/**
 * Runtime drivers. One Pi runtime per canonical session file:
 *  - BridgeHandle: connects to an opt-in bridge inside a running terminal Pi (no second writer).
 *  - ManagedHandle: owns one forked Pi SDK child for one browser-created session.
 * Server-side runtime generations fence stale pages; they do NOT fence the terminal.
 */
import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DISPATCH_ACK_TIMEOUT_MS, HEALTH_MAX_MISSES, HEALTH_PING_MS, MAX_RECORD_BYTES, type Capabilities, type RuntimeIdentity } from "@piwebui/shared";
import { logInfo, logWarn } from "./log.ts";
import { resolveAdapterScript } from "./adapterPaths.ts";
import { LfFramer, decodeRecord } from "@piwebui/pi-adapter/tail";

export type DriverEvent = { name: string; payload: Record<string, unknown> };

export interface Driver {
  kind: "bridge" | "managed";
  runtimeId: string;
  generation: number;
  pid: number;
  piVersion: string;
  sessionFile: string | null;
  cwd: string | null;
  capabilities: Capabilities;
  alive(): boolean;
  cmd<T = unknown>(cmd: string, args?: unknown, timeoutMs?: number): Promise<T>;
  onEvent(cb: (e: DriverEvent) => void): () => void;
  onDead(cb: (reason: "exited" | "lost" | "disposed", code: number | null, signal: string | null) => void): void;
  dispose(reason?: string): void;
}

function frameLines(buffer: string): { lines: string[]; rest: string } {
  const idx = buffer.indexOf("\n");
  if (idx === -1) return { lines: [], rest: buffer };
  const lines = buffer.split("\n");
  const rest = lines.pop() ?? "";
  return { lines: lines.filter((l) => l.trim().length > 0), rest };
}

export class BridgeHandle implements Driver {
  kind = "bridge" as const;
  generation: number;
  runtimeId: string;
  pid = -1;
  piVersion = "unknown";
  sessionFile: string | null = null;
  cwd: string | null = null;
  capabilities!: Capabilities;
  private socket: net.Socket | null = null;
  private buf = "";
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private eventCbs: ((e: DriverEvent) => void)[] = [];
  private deadCb: ((reason: "exited" | "lost" | "disposed", code: number | null, signal: string | null) => void) | null = null;
  private missedPongs = 0;
  private pingTimer: NodeJS.Timeout | null = null;
  private dead = false;
  hello: Record<string, unknown> | null = null;

  private constructor(private record: { runtimeId: string; socketPath: string; pid: number; procStart: number }, gen: number, private token: string) {
    this.generation = gen;
    this.runtimeId = record.runtimeId;
  }

  static async connect(record: { runtimeId: string; socketPath: string; pid: number; procStart: number }, gen: number, token: string): Promise<BridgeHandle> {
    const h = new BridgeHandle(record, gen, token);
    await h.open();
    return h;
  }

  private open(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection({ path: this.record.socketPath });
      let authed = false;
      let settled = false;
      sock.setTimeout(5000);
      sock.on("connect", () => {
        sock.setTimeout(0);
        sock.write(JSON.stringify({ t: "auth", token: this.token, serverId: crypto.randomBytes(6).toString("hex") }) + "\n");
      });
      sock.on("data", (d: Buffer) => {
        this.buf += d.toString("utf8");
        if (this.buf.length > 16 * 1024 * 1024) { sock.destroy(); return; }
        const { lines, rest } = frameLines(this.buf);
        this.buf = rest;
        for (const line of lines) {
          let frame: any;
          try { frame = JSON.parse(line); } catch { continue; }
          if (!authed) {
            if (frame.t === "auth_ok") {
              authed = true;
              this.hello = frame.hello ?? null;
              const hi = frame.hello ?? {};
              this.pid = Number(hi.pid ?? this.record.pid);
              this.piVersion = String(hi.piVersion ?? "unknown");
              this.sessionFile = hi.sessionFile ?? null;
              this.cwd = hi.cwd ?? null;
              this.capabilities = (hi.capabilities ?? {}) as Capabilities;
              if (String(hi.runtimeId) !== this.record.runtimeId) { sock.destroy(); reject(new Error("runtime identity mismatch")); return; }
              if (Number(hi.pid) !== this.record.pid || Number(hi.procStart) !== this.record.procStart) {
                sock.destroy(); reject(new Error("process identity mismatch (stale registry record?)")); return;
              }
              this.socket = sock;
              this.startHealth();
              settled = true;
              resolve();
            } else if (frame.t === "res" && frame.id === "auth") {
              sock.destroy();
              settled = true;
              reject(new Error("bridge auth rejected"));
            }
            continue;
          }
          this.handleFrame(frame);
        }
      });
      sock.on("error", (e: Error) => {
        if (!settled) { settled = true; reject(e); }
        this.die("lost");
      });
      sock.on("close", () => { if (!settled) { settled = true; reject(new Error("socket closed")); } this.die("lost"); });
    });
  }

  private handleFrame(frame: any) {
    if (frame.t === "res") {
      const p = this.pending.get(frame.id);
      if (p) {
        this.pending.delete(frame.id);
        clearTimeout(p.timer);
        if (frame.ok) p.resolve(frame.data);
        else p.reject(Object.assign(new Error(frame.error?.message ?? "bridge error"), { code: frame.error?.code ?? "internal" }));
      }
      return;
    }
    if (frame.t === "pong") { this.missedPongs = 0; return; }
    if (frame.t === "ev") {
      for (const cb of this.eventCbs) {
        try { cb({ name: String(frame.name), payload: (frame.payload ?? {}) as Record<string, unknown> }); } catch { /* keep handlers isolated */ }
      }
    }
  }

  private startHealth() {
    this.pingTimer = setInterval(() => {
      if (!this.socket || this.dead) return;
      this.missedPongs++;
      if (this.missedPongs > HEALTH_MAX_MISSES) { this.die("lost"); return; }
      try { this.socket.write(JSON.stringify({ t: "ping", id: crypto.randomBytes(4).toString("hex") }) + "\n"); } catch { this.die("lost"); }
    }, HEALTH_PING_MS);
    this.pingTimer.unref?.();
  }

  alive(): boolean { return !this.dead && this.socket !== null; }

  cmd<T>(cmd: string, args?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.dead || !this.socket) return Promise.reject(Object.assign(new Error("bridge unavailable"), { code: "host_unavailable" }));
    const id = crypto.randomBytes(8).toString("hex");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("bridge command timeout (outcome may be unknown)"), { code: "timeout" }));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try { this.socket!.write(JSON.stringify({ t: "cmd", id, cmd, args: args ?? {} }) + "\n"); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  /** Command with dispatch-ack deadline distinct from completion (plan rule 4). */
  cmdWithAck(cmd: string, args?: unknown, ackMs = DISPATCH_ACK_TIMEOUT_MS): Promise<{ ack: unknown }> {
    return this.cmd(cmd, args, ackMs).then((ack) => ({ ack }));
  }

  onEvent(cb: (e: DriverEvent) => void): () => void {
    this.eventCbs.push(cb);
    return () => { this.eventCbs = this.eventCbs.filter((c) => c !== cb); };
  }
  onDead(cb: Driver["onDead"] extends (x: infer F) => void ? F : never) { this.deadCb = cb as never; }

  private die(reason: "exited" | "lost" | "disposed") {
    if (this.dead) return;
    this.dead = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error("bridge disconnected"), { code: "host_unavailable" })); }
    this.pending.clear();
    try { this.socket?.destroy(); } catch { /* ignore */ }
    this.socket = null;
    this.deadCb?.(reason, null, null);
  }

  dispose(reason?: string) { void reason; this.die("disposed"); }
}

export class BridgeDiscovery {
  private handles = new Map<string, BridgeHandle>();
  private timer: NodeJS.Timeout | null = null;
  private genCounter = 0;
  constructor(
    private dir: string,
    private token: string,
    private onNew: (h: BridgeHandle, record: Record<string, unknown>) => void,
    private onGone: (h: BridgeHandle) => void,
  ) {}

  start() {
    try { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); } catch { /* exists */ }
    this.scan();
    this.timer = setInterval(() => this.scan(), 3000);
    this.timer.unref?.();
  }
  stop() { if (this.timer) clearInterval(this.timer); for (const h of this.handles.values()) h.dispose(); this.handles.clear(); }

  handlesSnapshot(): BridgeHandle[] { return [...this.handles.values()]; }

  private async scan() {
    let files: string[] = [];
    try { files = fs.readdirSync(this.dir).filter((f) => f.endsWith(".json")); } catch { return; }
    const seen = new Set<string>();
    for (const f of files) {
      const full = path.join(this.dir, f);
      let rec: any;
      try {
        const st = fs.statSync(full);
        if ((st.mode & 0o777) !== 0o600) continue; // owner-only records; refuse others
        if (st.uid !== process.getuid?.()) continue;
        rec = JSON.parse(fs.readFileSync(full, "utf8"));
      } catch { continue; }
      if (!rec?.runtimeId || !rec.socketPath || typeof rec.socketPath !== "string") continue;
      if (!rec.socketPath.startsWith(this.dir)) continue; // registry records must point inside the registry dir (spoof guard)
      seen.add(String(rec.runtimeId));
      const tokenHash = crypto.createHash("sha256").update(this.token).digest("hex");
      if (rec.tokenHash !== tokenHash) continue; // not our token
      // pid liveness for records without a live handle
      if (!this.handles.has(rec.runtimeId)) {
        if (!this.pidAlive(rec.pid)) {
          this.cleanupStale(full, rec);
          continue;
        }
        try {
          const h = await BridgeHandle.connect({ runtimeId: String(rec.runtimeId), socketPath: String(rec.socketPath), pid: Number(rec.pid), procStart: Number(rec.procStart) }, ++this.genCounter, this.token);
          h.onDead((reason, code, sig) => {
            this.handles.delete(h.runtimeId);
            this.onGone(h);
            void reason; void code; void sig;
          });
          this.handles.set(h.runtimeId, h);
          this.onNew(h, rec);
          logInfo("bridge_connected", { pid: h.pid, gen: h.generation });
        } catch (e) {
          // Connection refused on a live pid: leave the record (bridge may be mid-start).
          logWarn("bridge_connect_failed", { err: String((e as Error).message).slice(0, 80) });
        }
      }
    }
    // Gone bridges: handle died (already deleted) or record vanished.
    for (const [id, h] of this.handles) {
      if (!seen.has(id)) {
        this.handles.delete(id);
        h.dispose();
        this.onGone(h);
      }
    }
  }

  private pidAlive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
  }

  /** Remove artifacts only when the owning process is verifiably dead (never another live bridge's socket). */
  private cleanupStale(recordPath: string, rec: any) {
    try {
      fs.unlinkSync(recordPath);
      if (rec.socketPath && String(rec.socketPath).startsWith(this.dir)) {
        try { fs.unlinkSync(String(rec.socketPath)); } catch { /* gone */ }
      }
      logInfo("bridge_stale_cleanup", { runtime: String(rec.runtimeId).slice(0, 8) });
    } catch { /* ignore */ }
  }
}

/* ---------------- managed host ---------------- */

export class ManagedHandle implements Driver {
  kind = "managed" as const;
  runtimeId = "pending";
  generation: number;
  pid = -1;
  piVersion = "unknown";
  sessionFile: string | null = null;
  cwd: string | null;
  capabilities!: Capabilities;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private eventCbs: ((e: DriverEvent) => void)[] = [];
  private deadCb: ((reason: "exited" | "lost" | "disposed", code: number | null, signal: string | null) => void) | null = null;
  private dead = false;
  /** Bounded tail of host stderr, kept so an unexpected exit can be explained instead of guessed at. */
  private stderrTail = "";
  private bootedOnce = false;
  private initArgs: Record<string, unknown>;
  private pingTimer: NodeJS.Timeout | null = null;
  private missedPongs = 0;
  ready: Promise<void>;
  intentionalExit = false;
  /** Boot-time runtime facts from the host handshake (model/thinking are otherwise unknown until the first run). */
  helloModel: RuntimeIdentity["model"] | null = null;
  helloThinkingLevel: string | null = null;
  helloSessionName: string | null = null;

  constructor(private child: ChildProcess, gen: number, initArgs: Record<string, unknown>) {
    this.generation = gen;
    this.initArgs = initArgs;
    this.cwd = (initArgs.cwd as string) ?? null;
    this.child.on("message", (msg: any) => this.onMessage(msg));
    // Without this listener an IPC error after disconnect ("Channel closed") is thrown as an
    // unhandled 'error' event and takes the whole server down.
    this.child.on("error", (e) => {
      logWarn("managed_host_error", { runtime: this.runtimeId, err: String((e as Error).message).slice(0, 160) });
      this.die(this.dead ? "disposed" : "lost", null, null);
    });
    this.child.on("exit", (code, signal) => {
      this.die(this.intentionalExit ? "disposed" : "exited", code, signal);
    });
    this.child.stderr?.on("data", (buf: Buffer) => {
      // Raw stderr is dropped for privacy in production; PIWEB_HOST_DEBUG (test-only)
      // mirrors it to a file so host crashes are diagnosable.
      const dbg = process.env.PIWEB_HOST_DEBUG;
      if (dbg) { try { fs.appendFileSync(dbg, `[host ${String(initArgs.sessionDir ?? initArgs.cwd ?? "?")}] ${buf.toString()}`); } catch { /* ignore */ } }
      // Keep a short tail regardless: a host that dies during boot produced no user content, and
      // "exited during boot (1)" on its own is not actionable for the person reading the log.
      this.stderrTail = (this.stderrTail + buf.toString("utf8")).slice(-4_000);
    });
    this.ready = new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("managed host boot timeout")), 600_000);
      this.bootResolve = () => { this.bootedOnce = true; clearTimeout(t); if (this.initTimer) clearInterval(this.initTimer); resolve(); };
      this.bootReject = (e) => { clearTimeout(t); if (this.initTimer) clearInterval(this.initTimer); reject(e); };
      this.child.once("exit", (code) => {
        const why = `host exited during boot (${code})`;
        const tail = this.stderrTail.replace(/\s+/g, " ").trim().slice(-300);
        try { this.bootReject?.(new Error(tail ? `${why}: ${tail}` : why)); } catch { /* resolved */ }
      });
    });
    // Handshake: sending init once at fork time races the child's listener attach
    // under startup contention. The child announces host_ready when its listener is
    // live; we (re)send init then, and also on a small retry timer as belt-and-braces.
    // The host treats duplicate inits idempotently.
    this.initTimer = setInterval(() => this.sendInit(), 1500);
    this.initTimer.unref?.();
    this.sendInit();
  }
  private initSentTo = new Set<string>();
  private initTimer: NodeJS.Timeout | null = null;
  private booted = false;
  private sendInit() {
    if (this.booted || this.dead) return;
    try { this.child.send({ t: "init", args: this.initArgs }); } catch { /* channel gone */ }
  }
  private bootResolve?: () => void;
  private bootReject?: (e: Error) => void;

  private onMessage(msg: any) {
    if (!msg || typeof msg !== "object") return;
    if (msg.t === "host_ready") { this.sendInit(); return; }
    if (msg.t === "auth_ok") {
      this.booted = true;
      if (this.initTimer) { clearInterval(this.initTimer); this.initTimer = null; }
      const hi = msg.hello ?? {};
      this.runtimeId = String(hi.runtimeId ?? "unknown");
      this.pid = Number(hi.pid ?? this.child.pid ?? -1);
      this.piVersion = String(hi.piVersion ?? "unknown");
      this.sessionFile = hi.sessionFile ?? null;
      this.capabilities = (hi.capabilities ?? {}) as Capabilities;
      // What the runtime already knows at boot; a managed session has no file (and so no
      // model_change entry) until its first run (BUG-007).
      this.helloModel = (hi.model ?? null) as RuntimeIdentity["model"] | null;
      this.helloThinkingLevel = hi.thinkingLevel == null ? null : String(hi.thinkingLevel);
      this.helloSessionName = hi.sessionName == null ? null : String(hi.sessionName);
      this.startHealth();
      this.bootResolve?.();
      return;
    }
    if (msg.t === "res") {
      const p = this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); clearTimeout(p.timer); if (msg.ok) p.resolve(msg.data); else p.reject(Object.assign(new Error(msg.error?.message ?? "host error"), { code: msg.error?.code ?? "internal" })); }
      return;
    }
    if (msg.t === "pong") { this.missedPongs = 0; return; }
    if (msg.t === "ev") {
      for (const cb of this.eventCbs) { try { cb({ name: String(msg.name), payload: (msg.payload ?? {}) as Record<string, unknown> }); } catch { /* isolate */ } }
    }
  }

  private startHealth() {
    this.pingTimer = setInterval(() => {
      if (this.dead) return;
      this.missedPongs++;
      if (this.missedPongs > HEALTH_MAX_MISSES) { this.die("lost", null, null); return; }
      try { this.child.send({ t: "ping", id: "p" + this.missedPongs }); } catch { this.die("lost", null, null); }
    }, HEALTH_PING_MS);
    this.pingTimer.unref?.();
  }

  alive(): boolean { return !this.dead; }

  cmd<T>(cmd: string, args?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.dead) return Promise.reject(Object.assign(new Error("managed host unavailable"), { code: "host_unavailable" }));
    const id = crypto.randomBytes(8).toString("hex");
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Object.assign(new Error("managed host command timeout (outcome may be unknown)"), { code: "timeout" })); }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try { this.child.send({ t: "cmd", id, cmd, args: args ?? {} }); }
      catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }

  /** Route a dialog answer with per-request deadline (distinct from cmd timeouts). */
  dialogAnswer(requestId: string, requestGeneration: number, value: unknown): Promise<{ ok: boolean }> {
    if (this.dead) return Promise.reject(Object.assign(new Error("host unavailable"), { code: "host_unavailable" }));
    return new Promise((resolve) => {
      const handler = (msg: any) => {
        if (msg?.t === "dialog_result" && msg.requestId === requestId) {
          this.child.off("message", handler);
          resolve({ ok: !!msg.ok });
        }
      };
      this.child.on("message", handler);
      setTimeout(() => { this.child.off("message", handler); resolve({ ok: false }); }, 5000).unref?.();
      try { this.child.send({ t: "dialog", requestId, requestGeneration, ...(value as object) }); } catch { this.child.off("message", handler); resolve({ ok: false }); }
    });
  }

  onEvent(cb: (e: DriverEvent) => void): () => void { this.eventCbs.push(cb); return () => { this.eventCbs = this.eventCbs.filter((c) => c !== cb); }; }
  onDead(cb: any) { this.deadCb = cb; }

  markIntentionalExit() { this.intentionalExit = true; }

  private die(reason: "exited" | "lost" | "disposed", code: number | null, signal: string | null) {
    if (this.dead) return;
    this.dead = true;
    if (reason !== "disposed") {
      // An exit nobody asked for: say so, with the exit code and (before boot) the stderr tail.
      logWarn("managed_host_exit", {
        runtime: this.runtimeId, pid: this.pid, reason, code, signal,
        booted: this.bootedOnce, cwd: this.cwd ?? null,
        stderr: this.bootedOnce ? "" : this.stderrTail.replace(/\s+/g, " ").trim().slice(-300),
      });
    } else {
      logInfo("managed_host_exit", { runtime: this.runtimeId, pid: this.pid, reason, code, signal });
    }
    if (this.pingTimer) clearInterval(this.pingTimer);
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error("managed host exited"), { code: "host_unavailable" })); }
    this.pending.clear();
    this.deadCb?.(reason, code, signal);
  }

  dispose(reason?: string) {
    this.intentionalExit = true;
    void reason;
    try { this.child.disconnect(); } catch { /* ignore */ }
    setTimeout(() => { try { if (!this.dead) this.child.kill("SIGKILL"); } catch { /* ignore */ } }, 5000).unref?.();
  }
}

export function spawnManagedHost(initArgs: { cwd: string; agentDir?: string; sessionDir?: string; model?: { provider: string; modelId: string }; thinkingLevel?: string; name?: string }, gen: number, env: Record<string, string>): ManagedHandle {
  const { script, execArgv } = resolveAdapterScript(path.join("host", "main.js"), path.join("host", "main.ts"));
  const child = fork(script, [], {
    execArgv,
    env: { ...process.env, ...env, PIWEB_MANAGED_HOST: "1" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  return new ManagedHandle(child, gen, initArgs as unknown as Record<string, unknown>);
}

/** Small helper reused by drivers for bounded record decode of framed bytes (kept for parity with adapter). */
export function decodeFrameLine(line: string): unknown {
  const framer = new LfFramer(MAX_RECORD_BYTES);
  const recs = framer.feed(Buffer.from(line + "\n", "utf8"));
  const first = recs[0];
  if (!first) return null;
  return decodeRecord(first, MAX_RECORD_BYTES);
}
