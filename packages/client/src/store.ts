/** Central client state (zustand). Mirrors server-pushed state; never invents it. */
import { create } from "zustand";
import { api, newOperationId, ApiError } from "./api";
import { SseManager } from "./sse";

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
  model: { provider: string; modelId: string } | null; thinkingLevel: string | null;
  sessionName: string | null; contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  leafEntryId: string | null; lastSettled?: { at: string; aborted: boolean } | null;
  retry?: { active: boolean; reason?: string } | null; compaction?: { active: boolean; reason?: string } | null;
}
export interface DialogRequest {
  requestId: string; requestGeneration: number; kind: "select" | "confirm" | "input" | "editor";
  title: string; message?: string; options?: string[]; placeholder?: string; prefill?: string;
  timeoutMs?: number; expiresAt?: string | null; observed?: boolean;
}
export interface SessionListItem {
  meta: { sessionKey: string; workspaceKey: string | null; path: string | null; name: string | null; cwd: string | null; modified: string | null; firstPrompt: string | null; messageCount: number | null; piSessionId: string | null };
  mode: string; state: string;
}
export interface SessionStatusLite {
  mode: string; state: string; driver: string;
  runtime: { runtimeId: string; runtimeGeneration: number; pid: number; piVersion: string; hostKind: string; piMode: string } | null;
  sessionGeneration: number;
  leaf: { entryId: string | null; source: string | null };
  compat: { tested: boolean; detail: string; piVersion?: string | null };
  conflict: unknown | null;
  capabilities: Record<string, boolean>;
  control: { epoch: number; controllerId: string | null } | null;
}

export interface SessionView {
  entries: EntryView[];
  entryTotal: number;
  hasOlder: boolean;
  runtime: RuntimeState | null;
  previews: Record<string, PreviewState>;
  tools: Record<string, ToolStateView>;
  dialogs: DialogRequest[];
  status: SessionStatusLite | null;
  sse: "connecting" | "live" | "closed";
  notes: string[];           // transient notices (resync reasons, conflicts)
  models: { provider: string; modelId: string; label?: string }[];
  loaded: boolean;
}

const emptySession = (): SessionView => ({
  entries: [], entryTotal: 0, hasOlder: false, runtime: null, previews: {}, tools: {},
  dialogs: [], status: null, sse: "connecting", notes: [], models: [], loaded: false,
});

interface Store {
  authed: boolean | null;
  principal: { id: string; kind: string } | null;
  workspaces: { key: string; path: string; label: string | null }[];
  sessions: SessionListItem[];
  activeKey: string | null;
  views: Record<string, SessionView>;
  lastOperation: { id: string; state: string; message?: string } | null;

  boot: () => Promise<void>;
  login: (code: string) => Promise<string | null>;
  logout: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  openSession: (key: string) => Promise<void>;
  closeSse: (key: string) => void;
  loadOlder: () => Promise<void>;
  command: (command: Record<string, unknown>) => Promise<void>;
  acquireControl: (key: string) => Promise<boolean>;
  answerDialog: (d: DialogRequest, value: unknown, cancel?: boolean) => Promise<void>;
  createSession: (workspaceKey: string) => Promise<string | null>;
  note: (msg: string) => void;
  refreshStatus: () => Promise<void>;
}

/* control grants: one controller id per browser tab, secrets in memory only */
const controllerId = (() => {
  let id = sessionStorage.getItem("piweb-controller");
  if (!id) { id = `c-${Math.random().toString(36).slice(2, 10)}-${Date.now().toString(36)}`; sessionStorage.setItem("piweb-controller", id); }
  return id;
})();
const grants = new Map<string, { epoch: number; secret: string }>();

export const useStore = create<Store>((set, get) => {
  const sses = new Map<string, SseManager>();

  const patch = (key: string | null, fn: (v: SessionView) => SessionView) => {
    if (!key) return;
    const views = { ...get().views };
    views[key] = fn(views[key] ? { ...views[key] } : emptySession());
    set({ views });
  };

  const attachSse = (key: string) => {
    if (sses.has(key)) return;
    const mgr = new SseManager(key, {
      onOpen: () => patch(key, (v) => ({ ...v, sse: "live" })),
      onStatus: (s) => patch(key, (v) => ({ ...v, sse: s })),
      onEvent: (name, payload) => {
        patch(key, (v) => applySseEvent(v, name, payload));
      },
    });
    sses.set(key, mgr);
  };

  return {
    authed: null, principal: null, workspaces: [], sessions: [], activeKey: null,
    views: {}, lastOperation: null,

    boot: async () => {
      try {
        const me = await api.get<{ id: string; name: string; kind: string }>("/api/v1/auth/me");
        if (me.kind === "web") {
          const c = await api.get<{ csrf: string | null }>("/api/v1/auth/csrf");
          if (c.csrf) api.setCsrf(c.csrf);
        }
        set({ authed: true, principal: { id: me.id, kind: me.kind } });
        await get().refreshSessions();
      } catch (e) {
        set({ authed: (e as ApiError).status === 401 ? false : null });
        if ((e as ApiError).status !== 401) set({ authed: false });
      }
    },

    login: async (code) => {
      try {
        const out = await api.post<{ csrf: string }>("/api/v1/auth/exchange", { code });
        api.setCsrf(out.csrf);
        const me = await api.get<{ id: string; name: string; kind: string }>("/api/v1/auth/me");
        set({ authed: true, principal: { id: me.id, kind: me.kind } });
        await get().refreshSessions();
        return null;
      } catch (e) { return (e as ApiError).message ?? "login failed"; }
    },

    logout: async () => {
      try { await api.post("/api/v1/auth/logout"); } catch { /* ignore */ }
      api.setCsrf("");
      set({ authed: false, principal: null, sessions: [], views: {}, activeKey: null });
    },

    refreshSessions: async () => {
      const [out, ws] = await Promise.all([
        api.get<{ sessions: SessionListItem[] }>("/api/v1/sessions?limit=100"),
        api.get<{ workspaces: { workspaceKey: string; path: string; label?: string | null }[] }>("/api/v1/workspaces"),
      ]);
      set({ sessions: out.sessions, workspaces: ws.workspaces.map((w) => ({ key: w.workspaceKey, path: w.path, label: w.label ?? null })) });
    },

    acquireControl: async (key) => {
      try {
        const out = await api.post<{ epoch: number; secret: string }>(`/api/v1/sessions/${encodeURIComponent(key)}/control`, { action: "acquire", controllerId });
        grants.set(key, { epoch: out.epoch, secret: out.secret });
        return true;
      } catch (e) {
        get().note((e as ApiError).message);
        return false;
      }
    },

    openSession: async (key) => {
      set({ activeKey: key });
      patch(key, (v) => ({ ...v }));
      attachSse(key); // the SSE stream sends an authoritative snapshot on subscribe
      try {
        const out = await api.get<{ meta: SessionListItem["meta"]; status: SessionStatusLite }>(`/api/v1/sessions/${encodeURIComponent(key)}`);
        patch(key, (v) => ({ ...v, status: out.status }));
        if (out.status.capabilities?.canControl && !grants.has(key)) void get().acquireControl(key);
      } catch { /* keep */ }
      try {
        const m = await api.get<{ models: { provider: string; modelId: string }[] }>(`/api/v1/sessions/${encodeURIComponent(key)}/models`);
        patch(key, (v) => ({ ...v, models: m.models ?? [] }));
      } catch { /* owner offline */ }
    },

    closeSse: (key) => {
      sses.get(key)?.close();
      sses.delete(key);
    },

    loadOlder: async () => {
      const { activeKey } = get();
      const v = activeKey ? get().views[activeKey] : null;
      if (!activeKey || !v?.entries.length) return;
      // entries page walks from file head; fetch first page not yet loaded (simple growing prefix)
      try {
        const page = await api.get<{ entries: EntryView[] }>(`/api/v1/sessions/${encodeURIComponent(activeKey)}/entries?limit=200`);
        patch(activeKey, (s) => ({ ...s, entries: page.entries.length < s.entries.length ? page.entries : s.entries, hasOlder: false }));
      } catch { /* ignore */ }
    },

    command: async (command) => {
      const { activeKey } = get();
      if (!activeKey) return;
      const st = get().views[activeKey]?.status;
      const grant = grants.get(activeKey);
      if (!st?.runtime) { get().note("no controllable runtime for this session (file mirror / owner offline)"); return; }
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
      try {
        const out = await api.post<{ state?: string; operationId?: string }>(
          `/api/v1/sessions/${encodeURIComponent(activeKey)}/commands`, envelope, opId);
        set({ lastOperation: { id: opId, state: out.state ?? "accepted" } });
        setTimeout(() => { void get().refreshStatus(); }, 1200);
      } catch (e) {
        const err = e as ApiError;
        if (err.code === "stale_control" || err.code === "forbidden") {
          // one transparent re-acquire + retry (control lost to renewal race or new epoch)
          const ok = await get().acquireControl(activeKey);
          if (ok) {
            try {
              const g = grants.get(activeKey)!;
              const out = await api.post<{ state?: string }>(`/api/v1/sessions/${encodeURIComponent(activeKey)}/commands`,
                { ...envelope, operationId: opId, controlEpoch: g.epoch, controlSecret: g.secret }, opId);
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
      const { activeKey } = get();
      if (!activeKey) return;
      const payload: Record<string, unknown> = { type: "dialogResponse", requestId: d.requestId, requestGeneration: d.requestGeneration };
      if (cancel) payload.cancelled = true;
      else if (d.kind === "confirm") payload.confirmed = !!value;
      else if (d.kind === "select") payload.value = value == null ? null : String(value);
      else payload.value = value == null ? null : String(value);
      await get().command(payload);
      patch(activeKey, (v) => ({ ...v, dialogs: v.dialogs.filter((x) => x.requestId !== d.requestId) }));
    },

    createSession: async (workspaceKey) => {
      try {
        const out = await api.post<{ sessionKey: string }>("/api/v1/sessions", { workspaceKey });
        await get().refreshSessions();
        return out.sessionKey;
      } catch (e) { get().note((e as ApiError).message); return null; }
    },

    note: (msg) => {
      const k = get().activeKey;
      patch(k, (v) => ({ ...v, notes: [...v.notes.slice(-4), msg] }));
      if (k) setTimeout(() => patch(k, (v) => ({ ...v, notes: v.notes.filter((n) => n !== msg) })), 8000);
    },

    refreshStatus: async () => {
      await get().refreshSessions().catch(() => undefined);
      const { activeKey } = get();
      if (!activeKey) return;
      attachSse(activeKey);
    },
  };
});

function applySseEvent(v: SessionView, name: string, payload: unknown): SessionView {
  const nv = { ...v };
  switch (name) {
    case "snapshot": {
      const s = payload as { entries?: EntryView[]; entryTotal?: number; runtimeState?: RuntimeState; status?: SessionStatusLite; pendingDialogs?: DialogRequest[]; observedDialogs?: DialogRequest[] };
      if (s.entries) { nv.entries = s.entries; nv.entryTotal = s.entryTotal ?? s.entries.length; }
      if (s.runtimeState) nv.runtime = s.runtimeState;
      if (s.status) nv.status = s.status;
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
      if (p.mappedEntryId) {
        // entry already persisted and merged: drop provisional preview
        if (nv.entries.some((e) => e.entryId === p.mappedEntryId)) {
          const { [p.liveMessageId]: _drop, ...rest } = nv.previews;
          nv.previews = rest;
        }
      }
      break;
    }
    case "toolState": {
      const t = payload as ToolStateView;
      nv.tools = { ...nv.tools, [t.toolCallId]: { ...(nv.tools[t.toolCallId] ?? {} as ToolStateView), ...t } };
      break;
    }
    case "runtimeState": {
      const r = payload as RuntimeState;
      nv.runtime = r;
      // runtime previews/tools lists are authoritative snapshots
      for (const p of r.previews ?? []) nv.previews = { ...nv.previews, [p.liveMessageId]: p };
      for (const t of r.tools ?? []) nv.tools = { ...nv.tools, [t.toolCallId]: { ...(nv.tools[t.toolCallId] ?? {} as ToolStateView), ...t } };
      // previews no longer in the owner's list were persisted or abandoned: drop them
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
    case "conflict": {
      nv.notes = [...nv.notes.slice(-4), `file conflict: ${(payload as { kind?: string })?.kind ?? "detected"} — showing file contents only`];
      break;
    }
    case "operationState": {
      const ops = (payload as { operations?: { state: string }[] }).operations ?? [];
      const failed = ops.filter((o) => o.state === "failed").length;
      if (failed) nv.notes = [...nv.notes.slice(-4), `${failed} operation(s) failed — see status`];
      break;
    }
    case "ownerChanged": {
      nv.notes = [...nv.notes.slice(-4), "owning runtime changed (bridge reconnected or host exited); refreshing view"];
      nv.status = null;
      break;
    }
    case "hostExited": {
      const p = payload as { reason?: string };
      nv.notes = [...nv.notes.slice(-4), `runtime exited (${p.reason ?? "unknown"}); session is now a file mirror`];
      break;
    }
    case "controlState": break;
    case "resync": {
      nv.notes = [...nv.notes.slice(-4), `stream resync (${(payload as { reason?: string })?.reason ?? "replay unavailable"})`];
      break;
    }
    default: break;
  }
  return nv;
}
