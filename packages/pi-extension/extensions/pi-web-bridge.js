/**
 * @piwebui/pi-web-bridge — let a terminal `pi` be seen and driven from pi-web, with no
 * configuration at all.
 *
 * How it works (bridge_plan 02): the extension runs *inside* your terminal pi process,
 * resolves the pi-web server descriptor (`~/.pi-web/bridge.json` by default), dials the
 * server's Unix socket, streams this pi's live events out, and executes the commands that
 * come back in. The terminal keeps working normally the whole time.
 *
 * Design rules, all of them load-bearing:
 *  - Public `ExtensionAPI`/`ExtensionContext` only. No monkey-patching, no private `dist`
 *    imports, no second writer of the session file, no debugger attach.
 *  - Node builtins only (`net`/`fs`/`path`/`os`/`crypto`/`perf_hooks`), so pi's jiti can load
 *    this file with nothing installed.
 *  - The socket belongs to the *process*, the capabilities belong to the *current instance*:
 *    pi re-instantiates extensions on /new, /resume, /fork and /reload, and a `pi` handle
 *    captured by a dead instance throws. Hence the globalThis hub below.
 *  - No sockets, watchers or timers are started from the factory: everything is deferred to
 *    `session_start` and released on `session_shutdown{quit}`.
 *  - Terminal dialogs are observable only: Pi's public API has no remote response path, so
 *    `dialogRespond` answers 501 instead of pretending.
 *  - Nothing here may slow pi down: the hot path is a map write plus a coalesced socket write,
 *    every handler is wrapped, every timer and socket is unref'd.
 *
 * Exported surface (named exports) exists for the unit tests; pi uses the default export.
 */
import net from "node:net";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

export const BRIDGE_PROTOCOL = 1;
export const BRIDGE_MIN_PROTOCOL = 1;
export const ADAPTER_VERSION = "0.1.0";

/** Mirrors @piwebui/shared/bridge-protocol (kept in sync by test/protocol-parity.test.mts). */
export const LIMITS = {
  replayFrames: 2000,
  replayBytes: 4 * 1024 * 1024,
  inboundBytes: 8 * 1024 * 1024,
  previewBytes: 2 * 1024 * 1024,
  toolStateBytes: 1 * 1024 * 1024,
  argsPreviewBytes: 8 * 1024,
  maxPreviews: 4,
  maxObservedDialogs: 16,
  authDeadlineMs: 5000,
  maxServers: 4,
  /** socket.writableLength above which `message_update` previews are shed. */
  backpressureSoftBytes: 4 * 1024 * 1024,
  /** ...and above which tool-output updates are shed too. */
  backpressureHardBytes: 8 * 1024 * 1024,
  retryStepsMs: [1000, 2000, 5000, 10000, 15000],
  descriptorScanMs: 60_000,
  previewCoalesceMs: 40,
  toolCoalesceMs: 80,
  seenOpsMax: 500,
};

/** Frame priority for the drop policy: lower is more droppable. Never drop >= 2. */
const EVENT_PRIORITY = {
  message_update: 0,
  tool_update: 1,
  input_seen: 1,
  diag: 2,
};
function eventPriority(name) {
  return Object.prototype.hasOwnProperty.call(EVENT_PRIORITY, name) ? EVENT_PRIORITY[name] : 2;
}

/* ------------------------------------------------------------------ utils */

const nowIso = () => new Date().toISOString();

function constantTimeEquals(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function pidAlive(pid) {
  if (!pid || pid < 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

function readJsonSafe(file, fsImpl) {
  try {
    return JSON.parse(fsImpl.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value, fsImpl, mode = 0o600) {
  const tmp = `${file}.tmp-${process.pid}`;
  fsImpl.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fsImpl.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode });
  try { fsImpl.chmodSync(tmp, mode); } catch { /* best effort */ }
  fsImpl.renameSync(tmp, file);
}

function err(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function truncateText(v, max) {
  const s = typeof v === "string" ? v : String(v ?? "");
  return s.length > max ? s.slice(0, max) : s;
}

function truncateArgs(a, max = LIMITS.argsPreviewBytes) {
  try {
    const s = JSON.stringify(a ?? {});
    if (s.length <= max) return a ?? {};
    return { _truncated: s.slice(0, max) };
  } catch {
    return {};
  }
}

/* ---------------------------------------------------- descriptor resolution */

/**
 * The documented search order (02 §2.2). Steps 2–6 are alternatives (first usable hit wins);
 * step 7 fans out to every other server discovered through the pointer directory.
 * `PIWEB_BRIDGE_DISABLE` short-circuits everything.
 */
export function descriptorCandidates({ env = process.env, homedir = os.homedir() } = {}) {
  const out = [];
  if (env.PIWEB_BRIDGE_FILE) out.push({ kind: "file", path: env.PIWEB_BRIDGE_FILE, source: "PIWEB_BRIDGE_FILE" });
  if (env.PIWEB_BRIDGE_SOCKET && env.PIWEB_BRIDGE_TOKEN) {
    out.push({
      kind: "inline",
      source: "PIWEB_BRIDGE_SOCKET/PIWEB_BRIDGE_TOKEN",
      descriptor: {
        v: 1,
        serverId: env.PIWEB_BRIDGE_SERVER_ID || "inline",
        protocol: [BRIDGE_PROTOCOL],
        socket: env.PIWEB_BRIDGE_SOCKET,
        token: env.PIWEB_BRIDGE_TOKEN,
        http: env.PIWEB_BRIDGE_HTTP || "",
        dataDir: env.PIWEB_DATA_DIR || "",
        pid: 0,
        procStart: 0,
      },
    });
  }
  if (env.PIWEB_DATA_DIR) out.push({ kind: "file", path: path.join(env.PIWEB_DATA_DIR, "bridge.json"), source: "PIWEB_DATA_DIR" });
  if (env.PI_CODING_AGENT_DIR) {
    out.push({ kind: "file", path: path.join(path.dirname(env.PI_CODING_AGENT_DIR), "pi-web", "bridge.json"), source: "PI_CODING_AGENT_DIR sibling" });
  }
  const homeDir = path.join(homedir, ".pi-web");
  out.push({ kind: "file", path: path.join(homeDir, "bridge.json"), source: "~/.pi-web/bridge.json" });
  out.push({ kind: "pointers", dir: path.join(homeDir, "servers"), source: "~/.pi-web/servers" });
  return out;
}

/** Structural copy of shared/bridge-protocol parseBridgeDescriptor (the extension imports nothing). */
export function parseDescriptor(raw, filePath) {
  const fail = (reason, detail) => ({ ok: false, reason, path: filePath, ...(detail ? { detail } : {}) });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("malformed", "not an object");
  if (raw.v !== 1) return fail("unsupported_version", `v=${String(raw.v)}`);
  if (typeof raw.socket !== "string" || !raw.socket) return fail("no_socket");
  if (typeof raw.token !== "string" || raw.token.length < 16 || !/^[A-Za-z0-9_-]{16,}$/.test(raw.token)) return fail("no_token");
  const protocol = Array.isArray(raw.protocol) ? raw.protocol.filter((p) => typeof p === "number") : [];
  if (!protocol.includes(BRIDGE_PROTOCOL)) return fail("unsupported_protocol", JSON.stringify(raw.protocol));
  return {
    ok: true,
    path: filePath,
    descriptor: {
      v: 1,
      serverId: typeof raw.serverId === "string" && raw.serverId ? raw.serverId : "unknown",
      protocol,
      socket: raw.socket,
      token: raw.token,
      http: typeof raw.http === "string" ? raw.http : "",
      dataDir: typeof raw.dataDir === "string" ? raw.dataDir : "",
      pid: Number(raw.pid) || 0,
      procStart: Number(raw.procStart) || 0,
      piwebVersion: typeof raw.piwebVersion === "string" ? raw.piwebVersion : undefined,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    },
  };
}

/**
 * Resolve every server this pi should dial. Pure: pass `env`, `homedir`, `fsImpl`.
 * Returns `{ disabled, servers, notes, legacy }`; `notes` is what `/piweb` and the notify show.
 */
export function resolveServers({ env = process.env, homedir = os.homedir(), fsImpl = fs, maxServers = LIMITS.maxServers } = {}) {
  const notes = [];
  if (env.PIWEB_BRIDGE_DISABLE === "1" || env.PIWEB_BRIDGE_DISABLE === "true") {
    return { disabled: true, servers: [], notes: ["disabled by PIWEB_BRIDGE_DISABLE"], legacy: null };
  }
  const servers = [];
  const seenSockets = new Set();
  const push = (spec, from) => {
    if (servers.length >= maxServers) {
      notes.push(`not connecting to ${from}: already at PIWEB_BRIDGE_MAX_SERVERS=${maxServers}`);
      return;
    }
    if (seenSockets.has(spec.socket)) return;
    seenSockets.add(spec.socket);
    servers.push(spec);
  };

  const accept = (resolved, source) => {
    if (!resolved.ok) {
      notes.push(`${source}: ${resolved.reason}${resolved.detail ? ` (${resolved.detail})` : ""}`);
      return false;
    }
    const d = resolved.descriptor;
    if (d.pid && !pidAlive(d.pid)) {
      notes.push(`${source}: server pid ${d.pid} is not running (stale descriptor)`);
      return false;
    }
    if (!fsImpl.existsSync(d.socket)) {
      notes.push(`${source}: socket ${d.socket} does not exist (is pi-web running?)`);
      return false;
    }
    push({ ...d, source, descriptorPath: resolved.path }, `${d.serverId}@${resolved.path}`);
    return true;
  };

  let primaryFound = false;
  let pointersDir = null;
  for (const cand of descriptorCandidates({ env, homedir })) {
    if (cand.kind === "inline") {
      const r = parseDescriptor(cand.descriptor, cand.source);
      if (accept(r, cand.source)) primaryFound = true;
    } else if (cand.kind === "file") {
      if (primaryFound) continue;
      if (!fsImpl.existsSync(cand.path)) continue;
      if (accept(parseDescriptor(readJsonSafe(cand.path, fsImpl), cand.path), cand.path)) primaryFound = true;
    } else if (cand.kind === "pointers") {
      pointersDir = cand.dir;
    }
  }

  // Other servers: pointer files written by pi-web instances on a non-default --data-dir.
  if (pointersDir) {
    let files = [];
    try {
      files = fsImpl.readdirSync(pointersDir).filter((f) => f.endsWith(".json"));
    } catch { /* no pointer dir: perfectly normal */ }
    for (const f of files) {
      const full = path.join(pointersDir, f);
      const pointer = readJsonSafe(full, fsImpl);
      const target = pointer && typeof pointer.descriptor === "string" ? pointer.descriptor : null;
      if (!target) {
        notes.push(`${full}: pointer without a descriptor path`);
        continue;
      }
      accept(parseDescriptor(readJsonSafe(target, fsImpl), target), `pointer ${f}`);
    }
  }

  if (!servers.length && !notes.length) {
    notes.push(`no pi-web server descriptor found (looked for ${descriptorCandidates({ env, homedir }).map((c) => c.path ?? c.source).join(", ")}) — start pi-web, or set PIWEB_DATA_DIR`);
  }

  // Legacy registry mode (02 §7): only when the old env pair is present.
  let legacy = null;
  const mode = (env.PIWEB_BRIDGE_MODE || "both").toLowerCase();
  const legacyToken = env.PIWEB_BRIDGE_TOKEN || "";
  const legacyDir = env.PIWEB_BRIDGE_DIR || path.join(homedir, ".pi-web", "bridges");
  if ((mode === "both" || mode === "legacy") && legacyToken.length >= 16) {
    legacy = { dir: legacyDir, token: legacyToken, mode };
  } else if ((mode === "both" || mode === "legacy") && env.PIWEB_BRIDGE_TOKEN) {
    notes.push("PIWEB_BRIDGE_TOKEN is set but shorter than 16 characters: legacy mode not started");
  }
  if (mode === "off") return { disabled: true, servers: [], notes: [...notes, "PIWEB_BRIDGE_MODE=off"], legacy: null };
  if (mode === "dial") legacy = null;
  if (mode === "legacy") servers.length = 0;
  return { disabled: false, servers, notes, legacy };
}

/* ------------------------------------------------------------------ framing */

export function encodeFrame(obj) {
  return `${JSON.stringify(obj)}\n`;
}

/** Newline framer with a buffer ceiling; `overflow` marks the connection fatal. */
export class LineFramer {
  constructor(maxBytes = LIMITS.inboundBytes) {
    this.maxBytes = maxBytes;
    this.buf = "";
    this.overflow = false;
  }
  feed(chunk) {
    this.buf += chunk.toString("utf8");
    if (this.buf.length > this.maxBytes) {
      this.overflow = true;
      return [];
    }
    const out = [];
    let idx;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.trim()) out.push(line);
    }
    return out;
  }
}

/** Bounded replay ring of outbound events (per runtime, shared by every server connection). */
export class ReplayRing {
  constructor(maxFrames = LIMITS.replayFrames, maxBytes = LIMITS.replayBytes) {
    this.maxFrames = maxFrames;
    this.maxBytes = maxBytes;
    this.frames = [];
    this.bytes = 0;
    this.oldestDroppedSeq = 0;
  }
  push(frame) {
    this.frames.push(frame);
    this.bytes += frame.bytes;
    while ((this.frames.length > this.maxFrames || this.bytes > this.maxBytes) && this.frames.length) {
      const drop = this.frames.shift();
      this.bytes -= drop.bytes;
      this.oldestDroppedSeq = drop.seq;
    }
  }
  /** Frames strictly after `afterSeq`; `contiguous:false` means the caller must resnapshot. */
  since(afterSeq) {
    const first = this.frames[0];
    const contiguous = !first || first.seq <= afterSeq + 1;
    return { contiguous, frames: this.frames.filter((f) => f.seq > afterSeq) };
  }
  get size() { return this.frames.length; }
  get lastSeq() { const f = this.frames[this.frames.length - 1]; return f ? f.seq : 0; }
}

/* ------------------------------------------------------- pi version detection */

export function detectPiVersion(env = process.env, fsImpl = fs) {
  const candidates = [];
  if (env.PIWEB_PI_PACKAGE) candidates.push(path.join(env.PIWEB_PI_PACKAGE, "package.json"));
  // 1) repo layout next to this file (workspace checkout)
  try {
    const here = path.dirname(new URL(import.meta.url).pathname);
    candidates.push(path.resolve(here, "..", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
    candidates.push(path.resolve(here, "..", "..", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
  } catch { /* unusual import.meta */ }
  // 2) walk up from the running CLI entry (global installs: .../pi-coding-agent/dist/bundle/cli.js)
  let dir = path.dirname(process.argv[1] ?? ".");
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(dir, "package.json"));
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  for (const c of candidates) {
    const pkg = readJsonSafe(c, fsImpl);
    if (pkg && pkg.name === "@earendil-works/pi-coding-agent") return String(pkg.version ?? "unknown");
  }
  return "unknown";
}

/* ------------------------------------------------- live state (bounded, local) */

function sanitizeBlock(b) {
  if (!b || typeof b !== "object") return { type: "unknown" };
  if (b.type === "text") return { type: "text", text: String(b.text ?? "") };
  if (b.type === "thinking") return { type: "thinking", thinking: String(b.thinking ?? "") };
  if (b.type === "toolCall") return { type: "toolCall", id: String(b.id ?? ""), name: String(b.name ?? ""), arguments: truncateArgs(b.arguments) };
  // No image bytes on the live channel: the browser reads the persisted entry instead.
  if (b.type === "image") return { type: "image", mimeType: String(b.mimeType ?? "") };
  return { type: String(b.type ?? "unknown") };
}

function snapshotPreview(p) {
  const blocks = [];
  let bytes = 0;
  let truncated = false;
  const content = p.msg?.content;
  if (Array.isArray(content)) {
    for (let i = 0; i < content.length; i++) {
      const b = content[i];
      const size = JSON.stringify(b)?.length ?? 0;
      if (bytes + size > LIMITS.previewBytes) { truncated = true; break; }
      blocks.push({ index: i, block: sanitizeBlock(b) });
      bytes += size;
    }
  } else if (typeof content === "string") {
    blocks.push({ index: 0, block: { type: "text", text: truncateText(content, LIMITS.previewBytes) } });
    truncated = content.length > LIMITS.previewBytes;
  }
  return {
    liveMessageId: p.liveMessageId, role: p.role, rev: p.rev, blocks, startedAt: p.startedAt,
    done: p.done, ...(p.mappedEntryId ? { mappedEntryId: p.mappedEntryId } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

function modelRef(m) {
  if (!m) return null;
  return {
    provider: String(m.provider ?? ""),
    modelId: String(m.id ?? ""),
    ...(m.name ? { name: String(m.name) } : {}),
    ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
    ...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
    reasoning: m.reasoning === true,
  };
}

export function capabilities(hub, ctx) {
  const sm = ctx?.sessionManager;
  return {
    snapshot: !!sm,
    livePreview: true,
    liveTree: typeof sm?.getTree === "function",
    promptStart: typeof hub.pi?.sendUserMessage === "function",
    promptSteer: typeof hub.pi?.sendUserMessage === "function",
    promptFollowUp: typeof hub.pi?.sendUserMessage === "function",
    abort: typeof ctx?.abort === "function",
    compact: typeof ctx?.compact === "function",
    setModel: typeof hub.pi?.setModel === "function",
    setThinking: typeof hub.pi?.setThinkingLevel === "function",
    rename: typeof hub.pi?.setSessionName === "function",
    modelsCatalog: typeof ctx?.modelRegistry?.find === "function",
    commandList: typeof hub.pi?.getCommands === "function",
    queue: "flag",
    clearQueue: false,
    dialogObserve: true,
    dialogRespond: false,
    stopForTerminal: false,
    contextUsage: typeof ctx?.getContextUsage === "function",
    runtimeContext: typeof sm?.buildContextEntries === "function",
    canControl: true,
    notes: [
      "Terminal extension dialogs are observable but must be answered in the terminal: the public Pi extension API gives no remote response path (ui_prompt_start/end carry kind/title only).",
      "Queue introspection is a pending flag only; queue contents and clearing are not exposed by the public API.",
      "Browser prompt text is delivered literally; slash-command and @path expansion happens only with the explicit expandCommands opt-in.",
    ],
  };
}

function treePreview(e) {
  if (e.type === "message") {
    const c = e.message?.content;
    if (typeof c === "string") return c.slice(0, 160);
    if (Array.isArray(c)) for (const b of c) if (b?.type === "text") return String(b.text).slice(0, 160);
  }
  return String(e.type ?? "");
}

export function buildTree(sm) {
  const tree = sm.getTree?.() ?? [];
  const nodes = {};
  const walk = (node, parentId) => {
    const id = node.entry?.id;
    if (!id) return;
    nodes[id] = {
      entryId: id,
      parentId: parentId ?? null,
      type: String(node.entry.type ?? "unknown"),
      timestamp: String(node.entry.timestamp ?? ""),
      label: node.label,
      preview: treePreview(node.entry),
      childIds: (node.children ?? []).map((c) => c.entry?.id).filter(Boolean),
      onActiveBranch: false,
    };
    for (const c of node.children ?? []) walk(c, id);
  };
  for (const root of tree) walk(root, null);
  const leaf = sm.getLeafId?.() ?? null;
  let cur = leaf;
  while (cur && nodes[cur]) {
    nodes[cur].onActiveBranch = true;
    cur = nodes[cur].parentId;
  }
  return { leaf: { entryId: leaf, source: "runtime" }, roots: tree.map((t) => t.entry?.id).filter(Boolean), nodes };
}

function contextMessagesLite(e) {
  if (e.type === "message" && e.message) {
    return [{ role: String(e.message.role ?? "?"), content: e.message.content ?? null, ...(e.id ? { entryId: e.id } : {}) }];
  }
  if (e.type === "compaction") return [{ role: "compaction", content: truncateText(e.summary, 2000), ...(e.id ? { entryId: e.id } : {}) }];
  return [];
}

/** Owner snapshot. Never throws: an unbound context is an error frame, not a crash. */
export function buildSnapshot(hub) {
  const ctx = hub.ctx;
  if (!ctx) throw err("host_unavailable", "extension context not yet captured");
  const sm = ctx.sessionManager;
  const entries = typeof sm.getEntries === "function" ? sm.getEntries() : [];
  const idle = ctx.isIdle();
  const pending = hub.observedDialogs.filter((d) => !d.endedAt).map((d) => ({
    requestId: d.requestId, requestGeneration: hub.sessionGeneration, kind: d.kind, title: d.title ?? "",
    answered: false, terminalObserved: true, createdAt: d.startedAt,
  }));
  return {
    sessionFile: sm.getSessionFile?.() ?? null,
    sessionId: sm.getSessionId?.() ?? null,
    cwd: sm.getCwd?.() ?? ctx.cwd ?? null,
    piVersion: hub.piVersion,
    mode: ctx.mode ?? "tui",
    leafEntryId: typeof sm.getLeafId === "function" ? sm.getLeafId() : null,
    leafSource: "runtime",
    phase: hub.compaction ? "compacting" : idle ? "idle" : "streaming",
    stateRevision: hub.stateRevision,
    isStreaming: !idle,
    previews: [...hub.previews.values()].map(snapshotPreview),
    tools: [...hub.tools.values()],
    queue: { hasPending: ctx.hasPendingMessages?.() ?? null, note: "Pending flag only; queue contents are not exposed by the extension API." },
    model: modelRef(ctx.model),
    thinkingLevel: hub.pi?.getThinkingLevel?.() ?? ctx.thinkingLevel ?? null,
    sessionName: hub.pi?.getSessionName?.() ?? null,
    contextUsage: ctx.getContextUsage?.() ?? null,
    pendingDialogs: pending,
    observedDialogs: hub.observedDialogs.slice(-LIMITS.maxObservedDialogs).map((d) => ({
      requestId: d.requestId, requestGeneration: hub.sessionGeneration, kind: d.kind, title: d.title ?? "",
      answered: !!d.endedAt, terminalObserved: true, createdAt: d.startedAt,
    })),
    lastSettled: hub.lastSettled,
    retry: null,
    compaction: hub.compaction ? { active: true, reason: hub.compaction } : null,
    entryCount: entries.length,
    capabilities: capabilities(hub, ctx),
  };
}

/** Everything a fresh server connection needs to adopt and attest this runtime. */
export function helloInfo(hub) {
  const ctx = hub.ctx;
  const sm = ctx?.sessionManager;
  return {
    t: "hello",
    protocol: BRIDGE_PROTOCOL,
    minProtocol: BRIDGE_MIN_PROTOCOL,
    runtimeId: hub.runtimeId,
    pid: hub.pid,
    procStart: hub.procStart,
    sessionId: sm?.getSessionId?.() ?? hub.sessionId ?? "",
    sessionFile: sm?.getSessionFile?.() ?? hub.sessionFile ?? null,
    cwd: sm?.getCwd?.() ?? ctx?.cwd ?? hub.cwd ?? process.cwd(),
    piVersion: hub.piVersion,
    piMode: ctx?.mode ?? "tui",
    adapterVersion: ADAPTER_VERSION,
    startedAt: hub.startedAt,
    sessionGeneration: hub.sessionGeneration,
    capabilities: capabilities(hub, ctx),
    attest: { cmdlineHash: hub.cmdlineHash, childOfPi: false },
  };
}

/* ------------------------------------------------------------------ commands */

/**
 * Browser -> terminal commands. Resolved through the hub at call time, never through a
 * captured instance handle (B-11): after /new the previous instance's `pi` throws.
 */
export async function handleCommand(hub, cmd, args = {}) {
  const pi = hub.pi;
  const ctx = hub.ctx;
  switch (cmd) {
    case "hello":
      return helloInfo(hub);
    case "snapshot":
      return buildSnapshot(hub);
    case "prompt": {
      if (!pi || !ctx) throw err("host_unavailable", "no session bound yet");
      // At-least-once safety: the same operation id must never fire twice.
      if (args.operationId) {
        if (hub.seenOps.has(args.operationId)) return { invoked: true, dedup: true };
        hub.seenOps.add(args.operationId);
        while (hub.seenOps.size > LIMITS.seenOpsMax) hub.seenOps.delete(hub.seenOps.values().next().value);
      }
      const { text, images, delivery = "start", expandCommands } = args;
      const content = images?.length
        ? [{ type: "text", text: String(text ?? "") }, ...images.map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType }))]
        : String(text ?? "");
      const busy = !ctx.isIdle();
      if (delivery === "start" && busy) throw err("busy", "session is streaming; use steer or a follow-up instead");
      if (delivery === "steer" && !busy) throw err("busy", "nothing to steer; the session is idle");
      const options = {};
      if (busy && delivery !== "start") options.deliverAs = delivery === "steer" ? "steer" : "followUp";
      // Literal delivery by default: expanding dispatches extension commands from browser text.
      if (expandCommands === true) options.expandPromptTemplates = true;
      pi.sendUserMessage(content, Object.keys(options).length ? options : undefined);
      return { invoked: true, delivery: busy ? delivery : "start", expanded: expandCommands === true };
    }
    case "abort": {
      if (!ctx || typeof ctx.abort !== "function") throw err("unsupported_capability", "abort unavailable");
      ctx.abort();
      return { requested: true, note: "Abort requested; completion arrives as agent_settled." };
    }
    case "compact": {
      if (!ctx || typeof ctx.compact !== "function") throw err("unsupported_capability", "compact unavailable");
      const opId = args?.operationId;
      ctx.compact({
        customInstructions: args?.instructions || undefined,
        onComplete: () => hub.broadcast("compact_done", { operationId: opId, ok: true }),
        onError: (e) => hub.broadcast("compact_done", { operationId: opId, ok: false, error: truncateText(e?.message ?? e, 200) }),
      });
      return { started: true };
    }
    case "setModel": {
      const reg = ctx?.modelRegistry;
      if (!reg || typeof pi?.setModel !== "function") throw err("unsupported_capability", "model switching unavailable");
      const model = reg.find(args.provider, args.modelId);
      if (!model) throw err("invalid_request", `model ${args.provider}/${args.modelId} not found`);
      const ok = await pi.setModel(model);
      if (!ok) throw err("pi_command_failed", "model rejected (is the provider authenticated?)");
      return { model: modelRef(ctx.model) };
    }
    case "setThinking": {
      if (typeof pi?.setThinkingLevel !== "function") throw err("unsupported_capability", "thinking level unavailable");
      pi.setThinkingLevel(args.level);
      return { level: pi.getThinkingLevel?.() ?? args.level };
    }
    case "rename": {
      if (typeof pi?.setSessionName !== "function") throw err("unsupported_capability", "rename unavailable");
      if (args.name === null || args.name === undefined) throw err("unsupported_capability", "clearing a session name is not supported by the extension API");
      pi.setSessionName(String(args.name));
      return { name: String(args.name) };
    }
    case "models": {
      const reg = ctx?.modelRegistry;
      if (!reg) throw err("unsupported_capability", "no model registry in this context");
      const list = (reg.getAvailable?.() ?? reg.getAll?.() ?? []).map((m) => ({ ...modelRef(m), available: true }));
      return { models: list.slice(0, 500) };
    }
    case "commands": {
      const cmds = pi?.getCommands?.() ?? [];
      return {
        commands: cmds
          .map((c) => ({ name: c.invocationName ?? c.name, description: c.description ?? "", source: c.source ?? "builtin" }))
          .slice(0, 300),
      };
    }
    case "tree": {
      const sm = ctx?.sessionManager;
      if (!sm || typeof sm.getTree !== "function") throw err("unsupported_capability", "tree unavailable");
      return buildTree(sm);
    }
    case "context": {
      const sm = ctx?.sessionManager;
      if (!sm || typeof sm.buildContextEntries !== "function") throw err("unsupported_capability", "context unavailable");
      const ctxEntries = sm.buildContextEntries();
      return {
        kind: "runtime_preview",
        leafEntryId: sm.getLeafId?.() ?? null,
        capturedAt: nowIso(),
        model: modelRef(ctx.model),
        thinkingLevel: pi?.getThinkingLevel?.() ?? null,
        messages: ctxEntries.flatMap(contextMessagesLite),
        unavailableFields: ["systemPrompt", "toolDeclarations", "routing", "providerPayload"],
        note: "Runtime preview from the owning terminal Pi's in-memory projection. Pi hooks/routing/conversion may still alter the actual provider request.",
      };
    }
    case "stats-lite": {
      const sm = ctx?.sessionManager;
      return {
        sessionId: sm?.getSessionId?.() ?? null,
        sessionFile: sm?.getSessionFile?.() ?? null,
        entryCount: sm?.getEntries?.().length ?? 0,
        cwd: sm?.getCwd?.() ?? ctx?.cwd ?? null,
      };
    }
    case "dialogRespond":
      throw err("unsupported_capability", "Terminal extension dialogs cannot be answered remotely through the public Pi extension API (ui_prompt_start/end carry no response handle). Answer in the terminal.");
    case "clearQueue":
      throw err("unsupported_capability", "Queue clearing is not exposed by the public Pi extension API.");
    case "stopForTerminal":
      throw err("unsupported_capability", "This session already runs in the terminal; there is nothing to hand off.");
    default:
      throw err("unsupported_capability", `unknown command ${cmd}`);
  }
}

/* ------------------------------------------------------------------ dialing */

/** One outbound connection to one discovered pi-web server. */
class DialConn {
  constructor(hub, spec) {
    this.hub = hub;
    this.spec = spec;
    this.id = `${spec.serverId}:${spec.socket}`;
    this.sock = null;
    this.authed = false;
    this.closed = false;
    this.fatal = false;
    this.retryStep = 0;
    this.lastSeenSeq = 0;
    this.resumedFrom = null;
    this.lastError = null;
    this.connectedAt = null;
    this.rejected = 0;
    this.timer = null;
  }

  start() {
    this.connect();
  }

  schedule(delayMs) {
    if (this.closed || this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, delayMs);
    this.timer.unref?.();
  }

  backoff() {
    const steps = LIMITS.retryStepsMs;
    const base = steps[Math.min(this.retryStep, steps.length - 1)];
    this.retryStep++;
    this.schedule(base + Math.floor(Math.random() * Math.min(500, base)));
  }

  fail(reason) {
    this.lastError = reason;
    this.hub.diag.rejects[reason.split(":")[0]] = (this.hub.diag.rejects[reason.split(":")[0]] ?? 0) + 1;
    this.hub.note(`fail:${reason}`, `pi-web ${this.spec.serverId}: ${reason}`);
    this.hub.diag.lastError = `${this.spec.serverId}: ${reason}`;
  }

  connect() {
    if (this.closed || this.sock) return;
    let sock;
    try {
      sock = net.createConnection({ path: this.spec.socket });
    } catch (e) {
      this.fail(`connect_error:${e.message}`);
      this.backoff();
      this.hub.refreshStatus();
      return;
    }
    sock.unref?.();
    sock.setNoDelay?.(true);
    this.sock = sock;
    const framer = new LineFramer();
    let deadline = null;
    const clearDeadline = () => { if (deadline) { clearTimeout(deadline); deadline = null; } };
    deadline = setTimeout(() => {
      if (!this.authed) { this.fail("auth_timeout"); this.closeSocket(); this.backoff(); this.hub.refreshStatus(); }
    }, LIMITS.authDeadlineMs);
    deadline.unref?.();

    sock.on("connect", () => {
      this.write({ t: "auth", token: this.spec.token, clientVersion: ADAPTER_VERSION });
      this.write(this.hub.hello());
    });
    sock.on("data", (chunk) => {
      for (const line of framer.feed(chunk)) {
        if (framer.overflow) { this.fail("buffer_overflow"); this.closeSocket(); this.backoff(); return; }
        let frame;
        try { frame = JSON.parse(line); } catch { this.rejected++; continue; }
        this.handleFrame(frame, clearDeadline);
      }
    });
    sock.on("error", (e) => { if (!this.authed) this.fail(`socket_error:${e.code ?? e.message}`); });
    sock.on("close", () => {
      clearDeadline();
      const wasAuthed = this.authed;
      this.sock = null;
      this.authed = false;
      if (this.closed) return;
      if (wasAuthed) { this.hub.diag.disconnects++; this.hub.note(`gone:${this.id}`, `pi-web ${this.spec.serverId} disconnected`); }
      if (!this.fatal) this.backoff();
      else this.schedule(LIMITS.descriptorScanMs);
      this.hub.refreshStatus();
    });
  }

  handleFrame(frame, clearDeadline) {
    if (!frame || typeof frame !== "object") return;
    if (!this.authed) {
      if (frame.t === "auth_ok") {
        clearDeadline?.();
        this.authed = true;
        this.fatal = false;
        this.retryStep = 0;
        this.connectedAt = nowIso();
        this.resumedFrom = Number(frame.resumedFrom ?? 0) || 0;
        this.hub.diag.connects++;
        this.hub.lastError = null;
        this.replayFrom(this.resumedFrom);
        this.hub.refreshStatus();
      } else if (frame.t === "auth_error") {
        // A wrong token or a rejected claim will not fix itself: back off hard and say why, once.
        this.fatal = true;
        this.fail(`auth_error:${frame.code ?? "unauthorized"}`);
        this.hub.diag.lastError = `${this.spec.serverId}: ${frame.code ?? "unauthorized"} — ${truncateText(frame.message, 120)}`;
        this.closeSocket();
      }
      return;
    }
    switch (frame.t) {
      case "cmd":
        this.hub.runCommand(frame, (res) => this.write(res));
        break;
      case "ping":
        if (typeof frame.lastSeenSeq === "number") this.lastSeenSeq = frame.lastSeenSeq;
        this.write({ t: "pong", id: frame.id, lastSeenSeq: this.hub.seq });
        break;
      case "pong":
        if (typeof frame.lastSeenSeq === "number") this.lastSeenSeq = frame.lastSeenSeq;
        break;
      case "replay":
        this.replayFrom(Number(frame.fromSeq) || 0);
        break;
      case "ev":
        if (frame.name === "reauth_required") { this.hub.rescanServers({ force: true }); this.closeSocket(); }
        break;
      default:
        break;
    }
  }

  write(obj) {
    if (!this.sock) return false;
    try {
      return this.sock.write(encodeFrame(obj));
    } catch {
      return false;
    }
  }

  /** Replay everything the server has not seen yet (bounded by the ring). */
  replayFrom(afterSeq) {
    if (!this.authed) return;
    const { contiguous, frames } = this.hub.ring.since(afterSeq);
    if (!contiguous) {
      this.write({ t: "gap", fromSeq: afterSeq, reason: "ring_evicted" });
      this.hub.note(`gap:${this.id}`, `pi-web ${this.spec.serverId}: replay window too small, the server will resnapshot`);
      return;
    }
    if (!frames.length) return;
    for (const f of frames) {
      if (!this.sock) return;
      try { this.sock.write(f.line); } catch { return; }
    }
  }

  /** Fan out one already-serialized event frame. Implements the documented drop policy. */
  sendEvent(rec) {
    if (!this.authed || !this.sock) return;
    const prio = eventPriority(rec.name);
    const buffered = this.sock.writableLength ?? 0;
    if (buffered > LIMITS.backpressureHardBytes && prio < 2) {
      if (prio === 0) this.hub.diag.droppedPreviews++;
      else this.hub.diag.droppedTools++;
      this.hub.diag.droppedAny = (this.hub.diag.droppedAny ?? 0) + 1;
      if (this.hub.diag.droppedAny % 50 === 0) this.hub.emitDiag();
      return;
    }
    if (buffered > LIMITS.backpressureSoftBytes && prio === 0) {
      this.hub.diag.droppedPreviews++;
      this.hub.diag.droppedAny = (this.hub.diag.droppedAny ?? 0) + 1;
      if (this.hub.diag.droppedAny % 50 === 0) this.hub.emitDiag();
      return;
    }
    try { this.sock.write(rec.line); } catch { /* socket closing; the ring still holds the frame */ }
  }

  advertise() {
    if (this.authed) this.write(this.hub.hello());
  }

  closeSocket() {
    this.authed = false;
    try { this.sock?.destroy(); } catch { /* already gone */ }
    this.sock = null;
  }

  close() {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.closeSocket();
  }
}

/* ------------------------------------------------- legacy registry transport */

/**
 * The pre-1.0 transport, kept for exactly one release (02 §7): this pi listens on its own
 * socket inside `PIWEB_BRIDGE_DIR` and writes a registry record an older pi-web polls.
 * Only started when PIWEB_BRIDGE_TOKEN (+ optional PIWEB_BRIDGE_DIR) is present.
 */
class LegacyListener {
  constructor(hub, cfg) {
    this.hub = hub;
    this.cfg = cfg;
    this.dir = cfg.dir;
    this.token = cfg.token;
    this.socketPath = path.join(cfg.dir, `r-${hub.runtimeId}.sock`);
    this.recordPath = path.join(cfg.dir, `r-${hub.runtimeId}.json`);
    this.conns = new Set();
    this.server = null;
    this.started = false;
  }

  registryRecord() {
    const h = helloInfo(this.hub);
    return {
      protocol: BRIDGE_PROTOCOL,
      runtimeId: this.hub.runtimeId,
      socketPath: this.socketPath,
      tokenHash: crypto.createHash("sha256").update(this.token).digest("hex"),
      pid: this.hub.pid,
      procStart: this.hub.procStart,
      piVersion: this.hub.piVersion,
      startedAt: this.hub.startedAt,
      cwd: h.cwd,
      sessionFile: h.sessionFile,
      sessionId: h.sessionId,
      mode: h.piMode,
      capabilities: h.capabilities,
    };
  }

  writeRegistry() {
    try {
      writeJsonAtomic(this.recordPath, this.registryRecord(), this.hub.fsImpl);
      try { this.hub.fsImpl.chmodSync(this.socketPath, 0o600); } catch { /* not listening yet */ }
    } catch (e) {
      this.hub.diag.lastError = `legacy registry write failed: ${e.message}`;
    }
  }

  removeArtifacts() {
    for (const f of [this.recordPath, this.socketPath]) {
      try { if (this.hub.fsImpl.existsSync(f)) this.hub.fsImpl.unlinkSync(f); } catch { /* gone */ }
    }
  }

  start() {
    if (this.started) return;
    this.started = true;
    try {
      this.hub.fsImpl.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      this.server = net.createServer((conn) => this.onConn(conn));
      this.server.on("error", (e) => { this.hub.diag.lastError = `legacy listener: ${e.message}`; });
      this.server.listen(this.socketPath, () => {
        try { this.hub.fsImpl.chmodSync(this.socketPath, 0o600); } catch { /* best effort */ }
        this.writeRegistry();
      });
      this.server.unref?.();
    } catch (e) {
      this.hub.diag.lastError = `legacy listener failed: ${e.message}`;
    }
  }

  onConn(conn) {
    conn.on("error", () => conn.destroy());
    const framer = new LineFramer();
    let authed = false;
    conn.on("data", (chunk) => {
      for (const line of framer.feed(chunk)) {
        if (framer.overflow) { conn.destroy(); return; }
        let frame;
        try { frame = JSON.parse(line); } catch { continue; }
        if (!authed) {
          if (frame.t === "auth" && constantTimeEquals(String(frame.token ?? ""), this.token)) {
            authed = true;
            this.conns.add(conn);
            this.writeRegistry();
            // Legacy shape: the pre-1.0 server reads `hello` off the auth_ok frame.
            try { conn.write(encodeFrame({ t: "auth_ok", protocol: BRIDGE_PROTOCOL, hello: helloInfo(this.hub) })); } catch { /* closing */ }
          } else {
            try { conn.write(encodeFrame({ t: "res", id: "auth", ok: false, error: { code: "unauthorized", message: "bad token" } })); } catch { /* closing */ }
            conn.destroy();
            return;
          }
          continue;
        }
        if (frame.t === "ping") { try { conn.write(encodeFrame({ t: "pong", id: frame.id })); } catch { /* closing */ } continue; }
        if (frame.t === "cmd") this.hub.runCommand(frame, (res) => { try { conn.write(encodeFrame(res)); } catch { /* closing */ } });
      }
    });
    conn.on("close", () => this.conns.delete(conn));
  }

  sendEvent(rec) {
    for (const c of this.conns) { try { c.write(rec.line); } catch { this.conns.delete(c); } }
  }

  get viewers() { return this.conns.size; }

  stop() {
    this.started = false;
    try { this.server?.close(); } catch { /* ignore */ }
    for (const c of this.conns) { try { c.destroy(); } catch { /* ignore */ } }
    this.conns.clear();
    this.removeArtifacts();
  }
}

/* ------------------------------------------------------------------ the hub */

/**
 * Process-global bridge state. Lives on `globalThis` because pi re-instantiates extensions on
 * /new, /resume, /fork and /reload in the *same* process (measured): the socket must survive
 * the switch while the `pi`/`ctx` handles must be refreshed.
 */
export function createHub(opts = {}) {
  const env = opts.env ?? process.env;
  const fsImpl = opts.fs ?? fs;
  const homedir = opts.homedir ?? os.homedir();
  const hub = {
    runtimeId: crypto.randomBytes(8).toString("hex"),
    pid: process.pid,
    procStart: Math.floor(performance.timeOrigin),
    startedAt: nowIso(),
    cmdlineHash: crypto.createHash("sha256").update(process.argv.join("\0")).digest("hex"),
    piVersion: opts.piVersion ?? detectPiVersion(env, fsImpl),
    adapterVersion: ADAPTER_VERSION,
    env,
    fsImpl,
    homedir,
    pi: null,
    ctx: null,
    sessionId: null,
    sessionFile: null,
    cwd: process.cwd(),
    sessionGeneration: 0,
    lastError: null,
    seq: 0,
    ring: new ReplayRing(),
    conns: new Map(),
    legacy: null,
    resolution: { servers: [], notes: [], disabled: false, legacy: null },
    seenOps: new Set(),
    previews: new Map(),
    previewOrder: [],
    tools: new Map(),
    observedDialogs: [],
    stateRevision: 0,
    compaction: null,
    lastSettled: null,
    diag: { connects: 0, disconnects: 0, rejects: {}, droppedPreviews: 0, droppedTools: 0, droppedAny: 0, notes: [], lastError: null },
    wired: false,
    notifiedOnce: new Set(),
    timers: [],
    idSeq: 0,
    scanTimer: null,
    scanRetry: null,
    scanRetryStep: 0,
    watch: null,
    previewThrottle: new Map(),
    toolThrottle: new Map(),
    maxServers: Number(env.PIWEB_BRIDGE_MAX_SERVERS) || LIMITS.maxServers,
    modes: (env.PIWEB_BRIDGE_MODES || "tui").split(",").map((s) => s.trim()).filter(Boolean),
    disabledByFlag: false,
    listeners: new Set(),
  };

  hub.touch = () => { hub.stateRevision++; };

  hub.note = (key, message) => {
    if (hub.notifiedOnce.has(key)) return;
    hub.notifiedOnce.add(key);
    hub.diag.notes.push(`${nowIso()} ${message}`);
    while (hub.diag.notes.length > 40) hub.diag.notes.shift();
    hub.log("info", message);
  };

  hub.log = (level, message, fields) => {
    const sink = env.PIWEB_BRIDGE_DEBUG;
    if (!sink) return;
    const line = `${nowIso()} [pi-web-bridge ${level}] ${message}${fields ? ` ${JSON.stringify(fields)}` : ""}\n`;
    try {
      if (sink === "1" || sink === "stderr") process.stderr.write(line);
      else fsImpl.appendFileSync(sink, line);
    } catch { /* never let logging break pi */ }
  };

  hub.hello = () => helloInfo(hub);

  hub.emitDiag = () => {
    hub.broadcast("diag", {
      droppedPreviews: hub.diag.droppedPreviews,
      droppedTools: hub.diag.droppedTools,
      ring: hub.ring.size,
      seq: hub.seq,
      conns: [...hub.conns.values()].map((c) => ({ serverId: c.spec.serverId, authed: c.authed, lastError: c.lastError })),
    });
  };

  /** The single outbound path: one seq, one serialization, fan-out to every sink. */
  hub.broadcast = (name, payload) => {
    try {
      const seq = ++hub.seq;
      const line = encodeFrame({ t: "ev", seq, name, payload: payload ?? {} });
      const rec = { seq, name, payload: payload ?? {}, line, bytes: line.length };
      hub.ring.push(rec);
      for (const c of hub.conns.values()) c.sendEvent(rec);
      if (hub.legacy) hub.legacy.sendEvent(rec);
      return seq;
    } catch (e) {
      hub.diag.lastError = `broadcast: ${e.message}`;
      return 0;
    }
  };

  /** Command execution with generation fencing, shared by the dial and legacy transports. */
  hub.runCommand = (frame, reply) => {
    const run = async () => {
      if (typeof frame.sessionGeneration === "number" && frame.sessionGeneration !== hub.sessionGeneration) {
        return { t: "res", id: frame.id, ok: false, error: { code: "stale_control", message: `session generation ${frame.sessionGeneration} is not current (${hub.sessionGeneration})` } };
      }
      try {
        const data = await handleCommand(hub, frame.cmd, frame.args ?? {});
        return { t: "res", id: frame.id, ok: true, data };
      } catch (e) {
        return { t: "res", id: frame.id, ok: false, error: { code: e.code ?? "internal", message: truncateText(e.message ?? e, 300) } };
      }
    };
    run().then(reply, (e) => reply({ t: "res", id: frame.id, ok: false, error: { code: "internal", message: truncateText(e?.message ?? e, 300) } }));
  };

  hub.viewers = () => {
    let n = 0;
    for (const c of hub.conns.values()) if (c.authed) n++;
    if (hub.legacy) n += hub.legacy.viewers;
    return n;
  };

  hub.connectedServers = () => [...hub.conns.values()].filter((c) => c.authed).map((c) => c.spec.serverId);

  hub.describe = () => ({
    runtimeId: hub.runtimeId.slice(0, 8),
    pid: hub.pid,
    piVersion: hub.piVersion,
    adapterVersion: hub.adapterVersion,
    sessionGeneration: hub.sessionGeneration,
    sessionId: hub.sessionId,
    sessionFile: hub.sessionFile,
    cwd: hub.cwd,
    mode: hub.ctx?.mode ?? null,
    seq: hub.seq,
    ring: hub.ring.size,
    servers: [...hub.conns.values()].map((c) => ({
      serverId: c.spec.serverId, socket: c.spec.socket, source: c.spec.source,
      connected: c.authed, lastError: c.lastError, connectedAt: c.connectedAt,
    })),
    legacy: hub.legacy ? { dir: hub.legacy.dir, socket: hub.legacy.socketPath, viewers: hub.legacy.viewers } : null,
    dropped: { previews: hub.diag.droppedPreviews, tools: hub.diag.droppedTools },
    disabled: hub.resolution.disabled || hub.disabledByFlag,
    notes: hub.diag.notes.slice(-6),
    lastError: hub.diag.lastError ?? hub.lastError,
  });

  /* -------- server discovery -------- */

  hub.rescanServers = ({ force = false } = {}) => {
    if (!hub.bridgeAllowed()) {
      hub.markUnavailable(hub.disabledByFlag
        ? "disabled by --no-pi-web-bridge"
        : `mode ${hub.ctx?.mode ?? "?"} is not bridged (PIWEB_BRIDGE_MODES=${hub.modes.join(",")})`);
      return;
    }
    let resolution;
    try {
      resolution = resolveServers({ env, homedir: hub.homedir, fsImpl, maxServers: hub.maxServers });
    } catch (e) {
      hub.diag.lastError = `descriptor scan failed: ${e.message}`;
      return;
    }
    hub.resolution = resolution;
    if (resolution.disabled) {
      hub.closeAll();
      return;
    }
    const wanted = new Map(resolution.servers.map((s) => [`${s.serverId}:${s.socket}`, s]));
    // Drop connections whose descriptor disappeared (server shut down, data dir changed).
    for (const [id, conn] of hub.conns) {
      if (!wanted.has(id)) {
        conn.close();
        hub.conns.delete(id);
        if (force) hub.note(`dropped:${id}`, `stopped connecting to ${conn.spec.serverId} (descriptor gone)`);
      }
    }
    for (const [id, spec] of wanted) {
      if (hub.conns.has(id)) continue;
      const conn = new DialConn(hub, spec);
      hub.conns.set(id, conn);
      conn.start();
      hub.log("info", `dialling ${spec.serverId} at ${spec.socket} (from ${spec.source})`);
    }
    if (resolution.legacy && !hub.legacy) {
      hub.legacy = new LegacyListener(hub, resolution.legacy);
      hub.legacy.start();
      hub.note("legacy-start", `legacy bridge listening on ${hub.legacy.socketPath}`);
    }
    if (!resolution.legacy && hub.legacy) {
      hub.legacy.stop();
      hub.legacy = null;
    }
    if (!resolution.servers.length && resolution.notes.length) {
      hub.note("no-server", resolution.notes[0]);
    }
    hub.ensureScanTimer();
    // "pi was started before pi-web": with no server to dial there is nothing to back off *from*,
    // so the scan itself must retry on the same ladder (H-03), not only on the 60 s heartbeat.
    if (!resolution.servers.length && !hub.conns.size) {
      const step = LIMITS.retryStepsMs[Math.min(hub.scanRetryStep, LIMITS.retryStepsMs.length - 1)];
      hub.scanRetryStep++;
      if (!hub.scanRetry) {
        hub.scanRetry = setTimeout(() => { hub.scanRetry = null; hub.rescanServers({}); }, step + Math.floor(Math.random() * Math.min(500, step)));
        hub.scanRetry.unref?.();
      }
    } else {
      hub.scanRetryStep = 0;
      if (hub.scanRetry) { clearTimeout(hub.scanRetry); hub.scanRetry = null; }
    }
  };

  hub.ensureScanTimer = () => {
    if (hub.scanTimer) return;
    hub.scanTimer = setInterval(() => hub.rescanServers({}), LIMITS.descriptorScanMs);
    hub.scanTimer.unref?.();
    // Fast path where watching works: a server that just started is picked up immediately.
    try {
      const dir = path.dirname(descriptorCandidates({ env, homedir: hub.homedir }).find((c) => c.kind === "file")?.path ?? path.join(hub.homedir, ".pi-web", "bridge.json"));
      hub.watch = fsImpl.watch(dir, { persistent: false }, () => {
        clearTimeout(hub.watchDebounce);
        hub.watchDebounce = setTimeout(() => hub.rescanServers({ force: true }), 150);
        hub.watchDebounce.unref?.();
      });
      hub.watch.on?.("error", () => { try { hub.watch?.close(); } catch { /* ignore */ } hub.watch = null; });
    } catch { /* watching is an optimization only */ }
  };

  hub.advertiseAll = () => {
    for (const c of hub.conns.values()) c.advertise();
    if (hub.legacy) hub.legacy.writeRegistry();
  };

  hub.closeAll = () => {
    for (const c of hub.conns.values()) c.close();
    hub.conns.clear();
    if (hub.legacy) { hub.legacy.stop(); hub.legacy = null; }
    if (hub.scanTimer) { clearInterval(hub.scanTimer); hub.scanTimer = null; }
    if (hub.scanRetry) { clearTimeout(hub.scanRetry); hub.scanRetry = null; }
    if (hub.watchDebounce) clearTimeout(hub.watchDebounce);
    try { hub.watch?.close(); } catch { /* ignore */ }
    hub.watch = null;
  };

  /** Nothing to dial, and the reason is recorded so `/piweb` and `/runtimes` can say it. */
  hub.markUnavailable = (note) => {
    hub.resolution = { disabled: true, servers: [], notes: [note], legacy: null };
    hub.closeAll();
  };

  /* -------- status surface inside pi -------- */

  hub.refreshStatus = () => {
    const ui = hub.ctx?.ui;
    if (!ui?.setStatus) return;
    try {
      const servers = hub.connectedServers();
      if (servers.length) ui.setStatus("pi-web", `● pi-web · ${hub.viewers()} viewer${hub.viewers() === 1 ? "" : "s"} · ${servers.join(",")}`);
      else ui.setStatus("pi-web", `○ pi-web${hub.diag.lastError ? ` · ${truncateText(hub.diag.lastError, 40)}` : ""}`);
    } catch { /* the UI may be gone during shutdown */ }
  };

  hub.notifyOnce = (key, message) => {
    if (hub.notifiedOnce.has(key)) return;
    hub.notifiedOnce.add(key);
    try { hub.ctx?.ui?.notify?.(message, "warning"); } catch { /* no UI */ }
  };

  return hub;
}

/* ------------------------------------------------- instance + session binding */

/** liveMessageId per message object, without writing into pi's own objects. */
const liveIds = new WeakMap();
function liveIdOf(hub, msg) {
  if (!msg || typeof msg !== "object") return null;
  let id = liveIds.get(msg);
  if (!id) {
    id = `lm-${Date.now().toString(36)}-${++hub.idSeq}`;
    liveIds.set(msg, id);
  }
  return id;
}

/**
 * The tracker for a message handed to `message_start/update/end`.
 *
 * Object identity is *not* stable here: pi passes a fresh message object for every streamed
 * chunk, so keying previews on it (the old behaviour, `liveIdOf` alone) minted one preview per
 * token — duplicate assistant rows in the browser, each stuck on "working", replayed on every
 * reload and growing without bound (BUG-004). Trackers are therefore keyed by their own id and
 * re-associated to the newest object positionally: the same object if we have seen it, otherwise
 * the most recent still-open tracker of the same role. The managed host already works this way.
 */
function trackerFor(hub, msg, role, { create = true } = {}) {
  const byObj = msg && typeof msg === "object" ? liveIds.get(msg) : null;
  const existing = byObj ? hub.previews.get(byObj) : null;
  if (existing) { existing.msg = msg; return existing; }
  for (let i = hub.previewOrder.length - 1; i >= 0; i--) {
    const p = hub.previews.get(hub.previewOrder[i]);
    if (p && !p.done && p.role === role) { try { liveIds.set(msg, p.liveMessageId); } catch { /* non-object */ } p.msg = msg; return p; }
  }
  if (!create) return null;
  const id = liveIdOf(hub, msg);
  const p = { msg, liveMessageId: id, role, rev: 0, done: false, startedAt: nowIso(), bytes: 0 };
  hub.previews.set(id, p);
  hub.previewOrder.push(id);
  while (hub.previewOrder.length > LIMITS.maxPreviews) {
    const dropId = hub.previewOrder.shift();
    if (dropId === id) { hub.previewOrder.push(dropId); continue; }
    const drop = hub.previews.get(dropId);
    // A preview evicted while still open was never closed by a message_end: say `done` out loud
    // so the browser stops showing it as an in-flight row.
    if (drop && !drop.done) { drop.done = true; hub.broadcast("message_end", { liveMessageId: drop.liveMessageId, preview: snapshotPreview(drop) }); }
    hub.previews.delete(dropId);
  }
  return p;
}

/** Close everything still streaming: after a turn or a settle nothing more can arrive. */
function closeOpenPreviews(hub, role) {
  for (const id of [...hub.previewOrder]) {
    const p = hub.previews.get(id);
    if (!p || p.done || (role && p.role !== role)) continue;
    p.done = true;
    p.rev++;
    const t = hub.previewThrottle.get(id);
    if (t) { clearTimeout(t); hub.previewThrottle.delete(id); }
    hub.broadcast("message_end", { liveMessageId: p.liveMessageId, preview: snapshotPreview(p) });
  }
}


export function createInstanceApi(hub) {
  hub.bindInstance = (pi) => {
    hub.pi = pi;
    return hub;
  };

  hub.bindContext = (ctx) => {
    if (!ctx) return hub;
    hub.ctx = ctx;
    const sm = ctx.sessionManager;
    hub.sessionId = sm?.getSessionId?.() ?? hub.sessionId;
    hub.sessionFile = sm?.getSessionFile?.() ?? hub.sessionFile;
    hub.cwd = sm?.getCwd?.() ?? ctx.cwd ?? hub.cwd;
    return hub;
  };

  hub.clearSessionState = () => {
    hub.previews.clear();
    hub.previewOrder.length = 0;
    hub.tools.clear();
    hub.observedDialogs.length = 0;
    hub.compaction = null;
    hub.lastSettled = null;
    for (const t of hub.previewThrottle.values()) clearTimeout(t);
    for (const t of hub.toolThrottle.values()) clearTimeout(t);
    hub.previewThrottle.clear();
    hub.toolThrottle.clear();
    hub.touch();
  };

  hub.bridgeAllowed = () => {
    if (hub.disabledByFlag) return false;
    if ((hub.env.PIWEB_BRIDGE_DISABLE ?? "") === "1") return false;
    const mode = hub.ctx?.mode ?? "tui";
    return hub.modes.includes(mode);
  };

  hub.onSessionStart = (pi, ctx, reason) => {
    hub.bindInstance(pi);
    hub.bindContext(ctx);
    hub.sessionGeneration++;
    hub.clearSessionState();
    if (!hub.bridgeAllowed()) {
      hub.markUnavailable(hub.disabledByFlag
        ? "this session opted out with --no-pi-web-bridge"
        : `pi is running in ${hub.ctx?.mode ?? "unknown"} mode; only ${hub.modes.join(",")} is bridged`);
      hub.refreshStatus();
      return;
    }
    hub.broadcast("session_start", {
      reason,
      sessionId: hub.sessionId,
      sessionFile: hub.sessionFile,
      sessionGeneration: hub.sessionGeneration,
      cwd: hub.cwd,
    });
    hub.rescanServers();
    hub.advertiseAll();
    hub.refreshStatus();
    // A descriptor that appears later is picked up by the scan timer; say why nothing is up.
    if (!hub.conns.size && hub.resolution.notes.length) {
      hub.notifyOnce("no-server-notify", `pi-web bridge is not connected: ${hub.resolution.notes[0]}`);
    }
  };

  hub.onInstanceShutdown = (reason) => {
    hub.broadcast("session_shutdown", { reason });
    if (reason === "quit") {
      hub.closeAll();
      try { hub.ctx?.ui?.setStatus?.("pi-web", undefined); } catch { /* going away */ }
      return;
    }
    // new | resume | fork | reload: the socket belongs to the process, so it stays up;
    // this instance's pi/ctx are stale from here on (B-5/B-11).
    hub.wired = false;
    hub.pi = null;
    hub.ctx = null;
    hub.clearSessionState();
  };

  return hub;
}

/**
 * Wire one extension instance into the hub. `wire:false` still refreshes the live handles
 * (the double-load guard), it only skips a second copy of every event handler.
 */
export function attach(hub, pi, { wire = true } = {}) {
  if (!hub.bindInstance) createInstanceApi(hub);
  hub.bindInstance(pi);
  try {
    if (typeof pi.registerFlag === "function") {
      pi.registerFlag("no-pi-web-bridge", { description: "Do not connect this pi session to pi-web", type: "boolean" });
    }
    if (typeof pi.getFlag === "function") hub.disabledByFlag = Boolean(pi.getFlag("no-pi-web-bridge"));
  } catch { /* an older pi without flag support: PIWEB_BRIDGE_DISABLE still works */ }

  if (!wire) return hub;
  hub.wired = true;

  if (typeof pi.registerCommand === "function") {
    pi.registerCommand("piweb", {
      description: "Show the pi-web bridge status for this terminal",
      handler: async (_args, ctx) => {
        hub.bindContext(ctx);
        const d = hub.describe();
        const line = d.servers.filter((s) => s.connected);
        if (line.length) {
          ctx.ui.notify(`pi-web ${line.map((s) => s.serverId).join(",")}: live · ${d.sessionFile ?? "no file yet"} · ${hub.viewers()} viewer${hub.viewers() === 1 ? "" : "s"} · ${d.dropped.previews} dropped`, "info");
        } else if (d.disabled) {
          ctx.ui.notify("pi-web bridge is disabled for this session (PIWEB_BRIDGE_DISABLE / --no-pi-web-bridge).", "info");
        } else {
          const why = d.lastError ?? hub.resolution.notes[0] ?? "no server descriptor found";
          ctx.ui.notify(`pi-web bridge is not connected: ${why}`, "warning");
        }
        for (const n of d.notes.slice(-3)) ctx.ui.notify(`  · ${n}`, "info");
      },
    });
  }

  const on = (ev, handler) => {
    try {
      pi.on(ev, async (event, ctx) => {
        try {
          if (ctx) hub.bindContext(ctx);
          await handler(event, ctx);
        } catch (e) {
          // Never let a bridge failure surface inside pi.
          hub.diag.lastError = `${ev}: ${truncateText(e?.message ?? e, 160)}`;
          hub.log("error", hub.diag.lastError);
        }
      });
    } catch { /* event unsupported by this pi version */ }
  };

  const previewFrame = (p) => ({ liveMessageId: p.liveMessageId, preview: snapshotPreview(p) });

  const throttledPreview = (p) => {
    const key = p.liveMessageId;
    if (hub.previewThrottle.has(key)) return;
    const timer = setTimeout(() => {
      hub.previewThrottle.delete(key);
      hub.broadcast("message_update", previewFrame(p));
    }, LIMITS.previewCoalesceMs);
    timer.unref?.();
    hub.previewThrottle.set(key, timer);
  };

  const throttledTool = (id) => {
    if (hub.toolThrottle.has(id)) return;
    const timer = setTimeout(() => {
      hub.toolThrottle.delete(id);
      hub.broadcast("tool_update", { tool: hub.tools.get(id) });
    }, LIMITS.toolCoalesceMs);
    timer.unref?.();
    hub.toolThrottle.set(id, timer);
  };

  on("session_start", (e, ctx) => hub.onSessionStart(pi, ctx, e.reason));
  on("session_shutdown", (e) => hub.onInstanceShutdown(e.reason));
  on("session_info_changed", (e) => {
    hub.touch();
    hub.broadcast("session_info_changed", { name: e.name ?? null });
    if (hub.legacy) hub.legacy.writeRegistry();
  });
  on("session_tree", (e) => {
    hub.touch();
    hub.broadcast("session_tree", { newLeafId: e.newLeafId ?? null, oldLeafId: e.oldLeafId ?? null });
  });
  on("session_before_compact", () => {
    hub.compaction = "manual";
    hub.touch();
    hub.broadcast("runtime_state", { phase: "compacting" });
  });
  on("session_compact", (e) => {
    hub.compaction = null;
    hub.touch();
    hub.broadcast("compacted", { entryId: e.compactionEntry?.id ?? null, reason: e.reason, willRetry: !!e.willRetry });
  });
  on("session_compact_failed", (e) => {
    hub.compaction = null;
    hub.touch();
    hub.broadcast("compact_failed", { reason: e.reason ?? "unknown" });
  });

  on("agent_start", () => { hub.touch(); hub.broadcast("agent_start", {}); });
  on("agent_settled", (e) => {
    hub.lastSettled = { at: nowIso(), aborted: !!e.aborted };
    closeOpenPreviews(hub); // the agent has settled: no preview is still streaming
    hub.touch();
    hub.broadcast("agent_settled", { aborted: !!e.aborted });
  });

  on("message_start", (e) => {
    const role = e.message?.role === "user" ? "user" : "assistant";
    const p = trackerFor(hub, e.message, role);
    hub.touch();
    hub.broadcast("message_start", { liveMessageId: p.liveMessageId, role });
  });
  on("message_update", (e) => {
    const p = trackerFor(hub, e.message, e.message?.role === "user" ? "user" : "assistant");
    p.rev++;
    throttledPreview(p);
  });
  on("message_end", (e) => {
    const p = trackerFor(hub, e.message, e.message?.role === "user" ? "user" : "assistant", { create: false });
    if (p) {
      p.done = true;
      p.rev++;
      const t = hub.previewThrottle.get(p.liveMessageId);
      if (t) { clearTimeout(t); hub.previewThrottle.delete(p.liveMessageId); }
      hub.broadcast("message_end", previewFrame(p));
    }
    hub.touch();
  });
  on("turn_end", (e) => {
    const p = trackerFor(hub, e.message, e.message?.role === "user" ? "user" : "assistant", { create: false });
    if (p) p.mappedEntryId = e.messageEntryId;
    // Whatever this turn left open is finished business, not a live stream (BUG-004). Closing here
    // (rather than silently marking the mapped one done) means every listener gets a definitive
    // `message_end` for it instead of having to infer the end from the turn frame.
    closeOpenPreviews(hub, "assistant");
    hub.touch();
    // `messageEntryId` is the mapping that lets the browser collapse a live preview into the
    // persisted entry instead of showing the same assistant message twice.
    hub.broadcast("turn_end", {
      messageEntryId: e.messageEntryId ?? null,
      toolResultEntryIds: e.toolResultEntryIds ?? [],
      liveMessageId: p ? p.liveMessageId : null,
      turnIndex: e.turnIndex,
    });
  });

  on("tool_execution_start", (e) => {
    hub.tools.set(e.toolCallId, {
      toolCallId: e.toolCallId,
      toolName: e.toolName,
      state: "running",
      argsPreview: truncateArgs(e.args),
      outputMode: "replace",
      startedAt: nowIso(),
      ...(e.parentToolCallId ? { parentToolCallId: e.parentToolCallId } : {}),
    });
    hub.touch();
    hub.broadcast("tool_update", { tool: hub.tools.get(e.toolCallId) });
  });
  on("tool_execution_update", (e) => {
    const t = hub.tools.get(e.toolCallId) ?? {
      toolCallId: e.toolCallId, toolName: e.toolName, state: "running", startedAt: nowIso(), outputMode: "replace",
    };
    // Pi sends cumulative snapshots for partial tool results: replace, never append.
    const partial = e.partialResult;
    if (Array.isArray(partial?.content)) t.outputContent = partial.content.map(sanitizeBlock);
    const size = JSON.stringify(partial ?? {})?.length ?? 0;
    if (size > LIMITS.toolStateBytes) {
      t.truncated = true;
      delete t.outputContent;
    }
    hub.tools.set(e.toolCallId, t);
    throttledTool(e.toolCallId);
  });
  on("tool_execution_end", (e) => {
    const t = hub.tools.get(e.toolCallId) ?? {
      toolCallId: e.toolCallId, toolName: e.toolName, state: "running", startedAt: nowIso(), outputMode: "replace",
    };
    t.state = e.isError ? "error" : "ok";
    if (typeof e.durationMs === "number") t.durationMs = e.durationMs;
    t.endedAt = nowIso();
    const content = e.result?.content;
    if (Array.isArray(content)) {
      const size = JSON.stringify(content).length;
      if (size > LIMITS.toolStateBytes) { t.truncated = true; t.outputContent = [{ type: "text", text: `[output truncated: ${size} bytes]` }]; }
      else t.outputContent = content.map(sanitizeBlock);
    }
    if (e.result?.details != null) {
      const s = JSON.stringify(e.result.details);
      if (s && s.length <= 256 * 1024) t.details = e.result.details;
      else t.details = { _truncated: true };
    }
    hub.tools.set(e.toolCallId, t);
    hub.touch();
    hub.broadcast("tool_update", { tool: t });
  });

  on("model_select", (e) => {
    hub.touch();
    hub.broadcast("model_select", { model: modelRef(e.model), previous: modelRef(e.previousModel), source: e.source });
    if (hub.legacy) hub.legacy.writeRegistry();
  });
  on("thinking_level_select", (e) => {
    hub.touch();
    hub.broadcast("thinking_level_select", { level: e.level, previous: e.previousLevel });
  });

  on("ui_prompt_start", (e) => {
    const requestId = `term-${hub.observedDialogs.length + 1}-${hub.sessionGeneration}`;
    hub.observedDialogs.push({ requestId, kind: e.kind ?? "custom", title: e.title ?? "", startedAt: nowIso(), endedAt: null });
    while (hub.observedDialogs.length > LIMITS.maxObservedDialogs) hub.observedDialogs.shift();
    hub.touch();
    hub.broadcast("dialog_observed", {
      requestId,
      requestGeneration: hub.sessionGeneration,
      kind: e.kind ?? "custom",
      title: e.title ?? "",
      terminalObserved: true,
      note: "Answer in the terminal; remote answering is not supported by the public Pi extension API.",
    });
  });
  on("ui_prompt_end", (e) => {
    const d = [...hub.observedDialogs].reverse().find((x) => !x.endedAt && x.kind === (e.kind ?? "custom"));
    if (d) d.endedAt = nowIso();
    hub.touch();
    hub.broadcast("dialog_observed_end", { kind: e.kind ?? "custom", title: e.title ?? "" });
  });

  // Transparency only: the terminal is never fenced by the bridge.
  on("input", (e) => hub.broadcast("input_seen", { source: e.source, streamingBehavior: e.streamingBehavior ?? null }));

  return hub;
}

/* ------------------------------------------------------------------ factory */

export default function piWebBridge(pi) {
  // pi-web's own managed SDK host: that runtime is already owned by pi-web itself.
  if (process.env.PIWEB_MANAGED_HOST === "1") return;
  const hub = (globalThis.__piwebBridge ??= createHub());
  createInstanceApi(hub);
  const alreadyWired = hub.wired;
  attach(hub, pi, { wire: !alreadyWired });
  if (alreadyWired) hub.note("double-load", "a second bridge instance is loaded in this process: sharing one connection (no duplicate runtime)");
}
