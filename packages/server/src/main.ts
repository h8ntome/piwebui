/**
 * pi-web server entry. Default bind 127.0.0.1:4319 with mandatory auth.
 * Commands: serve (default) | mint-code | mint-token <name> | revoke-token <id> |
 * install-bridge [--agent-dir <dir>] | print-bridge-command
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import crypto from "node:crypto";
import { resolvePiPackage } from "@piwebui/pi-adapter";
import { loadConfig, AuthService, saveConfigDir, type Config } from "./auth.ts";
import { Store } from "./store.ts";
import { ReadClient } from "./readClient.ts";
import { StreamHub } from "./hub.ts";
import { Sessions } from "./sessions.ts";
import { ControlGrants } from "./control.ts";
import { Operations } from "./operations.ts";
import { CommandDispatcher, shellEscape } from "./commands.ts";
import { buildServer } from "./http.ts";
import { registerRoutes, type AppCtx } from "./routes.ts";
import { BridgeDiscovery, type BridgeHandle } from "./drivers.ts";
import { logInfo } from "./log.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[name] = next; i++; }
      else out[name] = true;
    }
  }
  return out;
}

function clientDist(): string | null {
  for (const cand of [
    path.join(HERE, "..", "client-dist"), // packed/installed: npm i -g @piwebui/pi-web
    path.join(HERE, "..", "dist"),
    path.join(HERE, "..", "..", "client", "dist"),
  ]) if (fs.existsSync(path.join(cand, "index.html"))) return cand;
  return null;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2",
  ".map": "application/json",
};

function serveStatic(app: ReturnType<typeof buildServer>, dir: string) {
  app.get("/boot/theme.js", async (_req, reply) => {
    reply.header("content-type", MIME[".js"]);
    reply.header("cache-control", "no-cache");
    // Blocking same-origin boot script: sets theme attribute before first paint (CSP: 'self').
    return `try{var m=localStorage.getItem('piweb.theme')||'auto';var light=m==='light'||(m==='auto'&&window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches);document.documentElement.setAttribute('data-pi-theme',light?'light':'dark');var ap=localStorage.getItem('piweb.appearance');if(ap)document.documentElement.setAttribute('data-pi-appearance',ap);}catch(e){document.documentElement.setAttribute('data-pi-theme','dark');}`;
  });
  app.get("*", async (req, reply) => {
    const url = (req.url ?? "/").split("?")[0]!;
    if (url.startsWith("/api/")) { reply.code(404).type("application/json"); return { error: { code: "not_found", message: "no such api route" } }; }
    let rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
    const full = path.normalize(path.join(dir, rel));
    if (!full.startsWith(dir)) { reply.code(403).type("text/plain"); return "forbidden"; }
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { st = null as never; }
    if (st && st.isFile()) {
      reply.header("content-type", MIME[path.extname(full)] ?? "application/octet-stream");
      reply.header("cache-control", rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      return reply.send(fs.readFileSync(full));
    }
    // SPA fallback
    const index = path.join(dir, "index.html");
    if (fs.existsSync(index)) {
      reply.header("content-type", MIME[".html"]);
      reply.header("cache-control", "no-cache");
      return reply.send(fs.readFileSync(index));
    }
    reply.code(404).type("text/plain");
    return "not found";
  });
}

export async function serve(flags: Record<string, string | boolean>) {
  const cfg: Config = loadConfig({
    ...(flags.port ? { port: Number(flags.port) } : {}),
    ...(flags.bind ? { bind: String(flags.bind) } : {}),
    ...(flags["data-dir"] ? { dataDir: String(flags["data-dir"]) } : {}),
    ...(flags["tls-cert"] && flags["tls-key"] ? { tls: { certFile: String(flags["tls-cert"]), keyFile: String(flags["tls-key"]) } } : {}),
    ...(flags["host-allow"] ? { hostsAllow: String(flags["host-allow"]).split(",") } : {}),
    ...(flags["agent-dir"] ? { agentDir: String(flags["agent-dir"]) } : {}),
  });
  saveConfigDir(cfg);
  const store = new Store(path.join(cfg.dataDir, "metadata.db"));
  const auth = new AuthService(store, cfg);
  const hub = new StreamHub();
  const piPkg = resolvePiPackage(cfg.agentDir ? { agentDir: cfg.agentDir } : {});
  const read = new ReadClient({ piPackageEnv: piPkg?.entry ?? "" });
  const sessions = new Sessions(cfg, store, hub, read, () => auth.bridgeToken(), { version: piPkg?.version ?? null, path: piPkg?.dir ?? null });
  sessions.loadWorkspaces();
  const control = new ControlGrants(store);
  const ops = new Operations(store);
  for (const extra of cfg.sessionRootsExtra) void extra;

  const dispatcher = new CommandDispatcher(sessions, ops, control, {
    operationsChanged(sessionKey: string) {
      hub.emit(sessionKey, "operationState", { operations: ops.activeFor(sessionKey) });
    },
  });

  // ---- bridge discovery ----
  const bridgeDir = path.join(cfg.dataDir, "bridges");
  const bridges = new BridgeDiscovery(
    bridgeDir,
    auth.bridgeToken(),
    (handle: BridgeHandle) => attachBridge(handle),
    (handle: BridgeHandle) => {
      const rec = sessions.byKey.get(handle.runtimeId);
      void rec;
      for (const r of sessions.byKey.values()) {
        if (r.driver === handle) {
          r.driver = null;
          r.state.phase = "unknown";
          r.state.previews.clear();
          r.state.dialogs.clear();
          ops.ownerLost(r.key);
          hub.emit(r.key, "ownerChanged", { runtime: null, mode: sessions.mode(r) });
          hub.emit(r.key, "resync", { reason: "owner_lost" });
        }
      }
    },
  );

  function attachBridge(handle: BridgeHandle) {
    const filePath = handle.sessionFile ? fs.existsSync(handle.sessionFile) ? handle.sessionFile : null : null;
    let rec = filePath ? sessions.byPath.get(filePath) : undefined;
    if (!rec && filePath) {
      rec = sessions.ensureFromFileNoWatch(filePath);
      rec.kind = "bridged";
    }
    if (!rec) {
      // Session not flushed to disk yet: register a bridged placeholder keyed by runtime id.
      rec = sessions.blankRec("b_" + handle.runtimeId, null, "bridged");
      rec.meta.cwd = handle.cwd;
      sessions.byKey.set(rec.key, rec);
    }
    if (rec.driver && rec.driver !== handle) {
      // A second bridge claiming the same file: refuse duplicate live ownership.
      handle.dispose("duplicate owner refused");
      return;
    }
    rec.driver = handle;
    handle.onEvent((ev) => {
      sessions.applyDriverEvent(rec!, ev);
      if (ev.name === "session_start" && handle.sessionFile && rec!.path !== handle.sessionFile) {
        sessions.byPath.delete(rec!.path ?? "");
        rec!.path = handle.sessionFile;
        rec!.meta.path = handle.sessionFile;
        sessions.byPath.set(handle.sessionFile, rec!);
      }
    });
    handle.onDead(() => {
      if (rec!.driver === handle) {
        rec!.driver = null;
        rec!.state.phase = "unknown";
        ops.ownerLost(rec!.key);
        hub.emit(rec!.key, "ownerChanged", { runtime: null, mode: sessions.mode(rec!) });
        hub.emit(rec!.key, "resync", { reason: "bridge_lost" });
      }
    });
    // Adopt terminal metadata via one snapshot pull (non-fatal if it fails).
    void handle.cmd("snapshot", {}, 8000).then((snap) => {
      sessions.mergeOwnerSnapshot(rec!, snap as Record<string, unknown>);
      hub.emit(rec!.key, "ownerChanged", { runtime: sessions.identity(rec!), mode: sessions.mode(rec!) });
      hub.emit(rec!.key, "resync", { reason: "owner_attached" });
    }).catch(() => { /* attach anyway; users can refresh */ });
  }

  const app = buildServer(cfg, auth);
  const ctx: AppCtx = {
    cfg, auth, store, read, hub, sessions, control, ops, dispatcher,
    bridges: bridges as never,
    piPkg: { version: piPkg?.version ?? null, path: piPkg?.entry ?? null },
    serverId: auth.serverId(),
    startedAt: Date.now(),
    manifest: { version: "0.1.0" },
  };
  registerRoutes(app, ctx);
  const dist = clientDist();
  if (dist) serveStatic(app, dist);
  else {
    app.get("/", async (_req, reply) => { reply.code(503).type("text/plain"); return "pi-web client not built yet (npm run build -w @piwebui/client)"; });
  }

  await app.listen({ host: cfg.bind, port: cfg.port });
  bridges.start();
  setInterval(() => ops.sweep(), 3600_000).unref?.();

  // Access banner (terminal only; bootstrap codes never appear in access logs).
  const scheme = cfg.tls ? "https" : "http";
  const code = auth.mintBootstrapCode();
  const token = auth.bridgeToken();
  process.stdout.write([
    "",
    `  pi-web listening on ${scheme}://${cfg.bind}:${cfg.port}  (server ${ctx.serverId})`,
    `  Pi adapter: ${piPkg ? `${piPkg.name}@${piPkg.version}` : "NOT RESOLVED (read-only)"}`,
    "",
    `  Login code (one use, 2 min): ${code}`,
    `  Open ${scheme}://${cfg.bind === "0.0.0.0" ? "localhost" : cfg.bind}:${cfg.port}/ and exchange the code.`,
    "",
    "  To let a TERMINAL pi be controlled from the browser, start it with the bridge:",
    `    PIWEB_BRIDGE_TOKEN=${token} \\`,
    `    PIWEB_BRIDGE_DIR=${bridgeDir} \\`,
    `    pi -e ${bridgeExtensionPathFor(piPkg)}`,
    "  (Existing pi processes pick the bridge up only at an idle /reload or next start.)",
    "",
  ].join("\n") + "\n");
  logInfo("server_start", { port: cfg.port });

  const shutdown = async () => {
    bridges.stop();
    for (const rec of sessions.byKey.values()) {
      if (rec.driver && rec.kind === "managed") { (rec.driver as { markIntentionalExit?: () => void }).markIntentionalExit?.(); rec.driver.dispose("server shutdown"); }
      sessions.stopWatch(rec);
    }
    await read.stop();
    await app.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  void http; void https;
  return app;
}

function bridgeExtensionPathFor(_piPkg: ReturnType<typeof resolvePiPackage>): string {
  const src = path.join(HERE, "..", "..", "pi-adapter", "src", "bridge", "extension.mjs");
  const dist = path.join(HERE, "..", "..", "pi-adapter", "dist", "bridge", "extension.mjs");
  return fs.existsSync(dist) ? dist : src;
}

/* ---------------- CLI subcommands ---------------- */
async function cli() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "serve";
  const flags = parseFlags(argv.slice(1));
  if (cmd === "serve") { await serve(flags); return; }
  const cfg = loadConfig({ ...(flags["data-dir"] ? { dataDir: String(flags["data-dir"]) } : {}) });
  const store = new Store(path.join(cfg.dataDir, "metadata.db"));
  const auth = new AuthService(store, cfg);
  if (cmd === "mint-code") {
    console.log(auth.mintBootstrapCode());
  } else if (cmd === "mint-token") {
    const name = String(flags.name ?? "cli");
    const t = auth.mintApiToken(name);
    console.log(t.token);
    console.error(`token id: ${t.id}`);
  } else if (cmd === "revoke-token") {
    console.log(String(auth.revokeApiToken(String(flags.id ?? ""))));
  } else if (cmd === "logout-all") {
    auth.logoutAllWeb();
    console.log("ok");
  } else if (cmd === "allow") {
    const p = argv[1];
    if (!p) { console.error("usage: pi-web allow <absolute-directory>"); process.exit(2); }
    const canon = fs.realpathSync(path.resolve(p));
    if (!fs.statSync(canon).isDirectory()) { console.error("not a directory"); process.exit(2); }
    const key = "w_" + crypto.randomBytes(6).toString("hex");
    store.db.prepare("INSERT INTO workspaces(key,path,label,added_at) VALUES(?,?,?,?) ON CONFLICT(path) DO NOTHING").run(key, canon, canon, new Date().toISOString());
    const row = store.db.prepare("SELECT key FROM workspaces WHERE path=?").get(canon) as { key: string } | undefined;
    console.log(`workspace allowed: ${canon} (${row?.key ?? key})`);
  } else if (cmd === "workspaces") {
    const rows = store.db.prepare("SELECT key,path FROM workspaces ORDER BY added_at").all() as { key: string; path: string }[];
    for (const r of rows) console.log(`${r.key}\t${r.path}`);
    if (!rows.length) console.log("(no workspaces: pi-web allow <dir>)");
  } else if (cmd === "install-bridge") {
    const agentDir = String(flags["agent-dir"] ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"));
    const extDir = path.join(agentDir, "extensions");
    fs.mkdirSync(extDir, { recursive: true });
    const src = bridgeExtensionPathFor(null);
    const dest = path.join(extDir, "pi-web-bridge.mjs");
    fs.copyFileSync(src, dest);
    console.log(`Installed bridge extension to ${dest}`);
    console.log("Existing terminal Pi processes load it at the next idle /reload; new pi starts load it automatically.");
    console.log("You must start pi with PIWEB_BRIDGE_TOKEN and PIWEB_BRIDGE_DIR set (see server banner / README).");
  } else if (cmd === "print-bridge-command") {
    console.log(`PIWEB_BRIDGE_TOKEN=${auth.bridgeToken()} PIWEB_BRIDGE_DIR=${path.join(cfg.dataDir, "bridges")} pi -e ${bridgeExtensionPathFor(null)}`);
  } else {
    console.error("usage: pi-web [serve|allow <dir>|workspaces|mint-code|mint-token|revoke-token|logout-all|install-bridge|print-bridge-command]");
    process.exit(2);
  }
  store.close();
}

if (process.argv[1] && (process.argv[1].endsWith("main.ts") || process.argv[1].endsWith("main.js"))) {
  void cli();
}

void shellEscape;
