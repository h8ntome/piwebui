/**
 * A stand-in for pi's ExtensionAPI / ExtensionContext, good enough to drive the bridge through
 * session replacement, dialogs, tools and prompts without booting a real TUI. The real-thing proof
 * lives in `test/pty-smoke.mts`; this harness is for the state machine.
 */
import { EventEmitter } from "node:events";

export interface FakePiOptions {
  sessionId?: string;
  sessionFile?: string | null;
  cwd?: string;
  mode?: "tui" | "print" | "rpc" | "json";
  idle?: boolean;
  piVersion?: string;
}

export interface FakeInstance {
  pi: Record<string, never>;
  ctx: Record<string, never>;
  events: string[];
  calls: { kind: string; args: unknown }[];
  commands: Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>;
  flags: Map<string, unknown>;
  setIdle(v: boolean): void;
  replaceWith(opts?: FakePiOptions): FakeInstance;
}

export function makePi(opts: FakePiOptions = {}): FakeInstance {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  const pending: Promise<unknown>[] = [];
  const events: string[] = [];
  const calls: { kind: string; args: unknown }[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const flags = new Map<string, unknown>();
  const state = {
    sessionId: opts.sessionId ?? "01a1ba52-0000-7000-8000-000000000001",
    sessionFile: opts.sessionFile === undefined ? "/tmp/fake/session.jsonl" : opts.sessionFile,
    idle: opts.idle ?? true,
    name: undefined as string | undefined,
    thinking: "low" as string,
    model: { provider: "mock", id: "mock-echo", reasoning: true, contextWindow: 100_000 },
  };
  const pi = {
    on(event: string, handler: (e: unknown, ctx: unknown) => Promise<void> | void) {
      emitter.on(event, (e: unknown, ctx: unknown) => {
        events.push(`${event}:${(e as { reason?: string })?.reason ?? ""}`);
        pending.push(Promise.resolve().then(() => handler(e, ctx)));
      });
      return () => { /* unsubscribe not needed by the harness */ };
    },
    registerCommand(name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, def);
    },
    registerFlag(name: string, def: { default?: unknown }) {
      // pi keeps a registered default; a test that pre-set a value keeps it.
      if (!flags.has(name)) flags.set(name, def.default);
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    sendUserMessage(content: unknown, options?: unknown) {
      calls.push({ kind: "sendUserMessage", args: { content, options } });
    },
    sendMessage(message: unknown, options?: unknown) {
      calls.push({ kind: "sendMessage", args: { message, options } });
    },
    async setModel(model: unknown) {
      calls.push({ kind: "setModel", args: model });
      state.model = model as typeof state.model;
      return true;
    },
    setThinkingLevel(level: string) {
      calls.push({ kind: "setThinkingLevel", args: level });
      state.thinking = level;
    },
    getThinkingLevel() { return state.thinking; },
    setSessionName(name: string) {
      calls.push({ kind: "setSessionName", args: name });
      state.name = name;
    },
    getSessionName() { return state.name; },
    getCommands() { return [{ name: "help", invocationName: "/help", description: "help" }]; },
    // test hooks
    __emit(event: string, payload: unknown, ctx: unknown) {
      emitter.emit(event, payload, ctx);
      // Handlers are async (pi awaits them); drain them so tests are deterministic.
      return (async () => { while (pending.length) await pending.shift(); })();
    },
    __state: state,
    __opts: opts,
  };
  const ctx = {
    mode: opts.mode ?? "tui",
    hasUI: (opts.mode ?? "tui") === "tui",
    cwd: opts.cwd ?? "/tmp/fake",
    sessionManager: {
      getSessionId: () => state.sessionId,
      getSessionFile: () => state.sessionFile,
      getCwd: () => opts.cwd ?? "/tmp/fake",
      getLeafId: () => "e1",
      getEntries: () => [{ id: "e1", type: "message" }],
      getTree: () => [{ entry: { id: "e1", type: "message", timestamp: "2026-11-08T00:00:00Z", message: { role: "user", content: "hi" } }, children: [] }],
      buildContextEntries: () => [{ id: "e1", type: "message", message: { role: "user", content: "hi" } }],
    },
    modelRegistry: {
      find: (provider: string, modelId: string) => (provider === "mock" ? { provider, id: modelId } : undefined),
      getAvailable: () => [{ provider: "mock", id: "mock-echo", name: "Mock", reasoning: true }],
    },
    model: state.model,
    isIdle: () => state.idle,
    hasPendingMessages: () => false,
    abort() { calls.push({ kind: "abort", args: null }); },
    compact(options?: unknown) {
      calls.push({ kind: "compact", args: options });
      (options as { onComplete?: () => void } | undefined)?.onComplete?.();
    },
    getContextUsage: () => ({ tokens: 100, contextWindow: 100_000, percent: 0.1 }),
    ui: {
      statuses: new Map<string, string | undefined>(),
      notifications: [] as string[],
      setStatus(key: string, text: string | undefined) { this.statuses.set(key, text); },
      notify(text: string) { this.notifications.push(text); },
    },
  };
  return {
    pi: pi as unknown as Record<string, never>,
    ctx: ctx as unknown as Record<string, never>,
    events,
    calls,
    commands,
    flags,
    setIdle(v: boolean) { state.idle = v; },
    replaceWith(next?: FakePiOptions) {
      // pi re-instantiates extensions on /new: fresh pi, fresh ctx, same process.
      return makePi({ ...opts, ...next, sessionId: next?.sessionId ?? state.sessionId });
    },
  };
}

/** Fire a session start the way pi does: shutdown(new) -> factory -> start(new). */
export async function startSession(inst: FakeInstance, reason: "startup" | "new" | "resume" | "fork" | "reload") {
  await (inst.pi as unknown as { __emit: (e: string, p: unknown, c: unknown) => Promise<void> }).__emit(
    "session_start", { type: "session_start", reason }, inst.ctx,
  );
}

export async function shutdownSession(inst: FakeInstance, reason: "quit" | "new" | "resume" | "fork" | "reload") {
  await (inst.pi as unknown as { __emit: (e: string, p: unknown, c: unknown) => Promise<void> }).__emit(
    "session_shutdown", { type: "session_shutdown", reason }, inst.ctx,
  );
}

export async function emit(inst: FakeInstance, event: string, payload: unknown) {
  await (inst.pi as unknown as { __emit: (e: string, p: unknown, c: unknown) => Promise<void> }).__emit(event, payload, inst.ctx);
}

/** A fake sink with the shape DialConn exposes, so hub bookkeeping can be tested without sockets. */
export function fakeConn(serverId = "fake") {
  const conn = {
    spec: { serverId, socket: `/tmp/${serverId}.sock` },
    authed: true,
    closed: false,
    advertised: 0,
    sent: [] as { name: string }[],
    advertise() { conn.advertised++; },
    sendEvent(rec: { name: string }) { conn.sent.push(rec); },
    close() { conn.closed = true; conn.authed = false; },
  };
  return conn;
}
