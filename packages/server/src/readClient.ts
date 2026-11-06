/**
 * Server-side client for the isolated Pi read worker process. The API server itself
 * never imports Pi; all parsing/projection happens in the worker (which is restricted
 * to registered session roots and performs read-only file access).
 */
import { fork, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { logWarn, logError } from "./log.ts";

export interface ReadWorkerError extends Error { code: string }

const ADAPTER_SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-adapter", "src");
const ADAPTER_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "pi-adapter", "dist");

export class ReadClient {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private seq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private ready: Promise<void> | null = null;
  private rootsFingerprint = "";

  constructor(private opts: { piPackageEnv?: string }) {}

  private workerScript(): { script: string; execArgv: string[] } {
    const candidateTs = path.join(ADAPTER_SRC, "read", "worker.ts");
    const candidateJs = path.join(ADAPTER_DIST, "read", "worker.js");
    if (existsSync(candidateJs)) return { script: candidateJs, execArgv: [] };
    const loader = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "tsx", "dist", "loader.mjs");
    return { script: candidateTs, execArgv: existsSync(loader) ? ["--import", pathToFileURL(loader).href] : ["--import", "tsx"] };
  }

  async ensure(roots: string[]): Promise<void> {
    this.currentRoots = [...roots];
    const fp = JSON.stringify([...roots].sort());
    if (this.proc && this.rootsFingerprint === fp) { await this.ready; return; }
    await this.stop();
    this.rootsFingerprint = fp;
    const { script, execArgv } = this.workerScript();
    this.proc = fork(script, [], {
      execArgv: [...execArgv],
      env: { ...process.env, PIWEB_READ_ROOTS: fp, ...(this.opts.piPackageEnv ? { PIWEB_PI_PACKAGE: this.opts.piPackageEnv } : {}) },
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    }) as ChildProcessWithoutNullStreams;
    this.proc!.stderr?.on("data", () => { /* raw worker stderr is deliberately dropped (privacy) */ });
    this.proc!.on("exit", (code, signal) => {
      logWarn("read_worker_exit", { code: code ?? -1, signal: signal ?? "" });
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(Object.assign(new Error("read worker exited"), { code: "host_unavailable" })); }
      this.pending.clear();
      this.proc = null;
      this.ready = null;
    });
    this.proc!.on("message", (msg: any) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.t === "ready") { const r = this.readyResolve; r?.(); return; }
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
    // wait for ready handshake
    const timer = setTimeout(() => this.readyResolve?.(), 15_000);
    await this.ready;
    clearTimeout(timer);
  }
  private readyResolve?: () => void;

  async call<T>(op: string, args: Record<string, unknown>, timeoutMs = 30_000): Promise<T> {
    await this.ensure(this.currentRoots);
    const id = `r${++this.seq}`;
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error("read worker timeout"), { code: "timeout" }));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      try {
        this.proc!.send({ id, op, args });
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(Object.assign(new Error("read worker unavailable"), { code: "host_unavailable" }));
      }
    });
  }

  currentRoots: string[] = [];

  async stop() {
    if (this.proc) {
      const p = this.proc;
      this.proc = null;
      this.ready = null;
      p.disconnect();
      setTimeout(() => { try { p.kill(); } catch { /* gone */ } }, 2000).unref?.();
    }
  }
}
