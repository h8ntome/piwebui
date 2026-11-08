/**
 * Process-global hub lifecycle: the properties that make session switching work
 * (bridge_plan D-4, fixes B-5/B-7/B-11) and the failure modes that used to be silent.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import piWebBridge, { attach, createHub, createInstanceApi, handleCommand } from "../extensions/pi-web-bridge.js";
import { emit, fakeConn, makePi, shutdownSession, startSession } from "./fakepi.mts";

/** An empty home: nothing on this machine can leak into a unit test's server discovery. */
const emptyHome = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-emptyhome-"));

function freshHub(env: Record<string, string> = {}) {
  delete (globalThis as Record<string, unknown>).__piwebBridge;
  delete (globalThis as Record<string, unknown>).__piwebBridgeInstalled;
  const hub = createHub({
    env: { PIWEB_BRIDGE_MODE: "dial", PIWEB_DATA_DIR: "/nonexistent-piweb", ...env } as NodeJS.ProcessEnv,
    homedir: emptyHome,
  });
  createInstanceApi(hub);
  return hub;
}

/**
 * Install a sink with a stubbed resolver, so "the socket survives a session switch" can be
 * asserted without a real server on the other end of the pipe.
 */
function injectFakeServer(hub: ReturnType<typeof createHub>, serverId = "srv") {
  const conn = fakeConn(serverId);
  const spec = { serverId, socket: conn.spec.socket };
  hub.conns.set(`${serverId}:${spec.socket}`, conn as never);
  hub.rescanServers = () => {
    hub.resolution = { disabled: false, servers: [spec], notes: [], legacy: null };
  };
  return conn;
}

function eventCounts(hub: ReturnType<typeof createHub>) {
  return hub.ring.frames.map((f: { name: string }) => f.name);
}

test("the hub is a process singleton: runtimeId survives instances and reloads", () => {
  const hub = freshHub();
  const inst1 = makePi();
  attach(hub, inst1.pi);
  const runtimeId = hub.runtimeId;
  const inst2 = makePi();
  attach(hub, inst2.pi);
  assert.equal(hub.runtimeId, runtimeId, "runtimeId is minted once per process (D-4)");
  assert.equal(hub.pi, inst2.pi, "the freshest pi handle wins");
});

test("a second instance re-binds but does not wire a second copy of every handler", async () => {
  const hub = freshHub();
  const inst1 = makePi();
  const inst2 = makePi();
  attach(hub, inst1.pi, { wire: true });
  attach(hub, inst2.pi, { wire: false });
  await startSession(inst1, "startup");
  const starts = inst1.events.filter((e) => e.startsWith("session_start")).length;
  assert.equal(starts, 1, "one session_start handler, not two (B-7 double-load)");
  assert.equal(hub.wired, true);
  void inst2;
});

test("the real factory is idempotent through globalThis (double load: -e and the package)", async () => {
  delete (globalThis as Record<string, unknown>).__piwebBridge;
  delete (globalThis as Record<string, unknown>).__piwebBridgeInstalled;
  const inst1 = makePi();
  const inst2 = makePi();
  piWebBridge(inst1.pi as never);
  const hub = (globalThis as Record<string, never>).__piwebBridge as ReturnType<typeof createHub>;
  const runtimeId = hub.runtimeId;
  piWebBridge(inst2.pi as never);
  assert.equal(hub.runtimeId, runtimeId, "one hub, one connection set");
  await startSession(inst1, "startup");
  assert.equal(inst1.events.filter((e) => e.startsWith("session_start")).length, 1);
  assert.ok(hub.diag.notes.some((n: string) => n.includes("second bridge instance")), hub.diag.notes.join("; "));
});

test("session_start binds identity, clears session state and advertises to every server", async () => {
  const hub = freshHub();
  const inst = makePi({ sessionId: "01a1ba52-aaaa-7000-8000-000000000002", sessionFile: "/tmp/x.jsonl" });
  attach(hub, inst.pi);
  await startSession(inst, "startup");
  assert.equal(hub.sessionGeneration, 1);
  assert.equal(hub.sessionId, "01a1ba52-aaaa-7000-8000-000000000002");
  assert.equal(hub.sessionFile, "/tmp/x.jsonl");
  assert.ok(eventCounts(hub).includes("session_start"), eventCounts(hub).join(","));
  // A server that is already connected when the session changes gets a fresh hello.
  const conn = fakeConn("srv");
  hub.conns.set("srv", conn as never);
  hub.advertiseAll();
  assert.equal(conn.advertised, 1, "a server already connected is re-advertised");
  assert.equal(conn.closed, false);
  // And a server whose descriptor vanished is dropped instead of being dialled forever.
  hub.rescanServers();
  assert.equal(conn.closed, true);
  assert.equal(hub.conns.size, 0);
});

test("a live sink is kept across a switch while its descriptor still resolves", async () => {
  const hub = freshHub();
  const inst = makePi();
  attach(hub, inst.pi);
  await startSession(inst, "startup");
  const conn = injectFakeServer(hub);
  await startSession(inst, "reload");
  assert.equal(conn.closed, false, "still there: the descriptor did not change");
  assert.equal(conn.advertised, 1, "and it was re-advertised");
});

test("a non-tui pi never opens a bridge (pi -p, subagents, the managed host)", async () => {
  const hub = freshHub();
  const inst = makePi({ mode: "print" });
  attach(hub, inst.pi);
  const conn = fakeConn("srv");
  hub.conns.set("srv", conn as never);
  await startSession(inst, "startup");
  assert.equal(conn.closed, true, "existing connections are torn down for a print-mode run");
  assert.equal(hub.conns.size, 0);
  assert.ok(!eventCounts(hub).includes("session_start"), "nothing is broadcast from an unbridgeable mode");
  assert.ok(hub.resolution.disabled, "and the reason is recorded for /piweb");
});

test("PIWEB_BRIDGE_DISABLE and --no-pi-web-bridge both keep the process quiet", async () => {
  const hub = freshHub({ PIWEB_BRIDGE_DISABLE: "1" });
  const inst = makePi();
  attach(hub, inst.pi);
  await startSession(inst, "startup");
  assert.equal(hub.conns.size, 0);
  assert.equal(hub.resolution.disabled, true, "the resolver was consulted and reported disabled");

  const hub2 = freshHub();
  const inst2 = makePi();
  (inst2.flags as Map<string, unknown>).set("no-pi-web-bridge", true);
  attach(hub2, inst2.pi);
  await startSession(inst2, "startup");
  assert.equal(hub2.conns.size, 0);
});

test("/new keeps the socket, retires the instance handles and rebinds the new ones (B-5)", async () => {
  const hub = freshHub();
  const first = makePi({ sessionId: "sid-1" });
  attach(hub, first.pi);
  await startSession(first, "startup");
  const conn = injectFakeServer(hub);

  // pi: session_shutdown{new} -> new factory -> session_start{new}
  await shutdownSession(first, "new");
  assert.equal(conn.closed, false, "the socket belongs to the process, not the instance");
  assert.equal(hub.pi, null, "the dying instance's pi handle is dropped");
  assert.equal(hub.wired, false, "the next instance must wire its own handlers");

  const second = first.replaceWith({ sessionId: "sid-2", sessionFile: "/tmp/second.jsonl" });
  attach(hub, second.pi);
  await startSession(second, "new");
  assert.equal(conn.closed, false);
  assert.equal(hub.sessionId, "sid-2");
  assert.equal(hub.sessionGeneration, 2);
  assert.ok(hub.ctx, "ctx rebound");
});

test("commands after a session switch use the live handle, not the stale one (B-11)", async () => {
  const hub = freshHub();
  const first = makePi({ sessionId: "sid-1" });
  attach(hub, first.pi);
  await startSession(first, "startup");
  await shutdownSession(first, "new");
  const second = first.replaceWith({ sessionId: "sid-2" });
  attach(hub, second.pi);
  await startSession(second, "new");

  const res = await handleCommand(hub, "prompt", { text: "from the browser", delivery: "start" });
  assert.equal(res.invoked, true);
  assert.equal(second.calls.filter((c) => c.kind === "sendUserMessage").length, 1);
  assert.equal(first.calls.filter((c) => c.kind === "sendUserMessage").length, 0, "the dead instance's handle was never touched");
});

test("session_shutdown{quit} closes every sink and leaves nothing behind", async () => {
  const hub = freshHub();
  const inst = makePi();
  attach(hub, inst.pi);
  await startSession(inst, "startup");
  const conn = injectFakeServer(hub);
  await shutdownSession(inst, "quit");
  assert.equal(conn.closed, true);
  assert.equal(hub.conns.size, 0);
});

test("generation fencing: a command carrying an old session generation is refused", async () => {
  const hub = freshHub();
  const inst = makePi();
  attach(hub, inst.pi);
  await startSession(inst, "startup");
  hub.sessionGeneration = 5;
  const reply = await new Promise<Record<string, never>>((resolve) => {
    hub.runCommand({ t: "cmd", id: "c1", cmd: "prompt", args: { text: "hi" }, sessionGeneration: 4 }, resolve as never);
  });
  assert.equal(reply.ok, false);
  assert.equal((reply.error as { code: string }).code, "stale_control");
  const fresh = await new Promise<Record<string, never>>((resolve) => {
    hub.runCommand({ t: "cmd", id: "c2", cmd: "snapshot", args: {}, sessionGeneration: 5 }, resolve as never);
  });
  assert.equal(fresh.ok, true);
});

test("previews and tool state are session-scoped and cleared on switch", async () => {
  const hub = freshHub();
  const inst = makePi();
  attach(hub, inst.pi);
  await startSession(inst, "startup");
  const msg = { role: "assistant", content: [{ type: "text", text: "partial" }] };
  await emit(inst, "message_start", { message: msg });
  await emit(inst, "message_update", { message: msg });
  assert.equal(hub.previews.size, 1);
  await emit(inst, "tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
  assert.equal(hub.tools.size, 1);
  await shutdownSession(inst, "new");
  const second = inst.replaceWith({ sessionId: "sid-9" });
  attach(hub, second.pi);
  await startSession(second, "new");
  assert.equal(hub.previews.size, 0, "a new session must not inherit another session's previews");
  assert.equal(hub.tools.size, 0);
});
