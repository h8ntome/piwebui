/**
 * The release configuration has to be *complete*, not just correct — a package that exists
 * in the workspace but is missing from the publish loop is never updated on npm, and nothing
 * fails when that happens. `@piwebui/pi-web-bridge` (`packages/pi-extension`) is the real
 * case: it landed with the terminal bridge while the release workflow still named only three
 * packages.
 *
 * These tests are the guard: the publish list is derived from the workspace manifests, every
 * leg of the release pipeline reads that same list, and each publishable manifest is actually
 * publishable (same version, public access, and the entry points it advertises on disk).
 *
 *   npx tsx --test scripts/test/publish-list.test.mts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { dirList, nameList, publishablePackages, ROOT, workspaceDirs } from "../publish-list.mts";

const NAMES = ["@piwebui/shared", "@piwebui/pi-adapter", "@piwebui/pi-web-bridge", "@piwebui/pi-web"];
const readJson = (rel: string) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), "utf8")) as Record<string, any>;

test("the bridge is part of the publish list, in dependency order", () => {
  const names = publishablePackages().map((p) => p.name);
  assert.deepEqual(names, NAMES, `publish list is ${names.join(", ")}`);
  assert.ok(names.includes("@piwebui/pi-web-bridge"), "@piwebui/pi-web-bridge must be published by CI");
  // shared before its consumers, server last: npm publish order.
  assert.ok(names.indexOf("@piwebui/shared") < names.indexOf("@piwebui/pi-adapter"));
  assert.ok(names.indexOf("@piwebui/pi-adapter") < names.indexOf("@piwebui/pi-web"));
  assert.equal(publishablePackages().at(-1)!.dir, "server");
});

test("every non-private workspace is published; only the client is private", () => {
  const expected = workspaceDirs().filter((dir) => {
    const file = path.join(ROOT, "packages", dir, "package.json");
    return fs.existsSync(file) && readJson(`packages/${dir}/package.json`).private !== true;
  });
  assert.deepEqual(publishablePackages().map((p) => p.dir), expected, "a workspace package is missing from the publish list");
  assert.ok(!nameList().includes("@piwebui/client"), "the client ships inside @piwebui/pi-web as client-dist; it must stay private");
});

test("all publishable manifests agree on one version and are publish-ready", () => {
  const versions = new Set(publishablePackages().map((p) => p.version));
  assert.equal(versions.size, 1, `manifests drifted: ${[...versions].join(", ")} — the release workflow refuses to publish a mixed set`);
  for (const p of publishablePackages()) {
    const json = readJson(`packages/${p.dir}/package.json`);
    assert.equal(json.publishConfig?.access, "public", `${p.name}: must be public (the workflow also passes --access public)`);
    assert.ok(json.description, `${p.name}: npm lists an empty description`);
    assert.ok(json.license, `${p.name}: no license`);
    assert.equal(json.repository?.url, "git+https://github.com/h8ntome/piwebui.git", `${p.name}: repository must point at the public repo`);
    assert.ok(!JSON.stringify(json.dependencies ?? {}).includes("workspace:"), `${p.name}: workspace:* ranges make the published tarball uninstallable`);
  }
});

test("the bridge advertises an extension file that actually exists and ships", () => {
  const bridge = publishablePackages().find((p) => p.name === "@piwebui/pi-web-bridge")!;
  assert.ok(bridge.piExtensions.length, "@piwebui/pi-web-bridge declares no pi.extensions — pi would install a package with nothing to load");
  const json = readJson("packages/pi-extension/package.json");
  for (const rel of bridge.piExtensions) {
    const clean = rel.replace(/^\.\//, "");
    assert.ok(fs.existsSync(path.join(ROOT, "packages", "pi-extension", clean)), `pi.extensions points at a missing file: ${clean}`);
    const covered = (json.files ?? []).some((f: string) => clean === f || clean.startsWith(`${f.replace(/\/$/, "")}/`));
    assert.ok(covered, `${clean} is outside the \`files\` allowlist, so the published tarball would not contain it`);
  }
});

test("the release workflow and the canary stamp read the list instead of naming packages", () => {
  const wf = fs.readFileSync(path.join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.match(wf, /publish-list\.mts --gh/, "release.yml must resolve the package list from scripts/publish-list.mts");
  assert.match(wf, /steps\.pkgs\.outputs\.dirs/, "every package loop in release.yml must iterate steps.pkgs.outputs.dirs");
  assert.match(wf, /steps\.pkgs\.outputs\.names/, "the run summary must iterate steps.pkgs.outputs.names");
  // A hardcoded `for p in shared ...` anywhere else is a loop that will silently skip a package.
  assert.equal((wf.match(/for p in (?!$|\$\{|\$)[a-z]/gm) ?? []).length, 0, "release.yml has a hardcoded package list");
  assert.equal((wf.match(/for n in @(?!$|\$)/gm) ?? []).length, 0, "release.yml has a hardcoded package-name list");
  const stamp = fs.readFileSync(path.join(ROOT, "scripts", "set-canary-version.mts"), "utf8");
  assert.match(stamp, /publishablePackages/, "set-canary-version.mts must stamp every publishable package, not a hardcoded three");
  assert.equal(dirList().split(" ").length, 4, "expected four publishable packages");
});

test("the server is the only package that puts a command on PATH", () => {
  const cli = publishablePackages().filter((p) => p.cli);
  assert.deepEqual(cli.map((p) => p.name), ["@piwebui/pi-web"], "scripts/cli-names.mts only verifies the server's bin map");
});
