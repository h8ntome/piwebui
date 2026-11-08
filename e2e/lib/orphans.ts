/**
 * Orphan guard for the e2e harnesses (BUG-041).
 *
 * Every harness here spawns a server (and often a terminal `pi` in a pty) as a detached process
 * group. Killing only the direct child leaks whole trees: this audit inherited 57 live `pi-web`
 * servers and a `ptyrun.py` that had burned 261 CPU-minutes, and a leaked server on a fixed port
 * makes the *next* run's failures meaningless.
 *
 * Usage: `const guard = orphanGuard("pi-web-e2e"); guard.add(child); ... guard.dispose();`
 * `dispose()` kills every group, then reports anything of ours still alive so the suite fails
 * loudly instead of leaving it for the next person.
 */
import { execSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";

export interface OrphanGuard {
  add<T extends ChildProcess>(child: T): T;
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
  const onSignal = (sig: NodeJS.Signals) => { killAll(); process.exit(sig === "SIGINT" ? 130 : 143); };
  process.on("exit", killAll);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  return {
    add<T extends ChildProcess>(child: T): T {
      if (child.pid) pids.add(child.pid);
      return child;
    },
    dispose() {
      killAll();
      let leaked: string[] = [];
      try {
        const out = execSync(`pgrep -fa ${JSON.stringify(signature)} || true`, { encoding: "utf8" });
        leaked = out.split("\n").filter((l) => l.trim().length > 0 && !l.includes("pgrep"));
      } catch { /* pgrep missing: nothing to report */ }
      if (leaked.length) {
        console.error(`orphan guard: ${leaked.length} process(es) matching "${signature}" survived this run:\n${leaked.join("\n")}`);
      }
      return { leaked };
    },
  };
}
