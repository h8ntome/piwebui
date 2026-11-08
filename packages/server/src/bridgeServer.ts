/**
 * The accepting side of the bridge (bridge_plan 03 §2–§3): pi-web listens on one Unix socket,
 * terminal pis dial it.
 *
 * Every connection walks the same gate ladder before it can adopt a session, and every rejection
 * is counted with a machine-readable reason so `/api/v1/bridge/diagnose`, `/api/v1/runtimes` and
 * `pi-web doctor` can answer "why is my terminal a mirror?" in one sentence:
 *
 *   transport -> auth (token, constant time, 5 s) -> hello -> identity -> protocol
 *            -> attestation (pid really is a live pi started when it claims) -> trust
 *
 * A `BridgeConn` is a `Driver`, exactly like the legacy `BridgeHandle` and `ManagedHandle`, so the
 * whole command gauntlet (`commands.ts`) works unchanged on top of it.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import {
  BRIDGE_AUTH_TIMEOUT_MS,
  BRIDGE_INBOUND_BYTES,
  BRIDGE_MAX_CONNS,
  BRIDGE_MAX_FRAME_BYTES,
  BRIDGE_MAX_FRAMES_PER_SEC,
  BRIDGE_PROTOCOL,
  HEALTH_MAX_MISSES,
  HEALTH_PING_MS,
  type BridgeHelloFrame,
  type BridgeRejectReason,
  type Capabilities,
} from "@piwebui/shared";
import { logInfo, logWarn } from "./log.ts";
import { probeSocket } from "./descriptor.ts";
import { attestRuntime, type AttestProbe } from "./attest.ts";
import type { Driver, DriverEvent } from "./drivers.ts";
import type { BridgeRuntimeRow, Store } from "./store.ts";

export type BridgeMode = "dial" | "legacy" | "both" | "off";

/** Same frame contract as the extension's `hello`. */
export type HelloFrame = BridgeHelloFrame;

export interface BridgeServerOptions {
  dataDir: string;
  serverId: string;
  token: string;
  socketPath: string;
  /** `dial`/`both` start the listener; `legacy`/`off` leave it down (02 §7). */
  mode: BridgeMode;
  requireAttestation: boolean;
  autoTrust: boolean;
  /** Optional prefix allowlist for a bridge's cwd (03 §10.2). Empty/undefined = allow any. */
  allowCwd?: string[] | undefined;
  maxConns?: number | undefined;
  store?: Store | undefined;
  probe?: AttestProbe | undefined;
  helloDeadlineMs?: number | undefined;
  onAttach: (conn: BridgeConn, hello: HelloFrame) => void;
  /** A connection that was already accepted sent a second `hello` (session replacement). */
  onAdvertise?: (conn: BridgeConn, hello: HelloFrame) => void;
  onGone: (conn: BridgeConn, reason: "closed" | "timeout" | "revoked") => void;
}

/** Newline-delimited JSON framer with buffer and per-line ceilings. */
class FrameReader {
  private buf = "";
  overflow = false;
  feed(chunk: Buffer): (string | null)[] {
    this.buf += chunk.toString("utf8");
    if (this.buf.length > BRIDGE_INBOUND_BYTES) {
      this.overflow = true;
      return [];
    }
    const out: (string | null)[] = [];
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      // A single absurd line is fatal (a peer that cannot frame is not worth parsing).
      out.push(line.length > BRIDGE_MAX_FRAME_BYTES ? null : line);
    }
    return out;
  }
}

export class BridgeConn implements Driver {
  readonly kind = "bridge" as const;
  generation: number;
  runtimeId: string;
  pid: number;
  piVersion: string;
  sessionFile: string | null;
  cwd: string | null;
  capabilities: Capabilities;
  sessionId: string;
  sessionGeneration: number;
  piMode: string;
  adapterVersion: string;
  procStart: number;
  protocol: number;
  attested: boolean;
  trusted: boolean;
  lastSeq = 0;
  connectedAt = new Date().toISOString();
  dropped = { previews: 0, tools: 0 };
  /** Frames ignored by the seq fence (a replay that overlapped live delivery). */
  duplicates = 0;
  lastError: string | null = null;
  /** Why the connection ended, for the machine-readable reason in logs and `/runtimes`.
   * Declared on `Driver`'s narrower vocabulary by the bridge server when it maps this back. */
  deathReason: "closed" | "timeout" | "revoked" | "disposed" = "disposed";
  hello: HelloFrame;

  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private eventCbs: ((e: DriverEvent) => void)[] = [];
  private deadCb: ((reason: "exited" | "lost" | "disposed", code: number | null, signal: string | null) => void) | null = null;
  private missedPongs = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private dead = false;
  framesIn = 0;
  framesOut = 0;

  constructor(public socket: net.Socket, hello: HelloFrame, gen: number, public serverId: string) {
    this.hello = hello;
    this.generation = gen;
    this.runtimeId = hello.runtimeId;
    this.pid = hello.pid;
    this.procStart = hello.procStart;
    this.piVersion = hello.piVersion;
    this.piMode = hello.piMode;
    this.adapterVersion = hello.adapterVersion;
    this.sessionId = hello.sessionId;
    this.sessionGeneration = hello.sessionGeneration;
    this.sessionFile = hello.sessionFile;
    this.cwd = hello.cwd;
    this.capabilities = (hello.capabilities ?? {}) as Capabilities;
    this.protocol = hello.protocol;
    this.attested = false;
    this.trusted = true;
  }

  alive(): boolean {
    return !this.dead && this.socket.writable;
  }

  cmd<T = unknown>(cmd: string, args?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.dead) return Promise.reject(Object.assign(new Error("bridge disconnected"), { code: "host_unavailable" }));
    const id = crypto.randomBytes(8).toString("hex");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("bridge command timeout (outcome may be unknown)"), { code: "timeout" }));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.write({ t: "cmd", id, cmd, args: args ?? {}, sessionGeneration: this.sessionGeneration });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e as Error);
      }
    });
  }

  onEvent(cb: (e: DriverEvent) => void): () => void {
    this.eventCbs.push(cb);
    return () => { this.eventCbs = this.eventCbs.filter((c) => c !== cb); };
  }

  onDead(cb: (reason: "exited" | "lost" | "disposed", code: number | null, signal: string | null) => void): void {
    this.deadCb = cb;
  }

  write(frame: Record<string, unknown>): void {
    this.socket.write(`${JSON.stringify(frame)}\n`);
    this.framesOut++;
  }

  /** Sequence bookkeeping; returns false for a duplicate (a replay we already applied). */
  noteSeq(seq: number): boolean {
    if (!Number.isFinite(seq)) return true;
    if (seq <= this.lastSeq) return false;
    this.lastSeq = seq;
    return true;
  }

  /** Called by the server for each inbound frame it did not consume itself. */
  ingest(frame: Record<string, unknown>): void {
    if (frame.t === "hello") return; // handled by the server, not the driver stream
    if (frame.t === "res") {
      const p = this.pending.get(String(frame.id));
      if (!p) return;
      this.pending.delete(String(frame.id));
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.data);
      else p.reject(Object.assign(new Error(String((frame.error as { message?: string } | undefined)?.message ?? "bridge error")), { code: String((frame.error as { code?: string } | undefined)?.code ?? "internal") }));
      return;
    }
    if (frame.t === "pong") {
      this.missedPongs = 0;
      return;
    }
    if (frame.t === "ev") {
      this.framesIn++;
      const name = String(frame.name);
      const payload = (frame.payload ?? {}) as Record<string, unknown>;
      const seq = Number(frame.seq);
      if (!this.noteSeq(seq)) {
        this.duplicates++;
        return; // already applied (a replay that overlapped): the seq fence is the dedup
      }
      if (name === "session_start") {
        // Keep the fencing values in step with the runtime, or every later command would be
        // refused as stale after the terminal switched sessions.
        if (typeof payload.sessionGeneration === "number") this.sessionGeneration = payload.sessionGeneration;
        if (typeof payload.sessionId === "string" && payload.sessionId) this.sessionId = payload.sessionId;
        if (typeof payload.sessionFile === "string") this.sessionFile = payload.sessionFile;
      }
      for (const cb of this.eventCbs) {
        try { cb({ name, payload }); } catch { /* one bad handler must not kill the stream */ }
      }
      return;
    }
    if (frame.t === "diag") {
      const p = (frame.payload ?? {}) as Record<string, unknown>;
      this.dropped.previews = Number(p.droppedPreviews ?? this.dropped.previews);
      this.dropped.tools = Number(p.droppedTools ?? this.dropped.tools);
      return;
    }
    if (frame.t === "gap") {
      for (const cb of this.eventCbs) {
        try { cb({ name: "bridge_gap", payload: { fromSeq: Number(frame.fromSeq ?? 0), reason: String(frame.reason ?? "ring_evicted") } }); } catch { /* ignore */ }
      }
    }
  }

  startHealth(): void {
    this.pingTimer = setInterval(() => {
      if (this.dead) return;
      this.missedPongs++;
      if (this.missedPongs > HEALTH_MAX_MISSES) { this.die("timeout"); return; }
      try { this.write({ t: "ping", id: crypto.randomBytes(4).toString("hex"), lastSeenSeq: this.lastSeq }); }
      catch { this.die("timeout"); }
    }, HEALTH_PING_MS);
    this.pingTimer.unref?.();
  }

  requestReplay(fromSeq: number): void {
    try { this.write({ t: "replay", fromSeq }); } catch { /* dying */ }
  }

  /** Ask a bridge to re-read its descriptor (token rotation) and drop it shortly after. */
  requireReauth(): void {
    try { this.write({ t: "ev", seq: 0, name: "reauth_required", payload: { reason: "token_rotated" } }); } catch { /* ignore */ }
  }

  dispose(reason?: string): void {
    void reason;
    this.die("disposed");
  }

  /** Internal: the socket closed, timed out, or was revoked. */
  die(reason: "closed" | "timeout" | "revoked" | "disposed"): void {
    if (this.dead) return;
    this.dead = true;
    this.deathReason = reason;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(Object.assign(new Error("bridge disconnected"), { code: "host_unavailable" }));
    }
    this.pending.clear();
    try { this.socket.destroy(); } catch { /* ignore */ }
    this.deadCb?.(reason === "timeout" ? "lost" : reason === "closed" ? "lost" : "disposed", null, null);
  }
}

export interface BridgeServerStats {
  listener: "ok" | "disabled" | string;
  socketPath: string;
  mode: BridgeMode;
  dial: number;
  legacy: number;
  rejected: Record<string, number>;
  conns: { runtimeId: string; pid: number; sessionId: string; lastSeq: number; framesIn: number }[];
  descriptor: { serverId: string; socket: string } | null;
}

export class BridgeServer {
  readonly stats = { rejected: {} as Record<string, number> };
  private conns = new Map<string, BridgeConn>();
  /** runtimeId -> last seq, kept across reconnects so resume can pick up where we stopped. */
  private lastSeqByRuntime = new Map<string, number>();
  private genCounter = 0;
  private listener: net.Server | null = null;
  private listenerError: string | null = null;
  private started = false;
  /** Frames-per-second windows, one entry per live connection. */
  private rateWindows = new WeakMap<net.Socket, { since: number; count: number; strikes: number }>();

  constructor(private opts: BridgeServerOptions) {}

  get mode(): BridgeMode { return this.opts.mode; }
  get socketPath(): string { return this.opts.socketPath; }

  connectionCount(): number { return this.conns.size; }
  connections(): BridgeConn[] { return [...this.conns.values()]; }
  connectionFor(runtimeId: string): BridgeConn | undefined { return this.conns.get(runtimeId); }

  rejected(reason: string, n = 1): void {
    this.stats.rejected[reason] = (this.stats.rejected[reason] ?? 0) + n;
  }

  async listen(): Promise<{ ok: boolean; error?: string; reusedStale?: boolean }> {
    if (this.opts.mode === "off" || this.opts.mode === "legacy") return { ok: true };
    const sock = this.opts.socketPath;
    // Probe-then-unlink: a socket file that answers belongs to another live server and is never
    // stolen; one that answers nothing after its owner died is ours to replace (03 §2.3).
    try {
      if (await probeSocket(sock)) {
        const err = `another server already answers on ${sock}`;
        this.listenerError = err;
        return { ok: false, error: err };
      }
      if (fs.existsSync(sock)) {
        fs.unlinkSync(sock);
        logInfo("bridge_stale_socket_removed", { socket: sock, note: "no live server answered it" });
      }
    } catch { /* no file, no answer: bind it */ }
    return await new Promise((resolve) => {
      const server = net.createServer((socket) => this.onConnection(socket));
      server.on("error", (e) => {
        this.listenerError = e.message;
        logWarn("bridge_listener_error", { code: (e as NodeJS.ErrnoException).code ?? "error", err: e.message });
        if (!this.started) resolve({ ok: false, error: e.message });
      });
      try {
        server.listen(sock, () => {
          this.started = true;
          this.listener = server;
          try { fs.chmodSync(sock, 0o600); } catch { /* platform without chmod on sockets */ }
          logInfo("bridge_listener_listening", { socket: sock, serverId: this.opts.serverId });
          resolve({ ok: true });
        });
        server.unref?.();
      } catch (e) {
        this.listenerError = String((e as Error).message);
        resolve({ ok: false, error: this.listenerError });
      }
    });
  }

  close(): void {
    for (const c of this.conns.values()) c.die("disposed");
    this.conns.clear();
    try { this.listener?.close(); } catch { /* ignore */ }
    this.listener = null;
    this.started = false;
  }

  /** Revoke a runtime: drop it now and refuse it until it is trusted again. */
  revoke(runtimeId: string): boolean {
    const c = this.conns.get(runtimeId);
    if (!c) return false;
    this.opts.store?.runtimeSetTrusted(runtimeId, false);
    c.die("revoked");
    this.conns.delete(runtimeId);
    return true;
  }

  broadcastControl(name: string, payload: Record<string, unknown>): void {
    for (const c of this.conns.values()) {
      try { c.write({ t: "ev", seq: 0, name, payload }); } catch { /* dying */ }
    }
  }

  /* ------------------------------------------------------------ acceptance */

  private onConnection(socket: net.Socket): void {
    socket.on("error", () => socket.destroy());
    if (this.conns.size >= (this.opts.maxConns ?? BRIDGE_MAX_CONNS)) {
      this.reject(socket, "too_many_conns", "connection cap reached");
      return;
    }
    const reader = new FrameReader();
    let authed = false;
    let conn: BridgeConn | null = null;
    const deadline = setTimeout(() => {
      this.reject(socket, authed ? "missing_hello" : "auth_timeout", authed ? "hello never arrived" : "no auth frame in time");
    }, this.opts.helloDeadlineMs ?? BRIDGE_AUTH_TIMEOUT_MS);
    deadline.unref?.();

    socket.on("data", (chunk: Buffer) => {
      for (const line of reader.feed(chunk)) {
        if (reader.overflow) { this.reject(socket, "buffer_overflow", "inbound buffer exceeded"); return; }
        if (line === null) { this.reject(socket, "frame_too_large", "frame exceeded the per-line cap"); return; }
        let frame: Record<string, unknown>;
        try { frame = JSON.parse(line) as Record<string, unknown>; } catch { this.reject(socket, "bad_frame", "invalid JSON"); return; }
        if (!frame || typeof frame !== "object") { this.reject(socket, "bad_frame", "frame is not an object"); return; }

        if (!authed) {
          if (frame.t !== "auth") { this.reject(socket, "unauthorized", "first frame must be auth"); return; }
          if (!constantTimeEquals(String(frame.token ?? ""), this.opts.token)) {
            this.reject(socket, "unauthorized", "token mismatch (wrong server? stale bridge.json?)");
            return;
          }
          authed = true;
          continue;
        }
        if (conn) {
          this.consume(conn, frame);
          continue;
        }
        if (frame.t === "hello") {
          const accepted = this.accept(socket, frame as unknown as HelloFrame);
          if (!accepted) return;
          conn = accepted;
          clearTimeout(deadline);
        } else {
          this.reject(socket, "missing_hello", `expected hello, got ${String(frame.t)}`);
          return;
        }
      }
    });
    socket.on("close", () => {
      clearTimeout(deadline);
      if (!conn) return;
      const existing = this.conns.get(conn.runtimeId);
      if (existing === conn) {
        this.conns.delete(conn.runtimeId);
        this.forgetLastSeq(conn);
        this.opts.onGone(conn, "closed");
      }
    });
  }

  private consume(conn: BridgeConn, frame: Record<string, unknown>): void {
    if (frame.t === "ping") { conn.ingest(frame); return; }
    if (frame.t === "hello") {
      // Re-advertisement on an established connection: the terminal switched sessions
      // (/new, /resume, /fork, /reload) without dropping the socket (D-4). Refresh the fencing
      // facts here, otherwise the next browser command is refused as stale.
      const h = frame as unknown as HelloFrame;
      conn.piVersion = h.piVersion || conn.piVersion;
      conn.cwd = h.cwd ?? conn.cwd;
      conn.capabilities = h.capabilities ?? conn.capabilities;
      conn.sessionId = h.sessionId || conn.sessionId;
      conn.sessionFile = h.sessionFile ?? conn.sessionFile;
      if (typeof h.sessionGeneration === "number") conn.sessionGeneration = h.sessionGeneration;
      this.opts.onAdvertise?.(conn, h);
      return;
    }
    // Rate accounting: 20/s is the documented soft expectation (a coalesced stream is ~25/s,
    // so shedding there would break real turns); only an absurd sustained rate gets shed.
    const w = this.rateWindows.get(conn.socket) ?? { since: Date.now(), count: 0, strikes: 0 };
    w.count++;
    if (Date.now() - w.since > 1000) {
      if (w.count > BRIDGE_MAX_FRAMES_PER_SEC * 10) w.strikes++;
      else w.strikes = 0;
      w.since = Date.now();
      w.count = 0;
      if (w.strikes >= 3) {
        this.rejected("throttled");
        logWarn("bridge_conn_rejected", { reason: "throttled", runtimeId: conn.runtimeId });
        conn.die("timeout");
        this.conns.delete(conn.runtimeId);
        this.opts.onGone(conn, "timeout");
        return;
      }
    }
    this.rateWindows.set(conn.socket, w);
    conn.ingest(frame);
  }

  private accept(socket: net.Socket, hello: HelloFrame): BridgeConn | null {
    const fail = (reason: BridgeRejectReason, message: string): null => {
      this.rejected(reason);
      logWarn("bridge_conn_rejected", { reason, claimed: `${hello.pid}/${String(hello.runtimeId).slice(0, 8)}`, detail: message.slice(0, 160) });
      try {
        socket.write(`${JSON.stringify({ t: "auth_error", code: reason, message })}\n`);
      } catch { /* ignore */ }
      socket.destroy();
      return null;
    };
    if (typeof hello.runtimeId !== "string" || !hello.runtimeId) return fail("bad_frame", "hello without runtimeId");
    if (typeof hello.sessionId !== "string" || !hello.sessionId) return fail("bad_frame", "hello without sessionId");
    if (!(hello.minProtocol ?? 1) || !(BRIDGE_PROTOCOL >= (hello.minProtocol ?? 1) && BRIDGE_PROTOCOL <= (hello.protocol ?? 0))) {
      return fail("unsupported_protocol", `bridge speaks ${hello.minProtocol ?? "?"}..${hello.protocol ?? "?"}, server speaks ${BRIDGE_PROTOCOL}`);
    }
    if (!(hello.capabilities && typeof hello.capabilities === "object")) return fail("bad_frame", "hello without capabilities");

    const prior = this.conns.get(hello.runtimeId);
    if (prior) {
      // Double load (`-e` *and* the installed package) must not create two runtimes in one pid;
      // a different procStart means the pid was recycled, which is a genuinely new runtime.
      if (prior.procStart === hello.procStart) return fail("duplicate_runtime", `a connection for runtime ${hello.runtimeId.slice(0, 8)} at pid ${hello.pid} is already live`);
      prior.die("disposed");
      this.conns.delete(hello.runtimeId);
      this.opts.onGone(prior, "closed");
    }

    if (this.opts.allowCwd?.length) {
      const cwd = String(hello.cwd ?? "");
      if (!this.opts.allowCwd.some((p) => cwd === p || cwd.startsWith(p.endsWith("/") ? p : `${p}/`))) {
        return fail("cwd_denied", `cwd ${cwd} is outside bridge.allowCwd`);
      }
    }

    const att = attestRuntime({ pid: hello.pid, procStart: hello.procStart }, { require: true, probe: this.opts.probe });
    if (!att.ok) {
      if (this.opts.requireAttestation) {
        logWarn("bridge_attest_failed", { claimed: `${hello.pid}:${hello.procStart}`, found: `${att.found?.pidAlive ? "alive" : "dead"} ${att.found?.startMs ?? "?"}`, reason: att.reason ?? "unknown" });
        return fail("attest_failed", att.reason ?? "attestation failed");
      }
      // --no-attest: accept on token + file modes alone, but never pretend it was attested.
      logWarn("bridge_attest_skipped", { pid: hello.pid, reason: att.reason ?? "unknown", note: "accepted without attestation (--no-attest)" });
    }
    if (att.ok && att.method === "none") logWarn("bridge_attest_degraded", { pid: hello.pid, note: "process start time unavailable; trusting token + file modes" });

    const row = this.opts.store?.runtimeGet(hello.runtimeId);
    if (row && !row.trusted) return fail("untrusted_runtime", "revoked with pi-web revoke-runtime (or autoTrust=false)");
    if (!row && !this.opts.autoTrust) return fail("untrusted_runtime", "run `pi-web trust-runtime <runtimeId>` first (bridge.autoTrust=false)");

    const conn = new BridgeConn(socket, hello, ++this.genCounter, this.opts.serverId);
    conn.attested = att.ok && att.method !== "none";
    conn.trusted = true;
    conn.lastSeq = this.lastSeqByRuntime.get(hello.runtimeId) ?? (Number(row?.last_seq ?? 0) || 0);
    const resumedFrom = conn.lastSeq || null;
    try {
      conn.write({
        t: "auth_ok",
        serverId: this.opts.serverId,
        protocol: BRIDGE_PROTOCOL,
        minProtocol: BRIDGE_PROTOCOL,
        resumedFrom,
      });
    } catch (e) {
      return fail("bad_frame", `cannot write auth_ok: ${(e as Error).message}`);
    }
    conn.startHealth();
    this.conns.set(conn.runtimeId, conn);
    this.opts.store?.runtimeUpsert({
      runtime_id: conn.runtimeId,
      server_id: this.opts.serverId,
      pid: conn.pid,
      proc_start: conn.procStart,
      cwd: conn.cwd,
      pi_version: conn.piVersion,
      protocol: conn.protocol,
      adapter_version: conn.adapterVersion,
      trusted: 1,
    });
    logInfo("bridge_conn_accepted", { runtimeId: conn.runtimeId.slice(0, 8), pid: conn.pid, pi: conn.piVersion, mode: conn.piMode, gen: conn.generation });
    logInfo("bridge_runtime_attached", { runtimeId: conn.runtimeId.slice(0, 8), pid: conn.pid, piVersion: conn.piVersion });
    conn.onDead(() => {
      if (this.conns.get(conn.runtimeId) === conn) this.conns.delete(conn.runtimeId);
      this.forgetLastSeq(conn);
      logInfo("bridge_runtime_gone", { runtimeId: conn.runtimeId.slice(0, 8), reason: conn.deathReason });
      this.opts.onGone(conn, conn.deathReason === "revoked" ? "revoked" : conn.deathReason === "timeout" ? "timeout" : "closed");
    });
    this.opts.onAttach(conn, hello);
    return conn;
  }

  private forgetLastSeq(conn: BridgeConn): void {
    this.lastSeqByRuntime.set(conn.runtimeId, conn.lastSeq);
    this.opts.store?.runtimeNoteSeq(conn.runtimeId, conn.lastSeq);
  }

  private reject(socket: net.Socket, reason: BridgeRejectReason | string, message: string): void {
    this.rejected(String(reason));
    logWarn("bridge_conn_rejected", { reason, detail: message.slice(0, 160) });
    try { socket.write(`${JSON.stringify({ t: "auth_error", code: reason, message })}\n`); } catch { /* ignore */ }
    socket.destroy();
  }

  statsSnapshot(descriptor: { serverId: string; socket: string } | null, legacyCount: number): BridgeServerStats {
    return {
      listener: this.listenerError ? this.listenerError : this.started ? "ok" : this.opts.mode === "off" || this.opts.mode === "legacy" ? "disabled" : "not started",
      socketPath: this.opts.socketPath,
      mode: this.opts.mode,
      dial: this.conns.size,
      legacy: legacyCount,
      rejected: { ...this.stats.rejected },
      conns: this.connections().map((c) => ({ runtimeId: c.runtimeId, pid: c.pid, sessionId: c.sessionId, lastSeq: c.lastSeq, framesIn: c.framesIn })),
      descriptor: descriptor ? { serverId: descriptor.serverId, socket: descriptor.socket } : null,
    };
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}
