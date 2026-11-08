/**
 * Stamp a canary version onto every publishable manifest, CI-only.
 *
 *   node scripts/set-canary-version.mts <base-version> <canary-version>
 *
 * Rewrites `version` in every package reported by `scripts/publish-list.mts` (today:
 * shared, pi-adapter, pi-extension, server) from <base> to <canary>, and pins the internal
 * `@piwebui/*` dependency ranges to the same <canary> so a canary build of the server can
 * never resolve its shared/adapter deps to an older stable release. Nothing is committed
 * back to git, which is why the ranges can be pinned exactly: the working tree is thrown
 * away when the job ends and main keeps the caret ranges.
 *
 * The package list is imported, not written out here, so a package added to the workspace is
 * stamped automatically instead of being published at the old version.
 *
 * Refuses to run unless every manifest is exactly at <base>, so a drifted version fails loud
 * instead of publishing a Frankenstein set.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publishablePackages } from "./publish-list.mts";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKGS = publishablePackages(ROOT);
const NAMES = new Set(PKGS.map((p) => p.name));

const [base, canary] = process.argv.slice(2);
if (!base || !canary) {
  console.error("usage: set-canary-version.mts <base-version> <canary-version>");
  process.exit(2);
}
if (!/^[0-9]+\.[0-9]+\.[0-9]+[-+][0-9A-Za-z.-]+$/.test(canary)) {
  console.error(`canary version "${canary}" is not a valid semver prerelease/build`);
  process.exit(2);
}

const files = PKGS.map((pkg) => {
  const p = pkg.dir;
  const file = path.join(ROOT, "packages", p, "package.json");
  const json = JSON.parse(fs.readFileSync(file, "utf8")) as {
    name: string;
    version: string;
    dependencies?: Record<string, string>;
  };
  if (json.version !== base) {
    console.error(`packages/${p}: version ${json.version} does not match base ${base}`);
    process.exit(1);
  }
  return { p, file, json };
});

for (const { p, file, json } of files) {
  const from = json.version;
  json.version = canary;
  const pinned: string[] = [];
  for (const dep of Object.keys(json.dependencies ?? {})) {
    if (!NAMES.has(dep)) continue;
    json.dependencies![dep] = canary;
    pinned.push(`${dep}@${canary}`);
  }
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  console.log(`packages/${p}: ${json.name} ${from} -> ${canary}${pinned.length ? ` (deps: ${pinned.join(", ")})` : ""}`);
}
