/**
 * Descriptor resolution (bridge_plan 02 §2.2): search order, first-hit-wins, malformed and stale
 * descriptors must be *reported*, never looped on, and every escape hatch must work.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { parseDescriptor, resolveServers } from "../extensions/pi-web-bridge.js";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A descriptor the resolver will accept: the socket exists and the pid is us. */
function goodDescriptor(dir: string, serverId = "srv1"): { path: string; token: string } {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socket = path.join(dir, `bridge-${serverId}.sock`);
  fs.writeFileSync(socket, ""); // existsSync is what the resolver checks
  const token = "A".repeat(32);
  const file = path.join(dir, "bridge.json");
  fs.writeFileSync(file, JSON.stringify({
    v: 1, serverId, protocol: [1], socket, token, http: "http://127.0.0.1:4319",
    dataDir: dir, pid: process.pid, procStart: Math.floor(performance.timeOrigin), updatedAt: new Date().toISOString(),
  }), { mode: 0o600 });
  return { path: file, token };
}

test("PIWEB_BRIDGE_DISABLE wins over everything and starts nothing", () => {
  const dir = tmp("piweb-desc-");
  const d = goodDescriptor(dir);
  const r = resolveServers({ env: { PIWEB_BRIDGE_DISABLE: "1", PIWEB_BRIDGE_FILE: d.path }, homedir: dir, fsImpl: fs });
  assert.equal(r.disabled, true);
  assert.equal(r.servers.length, 0);
});

test("PIWEB_BRIDGE_FILE is step 2 and beats the default path", () => {
  const dir = tmp("piweb-desc-");
  const wanted = goodDescriptor(path.join(dir, "a"), "explicit");
  goodDescriptor(path.join(dir, "b"), "default");
  const r = resolveServers({
    env: { PIWEB_BRIDGE_FILE: wanted.path, PIWEB_DATA_DIR: path.join(dir, "b") },
    homedir: dir, fsImpl: fs,
  });
  assert.equal(r.servers.length, 1);
  assert.equal(r.servers[0].serverId, "explicit");
  assert.equal(r.servers[0].token, wanted.token);
});

test("inline socket+token descriptor works without any file (containers, tests)", () => {
  const dir = tmp("piweb-desc-");
  const socket = path.join(dir, "x.sock");
  fs.writeFileSync(socket, "");
  const r = resolveServers({
    env: { PIWEB_BRIDGE_SOCKET: socket, PIWEB_BRIDGE_TOKEN: "B".repeat(40) },
    homedir: dir, fsImpl: fs,
  });
  assert.equal(r.servers.length, 1);
  assert.equal(r.servers[0].socket, socket);
  assert.equal(r.servers[0].serverId, "inline");
});

test("PIWEB_DATA_DIR is used, and the sibling-of-agent-dir heuristic runs before ~/.pi-web", () => {
  const dir = tmp("piweb-desc-");
  const agentDir = path.join(dir, "custom", "agent");
  const sibling = goodDescriptor(path.join(dir, "custom", "pi-web"), "sibling");
  goodDescriptor(path.join(dir, ".pi-web"), "home");
  const r = resolveServers({ env: { PI_CODING_AGENT_DIR: agentDir }, homedir: dir, fsImpl: fs });
  assert.equal(r.servers.length, 1, `notes: ${r.notes.join("; ")}`);
  assert.equal(r.servers[0].serverId, "sibling");
  assert.equal(r.servers[0].descriptorPath, sibling.path);
});

test("a malformed descriptor is named, not retried silently, and the next candidate still wins", () => {
  const dir = tmp("piweb-desc-");
  fs.mkdirSync(path.join(dir, "bad"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bad", "bridge.json"), "{not json");
  const good = goodDescriptor(path.join(dir, ".pi-web"), "fallback");
  const r = resolveServers({ env: { PIWEB_DATA_DIR: path.join(dir, "bad") }, homedir: dir, fsImpl: fs });
  assert.equal(r.servers.length, 1);
  assert.equal(r.servers[0].serverId, "fallback");
  assert.ok(r.notes.some((n: string) => n.includes("malformed")), r.notes.join("; "));
  assert.ok(good.path);
});

test("a stale descriptor (dead pid) is refused with a reason", () => {
  const dir = tmp("piweb-desc-");
  const d = goodDescriptor(dir);
  const raw = JSON.parse(fs.readFileSync(d.path, "utf8"));
  raw.pid = 999_999; // no such process
  fs.writeFileSync(d.path, JSON.stringify(raw));
  const r = resolveServers({ env: { PIWEB_BRIDGE_FILE: d.path }, homedir: dir, fsImpl: fs });
  assert.equal(r.servers.length, 0);
  assert.ok(r.notes.some((n: string) => n.includes("not running")), r.notes.join("; "));
});

test("a descriptor whose socket vanished is refused with a reason", () => {
  const dir = tmp("piweb-desc-");
  const d = goodDescriptor(dir);
  const raw = JSON.parse(fs.readFileSync(d.path, "utf8"));
  fs.unlinkSync(raw.socket);
  fs.writeFileSync(d.path, JSON.stringify(raw));
  const r = resolveServers({ env: { PIWEB_BRIDGE_FILE: d.path }, homedir: dir, fsImpl: fs });
  assert.equal(r.servers.length, 0);
  assert.ok(r.notes.some((n: string) => n.includes("does not exist")), r.notes.join("; "));
});

test("pointer files fan out to additional servers (two servers, one pi)", () => {
  const dir = tmp("piweb-desc-");
  const home = path.join(dir, ".pi-web");
  const a = goodDescriptor(home, "a");
  const otherDir = path.join(dir, "elsewhere");
  const b = goodDescriptor(otherDir, "b");
  fs.mkdirSync(path.join(home, "servers"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, "servers", "b.json"), JSON.stringify({ descriptor: b.path }));
  const r = resolveServers({ env: { PIWEB_BRIDGE_FILE: a.path }, homedir: dir, fsImpl: fs });
  const ids = r.servers.map((s: { serverId: string }) => s.serverId).sort();
  assert.deepEqual(ids, ["a", "b"]);
});

test("PIWEB_BRIDGE_MAX_SERVERS bounds the fan-out", () => {
  const dir = tmp("piweb-desc-");
  const home = path.join(dir, ".pi-web");
  const a = goodDescriptor(home, "a");
  const b = goodDescriptor(path.join(dir, "other"), "b");
  fs.mkdirSync(path.join(home, "servers"), { recursive: true });
  fs.writeFileSync(path.join(home, "servers", "b.json"), JSON.stringify({ descriptor: b.path }));
  const r = resolveServers({ env: { PIWEB_BRIDGE_FILE: a.path, PIWEB_BRIDGE_MAX_SERVERS: "1" }, homedir: dir, fsImpl: fs, maxServers: 1 });
  assert.equal(r.servers.length, 1);
  assert.ok(r.notes.some((n: string) => n.includes("MAX_SERVERS")), r.notes.join("; "));
});

test("legacy registry mode is only picked up when the token is long enough", () => {
  const dir = tmp("piweb-desc-");
  const env = { PIWEB_BRIDGE_TOKEN: "short", PIWEB_BRIDGE_DIR: path.join(dir, "bridges") };
  const short = resolveServers({ env, homedir: dir, fsImpl: fs });
  assert.equal(short.legacy, null);
  assert.ok(short.notes.some((n: string) => n.includes("shorter than 16")), short.notes.join("; "));
  const long = resolveServers({ env: { ...env, PIWEB_BRIDGE_TOKEN: "C".repeat(32) }, homedir: dir, fsImpl: fs });
  assert.ok(long.legacy);
  assert.equal(long.legacy.dir, path.join(dir, "bridges"));
});

test("PIWEB_BRIDGE_MODE=off disables everything, dial drops legacy", () => {
  const dir = tmp("piweb-desc-");
  const base = { PIWEB_BRIDGE_TOKEN: "C".repeat(32), PIWEB_BRIDGE_DIR: path.join(dir, "bridges") };
  assert.equal(resolveServers({ env: { ...base, PIWEB_BRIDGE_MODE: "off" }, homedir: dir, fsImpl: fs }).disabled, true);
  const dial = resolveServers({ env: { ...base, PIWEB_BRIDGE_MODE: "dial" }, homedir: dir, fsImpl: fs });
  assert.equal(dial.legacy, null);
});

test("parseDescriptor rejects the shapes that must never be trusted", () => {
  const p = "/tmp/bridge.json";
  assert.equal(parseDescriptor(null, p).ok, false);
  assert.equal(parseDescriptor([], p).ok, false);
  assert.equal(parseDescriptor({ v: 2, socket: "/s", token: "x".repeat(32), protocol: [1] }, p).reason, "unsupported_version");
  assert.equal(parseDescriptor({ v: 1, socket: "", token: "x".repeat(32), protocol: [1] }, p).reason, "no_socket");
  assert.equal(parseDescriptor({ v: 1, socket: "/s", token: "short", protocol: [1] }, p).reason, "no_token");
  assert.equal(parseDescriptor({ v: 1, socket: "/s", token: "x".repeat(32), protocol: [7] }, p).reason, "unsupported_protocol");
  assert.equal(parseDescriptor({ v: 1, socket: "/s", token: "x".repeat(32), protocol: [1] }, p).ok, true);
});
