/**
 * Verify what npm actually serves, end to end, the way a user does it.
 *
 *   node scripts/verify-published.mts                       # default dist-tag: latest
 *   node scripts/verify-published.mts --tag next
 *   node scripts/verify-published.mts --version 0.1.1
 *   node scripts/verify-published.mts --tag latest --settle 120   # wait out registry read-replica lag
 *   node scripts/verify-published.mts --tag latest --expect-version 0.1.1
 *
 * `--expect-version` is the assertion that the *tag* actually moved: publishing a version
 * and pointing `latest` at it are two things that can fail independently.
 *
 * `--settle <seconds>` polls for up to that long before giving up: npm's read replica
 * lags the write by up to a minute after a publish, so a verify run fired straight after
 * `npm publish` must not treat the first `404` as the truth.
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

const argv = process.argv.slice(2);
const flag = (name: string, fallback = ""): string => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-verify-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

console.log(`verifying ${pkgName} ${label} from ${process.env.npm_config_registry || "https://registry.npmjs.org"}`);

// 1. what does the registry say this tag points at? (retry while the read replica catches up)
let view = npm(["view", spec, "--json"]);
for (let waited = 0; view.status !== 0 && waited < settleMs; ) {
  const err0 = `${view.stdout}${view.stderr}`;
  if (!/E404|not found/i.test(err0)) break;
  const step = 10_000;
  console.log(`   not visible yet (npm read replica lags the write); retrying in ${step / 1000}s`);
  await sleep(step);
  waited += step;
  view = npm(["view", spec, "--json"]);
}
if (view.status !== 0) {
  const err = `${view.stdout}${view.stderr}`;
  if (/E404|not found/i.test(err)) {
    fail(`the registry has no ${spec} (404) — nothing is published under ${label}, so \`npm i -g\` has nothing to install. ${err.trim().slice(0, 300)}`);
  }
  fail(`npm view failed (${view.status}): ${err.trim().slice(0, 400)}`);
}
let manifest: { version?: string; bin?: Record<string, string> | string } = {};
try {
  manifest = JSON.parse(view.stdout) as typeof manifest;
} catch {
  fail(`could not parse \`npm view ${spec} --json\`: ${view.stdout.trim().slice(0, 200)}`);
}
const version = manifest.version ?? "";
// `bin` may be a bare string (`"bin": "./cli.js"`), in which case npm names the command
// after the package, which is never what our docs promise.
const rawBin = manifest.bin;
const binMap: Record<string, string> =
  typeof rawBin === "string" ? { [pkgName]: rawBin } : (rawBin ?? {});
if (!version) fail(`the published manifest for ${spec} has no version: ${view.stdout.trim().slice(0, 200)}`);
if (expectVersion && version !== expectVersion) {
  fail(`${label} resolves to ${version}, not the ${expectVersion} that was just published — the publish did not move the tag (or it moved to an older version).`);
}
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
const ins = npm(["install", "-g", "--no-audit", "--no-fund", "--prefix", prefix, spec]);
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
