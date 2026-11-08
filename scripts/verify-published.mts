/**
 * Verify what npm actually serves, end to end, the way a user does it.
 *
 *   node scripts/verify-published.mts                       # default dist-tag: latest
 *   node scripts/verify-published.mts --tag next
 *   node scripts/verify-published.mts --version 0.1.1
 *   node scripts/verify-published.mts --tag latest --settle 120   # wait out registry read-replica lag
 *   node scripts/verify-published.mts --tag latest --expect-version 0.1.1
 *   node scripts/verify-published.mts --tag next  --expect-version 0.1.1 --all
 *
 * `--all` extends the check from the CLI to *every* publishable package: each one must exist
 * at the released version, must have the requested dist-tag pointing at that version, and must
 * ship the entry points its own manifest advertises. Without it a release proves only that
 * `@piwebui/pi-web` works, and a package whose `files` allowlist ships nothing usable — or
 * whose publish was simply missing from the workflow's list — passes unnoticed.
 * `--allow-missing "<names>"` downgrades the listed packages to a warning; the release
 * workflow passes the packages it could not publish (no trusted publisher yet) so the run
 * reports them without failing the packages that did land.
 *
 * `--expect-version` is the assertion that the *tag* actually moved: publishing a version
 * and pointing `latest` at it are two things that can fail independently.
 *
 * `--settle <seconds>` polls for up to that long before giving up: npm's read replica
 * lags the write by minutes after a publish, so a verify run fired straight after
 * `npm publish` must not treat the first `404` — or a dist-tag that still resolves to the
 * previous version — as the truth.
 *
 * `check-cli-names.mts` proves the repository is self-consistent; it cannot see the
 * artifact already on the registry. This script closes that gap, because the reported
 * failure — `npm install -g @piwebui/pi-web` then `zsh: command not found: pi-web` —
 * came from a published version (`0.1.0`) whose `bin` map predated the command rename
 * and therefore installed only `piweb`. Only the registry can answer "what will a new
 * install get?".
 *
 * Steps, all against the live registry and in throwaway directories:
 *   1. resolve the dist-tag to a concrete version and read its published manifest;
 *   2. require every documented command name in that manifest's `bin` map;
 *   3. `npm pack` the tarball and confirm each declared bin target ships inside it
 *      (a manifest can name a file the pack never included);
 *   4. `npm install -g` into a scratch prefix and run `<cmd> --version` from an
 *      unrelated cwd, exactly as the README instructs.
 *
 * Exits non-zero with the reason, so CI can gate a release on it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLI_NAMES, SERVER_PKG_NAME } from "./cli-names.mts";
import { publishablePackages } from "./publish-list.mts";

const argv = process.argv.slice(2);
const flag = (name: string, fallback = ""): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const all = argv.includes("--all");

const pkgName = process.env.PIWEB_VERIFY_PKG || SERVER_PKG_NAME;
const spec = flag("version") ? `${pkgName}@${flag("version")}` : `${pkgName}@${flag("tag", "latest")}`;
const label = flag("version") ? `version ${flag("version")}` : `dist-tag "${flag("tag", "latest")}"`;
const expectVersion = flag("expect-version");

const ok = (m: string) => console.log(` ✔ ${m}`);
const fail = (m: string): never => {
  console.error(` ✘ ${m}`);
  console.error(`   checked ${spec}`);
  process.exit(1);
};

const npm = (args: string[], cwd?: string) =>
  spawnSync("npm", args, { cwd, encoding: "utf8", env: process.env, timeout: 600_000 });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const settleMs = Math.max(0, Number(flag("settle", "0") || 0)) * 1000;
// One deadline for every lag wait in the run, so `--settle 300` means "spend at most 5
// minutes total outlasting the replica", never "5 minutes per phase".
const lagDeadline = Date.now() + settleMs;
const LAGGED = /ETARGET|E404|NO MATCH FOUND|NOT FOUND|404/i;
/** True while the registry could still legitimately come good on this version. */
const mayStillBeLagging = (out: string) => LAGGED.test(out) && Date.now() < lagDeadline;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-verify-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

console.log(`verifying ${pkgName} ${label} from ${process.env.npm_config_registry || "https://registry.npmjs.org"}`);

// 1. what does the registry say this tag points at? Retry while the read replica catches up.
// Two transients live here, and only one of them looks like an error: a version that was
// published seconds ago is routinely invisible for minutes, and a dist-tag that has not
// propagated yet answers with the *previous* version rather than failing. Both must be
// waited out, or a perfectly good release is reported as a missing one.
let manifest: { version?: string; bin?: Record<string, string> | string } = {};
let version = "";
let out = npm(["view", spec, "--json"]);
for (; ; ) {
  const err0 = `${out.stdout}${out.stderr}`;
  let why = "";
  if (out.status !== 0) {
    if (!/E404|not found/i.test(err0)) fail(`npm view failed (${out.status}): ${err0.trim().slice(0, 400)}`);
    why = `the registry has no ${spec} yet (404)`;
  } else {
    try {
      manifest = JSON.parse(out.stdout) as typeof manifest;
    } catch {
      fail(`could not parse \`npm view ${spec} --json\`: ${out.stdout.trim().slice(0, 200)}`);
    }
    version = manifest.version ?? "";
    if (!version) fail(`the published manifest for ${spec} has no version: ${out.stdout.trim().slice(0, 200)}`);
    if (expectVersion && version !== expectVersion) why = `${label} still resolves to ${version}, not the ${expectVersion} that was just published`;
  }
  if (!why) break;
  if (Date.now() >= lagDeadline) {
    if (why.startsWith("the registry has no")) {
      fail(`${why} — nothing is published under ${label}, so \`npm i -g\` has nothing to install. ${err0.trim().slice(0, 300)}`);
    }
    fail(`${why} — the tag has not moved after ${Math.round(settleMs / 1000)}s of retrying (or it moved to an older version).`);
  }
  const step = 15_000;
  console.log(`   ${why}; npm read replica lags the write, retrying in ${step / 1000}s`);
  await sleep(step);
  out = npm(["view", spec, "--json"]);
}
// `bin` may be a bare string (`"bin": "./cli.js"`), in which case npm names the command
// after the package, which is never what our docs promise.
const rawBin = manifest.bin;
const binMap: Record<string, string> =
  typeof rawBin === "string" ? { [pkgName]: rawBin } : (rawBin ?? {});
ok(`${spec} -> ${version}${expectVersion ? ` (as expected)` : ""}`);

// 2. does the published manifest put every documented command on PATH?
const shipped = Object.keys(binMap);
if (!shipped.length) {
  fail(`${version} declares no \`bin\` at all, so \`npm i -g ${pkgName}\` installs a package with no command on PATH.`);
}
for (const name of CLI_NAMES) {
  if (!shipped.includes(name)) {
    fail(
      `${version} ships \`bin\` = ${JSON.stringify(binMap)}: the documented command \`${name}\` is absent, ` +
        `so \`npm i -g ${pkgName}\` succeeds and then \`${name}\` is not found. ` +
        `Publish the version whose manifest has \`${name}\`, or restore it to \`bin\`.`,
    );
  }
}
ok(`bin map declares ${CLI_NAMES.map((n) => `\`${n}\``).join(", ")}`);

// 3. is each declared target actually inside the shipped tarball?
const packed = npm(["pack", spec, "--pack-destination", tmp]);
if (packed.status !== 0) fail(`npm pack ${spec} failed: ${(packed.stdout + packed.stderr).trim().slice(0, 400)}`);
const tarball = fs.readdirSync(tmp).filter((f) => f.endsWith(".tgz")).map((f) => path.join(tmp, f))[0];
if (!tarball) fail(`npm pack ${spec} produced no .tgz in ${tmp}`);
const listing = spawnSync("tar", ["tzf", tarball], { encoding: "utf8" });
if (listing.status !== 0) fail(`could not list ${tarball}: ${listing.stderr.slice(0, 200)}`);
const entries = new Set(listing.stdout.trim().split("\n").map((l) => l.replace(/^\.\//, "")));
const pkgRoot = [...entries][0]?.split("/")[0] ?? "package";
for (const name of CLI_NAMES) {
  const target = (binMap[name] ?? "").replace(/^\.\//, "");
  if (!target) continue;
  if (!entries.has(`${pkgRoot}/${target}`)) {
    fail(`\`bin.${name}\` declares ${target} but the published tarball does not contain it (files allowlist excluded it?)`);
  }
}
for (const must of ["dist/main.js", "client-dist/index.html"]) {
  if (!entries.has(`${pkgRoot}/${must}`)) {
    fail(`the published tarball is missing ${must}; the launcher would fall back to sources that a global install does not have`);
  }
}
const declaredTargets = [...new Set(CLI_NAMES.map((n) => (binMap[n] ?? "").replace(/^\.\//, "")))].filter(Boolean);
ok(`tarball contains ${declaredTargets.join(", ")}, dist/main.js and client-dist/index.html (${entries.size} files)`);

// 4. the real user path: global install into a scratch prefix, run from a foreign cwd.
const prefix = path.join(tmp, "prefix");
fs.mkdirSync(prefix, { recursive: true });
// The canary manifest pins its internal deps to the canary version, so this install fails
// with ETARGET while the replica still serves the dependency graph from before the publish —
// the same lag as step 1, one layer down, and it takes the whole install with it.
let ins = npm(["install", "-g", "--no-audit", "--no-fund", "--prefix", prefix, spec]);
for (let n = 0; ins.status !== 0 && mayStillBeLagging(`${ins.stdout}${ins.stderr}`); n++) {
  const step = 15_000;
  const code = /npm error code (\w+)/.exec(`${ins.stdout}${ins.stderr}`)?.[1] ?? "lag";
  console.log(`   global install hit registry lag (${code}#${n + 1}); retrying in ${step / 1000}s`);
  await sleep(step);
  ins = npm(["install", "-g", "--no-audit", "--no-fund", "--prefix", prefix, spec]);
}
if (ins.status !== 0) fail(`npm install -g ${spec} failed: ${(ins.stdout + ins.stderr).trim().slice(-500)}`);
ok(`npm i -g ${spec} installed`);

for (const name of CLI_NAMES) {
  const link = path.join(prefix, "bin", name);
  if (!fs.existsSync(link)) fail(`a global install of ${version} put no \`${name}\` in ${prefix}/bin (got: ${fs.readdirSync(path.join(prefix, "bin")).join(", ") || "nothing"})`);
  const run = spawnSync(link, ["--version"], { cwd: os.tmpdir(), encoding: "utf8", timeout: 120_000, env: process.env });
  const out = `${run.stdout ?? ""}${run.stderr ?? ""}`;
  if (run.status !== 0 || !out.includes(version)) {
    fail(`\`${name} --version\` did not report ${version} (status ${run.status}): ${out.trim().slice(0, 300)}`);
  }
  ok(`\`${name} --version\` -> ${out.trim()}`);
}

console.log(`\n${pkgName}@${version} is installable and answers to ${CLI_NAMES.map((n) => `\`${n}\``).join(" and ")}.`);

/**
 * 5. every other publishable package, so a release is proven for the whole set.
 *
 * The tarball inspection is per package: the bridge is a `pi` extension whose whole contract
 * is the file listed under `pi.extensions`, so a published tarball that omits it installs
 * cleanly and does nothing at all. The dist-tag check is the one that catches a package that
 * published but whose tag never moved — the `latest`/`pi-web` incident, in package form.
 */
if (all) {
  const tag = flag("tag");
  const allowMissing = new Set(flag("allow-missing").split(/\s+/).filter(Boolean));
  const others = publishablePackages().filter((p) => p.name !== pkgName);
  const skipped: string[] = [];
  const viewSettled = async (args: string[]) => {
    let r = npm(args);
    while (r.status !== 0 && Date.now() < lagDeadline) {
      const step = 15_000;
      console.log(`   ${args[1]} not visible yet; retrying in ${step / 1000}s`);
      await sleep(step);
      r = npm(args);
    }
    return r;
  };
  if (!others.length) ok("--all: no other publishable packages to check");
  for (const pkg of others) {
    if (allowMissing.has(pkg.name)) {
      skipped.push(pkg.name);
      console.log(` ⚠ ${pkg.name} was not published this run (npm has no trusted publisher registered for it) — not verified`);
      continue;
    }
    const found = await viewSettled(["view", `${pkg.name}@${version}`, "version", "--json"]);
    if (found.status !== 0) {
      fail(`--all: ${pkg.name}@${version} is not on the registry (${(found.stdout + found.stderr).trim().slice(0, 200)}) — it was not published, or its publish did not land`);
    }
    if (tag) {
      // `dist-tags.<tag>`, not `<tag>.version`: the latter asks for `.version` on a string
      // and npm answers with empty output and exit 0, so a query can never fail loudly.
      const t = await viewSettled(["view", pkg.name, `dist-tags.${tag}`, "--json"]);
      const got = String(JSON.parse(t.stdout || "null") ?? "");
      if (t.status !== 0 || got !== version) {
        fail(`--all: ${pkg.name} dist-tag "${tag}" points at ${got || "nothing"}, not ${version} — that package's tag did not move with the release`);
      }
    }
    const packed = npm(["pack", `${pkg.name}@${version}`, "--pack-destination", tmp]);
    if (packed.status !== 0) fail(`--all: npm pack ${pkg.name}@${version} failed: ${(packed.stdout + packed.stderr).trim().slice(0, 300)}`);
    // npm names a scoped tarball after `scope-name-version.tgz`; take the name it printed
    // instead of rebuilding it (a guessed prefix silently matched nothing).
    const said = packed.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
    const tgzPath = said ? path.join(tmp, path.basename(said)) : "";
    if (!tgzPath || !fs.existsSync(tgzPath)) {
      fail(`--all: npm pack ${pkg.name}@${version} produced no tarball in ${tmp} (npm said: ${said.slice(0, 120) || "nothing"})`);
    }
    const listing = spawnSync("tar", ["tzf", tgzPath], { encoding: "utf8" });
    const entries = new Set(listing.stdout.trim().split("\n").filter(Boolean).map((l) => l.replace(/^\.\//, "")));
    const root_ = [...entries][0]?.split("/")[0] ?? "package";
    const files = [...entries].filter((e) => e.split("/").length > 1);
    if (!files.length) fail(`--all: the published ${pkg.name} tarball contains nothing but its manifest`);
    const missing = pkg.piExtensions
      .map((rel) => rel.replace(/^\.\//, ""))
      .filter((rel) => !entries.has(`${root_}/${rel}`));
    if (missing.length) {
      fail(`--all: ${pkg.name}@${version} advertises pi.extensions ${missing.map((m) => `\`${m}\``).join(", ")} but the published tarball does not contain ${missing.map((m) => `\`${m}\``).join(", ")} — \`pi install\` would resolve a file that is not there`);
    }
    ok(`${pkg.name}@${version}${tag ? ` on "${tag}"` : ""}: ${files.length} files${pkg.piExtensions.length ? `, pi extensions present (${pkg.piExtensions.length})` : ""}`);
  }
  const checked = others.length - skipped.length;
  if (checked) console.log(`\n${checked} of ${others.length + 1} publishable packages verified at ${version}${skipped.length ? `; ${skipped.length} skipped (${skipped.join(", ")})` : ""}.`);
}
