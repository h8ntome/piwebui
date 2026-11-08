/**
 * Process attestation (bridge_plan 03 §3, D-6).
 *
 * The dial model gives pi-web an inbound listener, so a bridge's self-reported identity has to be
 * checked against something the bridge does not control: the OS's own view of the claimed pid.
 * Node exposes no `SO_PEERCRED` accessor (measured: `getSocketCredentials`/`getPeerCredentials` are
 * absent in Node 24), so same-uid remains the trust boundary and this module is the layer above it:
 * a *different* process cannot claim a pi's pid and survive a start-time comparison, and a process
 * that is not pi at all fails the cmdline check.
 *
 * Everything is injectable so the gates can be unit-tested without forging /proc.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { BRIDGE_ATTEST_TOLERANCE_MS } from "@piwebui/shared";

export interface AttestClaim {
  pid: number;
  procStart: number;
}

export interface AttestProbe {
  /** null when unavailable. */
  cmdline(pid: number): string | null;
  /** OS-observed process start in ms since epoch, or null. */
  startMs(pid: number): number | null;
}

export interface AttestResult {
  ok: boolean;
  /** Machine-readable; surfaced by `/api/v1/runtimes`, `bridge_conn_rejected` and `doctor`. */
  reason?: "pid_not_alive" | "start_unknown" | "start_mismatch" | "not_pi_process";
  found?: { cmdline: string; startMs: number | null; pidAlive: boolean };
  method?: "proc" | "ps" | "none";
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Anything that plausibly is the pi CLI: the package dir, or an argv[0] literally named `pi`. */
export function looksLikePiCmdline(cmdline: string): boolean {
  const clean = cmdline.replace(/\0/g, " ").trim();
  if (!clean) return false;
  if (clean.includes("pi-coding-agent")) return true;
  if (/@earendil-works[\\/]/.test(clean)) return true;
  const argv0 = clean.split(/\s+/)[0] ?? "";
  const base = argv0.split(/[\\/]/).pop() ?? "";
  return base === "pi" || base === "pi.exe";
}

function linuxStartMs(pid: number): { startMs: number | null; method: "proc" | "ps" } {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // comm is parenthesised and may itself contain spaces/parentheses: cut at the last ")".
    const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const starttimeTicks = Number(tail[19]);
    if (!Number.isFinite(starttimeTicks)) return { startMs: null, method: "proc" };
    const btimeLine = /^btime (\d+)$/m.exec(fs.readFileSync("/proc/stat", "utf8"));
    if (!btimeLine) return { startMs: null, method: "proc" };
    const hz = Number(process.env.PIWEB_LINUX_CLK_TCK ?? 100) || 100;
    const btimeMs = Number(btimeLine[1]) * 1000;
    return { startMs: btimeMs + (starttimeTicks / hz) * 1000, method: "proc" };
  } catch {
    return { startMs: null, method: "proc" };
  }
}

function psElapsedStartMs(pid: number): number | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "etimes="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const sec = Number(out);
    if (!Number.isFinite(sec)) return null;
    return Date.now() - sec * 1000;
  } catch {
    return null;
  }
}

/** The real probe: /proc where it exists (Linux), `ps` everywhere else (macOS, BSD). */
export const defaultProbe: AttestProbe = {
  cmdline(pid: number): string | null {
    try {
      return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8");
    } catch {
      try {
        const out = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        return out || null;
      } catch {
        return null;
      }
    }
  },
  startMs(pid: number): number | null {
    const { startMs } = linuxStartMs(pid);
    if (startMs !== null) return startMs;
    return psElapsedStartMs(pid);
  },
};

/**
 * Verify a bridge's `{pid, procStart}` claim. `toleranceMs` absorbs node startup and clock
 * granularity; a recycled pid (same pid, different lifetime) always fails on the start time.
 */
export function attestRuntime(
  claim: AttestClaim,
  opts: { require: boolean; probe?: AttestProbe | undefined; toleranceMs?: number | undefined } = { require: true },
): AttestResult {
  const probe = opts.probe ?? defaultProbe;
  const tolerance = opts.toleranceMs ?? BRIDGE_ATTEST_TOLERANCE_MS;
  if (!pidAlive(claim.pid)) return { ok: false, reason: "pid_not_alive", found: { cmdline: "", startMs: null, pidAlive: false } };
  const cmdline = probe.cmdline(claim.pid) ?? "";
  const startMs = probe.startMs(claim.pid);
  const found = { cmdline: cmdline.replace(/\0/g, " ").trim(), startMs, pidAlive: true };
  if (startMs === null) {
    // No way to compare lifetimes: keep the token/file-mode trust, but say so out loud.
    return { ok: !opts.require, reason: "start_unknown", found, method: "none" };
  }
  if (Math.abs(startMs - claim.procStart) > tolerance) return { ok: false, reason: "start_mismatch", found, method: "proc" };
  if (!looksLikePiCmdline(found.cmdline)) return { ok: false, reason: "not_pi_process", found, method: "proc" };
  return { ok: true, found, method: "proc" };
}
