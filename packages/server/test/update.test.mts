/**
 * `pi-web update`: the part that decides whether a newer build exists, and where it would go.
 *
 * The two failure modes this suite is really about are the ones that made a user sit on a
 * four-day-old UI with no clue: a version comparison that treats `0.1.2-canary.2` as newer than
 * `0.1.2`, and an updater that asks npm where the "global" prefix is on a machine holding two
 * Node installs and then updates the one that is not running.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  compareVersions,
  defaultTag,
  installedPackageDir,
  performUpdate,
  prefixFor,
  updatePlan,
} from "../src/update.ts";

test("canary ordering: more commits win, and a release outranks its own canaries", () => {
  assert.equal(compareVersions("0.1.2-canary.2.aaa", "0.1.2-canary.10.bbb"), -1);
  assert.equal(compareVersions("0.1.2-canary.10.bbb", "0.1.2-canary.2.aaa"), 1);
  assert.equal(compareVersions("0.1.2", "0.1.2-canary.19.abc"), 1);
  assert.equal(compareVersions("0.1.1", "0.1.2-canary.1.x"), -1);
  assert.equal(compareVersions("0.1.1", "0.1.1"), 0);
  assert.equal(compareVersions("0.2.0", "0.1.99"), 1);
});

test("a canary follows @next and a release follows @latest", () => {
  assert.equal(defaultTag("0.1.2-canary.19.098167c"), "next");
  assert.equal(defaultTag("0.1.1"), "latest");
  assert.equal(defaultTag("1.0.0-rc.3"), "next");
});

test("the prefix comes from the path being run, not from npm's opinion", () => {
  assert.equal(prefixFor("/node/lib/node_modules/@piwebui/pi-web"), "/node");
  assert.equal(prefixFor("/home/dev/.local/lib/node_modules/node/lib/node_modules/@piwebui/pi-web"), "/home/dev/.local/lib/node_modules/node");
  assert.equal(prefixFor("/opt/pi/lib/node_modules/@piwebui/pi-web"), "/opt/pi");
  // A plain (non-global) install updates in place, and the prefix is its node_modules parent.
  assert.equal(prefixFor("/repo/node_modules/@piwebui/pi-web"), "/repo");
  assert.equal(prefixFor("/standalone/pi-web"), null);
});

test("a built checkout is refused rather than overwritten", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-update-"));
  fs.mkdirSync(path.join(dir, "packages/server/dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "packages/server/package.json"), JSON.stringify({ name: "@piwebui/pi-web", version: "0.1.1" }));
  // No dist/main.js => not an installed build.
  assert.equal(installedPackageDir(path.join(dir, "packages/server/dist")), null);
  fs.mkdirSync(path.join(dir, "packages/server/client-dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "packages/server/dist/main.js"), "// built\n");
  assert.equal(installedPackageDir(path.join(dir, "packages/server/dist")), path.join(dir, "packages/server"));
  fs.rmSync(dir, { recursive: true, force: true });
});

test("the plan says what to do, including when the registry is unreachable", () => {
  const facts = { installed: "0.1.0", tag: "latest", packageDir: "/node/lib/node_modules/@piwebui/pi-web", reason: "" };
  assert.equal(updatePlan({ ...facts, available: "0.1.1" }).action, "update-available");
  assert.equal(updatePlan({ ...facts, available: "0.1.0" }).action, "up-to-date");
  assert.match(updatePlan({ ...facts, available: null }).reason, /could not read/);
  const checkout = updatePlan({ ...facts, packageDir: null, available: "0.1.1" });
  assert.equal(checkout.action, "unknown");
  assert.match(checkout.reason, /git checkout/);
});

test("update --check installs nothing and tells you the command", async () => {
  let installs = 0;
  const report = await performUpdate(
    { check: true, tag: "next", restart: false, json: false },
    {
      installed: "0.1.2-canary.19.a",
      packageDir: "/node/lib/node_modules/@piwebui/pi-web",
      latest: async () => "0.1.2-canary.20.b",
      install: async () => { installs += 1; },
    },
  );
  assert.equal(report.action, "update-available");
  assert.equal(installs, 0, "--check never installs");
  assert.match(report.nextStep, /pi-web update/);
});

test("update installs into the prefix this file was loaded from, then says to restart", async () => {
  const calls: string[][] = [];
  const report = await performUpdate(
    { check: false, tag: undefined, restart: false, json: false },
    {
      installed: "0.1.0",
      packageDir: "/node/lib/node_modules/@piwebui/pi-web",
      latest: async () => "0.1.1",
      install: async (_npm, prefix, tag) => { calls.push([prefix ?? "", tag]); },
      npm: "npm",
    },
  );
  assert.deepEqual(calls, [["/node", "latest"]], "the running install's own prefix, on its own tag");
  assert.equal(report.installed, "0.1.1");
  assert.match(report.nextStep, /restart pi-web/);
});

test("a reachable registry that is already newest is a no-op, and unreachable is not an error", async () => {
  const fresh = await performUpdate({ check: true, tag: "latest", restart: false, json: false }, {
    installed: "0.1.1",
    packageDir: "/node/lib/node_modules/@piwebui/pi-web",
    latest: async () => "0.1.1",
  });
  assert.equal(fresh.action, "up-to-date");
  assert.match(fresh.reason, /already the newest/);

  const offline = await performUpdate({ check: true, tag: "latest", restart: false, json: false }, {
    installed: "0.1.1",
    packageDir: "/node/lib/node_modules/@piwebui/pi-web",
    latest: async () => null,
  });
  assert.equal(offline.action, "unknown");
  assert.equal(offline.available, null);
});
