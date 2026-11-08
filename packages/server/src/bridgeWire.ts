/**
 * Bridge wiring: turns an accepted `BridgeConn` into a live session record and keeps the two in
 * step (bridge_plan 03 §4). Kept apart from `main.ts` so the adoption state machine is testable
 * without booting HTTP, and apart from `sessions.ts` so the registry stays transport-agnostic.
 *
 * The invariants that matter here:
 *  - identity is pi's `sessionId` (D-3), so a session that has no file yet is still adoptable;
 *  - one live runtime per session: a second claim on the same rec is refused, not merged;
 *  - `/new` produces a *new* row and retires the old one to mirror (03 §4.1) — the row you were
 *    reading never silently changes into a different conversation;
 *  - a dropped bridge never invents state: operations go `unknown`, the mode falls back to mirror.
 */
import type { BridgeDiagnose, RuntimeInfo } from "@piwebui/shared";
import type { BridgeConn, HelloFrame } from "./bridgeServer.ts";
import type { Operations } from "./operations.ts";
import type { SessionRec, Sessions } from "./sessions.ts";
import type { Store } from "./store.ts";
import { logInfo } from "./log.ts";

export interface BridgeWireOptions {
  sessions: Sessions;
  ops: Operations;
  store: Store;
  serverId: string;
  /** For diagnostics only: how the listener is configured. */
  listener: () => { mode: string; socketPath: string; listener: string; rejects: Record<string, number> };
  legacyCount?: () => number;
  versionGate?: () => BridgeDiagnose["versionGate"];
  descriptor?: () => { redacted: Record<string, unknown>; ageMs: number | null } | null;
  legacyInfo?: () => { dir: string; records: number; note: string };
}

export interface BridgeWireOptions {
  sessions: Sessions;
  ops: Operations;
  store: Store;
  serverId: string;
  /** For diagnostics only: how the listener is configured. */
  listener: () => { mode: string; socketPath: string; listener: string; rejects: Record<string, number> };
  legacyCount?: () => number;
}

export interface BridgeWire {
  onAttach: (conn: BridgeConn, hello: HelloFrame) => void;
  onAdvertise: (conn: BridgeConn, hello: HelloFrame) => void;
  onGone: (conn: BridgeConn, reason: "closed" | "timeout" | "revoked") => void;
  recFor: (runtimeId: string) => SessionRec | undefined;
  runtimes: () => RuntimeInfo[];
  diagnose: () => BridgeDiagnose;
  counts: () => { dial: number };
  /** Connections the server is currently holding open (for `/health`). */
  connections: () => BridgeConn[];
}

export function wireBridge(o: BridgeWireOptions): BridgeWire {
  const byRuntime = new Map<string, SessionRec>();

  // A retired owner's in-flight operations can never be confirmed: they go `unknown`, never retried.
  o.sessions.retireHook = (rec) => o.ops.ownerLost(rec.key);

  function claim(hello: HelloFrame) {
    return {
      runtimeId: hello.runtimeId,
      sessionId: hello.sessionId,
      sessionFile: hello.sessionFile ?? null,
      cwd: hello.cwd ?? null,
      piVersion: hello.piVersion,
      piMode: hello.piMode,
      sessionGeneration: hello.sessionGeneration,
      capabilities: hello.capabilities,
    };
  }

  function streamOwnerChanged(rec: SessionRec) {
    o.sessions.hub.emit(rec.key, "ownerChanged", { runtime: o.sessions.identity(rec), mode: o.sessions.mode(rec) });
    o.sessions.hub.emit(rec.key, "resync", { reason: "owner_attached" });
  }

  function pullSnapshot(rec: SessionRec, conn: BridgeConn): void {
    void conn.cmd("snapshot", {}, 8_000)
      .then((snap) => {
        o.sessions.mergeOwnerSnapshot(rec, snap as Record<string, unknown>);
        streamOwnerChanged(rec);
      })
      .catch((e) => {
        const msg = String((e as Error).message).slice(0, 120);
        conn.lastError = `snapshot: ${msg}`;
        logInfo("bridge_snapshot_failed", { runtimeId: conn.runtimeId.slice(0, 8), err: msg });
      });
  }

  function bind(conn: BridgeConn, rec: SessionRec): void {
    byRuntime.set(conn.runtimeId, rec);
    conn.onEvent((ev) => {
      const current = byRuntime.get(conn.runtimeId);
      if (!current || current.driver !== conn) return;
      if (ev.name === "session_start" && typeof ev.payload.sessionId === "string" && ev.payload.sessionId !== current.meta.piSessionId) {
        switchSession(conn, { ...(ev.payload as unknown as HelloFrame), sessionId: String(ev.payload.sessionId) } as HelloFrame);
        return;
      }
      o.sessions.applyDriverEvent(current, ev);
    });
    pullSnapshot(rec, conn);
  }

  /** The bridge announced a different pi session on the same connection (/new, /resume, /fork). */
  function switchSession(conn: BridgeConn, hello: HelloFrame): void {
    const old = byRuntime.get(conn.runtimeId);
    if (old && old.meta.piSessionId === hello.sessionId) {
      // Same session re-advertising (e.g. /reload): refresh facts, resync, keep the row.
      conn.sessionGeneration = hello.sessionGeneration ?? conn.sessionGeneration;
      o.sessions.hub.bumpGeneration(old.key);
      o.sessions.hub.emit(old.key, "resync", { reason: "owner_readvertised" });
      return;
    }
    if (old) {
      old.driver = null;
      o.sessions.retireBridge(old, "owner_switched");
    }
    const { rec } = o.sessions.adoptBridge(conn, claim(hello));
    if (!rec.driver) return; // refused: another runtime owns it after all
    bind(conn, rec);
    o.sessions.emitGlobal("runtimeAttached", {
      runtimeId: conn.runtimeId, pid: conn.pid, serverId: o.serverId,
      sessionId: hello.sessionId, sessionKey: rec.key, cwd: conn.cwd, piVersion: conn.piVersion,
    });
    pullSnapshot(rec, conn);
  }

  function onAttach(conn: BridgeConn, hello: HelloFrame): void {
    const { rec } = o.sessions.adoptBridge(conn, claim(hello));
    if (!rec.driver) return;
    bind(conn, rec);
    o.sessions.emitGlobal("runtimeAttached", {
      runtimeId: conn.runtimeId, pid: conn.pid, serverId: o.serverId,
      sessionId: hello.sessionId, sessionKey: rec.key, cwd: hello.cwd, piVersion: hello.piVersion,
    });
    o.sessions.emitGlobal("sessionAppeared", { sessionKey: rec.key, mode: o.sessions.mode(rec), cwd: rec.meta.cwd, piSessionId: hello.sessionId });
  }

  function onAdvertise(conn: BridgeConn, hello: HelloFrame): void {
    conn.capabilities = hello.capabilities ?? conn.capabilities;
    conn.piVersion = hello.piVersion || conn.piVersion;
    conn.cwd = hello.cwd ?? conn.cwd;
    switchSession(conn, hello);
  }

  function onGone(conn: BridgeConn, reason: string): void {
    const rec = byRuntime.get(conn.runtimeId);
    byRuntime.delete(conn.runtimeId);
    if (rec && rec.driver === conn) {
      rec.driver = null;
      o.sessions.retireBridge(rec, `bridge_${reason}`);
    }
    o.store.runtimeNoteError(conn.runtimeId, `gone: ${reason}`);
    o.sessions.emitGlobal("runtimeGone", { runtimeId: conn.runtimeId, pid: conn.pid, serverId: o.serverId, reason });
  }

  function runtimes(): RuntimeInfo[] {
    const out: RuntimeInfo[] = [];
    for (const [runtimeId, rec] of byRuntime) {
      const conn = rec.driver as BridgeConn | null;
      if (!conn || conn.runtimeId !== runtimeId) continue;
      out.push({
        runtimeId,
        transport: "dial",
        serverId: o.serverId,
        pid: conn.pid,
        procStart: conn.procStart,
        piVersion: conn.piVersion,
        piMode: conn.piMode ?? "tui",
        protocol: conn.protocol,
        adapterVersion: conn.adapterVersion ?? "unknown",
        cwd: conn.cwd,
        runtimeGeneration: conn.generation,
        sessionGeneration: conn.sessionGeneration,
        lastSeq: conn.lastSeq,
        sessions: [{ key: rec.key, piSessionId: rec.meta.piSessionId, mode: o.sessions.mode(rec) }],
        capabilities: conn.capabilities,
        lastError: conn.lastError,
        dropped: { ...conn.dropped, throttled: 0 },
        attested: !!conn.attested,
        trusted: !!conn.trusted,
        connectedAt: conn.connectedAt,
      });
    }
    return out;
  }

  function diagnose(): BridgeDiagnose {
    const listener = o.listener();
    const all = [...o.sessions.byKey.values()];
    const desc = o.descriptor?.() ?? null;
    return {
      mode: listener.mode as BridgeDiagnose["mode"],
      listener: listener.listener,
      socketPath: listener.socketPath,
      descriptor: desc?.redacted ?? null,
      descriptorAgeMs: desc?.ageMs ?? null,
      tokenPresent: true,
      attestationRequired: true,
      counts: {
        dial: byRuntime.size,
        legacy: o.legacyCount?.() ?? 0,
        managed: o.sessions.managedCount(),
        mirrors: all.filter((r) => !r.driver && r.file.exists).length,
        rejected: Object.values(listener.rejects).reduce((a, b) => a + b, 0),
      },
      rejects: listener.rejects,
      versionGate: o.versionGate?.() ?? { serverPiVersion: o.sessions.piPkg.version, validated: [], allowedByConfig: [], verdict: "unknown" },
      sessions: all.map((rec) => ({
        key: rec.key,
        mode: o.sessions.mode(rec),
        piSessionId: rec.meta.piSessionId,
        path: rec.path,
        why: o.sessions.why(rec),
      })),
      legacy: o.legacyInfo?.() ?? { dir: "", records: 0, note: "legacy mode not enabled" },
    };
  }

  return {
    onAttach,
    onAdvertise,
    onGone,
    recFor: (runtimeId: string) => byRuntime.get(runtimeId),
    runtimes,
    diagnose,
    connections: () => [...byRuntime.keys()].map((id) => byRuntime.get(id)!.driver).filter(Boolean) as unknown as BridgeConn[],
    counts: () => ({ dial: byRuntime.size }),
  };
}
