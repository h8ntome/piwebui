/**
 * Orphan guard for the e2e harnesses (BUG-041).
 *
 * Every harness here spawns a server (and often a terminal `pi` in a pty) as a detached process
 * group. Killing only the direct child leaks whole trees: this audit inherited 57 live `pi-web`
 * servers and a `ptyrun.py` that had burned 261 CPU-minutes, and a leaked server on a fixed port
 * makes the *next* run's failures meaningless.
 *
 * Usage: `const guard = orphanGuard("pi-web-e2e"); guard.add(child); ... guard.dispose();`
 * The signature is a `|`-separated list of literal substrings that identify this harness's own
 * processes (a temp path or a flag only it passes) - it is matched as text, never as a regex.
 * `dispose()` kills every group, then reports anything of ours still alive so the suite fails
 * loudly instead of leaving it for the next person.
 */
import { execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface OrphanGuard {
  add<T extends ChildProcess>(child: T): T;
  /** Add a signature later, once the run knows something unique about what it started. */
  also(signature: string): void;
  dispose(): { leaked: string[] };
}

export function orphanGuard(signature: string): OrphanGuard {
  const pids = new Set<number>();
  const killed = new Set<number>();
  const killGroup = (pid: number) => {
    if (killed.has(pid)) return;
    killed.add(pid);
    try { process.kill(-pid, "SIGKILL"); } catch { /* already gone */ }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
  };
  const killAll = () => { for (const p of pids) killGroup(p); };
  const extra: string[] = [];
  const onSignal = (sig: NodeJS.Signals) => { killAll(); process.exit(sig === "SIGINT" ? 130 : 143); };
  process.on("exit", killAll);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return {
    add<T extends ChildProcess>(child: T): T {
      if (child.pid) pids.add(child.pid);
      return child;
    },
    also(signature: string) { extra.push(signature); },
    dispose() {
      killAll();
      let leaked: string[] = [];
      try {
        // `ps` + a literal substring match rather than `pgrep -fa "$signature"`: a signature that
        // begins with `--` (a flag the run passed, like `--data-dir /tmp/x`) is parsed by pgrep as
        // its own option and the whole report turns into a usage dump.
        const out = execSync("ps -eo args=", { encoding: "utf8" });
        const parts = [...signature.split("|"), ...extra].map((s) => s.trim()).filter(Boolean);
        const hit = (line: string) => parts.some((p) => line.includes(p));
        leaked = out.split("\n").filter((l) => l.trim().length > 0 && hit(l) && !l.startsWith("ps "));
      } catch { /* ps missing: nothing to report */ }
      if (leaked.length) {
        console.error(`orphan guard: ${leaked.length} process(es) matching "${signature}" survived this run:\n${leaked.join("\n")}`);
      }
      return { leaked };
    },
  };
}
