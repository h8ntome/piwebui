/**
 * Session registry + per-session server state.
 *
 * Invariants (plan rules 1–3):
 *  - Exactly one live runtime per canonical session file. Bridge sessions never get an
 *    SDK host; managed sessions hold a path reservation for their whole life.
 *  - File mirrors show PERSISTED records only. Live previews/queues/dialogs/current leaf
 *    come from the owner; when there is no owner they are explicitly unavailable.
 *  - Browser control grants fence web clients only — never the terminal.
 */
import fs from "node:fs";
import path from "node:path";
import {
  ENTRIES_PAGE_DEFAULT,
  MAX_MANAGED_RUNTIMES,
  MAX_OBSERVED_DIALOGS,
  SNAPSHOT_ENTRY_PAGE,
  SETTLED_HOST_CLEANUP_MS,
  TESTED_PI_VERSIONS,
  isPiVersionAllowed,
  type Capabilities,
  type ConflictInfo,
  type ControlState,
  type DialogRequest,
  type EntryPage,
  type EntryView,
  type PreviewState,
  type QueueState,
  type RunPhase,
  type RuntimeIdentity,
  type RuntimeStatePayload,
  type SessionMeta,
  type SessionMode,
  type SessionStatus,
  type SnapshotPayload,
  type ToolStateView,
  type WorkspaceInfo,
} from "@piwebui/shared";
import { Store } from "./store.ts";
import { type Config } from "./auth.ts";
import { ReadClient } from "./readClient.ts";
import { StreamHub } from "./hub.ts";
import type { Driver } from "./drivers.ts";
import { LfFramer, decodeRecord, classifyChange, type FileIdentity } from "@piwebui/pi-adapter/tail";
import { logInfo, logWarn } from "./log.ts";
import crypto from "node:crypto";

/**
 * Structural view of a dial-mode bridge connection, so `sessions.ts` does not import the
 * accepting transport module (and can be tested with a stub driver).
 */
export interface BridgeLike extends Driver {
  sessionId: string;
  sessionGeneration: number;
  piMode?: string;
  adapterVersion?: string;
  procStart?: number;
  attested?: boolean;
}

/** Claims a bridge makes about the session it owns (subset of the `hello` frame). */
export interface BridgeClaim {
  runtimeId: string;
  sessionId: string;
  sessionFile: string | null;
  cwd: string | null;
  piVersion?: string;
  piMode?: string;
  sessionGeneration?: number;
  capabilities?: Capabilities;
}

/** Hub key carrying machine-wide facts instead of one session's stream (03 §5). */
export const GLOBAL_STREAM_KEY = "*";

/** Stable session key for a pi session UUID: the same terminal session always maps here. */
export function keyForSessionId(sessionId: string): string {
  return "s_" + crypto.createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
}

export interface SessionRec {
  key: string;
  kind: "managed" | "bridged" | "discovered";
  path: string | null;
  workspaceKey: string | null;
  createdAt: string;
  meta: SessionMeta;
  driver: Driver | null;
  sessionGeneration: number;
  state: {
    phase: RunPhase;
    stateRevision: number;
    previews: Map<string, PreviewState>;
    tools: Map<string, ToolStateView>;
    queue: QueueState;
    dialogs: Map<string, DialogRequest>;
    observedDialogs: DialogRequest[];
    model: RuntimeIdentity["model"];
    thinkingLevel: string | null;
    sessionName: string | null;
    contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
    leaf: string | null;
    lastSettled: { at: string; aborted: boolean } | null;
    retry: { active: boolean; reason?: string } | null;
    compaction: { active: boolean; reason?: string } | null;
    entryCount: number | null;
  };
  file: {
    genId: string | null;
    exists: boolean;
    offset: number;
    identity: FileIdentity | null;
    fingerprint: string | null;
    recentEntries: EntryView[];
    recentIds: Set<string>;
    lastError: string | null;
    framer: LfFramer | null;
  };
  conflict: ConflictInfo | null;
  watch: { timer?: NodeJS.Timeout; watcher?: fs.FSWatcher };
  cleanupTimer?: NodeJS.Timeout;
  released: boolean;
}

/** Allowlist rows historically stored the absolute path as the label; show a name instead. */
function displayLabel(p: string, label?: string | null): string {
  const t = (label ?? "").trim();
  if (!t || t === p) return path.basename(p) || p;
  return t;
}

export class Sessions {
  byKey = new Map<string, SessionRec>();
  byPath = new Map<string, SessionRec>();
  /** pi session UUID -> rec (D-3): the identity that exists before the file does. */
  bySessionId = new Map<string, SessionRec>();
  workspaces = new Map<string, WorkspaceInfo>();
  /** Paths the user deleted (lazily loaded, see `isHidden`). */
  private hidden = new Set<string>();
  private hiddenLoaded = false;
  /** Machine-wide bridge facts, reported by `/api/v1/bridge/diagnose`. */
  bridgeDiag: { mode: string; listener: string; rejects: Record<string, number> } | null = null;

  constructor(
    public cfg: Config,
    public store: Store,
    public hub: StreamHub,
    public read: ReadClient,
    public serverTokenProvider: () => string,
    public piPkg: { version: string | null; path: string | null },
  ) {
    void this.serverTokenProvider;
  }

  /* ---------------- workspaces ---------------- */
  loadWorkspaces() {
    this.workspaces.clear();
    const rows = this.store.db.prepare("SELECT key,path,label,added_at FROM workspaces").all() as { key: string; path: string; label: string; added_at: string }[];
    for (const r of rows) this.workspaces.set(r.key, { workspaceKey: r.key, path: r.path, label: displayLabel(r.path, r.label), addedAt: r.added_at });
  }
  /**
   * Re-read the allowlist from SQLite. `pi-web allow <dir>` writes to the same database the
   * running server holds open, so without this the CLI silently had no effect until a restart.
   * Cheap (one small table scan) and called on the list endpoints, which are the only places
   * a newly allowed folder has to show up.
   */
  reloadWorkspaces() {
    try { this.loadWorkspaces(); } catch { /* keep the in-memory view if the db is busy */ }
  }
  addWorkspace(canonPath: string, label?: string): WorkspaceInfo {
    const key = "w_" + crypto.randomBytes(6).toString("hex");
    const info: WorkspaceInfo = { workspaceKey: key, path: canonPath, label: label?.trim() || path.basename(canonPath), addedAt: new Date().toISOString() };
    this.store.db.prepare("INSERT INTO workspaces(key,path,label,added_at) VALUES(?,?,?,?) ON CONFLICT(path) DO NOTHING").run(key, canonPath, info.label, info.addedAt);
    const existing = this.store.db.prepare("SELECT key FROM workspaces WHERE path=?").get(canonPath) as { key: string } | undefined;
    info.workspaceKey = existing?.key ?? key;
    this.workspaces.set(info.workspaceKey, info);
    return info;
  }
  removeWorkspace(key: string): boolean {
    const w = this.workspaces.get(key);
    if (!w) return false;
    this.store.db.prepare("DELETE FROM workspaces WHERE key=?").run(key);
    this.workspaces.delete(key);
    for (const rec of this.byKey.values()) if (rec.workspaceKey === key) {
      rec.workspaceKey = null;
      if (rec.kind !== "managed") {
        rec.conflict = { kind: "unknown", observedAt: new Date().toISOString(), detail: `Workspace removed from the allowlist: its files are no longer readable here (${w.path}). Re-add the folder to read this session again; ongoing runs were untouched.` };
      } else if (rec.driver) {
        // Still running, still promptable, but its transcript is behind the fence now: say so in
        // the status instead of letting the UI discover a bare 403 (BUG-014).
        rec.conflict = { kind: "unknown", observedAt: new Date().toISOString(), detail: `The workspace that owned this session (${w.path}) was removed from the allowlist. The run keeps going, but its file is not readable until the folder is allowed again.` };
      }
    }
    return true;
  }

  /** Roots the read worker may see: <agentDir>/sessions + extra configured roots + session dirs of workspaces. */
  sessionRoots(): string[] {
    const roots: string[] = [];
    const agentDir = this.cfg.agentDir ?? path.join(process.env.PI_CODING_AGENT_DIR || path.join(process.env.HOME ?? "", ".pi", "agent"));
    const def = path.join(agentDir, "sessions");
    if (fs.existsSync(def)) roots.push(def);
    roots.push(...this.cfg.sessionRootsExtra.filter((r) => fs.existsSync(r)));
    // An attested bridged pi may live under --session-dir or another PI_CODING_AGENT_DIR; without
    // its directory the read worker would list the session but fail to page it (03 §4).
    if (this.trustBridgeDirs()) {
      for (const rec of this.byKey.values()) {
        if (rec.kind === "bridged" && rec.driver && rec.path) {
          const dir = path.dirname(rec.path);
          if (fs.existsSync(dir)) roots.push(dir);
        }
      }
    }
    return [...new Set(roots)];
  }

  trustBridgeDirs(): boolean {
    return this.cfg.bridge?.trustSessionDirs !== false && process.env.PIWEB_BRIDGE_TRUST_SESSION_DIRS !== "0";
  }
  agentDir(): string {
    return this.cfg.agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "", ".pi", "agent");
  }

  workspaceForCwd(cwd: string): WorkspaceInfo | null {
    for (const w of this.workspaces.values()) {
      if (cwd === w.path || cwd.startsWith(w.path + path.sep)) return w;
    }
    return null;
  }

  /* ---------------- session records ---------------- */
  keyFor(canonPath: string): string {
    const row = this.store.db.prepare("SELECT key FROM sessions WHERE path=?").get(canonPath) as { key: string } | undefined;
    if (row) return row.key;
    const key = "s_" + crypto.randomBytes(8).toString("hex");
    this.store.db
      .prepare("INSERT INTO sessions(key,path,kind,workspace_key,created_at,updated_at,origin) VALUES(?,?,?,?,?,?,?)")
      .run(key, canonPath, "discovered", null, new Date().toISOString(), new Date().toISOString(), "file");
    return key;
  }

  ensureFromFile(canonPath: string): SessionRec {
    const existing = this.byPath.get(canonPath);
    if (existing) return existing;
    const key = this.keyFor(canonPath);
    const rec = this.blankRec(key, canonPath, "discovered");
    const ws = this.workspaceForCwd(this.headerCwd(canonPath) ?? "");
    rec.workspaceKey = ws?.workspaceKey ?? null;
    rec.meta.workspaceKey = rec.workspaceKey;
    this.attach(rec);
    return rec;
  }

  private headerCwd(canonPath: string): string | null {
    try {
      const fd = fs.openSync(canonPath, "r");
      try {
        const buf = Buffer.alloc(4096);
        const { bytesRead } = { bytesRead: fs.readSync(fd, buf, 0, 4096, 0) };
        const firstLine = buf.subarray(0, bytesRead).toString("utf8").split("\n")[0] ?? "";
        const h = JSON.parse(firstLine);
        return typeof h.cwd === "string" ? h.cwd : null;
      } finally { fs.closeSync(fd); }
    } catch { return null; }
  }

  blankRec(key: string, p: string | null, kind: SessionRec["kind"]): SessionRec {
    const now = new Date().toISOString();
    const rec: SessionRec = {
      key, kind, path: p, workspaceKey: null, createdAt: now,
      meta: { sessionKey: key, workspaceKey: null, path: p, piSessionId: null, cwd: null, name: null, created: null, modified: null, messageCount: null, firstPrompt: null, sizeBytes: null, version: null },
      driver: null,
      sessionGeneration: 1,
      state: {
        phase: "unknown", stateRevision: 0, previews: new Map(), tools: new Map(),
        queue: { hasPending: null, count: null, note: "No owner: queue state unavailable." },
        dialogs: new Map(), observedDialogs: [], model: null as RuntimeIdentity["model"], thinkingLevel: null, sessionName: null,
        contextUsage: null, leaf: null, lastSettled: null, retry: null, compaction: null, entryCount: null,
      },
      file: { genId: null, exists: false, offset: 0, identity: null, fingerprint: null, recentEntries: [], recentIds: new Set(), lastError: null, framer: null },
      conflict: null,
      watch: {},
      released: false,
    };
    return rec;
  }

  ensureFromFileNoWatch(canonPath: string): SessionRec {
    const existing = this.byPath.get(canonPath);
    if (existing) return existing;
    const key = this.keyFor(canonPath);
    const rec = this.blankRec(key, canonPath, "discovered");
    const ws = this.workspaceForCwd(this.headerCwd(canonPath) ?? "");
    rec.workspaceKey = ws?.workspaceKey ?? null;
    rec.meta.workspaceKey = rec.workspaceKey;
    this.byKey.set(rec.key, rec);
    this.byPath.set(canonPath, rec);
    void this.loadFileOnce(rec);
    return rec;
  }

  private async loadFileOnce(rec: SessionRec) {
    try {
      const page = await this.read.call<import("@piwebui/shared").EntryPage>("pageTail", { file: rec.path!, limit: 50 });
      rec.file.exists = true;
      rec.file.genId = page.fileGeneration;
      rec.state.entryCount = page.entryCount;
      rec.file.recentEntries = page.entries;
      for (const e of page.entries) rec.file.recentIds.add(e.entryId);
    } catch { rec.file.exists = false; }
  }

  ensureWatch(rec: SessionRec) {
    if (!rec.path || rec.watch.timer) return;
    const watched = [...this.byKey.values()].filter((r) => r.watch.timer).length;
    if (watched >= 8 && !rec.driver) return; // bounded mirror views; snapshots still work via cold reads
    this.startWatch(rec);
  }

  attach(rec: SessionRec) {
    this.byKey.set(rec.key, rec);
    if (rec.path) this.byPath.set(rec.path, rec);
    const sid = rec.meta.piSessionId;
    if (sid) {
      const holder = this.bySessionId.get(sid);
      if (!holder || holder.key === rec.key) this.bySessionId.set(sid, rec);
    }
  }

  /** Full unregister: maps + file watch. Used when a mirror twin is merged into a bridged rec. */
  forget(rec: SessionRec) {
    this.byKey.delete(rec.key);
    if (rec.path && this.byPath.get(rec.path) === rec) this.byPath.delete(rec.path);
    const sid = rec.meta.piSessionId;
    if (sid && this.bySessionId.get(sid) === rec) this.bySessionId.delete(sid);
    this.stopWatch(rec);
    this.hub.drop(rec.key);
  }

  /* ---------------- deletion ("forget this session in pi-web") ---------------- */

  /** Paths the user deleted; kept because pi-web never deletes the session file itself. */
  isHidden(p: string | null): boolean {
    if (!p) return false;
    if (!this.hiddenLoaded) {
      this.hiddenLoaded = true;
      try {
        this.hidden = new Set((this.store.db.prepare("SELECT path FROM hidden_sessions").all() as { path: string }[]).map((r) => r.path));
      } catch { this.hidden = new Set(); }
    }
    return this.hidden.has(p);
  }

  hiddenList(): { path: string; sessionKey: string | null; name: string | null; hiddenAt: string }[] {
    try {
      return (this.store.db.prepare("SELECT path,session_key,name,hidden_at FROM hidden_sessions ORDER BY hidden_at DESC").all() as Record<string, string | null>[])
        .map((r) => ({ path: String(r.path), sessionKey: r.session_key ?? null, name: r.name ?? null, hiddenAt: String(r.hidden_at) }));
    } catch { return []; }
  }

  unhide(p: string): boolean {
    const changed = this.store.db.prepare("DELETE FROM hidden_sessions WHERE path=?").run(p).changes > 0;
    this.hidden.delete(p);
    return changed;
  }

  /**
   * Retire a session from pi-web: stop the runtime we own, drop the registry row, and hide the
   * file so the next list refresh does not silently bring the row back. The session file on disk is
   * never touched. A live terminal (bridged) session is refused by the caller instead: disconnecting
   * someone else's running pi is not what "delete" should mean.
   */
  retire(rec: SessionRec, reason: string): { hidden: string | null } {
    const driver = rec.driver as unknown as ({ markIntentionalExit?: () => void; dispose?: (r: string) => void; kind?: string } | null);
    if (driver && driver.kind !== "bridge") {
      driver.markIntentionalExit?.();
      driver.dispose?.(reason);
    } else if (driver) {
      try { driver.dispose?.(reason); } catch { /* socket already gone */ }
    }
    rec.driver = null;
    rec.released = true;
    if (rec.path) {
      this.store.db.prepare("INSERT INTO hidden_sessions(path,session_key,name,hidden_at) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET session_key=excluded.session_key, name=excluded.name, hidden_at=excluded.hidden_at")
        .run(rec.path, rec.key, rec.meta.name ?? rec.meta.firstPrompt ?? null, new Date().toISOString());
      this.hidden.add(rec.path);
      this.store.db.prepare("DELETE FROM file_claims WHERE path=?").run(rec.path);
    }
    this.store.db.prepare("DELETE FROM sessions WHERE key=?").run(rec.key);
    this.store.db.prepare("DELETE FROM control_grants WHERE session_key=?").run(rec.key);
    this.store.db.prepare("DELETE FROM operations WHERE session_key=?").run(rec.key);
    this.forget(rec);
    this.emitGlobal("sessionRetired", { sessionKey: rec.key, reason });
    return { hidden: rec.path ?? null };
  }

  /** Machine-wide event (03 §5): `runtimeAttached`, `sessionAppeared`, ... */
  emitGlobal(name: Parameters<typeof this.hub.emit>[1], payload: unknown) {
    try { this.hub.emit(GLOBAL_STREAM_KEY, name, payload); } catch { /* the global stream never blocks adoption */ }
  }

  /** Persist a registry row for a session rec (idempotent; keeps `path` unique). */
  persistRec(rec: SessionRec) {
    const now = new Date().toISOString();
    try {
      if (rec.path) this.store.db.prepare("DELETE FROM sessions WHERE path=? AND key<>?").run(rec.path, rec.key);
      this.store.db
        .prepare(`INSERT INTO sessions(key,path,kind,workspace_key,created_at,updated_at,origin,pi_session_id)
          VALUES(?,?,?,?,?,?,?,?)
          ON CONFLICT(key) DO UPDATE SET path=excluded.path, kind=excluded.kind, workspace_key=excluded.workspace_key,
            updated_at=excluded.updated_at, pi_session_id=excluded.pi_session_id`)
        .run(rec.key, rec.path, rec.kind, rec.workspaceKey, rec.createdAt, now, rec.kind === "bridged" ? "bridge" : "file", rec.meta.piSessionId);
    } catch (e) {
      logWarn("session_persist_failed", { key: rec.key.slice(0, 10), err: String((e as Error).message).slice(0, 120) });
    }
  }

  /* ---------------- bridge adoption (D-3, 03 §4) ---------------- */

  /**
   * Make (or refresh) the session record a bridge connection owns.
   *
   * Identity order is pi `sessionId`, then path, then new: a fresh terminal session has no file
   * yet (pi pre-allocates the path), so a path-first lookup could never represent it (E6/B-6).
   */
  adoptBridge(conn: BridgeLike, claim: BridgeClaim): { rec: SessionRec; adopted: boolean } {
    const sessionId = claim.sessionId;
    const filePath = claim.sessionFile ? this.realpathSafe(claim.sessionFile) : null;
    const existingBySession = this.bySessionId.get(sessionId);
    const existingByPath = filePath ? this.byPath.get(filePath) : undefined;
    const twin = existingBySession ?? existingByPath;
    const rec = twin ?? this.blankRec(keyForSessionId(sessionId), filePath, "bridged");
    const wasNew = !this.byKey.has(rec.key);
    rec.kind = "bridged";
    rec.meta.piSessionId = sessionId;
    if (filePath) { rec.path = filePath; rec.meta.path = filePath; }
    if (claim.cwd) { rec.meta.cwd = claim.cwd; }
    if (!rec.workspaceKey) {
      const ws = this.workspaceForCwd(claim.cwd ?? "");
      if (ws) { rec.workspaceKey = ws.workspaceKey; rec.meta.workspaceKey = ws.workspaceKey; }
    }
    rec.sessionGeneration = claim.sessionGeneration ?? rec.sessionGeneration;
    if (rec.driver && rec.driver !== conn) {
      // One live runtime per session, whatever the transport (03 §4 "both").
      conn.dispose("duplicate owner refused");
      return { rec, adopted: false };
    }
    rec.driver = conn;
    conn.sessionId = sessionId;
    if (filePath) conn.sessionFile = filePath;
    this.attach(rec);
    this.bySessionId.set(sessionId, rec);
    this.persistRec(rec);
    // A mirror row may already exist for the same file (created by the file scan first): merge it.
    const otherTwin = existingBySession && existingByPath && existingBySession !== existingByPath ? existingByPath : null;
    this.mergeTwinInto(rec, otherTwin);
    if (rec.path) this.ensureWatch(rec);
    if (wasNew) {
      logInfo("bridge_session_adopted", { key: rec.key.slice(0, 10), piSessionId: sessionId.slice(0, 8), file: rec.path ? "yes" : "not yet on disk" });
      this.emitGlobal("sessionAppeared", { sessionKey: rec.key, mode: this.mode(rec), cwd: rec.meta.cwd, piSessionId: sessionId });
    }
    return { rec, adopted: wasNew };
  }

  /** Retire a session rec that its bridge switched away from: readable as a mirror, never hijacked. */
  retireBridge(rec: SessionRec, reason: string): void {
    if (rec.driver) rec.driver = null;
    rec.state.phase = "unknown";
    rec.state.previews.clear();
    rec.state.tools.clear();
    rec.state.dialogs.clear();
    if (rec.meta.piSessionId) {
      if (this.bySessionId.get(rec.meta.piSessionId) === rec) this.bySessionId.delete(rec.meta.piSessionId);
    }
    this.retireHook?.(rec, reason);
    this.hub.emit(rec.key, "ownerChanged", { runtime: null, mode: this.mode(rec) });
    this.hub.emit(rec.key, "resync", { reason });
    logInfo("bridge_session_retired", { key: rec.key.slice(0, 10), reason });
    this.emitGlobal("sessionRetired", { sessionKey: rec.key, mode: this.mode(rec), reason });
  }

  /**
   * When a mirror row and a bridged row describe the same conversation, keep the bridged one
   * (its key is what the browser is watching) and retire the mirror (E12's duplicate twin).
   */
  private mergeTwinInto(keep: SessionRec, other: SessionRec | null): void {
    if (!other || other === keep) return;
    if (other.driver) return; // never steal a live runtime
    this.retireBridge(other, "merged");
    this.forget(other);
    this.store.db.prepare("DELETE FROM sessions WHERE key=?").run(other.key);
    logInfo("bridge_twin_merged", { kept: keep.key.slice(0, 10), retired: other.key.slice(0, 10) });
  }

  /** Installed by the server wiring: in-flight operations of a retired owner become `unknown`. */
  retireHook?: (rec: SessionRec, reason: string) => void;

  /** Resolve a claimed session path without letting a symlink redirect adoption. */
  private realpathSafe(p: string): string | null {
    try { return fs.realpathSync(p); } catch { return p; }
  }

  mode(rec: SessionRec): SessionMode {
    if (!rec.driver) {
      // `file.exists` only turns true after the first tail read, so right after boot a session file
      // that plainly exists was listed as `history` ("no file") for a moment (BUG-034). Ask the
      // filesystem when that read has not happened yet, instead of claiming it is gone.
      return rec.file.exists || (rec.path ? fs.existsSync(rec.path) : false) ? "mirror" : "history";
    }
    return rec.kind === "managed" ? "managed" : "live";
  }

  sourceKind(rec: SessionRec): "file" | "runtime" | "none" {
    if (rec.driver) return "runtime";
    return rec.file.exists || (rec.path ? fs.existsSync(rec.path) : false) ? "file" : "none";
  }

  compat(rec: SessionRec): SessionStatus["compat"] {
    const v = rec.driver?.piVersion ?? this.piPkg.version ?? null;
    const tested = isPiVersionAllowed(v);
    const validated = TESTED_PI_VERSIONS.includes(v ?? "");
    if (tested && !validated) {
      return { piVersion: v, tested: true, detail: `pi ${v} is not in this build's validated list but was allowlisted with PIWEB_ALLOW_PI_VERSIONS` };
    }
    return {
      piVersion: v,
      tested,
      detail: tested
        ? `adapter validated for pi ${v}`
        : `pi ${v ?? "unknown"} is not validated by this pi-web build: writes are disabled (fail-closed), reads keep working. Override with PIWEB_ALLOW_PI_VERSIONS=${v ?? "<version>"}, or upgrade pi-web.`,
    };
  }

  /** One-sentence answer to "why is this session not controllable?" (D-8). */
  why(rec: SessionRec): string {
    if (rec.driver) {
      if (!this.compat(rec).tested) return `pi ${rec.driver.piVersion} not validated: writes disabled (override with PIWEB_ALLOW_PI_VERSIONS)`;
      return "";
    }
    if (rec.conflict) return `file conflict (${rec.conflict.kind}): writes frozen until the writers are sorted out`;
    if (!rec.path) return "no owning runtime and no file: this session is history only";
    if (!rec.file.exists) return "no bridge connected to the pi that owns this file";
    return "no bridge connected to the pi that owns this file";
  }

  identity(rec: SessionRec): RuntimeIdentity | null {
    const d = rec.driver;
    if (!d) return null;
    return {
      runtimeId: d.runtimeId, runtimeGeneration: d.generation, pid: d.pid, piVersion: d.piVersion,
      hostKind: d.kind === "managed" ? "managed" : "terminal",
      piMode: d.kind === "managed" ? "sdk" : "tui",
      sessionFile: d.sessionFile, sessionId: rec.meta.piSessionId, cwd: d.cwd,
      model: rec.state.model ?? null, thinkingLevel: rec.state.thinkingLevel, sessionName: rec.state.sessionName,
    };
  }

  /* ---------------- file watching (mirror) ---------------- */
  startWatch(rec: SessionRec) {
    if (!rec.path) return;
    if (rec.watch.timer) return;
    const tick = () => void this.pollFile(rec);
    rec.watch.timer = setInterval(tick, 500);
    rec.watch.timer.unref?.();
    try {
      const dir = path.dirname(rec.path);
      rec.watch.watcher = fs.watch(dir, (_ev, fname) => { if (fname === path.basename(rec.path!)) void this.pollFile(rec); });
      rec.watch.watcher.on("error", () => { /* stat poll continues */ });
    } catch { /* directory may not exist yet */ }
    void this.pollFile(rec);
  }
  stopWatch(rec: SessionRec) {
    if (rec.watch.timer) clearInterval(rec.watch.timer);
    rec.watch.watcher?.close();
    rec.watch = {};
  }

  async pollFile(rec: SessionRec) {
    if (!rec.path) return;
    let st: fs.Stats;
    try { st = fs.statSync(rec.path); } catch {
      if (rec.file.exists) {
        rec.file.exists = false; rec.file.genId = null; rec.file.offset = 0; rec.file.identity = null;
        this.hub.emit(rec.key, "resync", { reason: "file_vanished" });
      }
      return;
    }
    const identity: FileIdentity = { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
    const genId = `g${st.dev.toString(36)}-${st.ino.toString(36)}-${st.size.toString(36)}`;
    if (!rec.file.identity) {
      // cold: use read worker to index bounded tail
      rec.file.identity = identity; rec.file.exists = true;
      try {
        const page = await this.read.call<EntryPage>("pageTail", { file: rec.path, limit: SNAPSHOT_ENTRY_PAGE });
        rec.file.genId = page.fileGeneration;
        rec.file.offset = st.size;
        rec.file.recentEntries = page.entries;
        for (const e of page.entries) rec.file.recentIds.add(e.entryId);
        rec.file.fingerprint = page.nextCursor ?? null;
        rec.state.entryCount = page.entryCount;
        rec.file.exists = true;
        // The first read has to establish the same facts an append would: model_change and
        // thinking_level_change are the first entries of every session file, and skipping them left
        // a freshly created session showing "Select model" / "Model —" until its first run ended
        // (BUG-007).
        for (const e of page.entries) await this.applyEntryToState(rec, e);
        void this.refreshMeta(rec);
      } catch (e) {
        rec.file.lastError = String((e as Error).message).slice(0, 120);
      }
      return;
    }
    const same = identity.ino === rec.file.identity.ino && identity.dev === rec.file.identity.dev;
    if (!same || st.size < rec.file.offset) {
      // replaced or shrunk: invalidate everything, freeze unsafe mutations (F-11)
      if (!rec.released) {
        rec.conflict = {
          kind: same ? "shrink" : "file_replaced",
          observedAt: new Date().toISOString(),
          detail: same ? `file shrank (${st.size} < ${rec.file.offset})` : "file inode changed (replacement detected)",
        };
      }
      this.hub.emit(rec.key, "conflict", rec.conflict);
      this.hub.emit(rec.key, "resync", { reason: same ? "file_shrank" : "file_replaced" });
      rec.file.identity = identity;
      rec.file.genId = genId;
      rec.file.offset = 0;
      rec.file.recentEntries = [];
      rec.file.recentIds = new Set();
      rec.file.framer = null;
      this.hub.getStream(rec.key).bumpGeneration();
      void this.pollFileCold(rec);
      return;
    }
    if (st.size > rec.file.offset) await this.readAppend(rec, st.size);
    else rec.file.identity = identity;
  }

  private async pollFileCold(rec: SessionRec) {
    try {
      const page = await this.read.call<EntryPage>("pageTail", { file: rec.path!, limit: SNAPSHOT_ENTRY_PAGE });
      rec.file.genId = page.fileGeneration;
      rec.file.recentEntries = page.entries;
      rec.file.recentIds = new Set(page.entries.map((e) => e.entryId));
      rec.file.offset = (await fs.promises.stat(rec.path!)).size;
      rec.state.entryCount = page.entryCount;
      for (const e of page.entries) await this.applyEntryToState(rec, e); // see BUG-007 above
      void this.refreshMeta(rec);
    } catch { /* retry next tick */ }
  }

  async readAppend(rec: SessionRec, endSize: number) {
    if (!rec.path) return;
    const fh = await fs.promises.open(rec.path, "r");
    try {
      let pos = rec.file.offset;
      const buf = Buffer.allocUnsafe(64 * 1024);
      if (!rec.file.framer) rec.file.framer = new LfFramer(64 * 1024 * 1024, pos);
      while (pos < endSize) {
        const len = Math.min(buf.length, endSize - pos);
        const { bytesRead } = await fh.read(buf, 0, len, pos);
        if (bytesRead === 0) break;
        pos += bytesRead;
        for (const rec2 of rec.file.framer.feed(buf.subarray(0, bytesRead))) {
          const r = decodeRecord(rec2, 4 * 1024 * 1024);
          if (r.header) continue;
          if (r.diagnostic) { logWarn("tail_invalid_record", { key: rec.key.slice(0, 10), off: r.diagnostic.byteOffset }); continue; }
          if (!r.entry) continue;
          if (rec.file.recentIds.has(r.entry.entryId)) continue; // duplicate ids: RR-2 diagnostics not overwrite
          this.pushRecent(rec, r.entry);
          const replacesLive = this.findLiveMapping(rec, r.entry);
          this.hub.emit(rec.key, "entry", { fileGeneration: rec.file.genId ?? "", entry: r.entry, ...(replacesLive ? { replacesLiveMessageId: replacesLive } : {}) }, { entryId: r.entry.entryId, source: "file", replaceKey: replacesLive ? `preview:${replacesLive}` : undefined });
          rec.state.entryCount = (rec.state.entryCount ?? 0) + 1;
          rec.state.leaf = r.entry.entryId;
          void this.applyEntryToState(rec, r.entry);
        }
        if (rec.file.framer.overflow) {
          this.hub.emit(rec.key, "resync", { reason: "oversized_record" });
          rec.file.framer = null;
          break;
        }
      }
      rec.file.offset = pos;
      rec.file.genId = `g${rec.file.identity!.dev.toString(36)}-${rec.file.identity!.ino.toString(36)}-${pos.toString(36)}`;
      rec.file.exists = true;
      void this.refreshMetaLight(rec);
    } finally {
      await fh.close();
    }
  }

  private pushRecent(rec: SessionRec, e: EntryView) {
    rec.file.recentEntries.push(e);
    rec.file.recentIds.add(e.entryId);
    while (rec.file.recentEntries.length > 300) { const drop = rec.file.recentEntries.shift()!; rec.file.recentIds.delete(drop.entryId); }
  }

  private findLiveMapping(rec: SessionRec, entry: EntryView): string | undefined {
    for (const [id, p] of rec.state.previews) if (p.mappedEntryId === entry.entryId) return id;
    return undefined;
  }

  /** Track leaf/name/model facts from persisted entries (no guessing). */
  private async applyEntryToState(rec: SessionRec, entry: EntryView) {
    const raw = entry.raw as Record<string, unknown>;
    if (raw.type === "session_info" && typeof raw.name === "string") { rec.state.sessionName = raw.name; rec.meta.name = raw.name; }
    if (raw.type === "model_change") rec.state.model = { provider: String(raw.provider ?? ""), modelId: String(raw.modelId ?? "") };
    if (raw.type === "thinking_level_change") rec.state.thinkingLevel = String(raw.thinkingLevel ?? "");
    if (rec.driver) return;
    // mirror only: phase comes from file facts, honestly labeled
    if (raw.type === "message" && (raw.message as Record<string, unknown> | undefined)?.role === "assistant") {
      rec.state.phase = "idle";
    }
  }

  async refreshMeta(rec: SessionRec) {
    if (!rec.path) return;
    try {
      const summaries = await this.read.call<{ meta: SessionMeta }[]>("list", {});
      const hit = summaries.find((s) => s.meta.path === rec.path);
      if (hit) Object.assign(rec.meta, hit.meta, { sessionKey: rec.key, workspaceKey: rec.workspaceKey });
    } catch { /* meta stays stale */ }
  }
  async refreshMetaLight(rec: SessionRec) {
    try {
      const st = await fs.promises.stat(rec.path!);
      rec.meta.modified = new Date(st.mtimeMs).toISOString();
      rec.meta.sizeBytes = st.size;
    } catch { /* ignore */ }
  }

  /* ---------------- driver event application ---------------- */
  applyDriverEvent(rec: SessionRec, ev: { name: string; payload: Record<string, unknown> }) {
    const s = rec.state;
    const key = rec.key;
    const boundPreviews = () => {
      // A runtime that mints a preview per streamed chunk (or dies mid-stream) must not be able to
      // grow this map without bound: it is replayed in every snapshot, so the transcript would
      // accumulate ghost rows that never resolve (BUG-004). The managed host caps at 8; do the same
      // here so any bridge, old or new, is bounded from the server side too.
      while (s.previews.size > 8) {
        const oldest = s.previews.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        const drop = s.previews.get(oldest);
        if (!drop) { s.previews.delete(oldest); continue; }
        drop.done = true;
        this.hub.emit(key, "preview", drop, { liveMessageId: drop.liveMessageId, source: "runtime", replaceKey: `preview:${drop.liveMessageId}` });
        s.previews.delete(oldest);
      }
    };
    switch (ev.name) {
      case "message_start": {
        const id = String(ev.payload.liveMessageId);
        s.previews.set(id, { liveMessageId: id, role: (ev.payload.role as "user" | "assistant") ?? "assistant", rev: 0, blocks: [], startedAt: new Date().toISOString(), done: false });
        boundPreviews();
        this.hub.emit(key, "preview", s.previews.get(id), { liveMessageId: id, source: "runtime" });
        if (s.phase === "idle") { s.phase = "streaming"; this.hub.emit(key, "runtimeState", this.runtimePayload(rec)); }
        break;
      }
      case "message_update": {
        const p = ev.payload.preview as PreviewState;
        if (p) {
          s.previews.set(p.liveMessageId, p);
          boundPreviews();
          this.hub.emit(key, "preview", p, { liveMessageId: p.liveMessageId, source: "runtime", replaceKey: `preview:${p.liveMessageId}` });
        }
        break;
      }
      case "message_end": {
        const p = ev.payload.preview as PreviewState | null;
        if (p) { s.previews.set(p.liveMessageId, p); this.hub.emit(key, "preview", p, { liveMessageId: p.liveMessageId, source: "runtime", replaceKey: `preview:${p.liveMessageId}` }); }
        break;
      }
      case "turn_end": {
        const le = ev.payload.liveMessageId as string | undefined;
        const me = ev.payload.messageEntryId as string | undefined;
        if (le && me) {
          const p = s.previews.get(le);
          if (p) { p.mappedEntryId = me; p.done = true; }
        }
        // Anything still open after a turn boundary is finished business, not a live stream.
        for (const p of s.previews.values()) {
          if (!p.done && p.role === "assistant") { p.done = true; this.hub.emit(key, "preview", p, { liveMessageId: p.liveMessageId, source: "runtime", replaceKey: `preview:${p.liveMessageId}` }); }
        }
        this.hub.emit(key, "runtimeState", this.runtimePayload(rec));
        break;
      }
      case "tool_update": {
        const t = ev.payload.tool as ToolStateView;
        if (t) { s.tools.set(t.toolCallId, t); this.hub.emit(key, "toolState", t, { source: "runtime", replaceKey: `tool:${t.toolCallId}` }); }
        break;
      }
      case "queue_state": {
        s.queue = ev.payload.queue as QueueState;
        this.hub.emit(key, "queueState", s.queue);
        break;
      }
      case "agent_start": {
        s.phase = "streaming";
        this.hub.emit(key, "runtimeState", this.runtimePayload(rec));
        break;
      }
      case "agent_settled": {
        s.lastSettled = { at: new Date().toISOString(), aborted: !!ev.payload.aborted };
        s.phase = "idle";
        for (const p of s.previews.values()) p.done = true; // nothing can still be streaming
        this.onOperationLifecycle(rec, "agent_settled", { aborted: !!ev.payload.aborted });
        this.hub.emit(key, "runtimeState", this.runtimePayload(rec));
        this.scheduleSettledCleanup(rec);
        break;
      }
      case "run_completed": {
        this.onOperationLifecycle(rec, "run_completed", ev.payload);
        break;
      }
      case "compact_done": {
        this.onOperationLifecycle(rec, "compact_done", ev.payload);
        break;
      }
      case "compacted": {
        s.compaction = null;
        this.onOperationLifecycle(rec, "compacted", ev.payload);
        this.hub.emit(key, "runtimeState", this.runtimePayload(rec));
        break;
      }
      case "compact_failed": {
        s.compaction = null;
        this.onOperationLifecycle(rec, "compact_failed", ev.payload);
        break;
      }
      case "retry_state": {
        s.retry = ev.payload.active ? { active: true, reason: String(ev.payload.error ?? "") } : null;
        this.hub.emit(key, "runtimeState", this.runtimePayload(rec));
        break;
      }
      case "runtime_state_changed": {
        this.hub.emit(key, "runtimeState", this.runtimePayload(rec));
        break;
      }
      case "model_select": {
        s.model = (ev.payload.model as RuntimeIdentity["model"]) ?? s.model;
        this.hub.emit(key, "runtimeState", this.runtimePayload(rec));
        break;
      }
      case "thinking_level_select": {
        s.thinkingLevel = String(ev.payload.level ?? "");
        this.hub.emit(key, "runtimeState", this.runtimePayload(rec));
        break;
      }
      case "session_info_changed": {
        s.sessionName = (ev.payload.name as string | null) ?? null;
        rec.meta.name = s.sessionName;
        this.hub.emit(key, "runtimeState", this.runtimePayload(rec));
        break;
      }
      case "session_start": {
        rec.sessionGeneration++;
        this.hub.bumpGeneration(key);
        s.previews.clear(); s.tools.clear(); s.dialogs.clear(); s.observedDialogs = [];
        if (typeof ev.payload.sessionGeneration === "number") rec.sessionGeneration = Math.max(rec.sessionGeneration, Number(ev.payload.sessionGeneration));
        if (typeof ev.payload.sessionId === "string") this.bySessionId.set(String(ev.payload.sessionId), rec);
        if (typeof ev.payload.sessionFile === "string" && ev.payload.sessionFile && rec.path !== ev.payload.sessionFile) {
          const file = String(ev.payload.sessionFile);
          if (this.byPath.get(rec.path ?? "") === rec) this.byPath.delete(rec.path ?? "");
          rec.path = file;
          rec.meta.path = file;
          this.byPath.set(file, rec);
          this.persistRec(rec);
          this.ensureWatch(rec);
        }
        this.hub.emit(key, "resync", { reason: "session_generation_changed" });
        break;
      }
      case "session_tree": {
        if (ev.payload.newLeafId !== undefined) s.leaf = (ev.payload.newLeafId as string | null) ?? s.leaf;
        this.hub.emit(key, "runtimeState", this.runtimePayload(rec));
        break;
      }
      case "runtime_state": {
        // The bridge reports phase transitions it can see (compaction) that are not their own event.
        const phase = ev.payload.phase as RunPhase | undefined;
        if (phase) s.phase = phase;
        this.hub.emit(key, "runtimeState", this.runtimePayload(rec));
        break;
      }
      case "bridge_gap": {
        // The bridge's replay window could not cover us: the client must resnapshot, and the
        // only honest way to say that is the same resync a queue overflow uses.
        logWarn("bridge_replay_gap", { key: rec.key.slice(0, 10), from: String(ev.payload.fromSeq ?? 0) });
        this.hub.bumpGeneration(key);
        this.hub.emit(key, "resync", { reason: "bridge_replay_gap" });
        break;
      }
      case "diag": {
        this.hub.emit(key, "notice", { kind: "bridge_diag", level: "info", ...(ev.payload as object) });
        break;
      }
      case "dialog_request": {
        const d = ev.payload as unknown as DialogRequest;
        d.terminalObserved = false;
        d.answered = false;
        d.requestGeneration = d.requestGeneration ?? rec.sessionGeneration;
        s.dialogs.set(d.requestId, d);
        this.hub.emit(key, "dialogRequest", d);
        s.phase = "awaiting_dialog";
        break;
      }
      case "dialog_resolved": {
        const id = String(ev.payload.requestId);
        const d = s.dialogs.get(id);
        if (d) { d.answered = true; s.dialogs.delete(id); }
        this.hub.emit(key, "dialogResolved", { requestId: id, reason: ev.payload.reason ?? "answered" });
        if (s.phase === "awaiting_dialog") s.phase = "idle";
        break;
      }
      case "dialog_observed": {
        const d = {
          requestId: String(ev.payload.requestId), requestGeneration: Number(ev.payload.requestGeneration ?? rec.sessionGeneration),
          kind: (ev.payload.kind as DialogRequest["kind"]) ?? "confirm", title: String(ev.payload.title ?? ""),
          answered: false, terminalObserved: true, createdAt: new Date().toISOString(),
        } satisfies DialogRequest;
        s.observedDialogs.push(d);
        while (s.observedDialogs.length > 16) s.observedDialogs.shift();
        s.phase = "awaiting_dialog";
        this.hub.emit(key, "dialogRequest", d);
        break;
      }
      case "dialog_observed_end": {
        const t = ev.payload.title as string | undefined;
        const k = ev.payload.kind as string | undefined;
        const open = [...s.observedDialogs].reverse().find((d) => !d.answered && (!k || d.kind === k) && (!t || d.title === t));
        if (open) { open.answered = true; this.hub.emit(key, "dialogResolved", { requestId: open.requestId, reason: "answered_in_terminal" }); }
        if (s.phase === "awaiting_dialog" && ![...s.dialogs.values()].some((x) => !x.answered) && !s.observedDialogs.some((x) => !x.answered)) s.phase = "idle";
        break;
      }
      // Everything below used to be pushed as `event: unknown`, which the browser ignores: a
      // terminal extension that failed to bind, or a UI call the browser cannot render, vanished
      // without a trace (BUG-026). They are named `notice` frames now, and the client shows them.
      case "notify": this.hub.emit(key, "notice", { kind: "notify", level: "info", message: String(ev.payload.message ?? ev.payload.text ?? "Notice from the runtime"), ...ev.payload }); break;
      case "unsupported_ui":
        this.hub.emit(key, "notice", { kind: "unsupported_ui", level: "warn", message: `The terminal pi asked the browser for UI it cannot show (${String(ev.payload.method ?? "unknown method")})` });
        logWarn("unsupported_ui", { key: rec.key.slice(0, 10), method: String(ev.payload.method ?? "") });
        break;
      case "host_exiting": break;
      case "entry_appended": {
        const le = ev.payload.liveMessageId as string | undefined; void le;
        break;
      }
      case "extension_error":
        this.hub.emit(key, "notice", { kind: "extension_error", level: "error", message: `An extension in the owning pi failed: ${String(ev.payload.message ?? "")}`.slice(0, 400) });
        break;
      case "session_shutdown":
        this.hub.emit(key, "resync", { reason: "session_shutdown" });
        break;
      case "input_seen": break;
      case "host_exiting_done": break;
      default:
        // A runtime event this build has no mapping for is reported, not swallowed; the frame name
        // is a real one so a client can actually subscribe to it.
        this.hub.emit(key, "notice", { kind: "unmapped_event", level: "info", adapterEvent: ev.name, message: `Unhandled runtime event: ${ev.name}`, ...(ev.payload as object) });
        break;
    }
  }

  private onOperationLifecycle(_rec: SessionRec, _kind: string, _payload: Record<string, unknown>) {
    // Hook installed by Operations coordinator at wiring time.
    this.opHook?.(_rec, _kind, _payload);
  }
  opHook?: (rec: SessionRec, kind: string, payload: Record<string, unknown>) => void;

  runtimePayload(rec: SessionRec): RuntimeStatePayload {
    const s = rec.state;
    return {
      phase: rec.driver ? s.phase : "unavailable",
      stateRevision: s.stateRevision + ++this.revisionTick,
      isStreaming: s.phase === "streaming",
      previews: [...s.previews.values()],
      tools: [...s.tools.values()],
      queue: s.queue,
      model: s.model ?? null,
      thinkingLevel: s.thinkingLevel,
      sessionName: s.sessionName,
      contextUsage: s.contextUsage,
      leafEntryId: s.leaf,
      lastSettled: s.lastSettled,
      retry: s.retry,
      compaction: s.compaction,
    };
  }
  private revisionTick = 0;

  /* ---------------- snapshot composition ---------------- */
  async snapshot(rec: SessionRec, entryLimit = SNAPSHOT_ENTRY_PAGE): Promise<SnapshotPayload> {
    let ownerSnap: Record<string, unknown> | null = null;
    if (rec.driver?.alive() && this.compat(rec).tested) {
      try { ownerSnap = await rec.driver.cmd<Record<string, unknown>>("snapshot", {}, 8000); } catch { ownerSnap = null; }
    }
    if (ownerSnap) this.mergeOwnerSnapshot(rec, ownerSnap);
    let entries: EntryView[] = rec.file.recentEntries;
    let nextCursor: string | null = null;
    let diagnostics: { message: string; byteOffset: number }[] = [];
    let entryTotal = rec.state.entryCount ?? rec.file.recentEntries.length;
    if (rec.path && rec.file.exists) {
      try {
        const page = await this.read.call<EntryPage & { nextCursor: string | null; diagnostics?: { message: string; byteOffset: number }[] }>("pageTail", { file: rec.path, limit: entryLimit });
        entries = page.entries;
        entryTotal = page.entryCount;
        nextCursor = page.nextCursor;
        diagnostics = page.diagnostics ?? [];
      } catch { /* fall back to cached tail */ }
    }
    const status = this.status(rec);
    return {
      sessionKey: rec.key,
      meta: rec.meta,
      status,
      fileGeneration: rec.file.genId ?? "none",
      entries,
      nextEntriesCursor: nextCursor,
      entryTotal,
      // Truth about the window: a snapshot hands back the NEWEST entries, so anything the
      // client is missing sits *before* this page. The UI turns this into "load older".
      olderAvailable: entries.length > 0 && entries.length < entryTotal,
      diagnostics,
      runtimeState: rec.driver ? this.runtimePayload(rec) : null,
      pendingDialogs: [...rec.state.dialogs.values()].filter((d) => !d.answered),
      observedDialogs: rec.state.observedDialogs.filter((d) => !d.answered),
      barrier: { streamEpoch: 0, seq: 0 }, // filled by SSE route
    };
  }

  mergeOwnerSnapshot(rec: SessionRec, o: Record<string, unknown>) {
    const s = rec.state;
    s.phase = (o.phase as RunPhase) ?? s.phase;
    s.previews = new Map(((o.previews as PreviewState[]) ?? []).map((p) => [p.liveMessageId, p]));
    s.tools = new Map(((o.tools as ToolStateView[]) ?? []).map((t) => [t.toolCallId, t]));
    s.queue = (o.queue as QueueState) ?? s.queue;
    s.model = (o.model as RuntimeIdentity["model"]) ?? s.model;
    s.thinkingLevel = (o.thinkingLevel as string | null) ?? s.thinkingLevel;
    s.sessionName = (o.sessionName as string | null) ?? s.sessionName;
    s.contextUsage = (o.contextUsage as typeof s.contextUsage) ?? s.contextUsage;
    s.leaf = (o.leafEntryId as string | null) ?? s.leaf;
    s.lastSettled = (o.lastSettled as typeof s.lastSettled) ?? s.lastSettled;
    s.retry = (o.retry as typeof s.retry) ?? s.retry;
    s.compaction = (o.compaction as typeof s.compaction) ?? s.compaction;
    s.entryCount = (o.entryCount as number) ?? s.entryCount;
    if (Array.isArray(o.pendingDialogs)) {
      s.dialogs = new Map((o.pendingDialogs as DialogRequest[]).map((d) => [d.requestId, { ...d, terminalObserved: !!d.terminalObserved }]));
    }
    if (Array.isArray(o.observedDialogs)) s.observedDialogs = (o.observedDialogs as DialogRequest[]).slice(0, MAX_OBSERVED_DIALOGS);
    // Owner facts a bridge may have learned after the handshake (B-8: these used to be stale
    // forever because only the handshake filled them in).
    if (typeof o.sessionFile === "string" && o.sessionFile) {
      if (rec.path === null) rec.path = o.sessionFile;
      if (rec.meta.path !== o.sessionFile) {
        rec.meta.path = o.sessionFile;
        rec.path = o.sessionFile;
        this.byPath.set(o.sessionFile, rec);
        this.persistRec(rec);
        if (rec.driver) rec.driver.sessionFile = o.sessionFile;
      }
    }
    if (rec.kind === "managed" && typeof o.sessionFile === "string" && rec.meta.path !== o.sessionFile) {
      rec.meta.path = o.sessionFile; rec.path = o.sessionFile; this.byPath.set(o.sessionFile, rec);
      this.store.db.prepare("UPDATE sessions SET path=? WHERE key=?").run(o.sessionFile, rec.key);
    }
    if (typeof o.piVersion === "string" && rec.driver) rec.driver.piVersion = o.piVersion;
    if (o.capabilities && typeof o.capabilities === "object" && rec.driver) rec.driver.capabilities = o.capabilities as Capabilities;
    if (typeof o.sessionId === "string" && o.sessionId && rec.meta.piSessionId !== o.sessionId) {
      rec.meta.piSessionId = o.sessionId;
      this.bySessionId.set(o.sessionId, rec);
      this.persistRec(rec);
    }
    if (typeof o.cwd === "string" && rec.driver && !rec.driver.cwd) rec.driver.cwd = o.cwd;
    if (typeof o.stateRevision === "number") s.stateRevision = o.stateRevision;
  }

  /* ---------------- status ---------------- */
  status(rec: SessionRec, control: ControlState | null = null): SessionStatus {
    return {
      sessionKey: rec.key,
      mode: this.mode(rec),
      source: this.sourceKind(rec),
      driver: rec.driver ? (rec.kind === "managed" ? "managed" : "bridge") : "file",
      state: this.mode(rec) === "mirror" || this.mode(rec) === "history" ? "unavailable" : rec.state.phase,
      runtime: this.identity(rec),
      file: rec.path
        ? { path: rec.path, exists: rec.file.exists, sizeBytes: rec.meta.sizeBytes ?? null, modified: rec.meta.modified, generation: rec.file.genId }
        : null,
      fileGeneration: rec.file.genId ?? "none",
      sessionGeneration: rec.sessionGeneration,
      leaf: { entryId: rec.state.leaf ?? (rec.file.recentEntries.length ? rec.file.recentEntries[rec.file.recentEntries.length - 1]!.entryId : null), source: rec.state.leaf ? "runtime" : "file" },
      capabilities: this.capabilities(rec),
      compat: this.compat(rec),
      conflict: rec.conflict,
      control,
      pendingOperations: [],
    };
  }

  capabilities(rec: SessionRec): Capabilities {
    if (rec.driver && this.compat(rec).tested) return rec.driver.capabilities;
    const none: Capabilities = {
      snapshot: false, livePreview: false, liveTree: false, promptStart: false, promptSteer: false, promptFollowUp: false,
      abort: false, compact: false, setModel: false, setThinking: false, rename: false, modelsCatalog: false, commandList: false,
      queue: "none", clearQueue: false, dialogObserve: false, dialogRespond: false, stopForTerminal: false, contextUsage: false,
      runtimeContext: false, canControl: false,
      notes: rec.driver && !this.compat(rec).tested ? ["Pi version not validated: driver capabilities disabled (fail-closed)."] : ["No owning runtime: persisted file mirror only; runtime state is unavailable, not idle."],
    };
    return none;
  }

  managedCount(): number {
    let n = 0;
    for (const rec of this.byKey.values()) if (rec.kind === "managed" && rec.driver && !rec.released) n++;
    return n;
  }

  private scheduleSettledCleanup(rec: SessionRec) {
    if (rec.kind !== "managed" || !rec.driver) return;
    if (rec.cleanupTimer) clearTimeout(rec.cleanupTimer);
    rec.cleanupTimer = setTimeout(() => {
      try { this.runSettledCleanup(rec); } catch (err) { logWarn("settled_host_cleanup_failed", { key: rec.key.slice(0, 10), error: String(err) }); }
    }, SETTLED_HOST_CLEANUP_MS);
    rec.cleanupTimer.unref?.();
  }

  private runSettledCleanup(rec: SessionRec) {
    const s = rec.state;
    const quiet = s.phase === "idle" && !this.hub.getStream(rec.key).hasSubs()
      && s.dialogs.size === 0 && ((s.queue?.count ?? 0) === 0) && s.previews.size === 0;
    if (quiet && rec.driver) {
      logInfo("settled_host_cleanup", { key: rec.key.slice(0, 10) });
      const d = rec.driver;
      (d as unknown as { markIntentionalExit?: () => void }).markIntentionalExit?.();
      d.dispose("settled cleanup");
    }
  }

  hasCapacity(): boolean {
    const limit = Math.min(MAX_MANAGED_RUNTIMES, this.cfg.maxManaged);
    const NEVER_RUN_RECLAIM_GRACE_MS = 3 * 60_000;
    if (this.managedCount() < limit) return true;
    // At the limit. Before refusing, give back a slot held by a host that has never run and that
    // nobody is watching: an abandoned "New session" click used to hold one of the four slots
    // forever, and with no delete affordance the only exit was to find each row by hand (BUG-017).
    const victims = [...this.byKey.values()]
      .filter((r) => r.kind === "managed" && r.driver && !r.released
        && r.state.phase === "unknown"
        // A host that is still booting looks exactly like an abandoned one from here (unknown
        // phase, nothing streaming, nobody watching); evicting it produced a confusing
        // "host exited during boot" for a session its own client was waiting on. Only hosts that
        // finished the handshake, and had a chance to be used, are eligible.
        && r.driver.runtimeId !== "pending" && r.driver.pid > 0
        && Date.now() - Date.parse(r.createdAt) > NEVER_RUN_RECLAIM_GRACE_MS
        && r.state.previews.size === 0 && r.state.tools.size === 0 && r.state.dialogs.size === 0
        && !this.hub.getStream(r.key).hasSubs())
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const victim = victims[0];
    if (!victim) return false;
    logInfo("capacity_reclaimed_never_run", { key: victim.key.slice(0, 10), active: this.managedCount() });
    const d = victim.driver as unknown as { markIntentionalExit?: () => void; dispose: (r: string) => void };
    d.markIntentionalExit?.();
    d.dispose("capacity reclaim");
    victim.released = true;
    if (!victim.path) this.unregisterPhantom(victim);
    return this.managedCount() < limit;
  }

  /** A session that never produced a file leaves nothing behind; drop the row with the host. */
  private unregisterPhantom(rec: SessionRec) {
    if (rec.path) return;
    this.store.db.prepare("DELETE FROM sessions WHERE key=?").run(rec.key);
    this.store.db.prepare("DELETE FROM control_grants WHERE session_key=?").run(rec.key);
    this.store.db.prepare("DELETE FROM operations WHERE session_key=?").run(rec.key);
    this.forget(rec);
    this.emitGlobal("sessionRetired", { sessionKey: rec.key, reason: "capacity-reclaim" });
  }
}
