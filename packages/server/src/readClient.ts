/**
 * Server-side client for the isolated Pi read worker process. The API server itself
 * never imports Pi; all parsing/projection happens in the worker (which is restricted
 * to registered session roots and performs read-only file access).
 */
import { fork, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { resolveAdapterScript } from "./adapterPaths.ts";
import { logWarn, logError } from "./log.ts";

export interface ReadWorkerError extends Error { code: string }

/** How long a dead worker stays "failed" so callers answer instantly instead of respawning per request. */
const FAILURE_COOLDOWN_MS = 5_000;
/** Bound on retained worker stderr, so a crash can be reported without buffering unbounded output. */
const STDERR_TAIL_BYTES = 4_000;

export class ReadClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ready: Promise<void> | null = null;
  private realReady: Promise<void> = Promise.resolve();
  private realReadyResolve: () => void = () => undefined;
  private realReadyReject: (e: Error) => void = () => undefined;
  private rootsFingerprint = "";
  /** Set while a spawn/exit failure makes every call pointless; cleared by a successful ready. */
  private failedUntil = 0;
  private failureReason = "";
  private stderrTail = "";
  private everReady = false;

  constructor(private opts: { piPackageEnv?: string }) {}

  workerScript(): { script: string; execArgv: string[] } {
    return resolveAdapterScript(path.join("read", "worker.js"), path.join("read", "worker.ts"));
  }

  /** Reject everything in flight and remember why, so the next callers fail in milliseconds. */
  private failAll(reason: string, cooldownMs = FAILURE_COOLDOWN_MS) {
    this.failedUntil = Date.now() + cooldownMs;
    this.failureReason = reason;
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error(reason), { code: "host_unavailable" })); }
    this.pending.clear();
    // Nobody should keep waiting on a handshake that can no longer happen.
    this.readyResolve?.();
    try { this.realReadyReject(new Error(reason)); } catch { /* already settled */ }
  }

  private checkFailed(): void {
    if (this.failedUntil > Date.now()) {
      throw Object.assign(new Error(`read worker unavailable: ${this.failureReason}`), { code: "host_unavailable" });
    }
  }

  async ensure(roots: string[]): Promise<void> {
    this.currentRoots = [...roots];
    const fp = JSON.stringify([...roots].sort());
    if (this.proc && this.rootsFingerprint === fp) { await this.ready; return; }
    if (this.failedUntil > Date.now() && this.rootsFingerprint === fp) {
      // The same roots failed a moment ago: answer now, let the caller show "sessions unavailable".
      this.checkFailed();
    }
    await this.stop();
    this.rootsFingerprint = fp;
    let script: string;
    let execArgv: string[];
    try {
      ({ script, execArgv } = this.workerScript());
    } catch (e) {
      const msg = (e as Error).message;
      this.failAll(msg, 30_000);
      logError("read_worker_unresolvable", { err: msg });
      throw Object.assign(new Error(msg), { code: "host_unavailable", status: 503 });
    }
    this.failedUntil = 0;
    this.failureReason = "";
    this.stderrTail = "";
    this.everReady = false;
    try {
      this.proc = fork(script, [], {
        execArgv: [...execArgv],
        env: { ...process.env, PIWEB_READ_ROOTS: fp, ...(this.opts.piPackageEnv ? { PIWEB_PI_PACKAGE: this.opts.piPackageEnv } : {}) },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      }) as ChildProcessWithoutNullStreams;
    } catch (e) {
      const msg = `read worker could not be started: ${(e as Error).message}`;
      this.failAll(msg);
      logError("read_worker_spawn_failed", { err: msg, script });
      throw Object.assign(new Error(msg), { code: "host_unavailable", status: 503 });
    }
    const proc = this.proc;
    proc.stderr?.on("data", (buf: Buffer) => {
      // Raw worker stderr stays quiet (it could echo file paths and content); keep only a bounded
      // tail so an early crash can be explained. Logged only while the worker never got ready.
      this.stderrTail = (this.stderrTail + buf.toString("utf8")).slice(-STDERR_TAIL_BYTES);
    });
    proc.on("exit", (code, signal) => {
      if (this.proc !== proc) return; // superseded by a newer worker
      const why = `read worker exited (code ${code ?? "null"}${signal ? `, signal ${signal}` : ""})`;
      logWarn("read_worker_exit", { code: code ?? null, signal: signal ?? null, ready: this.everReady, stderr: this.everReady ? "" : tailForLog(this.stderrTail) });
      this.proc = null;
      this.ready = null;
      this.readyResolve?.();
      if (!this.everReady) {
        // It died before it could serve anything: stop pretending it might still boot.
        this.failAll(why);
      } else {
        for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error(why), { code: "host_unavailable" })); }
        this.pending.clear();
        this.realReady = new Promise<void>(() => undefined); // never resolves until next ensure()
      }
    });
    proc.on("error", (e) => {
      if (this.proc !== proc) return;
      const why = `read worker error: ${e.message}`;
      logWarn("read_worker_error", { err: e.message, stderr: tailForLog(this.stderrTail) });
      this.proc = null;
      this.ready = null;
      this.readyResolve?.();
      this.failAll(why);
    });
    proc.on("message", (msg: any) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "ready") {
        this.everReady = true;
        this.failedUntil = 0;
        this.failureReason = "";
        this.realReadyResolve();
        this.readyResolve?.();
        return;
      }
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(Object.assign(new Error(msg.error?.message ?? "read error"), { code: msg.error?.code ?? "internal" }));
    });
    let readyResolve!: () => void;
    this.ready = new Promise<void>((r) => { readyResolve = r; });
    this.readyResolve = readyResolve;
    this.realReady = new Promise<void>((resolve, reject) => {
      this.realReadyResolve = resolve;
      this.realReadyReject = reject;
    });
    this.realReady.catch(() => { /* handled by the race in call() */ });
    // fail-open handshake wait: server stays responsive (calls time out honestly) even if the
    // worker takes pathologically long to load (observed >15 min under macOS fileproviderd storms)
    const timer = setTimeout(() => this.readyResolve?.(), 90_000);
    await this.ready;
    clearTimeout(timer);
  }
  private readyResolve?: () => void;

  async call<T>(op: string, args: Record<string, unknown>, timeoutMs = 30_000, readyWaitMs = 300_000): Promise<T> {
    this.checkFailed();
    await this.ensure(this.currentRoots);
    // wait for the worker's real ready handshake before queueing a call, so slow boots
    // (cold FS) succeed instead of timing out repeatedly; a worker that dies during the boot
    // rejects this immediately rather than burning the whole grace period
    await Promise.race([
      this.realReady,
      new Promise<void>((r) => setTimeout(r, readyWaitMs)),
      new Promise<never>((_, reject) => {
        if (this.failedUntil > Date.now()) reject(Object.assign(new Error(`read worker unavailable: ${this.failureReason}`), { code: "host_unavailable" }));
      }),
    ]);
    const id = `r${++this.seq}`;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("read worker timeout"), { code: "timeout" }));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        if (!this.proc) throw new Error("no worker process");
        this.proc.send({ id, op, args });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(Object.assign(new Error("read worker unavailable"), { code: "host_unavailable" }));
      }
    });
  }

  currentRoots: string[] = [];

  async stop() {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    this.ready = null;
    try { p.disconnect(); } catch { /* channel gone */ }
    // Disconnect lets a healthy worker exit on its own; kill it shortly after so a replaced or
    // shutting-down server never leaves a worker behind (an unref'd timer would not fire at exit).
    if (p.exitCode === null && p.signalCode === null) {
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve(); }, 2_000);
        killTimer.unref?.();
        p.once("exit", () => { clearTimeout(killTimer); resolve(); });
      });
    }
  }
}

/** One-line, bounded form of the retained stderr tail for log records. */
function tailForLog(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(-400);
}
