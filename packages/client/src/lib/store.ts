/** Central client state (zustand). Mirrors server-pushed state; never invents it.
    Every action here maps onto a real pi-web endpoint. */
import { create } from "zustand";
import { api, newOperationId, ApiError } from "./api";
import { SseManager } from "./sse";
import { toast } from "../ui/Toast";

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
export interface FileView { kind: string; path: string; sizeBytes: number; text?: string; entries?: { name: string; kind: string; sizeBytes: number | null }[] }

export interface SessionView {
  entries: EntryView[];
  entryTotal: number;
  hasOlder: boolean;
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
  entries: [], entryTotal: 0, hasOlder: false, runtime: null, previews: {}, tools: {},
  dialogs: [], status: null, meta: null, sse: "connecting", notes: [], models: [],
  commands: [], context: null, stats: null, tree: null, loaded: false,
});

interface Store {
  ready: boolean;
  error: string | null;
  health: { version: string; pi: { resolvedVersion: string | null; tested: boolean }; managed: { active: number; limit: number } } | null;
  workspaces: WorkspaceInfo[];
  sessions: SessionListItem[];
  activeKey: string | null;
  views: Record<string, SessionView>;
  lastOperation: { id: string; state: string; message?: string } | null;

  boot: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  openSession: (key: string) => Promise<void>;
  closeSse: (key: string) => void;
  loadPanel: (key: string, which: "context" | "stats" | "tree") => Promise<void>;
  command: (command: Record<string, unknown>, key?: string) => Promise<void>;
  acquireControl: (key: string) => Promise<boolean>;
  renewControl: (key: string) => Promise<boolean>;
  answerDialog: (d: DialogRequest, value: unknown, cancel?: boolean) => Promise<void>;
  createSession: (workspaceKey: string) => Promise<string | null>;
  startInWorkspace: (workspaceKey: string, text: string, images?: WireImage[]) => Promise<string | null>;
  heroWorkspace: string | null;
  setHeroWorkspace: (key: string | null) => void;
  removeWorkspace: (key: string) => Promise<void>;
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
      patch(key, (v) => ({ ...v, status: out.status ?? v.status, meta: out.meta ?? v.meta }));
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
  const watchOperation = (opId: string) => {
    const poll = async (delay: number) => {
      window.setTimeout(async () => {
        try {
          const rec = await api.get<{ state: string; result?: { error?: { message?: string; code?: string } } }>(`/api/v1/operations/${encodeURIComponent(opId)}`);
          if (rec.state === "failed" || rec.state === "unknown" || rec.state === "cancelled") {
            const msg = rec.result?.error?.message ?? `${rec.state}`;
            set({ lastOperation: { id: opId, state: rec.state, message: msg } });
            toast.error(msg);
            const k = get().activeKey;
            if (k) {
              patch(k, (v) => ({ ...v, notes: [...v.notes.slice(-3), msg] }));
              window.setTimeout(() => patch(k, (v) => ({ ...v, notes: v.notes.filter((n) => n !== msg) })), 9000);
            }
          } else if (rec.state === "succeeded") {
            set({ lastOperation: { id: opId, state: "succeeded" } });
          } else {
            if (delay < 8000) await poll(delay * 2);
          }
        } catch { /* the receipt may already be pruned */ }
      }, delay);
    };
    void poll(1200);
  };

  const attachSse = (key: string) => {
    if (sses.has(key)) return;
    sses.set(key, new SseManager(key, {
      onOpen: () => patch(key, (v) => ({ ...v, sse: "live" })),
      onStatus: (s) => patch(key, (v) => ({ ...v, sse: s })),
      onEvent: (name, payload) => {
        patch(key, (v) => applySseEvent(v, name, payload));
        // these mean "your view of the world is stale": pull the authoritative snapshot
        if (name === "ownerChanged" || name === "resync" || name === "hostExited") void refreshStatus(key);
      },
    }));
  };

  return {
    ready: false, error: null, health: null, workspaces: [], sessions: [], activeKey: null,
    views: {}, lastOperation: null, heroWorkspace: null,

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
        set({ ready: true, error: null, health });
        await get().refreshSessions();
      } catch (e) {
        set({ ready: false, error: (e as Error).message || "cannot reach the pi-web server" });
      }
    },

    refreshSessions: async () => {
      const [out, ws] = await Promise.all([
        api.get<{ sessions: SessionListItem[] }>("/api/v1/sessions?limit=200"),
        api.get<{ workspaces: { workspaceKey: string; path: string; label?: string | null }[] }>("/api/v1/workspaces"),
      ]);
      set({
        sessions: out.sessions,
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
        get().note((e as ApiError).message);
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
      try {
        const m = await api.get<{ models: ModelInfo[] }>(`/api/v1/sessions/${encodeURIComponent(key)}/models`);
        patch(key, (v) => ({ ...v, models: m.models ?? [] }));
      } catch { /* no owning runtime with a catalogue */ }
      try {
        const c = await api.get<{ commands: { name: string; description?: string; argumentHint?: string }[] }>(`/api/v1/sessions/${encodeURIComponent(key)}/commands`);
        patch(key, (v) => ({ ...v, commands: c.commands ?? [] }));
      } catch { /* command list is optional */ }
    },

    closeSse: (key) => { sses.get(key)?.close(); sses.delete(key); },

    loadPanel: async (key, which) => {
      try {
        const out = await api.get<Record<string, unknown>>(`/api/v1/sessions/${encodeURIComponent(key)}/${which}`);
        patch(key, (v) => ({ ...v, [which]: out } as SessionView));
      } catch (e) { get().note((e as ApiError).message); }
    },

    command: async (command, keyOverride) => {
      const key = keyOverride ?? get().activeKey;
      if (!key) return;
      const st = get().views[key]?.status;
      if (!st?.runtime) { get().note("no controllable runtime for this session (file mirror / owner offline)"); return; }
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
        watchOperation(opId);
        setTimeout(() => { void get().refreshSessions(); }, 900);
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
              return;
            } catch (e2) { err.code = (e2 as ApiError).code; err.message = (e2 as ApiError).message; }
          }
        }
        set({ lastOperation: { id: opId, state: "failed", message: err.message } });
        get().note(err.message);
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
      } catch (e) { get().note((e as ApiError).message); return null; }
    },

    setHeroWorkspace: (key) => set({ heroWorkspace: key }),

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
      } catch (e) { get().note((e as ApiError).message); }
      return key;
    },

    addWorkspace: async (path, label) => {
      try {
        const out = await api.post<{ workspace: { workspaceKey: string } }>("/api/v1/workspaces", { path, ...(label ? { label } : {}) });
        await get().refreshSessions();
        return out.workspace.workspaceKey;
      } catch (e) { toast.error((e as ApiError).message); return null; }
    },

    removeWorkspace: async (key) => {
      try {
        await api.del(`/api/v1/workspaces/${encodeURIComponent(key)}`);
        await get().refreshSessions();
      } catch (e) { toast.error((e as ApiError).message); }
    },

    browse: async (path) => {
      try { return await api.get<BrowseResult>(`/api/v1/browse?path=${encodeURIComponent(path)}`); }
      catch (e) { toast.error((e as ApiError).message); return null; }
    },

    readFile: async (workspaceKey, path) => {
      try {
        return await api.get<FileView>(`/api/v1/files?workspaceKey=${encodeURIComponent(workspaceKey)}&path=${encodeURIComponent(path)}`);
      } catch (e) { toast.error((e as ApiError).message); return null; }
    },

    note: (msg) => {
      const k = get().activeKey;
      toast.warn(msg);
      patch(k, (v) => ({ ...v, notes: [...v.notes.slice(-3), msg] }));
      if (k) window.setTimeout(() => patch(k, (v) => ({ ...v, notes: v.notes.filter((n) => n !== msg) })), 8000);
    },
  };
});

export function applySseEvent(v: SessionView, name: string, payload: unknown): SessionView {
  const nv = { ...v };
  switch (name) {
    case "snapshot": {
      const s = payload as { entries?: EntryView[]; entryTotal?: number; runtimeState?: RuntimeState; status?: SessionStatusLite; meta?: SessionMeta; pendingDialogs?: DialogRequest[]; observedDialogs?: DialogRequest[] };
      if (s.entries) { nv.entries = s.entries; nv.entryTotal = s.entryTotal ?? s.entries.length; }
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
      nv.notes = [...nv.notes.slice(-3), `file conflict: ${(payload as { kind?: string })?.kind ?? "detected"} — showing file contents only`];
      break;
    case "ownerChanged":
      // Normal while a managed pi boots or a bridge reconnects: silently re-fetch (see attachSse).
      break;
    case "hostExited": {
      const p = payload as { reason?: string };
      nv.notes = [...nv.notes.slice(-3), `runtime exited (${p.reason ?? "unknown"}); session is now a file mirror`];
      break;
    }
    case "resync":
      nv.notes = [...nv.notes.slice(-3), `stream resync (${(payload as { reason?: string })?.reason ?? "replay unavailable"})`];
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
