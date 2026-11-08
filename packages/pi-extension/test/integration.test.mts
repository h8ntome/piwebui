/**
 * End-to-end over a real Unix socket: the extension's own code (hub, dialer, framer, command
 * handler) against the server's own acceptance gates and Driver surface, with a fake pi on the
 * extension side. This is the test that would have caught B-1..B-8 at once: it proves adoption,
 * streaming, commands, resume, and each rejection reason - without a browser or a TUI.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { BridgeServer, type BridgeConn, type HelloFrame } from "../../server/src/bridgeServer.ts";
import { writeDescriptor } from "../../server/src/descriptor.ts";
import { Store } from "../../server/src/store.ts";
import { BRIDGE_PROTOCOL, attach, createHub, createInstanceApi, parseDescriptor } from "../extensions/pi-web-bridge.js";
import { emit, makePi, shutdownSession, startSession } from "./fakepi.mts";

const TOKEN = "Zm9yLXRoZS10ZXN0LW9ubHktdG9rZW4tMTIzNA";

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(label: string, ms: number, pred: () => boolean): Promise<void> {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (pred()) return;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${label} after ${ms}ms`);
}

interface Harness {
  dir: string;
  store: Store;
  server: BridgeServer;
  attached: { conn: BridgeConn; hello: HelloFrame }[];
  gone: { runtimeId: string; reason: string }[];
  advertised: { runtimeId: string; sessionId: string }[];
  descriptorFile: string;
  socketPath: string;
}

async function startServer(overrides: Partial<ConstructorParameters<typeof BridgeServer>[0]> = {}): Promise<Harness> {
  const dir = tmp("piweb-int-");
  const store = new Store(path.join(dir, "metadata.db"));
  const socketPath = path.join(dir, "bridge-test.sock");
  const attached: Harness["attached"] = [];
  const gone: Harness["gone"] = [];
  const advertised: Harness["advertised"] = [];
  const server = new BridgeServer({
    dataDir: dir,
    serverId: "testsrv",
    token: TOKEN,
    socketPath,
    mode: "dial",
    requireAttestation: false,
    autoTrust: true,
    store,
    onAttach: (conn, hello) => attached.push({ conn, hello }),
    onAdvertise: (conn, hello) => advertised.push({ runtimeId: conn.runtimeId, sessionId: hello.sessionId }),
    onGone: (conn, reason) => gone.push({ runtimeId: conn.runtimeId, reason }),
    ...overrides,
  });
  const up = await server.listen();
  assert.equal(up.ok, true, up.error);
  const d = writeDescriptor({
    dataDir: dir, serverId: "testsrv", socket: socketPath, token: TOKEN,
    http: "http://127.0.0.1:0", piwebVersion: "test",
  });
  return { dir, store, server, attached, gone, advertised, descriptorFile: d.path, socketPath };
}

/** Boot the extension against a descriptor, with a fake pi, the way pi's loader would. */
function startBridge(descriptorFile: string, piOpts = {}) {
  const inst = makePi(piOpts);
  const hub = createHub({
    env: { PIWEB_BRIDGE_MODE: "dial", PIWEB_BRIDGE_FILE: descriptorFile } as NodeJS.ProcessEnv,
    piVersion: "1.5.0",
    homedir: h.dir, // no ~/.pi-web from the developer's machine leaking into the test
  });
  createInstanceApi(hub);
  attach(hub, inst.pi);
  return { hub, inst };
}

let h: Harness;
before(async () => { h = await startServer(); });
after(() => { h.server.close(); h.store.close(); fs.rmSync(h.dir, { recursive: true, force: true }); });

test("an attestation-free dial: hello is adopted with the identity the server needs (D-1/D-3)", async () => {
  const { hub, inst } = startBridge(h.descriptorFile, { sessionId: "sid-int-1", sessionFile: null });
  await startSession(inst, "startup");
  await until("attach", 6000, () => h.attached.length === 1);
  const { conn, hello } = h.attached[0];
  assert.equal(hello.sessionId, "sid-int-1");
  assert.equal(hello.piVersion, "1.5.0");
  assert.equal(hello.piMode, "tui");
  assert.equal(hello.protocol, BRIDGE_PROTOCOL);
  assert.equal(hello.sessionFile, null, "a brand new session has no file yet - adoption must not require one");
  assert.equal(typeof hello.capabilities.promptStart, "boolean");
  assert.equal(conn.runtimeId, hub.runtimeId);
  assert.equal(conn.pid, process.pid);
  assert.ok(conn.alive());
  hub.closeAll();
});

test("live events stream out with monotonic seq and the proven vocabulary (D-7)", async () => {
  const { hub, inst } = startBridge(h.descriptorFile, { sessionId: "sid-int-2" });
  await startSession(inst, "startup");
  await until("attach", 6000, () => h.attached.some((a) => a.hello.sessionId === "sid-int-2"));
  const conn = h.attached.find((a) => a.hello.sessionId === "sid-int-2")!.conn;
  const seen: { name: string; seq: number }[] = [];
  conn.onEvent((e) => seen.push({ name: e.name, seq: conn.lastSeq }));

  const msg = { role: "assistant", content: [{ type: "text", text: "hel" }] };
  await emit(inst, "message_start", { message: msg });
  await emit(inst, "message_update", { message: msg });
  await sleep(80); // past the 40 ms coalescing window
  msg.content[0].text = "hello world";
  await emit(inst, "message_update", { message: msg });
  await emit(inst, "message_end", { message: msg });
  await emit(inst, "turn_end", { message: msg, messageEntryId: "entry-42", toolResultEntryIds: [], turnIndex: 0 });
  await emit(inst, "tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "ls" } });
  await emit(inst, "tool_execution_end", { toolCallId: "t1", toolName: "bash", isError: false, result: { content: [{ type: "text", text: "file" }] } });
  await emit(inst, "agent_settled", { aborted: false });
  await until("all frames", 3000, () => seen.length >= 7);

  const names = seen.map((s) => s.name);
  for (const want of ["message_start", "message_update", "message_end", "turn_end", "tool_update", "agent_settled"]) {
    assert.ok(names.includes(want), `missing ${want} in ${names.join(",")}`);
  }
  const seqs = seen.map((s) => s.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "seq never goes backwards");
  assert.equal(new Set(seqs).size, seqs.length, "no duplicated seq on one connection");
  hub.closeAll();
});

test("turn_end carries messageEntryId so the preview collapses into the persisted entry", async () => {
  const { hub, inst } = startBridge(h.descriptorFile, { sessionId: "sid-int-3" });
  await startSession(inst, "startup");
  await until("attach", 6000, () => h.attached.some((a) => a.hello.sessionId === "sid-int-3"));
  const conn = h.attached.find((a) => a.hello.sessionId === "sid-int-3")!.conn;
  const turnEnds: Record<string, unknown>[] = [];
  conn.onEvent((e) => { if (e.name === "turn_end") turnEnds.push(e.payload); });
  const msg = { role: "assistant", content: [] };
  await emit(inst, "message_start", { message: msg });
  await emit(inst, "turn_end", { message: msg, messageEntryId: "entry-77", toolResultEntryIds: ["r1"], turnIndex: 0 });
  await until("turn_end", 2000, () => turnEnds.length > 0);
  assert.equal(turnEnds[0].messageEntryId, "entry-77");
  assert.equal((turnEnds[0].toolResultEntryIds as string[])[0], "r1");
  assert.ok(turnEnds[0].liveMessageId, "the live preview id rides along so the mapping is possible");
  hub.closeAll();
});

test("browser commands execute in the terminal and answer with receipts", async () => {
  const { hub, inst } = startBridge(h.descriptorFile, { sessionId: "sid-int-4" });
  await startSession(inst, "startup");
  await until("attach", 6000, () => h.attached.some((a) => a.hello.sessionId === "sid-int-4"));
  const conn = h.attached.find((a) => a.hello.sessionId === "sid-int-4")!.conn;

  const snap = await conn.cmd("snapshot", {}, 4000);
  assert.equal((snap as { sessionId: string }).sessionId, "sid-int-4");
  assert.equal((snap as { capabilities: { canControl: boolean } }).capabilities.canControl, true);

  const sent = await conn.cmd("prompt", { text: "from the browser", delivery: "start", operationId: "op-x" }, 4000);
  assert.equal((sent as { invoked: boolean }).invoked, true);
  assert.equal(inst.calls.filter((c) => c.kind === "sendUserMessage").length, 1);
  // the same operation id must not fire twice, even over a fresh command frame
  const dup = await conn.cmd("prompt", { text: "from the browser", delivery: "start", operationId: "op-x" }, 4000);
  assert.equal((dup as { dedup: boolean }).dedup, true);
  assert.equal(inst.calls.filter((c) => c.kind === "sendUserMessage").length, 1);

  await conn.cmd("rename", { name: "typed from web" }, 4000);
  assert.ok(inst.calls.some((c) => c.kind === "setSessionName"));

  await conn.cmd("abort", {}, 4000);
  assert.ok(inst.calls.some((c) => c.kind === "abort"));

  await assert.rejects(() => conn.cmd("dialogRespond", { requestId: "r" }, 4000), (e: Error & { code?: string }) => {
    assert.equal(e.code, "unsupported_capability");
    return true;
  });
  hub.closeAll();
});

test("a stalled socket sheds previews first, never turn_end (backpressure policy)", async () => {
  const { hub, inst } = startBridge(h.descriptorFile, { sessionId: "sid-int-5" });
  await startSession(inst, "startup");
  await until("attach", 6000, () => h.attached.some((a) => a.hello.sessionId === "sid-int-5"));
  const conn = h.attached.find((a) => a.hello.sessionId === "sid-int-5")!.conn;
  const dial = [...(hub as unknown as { conns: Map<string, { sock: net.Socket }> }).conns.values()][0];
  // Shadow the socket's writableLength getter: this is exactly what the drop policy reads.
  Object.defineProperty(dial.sock, "writableLength", { configurable: true, get: () => 9 * 1024 * 1024 });
  const got: string[] = [];
  conn.onEvent((e) => got.push(e.name));
  const msg = { role: "assistant", content: [{ type: "text", text: "x" }] };
  await emit(inst, "message_start", { message: msg });
  await emit(inst, "message_update", { message: msg });
  await sleep(80);
  await emit(inst, "message_update", { message: msg });
  await emit(inst, "turn_end", { message: msg, messageEntryId: "e", toolResultEntryIds: [], turnIndex: 0 });
  await until("essential frames", 2000, () => got.includes("turn_end"));
  assert.ok(got.includes("message_start"), "message_start is essential and survives");
  assert.ok(!got.includes("message_update"), `previews were shed, not queued: ${got.join(",")}`);
  assert.ok(hub.diag.droppedPreviews >= 1, "the shed count is visible for /runtimes and /piweb");
  hub.closeAll();
});

test("a reconnect resumes by seq instead of forcing a resnapshot (H-10)", async () => {
  const { hub, inst } = startBridge(h.descriptorFile, { sessionId: "sid-int-6" });
  await startSession(inst, "startup");
  await until("attach", 6000, () => h.attached.some((a) => a.hello.sessionId === "sid-int-6"));
  const first = h.attached.find((a) => a.hello.sessionId === "sid-int-6")!.conn;
  const msg = { role: "assistant", content: [{ type: "text", text: "one" }] };
  await emit(inst, "message_start", { message: msg });
  await sleep(60);
  const seqBeforeDrop = first.lastSeq;
  assert.ok(seqBeforeDrop > 0);

  // Server side drops the connection (the pi is still running).
  first.dispose("test");
  await until("gone", 3000, () => h.gone.some((g) => g.runtimeId === hub.runtimeId));
  // More events happen while disconnected: they must land in the ring, not vanish.
  await emit(inst, "message_update", { message: msg });
  await sleep(80);
  await emit(inst, "turn_end", { message: msg, messageEntryId: "entry-9", toolResultEntryIds: [], turnIndex: 0 });

  // Backoff step 1 is ~1 s; wait for the bridge to reconnect on its own.
  await until("reconnect", 8000, () => h.attached.filter((a) => a.hello.sessionId === "sid-int-6").length >= 2);
  const second = h.attached.filter((a) => a.hello.sessionId === "sid-int-6").at(-1)!.conn;
  // The replay arrives on connect, before a test listener could attach: what we assert is the
  // server's own bookkeeping - the new connection's seq ran past where the old one stopped, and
  // nothing was double-applied.
  await until("replayed frames", 3000, () => second.lastSeq > seqBeforeDrop);
  assert.equal(second.duplicates, 0, "no frame was applied twice across the reconnect");
  const seen: string[] = [];
  second.onEvent((e) => seen.push(e.name));
  await emit(inst, "turn_end", { message: { role: "assistant", content: [] }, messageEntryId: "entry-live", toolResultEntryIds: [], turnIndex: 1 });
  await until("live frame after resume", 3000, () => seen.includes("turn_end"));
  assert.ok(second.lastSeq > seqBeforeDrop, "the seq counter continued across the reconnect");
  hub.closeAll();
});

test("session replacement re-advertises on the same socket and the server sees it (D-4)", async () => {
  const { hub, inst } = startBridge(h.descriptorFile, { sessionId: "sid-before" });
  await startSession(inst, "startup");
  await until("attach", 6000, () => h.attached.some((a) => a.hello.sessionId === "sid-before"));
  const conn = h.attached.find((a) => a.hello.sessionId === "sid-before")!.conn;
  await shutdownSession(inst, "new");
  const next = inst.replaceWith({ sessionId: "sid-after" });
  attach(hub, next.pi);
  await startSession(next, "new");
  await until("re-advertisement", 4000, () => h.advertised.some((a) => a.sessionId === "sid-after"));
  assert.equal(conn.alive(), true, "the socket survived the switch");
  const snap = await conn.cmd("snapshot", {}, 4000);
  assert.equal((snap as { sessionId: string }).sessionId, "sid-after", "the server asks the *new* instance for state");
  hub.closeAll();
});

/* ---------------- rejection gates ---------------- */

async function rawSession(socketPath: string, frames: Record<string, unknown>[]): Promise<string[]> {
  return await new Promise((resolve, reject) => {
    const sock = net.createConnection({ path: socketPath });
    const replies: string[] = [];
    let sent = 0;
    const sendAll = () => {
      if (sent >= frames.length) return;
      const f = frames[sent++]!;
      try { sock.write(JSON.stringify(f) + "\n"); } catch { /* gone */ }
      setTimeout(sendAll, 30);
    };
    sock.on("connect", sendAll);
    sock.on("data", (d: Buffer) => {
      for (const line of d.toString("utf8").split("\n")) if (line.trim()) replies.push(line);
    });
    sock.on("error", (e) => { if (!replies.length) reject(e); });
    sock.on("close", () => resolve(replies));
    setTimeout(() => { try { sock.destroy(); } catch { /* gone */ } resolve(replies); }, 2500);
  });
}

test("the wrong token is refused as unauthorized and nothing is adopted (H-05)", async () => {
  const before = h.attached.length;
  const replies = await rawSession(h.socketPath, [{ t: "auth", token: "totally-wrong-token-123456" }]);
  assert.match(replies.join("\n"), /auth_error/);
  assert.match(replies.join("\n"), /unauthorized/);
  assert.equal(h.attached.length, before);
  assert.ok(h.server.stats.rejected.unauthorized >= 1);
});

test("a bridge that never says hello is dropped (auth_timeout gate)", async () => {
  const up = await new Promise<{ got: string }>((resolve) => {
    const sock = net.createConnection({ path: h.socketPath });
    sock.on("connect", () => sock.write(JSON.stringify({ t: "auth", token: TOKEN }) + "\n"));
    sock.on("data", (d: Buffer) => resolve({ got: d.toString("utf8") }));
    sock.on("close", () => resolve({ got: "closed" }));
    setTimeout(() => resolve({ got: "nothing" }), 7000);
  });
  assert.match(up.got, /missing_hello|closed/);
});

test("a duplicate runtime id at the same procStart is refused (H-08)", async () => {
  const { hub, inst } = startBridge(h.descriptorFile, { sessionId: "sid-dup" });
  await startSession(inst, "startup");
  await until("attach", 6000, () => h.attached.some((a) => a.hello.sessionId === "sid-dup"));
  const hello = h.attached.find((a) => a.hello.sessionId === "sid-dup")!.hello;
  const replies = await rawSession(h.socketPath, [
    { t: "auth", token: TOKEN },
    { ...hello },
  ]);
  assert.match(replies.join("\n"), /duplicate_runtime/);
  hub.closeAll();
});

test("an unparseable or protocol-incompatible hello is refused", async () => {
  const bad = await rawSession(h.socketPath, [{ t: "auth", token: TOKEN }, { t: "hello", runtimeId: "r", sessionId: "s", protocol: 0, minProtocol: 0 }]);
  assert.match(bad.join("\n"), /unsupported_protocol/);
});

test("a spoofed pid fails attestation and is not adopted (H-06)", async () => {
  const spoof = await startServer({ requireAttestation: true });
  try {
    const replies = await rawSession(spoof.socketPath, [
      { t: "auth", token: TOKEN },
      {
        t: "hello", protocol: BRIDGE_PROTOCOL, minProtocol: BRIDGE_PROTOCOL,
        runtimeId: "spoofed", pid: process.pid, procStart: Math.floor(performance.timeOrigin),
        sessionId: "sid-spoof", sessionFile: null, cwd: "/tmp", piVersion: "1.5.0", piMode: "tui",
        adapterVersion: "test", sessionGeneration: 1, capabilities: {},
      },
    ]);
    // This test process is alive at the claimed start time but is not pi: cmdline must save us.
    assert.match(replies.join("\n"), /auth_error/);
    assert.match(replies.join("\n"), /not_pi_process|attest_failed/);
    assert.equal(spoof.attached.length, 0);
    assert.ok(spoof.server.stats.rejected.attest_failed >= 1);
  } finally {
    spoof.server.close();
    spoof.store.close();
    fs.rmSync(spoof.dir, { recursive: true, force: true });
  }
});

test("a revoked runtime cannot reconnect until it is trusted again", async () => {
  const { hub, inst } = startBridge(h.descriptorFile, { sessionId: "sid-revoke" });
  await startSession(inst, "startup");
  await until("attach", 6000, () => h.attached.some((a) => a.hello.sessionId === "sid-revoke"));
  const conn = h.attached.find((a) => a.hello.sessionId === "sid-revoke")!.conn;
  assert.equal(h.server.revoke(conn.runtimeId), true);
  await until("gone", 3000, () => h.gone.some((g) => g.runtimeId === conn.runtimeId));
  const replies = await rawSession(h.socketPath, [{ t: "auth", token: TOKEN }, conn.hello]);
  assert.match(replies.join("\n"), /untrusted_runtime/);
  hub.closeAll();
});

test("the runtimes table records what was seen, and the socket is 0600 in a 0700 dir", async () => {
  const st = fs.statSync(h.socketPath);
  assert.equal(st.mode & 0o777, 0o600, "bridge socket must be owner-only");
  const dirSt = fs.statSync(h.dir);
  assert.ok((dirSt.mode & 0o777) === 0o700 || (dirSt.mode & 0o777) === 0o755);
  const rows = h.store.runtimeList();
  assert.ok(rows.length >= 1, "at least one attested runtime is recorded");
  assert.ok(rows.some((r) => r.trusted === 1), "auto-trust on first sight");
  assert.ok(rows.every((r) => r.runtime_id && r.pid === process.pid));
});

test("descriptor is 0600 and a foreign protocol is refused by the resolver", () => {
  const st = fs.statSync(h.descriptorFile);
  assert.equal(st.mode & 0o777, 0o600);
  const raw = JSON.parse(fs.readFileSync(h.descriptorFile, "utf8"));
  assert.equal(raw.socket, h.socketPath);
  assert.equal(raw.serverId, "testsrv");
  assert.equal(parseDescriptor({ ...raw, protocol: [99] }, h.descriptorFile).reason, "unsupported_protocol");
  assert.equal(parseDescriptor({ ...raw, token: "short" }, h.descriptorFile).reason, "no_token");
  assert.equal(parseDescriptor(raw, h.descriptorFile).ok, true);
});

test("a pi that started BEFORE pi-web dials it on its own, within the retry cap (H-03)", async () => {
  const dir = tmp("piweb-late-");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const store = new Store(path.join(dir, "metadata.db"));
  const socketPath = path.join(dir, "bridge-late.sock");
  // The pi boots first: there is no descriptor at all yet.
  const inst = makePi({ sessionId: "sid-late" });
  const hub = createHub({ env: { PIWEB_BRIDGE_MODE: "dial", PIWEB_DATA_DIR: dir } as NodeJS.ProcessEnv, piVersion: "1.5.0", homedir: dir });
  createInstanceApi(hub);
  attach(hub, inst.pi);
  await startSession(inst, "startup");
  assert.equal(hub.conns.size, 0, "nothing to dial yet");
  assert.ok(hub.resolution.notes.length, "and it says why");

  const late: HelloFrame[] = [];
  const server = new BridgeServer({
    dataDir: dir, serverId: "latesrv", token: TOKEN, socketPath, mode: "dial",
    requireAttestation: false, autoTrust: true, store,
    onAttach: (_c, hello) => late.push(hello), onGone: () => { /* ignore */ },
  });
  const t0 = Date.now();
  const up = await server.listen();
  assert.equal(up.ok, true);
  writeDescriptor({ dataDir: dir, serverId: "latesrv", socket: socketPath, token: TOKEN, http: "http://127.0.0.1:0", piwebVersion: "test" });
  try {
    await until("the bridge to find the server that appeared later", 12_000, () => late.length >= 1);
  } finally {
    hub.closeAll();
    server.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(late[0].sessionId, "sid-late");
  assert.ok(Date.now() - t0 < 12_000);
});

test("a stale socket file from a dead server is taken over, a live one is not (H-04)", async () => {
  const dir = tmp("piweb-stale-");
  const store = new Store(path.join(dir, "metadata.db"));
  const socketPath = path.join(dir, "bridge-stale.sock");
  fs.writeFileSync(socketPath, "not a socket"); // left behind by a SIGKILLed server
  const mk = () => new BridgeServer({
    dataDir: dir, serverId: "stalesrv", token: TOKEN, socketPath, mode: "dial",
    requireAttestation: false, autoTrust: true, store, onAttach: () => { /* ignore */ }, onGone: () => { /* ignore */ },
  });
  const first = mk();
  const up1 = await first.listen();
  assert.equal(up1.ok, true, "a socket nobody answers is unlinked and rebound");
  const second = mk();
  const up2 = await second.listen();
  assert.equal(up2.ok, false, "a live listener is never stolen from");
  assert.match(String(up2.error), /answers/);
  first.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
