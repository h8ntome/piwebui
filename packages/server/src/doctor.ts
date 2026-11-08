/**
 * `pi-web doctor` (bridge_plan 03 §9): one command that answers "why is my terminal pi not live
 * in the browser?" in one sentence per finding, with the fix command next to each problem.
 *
 * It is deliberately usable while the server runs (a second process against the same data dir)
 * and while it does not (no live server is a finding, not a crash). Everything is read-only except
 * nothing: doctor never mutates state, so it is safe to run while a bridge is mid-flight.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { allowedPiVersions, isPiVersionAllowed, TESTED_PI_VERSIONS, type BridgeDiagnose } from "@piwebui/shared";
import { resolvePiPackage } from "@piwebui/pi-adapter";
import { descriptorPath, readDescriptor } from "./descriptor.ts";

export interface DoctorCheck {
  id: string;
  ok: boolean;
  /** "warn" findings are explained but do not fail the run (e.g. legacy leftovers). */
  level: "ok" | "warn" | "fail";
  message: string;
  fix?: string;
}

export interface DoctorReport {
  ok: boolean;
  dataDir: string;
  generatedAt: string;
  checks: DoctorCheck[];
}

const ok = (id: string, message: string): DoctorCheck => ({ id, level: "ok", ok: true, message });
const warn = (id: string, message: string, fix?: string): DoctorCheck => ({ id, level: "warn", ok: false, message, ...(fix ? { fix } : {}) });
const fail = (id: string, message: string, fix?: string): DoctorCheck => ({ id, level: "fail", ok: false, message, ...(fix ? { fix } : {}) });

function modeOf(file: string): number {
  try { return fs.statSync(file).mode & 0o777; } catch { return -1; }
}

function pidAlive(pid: number): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function collectDoctor(dataDir: string): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const file = descriptorPath(dataDir);

  // 1. pi itself
  const pkg = resolvePiPackage({});
  if (!pkg) {
    checks.push(fail("pi", "Pi is not installed or not resolvable: terminal sessions cannot be bridged.", "npm i -g @earendil-works/pi-coding-agent"));
  } else {
    const allowed = isPiVersionAllowed(pkg.version);
    checks.push(allowed
      ? ok("pi", `pi ${pkg.version} resolved and validated for writes`)
      : warn("pi", `pi ${pkg.version} is not validated by this pi-web build: bridged sessions stay read-only`,
        `PIWEB_ALLOW_PI_VERSIONS=${pkg.version} pi-web   (validated: ${TESTED_PI_VERSIONS.join(", ")})`));
  }

  // 2. descriptor + permissions
  const read = readDescriptor(file);
  let httpBase: string | null = null;
  if (!read.ok) {
    checks.push(read.reason === "missing"
      ? fail("descriptor", `no bridge descriptor at ${file}: pi-web has not been started for this data dir`, "start it with `pi-web --no-open` (or point PIWEB_DATA_DIR at its --data-dir)")
      : fail("descriptor", `descriptor at ${file} is unusable (${read.reason}${read.detail ? `: ${read.detail}` : ""})`, "restart pi-web to republish it"));
  } else {
    const d = read.descriptor;
    httpBase = d.http || null;
    const dirMode = modeOf(dataDir);
    const fileMode = modeOf(file);
    checks.push(fileMode === 0o600 ? ok("descriptor.mode", `${file} is 0600 (owner-only, as it must be)`)
      : fail("descriptor.mode", `${file} is ${(fileMode).toString(8)}, not 0600: the bridge token is readable`, `chmod 600 ${file}`));
    // (this clause used to read `0o700 || 0o755 || 0o700`, i.e. a duplicated test that waved a
    // world-readable data dir through while metadata.db sat inside it at 0644 — BUG-022).
    const dbMode = modeOf(path.join(dataDir, "metadata.db"));
    checks.push(dirMode === 0o700 ? ok("datadir.mode", `${dataDir} is 0700 (owner-only, as it must be)`)
      : warn("datadir.mode", `${dataDir} mode ${(dirMode).toString(8)}, not 0700: anyone on this machine who can reach the port can also read this state`, `chmod 700 ${dataDir}`));
    if (dbMode >= 0 && dbMode !== 0o600) {
      checks.push(warn("db.mode", `${path.join(dataDir, "metadata.db")} mode ${(dbMode).toString(8)}, not 0600`, `chmod 600 ${path.join(dataDir, "metadata.db")}`));
    }
    checks.push(fs.existsSync(d.socket) ? ok("socket", `bridge socket present: ${d.socket}`)
      : fail("socket", `descriptor points at ${d.socket}, which does not exist: pi-web is not running (or died without cleaning up)`, "start pi-web; bridges reconnect within 15 s"));
    checks.push(pidAlive(d.pid) ? ok("server.pid", `pid ${d.pid} from the descriptor is alive (server ${d.serverId})`)
      : fail("server.pid", `descriptor claims server pid ${d.pid}, which is not running: it is stale`, "start pi-web (it rewrites the descriptor on boot)"));
    const age = (() => { try { return Date.now() - fs.statSync(file).mtimeMs; } catch { return null; } })();
    checks.push(age !== null && age < 7 * 24 * 3600_000 ? ok("descriptor.age", `descriptor is ${Math.round(age / 1000)} s old`)
      : warn("descriptor.age", age === null ? "descriptor age unknown" : `descriptor is ${Math.round(age / 60000)} min old`));
    if (d.protocol?.[0] !== 1) checks.push(fail("descriptor.protocol", `descriptor speaks protocol ${JSON.stringify(d.protocol)}, this build speaks 1`));
  }

  // 3. the running server's own view
  let live: { health?: Record<string, unknown>; runtimes?: unknown; diagnose?: BridgeDiagnose } | null = null;
  if (httpBase) {
    try {
      const health = await fetchJson(`${httpBase}/api/v1/health`);
      live = { health: health as Record<string, unknown> };
      const rt = await fetchJson(`${httpBase}/api/v1/runtimes`).catch(() => null);
      const dg = await fetchJson(`${httpBase}/api/v1/bridge/diagnose`).catch(() => null);
      if (rt) live.runtimes = rt;
      if (dg) live.diagnose = dg as BridgeDiagnose;
      const bridges = (health as { bridges?: Record<string, unknown> })?.bridges ?? {};
      const dial = Number(bridges.dial ?? 0);
      checks.push(dial > 0 ? ok("bridge.connected", `${dial} terminal runtime(s) dialled in`)
        : warn("bridge.connected", "no terminal pi is connected right now",
          "install the bridge once: `pi install npm:@piwebui/pi-web-bridge`, then run pi (a running pi needs /reload)"));
    } catch (e) {
      checks.push(fail("server.http", `pi-web is not answering on ${httpBase}: ${(e as Error).message.slice(0, 80)}`, "start pi-web, or check --bind/--port"));
    }
  }

  // 4. the extension pi will actually load
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? os.homedir(), ".pi", "agent");
  const extDir = path.join(agentDir, "extensions");
  const legacy = path.join(extDir, "pi-web-bridge.mjs");
  const modern = path.join(extDir, "pi-web-bridge.js");
  if (fs.existsSync(legacy)) {
    checks.push(fail("extension.legacy", `${legacy} exists: pi never auto-discovers .mjs, so that copy is dead weight (and confusing)`, `rm ${legacy}`));
  }
  let installed = fs.existsSync(modern);
  let viaPackage = false;
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")) as { packages?: string[] };
    viaPackage = (settings.packages ?? []).some((p) => p.includes("pi-web-bridge"));
  } catch { /* no settings.json */ }
  if (viaPackage) checks.push(ok("extension", "the bridge is installed as a pi package (self-updating, discoverable)"));
  else if (installed) checks.push(ok("extension", `${modern} is installed by file copy; it will not self-update`));
  else checks.push(warn("extension", "no bridge extension found for terminal pi", "pi install npm:@piwebui/pi-web-bridge   (or: pi-web install-extension)"));

  // 5. legacy leftovers we can name and clean
  const bridgeDir = path.join(dataDir, "bridges");
  try {
    const stale = fs.readdirSync(bridgeDir).filter((f) => f.endsWith(".json") || f.endsWith(".sock"));
    if (stale.length) checks.push(warn("legacy", `${bridgeDir} holds ${stale.length} pre-1.0 bridge artifact(s)`, "after switching to the dial transport: rm -rf " + bridgeDir));
  } catch { /* none: the normal case now */ }

  // 6. per-session verdicts, straight from the server
  const diag = live?.diagnose;
  if (diag) {
    const mirrors = diag.sessions.filter((s) => s.mode === "mirror" || s.mode === "history");
    if (mirrors.length === 0) checks.push(ok("sessions", `${diag.sessions.length} session(s), every one of them controllable`));
    else {
      const whyCounts = new Map<string, number>();
      for (const m of mirrors) whyCounts.set(m.why || "no bridge", (whyCounts.get(m.why || "no bridge") ?? 0) + 1);
      const summary = [...whyCounts.entries()].map(([why, n]) => `${n}x ${why}`).join("; ");
      checks.push(summary.includes("no bridge connected")
        ? warn("sessions", `${mirrors.length} session(s) are file mirrors: ${summary}`, "pi install npm:@piwebui/pi-web-bridge, then /reload in that terminal")
        : warn("sessions", `${mirrors.length} session(s) are not controllable: ${summary}`));
    }
    if (Object.keys(diag.rejects ?? {}).length) {
      checks.push(fail("accept", `bridge connections were rejected: ${Object.entries(diag.rejects).map(([k, v]) => `${k}=${v}`).join(", ")}`,
        "attest_failed means the claiming pid is not a live pi process; unauthorized means a stale or foreign bridge.json"));
    }
  }

  return {
    ok: !checks.some((c) => c.level === "fail"),
    dataDir,
    generatedAt: new Date().toISOString(),
    checks,
  };
}

async function fetchJson(url: string): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export function formatDoctor(report: DoctorReport): string {
  const lines = [`pi-web doctor - ${report.dataDir}`, ""];
  for (const c of report.checks) {
    const mark = c.level === "ok" ? " ok " : c.level === "warn" ? "warn" : "FAIL";
    lines.push(`  [${mark}] ${c.id}: ${c.message}`);
    if (c.fix) lines.push(`         fix: ${c.fix}`);
  }
  lines.push("");
  lines.push(report.ok ? "No blocking problems." : "Problems above are marked FAIL; warnings are informational.");
  void allowedPiVersions;
  return lines.join("\n");
}

export async function runDoctor(opts: { dataDir: string; json: boolean }): Promise<number> {
  const report = await collectDoctor(opts.dataDir);
  if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write(formatDoctor(report) + "\n");
  return report.ok ? 0 : 1;
}
