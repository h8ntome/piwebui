/**
 * pi-web live bridge — a supported, opt-in Pi extension that runs INSIDE a terminal Pi
 * process and exposes a local, token-authenticated Unix-socket control endpoint.
 *
 * Design rules (plan P0/P3):
 *  - It calls ONLY public ExtensionAPI / ExtensionContext operations of the owning Pi
 *    runtime (no monkey-patching, no second writer, no private dist imports).
 *  - Terminal extension dialogs are OBSERVABLE ONLY: ui_prompt_start/ui_prompt_end carry
 *    kind/title with no response handle in Pi 1.5.0 public types, so dialogRespond is
 *    reported unsupported instead of simulated.
 *  - Socket + registry artifacts live in an owner-only (0700) directory; socket 0600;
 *    every connection must present the shared token (hash recorded in registry).
 *  - Standalone module: imports nothing outside Node builtins so it can be loaded by
 *    `pi -e <path>` or installed into ~/.pi/agent/extensions/.
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";

const PROTOCOL = 1;
const env = process.env;
const BRIDGE_DIR = env.PIWEB_BRIDGE_DIR || path.join(os.homedir(), ".pi-web", "bridges");
const TOKEN = env.PIWEB_BRIDGE_TOKEN || "";

export default function piWebBridge(pi) {
  if (env.PIWEB_MANAGED_HOST === "1") {
    // Running inside a pi-web managed SDK host; the host owns control. Do not open a bridge.
    return;
  }
  if (!TOKEN || TOKEN.length < 16) {
    console.error("[pi-web bridge] PIWEB_BRIDGE_TOKEN missing; bridge disabled. Start with PIWEB_BRIDGE_TOKEN set, or unset the extension.");
    return;
  }
  const runtimeId = crypto.randomBytes(8).toString("hex");
  const procStart = Math.floor(performance.timeOrigin);
  const startedAt = new Date().toISOString();
  const socketPath = path.join(BRIDGE_DIR, `r-${runtimeId}.sock`);
  const recordPath = path.join(BRIDGE_DIR, `r-${runtimeId}.json`);

  /** The freshest command-context captured from any event/command callback. */
  let lastCtx = null;
  const setCtx = (ctx) => { if (ctx) lastCtx = ctx; return ctx; };

  /* ---------------- live state tracker (bounded) ---------------- */
  const previews = new Map(); // liveMessageId -> {msg, role, rev, blocks, done, mappedEntryId, startedAt}
  const previewOrder = [];
  const MAX_PREVIEWS = 4;
  const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;
  // pi hands a *new* message object per streamed chunk, so object identity (or a stamp written on
  // it) mints a fresh preview for every token: rows duplicated in the browser, forever "working",
  // replayed on every reconnect, and the map grew without bound. Trackers are keyed by their own id
  // and re-associated to the arriving object positionally (last open tracker of that role), exactly
  // like the managed host does.
  const objToTracker = new WeakMap();
  const tools = new Map(); // toolCallId -> state
  const observedDialogs = []; // {requestId, kind, title, startedAt, endedAt}
  let dialogSeq = 0;
  let stateRevision = 0;
  let compaction = null;
  let lastSettled = null;
  let sessionGeneration = 1;
  const seenOps = new Set();
  let piVersion = "unknown";
  const findPiPkg = () => {
    const candidates = [];
    // 1) repo layout next to this file (dev installs)
    candidates.push(path.resolve(path.dirname(new URL(import.meta.url).pathname), "..", "..", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "package.json"));
    // 2) ancestor of the running CLI entry (global installs: .../pi-coding-agent/dist/bundle/cli.js)
    let d = path.dirname(process.argv[1] ?? ".");
    for (let i = 0; i < 8; i++) {
      candidates.push(path.join(d, "package.json"));
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
    // 3) explicit override
    if (env.PIWEB_PI_PACKAGE) candidates.push(path.join(env.PIWEB_PI_PACKAGE, "package.json"));
    for (const c of candidates) {
      try {
        const pkg = JSON.parse(fs.readFileSync(c, "utf8"));
        if (pkg.name === "@earendil-works/pi-coding-agent") return pkg.version ?? "unknown";
      } catch { /* keep looking */ }
    }
    return "unknown";
  };
  piVersion = findPiPkg();

  function touch() { stateRevision++; }

  let idSeq = 0;
  function newTracker(msg, role) {
    const p = { msg, liveMessageId: `lm-${Date.now().toString(36)}-${++idSeq}`, role, rev: 0, blocks: [], done: false, startedAt: new Date().toISOString(), bytes: 0 };
    previews.set(p.liveMessageId, p);
    previewOrder.push(p.liveMessageId);
    while (previewOrder.length > MAX_PREVIEWS) {
      const dropId = previewOrder.shift();
      if (dropId === p.liveMessageId) { previewOrder.push(dropId); continue; }
      const drop = previews.get(dropId);
      if (drop && !drop.done) { drop.done = true; broadcast("message_end", { liveMessageId: drop.liveMessageId, preview: snapshotPreview(drop) }); }
      previews.delete(dropId);
    }
    try { objToTracker.set(msg, p); } catch { /* non-object message */ }
    return p;
  }

  /** Find (or create) the tracker for this message object: identity first, then stream position. */
  function trackerFor(msg, role, { create = true } = {}) {
    const byObj = objToTracker.get(msg);
    if (byObj && previews.has(byObj.liveMessageId)) { byObj.msg = msg; return byObj; }
    const open = [...previewOrder].reverse().map((id) => previews.get(id)).find((p) => p && !p.done && p.role === role);
    if (open) { open.msg = msg; try { objToTracker.set(msg, open); } catch { /* non-object */ } return open; }
    if (!create) return null;
    return newTracker(msg, role);
  }

  /** Close every preview still streaming; a turn or agent settle means nothing more can arrive. */
  function closeOpenPreviews(role) {
    for (const id of [...previewOrder]) {
      const p = previews.get(id);
      if (!p || p.done || (role && p.role !== role)) continue;
      p.done = true;
      p.rev++;
      broadcast("message_end", { liveMessageId: p.liveMessageId, preview: snapshotPreview(p) });
    }
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
        if (bytes + size > MAX_PREVIEW_BYTES) { truncated = true; break; }
        blocks.push({ index: i, block: sanitizeBlock(b) });
        bytes += size;
      }
    } else if (typeof content === "string") {
      blocks.push({ index: 0, block: { type: "text", text: content.slice(0, MAX_PREVIEW_BYTES) } });
      truncated = content.length > MAX_PREVIEW_BYTES;
    }
    return {
      liveMessageId: p.liveMessageId, role: p.role, rev: p.rev, blocks, startedAt: p.startedAt,
      done: p.done, mappedEntryId: p.mappedEntryId, truncated: truncated || undefined,
    };
  }

  function sanitizeBlock(b) {
    if (!b || typeof b !== "object") return { type: "unknown" };
    if (b.type === "text") return { type: "text", text: String(b.text ?? "") };
    if (b.type === "thinking") return { type: "thinking", thinking: String(b.thinking ?? "") };
    if (b.type === "toolCall") return { type: "toolCall", id: String(b.id ?? ""), name: String(b.name ?? ""), arguments: truncateArgs(b.arguments) };
    if (b.type === "image") return { type: "image", mimeType: String(b.mimeType ?? ""), data: undefined }; // no image bytes on the live channel
    return { type: String(b.type ?? "unknown") };
  }
  function truncateArgs(a) {
    try {
      const s = JSON.stringify(a ?? {});
      if (s.length <= 8192) return a ?? {};
      return { _truncated: s.slice(0, 8192) };
    } catch { return {}; }
  }

  /* ---------------- model helpers ---------------- */
  function modelRef(m) {
    if (!m) return null;
    return {
      provider: String(m.provider ?? ""), modelId: String(m.id ?? ""),
      name: m.name ? String(m.name) : undefined,
      contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
      maxTokens: typeof m.maxTokens === "number" ? m.maxTokens : undefined,
      reasoning: m.reasoning === true,
    };
  }

  function capabilities(ctx) {
    const hasSM = !!ctx?.sessionManager;
    return {
      snapshot: hasSM, livePreview: true, liveTree: typeof ctx?.sessionManager?.getTree === "function",
      promptStart: typeof pi.sendUserMessage === "function",
      promptSteer: typeof pi.sendUserMessage === "function",
      promptFollowUp: typeof pi.sendUserMessage === "function",
      abort: typeof ctx?.abort === "function",
      compact: typeof ctx?.compact === "function",
      setModel: typeof pi.setModel === "function",
      setThinking: typeof pi.setThinkingLevel === "function",
      rename: typeof pi.setSessionName === "function",
      modelsCatalog: typeof ctx?.modelRegistry?.find === "function",
      commandList: typeof pi.getCommands === "function",
      queue: "flag", clearQueue: false,
      dialogObserve: true, dialogRespond: false,
      stopForTerminal: false,
      contextUsage: typeof ctx?.getContextUsage === "function",
      runtimeContext: typeof ctx?.sessionManager?.buildContextEntries === "function",
      canControl: true,
      notes: [
        "Terminal dialogs raised by other extensions are observable but must be answered in the terminal: Pi 1.5.0 public extension API has no remote response path (ui_prompt_start/end carry kind/title only).",
        "Queue introspection is limited to a pending flag; queue contents and clearing are not exposed by the public extension API.",
        "Slash-command and @path expansion are not performed on browser prompt text (literal delivery only).",
      ],
    };
  }

  function buildSnapshot() {
    const ctx = lastCtx;
    if (!ctx) throw err("host_unavailable", "extension context not yet captured");
    const sm = ctx.sessionManager;
    const entries = typeof sm.getEntries === "function" ? sm.getEntries() : [];
    const leaf = typeof sm.getLeafId === "function" ? sm.getLeafId() : null;
    const idle = ctx.isIdle();
    const phase = compaction ? "compacting" : !idle ? "streaming" : "idle";
    const pending = observedDialogs.filter((d) => !d.endedAt).map((d) => ({
      requestId: d.requestId, requestGeneration: sessionGeneration, kind: d.kind, title: d.title ?? "",
      answered: false, terminalObserved: true, createdAt: d.startedAt,
    }));
    return {
      sessionFile: sm.getSessionFile?.() ?? null,
      sessionId: sm.getSessionId?.() ?? null,
      cwd: sm.getCwd?.() ?? ctx.cwd ?? null,
      piVersion, mode: ctx.mode ?? "tui",
      leafEntryId: leaf, leafSource: "runtime",
      phase, stateRevision, isStreaming: !idle,
      previews: [...previews.values()].map(snapshotPreview),
      tools: [...tools.values()],
      queue: { hasPending: ctx.hasPendingMessages?.() ?? null, note: "Pending flag only; queue contents are not exposed by the extension API." },
      model: modelRef(ctx.model), thinkingLevel: pi.getThinkingLevel?.() ?? ctx.thinkingLevel ?? null,
      sessionName: pi.getSessionName?.() ?? null,
      contextUsage: ctx.getContextUsage?.() ?? null,
      pendingDialogs: pending,
      observedDialogs: observedDialogs.slice(-16).map((d) => ({
        requestId: d.requestId, requestGeneration: sessionGeneration, kind: d.kind, title: d.title ?? "",
        answered: !!d.endedAt, terminalObserved: true, createdAt: d.startedAt,
      })),
      lastSettled, retry: null,
      compaction: compaction ? { active: true, reason: compaction } : null,
      entryCount: entries.length,
      capabilities: capabilities(ctx),
    };
  }

  function err(code, message) {
    const e = new Error(message); e.code = code; return e;
  }

  /* ---------------- command actor ---------------- */
  // Serialize configuration/session mutations; urgent ops (abort, prompt steering) run inline.
  let actorTail = Promise.resolve();
  function serialize(fn) {
    const run = actorTail.then(fn, fn);
    actorTail = run.then(() => {}, () => {});
    return run;
  }

  async function handleCommand(cmd, args) {
    const ctx = lastCtx;
    switch (cmd) {
      case "snapshot": return buildSnapshot();
      case "prompt": {
        if (!ctx) throw err("host_unavailable", "no context");
        const { text, images, delivery } = args;
        // Owner-side deduplication of operation IDs before invocation (at-least-once delivery).
        if (args.operationId) {
          if (seenOps.has(args.operationId)) return { invoked: true, dedup: true };
          seenOps.add(args.operationId);
          while (seenOps.size > 500) seenOps.delete(seenOps.values().next().value);
        }
        const content = images?.length
          ? [{ type: "text", text }, ...images.map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType }))]
          : text;
        const busy = !ctx.isIdle();
        if (delivery === "start" && busy) throw err("busy", "session is streaming; use steer or follow-up");
        if (delivery === "steer" && !busy) throw err("busy", "nothing to steer; session is idle");
        if (busy && delivery !== "start") pi.sendUserMessage(content, { deliverAs: delivery === "steer" ? "steer" : "followUp" });
        else pi.sendUserMessage(content); // void by design; lifecycle events carry completion
        return { invoked: true, delivery: busy ? delivery : "start" };
      }
      case "abort": {
        if (!ctx) throw err("host_unavailable", "no context");
        if (typeof ctx.abort !== "function") throw err("unsupported_capability", "abort unavailable");
        ctx.abort();
        return { requested: true, note: "Abort requested; completion arrives as agent_settled." };
      }
      case "compact": {
        if (!ctx || typeof ctx.compact !== "function") throw err("unsupported_capability", "compact unavailable");
        const opId = args?.operationId;
        ctx.compact({
          customInstructions: args?.instructions || undefined,
          onComplete: () => broadcast("compact_done", { operationId: opId, ok: true }),
          onError: (e) => broadcast("compact_done", { operationId: opId, ok: false, error: String(e?.message ?? e).slice(0, 200) }),
        });
        return { started: true };
      }
      case "setModel": {
        const reg = ctx?.modelRegistry;
        if (!reg || typeof pi.setModel !== "function") throw err("unsupported_capability", "model switching unavailable");
        const model = reg.find(args.provider, args.modelId);
        if (!model) throw err("invalid_request", `model ${args.provider}/${args.modelId} not found`);
        const ok = await pi.setModel(model);
        if (!ok) throw err("pi_command_failed", "model rejected (auth not configured?)");
        return { model: modelRef(ctx.model) };
      }
      case "setThinking": {
        if (typeof pi.setThinkingLevel !== "function") throw err("unsupported_capability", "thinking unavailable");
        pi.setThinkingLevel(args.level);
        return { level: pi.getThinkingLevel?.() ?? args.level };
      }
      case "rename": {
        if (typeof pi.setSessionName !== "function") throw err("unsupported_capability", "rename unavailable");
        if (args.name === null) throw err("unsupported_capability", "clearing a name is not supported by the extension API");
        pi.setSessionName(args.name);
        return { name: args.name };
      }
      case "models": {
        const reg = ctx?.modelRegistry;
        if (!reg) throw err("unsupported_capability", "no registry");
        const list = (reg.getAvailable?.() ?? reg.getAll?.() ?? []).map((m) => ({ ...modelRef(m), available: true }));
        return { models: list.slice(0, 500) };
      }
      case "commands": {
        const cmds = pi.getCommands?.() ?? [];
        return { commands: cmds.map((c) => ({ name: c.invocationName ?? c.name, description: c.description ?? "", source: c.source ?? "builtin" })).slice(0, 300) };
      }
      case "tree": {
        const sm = ctx?.sessionManager;
        if (!sm || typeof sm.getTree !== "function") throw err("unsupported_capability", "tree unavailable");
        return buildBridgeTree(sm);
      }
      case "context": {
        const sm = ctx?.sessionManager;
        if (!sm || typeof sm.buildContextEntries !== "function") throw err("unsupported_capability", "context unavailable");
        const ctxEntries = sm.buildContextEntries();
        const messages = ctxEntries.flatMap((e) => sessionEntryToContextMessagesLite(e));
        return {
          kind: "runtime_preview", leafEntryId: sm.getLeafId?.() ?? null, capturedAt: new Date().toISOString(),
          model: modelRef(ctx.model), thinkingLevel: pi.getThinkingLevel?.() ?? null,
          messages,
          unavailableFields: ["systemPrompt", "toolDeclarations", "routing", "providerPayload"],
          note: "Runtime preview from the owning terminal Pi's in-memory projection. Pi hooks/routing/conversion may still alter the actual provider request.",
        };
      }
      case "dialogRespond":
        throw err("unsupported_capability", "Terminal extension dialogs cannot be answered remotely through the public Pi extension API (ui_prompt_start/end carry no response handle). Answer in the terminal.");
      case "clearQueue":
        throw err("unsupported_capability", "Queue clearing is not exposed by the public Pi extension API.");
      case "stopForTerminal":
        throw err("unsupported_capability", "This session is already running in the terminal; nothing to hand off.");
      default:
        throw err("unsupported_capability", `unknown command ${cmd}`);
    }
  }

  function sessionEntryToContextMessagesLite(e) {
    // Keep the wire minimal: message entries contribute their message; others contribute markers.
    if (e.type === "message" && e.message) return [{ role: String(e.message.role ?? "?"), content: e.message.content ?? null, entryId: e.id ?? null }];
    if (e.type === "compaction") return [{ role: "compaction", content: String(e.summary ?? "").slice(0, 2000), entryId: e.id ?? null }];
    return [];
  }

  function buildBridgeTree(sm) {
    const tree = sm.getTree?.() ?? [];
    const nodes = {};
    const walk = (node, parentId) => {
      const id = node.entry?.id;
      if (!id) return;
      nodes[id] = {
        entryId: id, parentId: parentId ?? null, type: String(node.entry.type ?? "unknown"),
        timestamp: String(node.entry.timestamp ?? ""), label: node.label,
        preview: treePreview(node.entry), childIds: (node.children ?? []).map((c) => c.entry?.id).filter(Boolean),
        onActiveBranch: false,
      };
      for (const c of node.children ?? []) walk(c, id);
    };
    for (const root of tree) walk(root, null);
    const leaf = sm.getLeafId?.() ?? null;
    let cur = leaf;
    while (cur && nodes[cur]) { nodes[cur].onActiveBranch = true; cur = nodes[cur].parentId; }
    return { leaf: { entryId: leaf, source: "runtime" }, roots: tree.map((t) => t.entry?.id).filter(Boolean), nodes };
  }
  function treePreview(e) {
    if (e.type === "message") {
      const c = e.message?.content;
      if (typeof c === "string") return c.slice(0, 160);
      if (Array.isArray(c)) for (const b of c) if (b?.type === "text") return String(b.text).slice(0, 160);
    }
    return String(e.type ?? "");
  }

  /* ---------------- socket server + framing ---------------- */
  fs.mkdirSync(BRIDGE_DIR, { recursive: true, mode: 0o700 });
  const serverId = runtimeId;
  const connections = new Set();
  const server = net.createServer();
  server.on("error", (e) => console.error("[pi-web bridge] server error", e.message));

  function writeFrame(conn, obj) {
    try { conn.write(JSON.stringify(obj) + "\n"); } catch { /* conn closing */ }
  }
  function broadcast(name, payload) {
    const seq = ++broadcastSeq;
    for (const c of connections) writeFrame(c, { t: "ev", seq, name, payload });
  }
  let broadcastSeq = 0;

  server.on("connection", (conn) => {
    conn.on("error", () => conn.destroy());
    let buf = "";
    let authed = false;
    conn.on("data", (d) => {
      buf += d.toString("utf8");
      if (buf.length > 8 * 1024 * 1024) { conn.destroy(); return; }
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let frame;
        try { frame = JSON.parse(line); } catch { writeFrame(conn, { t: "res", id: "bad", ok: false, error: { code: "invalid_request", message: "bad JSON" } }); continue; }
        if (!authed) {
          if (frame.t === "auth") {
            const ok = constantTimeEquals(String(frame.token ?? ""), TOKEN);
            if (!ok) { writeFrame(conn, { t: "res", id: "auth", ok: false, error: { code: "unauthorized", message: "bad token" } }); conn.destroy(); return; }
            authed = true;
            connections.add(conn);
            writeFrame(conn, { t: "auth_ok", protocol: PROTOCOL, hello: helloInfo() });
          } else { conn.destroy(); }
          continue;
        }
        if (frame.t === "ping") { writeFrame(conn, { t: "pong", id: frame.id }); continue; }
        if (frame.t === "cmd") {
          handleCommand(frame.cmd, frame.args ?? {})
            .then((data) => writeFrame(conn, { t: "res", id: frame.id, ok: true, data }))
            .catch((e) => writeFrame(conn, { t: "res", id: frame.id, ok: false, error: { code: e.code ?? "internal", message: String(e.message ?? e).slice(0, 300) } }));
        }
      }
    });
    conn.on("close", () => connections.delete(conn));
  });

  function constantTimeEquals(a, b) {
    const ab = Buffer.from(a), bb = Buffer.from(b);
    if (ab.length !== bb.length) return false;
    return crypto.timingSafeEqual(ab, bb);
  }

  function helloInfo() {
    const ctx = lastCtx;
    return {
      protocol: PROTOCOL, runtimeId, pid: process.pid, procStart,
      piVersion, cwd: ctx?.cwd ?? process.cwd(),
      sessionFile: ctx?.sessionManager?.getSessionFile?.() ?? null,
      sessionId: ctx?.sessionManager?.getSessionId?.() ?? null,
      mode: ctx?.mode ?? "tui",
      capabilities: capabilities(ctx),
    };
  }

  function registryRecord() {
    const ctx = lastCtx;
    return {
      protocol: PROTOCOL, runtimeId, socketPath,
      tokenHash: crypto.createHash("sha256").update(TOKEN).digest("hex"),
      pid: process.pid, procStart, piVersion, startedAt,
      cwd: ctx?.cwd ?? process.cwd(),
      sessionFile: ctx?.sessionManager?.getSessionFile?.() ?? null,
      sessionId: ctx?.sessionManager?.getSessionId?.() ?? null,
      mode: ctx?.mode ?? "tui",
      capabilities: capabilities(ctx),
    };
  }

  function writeRegistry() {
    try {
      fs.mkdirSync(BRIDGE_DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(recordPath, JSON.stringify(registryRecord()), { mode: 0o600 });
      try { fs.chmodSync(socketPath, 0o600); } catch { /* not yet created */ }
    } catch (e) { console.error("[pi-web bridge] registry write failed", e.message); }
  }
  function removeArtifacts() {
    try { if (fs.existsSync(recordPath)) fs.unlinkSync(recordPath); } catch { }
    try { if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath); } catch { }
  }

  /* ---------------- Pi event wiring ---------------- */
  const on = (ev, h) => pi.on(ev, async (event, ctx) => { setCtx(ctx); await h(event, ctx); });

  on("session_start", (e) => {
    sessionGeneration++;
    previews.clear(); previewOrder.length = 0; tools.clear(); observedDialogs.length = 0;
    touch();
    broadcast("session_start", { reason: e.reason, sessionGeneration });
    writeRegistry();
  });
  on("session_shutdown", (e) => {
    broadcast("session_shutdown", { reason: e.reason });
    // Session replacement (new/resume/fork) reloads extensions: this instance's contexts
    // are stale. Close our endpoint and remove artifacts so we do not leak a zombie socket.
    if (["new", "resume", "fork", "reload"].includes(e.reason)) {
      setTimeout(() => {
        try { server.close(); } catch { }
        for (const c of connections) { try { c.destroy(); } catch { } }
        connections.clear();
        removeArtifacts();
      }, 150);
    }
  });
  on("session_info_changed", (e) => { touch(); broadcast("session_info_changed", { name: e.name ?? null }); writeRegistry(); });
  on("session_tree", (e) => { touch(); broadcast("session_tree", { newLeafId: e.newLeafId ?? null, oldLeafId: e.oldLeafId ?? null }); });
  on("session_before_compact", () => { compaction = "manual"; touch(); broadcast("runtime_state", { phase: "compacting" }); });
  on("session_compact", (e) => {
    compaction = null; touch();
    broadcast("compacted", { entryId: e.compactionEntry?.id ?? null, reason: e.reason, willRetry: !!e.willRetry });
  });
  on("session_compact_failed", (e) => { compaction = null; touch(); broadcast("compact_failed", { reason: e.reason ?? "unknown" }); });

  on("agent_start", () => { touch(); broadcast("agent_start", {}); });
  on("agent_settled", (e) => {
    lastSettled = { at: new Date().toISOString(), aborted: !!e.aborted };
    closeOpenPreviews(); // nothing can still be streaming once the agent has settled
    touch();
    broadcast("agent_settled", { aborted: !!e.aborted });
  });

  on("message_start", (e) => {
    const msg = e.message;
    const role = msg.role === "user" ? "user" : "assistant";
    const p = trackerFor(msg, role);
    touch();
    broadcast("message_start", { liveMessageId: p.liveMessageId, role });
  });
  on("message_update", (e) => {
    const msg = e.message;
    const p = trackerFor(msg, msg.role === "user" ? "user" : "assistant");
    p.rev++;
    throttledPreview(p);
  });
  on("message_end", (e) => {
    const msg = e.message;
    const p = trackerFor(msg, msg.role === "user" ? "user" : "assistant", { create: false });
    if (p) { p.done = true; p.rev++; broadcast("message_end", { liveMessageId: p.liveMessageId, preview: snapshotPreview(p) }); }
    touch();
  });
  on("turn_end", (e) => {
    const msg = e.message;
    let liveMessageId;
    const p = trackerFor(msg, msg?.role === "user" ? "user" : "assistant", { create: false });
    if (p) {
      liveMessageId = p.liveMessageId;
      if (e.messageEntryId) p.mappedEntryId = e.messageEntryId;
      p.done = true;
    }
    // Any assistant preview this turn left open is finished business, not a live stream: leaving
    // them open is what duplicated transcript rows and stuck the "working" shimmer on a bridged
    // session (BUG-004).
    closeOpenPreviews("assistant");
    touch();
    broadcast("turn_end", {
      messageEntryId: e.messageEntryId ?? null,
      toolResultEntryIds: e.toolResultEntryIds ?? [],
      liveMessageId: liveMessageId ?? null,
      turnIndex: e.turnIndex,
    });
  });

  let previewThrottle = new Map();
  function throttledPreview(p) {
    const key = p.liveMessageId;
    const pending = previewThrottle.get(key);
    if (pending) return;
    const timer = setTimeout(() => {
      previewThrottle.delete(key);
      broadcast("message_update", { liveMessageId: key, preview: snapshotPreview(p) });
    }, 40);
    if (timer.unref) timer.unref();
    previewThrottle.set(key, timer);
  }

  on("tool_execution_start", (e) => {
    tools.set(e.toolCallId, {
      toolCallId: e.toolCallId, toolName: e.toolName, state: "running",
      argsPreview: truncateArgs(e.args), outputMode: "replace", startedAt: new Date().toISOString(),
      parentToolCallId: e.parentToolCallId,
    });
    touch();
    broadcast("tool_update", { tool: tools.get(e.toolCallId) });
  });
  on("tool_execution_update", (e) => {
    const t = tools.get(e.toolCallId) ?? { toolCallId: e.toolCallId, toolName: e.toolName, state: "running", startedAt: new Date().toISOString(), outputMode: "replace" };
    // Cumulative snapshot policy: Pi's bash tool sends cumulative snapshots; replace by default.
    const partial = e.partialResult;
    t.outputContent = Array.isArray(partial?.content) ? partial.content.map(sanitizeBlock) : undefined;
    t.truncated = JSON.stringify(partial ?? {}).length > 1024 * 1024;
    tools.set(e.toolCallId, t);
    throttledTool(e.toolCallId);
  });
  on("tool_execution_end", (e) => {
    const t = tools.get(e.toolCallId) ?? { toolCallId: e.toolCallId, toolName: e.toolName, state: "running", startedAt: new Date().toISOString(), outputMode: "replace" };
    t.state = e.isError ? "error" : "ok";
    t.durationMs = e.durationMs;
    t.endedAt = new Date().toISOString();
    const content = e.result?.content;
    t.outputContent = Array.isArray(content) ? content.map(sanitizeBlock) : undefined;
    t.details = limitJson(e.result?.details);
    tools.set(e.toolCallId, t);
    touch();
    broadcast("tool_update", { tool: t });
  });
  const toolThrottle = new Map();
  function throttledTool(id) {
    if (toolThrottle.has(id)) return;
    const timer = setTimeout(() => { toolThrottle.delete(id); broadcast("tool_update", { tool: tools.get(id) }); }, 80);
    if (timer.unref) timer.unref();
    toolThrottle.set(id, timer);
  }
  function limitJson(v) {
    try { const s = JSON.stringify(v); if (s && s.length > 256 * 1024) return { _truncated: true }; return v; } catch { return undefined; }
  }

  on("model_select", (e) => { touch(); broadcast("model_select", { model: modelRef(e.model), previous: modelRef(e.previousModel), source: e.source }); writeRegistry(); });
  on("thinking_level_select", (e) => { touch(); broadcast("thinking_level_select", { level: e.level, previous: e.previousLevel }); });

  on("ui_prompt_start", (e) => {
    observedDialogs.push({ requestId: `term-${++dialogSeq}`, kind: e.kind ?? "custom", title: e.title ?? "", startedAt: new Date().toISOString(), endedAt: null });
    while (observedDialogs.length > 16) observedDialogs.shift();
    touch();
    broadcast("dialog_observed", {
      requestId: `term-${dialogSeq}`, requestGeneration: sessionGeneration, kind: e.kind ?? "custom",
      title: e.title ?? "", terminalObserved: true, note: "Answer in the terminal; remote answering is not supported by the public Pi extension API.",
    });
  });
  on("ui_prompt_end", (e) => {
    const d = [...observedDialogs].reverse().find((x) => !x.endedAt && x.kind === (e.kind ?? "custom"));
    if (d) d.endedAt = new Date().toISOString();
    touch();
    broadcast("dialog_observed_end", { kind: e.kind ?? "custom", title: e.title ?? "" });
  });

  on("input", (e) => {
    // Transparency only: record that input arrived and from where; never mutate.
    broadcast("input_seen", { source: e.source, streamingBehavior: e.streamingBehavior ?? null });
  });

  pi.registerCommand?.("piweb", {
    description: "Show pi-web bridge status",
    handler: async (_args, ctx) => {
      setCtx(ctx);
      const h = helloInfo();
      ctx.ui.notify(`pi-web bridge ${runtimeId.slice(0, 6)}: ${h.sessionFile ?? "no file"} · ${h.mode} · ${connections.size} viewer(s)`, "info");
    },
  });

  /* ---------------- lifecycle ---------------- */
  process.on("exit", removeArtifacts);
  try {
    server.listen(socketPath, () => { writeRegistry(); });
  } catch (e) {
    console.error("[pi-web bridge] failed to listen:", e.message);
  }
  const hb = setInterval(() => { if (lastCtx) writeRegistry(); }, 10_000);
  if (hb.unref) hb.unref();
}
