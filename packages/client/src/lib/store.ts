/** Central client state (zustand). Mirrors server-pushed state; never invents it.
    Every action here maps onto a real pi-web endpoint. */
import { create } from "zustand";
import { api, newOperationId, ApiError } from "./api";
import { SseManager } from "./sse";
import { humaniseError, isReadOnlyMode } from "./labels";
import { basename } from "./format";
import { toast } from "../ui/Toast";

function dedupeBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const x of xs) { const k = key(x); if (!seen.has(k)) { seen.add(k); out.push(x); } }
  return out;
}

/**
 * Merge the facts carried by `GET /sessions/:key` into the streamed runtime view.
 * `runtime` (from the SSE snapshot) is what the composer chip, `canSendNow` and the Context panel
 * read; `status.runtime` (from the polling endpoint) carries the same model/thinking/name facts
 * plus the phase, so a refresh can correct a view that predates the last turn. Anything the status
 * does not know (previews, tools, queue) is left exactly as the stream reported it - we never
 * synthesise state here.
 */
function foldStatusIntoRuntime(runtime: RuntimeState | null, status: SessionStatusLite | undefined): RuntimeState | null {
  const r = status?.runtime;
  if (!r && !status) return runtime;
  const phase = status?.state && status.state !== "unavailable" ? status.state : runtime?.phase ?? "unknown";
  return {
    phase,
    isStreaming: phase === "streaming" || phase === "compacting" || phase === "retrying" || phase === "awaiting_dialog",
    previews: runtime?.previews ?? [],
    tools: runtime?.tools ?? [],
    queue: runtime?.queue ?? { hasPending: false, count: 0, items: [], note: "" },
    model: r?.model ?? runtime?.model ?? null,
    thinkingLevel: r?.thinkingLevel ?? runtime?.thinkingLevel ?? null,
    sessionName: r?.sessionName ?? runtime?.sessionName ?? null,
    contextUsage: runtime?.contextUsage ?? null,
    leafEntryId: status?.leaf?.entryId ?? runtime?.leafEntryId ?? null,
    lastSettled: runtime?.lastSettled ?? null,
    retry: runtime?.retry ?? null,
    compaction: runtime?.compaction ?? null,
  };
}

export interface EntryView {
  entryId: string; parentId: string | null; type: string; timestamp: string;
  raw: Record<string, unknown>; byteOffset: number; byteLength: number;
  truncated?: boolean; invalid?: boolean;
}
export interface PreviewState {
  liveMessageId: string; role: "assistant" | "user"; rev: number;
  blocks: { index: number; block: Record<string, unknown> }[];
  startedAt: string; done: boolean; mappedEntryId?: string; truncated?: boolean;
}
export interface ToolStateView {
  toolCallId: string; toolName: string; label?: string;
  state: "running" | "ok" | "error" | "abandoned"; argsPreview?: unknown;
  outputMode: "replace" | "append"; outputText?: string; outputContent?: Record<string, unknown>[];
  durationMs?: number; startedAt: string; endedAt?: string; truncated?: boolean; parentToolCallId?: string;
}
export interface RuntimeState {
  phase: string; isStreaming: boolean; previews: PreviewState[]; tools: ToolStateView[];
  queue: { hasPending: boolean | null; count: number | null; items?: { kind: string; text: string }[]; note: string };
  model: { provider: string; modelId: string; name?: string; contextWindow?: number } | null;
  thinkingLevel: string | null;
  sessionName: string | null;
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  leafEntryId: string | null; lastSettled?: { at: string; aborted: boolean } | null;
  retry?: { active: boolean; reason?: string } | null;
  compaction?: { active: boolean; reason?: string } | null;
}
export interface DialogRequest {
  requestId: string; requestGeneration: number; kind: "select" | "confirm" | "input" | "editor";
  title: string; message?: string; options?: string[]; placeholder?: string; prefill?: string;
  timeoutMs?: number; expiresAt?: string | null; observed?: boolean;
}
export interface SessionMeta {
  sessionKey: string; workspaceKey: string | null; path: string | null; name: string | null;
  cwd: string | null; modified: string | null; created?: string | null; firstPrompt: string | null;
  messageCount: number | null; piSessionId: string | null; sizeBytes?: number | null;
}
export interface SessionListItem { meta: SessionMeta; mode: string; state: string }
export interface SessionStatusLite {
  mode: string; state: string; driver: string;
  runtime: { runtimeId: string; runtimeGeneration: number; pid: number; piVersion: string; hostKind: string; piMode: string; sessionFile?: string | null; model?: { provider: string; modelId: string; name?: string } | null; thinkingLevel?: string | null; sessionName?: string | null; cwd?: string | null } | null;
  sessionGeneration: number;
  leaf: { entryId: string | null; source: string | null };
  compat: { tested: boolean; detail: string; piVersion?: string | null };
  conflict: unknown | null;
  capabilities: Record<string, boolean> & { queue?: string };
  control: { epoch: number; controllerId: string | null } | null;
}
export interface ModelInfo { provider: string; modelId: string; name?: string; contextWindow?: number; maxTokens?: number; reasoning?: boolean; available?: boolean }
export interface WorkspaceInfo { key: string; path: string; label: string | null }
export interface WireImage { mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp"; dataBase64: string; name?: string }
export interface BrowseResult { path: string; parent: string | null; home: string; entries: { name: string; kind: "dir" | "file" }[]; truncated: boolean }
export interface FileView { kind: string; path: string; sizeBytes: number; text?: string; truncated?: boolean; entries?: { name: string; kind: string; sizeBytes: number | null }[] }

export interface SessionView {
  entries: EntryView[];
  entryTotal: number;
  hasOlder: boolean;
  /** Entry id to page from to reach the entries before `entries[0]` (null = at the start). */
  olderCursor: string | null;
  loadingOlder: boolean;
  /** Lines of the session file that could not be read (SRV-04). */
  diagnostics: { message: string; byteOffset: number }[];
  runtime: RuntimeState | null;
  previews: Record<string, PreviewState>;
  tools: Record<string, ToolStateView>;
  dialogs: DialogRequest[];
  status: SessionStatusLite | null;
  meta: SessionMeta | null;
  sse: "connecting" | "live" | "closed";
  notes: string[];
  models: ModelInfo[];
  commands: { name: string; description?: string; argumentHint?: string }[];
  context: unknown | null;
  stats: unknown | null;
  tree: unknown | null;
  loaded: boolean;
}

const emptySession = (): SessionView => ({
  entries: [], entryTotal: 0, hasOlder: false, olderCursor: null, loadingOlder: false,
  diagnostics: [], runtime: null, previews: {}, tools: {},
  dialogs: [], status: null, meta: null, sse: "connecting", notes: [], models: [],
  commands: [], context: null, stats: null, tree: null, loaded: false,
});

interface Store {
  ready: boolean;
  error: string | null;
  /** How many times boot() has been retried since the server last answered (GEN-01). */
  bootAttempts: number;
  /** The server stopped answering while the tab stayed open (SRV-05). */
  serverDown: boolean;
  health: { version: string; pi: { resolvedVersion: string | null; tested: boolean }; managed: { active: number; limit: number } } | null;
  workspaces: WorkspaceInfo[];
  sessions: SessionListItem[];
  activeKey: string | null;
  views: Record<string, SessionView>;
  lastOperation: { id: string; state: string; message?: string } | null;

  boot: () => Promise<void>;
  /** One cheap health probe; also the "did the server go away underneath us?" watch. */
  pingServer: () => Promise<void>;
  /**
   * The machine-wide stream: "a terminal pi just became controllable" (or stopped being).
   * Without this a tab only learns about new sessions when it reloads (E15).
   */
  watchGlobal: () => void;
  refreshSessions: () => Promise<void>;
  openSession: (key: string) => Promise<void>;
  loadCatalogue: (key: string) => Promise<void>;
  loadOlder: (key: string) => Promise<void>;
  closeSse: (key: string) => void;
  loadPanel: (key: string, which: "context" | "stats" | "tree") => Promise<void>;
  command: (command: Record<string, unknown>, key?: string) => Promise<boolean>;
  acquireControl: (key: string) => Promise<boolean>;
  renewControl: (key: string) => Promise<boolean>;
  answerDialog: (d: DialogRequest, value: unknown, cancel?: boolean) => Promise<void>;
  createSession: (workspaceKey: string) => Promise<string | null>;
  startInWorkspace: (workspaceKey: string, text: string, images?: WireImage[]) => Promise<string | null>;
  heroWorkspace: string | null;
  setHeroWorkspace: (key: string | null) => void;
  /** Workspace the Files panel should show; set when a workspace row is clicked (SB-08). */
  filesWorkspaceKey: string | null;
  setFilesWorkspaceKey: (key: string | null) => void;
  removeWorkspace: (key: string) => Promise<void>;
  deleteSession: (key: string) => Promise<void>;
  hiddenCount: number;
  addWorkspace: (path: string, label?: string) => Promise<string | null>;
  browse: (path: string) => Promise<BrowseResult | null>;
  readFile: (workspaceKey: string, path: string) => Promise<FileView | null>;
  note: (msg: string) => void;
}

/* control grants: one controller id per browser tab, secrets in memory only */
const controllerId = (() => {
  let id = sessionStorage.getItem("piweb-controller");
  if (!id) { id = `c-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`; sessionStorage.setItem("piweb-controller", id); }
  return id;
})();
const grants = new Map<string, { epoch: number; secret: string; expiresAt: number }>();
const renewTimers = new Map<string, number>();

/** One machine-wide stream per tab (`watchGlobal`); null until the first successful boot. */
let globalStream: EventSource | null = null;

/** Keys of the rows the sidebar currently shows, in display order. Module-level (not store
    state) on purpose: it is read by the Alt+↑/↓ handler, which must not cause a re-render. */
export const visibleSessionKeys: string[] = [];

export const useStore = create<Store>((set, get) => {
  const sses = new Map<string, SseManager>();

  const patch = (key: string | null, fn: (v: SessionView) => SessionView) => {
    if (!key) return;
    const views = { ...get().views };
    views[key] = fn(views[key] ? { ...views[key] } : emptySession());
    set({ views });
  };

  /** Re-read status/meta for one session without touching the selection. */
  const refreshStatus = async (key: string) => {
    try {
      const out = await api.get<{ meta: SessionMeta; status: SessionStatusLite }>(`/api/v1/sessions/${encodeURIComponent(key)}`);
      patch(key, (v) => ({
        ...v,
        status: out.status ?? v.status,
        meta: out.meta ?? v.meta,
        // The composer chip, canSendNow and the Context panel all read `runtime`, not `status`.
        // Refreshing only the latter left them reporting whatever a snapshot said when the stream
        // first attached - stale counts and composer state until a hard reload (BUG-008). The
        // status answer carries the same facts, so fold them in without inventing any.
        runtime: foldStatusIntoRuntime(v.runtime, out.status),
      }));
      if (out.status?.capabilities?.canControl && !grants.has(key)) void get().acquireControl(key);
    } catch { /* the stream will offer another chance */ }
  };

  /** Keep this tab's control grant alive while the session is open. */
  function scheduleRenewal(key: string) {
    const existing = renewTimers.get(key);
    if (existing) window.clearTimeout(existing);
    const g = grants.get(key);
    const wait = Math.max(5_000, Math.min(60_000, (g ? g.expiresAt : Date.now() + 60_000) - Date.now() - 10_000));
    renewTimers.set(key, window.setTimeout(() => {
      if (get().activeKey !== key) { renewTimers.delete(key); return; }
      void get().renewControl(key);
    }, wait));
  }

  /**
   * Commands are asynchronous: the POST only says "accepted". Poll the operation
   * receipt so the owner can report "no" (bad model, thinking level not supported…).
   */
  const watchOperation = (opId: string, sessionKey?: string) => {
    const poll = async (delay: number) => {
      window.setTimeout(async () => {
        try {
          const rec = await api.get<{ state: string; result?: { error?: { message?: string; code?: string } } }>(`/api/v1/operations/${encodeURIComponent(opId)}`);
          // A failure belongs to the session the command was sent for, not whichever row happens
          // to be open when the receipt comes back (BUG-027).
          const k = sessionKey ?? get().activeKey;
          if (rec.state === "failed" || rec.state === "unknown" || rec.state === "cancelled") {
            const msg = humaniseError(rec.result?.error?.message ?? `${rec.state}`);
            set({ lastOperation: { id: opId, state: rec.state, message: msg } });
            toast.error(msg);
            if (k) {
              patch(k, (v) => ({ ...v, notes: [...v.notes.slice(-3), msg] }));
              window.setTimeout(() => patch(k, (v) => ({ ...v, notes: v.notes.filter((n) => n !== msg) })), 9000);
            }
          } else if (rec.state === "succeeded") {
            set({ lastOperation: { id: opId, state: "succeeded" } });
            // The runtime is now the authority again: pull status so a model/thinking switch
            // shows in the chip, the menu tick and the panel within a second (CTL-03).
            if (k) { await refreshStatus(k); void get().loadCatalogue(k); }
          } else {
            if (delay < 8000) await poll(delay * 2);
          }
        } catch { /* the receipt may already be pruned */ }
      }, delay);
    };
    void poll(1200);
  };

  const attachSse = (key: string) => {
    // Re-attaching a session whose stream never delivered a snapshot (tab restored, stream died
    // before the first frame) has to actually re-subscribe; the old unconditional early-return
    // meant "open this session again" never re-read it (BUG-008).
    if (sses.has(key) && get().views[key]?.runtime) return;
    sses.get(key)?.close();
    sses.set(key, new SseManager(key, {
      onOpen: () => patch(key, (v) => ({ ...v, sse: "live" })),
      onStatus: (s) => patch(key, (v) => ({ ...v, sse: s })),
      onEvent: (name, payload) => {
        patch(key, (v) => applySseEvent(v, name, payload));
        // these mean "your view of the world is stale": pull the authoritative snapshot
        if (name === "ownerChanged" || name === "resync" || name === "hostExited") void refreshStatus(key);
        // A runtime that just appeared (or just changed) is the first moment its catalogues exist.
        if (name === "ownerChanged") void get().loadCatalogue(key);
        if (name === "runtimeState") {
          const r = payload as RuntimeState;
          const v = get().views[key];
          if (v && r?.model && (!v.models.length || v.models.some((m) => `${m.provider}/${m.modelId}` !== `${r.model!.provider}/${r.model!.modelId}`))) {
            // model changed outside our own command (terminal pi, another tab): re-read it
            if (v.runtime?.model && (v.runtime.model.provider !== r.model.provider || v.runtime.model.modelId !== r.model.modelId)) void refreshStatus(key);
          }
        }
      },
    }));
  };

  return {
    ready: false, error: null, bootAttempts: 0, serverDown: false, health: null, workspaces: [], sessions: [], activeKey: null,
    views: {}, lastOperation: null, heroWorkspace: null, filesWorkspaceKey: null, hiddenCount: 0,

    // No login: the server hands out a browser session on the first request, so booting is
    // just "talk to the server, then show the chats".
    boot: async () => {
      try {
        const me = await api.get<{ id: string; kind: string }>("/api/v1/auth/me");
        if (me.kind === "web") {
          const c = await api.get<{ csrf: string | null }>("/api/v1/auth/csrf");
          if (c.csrf) api.setCsrf(c.csrf);
        }
        const health = await api.get<Store["health"]>("/api/v1/health");
        set({ ready: true, error: null, health, bootAttempts: 0 });
        await get().refreshSessions();
        get().watchGlobal();
      } catch (e) {
        // "Failed to fetch" is what the browser says, not what the user wants to read (SRV-08).
        set((s) => ({ ready: false, error: humaniseError((e as Error).message) || "cannot reach the pi-web server", bootAttempts: s.bootAttempts + 1 }));
      }
    },

    watchGlobal: () => {
      if (globalStream || typeof EventSource === "undefined") return;
      try {
        const es = new EventSource("/api/v1/events", { withCredentials: true });
        globalStream = es;
        const on = (name: string) => (ev: MessageEvent) => {
          let payload: { sessionKey?: string; pid?: number; cwd?: string | null; mode?: string; reason?: string } = {};
          try {
            payload = ((JSON.parse(ev.data) as { payload?: unknown }).payload ?? {}) as typeof payload;
          } catch {
            return;
          }
          void get().refreshSessions();
          // Naming the folder (and pid) is the point: it says *which* terminal just joined.
          if (name === "sessionAppeared" && payload.mode === "live") {
            toast.success(`Terminal pi is live${payload.cwd ? ` — ${basename(payload.cwd)}` : ""}${payload.pid ? ` (pid ${payload.pid})` : ""}`);
          }
        };
        for (const name of ["sessionAppeared", "sessionRetired", "runtimeAttached", "runtimeGone"]) {
          es.addEventListener(name, on(name));
        }
        // EventSource reconnects by itself; refetch the list on every fresh open to close gaps.
        es.onopen = () => { void get().refreshSessions(); };
      } catch {
        globalStream = null; // no global stream: the list still refreshes on boot and after commands
      }
    },

    pingServer: async () => {
      // A tab left open while `pi-web` was restarted used to keep showing a stale transcript
      // with no hint at all. One health call per tick makes the outage visible and the
      // recovery automatic (SRV-05). Streams already report their own status.
      const was = get().serverDown;
      try {
        const health = await api.get<Store["health"]>("/api/v1/health");
        if (was) {
          set({ serverDown: false, health, error: null });
          toast.success("Back in touch with pi-web");
          void get().refreshSessions();
        } else {
          set({ health });
        }
      } catch {
        if (!was) {
          set({ serverDown: true });
          toast.error("Lost the pi-web server — retrying every few seconds");
        }
      }
    },

    refreshSessions: async () => {
      // Follow the server's cursor: a capped first page used to hide sessions silently (SRV-02).
      const pages: SessionListItem[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 20; i++) {
        const qs: string = cursor ? `limit=200&cursor=${encodeURIComponent(cursor)}` : "limit=200";
        const out: { sessions: SessionListItem[]; nextCursor?: string | null } = await api.get<{ sessions: SessionListItem[]; nextCursor?: string | null }>(`/api/v1/sessions?${qs}`);
        pages.push(...out.sessions);
        cursor = out.nextCursor ?? null;
        if (!cursor) break;
      }
      const ws = await api.get<{ workspaces: { workspaceKey: string; path: string; label?: string | null }[] }>("/api/v1/workspaces");
      set({
        sessions: dedupeBy(pages, (s) => s.meta.sessionKey),
        workspaces: ws.workspaces.map((w) => ({ key: w.workspaceKey, path: w.path, label: w.label ?? null })),
      });
    },

    acquireControl: async (key) => {
      try {
        const out = await api.post<{ epoch: number; secret: string; expiresAt?: string }>(
          `/api/v1/sessions/${encodeURIComponent(key)}/control`, { action: "acquire", controllerId });
        grants.set(key, { epoch: out.epoch, secret: out.secret, expiresAt: out.expiresAt ? Date.parse(out.expiresAt) : Date.now() + 60_000 });
        scheduleRenewal(key);
        return true;
      } catch (e) {
        get().note(humaniseError((e as ApiError).message));
        return false;
      }
    },

    renewControl: async (key) => {
      const g = grants.get(key);
      if (!g) return get().acquireControl(key);
      try {
        const out = await api.post<{ ok: boolean; expiresAt?: string }>(
          `/api/v1/sessions/${encodeURIComponent(key)}/control`, { action: "renew", controllerId });
        grants.set(key, { ...g, expiresAt: out.expiresAt ? Date.parse(out.expiresAt) : Date.now() + 60_000 });
        scheduleRenewal(key);
        return true;
      } catch {
        grants.delete(key);
        return get().acquireControl(key);
      }
    },

    openSession: async (key) => {
      set({ activeKey: key });
      patch(key, (v) => ({ ...v }));
      attachSse(key); // the SSE stream sends an authoritative snapshot on subscribe
      await refreshStatus(key);
      // The catalogue belongs to the runtime, which may not exist yet; fetch lazily instead of
      // once-at-open (CTL-02), and never leave a stale panel behind from the previous session.
      void get().loadCatalogue(key);
    },

    loadCatalogue: async (key) => {
      const cur = get().views[key];
      if (!cur) return;
      try {
        const m = await api.get<{ models: ModelInfo[] }>(`/api/v1/sessions/${encodeURIComponent(key)}/models`);
        patch(key, (v) => ({ ...v, models: m.models ?? [] }));
      } catch (e) {
        // 501 = this kind of session has no catalogue; distinguish it from "not ready yet".
        const code = (e as ApiError).code;
        patch(key, (v) => ({ ...v, models: [], ...(code === "read_only" ? { notes: v.notes } : {}) }));
      }
      try {
        const c = await api.get<{ commands: { name: string; description?: string; argumentHint?: string }[] }>(`/api/v1/sessions/${encodeURIComponent(key)}/commands`);
        patch(key, (v) => ({ ...v, commands: c.commands ?? [] }));
      } catch { /* command list is optional */ }
    },

    /** Walk backwards through the session file so the oldest turns stay reachable (TRN-01). */
    loadOlder: async (key) => {
      const v = get().views[key];
      if (!v || v.loadingOlder) return;
      const before = v.olderCursor ?? v.entries[0]?.entryId;
      if (!before) { patch(key, (x) => ({ ...x, hasOlder: false })); return; }
      patch(key, (x) => ({ ...x, loadingOlder: true }));
      try {
        const page = await api.get<{ entries: EntryView[]; olderCursor?: string | null; entryCount: number }>(
          `/api/v1/sessions/${encodeURIComponent(key)}/entries?before=${encodeURIComponent(before)}&limit=200`);
        const older = page.entries.filter((e) => !v.entries.some((x) => x.entryId === e.entryId));
        patch(key, (x) => ({
          ...x,
          entries: [...older, ...x.entries],
          // Keep walking back from the oldest record we now hold.
          olderCursor: older.length ? older[0]!.entryId : null,
          hasOlder: Boolean(page.olderCursor) && older.length > 0,
          loadingOlder: false,
        }));
      } catch (e) {
        patch(key, (x) => ({ ...x, loadingOlder: false }));
        get().note(humaniseError((e as ApiError).message));
      }
    },

    closeSse: (key) => { sses.get(key)?.close(); sses.delete(key); },

    loadPanel: async (key, which) => {
      try {
        const out = await api.get<Record<string, unknown>>(`/api/v1/sessions/${encodeURIComponent(key)}/${which}`);
        patch(key, (v) => ({ ...v, [which]: out } as SessionView));
      } catch (e) { get().note(humaniseError((e as ApiError).message)); }
    },

    command: async (command, keyOverride) => {
      const key = keyOverride ?? get().activeKey;
      if (!key) return false;
      const st = get().views[key]?.status;
      if (!st?.runtime) {
        get().note(isReadOnlyMode(st?.mode) ? "This session is read-only: there is no running pi to control." : "No controllable runtime for this session yet.");
        return false;
      }
      if (st.capabilities?.canControl) {
        const g = grants.get(key);
        if (!g || g.expiresAt - Date.now() < 3_000) await get().renewControl(key);
      }
      const grant = grants.get(key);
      const opId = newOperationId();
      const envelope = {
        operationId: opId,
        runtimeId: st.runtime.runtimeId,
        runtimeGeneration: st.runtime.runtimeGeneration,
        sessionGeneration: st.sessionGeneration,
        controlEpoch: grant?.epoch ?? 0,
        controlSecret: grant?.secret ?? "",
        command,
      };
      set({ lastOperation: { id: opId, state: "dispatching" } });
      const resend = async (g?: { epoch: number; secret: string }) => api.post<{ state?: string }>(
        `/api/v1/sessions/${encodeURIComponent(key)}/commands`,
        { ...envelope, controlEpoch: g?.epoch ?? envelope.controlEpoch, controlSecret: g?.secret ?? envelope.controlSecret },
        opId);
      try {
        const out = await resend();
        set({ lastOperation: { id: opId, state: out.state ?? "accepted" } });
        watchOperation(opId, key);
        setTimeout(() => { void get().refreshSessions(); }, 900);
        // A model/thinking change lands inside the runtime a moment after the POST returns;
        // re-read status so the chip and the menu tick stop showing the previous value.
        if (command.type === "setModel" || command.type === "setThinking") {
          setTimeout(() => { void refreshStatus(key); }, 700);
        }
        return true;
      } catch (e) {
        const err = e as ApiError;
        if (err.code === "stale_control" || err.code === "forbidden" || err.code === "busy"
          || (err.code === "invalid_request" && !envelope.controlSecret)) {
          // one transparent re-acquire + retry (control lost to renewal race or new epoch)
          const ok = await get().acquireControl(key);
          if (ok) {
            try {
              const g = grants.get(key)!;
              const out = await resend(g);
              set({ lastOperation: { id: opId, state: out.state ?? "accepted" } });
              watchOperation(opId, key);
              return true;
            } catch (e2) { err.code = (e2 as ApiError).code; err.message = (e2 as ApiError).message; }
          }
        }
        set({ lastOperation: { id: opId, state: "failed", message: err.message } });
        get().note(humaniseError(err.message));
        return false;
      }
    },

    answerDialog: async (d, value, cancel) => {
      const key = get().activeKey;
      if (!key) return;
      const payload: Record<string, unknown> = { type: "dialogResponse", requestId: d.requestId, requestGeneration: d.requestGeneration };
      if (cancel) payload.cancelled = true;
      else if (d.kind === "confirm") payload.confirmed = !!value;
      else payload.value = value == null ? null : String(value);
      await get().command(payload, key);
      patch(key, (v) => ({ ...v, dialogs: v.dialogs.filter((x) => x.requestId !== d.requestId) }));
    },

    createSession: async (workspaceKey) => {
      try {
        const out = await api.post<{ sessionKey: string }>("/api/v1/sessions", { workspaceKey });
        await get().refreshSessions();
        return out.sessionKey;
      } catch (e) { get().note(humaniseError((e as ApiError).message)); return null; }
    },

    setHeroWorkspace: (key) => set({ heroWorkspace: key }),

    setFilesWorkspaceKey: (key) => set({ filesWorkspaceKey: key }),

    /** The hero composer's "pick a workspace, type, send" flow: start a managed pi, wait for
        it to accept input, then deliver the first prompt. Returns the session key. */
    startInWorkspace: async (workspaceKey, text, images) => {
      const key = await get().createSession(workspaceKey);
      if (!key) return null;
      await get().openSession(key);
      // wait for the runtime to boot and advertise promptStart (bounded; the SSE keeps updating)
      const deadline = Date.now() + 45_000;
      for (;;) {
        const st = get().views[key]?.status;
        if (st?.capabilities?.promptStart && st.runtime && st.runtime.runtimeId !== "pending") break;
        if (Date.now() > deadline) { get().note("the new pi did not become controllable in time; open it from the list to retry"); return key; }
        if (!st || !st.runtime) await refreshStatus(key);
        await new Promise((r) => window.setTimeout(r, 300));
      }
      await get().renewControl(key);
      const st = get().views[key]!.status!;
      const opId = newOperationId();
      const grant = grants.get(key);
      try {
        await api.post(`/api/v1/sessions/${encodeURIComponent(key)}/commands`, {
          operationId: opId, runtimeId: st.runtime!.runtimeId, runtimeGeneration: st.runtime!.runtimeGeneration,
          sessionGeneration: st.sessionGeneration, controlEpoch: grant?.epoch ?? 0, controlSecret: grant?.secret ?? "",
          command: { type: "prompt", text, delivery: "start", ...(images?.length ? { images } : {}) },
        }, opId);
        watchOperation(opId, key);
        void get().loadCatalogue(key);
      } catch (e) { get().note(humaniseError((e as ApiError).message)); }
      return key;
    },

    addWorkspace: async (path, label) => {
      try {
        const out = await api.post<{ workspace: { workspaceKey: string } }>("/api/v1/workspaces", { path, ...(label ? { label } : {}) });
        await get().refreshSessions();
        return out.workspace.workspaceKey;
      } catch (e) { toast.error(humaniseError((e as ApiError).message)); return null; }
    },

    removeWorkspace: async (key) => {
      try {
        const gone = get().workspaces.find((w) => w.key === key);
        await api.del(`/api/v1/workspaces/${encodeURIComponent(key)}`);
        await get().refreshSessions();
        toast.success(gone ? `${basename(gone.path)} removed from the allowlist (running sessions were not interrupted)` : "Removed from the allowlist (running sessions were not interrupted)");
      } catch (e) { toast.error(humaniseError((e as ApiError).message)); }
    },

    /** Forget a session in pi-web (its file on disk is left alone; see DELETE /sessions/:key). */
    deleteSession: async (key) => {
      try {
        const out = await api.del<{ note?: string; hiddenPath?: string | null }>(`/api/v1/sessions/${encodeURIComponent(key)}`);
        sses.get(key)?.close();
        sses.delete(key);
        const views = { ...get().views };
        delete views[key];
        set({ views, hiddenCount: get().hiddenCount + (out?.hiddenPath ? 1 : 0), ...(get().activeKey === key ? { activeKey: null } : {}) });
        await get().refreshSessions();
        toast.success(out?.note ?? "Session removed from pi-web.");
      } catch (e) { toast.error(humaniseError((e as ApiError).message)); }
    },

    browse: async (path) => {
      try { return await api.get<BrowseResult>(`/api/v1/browse?path=${encodeURIComponent(path)}`); }
      catch (e) { toast.error(humaniseError((e as ApiError).message)); return null; }
    },

    readFile: async (workspaceKey, path) => {
      try {
        return await api.get<FileView>(`/api/v1/files?workspaceKey=${encodeURIComponent(workspaceKey)}&path=${encodeURIComponent(path)}`);
      } catch (e) { toast.error(humaniseError((e as ApiError).message)); return null; }
    },

    note: (msg) => {
      const k = get().activeKey;
      const text = humaniseError(msg);
      // One visible stack, newest last, no duplicates (CTL-10).
      toast.warn(text);
      patch(k, (v) => ({ ...v, notes: [...v.notes.filter((n) => n !== text).slice(-4), text] }));
      if (k) window.setTimeout(() => patch(k, (v) => ({ ...v, notes: v.notes.filter((n) => n !== text) })), 8000);
    },
  };
});

/**
 * Drop preview objects the transcript no longer needs (TRN-05): a finished preview whose entry
 * has landed, or a finished user echo whose message is already committed, would otherwise pile
 * up for the whole life of the tab.
 */
function prunePreviews(nv: SessionView): void {
  const ids = new Set(nv.entries.map((e) => e.entryId));
  const committedUser = new Set<string>();
  for (const e of nv.entries) {
    const m = (e.raw as { message?: { role?: string; content?: unknown } } | undefined)?.message;
    if (m?.role === "user") {
      const c = m.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b as { text?: string })?.text ?? "").join("") : "";
      committedUser.add(text.trim());
    }
  }
  for (const [id, p] of Object.entries(nv.previews)) {
    if (!p.done) continue;
    if (p.mappedEntryId && ids.has(p.mappedEntryId)) { delete nv.previews[id]; continue; }
    if (p.role === "user") {
      const text = p.blocks.map((b) => (b.block as { text?: string })?.text ?? "").join("").trim();
      if (text && committedUser.has(text)) delete nv.previews[id];
    }
  }
}

export function applySseEvent(v: SessionView, name: string, payload: unknown): SessionView {  const nv = { ...v };
  switch (name) {
    case "snapshot": {
      const s = payload as { entries?: EntryView[]; entryTotal?: number; olderAvailable?: boolean; diagnostics?: { message: string; byteOffset: number }[]; runtimeState?: RuntimeState; status?: SessionStatusLite; meta?: SessionMeta; pendingDialogs?: DialogRequest[]; observedDialogs?: DialogRequest[] };
      if (s.entries) {
        nv.entries = s.entries;
        nv.entryTotal = s.entryTotal ?? s.entries.length;
        // The snapshot is the newest window; anything older is one `?before=` call away.
        nv.olderCursor = s.entries.length ? s.entries[0]!.entryId : null;
        nv.hasOlder = s.olderAvailable ?? nv.entries.length < nv.entryTotal;
      }
      if (s.diagnostics) nv.diagnostics = s.diagnostics;
      if (s.runtimeState) nv.runtime = s.runtimeState;
      if (s.status) nv.status = s.status;
      if (s.meta) nv.meta = s.meta;
      nv.previews = Object.fromEntries((s.runtimeState?.previews ?? []).map((p) => [p.liveMessageId, p]));
      nv.tools = Object.fromEntries((s.runtimeState?.tools ?? []).map((t) => [t.toolCallId, t]));
      nv.dialogs = [...(s.pendingDialogs ?? []), ...(s.observedDialogs ?? [])];
      nv.loaded = true;
      break;
    }
    case "entry": {
      const e = (payload as { entry: EntryView }).entry;
      const idx = nv.entries.findIndex((x) => x.entryId === e.entryId);
      if (idx >= 0) nv.entries = nv.entries.map((x, i) => (i === idx ? e : x));
      else nv.entries = [...nv.entries, e];
      nv.entryTotal = Math.max(nv.entryTotal, nv.entries.length);
      prunePreviews(nv);
      break;
    }
    case "preview": {
      const p = payload as PreviewState;
      nv.previews = { ...nv.previews, [p.liveMessageId]: p };
      if (p.mappedEntryId && nv.entries.some((e) => e.entryId === p.mappedEntryId)) {
        const { [p.liveMessageId]: _drop, ...rest } = nv.previews;
        nv.previews = rest;
      }
      break;
    }
    case "toolState": {
      const t = payload as ToolStateView;
      nv.tools = { ...nv.tools, [t.toolCallId]: { ...(nv.tools[t.toolCallId] ?? ({} as ToolStateView)), ...t } };
      break;
    }
    case "runtimeState": {
      const r = payload as RuntimeState;
      nv.runtime = r;
      for (const p of r.previews ?? []) nv.previews = { ...nv.previews, [p.liveMessageId]: p };
      for (const t of r.tools ?? []) nv.tools = { ...nv.tools, [t.toolCallId]: { ...(nv.tools[t.toolCallId] ?? ({} as ToolStateView)), ...t } };
      const keep = new Set((r.previews ?? []).map((p) => p.liveMessageId));
      for (const id of Object.keys(nv.previews)) if (!keep.has(id)) delete nv.previews[id];
      // A finished preview whose entry has landed is dead weight (TRN-05).
      prunePreviews(nv);
      break;
    }
    case "queueState": {
      const q = payload as RuntimeState["queue"];
      nv.runtime = nv.runtime ? { ...nv.runtime, queue: q } : nv.runtime;
      break;
    }
    case "dialogRequest": {
      const d = payload as DialogRequest;
      nv.dialogs = [...nv.dialogs.filter((x) => x.requestId !== d.requestId), d];
      break;
    }
    case "dialogResolved": {
      const { requestId } = payload as { requestId: string };
      nv.dialogs = nv.dialogs.filter((x) => x.requestId !== requestId);
      break;
    }
    case "conflict":
      nv.notes = [...nv.notes.slice(-3), `The session file changed underneath us (${(payload as { kind?: string })?.kind ?? "detected"}) — showing what is on disk.`];
      break;
    case "ownerChanged":
      // Normal while a managed pi boots or a bridge reconnects: silently re-fetch (see attachSse).
      break;
    case "hostExited": {
      const p = payload as { reason?: string };
      nv.notes = [...nv.notes.slice(-3), `The runtime exited (${p.reason ?? "unknown"}); this session is now read-only.`];
      break;
    }
    case "resync":
      nv.notes = [...nv.notes.slice(-3), "Re-syncing this session…"];
      nv.loaded = false;
      break;
    case "operationState":
    case "controlState":
    default:
      break;
  }
  return nv;
}

// Debug handle: lets the browser console (and our own checks) inspect live state.
if (typeof window !== "undefined") (window as unknown as Record<string, unknown>).__pw = { useStore, api };
