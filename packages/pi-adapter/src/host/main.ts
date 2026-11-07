/**
 * Managed Pi SDK host: one child process, exactly one AgentSession, one session file.
 * Started via child_process.fork (IPC) with PIWEB_MANAGED_HOST=1. Pi is imported
 * dynamically from the resolved installed package — never bundled, never a private dist path.
 *
 * - ExtensionUIContext is bound BEFORE prompts are accepted; dialogs route to the parent
 *   server (and from there to the browser) with exactly-one-response semantics and real
 *   timeout/cancellation (Pi RPC parity: timeout/cancel => undefined, confirm => false).
 * - prompt() resolves at run completion; dispatch acknowledgement comes from
 *   preflightResult, so the parent never awaits the whole run for an ack.
 * - Parent disconnect => fail-closed: abort, dispose, exit (plan F-05).
 */
import crypto from "node:crypto";
import fs from "node:fs";
import { importPi } from "../pi-resolve.ts";
import type { Capabilities, DialogRequest, PreviewState, QueueState, ToolStateView } from "@piwebui/shared";
import { MAX_PREVIEW_MESSAGE_BYTES, MAX_TOOL_STATE_BYTES } from "@piwebui/shared";

export interface HostInitArgs {
  cwd: string;
  agentDir?: string;
  sessionDir?: string;
  model?: { provider: string; modelId: string };
  thinkingLevel?: string;
  name?: string;
  extensionPaths?: string[];
}

interface PendingDialog {
  requestId: string;
  generation: number;
  kind: "select" | "confirm" | "input" | "editor";
  resolve: (v: unknown) => void;
  answered: boolean;
  timer?: NodeJS.Timeout;
  request: Record<string, unknown>;
}

async function main() {
  const trace = (stage: string) => { if (process.env.PIWEB_HOST_TRACE) process.send?.({ t: "trace", stage }); };
  trace("init_waited");
  const init = await waitForInit();
  trace("pi_importing");
  const pi = await importPi();
  trace("pi_imported");
  const piVersion: string = pi.VERSION ?? "unknown";
  const runtimeId = crypto.randomBytes(8).toString("hex");
  const startedAt = new Date().toISOString();
  let stateRevision = 0;
  const touch = () => ++stateRevision;

  /* ---------- session creation (inherits the user's settings/auth explicitly) ---------- */
  const sessionManager = pi.SessionManager.create(init.cwd, init.sessionDir ?? undefined);
  // Parity with the CLI: auto-load user- and project-scope extension directories plus any
  // explicitly requested paths. The SDK's default loader does not scan these dirs itself.
  const extensionPaths: string[] = [];
  const autoDirs = [init.agentDir ? `${init.agentDir}/extensions` : "", `${init.cwd}/.pi/extensions`];
  for (const dir of autoDirs) {
    try {
      if (dir && fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) {
          if (/\.(ts|js|mjs)$/.test(f) && !f.startsWith(".")) extensionPaths.push(`${dir}/${f}`);
        }
      }
    } catch { /* skip */ }
  }
  for (const p of Array.isArray(init.extensionPaths) ? init.extensionPaths : []) if (typeof p === "string") extensionPaths.push(p);
  let resourceLoader: unknown = undefined;
  if (pi.DefaultResourceLoader && pi.SettingsManager && init.agentDir) {
    const sm = pi.SettingsManager.create(init.cwd, init.agentDir);
    const loader = new pi.DefaultResourceLoader({ cwd: init.cwd, agentDir: init.agentDir, settingsManager: sm, additionalExtensionPaths: extensionPaths });
    trace("loader_reload");
    await loader.reload();
    trace("loader_reloaded");
    resourceLoader = loader;
    try {
      const extRes: any = (loader as any).getExtensions?.();
      emit("boot_diag", { extensionPaths, loaded: (extRes?.extensions ?? []).map((x: any) => x.path ?? x.name ?? String(x)).slice(0, 10), errors: (extRes?.errors ?? []).map((e: any) => `${e.path}: ${String(e.error).slice(0, 120)}`).slice(0, 5) });
    } catch (e) { emit("boot_diag", { error: String(e).slice(0, 200) }); }
  }
  const createOpts: Record<string, unknown> = { cwd: init.cwd, sessionManager };
  if (init.agentDir) createOpts.agentDir = init.agentDir;
  if (init.thinkingLevel) createOpts.thinkingLevel = init.thinkingLevel;
  if (resourceLoader) createOpts.resourceLoader = resourceLoader;
  trace("session_creating");
  const { session } = await pi.createAgentSession(createOpts);
  trace("session_created");

  /* ---------- dialogs ---------- */
  const dialogs = new Map<string, PendingDialog>();
  let dialogSeq = 0;
  let dialogGeneration = 1;

  function makeDialogMethod(kind: "select" | "confirm" | "input" | "editor") {
    return async (title: string, a?: unknown, optsRaw?: { signal?: AbortSignal; timeout?: number }) => {
      const requestId = `dlg-${++dialogSeq}`;
      const message = kind === "confirm" ? String(a ?? "") : undefined;
      const options = kind === "select" && Array.isArray(a) ? (a as unknown[]).map(String) : undefined;
      const placeholder = kind === "input" ? String(a ?? "") : undefined;
      const prefill = kind === "editor" ? String(a ?? "") : undefined;
      const request = {
        requestId,
        requestGeneration: dialogGeneration,
        kind,
        title: String(title ?? ""),
        ...(message !== undefined ? { message } : {}),
        ...(options !== undefined ? { options } : {}),
        ...(placeholder !== undefined && placeholder !== "" ? { placeholder } : {}),
        ...(prefill !== undefined ? { prefill } : {}),
        ...(optsRaw?.timeout ? { timeoutMs: Number(optsRaw.timeout) } : {}),
        createdAt: new Date().toISOString(),
      };
      return await new Promise((resolve, reject) => {
        void reject;
        const settle = (value: unknown, reason: string) => {
          const pd = dialogs.get(requestId);
          if (!pd || pd.answered) return;
          pd.answered = true;
          if (pd.timer) clearTimeout(pd.timer);
          dialogs.delete(requestId);
          emit("dialog_resolved", { requestId, reason });
          touch();
          pd.resolve(value);
        };
        const pd: PendingDialog = {
          requestId, generation: dialogGeneration, kind, answered: false, request,
          resolve: (v: unknown) => resolve(v),
        };
        if (optsRaw?.timeout && Number.isFinite(optsRaw.timeout)) {
          pd.timer = setTimeout(() => settle(kind === "confirm" ? false : undefined, "timeout"), Math.max(250, Number(optsRaw.timeout)));
          pd.timer.unref?.();
        }
        optsRaw?.signal?.addEventListener?.("abort", () => settle(kind === "confirm" ? false : undefined, "cancelled"));
        dialogs.set(requestId, pd);
        emit("dialog_request", request);
        touch();
      });
    };
  }

  const uiContext = {
    select: makeDialogMethod("select"),
    confirm: makeDialogMethod("confirm"),
    input: makeDialogMethod("input"),
    editor: makeDialogMethod("editor"),
    notify: (message: string, type?: string) => {
      emit("notify", { message: String(message).slice(0, 2000), level: type ?? "info" });
    },
    onTerminalInput: () => {
      emit("unsupported_ui", { method: "onTerminalInput", note: "raw terminal input is TTY-only; no-op unsubscribe returned (RPC parity)" });
      return () => {};
    },
    setStatus: (key: string, text: string | undefined) => {
      emit("status_text", { key: String(key), text: text ?? null });
    },
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: (key: string, content: unknown) => {
      const lines = Array.isArray(content) ? (content as unknown[]).map((l) => String(l)).slice(0, 40) : null;
      emit("widget", { key: String(key), lines });
    },
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => {
      emit("unsupported_ui", {
        method: "custom",
        note: "custom TUI components cannot be rendered in the browser and were NOT auto-approved; the extension received undefined (RPC parity: cancelled)",
      });
      touch();
      return undefined;
    },
    pasteToEditor: (text: string) => { uiContext.setEditorText(text); },
    setEditorText: (text: string) => { emit("composer_set_text", { text: String(text).slice(0, 100_000) }); },
    getEditorText: () => "",
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    getEditorComponent: () => undefined,
    theme: undefined,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "Theme switching is not supported in the managed host" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };

  // Bind extensions with UI context BEFORE accepting prompts (plan rule 6).
  await session.bindExtensions({
    uiContext,
    mode: "rpc",
    onError: (e: Error) => emit("extension_error", { message: String(e?.message ?? e).slice(0, 300) }),
  });

  if (init.model) {
    const m = findModel(init.model.provider, init.model.modelId);
    if (m) { try { await session.setModel(m); } catch { /* keep default model; surfaced via snapshot */ } }
  }
  if (init.name) { try { session.setSessionName(init.name); } catch { /* ignore */ } }

  function findModel(provider: string, modelId: string) {
    try {
      const rt = session.modelRuntime;
      const all: any[] = rt?.getAvailableSnapshot?.() ?? rt?.getAllModels?.() ?? [];
      return all.find((m) => m.provider === provider && m.id === modelId);
    } catch { return undefined; }
  }

  /* ---------- live trackers ---------- */
  interface Tracker { id: string; role: "user" | "assistant"; startObj: any; endObj?: any; rev: number; startedAt: string; done: boolean; mappedEntryId?: string }
  const previews = new Map<string, Tracker>();
  const previewOrder: string[] = [];
  const objToTracker = new WeakMap<object, Tracker>();
  const tools = new Map<string, ToolStateView>();
  let queueState: QueueState = { hasPending: false, count: 0, items: [], note: "Queue contents reported by the managed SDK host (queue_update events)." };
  let compactionActive: string | null = null;
  let retryActive = false;
  let lastSettled: { at: string; aborted: boolean } | null = null;
  let msgSeq = 0;

  function modelRef(m: any) {
    if (!m) return null;
    return {
      provider: String(m.provider ?? ""), modelId: String(m.id ?? ""),
      ...(m.name ? { name: String(m.name) } : {}),
      ...(typeof m.contextWindow === "number" ? { contextWindow: m.contextWindow } : {}),
      ...(typeof m.maxTokens === "number" ? { maxTokens: m.maxTokens } : {}),
      reasoning: m.reasoning === true,
    };
  }
  function safeLen(v: unknown): number {
    try { return JSON.stringify(v)?.length ?? 0; } catch { return 0; }
  }
  function sanitizeBlock(b: any) {
    if (!b || typeof b !== "object") return { type: "unknown" };
    if (b.type === "text") return { type: "text", text: String(b.text ?? "") };
    if (b.type === "thinking") return { type: "thinking", thinking: String(b.thinking ?? "") };
    if (b.type === "toolCall") return { type: "toolCall", id: String(b.id ?? ""), name: String(b.name ?? ""), arguments: truncateArgs(b.arguments) };
    if (b.type === "image") return { type: "image", mimeType: String(b.mimeType ?? "") };
    if (b.type === "toolResult") return { type: "toolResult", toolCallId: String(b.toolCallId ?? ""), content: Array.isArray(b.content) ? b.content.map(sanitizeBlock) : undefined, isError: !!b.isError };
    return { type: String(b.type ?? "unknown") };
  }
  function truncateArgs(a: unknown) {
    try { const s = JSON.stringify(a ?? {}); return s.length <= 8192 ? (a ?? {}) : { _truncated: s.slice(0, 8192) }; } catch { return {}; }
  }
  function previewPayload(tr: Tracker): PreviewState | null {
    const msg = tr.endObj ?? tr.startObj;
    const blocks: PreviewState["blocks"] = [];
    let bytes = 0;
    let truncated = false;
    const content = msg?.content;
    if (Array.isArray(content)) {
      for (let i = 0; i < content.length; i++) {
        const b = content[i];
        const size = safeLen(b);
        if (bytes + size > MAX_PREVIEW_MESSAGE_BYTES) { truncated = true; break; }
        blocks.push({ index: i, block: sanitizeBlock(b) });
        bytes += size;
      }
    } else if (typeof content === "string") {
      blocks.push({ index: 0, block: { type: "text", text: content.slice(0, MAX_PREVIEW_MESSAGE_BYTES) } });
    }
    return {
      liveMessageId: tr.id, role: tr.role, rev: tr.rev,
      blocks, startedAt: tr.startedAt, done: tr.done, ...(tr.mappedEntryId ? { mappedEntryId: tr.mappedEntryId } : {}),
      ...(truncated ? { truncated: true } : {}),
    };
  }
  function previewPayloadById(id: string): PreviewState | null {
    const tr = previews.get(id);
    return tr ? previewPayload(tr) : null;
  }

  function createTracker(msg: any, role: "user" | "assistant"): Tracker {
    const tr: Tracker = { id: `lm-${Date.now().toString(36)}-${++msgSeq}`, role, startObj: msg, rev: 0, startedAt: new Date().toISOString(), done: false };
    try { objToTracker.set(msg, tr); } catch { /* non-object message */ }
    previews.set(tr.id, tr);
    previewOrder.push(tr.id);
    while (previewOrder.length > 8) { const dropId = previewOrder.shift()!; if (dropId !== tr.id) { const d = previews.get(dropId); if (d) { d.done = true; } previews.delete(dropId); } }
    return tr;
  }

  /** The pi message_end/turn_end object IS the object persisted into the entry tree
   * (verified against installed pi 1.5.0); map by object identity — never by content. */
  function mapTrackerEntry(tr: Tracker) {
    if (tr.mappedEntryId || !tr.endObj) return;
    try {
      const branch = session.sessionManager.getBranch?.() ?? [];
      for (const e of branch) {
        if (e.type === "message" && e.message === tr.endObj) {
          tr.mappedEntryId = e.id;
          emit("message_mapped", { liveMessageId: tr.id, entryId: e.id });
          break;
        }
      }
    } catch { /* best-effort */ }
  }

  function limitDetails(v: unknown) {
    try { const s = JSON.stringify(v); return s && s.length > 256 * 1024 ? { _truncated: true } : v; } catch { return undefined; }
  }

  const previewTimers = new Map<string, NodeJS.Timeout>();
  function throttledPreview(id: string) {
    if (previewTimers.has(id)) return;
    const t = setTimeout(() => { previewTimers.delete(id); emit("message_update", { liveMessageId: id, preview: previewPayloadById(id) }); }, 40);
    t.unref?.();
    previewTimers.set(id, t);
  }
  const toolTimers = new Map<string, NodeJS.Timeout>();
  function throttledTool(id: string) {
    if (toolTimers.has(id)) return;
    const t = setTimeout(() => { toolTimers.delete(id); emit("tool_update", { tool: tools.get(id) }); }, 80);
    t.unref?.();
    toolTimers.set(id, t);
  }

  session.subscribe((ev: any) => {
    switch (ev.type) {
      case "message_start": {
        const role = ev.message?.role;
        if (role !== "user" && role !== "assistant") break; // system/toolResult messages are not transcript previews
        const tr = createTracker(ev.message ?? {}, role);
        emit("message_start", { liveMessageId: tr.id, role: tr.role });
        break;
      }
      case "message_update": {
        const roleU = ev.message?.role;
        if (roleU !== "user" && roleU !== "assistant") break;
        let tr = objToTracker.get(ev.message);
        if (!tr) {
          tr = [...previews.values()].reverse().find((t) => !t.done && t.role === roleU);
          if (!tr) tr = createTracker(ev.message, roleU);
          try { objToTracker.set(ev.message, tr); } catch { }
        }
        tr.rev++;
        throttledPreview(tr.id);
        break;
      }
      case "message_end": {
        const roleE = ev.message?.role;
        if (roleE !== "user" && roleE !== "assistant") { touch(); break; }
        let tr = objToTracker.get(ev.message);
        if (!tr) {
          tr = [...previews.values()].reverse().find((t) => !t.done && t.role === roleE);
          if (tr) { try { objToTracker.set(ev.message, tr); } catch { } }
        }
        if (tr) {
          tr.endObj = ev.message;
          tr.done = true;
          tr.rev++;
          emit("message_end", { liveMessageId: tr.id, preview: previewPayload(tr) });
          setTimeout(() => mapTrackerEntry(tr!), 0);
        }
        touch();
        break;
      }
      case "tool_execution_start": {
        tools.set(ev.toolCallId, {
          toolCallId: ev.toolCallId, toolName: String(ev.toolName), state: "running",
          argsPreview: truncateArgs(ev.args), outputMode: "replace", startedAt: new Date().toISOString(),
          ...(ev.parentToolCallId ? { parentToolCallId: ev.parentToolCallId } : {}),
        } as ToolStateView);
        emit("tool_update", { tool: tools.get(ev.toolCallId) });
        break;
      }
      case "tool_execution_update": {
        const t = tools.get(ev.toolCallId);
        if (t) {
          const content = ev.partialResult?.content;
          if (Array.isArray(content)) t.outputContent = content.map(sanitizeBlock);
          t.truncated = safeLen(ev.partialResult) > MAX_TOOL_STATE_BYTES;
          throttledTool(ev.toolCallId);
        }
        break;
      }
      case "tool_execution_end": {
        const t = tools.get(ev.toolCallId) ?? ({ toolCallId: ev.toolCallId, toolName: String(ev.toolName), state: "running", outputMode: "replace", startedAt: new Date().toISOString() } as ToolStateView);
        t.state = ev.isError ? "error" : "ok";
        if (typeof ev.durationMs === "number") t.durationMs = ev.durationMs;
        t.endedAt = new Date().toISOString();
        const content = ev.result?.content;
        if (Array.isArray(content)) t.outputContent = content.map(sanitizeBlock);
        t.details = limitDetails(ev.result?.details);
        tools.set(ev.toolCallId, t);
        emit("tool_update", { tool: t });
        touch();
        break;
      }
      case "turn_end": {
        const tr = objToTracker.get(ev.message);
        if (tr && ev.messageEntryId && !tr.mappedEntryId) tr.mappedEntryId = ev.messageEntryId;
        if (tr) mapTrackerEntry(tr);
        const mappedId = tr?.mappedEntryId ?? ev.messageEntryId ?? null;
        emit("turn_end", { messageEntryId: mappedId, toolResultEntryIds: ev.toolResultEntryIds ?? [], liveMessageId: tr?.id ?? null, turnIndex: ev.turnIndex });
        touch();
        break;
      }
      case "agent_start": emit("agent_start", {}); touch(); break;
      case "agent_settled": {
        lastSettled = { at: new Date().toISOString(), aborted: !!ev.aborted };
        // settle implies the follow-up/steer queue was drained; keep queue view truthful
        queueState = { hasPending: false, count: 0, items: [], note: "settled: queue drained" };
        emit("queue_state", queueState);
        emit("agent_settled", { aborted: !!ev.aborted });
        touch();
        break;
      }
      case "queue_update": {
        const items: NonNullable<QueueState["items"]> = [
          ...(ev.steering ?? []).map((s: string) => ({ kind: "steer" as const, text: String(s).slice(0, 500) })),
          ...(ev.followUp ?? []).map((s: string) => ({ kind: "followUp" as const, text: String(s).slice(0, 500) })),
        ];
        queueState = { hasPending: items.length > 0, count: items.length, items, note: "Owner-reported queue contents." };
        emit("queue_state", { queue: queueState });
        touch();
        break;
      }
      case "compaction_start": compactionActive = ev.reason; emit("runtime_state_changed", {}); touch(); break;
      case "compaction_end": {
        compactionActive = null;
        emit("compacted", { reason: ev.reason, aborted: !!ev.aborted, willRetry: !!ev.willRetry, ...(ev.errorMessage ? { error: String(ev.errorMessage).slice(0, 200) } : {}) });
        touch();
        break;
      }
      case "auto_retry_start": retryActive = true; emit("retry_state", { active: true, attempt: ev.attempt, maxAttempts: ev.maxAttempts, error: String(ev.errorMessage ?? "").slice(0, 200) }); break;
      case "auto_retry_end": retryActive = false; emit("retry_state", { active: false, success: !!ev.success }); break;
      case "entry_appended": {
        const e = ev.entry;
        emit("entry_appended", { entryId: e?.id ?? null, entryType: e?.type ?? "unknown", parentId: e?.parentId ?? null });
        if (e?.type === "compaction" || e?.type === "branch_summary") mapAllTrackers();
        touch();
        break;
      }
      case "session_info_changed": emit("session_info_changed", { name: ev.name ?? null }); break;
      case "thinking_level_changed": emit("thinking_level_select", { level: ev.level }); break;
      default: break;
    }
  });

  /** Resolve any done-but-unmapped trackers against persisted entries (object identity). */
  function mapAllTrackers() {
    for (const tr of previews.values()) if (tr.done) mapTrackerEntry(tr);
  }

  function emit(name: string, payload: unknown) {
    try { process.send?.({ t: "ev", name, payload }); } catch { /* parent gone */ }
  }

  function caps(): Capabilities {
    return {
      snapshot: true, livePreview: true, liveTree: false,
      promptStart: true, promptSteer: true, promptFollowUp: true,
      abort: true, compact: true, setModel: true, setThinking: true, rename: true,
      modelsCatalog: true, commandList: true,
      queue: "full", clearQueue: false,
      dialogObserve: true, dialogRespond: true, stopForTerminal: true,
      contextUsage: true, runtimeContext: true, canControl: true,
      notes: [
        "Queue contents come from owner queue_update events; clearing the queue is not exposed by the public SDK API.",
        "Slash-command and @path expansion are not performed on browser prompt text (literal delivery only).",
        "custom() extension UI is unsupported in the browser; the extension receives undefined (cancelled), never an auto-approval.",
      ],
    };
  }

  function snapshot() {
    mapAllTrackers();
    const idle = session.isIdle;
    const phase = compactionActive ? "compacting" : retryActive ? "retrying" : [...dialogs.values()].some((d) => !d.answered) ? "awaiting_dialog" : !idle ? "streaming" : "idle";
    let contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null = null;
    try {
      const u = (session as any).getContextUsage?.() ?? null;
      if (u) contextUsage = { tokens: u.tokens ?? null, contextWindow: u.contextWindow ?? 0, percent: u.percent ?? null };
    } catch { /* capability probe failure is non-fatal */ }
    const pendingDialogs: DialogRequest[] = [...dialogs.values()].filter((d) => !d.answered).map((d) => ({
      requestId: d.requestId, requestGeneration: d.generation, kind: d.kind,
      title: String(d.request.title ?? ""), ...(d.request.message ? { message: String(d.request.message) } : {}),
      ...(d.request.options ? { options: d.request.options as string[] } : {}),
      ...(d.request.prefill ? { prefill: String(d.request.prefill) } : {}),
      ...(d.request.placeholder ? { placeholder: String(d.request.placeholder) } : {}),
      ...(d.request.timeoutMs ? { timeoutMs: Number(d.request.timeoutMs) } : {}),
      answered: false, terminalObserved: false, createdAt: String(d.request.createdAt ?? new Date().toISOString()),
    }));
    return {
      sessionFile: session.sessionFile ?? null,
      sessionId: session.sessionId ?? null,
      cwd: init.cwd,
      piVersion, mode: "managed",
      leafEntryId: session.sessionManager.getLeafId?.() ?? null,
      leafSource: "runtime" as const,
      phase, stateRevision, isStreaming: !idle,
      previews: [...previews.keys()].map((id) => previewPayloadById(id)).filter(Boolean) as PreviewState[],
      tools: [...tools.values()],
      queue: queueState,
      model: modelRef(session.model),
      thinkingLevel: session.thinkingLevel ?? null,
      sessionName: session.sessionName ?? null,
      contextUsage,
      pendingDialogs,
      observedDialogs: [],
      lastSettled,
      retry: retryActive ? { active: true } : null,
      compaction: compactionActive ? { active: true, reason: compactionActive } : null,
      entryCount: session.sessionManager.getEntryCount(),
      capabilities: caps(),
    };
  }

  /* ---------- command handling ---------- */
  let actorTail: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = actorTail.then(fn, fn);
    actorTail = run.then(() => undefined, () => undefined);
    return run;
  }

  const pendingRes = new Map<string, boolean>();
  const NORESPONSE = Symbol("no-response");
  const seenOps = new Set<string>();

  async function handleCommand(cmd: string, args: any): Promise<unknown> {
    switch (cmd) {
      case "snapshot": return snapshot();
      case "prompt": {
        const { text, images, delivery } = args;
        if (args.operationId) {
          if (seenOps.has(args.operationId)) return { invoked: true, dedup: true };
          seenOps.add(args.operationId);
          while (seenOps.size > 500) seenOps.delete(seenOps.values().next().value as string);
        }
        if (delivery === "start" && !session.isIdle) throw mkErr("session is streaming; use steer or follow-up", "busy");
        if (delivery === "steer" && session.isIdle) throw mkErr("nothing to steer; session is idle", "busy");
        const imgList = Array.isArray(images) && images.length ? images.map((im: any) => ({ type: "image", data: im.data, mimeType: im.mimeType })) : undefined;
        const options: Record<string, unknown> = {
          expandPromptTemplates: false,
          preflightResult: (disposition: string) => {
            // Dispatch acknowledgement; the run itself completes later via events.
            if (pendingRes.get(args._resId)) { pendingRes.delete(args._resId); send({ t: "res", id: args._resId, ok: true, data: { invoked: true, disposition } }); }
          },
        };
        if (delivery === "steer" || delivery === "followUp") options.streamingBehavior = delivery;
        if (imgList) options.images = imgList;
        const runPromise: Promise<void> = session.prompt(text, options);
        void runPromise.then(
          () => emit("run_completed", { operationId: args.operationId ?? null, ok: true }),
          (e: Error) => {
            emit("run_completed", { operationId: args.operationId ?? null, ok: false, error: String(e?.message ?? e).slice(0, 300) });
            if (pendingRes.get(args._resId)) { pendingRes.delete(args._resId); send({ t: "res", id: args._resId, ok: false, error: { code: "pi_command_failed", message: String(e?.message ?? e).slice(0, 300) } }); }
          },
        );
        return NORESPONSE; // response comes from preflightResult or rejection
      }
      case "abort": await session.abort(); return { settled: true };
      case "compact": {
        const result = await session.compact(args?.instructions || undefined);
        return { ok: true, entryId: (result as any)?.compactionEntry?.id ?? null };
      }
      case "setModel": {
        const model = findModel(args.provider, args.modelId);
        if (!model) throw mkErr(`model ${args.provider}/${args.modelId} not found or auth unavailable`, "invalid_request");
        await session.setModel(model);
        return { model: modelRef(session.model) };
      }
      case "setThinking": session.setThinkingLevel(args.level); return { level: session.thinkingLevel };
      case "rename": {
        if (args.name === null) throw mkErr("clearing name unsupported", "unsupported_capability");
        session.setSessionName(args.name);
        return { name: args.name };
      }
      case "models": {
        const rt = session.modelRuntime;
        const all: any[] = rt?.getAvailableSnapshot?.() ?? rt?.getAllModels?.() ?? [];
        return { models: all.slice(0, 500).map((m) => ({ ...modelRef(m), available: true })) };
      }
      case "commands": {
        try {
          const runner = (session as any).extensionRunner;
          const cmds = runner?.getCommands?.() ?? [];
          return { commands: cmds.slice(0, 300).map((c: any) => ({ name: c.invocationName ?? c.name, description: c.description ?? "", source: c.source ?? "extension" })) };
        } catch { return { commands: [] }; }
      }
      case "context": {
        const projection = session.sessionManager.buildSessionContext();
        return {
          kind: "runtime_preview",
          leafEntryId: session.sessionManager.getLeafId(),
          capturedAt: new Date().toISOString(),
          model: modelRef(session.model),
          thinkingLevel: session.thinkingLevel,
          messages: (projection.messages ?? []).map((m: any) => ({ role: String(m.role ?? "?"), content: m.content ?? null })),
          unavailableFields: ["systemPrompt", "toolDeclarations", "routing", "providerPayload"],
          note: "Runtime preview from the managed host's in-memory projection. Pi hooks/routing/conversion may still alter the provider request.",
        };
      }
      case "dialogRespond": {
        const pd = dialogs.get(args.requestId);
        if (!pd || pd.answered) throw mkErr("dialog already answered/expired/unknown", "stale_control");
        if (args.requestGeneration !== undefined && args.requestGeneration !== pd.generation) throw mkErr("stale dialog generation", "stale_control");
        pd.answered = true;
        if (pd.timer) clearTimeout(pd.timer);
        dialogs.delete(args.requestId);
        emit("dialog_resolved", { requestId: args.requestId, reason: args.cancelled ? "cancelled" : "answered" });
        const value = args.cancelled ? undefined : pd.kind === "confirm" ? !!args.confirmed : args.value === undefined ? undefined : args.value;
        pd.resolve(value);
        touch();
        return { resolved: true };
      }
      case "stopForTerminal": {
        if (args.mode === "abort") await session.abort();
        else await session.waitForIdle();
        for (const d of dialogs.values()) if (!d.answered) { d.answered = true; d.resolve(undefined); }
        dialogs.clear();
        emit("host_exiting", { reason: "stopForTerminal" });
        try { session.dispose(); } catch { /* ignore */ }
        setTimeout(() => process.exit(0), 250);
        return { exiting: true };
      }
      case "clearQueue": throw mkErr("queue clearing not exposed by SDK", "unsupported_capability");
      default: throw mkErr(`unknown command ${cmd}`, "unsupported_capability");
    }
  }

  function mkErr(message: string, code: string) {
    const e = new Error(message) as Error & { code: string };
    e.code = code;
    return e;
  }

  function send(frame: unknown) {
    try { process.send?.(frame); } catch { /* parent gone */ }
  }

  process.on("message", (msg: any) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "ping") { send({ t: "pong", id: msg.id }); return; }
    if (msg.t !== "cmd") return;
    const args = { ...(msg.args ?? {}), _resId: msg.id };
    pendingRes.set(msg.id, true);
    const invoke = async () => {
      try {
        const data = await handleCommand(msg.cmd, args);
        if (data === NORESPONSE) return; // prompt acks via preflightResult instead
        if (pendingRes.get(msg.id)) { pendingRes.delete(msg.id); send({ t: "res", id: msg.id, ok: true, data }); }
      } catch (e) {
        if (pendingRes.get(msg.id)) { pendingRes.delete(msg.id); send({ t: "res", id: msg.id, ok: false, error: { code: (e as Error & { code?: string }).code ?? "internal", message: String((e as Error).message ?? e).slice(0, 300) } }); }
      }
    };
    const urgent = msg.cmd === "abort" || msg.cmd === "dialogRespond" || msg.cmd === "prompt";
    if (urgent) void invoke();
    else void serialize(invoke);
  });

  process.on("disconnect", () => {
    // Fail closed: parent server died (plan F-05). dispose() is cancellation, not a flush proof.
    try { void Promise.resolve(session.abort()).catch(() => {}).finally(() => { try { session.dispose(); } catch { /* ignore */ } }); } catch { try { session.dispose(); } catch { /* ignore */ } }
    setTimeout(() => process.exit(1), 1500);
  });

  function waitForInit(): Promise<HostInitArgs> {
    return new Promise((resolve) => {
      const handler = (msg: any) => {
        if (msg?.t === "init") {
          process.off("message", handler);
          resolve(msg.args as HostInitArgs);
        }
      };
      process.on("message", handler);
      try { process.send?.({ t: "host_ready", pid: process.pid }); } catch { /* ignore */ }
    });
  }

  send({
    t: "auth_ok",
    hello: {
      protocol: 1, runtimeId, pid: process.pid, procStart: Math.floor(performance.timeOrigin),
      piVersion, cwd: init.cwd, sessionFile: session.sessionFile ?? null, sessionId: session.sessionId ?? null,
      mode: "managed", capabilities: caps(), startedAt,
    },
  });
}

if (process.env.PIWEB_MANAGED_HOST === "1") {
  main().catch((e) => {
    // Sanitized fatal metadata only: raw stderr may contain prompt/provider details.
    console.error(JSON.stringify({ host_fatal: String((e as Error)?.message ?? e).slice(0, 200) }));
    process.exit(1);
  });
}
