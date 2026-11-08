/**
 * pi-web server entry. Default bind 127.0.0.1:4319. Opening the UI lands straight on the
 * chats - there is no login page and no code to paste.
 *
 * Bare `pi-web` (no subcommand) starts the server and opens the browser, the way
 * `dsh web` works in the DeepSeek harness (launcher flags first, the app's own
 * flags after; `--port 0` lets the OS pick a free port). Explicit commands:
 * serve (default) | allow <dir> | workspaces | mint-token [--name n] |
 * revoke-token --id <id> | install-bridge [--agent-dir <dir>] |
 * print-bridge-command | help
 *
 * `bin/pi-web.mjs` imports `runCli` from the compiled build; `node dist/main.js`
 * and `tsx src/main.ts` still self-execute through the guard at the bottom.
 */
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
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

const HELP = `pi-web — local web UI for pi sessions (no login: open the URL and you are in)

  pi-web                        start the server and open the browser (loopback)
  pi-web serve [--port 4319] [--bind 127.0.0.1] [--data-dir DIR] [--host-allow h1,h2]
                [--agent-dir DIR] [--tls-cert F --tls-key F] [--open|--no-open]
  pi-web allow <absolute-dir>   allowlist a workspace whose sessions pi-web may read
  pi-web workspaces             list allowlisted workspaces
  pi-web mint-token [--name n]  print a long-lived API bearer token
  pi-web revoke-token --id ID   revoke an API token
  pi-web install-bridge         install the terminal-bridge pi extension
  pi-web print-bridge-command   exact env + \`pi -e\` command for a terminal session

Serve flags (bare \`pi-web\` and \`pi-web serve\` take the same flags):
  --port <n>        listen port; pass 0 to let the OS pick a free one (default 4319)
  --bind <addr>     one concrete IPv4/IPv6 literal of a local interface (default 127.0.0.1)
  --data-dir <dir>  state directory (default ~/.pi-web, or $PIWEB_DATA_DIR)
  --host-allow <h>  extra Host authorities for a reverse proxy (repeatable list, comma-separated)
  --agent-dir <dir> pi agent dir to read settings/themes from
  --tls-cert/--tls-key  serve HTTPS with an existing PEM pair (must be given together)
  --no-open         print the URL instead of opening the default browser
                    (also PIWEB_NO_OPEN=1; forced off over SSH or on non-loopback binds)

Environment: PIWEB_PORT PIWEB_BIND PIWEB_DATA_DIR PIWEB_HOSTS_ALLOW PIWEB_ORIGINS_ALLOW
             PIWEB_AGENT_DIR PIWEB_TLS_CERT PIWEB_TLS_KEY PIWEB_MAX_MANAGED PIWEB_NO_OPEN

  pi-web --version | --help

  Install once, launch anywhere:  npm i -g @piwebui/pi-web && pi-web
`;

/** Flags the CLI understands; anything else is a typo worth reporting. */
const KNOWN_FLAGS = new Set([
  "port", "bind", "data-dir", "host-allow", "origins-allow", "agent-dir", "tls-cert", "tls-key",
  "open", "no-open", "name", "id", "help", "h", "version", "v", "V",
]);

/** Flag names in argv that this CLI does not know (\"--pot 5000\" would otherwise be ignored). */
function unknownFlags(argv: string[]): string[] {
  return argv.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a.slice(2)));
}

/** Version of the installed @piwebui/pi-web package (works packed and in a checkout). */
export function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(HERE, "..", "package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printVersion(): void {
  console.log(`pi-web ${packageVersion()}`);
}

/* ---------------- browser handoff (bare `pi-web` launch) ---------------- */

const BROWSER_OPENERS: Record<string, string> = {
  darwin: "open", linux: "xdg-open", freebsd: "xdg-open", netbsd: "xdg-open", openbsd: "xdg-open", android: "termux-open",
};

function findInPath(prog: string): string | null {
  const exts = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD").split(";") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = path.join(dir, prog + ext);
      try { fs.accessSync(cand, fs.constants.X_OK); return cand; } catch { /* keep looking */ }
    }
  }
  return null;
}

function isLoopbackBind(bind: string): boolean {
  return bind === "127.0.0.1" || bind === "localhost" || bind === "::1";
}

/** Like dsh web: SSH_CONNECTION / SSH_TTY mean "this terminal is remote", so a
 *  local browser handoff would open nothing (or the wrong machine's browser). */
function launchedOverSsh(): boolean {
  return Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY);
}

/** Why we cannot (or will not) launch a browser here; null means "go ahead". */
function browserOpenBlocker(flags: Record<string, string | boolean>, bind: string): string | null {
  if (flags["no-open"]) return "--no-open";
  if (process.env.PIWEB_NO_OPEN) return "PIWEB_NO_OPEN is set";
  if (launchedOverSsh()) return "launched over SSH; open the printed URL on your own machine (ssh -L works)";
  if (!isLoopbackBind(bind)) return `bound to ${bind}, not loopback`;
  const opener = BROWSER_OPENERS[process.platform];
  if (!opener) return `no browser opener for ${process.platform}`;
  // `--open` says "try anyway": keep the platform opener but skip session probes.
  if (flags.open === true) return null;
  if (process.platform !== "darwin" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !process.env.TERMUX_VERSION) {
    return "no desktop session here (pass --open to try anyway)";
  }
  if (!findInPath(opener)) return `${opener} not installed`;
  return null;
}

/** One-line fatal startup report (dsh prints `dsh web: ...`; we print `pi-web: ...`). */
function fatal(message: string): never {
  process.stderr.write(`pi-web: ${message}\n`);
  process.exit(1);
}

function openBrowser(url: string): boolean {
  const opener = BROWSER_OPENERS[process.platform];
  if (!opener) return false;
  try {
    const child = spawn(opener, [url], { stdio: "ignore", detached: true });
    child.on("error", () => { /* fall back to the printed URL */ });
    child.unref();
    return true;
  } catch {
    return false;
  }
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
    manifest: { version: packageVersion() },
  };
  registerRoutes(app, ctx);
  const dist = clientDist();
  if (dist) serveStatic(app, dist);
  else {
    app.get("/", async (_req, reply) => { reply.code(503).type("text/plain"); return "pi-web client not built yet (npm run build -w @piwebui/client)"; });
  }

  try {
    await app.listen({ host: cfg.bind, port: cfg.port });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    const detail = error instanceof Error ? error.message : String(error);
    if (code === "EADDRINUSE") {
      fatal(`port ${cfg.port} on ${cfg.bind} is already in use - another pi-web (or something else) holds it. Start on a free port with \`pi-web --port 0\` (the OS picks one) or \`pi-web --port 4400\`.`);
    }
    if (code === "EACCES") {
      fatal(`${cfg.bind}:${cfg.port} needs privileges (ports below 1024). Run \`pi-web --port 4319\` on an unprivileged port.`);
    }
    fatal(`could not listen on ${cfg.bind}:${cfg.port}: ${detail}`);
  }

  // The listener knows the truth: with --port 0 the OS assigned the port, and the
  // Host/Origin fences were composed from the requested value, so admit the real
  // authority before any browser request can arrive.
  const scheme = cfg.tls ? "https" : "http";
  const address = app.server.address();
  const boundPort = typeof address === "object" && address ? address.port : cfg.port;
  if (boundPort !== cfg.port) {
    const authorities = [`localhost:${boundPort}`, `127.0.0.1:${boundPort}`, `[::1]:${boundPort}`, `${cfg.bind}:${boundPort}`];
    for (const h of authorities) if (!cfg.hostsAllow.includes(h)) cfg.hostsAllow.push(h);
    for (const h of authorities) {
      const origin = `${scheme}://${h}`;
      if (!cfg.originsAllow.includes(origin)) cfg.originsAllow.push(origin);
    }
  }
  bridges.start();
  setInterval(() => ops.sweep(), 3600_000).unref?.();

  // Access banner (terminal only).
  const token = auth.bridgeToken();
  const base = `${scheme}://${isLoopbackBind(cfg.bind) ? cfg.bind : "localhost"}:${boundPort}`;
  if (!isLoopbackBind(cfg.bind) && !cfg.tls) {
    process.stderr.write(`pi-web: listening on ${cfg.bind} over plain HTTP; anyone who can reach that address can drive pi. Prefer a loopback bind behind a proxy you own.\n`);
  }
  const blocker = browserOpenBlocker(flags, cfg.bind);
  const opened = blocker ? false : openBrowser(`${base}/`);
  process.stdout.write([
    "",
    `  pi-web listening on ${base}  (server ${ctx.serverId})`,
    `  Pi adapter: ${piPkg ? `${piPkg.name}@${piPkg.version}` : "NOT RESOLVED (read-only)"}`,
    "",
    ...(opened
      ? [`  Browser opened at ${base}/ - your sessions load straight away, no sign-in.`]
      : [`  Open ${base}/ in a browser.   (no browser launched: ${blocker})`]),
    "",
    "  To let a TERMINAL pi be controlled from the browser, start it with the bridge:",
    `    PIWEB_BRIDGE_TOKEN=${token} \\`,
    `    PIWEB_BRIDGE_DIR=${bridgeDir} \\`,
    `    pi -e ${bridgeExtensionPathFor(piPkg)}`,
    "  (Existing pi processes pick the bridge up only at an idle /reload or next start.)",
    "",
  ].join("\n") + "\n");
  logInfo("server_start", { port: boundPort, bind: cfg.bind, opened_browser: opened });

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

/** The path printed when the browser could not be handed the URL. */
function bridgeExtensionPathFor(_piPkg: ReturnType<typeof resolvePiPackage>): string {
  const src = path.join(HERE, "..", "..", "pi-adapter", "src", "bridge", "extension.mjs");
  const dist = path.join(HERE, "..", "..", "pi-adapter", "dist", "bridge", "extension.mjs");
  return fs.existsSync(dist) ? dist : src;
}

/* ---------------- CLI subcommands ---------------- */

/**
 * CLI entry, called by bin/pi-web.mjs in-process (and by the self-exec guard
 * below when the module is run directly).
 */
export async function runCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const wantsHelp = argv.some((a) => a === "-h" || a === "--help");
  const wantsVersion = argv.some((a) => a === "-v" || a === "-V" || a === "--version");
  // Bare launch: `pi-web` (or flags-only, e.g. `pi-web --port 5000`) starts the server and
  // opens the browser - the one-command launch, mirroring `dsh web`.
  if (argv.length === 0 || argv[0]!.startsWith("-")) {
    if (wantsHelp) { process.stdout.write(HELP); return; }
    if (wantsVersion) { printVersion(); return; }
    const bad = unknownFlags(argv);
    if (bad.length) { process.stderr.write(`unknown flag(s): ${bad.join(", ")}\n\n${HELP}`); process.exit(2); }
    await serve(parseFlags(argv));
    return;
  }
  const cmd = argv[0]!;
  if (cmd === "help") { process.stdout.write(HELP); return; }
  const flags = parseFlags(argv.slice(1));
  if (cmd === "serve") {
    const bad = unknownFlags(argv.slice(1));
    if (bad.length) { process.stderr.write(`unknown flag(s): ${bad.join(", ")}\n\n${HELP}`); process.exit(2); }
    await serve(flags);
    return;
  }
  const cfg = loadConfig({ ...(flags["data-dir"] ? { dataDir: String(flags["data-dir"]) } : {}) });
  const store = new Store(path.join(cfg.dataDir, "metadata.db"));
  const auth = new AuthService(store, cfg);
  if (cmd === "mint-token") {
    const name = String(flags.name ?? "cli");
    const t = auth.mintApiToken(name);
    console.log(t.token);
    console.error(`token id: ${t.id}`);
  } else if (cmd === "revoke-token") {
    console.log(String(auth.revokeApiToken(String(flags.id ?? ""))));
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
    process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
    process.exit(2);
  }
  store.close();
}

if (process.argv[1] && (process.argv[1].endsWith("main.ts") || process.argv[1].endsWith("main.js"))) {
  void runCli();
}

void shellEscape;
