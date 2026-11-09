/**
 * `pi-web update`: keep the *installed* copy of pi-web current.
 *
 * The gap this closes is the one that makes a fix look like it never happened: CI publishes a
 * canary on every commit to `main` and a release on every tag, but the copy of pi-web that is
 * actually sitting in a global npm prefix - and the server serving a browser from it - only
 * changes when someone re-installs and restarts it. Until now that was a manual step nobody
 * scheduled, so a browser could be pointed at a weeks-old build with nothing on screen saying so.
 *
 * Two rules shape the design:
 *
 * - **Never trust `npm prefix -g`.** A machine can hold several Node installs (this one does:
 *   the one on PATH and a second under `~/.npm-global`). The install to update is the one *this
 *   file was loaded from*, so the prefix is derived from this module's own path.
 * - **Never decide silently on someone's behalf about a running server.** Updating files is safe;
 *   restarting a server that has live sessions is the user's call, so `--restart` is opt-in and
 *   the default output says exactly what to do next.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The npm package this module ships inside. */
export const PACKAGE_NAME = "@piwebui/pi-web";

/** How far one npm call may take before we call it a failure (a registry read is never slow). */
const NPM_TIMEOUT_MS = 60_000;

export type UpdateAction = "up-to-date" | "update-available" | "unknown";

export interface UpdateFacts {
  /** Version of the package this process is running. */
  installed: string;
  /** The dist-tag being followed. */
  tag: string;
  /** The newest version on that tag, or null when the registry could not be read. */
  available: string | null;
  /** Directory of the installed package this code was loaded from (null in a bare checkout). */
  packageDir: string | null;
  /** Why the answer is what it is, in one line a human can act on. */
  reason: string;
}

/**
 * Which tag a build should follow. A canary (any `-canary.n.sha` build, stamped by CI per
 * commit) stays on `next`; a hand-picked release stays on `latest`. Nobody wants a tagged
 * release quietly replaced by a bleeding-edge canary, and nobody wants a canary to freeze.
 */
export function defaultTag(installed: string): string {
  return /-(canary|alpha|beta|rc|next|dev)\./.test(installed) || /-(canary|alpha|beta|rc)/.test(installed) ? "next" : "latest";
}

/** Is `a` older (-1), the same (0), or newer (1) than `b`? Semver-ish, prerelease-aware. */
export function compareVersions(a: string, b: string): number {
  const pa = splitVersion(a);
  const pb = splitVersion(b);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa.core[i] ?? 0) - (pb.core[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  // 1.2.3 outranks 1.2.3-canary.1; two prereleases compare identifier by identifier.
  if (pa.pre.length === 0 && pb.pre.length === 0) return 0;
  if (pa.pre.length === 0) return 1;
  if (pb.pre.length === 0) return -1;
  const len = Math.max(pa.pre.length, pb.pre.length);
  for (let i = 0; i < len; i += 1) {
    const left = pa.pre[i];
    const right = pb.pre[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    const numeric = typeof left === "number" && typeof right === "number";
    const cmp = numeric ? (left as number) - (right as number) : String(left).localeCompare(String(right));
    return cmp < 0 ? -1 : 1;
  }
  return 0;
}

function splitVersion(value: string): { core: number[]; pre: (string | number)[] } {
  const [base = "", prePart = ""] = value.split("+")[0]!.split("-");
  const core = base.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : 0));
  const pre = prePart === "" ? [] : prePart.split(".").map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return { core, pre };
}

/** The plan a caller acts on: is there anything newer on the tag, and what should they do? */
export function updatePlan(facts: UpdateFacts): { action: UpdateAction; from: string; to: string | null; reason: string } {
  if (facts.packageDir === null) {
    return { action: "unknown", from: facts.installed, to: null, reason: "this is a git checkout, not a global install; run `npm run build` here and `npm i -g` the packages instead" };
  }
  if (facts.available === null) {
    return { action: "unknown", from: facts.installed, to: null, reason: `npm could not read the ${facts.tag} tag of ${PACKAGE_NAME}` };
  }
  if (compareVersions(facts.available, facts.installed) <= 0) {
    return { action: "up-to-date", from: facts.installed, to: facts.available, reason: `already the newest ${facts.tag} build (${facts.installed})` };
  }
  return { action: "update-available", from: facts.installed, to: facts.available, reason: `${facts.tag} has ${facts.available}; this is ${facts.installed}` };
}

/**
 * The directory of the package this module was loaded from, or null when running from a source
 * checkout (the manifests there are not an installed package, and updating them would overwrite
 * someone's work in progress). Detected by walking up for a manifest that names this package,
 * then requiring a built `dist/main.js` beside it - packed installs have one, checkouts do not
 * until someone builds.
 */
export function installedPackageDir(start: string = path.dirname(fileURLToPath(import.meta.url))): string | null {
  let dir = start;
  for (let depth = 0; depth < 8; depth += 1) {
    const manifest = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(manifest, "utf8")) as { name?: string };
      if (pkg.name === PACKAGE_NAME) {
        return fs.existsSync(path.join(dir, "dist", "main.js")) ? dir : null;
      }
    } catch { /* keep walking */ }
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/**
 * The npm prefix that owns an installed package: the `<x>` in `<x>/lib/node_modules/<name>`
 * (`<x>/node_modules/<name>` for a prefix-less install, `<x>/node_modules/<scope>/<name>` on
 * Windows layouts). Derived from the path rather than asked of npm, because npm answers for
 * whichever npm is on PATH and that is often a different Node than the one running this.
 */
export function prefixFor(packageDir: string): string | null {
  const normalized = packageDir.split(path.sep).join("/");
  const marker = "/lib/node_modules/";
  const at = normalized.lastIndexOf(marker);
  if (at !== -1) return normalized.slice(0, at);
  const plain = normalized.lastIndexOf("/node_modules/");
  if (plain !== -1) {
    const prefix = normalized.slice(0, plain);
    return prefix === "" ? null : prefix;
  }
  return null;
}

/** The npm to use for that prefix: its own `bin/npm` when it has one, else the one on PATH. */
export function npmFor(prefix: string | null, platform: NodeJS.Platform = process.platform): string {
  if (prefix !== null) {
    const own = path.join(prefix, "bin", platform === "win32" ? "npm.cmd" : "npm");
    if (fs.existsSync(own)) return own;
  }
  return platform === "win32" ? "npm.cmd" : "npm";
}

/** Run one npm command with no shell and return its stdout, or an Error carrying npm's own complaint. */
export type NpmRunner = (npm: string, args: string[], signal?: AbortSignal) => Promise<string>;

export const runNpm: NpmRunner = (npm, args, signal) => new Promise<string>((resolve, reject) => {
  const child = spawn(npm, args, { stdio: ["ignore", "pipe", "pipe"], shell: false, windowsHide: true });
  let out = "";
  let err = "";
  const timer = setTimeout(() => child.kill(), NPM_TIMEOUT_MS);
  const kill = () => { clearTimeout(timer); child.kill(); };
  signal?.addEventListener("abort", kill, { once: true });
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => { out += chunk; });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { err = (err + chunk).slice(-800); });
  child.on("error", (error) => { clearTimeout(timer); reject(error); });
  child.on("close", (code) => {
    clearTimeout(timer);
    if (code === 0) resolve(out);
    else reject(new Error(`${path.basename(npm)} ${args[0] ?? ""} failed (exit ${String(code)}): ${(err.trim() || out.trim()).slice(0, 300)}`));
  });
});

/** The newest version on a dist-tag, or null when the registry is unreachable or npm is missing. */
export async function latestOnTag(tag: string, npm = npmFor(null), run: NpmRunner = runNpm): Promise<string | null> {
  try {
    const out = await run(npm, ["view", PACKAGE_NAME, "dist-tags", "--json"]);
    const tags = JSON.parse(out) as Record<string, string>;
    const version = tags[tag];
    return typeof version === "string" && version !== "" ? version : null;
  } catch {
    return null;
  }
}

export interface UpdateOptions {
  /** Check only: never installs. This is what a scheduled job should run with. */
  check: boolean;
  /** Dist-tag to follow; defaults from the installed version (`next` for canaries). */
  tag?: string | undefined;
  /** Restart the server after a successful install (opt-in: live sessions are the user's). */
  restart: boolean;
  /** Print machine-readable JSON instead of prose. */
  json: boolean;
}

export interface UpdateReport extends UpdateFacts {
  action: UpdateAction;
  installedAt: string | null;
  restarted: boolean;
  nextStep: string;
}

/**
 * Do the thing `pi-web update` promises: report, optionally install, optionally restart.
 * Everything it prints is meant to be actionable from a terminal on a machine you SSH into,
 * so no step is hidden behind an interactive prompt.
 */
export async function performUpdate(
  options: UpdateOptions,
  internals: { packageDir?: string | null; installed?: string; latest?: (tag: string) => Promise<string | null>; install?: (npm: string, prefix: string | null, tag: string) => Promise<void>; restart?: () => boolean; npm?: string } = {},
): Promise<UpdateReport> {
  const packageDir = internals.packageDir !== undefined ? internals.packageDir : installedPackageDir();
  const prefix = packageDir === null ? null : prefixFor(packageDir);
  const npm = internals.npm ?? npmFor(prefix);
  const installed = internals.installed ?? packageVersionOf(packageDir);
  const tag = options.tag && options.tag !== "" ? options.tag : defaultTag(installed);
  const latest = internals.latest ?? ((t: string) => latestOnTag(t, npm));
  const available = await latest(tag);
  const plan = updatePlan({ installed, tag, available, packageDir, reason: "" });

  let installedNow = false;
  if (!options.check && plan.action === "update-available") {
    const install = internals.install ?? ((n, p, t) => runNpm(n, ["install", "-g", ...(p !== null ? ["--prefix", p] : []), `${PACKAGE_NAME}@${t}`]));
    await install(npm, prefix, tag);
    installedNow = true;
  }

  let restarted = false;
  if (options.restart && (installedNow || plan.action === "up-to-date")) {
    restarted = (internals.restart ?? restartUserServer)();
  }

  const nextStep = plan.action === "unknown"
    ? plan.reason
    : installedNow
      ? restarted
        ? "updated and restarted; reload the browser tab to see it"
        : `updated to ${plan.to} - restart pi-web to load it${prefix !== null ? ` (systemctl --user restart pi-web, or just stop and start it)` : ""}`
      : plan.action === "update-available"
        ? `run \`pi-web update\` to install ${plan.to}, then restart pi-web`
        : "nothing to do";

  return {
    action: installedNow ? "up-to-date" : plan.action,
    installed: installedNow ? (plan.to ?? installed) : installed,
    available,
    tag,
    packageDir,
    installedAt: prefix,
    reason: installedNow ? `installed ${plan.to} from ${tag}` : plan.reason,
    restarted,
    nextStep,
  };
}

function packageVersionOf(packageDir: string | null): string {
  if (packageDir !== null) {
    try {
      return (JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
    } catch { /* fall through */ }
  }
  try {
    return (JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json"), "utf8")) as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** True when a `pi-web.service` user unit exists and was restarted. */
export function restartUserServer(): boolean {
  if (process.platform === "win32") return false;
  try {
    const unit = path.join(process.env.HOME ?? "", ".config", "systemd", "user", "pi-web.service");
    if (!fs.existsSync(unit)) return false;
    const child = spawn("systemctl", ["--user", "restart", "pi-web"], { stdio: "ignore", shell: false });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/** The human one-screen answer `pi-web update` prints. */
export function formatUpdate(report: UpdateReport): string {
  const lines = [
    `${PACKAGE_NAME}`,
    `  running:  ${report.installed}`,
    `  ${report.tag}: ${report.available ?? "(unreachable)"}`,
    ...(report.packageDir !== null ? [`  install:  ${report.packageDir}`] : []),
    `  ${report.reason}`,
  ];
  if (report.restarted) lines.push("  restarted: pi-web is running the new build");
  lines.push(`  next:     ${report.nextStep}`);
  return lines.join("\n");
}
