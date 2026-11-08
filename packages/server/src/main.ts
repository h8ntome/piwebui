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
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { resolvePiPackage } from "@piwebui/pi-adapter";
import { TESTED_PI_VERSIONS, allowedPiVersions, isPiVersionAllowed } from "@piwebui/shared";
import { loadConfig, AuthService, saveConfigDir, type BridgeModeName, type Config } from "./auth.ts";
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
import { BridgeServer, type HelloFrame } from "./bridgeServer.ts";
import { wireBridge, type BridgeWire } from "./bridgeWire.ts";
import { bridgeSocketPath, processStartMs, writeDescriptor, readDescriptor, descriptorPath, removeDescriptorSocket } from "./descriptor.ts";
import { logInfo } from "./log.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** `--bridge-mode` beats config beats the default (`dial`). */
function resolveBridgeMode(flags: Record<string, string | boolean>, cfg: Config): BridgeModeName {
  const raw = flags["bridge-mode"] ? String(flags["bridge-mode"]) : cfg.bridge?.mode ?? "dial";
  const mode = raw.toLowerCase() as BridgeModeName;
  return (["dial", "legacy", "both", "off"] as string[]).includes(mode) ? mode : "dial";
}

function bridgeListenerLabel(bridge: BridgeServer, disabled: boolean): string {
  if (disabled) return "disabled";
  const n = bridge.connections().length;
  return `dial listener on ${bridge.socketPath} (${n} runtime${n === 1 ? "" : "s"} connected)`;
}

function safeReaddir(dir: string): string[] {
  try { return fs.readdirSync(dir); } catch { return []; }
}

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

/**
 * Positional arguments of a subcommand, i.e. everything that is not a flag or a flag's value.
 * Reading `argv[1]` as the positional made `pi-web allow --data-dir X` take "--data-dir" as the
 * directory and `trust-runtime --data-dir X` as the runtime id (BUG-018).
 */
function positionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) i++; // this flag consumed that value
      continue;
    }
    out.push(a);
  }
  return out;
}

const HELP = `pi-web — local web UI for pi sessions (no login: open the URL and you are in)

  pi-web                        start the server and open the browser (loopback)
  pi-web serve [--port 4319] [--bind 127.0.0.1] [--data-dir DIR] [--host-allow h1,h2]
                [--agent-dir DIR] [--tls-cert F --tls-key F] [--open|--no-open]
  pi-web allow <absolute-dir>   allowlist a workspace whose sessions pi-web may read
  pi-web workspaces             list allowlisted workspaces
  pi-web mint-token [--label n] [--list]  print a long-lived API bearer token, or list them
  pi-web revoke-token --id ID   revoke an API token
  pi-web install-extension      copy the terminal bridge into ~/.pi/agent/extensions (prefer pi install)
  pi-web install-bridge         (deprecated alias of install-extension)
  pi-web doctor [--json]        why is my terminal pi not live in the browser?
  pi-web rotate-bridge-token    new bridge secret + descriptor rewrite
  pi-web trust-runtime <id>     allow a runtime that was revoked (or when autoTrust=false)
  pi-web revoke-runtime <id>    drop and distrust a runtime now
  pi-web hidden                 list sessions deleted in pi-web (their files are still on disk)
  pi-web unhide <path>          put one of them back in the list
  pi-web pair                   env line for bridging a pi on another host over an ssh tunnel
  pi-web deprecate-bridge       what changed in the bridge transport, and the cleanup command

Serve flags (bare \`pi-web\` and \`pi-web serve\` take the same flags):
  --port <n>        listen port; pass 0 to let the OS pick a free one (default 4319)
  --bind <addr>     one concrete IPv4/IPv6 literal of a local interface (default 127.0.0.1)
  --data-dir <dir>  state directory (default ~/.pi-web, or $PIWEB_DATA_DIR)
  --host-allow <h>  extra Host authorities for a reverse proxy (repeatable list, comma-separated)
  --agent-dir <dir> pi agent dir to read settings/themes from
  --tls-cert/--tls-key  serve HTTPS with an existing PEM pair (must be given together)
  --no-open         print the URL instead of opening the default browser
                    (also PIWEB_NO_OPEN=1; forced off over SSH or on non-loopback binds)
  --bridge-mode <m> dial (default) | both | legacy | off - how terminal pis connect
  --bridge-socket <path>  override the bridge socket (default <data-dir>/bridge-<serverId>.sock)
  --no-attest       accept bridges without verifying their pid is a live pi (not recommended)

Environment: PIWEB_PORT PIWEB_BIND PIWEB_DATA_DIR PIWEB_HOSTS_ALLOW PIWEB_ORIGINS_ALLOW
             PIWEB_AGENT_DIR PIWEB_TLS_CERT PIWEB_TLS_KEY PIWEB_MAX_MANAGED PIWEB_NO_OPEN
             PIWEB_BRIDGE_MODE PIWEB_BRIDGE_DISABLE PIWEB_BRIDGE_ATTEST PIWEB_BRIDGE_AUTO_TRUST
             PIWEB_BRIDGE_ALLOW_CWD PIWEB_BRIDGE_TRUST_SESSION_DIRS PIWEB_ALLOW_PI_VERSIONS
             Terminal side: PIWEB_BRIDGE_DISABLE PIWEB_BRIDGE_FILE PIWEB_BRIDGE_MODES
             PIWEB_BRIDGE_MAX_SERVERS PIWEB_BRIDGE_DEBUG

  pi-web --version | --help

  Install once, launch anywhere:  npm i -g @piwebui/pi-web && pi-web
`;

/** Flags the CLI understands; anything else is a typo worth reporting. */
const KNOWN_FLAGS = new Set([
  "port", "bind", "data-dir", "host-allow", "origins-allow", "agent-dir", "tls-cert", "tls-key",
  "open", "no-open", "name", "label", "id", "list", "help", "h", "version", "v", "V",
  "bridge-mode", "bridge-socket", "no-attest", "json", "ttl",
]);

/** Flag names in argv that this CLI does not know (\"--pot 5000\" would otherwise be ignored). */
function unknownFlags(argv: string[]): string[] {
  return argv.filter((a) => a.startsWith("--") && !KNOWN_FLAGS.has(a.slice(2)));
}

/** Version of the installed @piwebui/pi-web package (works packed and in a checkout). */export function packageVersion(): string {
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

/** Text-ish assets worth compressing on the fly (woff2/png are already compressed). */
const COMPRESSIBLE = new Set([".html", ".js", ".css", ".json", ".svg", ".map", ".txt"]);
const MIN_COMPRESS_BYTES = 860;
/** path -> { mtime, encoding -> body }, so a rebuild invalidates without a restart. */
const encodedCache = new Map<string, { mtimeMs: number; variants: Map<string, Buffer> }>();

function pickEncoding(accept: string, ext: string): "br" | "gzip" | null {
  if (!COMPRESSIBLE.has(ext)) return null;
  const a = accept.toLowerCase();
  if (a.includes("br")) return "br";
  if (a.includes("gzip")) return "gzip";
  return null;
}

function compressBody(full: string, raw: Buffer, st: fs.Stats, enc: "br" | "gzip"): Buffer | null {
  if (raw.length < MIN_COMPRESS_BYTES) return null;
  let entry = encodedCache.get(full);
  if (!entry || entry.mtimeMs !== st.mtimeMs) {
    entry = { mtimeMs: st.mtimeMs, variants: new Map() };
    encodedCache.set(full, entry);
  }
  const hit = entry.variants.get(enc);
  if (hit !== undefined) return hit;
  const body = enc === "br"
    ? brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
    : gzipSync(raw, { level: 6 });
  // Only keep and use it when it actually pays off.
  const out = body.length < raw.length ? body : null;
  entry.variants.set(enc, out ?? Buffer.alloc(0));
  return out;
}

function serveStatic(app: ReturnType<typeof buildServer>, dir: string) {
  // No boot-time theme script here on purpose. Pre-paint theming is done by the inline script in
  // client/index.html, which reads the one setting store the app actually uses
  // (`piweb:settings:v1.theme` -> `body[data-ds-dark-theme]`). A former GET /boot/theme.js read
  // `piweb.theme` / set `data-pi-theme` - keys and attributes nothing else has ever used, and no
  // script tag ever loaded it (BUG-009); deleting it is honest, wiring it would be a second
  // source of truth.
  app.get("*", async (req, reply) => {
    const url = (req.url ?? "/").split("?")[0]!;
    if (url.startsWith("/api/")) { reply.code(404).type("application/json"); return { error: { code: "not_found", message: "no such api route" } }; }
    let rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
    const full = path.normalize(path.join(dir, rel));
    if (!full.startsWith(dir)) { reply.code(403).type("text/plain"); return "forbidden"; }
    let st: fs.Stats;
    try { st = fs.statSync(full); } catch { st = null as never; }
    if (st && st.isFile()) {
      const ext = path.extname(full);
      reply.header("content-type", MIME[ext] ?? "application/octet-stream");
      reply.header("cache-control", rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache");
      const raw = fs.readFileSync(full);
      // The bundle is ~550 KB and a documented deployment is an SSH tunnel, so answer with a
      // content-encoding whenever the client can take one (brotli preferred).
      const enc = pickEncoding(String(req.headers["accept-encoding"] ?? ""), ext);
      if (enc) {
        const body = compressBody(full, raw, st, enc);
        if (body) {
          reply.header("content-encoding", enc);
          reply.header("vary", "Accept-Encoding");
          return reply.send(body);
        }
      }
      return reply.send(raw);
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

  // ---- terminal bridge: the server listens, terminal pis dial (D-1) ----
  const bridgeMode = resolveBridgeMode(flags, cfg);
  const bridgeDisabled = bridgeMode === "off" || process.env.PIWEB_BRIDGE_DISABLE === "1";
  const bridgeDir = path.join(cfg.dataDir, "bridges");
  const socketPath = flags["bridge-socket"] ? String(flags["bridge-socket"]) : bridgeSocketPath(cfg.dataDir, auth.serverId());
  if (Buffer.byteLength(socketPath, "utf8") > 100) {
    fatal(`bridge socket path is too long for a unix socket (${socketPath.length} chars): use a shorter --data-dir or pass --bridge-socket <short-path>`);
  }
  const bridge = new BridgeServer({
    dataDir: cfg.dataDir,
    serverId: auth.serverId(),
    token: auth.bridgeToken(),
    socketPath,
    mode: bridgeDisabled ? "off" : bridgeMode,
    requireAttestation: cfg.bridge?.requireAttestation !== false && !flags["no-attest"],
    autoTrust: cfg.bridge?.autoTrust !== false,
    allowCwd: cfg.bridge?.allowCwd,
    store,
    onAttach: (conn, hello) => wire.onAttach(conn, hello),
    onAdvertise: (conn, hello) => wire.onAdvertise(conn, hello),
    onGone: (conn, reason) => wire.onGone(conn, reason),
  });

  const wire: BridgeWire = wireBridge({
    sessions,
    ops,
    store,
    serverId: auth.serverId(),
    listener: () => ({ mode: bridgeMode, socketPath: bridge.socketPath, listener: bridgeListenerLabel(bridge, bridgeDisabled), rejects: bridge.stats.rejected }),
    versionGate: () => ({
      serverPiVersion: piPkg?.version ?? null,
      validated: [...TESTED_PI_VERSIONS],
      allowedByConfig: allowedPiVersions(),
      verdict: piPkg?.version && isPiVersionAllowed(piPkg.version) ? "writable" : "read-only until validated or allowlisted",
    }),
    legacyCount: () => legacyDiscovery.handlesSnapshot().length,
    legacyInfo: () => ({
      dir: bridgeDir,
      records: safeReaddir(bridgeDir).filter((f) => f.endsWith(".json")).length,
      note: "legacy discovery polls <dataDir>/bridges every 3 s; the dial transport is preferred",
    }),
  });

  // Legacy transport (pre-1.0): the server dials each terminal pi's own socket. Kept for one
  // release so an existing `PIWEB_BRIDGE_*` setup keeps working (H-18); the dial connection wins
  // when both exist because adoption refuses a second owner for one session.
  const legacyDiscovery = new BridgeDiscovery(
    bridgeDir,
    auth.bridgeToken(),
    (handle: BridgeHandle) => attachLegacyBridge(handle),
    (handle: BridgeHandle) => {
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

  function attachLegacyBridge(handle: BridgeHandle) {
    const hello = (handle.hello ?? {}) as Partial<HelloFrame>;
    const filePath = handle.sessionFile && fs.existsSync(handle.sessionFile) ? handle.sessionFile : null;
    const sessionId = String(hello.sessionId ?? handle.runtimeId);
    const { rec } = sessions.adoptBridge(handle as never, {
      runtimeId: handle.runtimeId,
      sessionId,
      sessionFile: filePath ?? handle.sessionFile ?? null,
      cwd: handle.cwd,
      piVersion: handle.piVersion,
      sessionGeneration: Number(hello.sessionGeneration ?? 1),
      capabilities: handle.capabilities,
    });
    if (!rec.driver) return; // a dial connection already owns this session
    handle.onEvent((ev) => sessions.applyDriverEvent(rec, ev));
    handle.onDead(() => {
      if (rec!.driver === handle) {
        rec!.driver = null;
        rec!.state.phase = "unknown";
        ops.ownerLost(rec!.key);
        hub.emit(rec!.key, "ownerChanged", { runtime: null, mode: sessions.mode(rec!) });
        hub.emit(rec!.key, "resync", { reason: "bridge_lost" });
      }
    });
    void handle.cmd("snapshot", {}, 8000).then((snap) => {
      sessions.mergeOwnerSnapshot(rec!, snap as Record<string, unknown>);
      hub.emit(rec!.key, "ownerChanged", { runtime: sessions.identity(rec!), mode: sessions.mode(rec!) });
      hub.emit(rec!.key, "resync", { reason: "owner_attached" });
    }).catch(() => { /* attach anyway; the next event refreshes state */ });
  }

  const app = buildServer(cfg, auth);
  const ctx: AppCtx = {
    cfg, auth, store, read, hub, sessions, control, ops, dispatcher,
    bridge, wire, legacyBridges: legacyDiscovery as never,
    bridgeMode,
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
  // The bridge listener starts with the HTTP listener: no terminal pi can dial a socket that
  // belongs to a server that is not answering yet.
  let descriptorInfo: ReturnType<typeof writeDescriptor> | null = null;
  if (!bridgeDisabled) {
    const up = await bridge.listen();
    if (!up.ok) {
      fatal(`something already answers on ${socketPath} - another pi-web (or a server that died holding it). Start this one on another --data-dir, or pass --bridge-socket <path>.`);
    }
    descriptorInfo = writeDescriptor({
      dataDir: cfg.dataDir,
      serverId: ctx.serverId,
      socket: socketPath,
      token: auth.bridgeToken(),
      http: `${scheme}://${isLoopbackBind(cfg.bind) ? cfg.bind : "localhost"}:${boundPort}`,
      piwebVersion: packageVersion(),
    });
    logInfo("bridge_descriptor_written", { path: descriptorInfo.path, pointer: descriptorInfo.pointerPath ?? "default dir" });
  }
  if (!bridgeDisabled && (bridgeMode === "legacy" || bridgeMode === "both")) legacyDiscovery.start();
  setInterval(() => ops.sweep(), 3600_000).unref?.();

  // Access banner (terminal only). The bridge token is never printed: it lives in the
  // 0600 descriptor, and printing it puts it in shell history, CI logs and screen shares (B-13).
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
    ...(bridgeDisabled
      ? ["  Terminal control: the bridge is OFF (--bridge-mode off or PIWEB_BRIDGE_DISABLE=1)."]
      : [
        "  Terminal control: install once, then just run pi:",
        "    pi install npm:@piwebui/pi-web-bridge",
        `  bridge: ${bridgeListenerLabel(bridge, false)} · ${socketPath}`,
        `  descriptor: ${descriptorInfo?.path ?? "(not written)"}`,
        "  A running terminal pi picks the bridge up on its next /reload or start.",
      ]),
    "",
  ].join("\n") + "\n");
  logInfo("server_start", { port: boundPort, bind: cfg.bind, opened_browser: opened, bridge_mode: bridgeMode });

  const shutdown = async () => {
    legacyDiscovery.stop();
    bridge.close();
    if (!bridgeDisabled) removeDescriptorSocket(socketPath);
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

/**
 * Where the bridge extension file actually lives: the workspace checkout first (dev), then the
 * copy staged into the published server package (`bridge-extension/`, see
 * scripts/stage-bridge-extension.mts). Never the legacy `.mjs`.
 */
function bridgeExtensionPathFor(_piPkg: ReturnType<typeof resolvePiPackage>): string | null {
  const candidates = [
    path.join(HERE, "..", "..", "pi-extension", "extensions", "pi-web-bridge.js"),
    path.join(HERE, "..", "bridge-extension", "pi-web-bridge.js"),
    path.join(HERE, "bridge-extension", "pi-web-bridge.js"),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
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
  // `--help`/`--version` mean the same thing after a subcommand as before it; before this they
  // were swallowed and the subcommand ran anyway (BUG-024).
  if (wantsHelp) { process.stdout.write(HELP); return; }
  if (wantsVersion) { printVersion(); return; }
  const badCmdFlags = unknownFlags(argv.slice(1));
  if (badCmdFlags.length) { process.stderr.write(`unknown flag(s) for \`${cmd}\`: ${badCmdFlags.join(", ")}\n\n${HELP}`); process.exit(2); }
  const rest = positionals(argv.slice(1));
  if (cmd === "serve") {
    await serve(flags);
    return;
  }
  const cfg = loadConfig({ ...(flags["data-dir"] ? { dataDir: String(flags["data-dir"]) } : {}) });
  const store = new Store(path.join(cfg.dataDir, "metadata.db"));
  const auth = new AuthService(store, cfg);
  if (cmd === "mint-token") {
    if (flags.list) {
      const rows = auth.listApiTokens();
      if (!rows.length) { console.log("(no API tokens: pi-web mint-token --label <name>)"); }
      else for (const r of rows) console.log(`${r.id}\t${r.name}\t${r.created_at}`);
    } else {
      // `--label` was documented but never read, so every token came out named "cli".
      const name = String(flags.label ?? flags.name ?? "cli");
      const t = auth.mintApiToken(name);
      console.log(t.token);
      console.error(`token id: ${t.id}`);
    }
  } else if (cmd === "revoke-token") {
    const id = String(flags.id ?? rest[0] ?? "");
    if (!id) { console.error("usage: pi-web revoke-token --id <id>  (list them with: pi-web mint-token --list)"); process.exit(2); }
    if (!auth.revokeApiToken(id)) { console.error(`no API token with id ${id} (list them with: pi-web mint-token --list)`); process.exit(1); }
    console.log("true");
  } else if (cmd === "allow") {
    const p = rest[0];
    if (!p) { console.error("usage: pi-web allow <absolute-directory>"); process.exit(2); }
    let canon: string;
    try {
      canon = fs.realpathSync(path.resolve(p));
    } catch {
      console.error(`no such directory: ${p}`);
      process.exit(2);
    }
    if (!fs.statSync(canon).isDirectory()) { console.error("not a directory"); process.exit(2); }
    const key = "w_" + crypto.randomBytes(6).toString("hex");
    store.db.prepare("INSERT INTO workspaces(key,path,label,added_at) VALUES(?,?,?,?) ON CONFLICT(path) DO NOTHING").run(key, canon, path.basename(canon), new Date().toISOString());
    const row = store.db.prepare("SELECT key FROM workspaces WHERE path=?").get(canon) as { key: string } | undefined;
    console.log(`workspace allowed: ${canon} (${row?.key ?? key})`);
    console.log("A running pi-web picks this up on its next list refresh; no restart needed.");
  } else if (cmd === "workspaces") {
    const rows = store.db.prepare("SELECT key,path FROM workspaces ORDER BY added_at").all() as { key: string; path: string }[];
    for (const r of rows) console.log(`${r.key}\t${r.path}`);
    if (!rows.length) console.log("(no workspaces: pi-web allow <dir>)");
  } else if (cmd === "install-extension" || cmd === "install-bridge") {
    if (cmd === "install-bridge") console.log("note: `install-bridge` is deprecated; use `install-extension` (or `pi install npm:@piwebui/pi-web-bridge`).\n");
    const agentDir = String(flags["agent-dir"] ?? process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"));
    const extDir = path.join(agentDir, "extensions");
    fs.mkdirSync(extDir, { recursive: true });
    const src = bridgeExtensionPathFor(null);
    if (!src) { console.error("pi-web: the bridge extension file was not found in this install; use `pi install npm:@piwebui/pi-web-bridge` instead."); process.exit(1); }
    const dest = path.join(extDir, "pi-web-bridge.js");
    fs.copyFileSync(src, dest);
    let removed = "";
    for (const legacyName of ["pi-web-bridge.mjs"]) {
      const legacy = path.join(extDir, legacyName);
      // A `.mjs` file is never auto-discovered by pi: leaving it behind means two copies of the
      // bridge in one process and a very confusing "it stopped working" story.
      try { fs.unlinkSync(legacy); removed = legacy; } catch { /* nothing to clean */ }
    }
    console.log(`Installed the bridge extension to ${dest}`);
    if (removed) console.log(`Removed the legacy (never loaded) copy at ${removed}`);
    console.log("No token, no environment variables: pi-web publishes its descriptor and the bridge finds it.");
    console.log("Preferred instead (self-updating, discoverable):  pi install npm:@piwebui/pi-web-bridge");
    console.log("An already-running pi loads it at the next idle /reload or at its next start.");
  } else if (cmd === "deprecate-bridge") {
    console.log([
      "The terminal bridge changed in 1.0: the bridge now dials pi-web instead of pi-web dialing each pi.",
      "Nothing to configure: pi-web publishes " + descriptorPath(cfg.dataDir) + " (0600) and the bridge reads it.",
      "If you set PIWEB_BRIDGE_TOKEN/PIWEB_BRIDGE_DIR by hand, you can drop them; the old transport still",
      "works for one more release via `pi-web --bridge-mode both`, and disappears after that.",
      "Uninstall the legacy copy: rm ~/.pi/agent/extensions/pi-web-bridge.mjs",
    ].join("\n"));
  } else if (cmd === "print-bridge-command") {
    // The token is no longer printed (B-13): the descriptor is the handoff.
    console.log(`pi -e ${bridgeExtensionPathFor(null) ?? "@piwebui/pi-web-bridge"}`);
    console.log(`# zero-config: pi-web already published ${descriptorPath(cfg.dataDir)}`);
  } else if (cmd === "rotate-bridge-token") {
    const next = auth.rotateBridgeToken();
    // A CLI rotation must not rewrite the descriptor as if the CLI were the server: it used to
    // stamp its own short-lived pid and the default :4319 URL, so a running server on another
    // port left bridges aimed at the wrong place and `doctor` compared against those fields.
    const prev = readDescriptor(descriptorPath(cfg.dataDir));
    const live = prev.ok ? prev.descriptor : null;
    const socketPath = flags["bridge-socket"] ? String(flags["bridge-socket"])
      : live?.socket ?? bridgeSocketPath(cfg.dataDir, auth.serverId());
    writeDescriptor({
      dataDir: cfg.dataDir,
      serverId: live?.serverId ?? auth.serverId(),
      socket: socketPath,
      token: next,
      http: live?.http ?? `http://${cfg.bind}:${cfg.port}`,
      piwebVersion: live?.piwebVersion ?? packageVersion(),
      ...(live ? { startedAt: live.startedAt, pid: live.pid, procStart: live.procStart } : {}),
    });
    console.log("New bridge token written to " + descriptorPath(cfg.dataDir) + " (never printed).");
    console.log("A running pi-web still holds the old token in memory: restart it, or POST /api/v1/bridge/rotate-token.");
    console.log("Bridges reconnect on their own within their retry window (<= 15 s).");
  } else if (cmd === "trust-runtime") {
    const id = rest[0];
    if (!id) { console.error("usage: pi-web trust-runtime <runtimeId>"); process.exit(2); }
    const row = store.runtimeGet(id);
    if (!row) { console.error(`unknown runtimeId ${id} (seen them with: pi-web doctor)`); process.exit(1); }
    store.runtimeSetTrusted(id, true);
    console.log(`trusted runtime ${id}`);
  } else if (cmd === "revoke-runtime") {
    const id = rest[0];
    if (!id) { console.error("usage: pi-web revoke-runtime <runtimeId>"); process.exit(2); }
    const changed = store.runtimeSetTrusted(id, false);
    if (!changed) { console.error(`unknown runtimeId ${id}`); process.exit(1); }
    console.log(`revoked runtime ${id}; it cannot connect until you trust it again`);
  } else if (cmd === "hidden") {
    const rows = store.db.prepare("SELECT path,session_key,name,hidden_at FROM hidden_sessions ORDER BY hidden_at DESC").all() as { path: string; session_key: string | null; name: string | null; hidden_at: string }[];
    if (!rows.length) console.log("(no deleted sessions: `pi-web delete <session>` hides one)");
    for (const r of rows) console.log(`${r.path}\t${r.name ?? r.session_key ?? ""}\t${r.hidden_at}`);
  } else if (cmd === "unhide") {
    const p = rest[0];
    if (!p) { console.error("usage: pi-web unhide <absolute-path-to-session.jsonl>"); process.exit(2); }
    const canon = path.resolve(p);
    const changed = store.db.prepare("DELETE FROM hidden_sessions WHERE path=?").run(canon).changes > 0;
    if (!changed) { console.error(`no hidden session at ${canon} (list them with: pi-web hidden)`); process.exit(1); }
    console.log(`unhidden: ${canon} — a running pi-web lists it again on its next refresh`);
  } else if (cmd === "pair") {
    // Documentation aid for the ssh -L story, not the zero-config path.
    const d = readDescriptor(descriptorPath(cfg.dataDir));
    if (!d.ok) { console.error(`no usable descriptor at ${descriptorPath(cfg.dataDir)} (${d.reason}): start pi-web there first`); process.exit(1); }
    console.log(`PIWEB_BRIDGE_SOCKET=${d.descriptor.socket} PIWEB_BRIDGE_TOKEN=${d.descriptor.token} pi -e @piwebui/pi-web-bridge`);
    console.log(`# copy bridge.json to the other host (0600!) and forward ${d.descriptor.socket} over ssh -L/-R; ttl is until you rotate the token.`);
  } else if (cmd === "doctor") {
    const { runDoctor } = await import("./doctor.ts");
    process.exitCode = await runDoctor({ dataDir: cfg.dataDir, json: Boolean(flags.json) });
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
