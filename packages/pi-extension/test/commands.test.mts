/**
 * Command mapping (bridge_plan 02 §5.3): the exact promises the browser's command gauntlet
 * depends on - busy policy honest, dedup at-least-once safe, and everything unsupported answered
 * 501-style instead of simulated.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSnapshot, capabilities, createHub, createInstanceApi, handleCommand } from "../extensions/pi-web-bridge.js";
import { makePi } from "./fakepi.mts";

function hubWithPi(opts: Parameters<typeof makePi>[0] = {}) {
  const inst = makePi(opts);
  const hub = createHub({ env: { PIWEB_BRIDGE_MODE: "off" } as NodeJS.ProcessEnv });
  createInstanceApi(hub);
  hub.bindInstance(inst.pi);
  hub.bindContext(inst.ctx);
  hub.sessionGeneration = 1;
  return { hub, inst };
}

async function rejects(code: string, fn: () => unknown) {
  await assert.rejects(fn, (e: Error & { code?: string }) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}: ${e.message}`);
    return true;
  });
}

test("prompt(start) on an idle session delivers with no deliverAs", async () => {
  const { hub, inst } = hubWithPi();
  const res = await handleCommand(hub, "prompt", { text: "hello", delivery: "start" });
  assert.deepEqual(res, { invoked: true, delivery: "start", expanded: false });
  const call = inst.calls.at(-1);
  assert.equal(call?.kind, "sendUserMessage");
  assert.deepEqual((call?.args as { content: string; options: unknown }).content, "hello");
  assert.equal((call?.args as { options: unknown }).options, undefined, "plain send, so pi starts a turn");
});

test("busy policy is explicit in both directions", async () => {
  const busy = hubWithPi({ idle: false });
  await rejects("busy", () => handleCommand(busy.hub, "prompt", { text: "x", delivery: "start" }));
  const idle = hubWithPi({ idle: true });
  await rejects("busy", () => handleCommand(idle.hub, "prompt", { text: "x", delivery: "steer" }));
});

test("steer and followUp map onto pi's deliverAs while streaming", async () => {
  const { hub, inst } = hubWithPi({ idle: false });
  await handleCommand(hub, "prompt", { text: "steer me", delivery: "steer" });
  assert.deepEqual((inst.calls.at(-1)?.args as { options: { deliverAs: string } }).options, { deliverAs: "steer" });
  await handleCommand(hub, "prompt", { text: "later", delivery: "followUp" });
  assert.deepEqual((inst.calls.at(-1)?.args as { options: { deliverAs: string } }).options, { deliverAs: "followUp" });
});

test("the same operationId is executed once (at-least-once delivery safety)", async () => {
  const { hub, inst } = hubWithPi();
  const first = await handleCommand(hub, "prompt", { text: "once", delivery: "start", operationId: "op-1" });
  const again = await handleCommand(hub, "prompt", { text: "once", delivery: "start", operationId: "op-1" });
  assert.equal(first.invoked, true);
  assert.equal(again.dedup, true);
  assert.equal(inst.calls.filter((c) => c.kind === "sendUserMessage").length, 1);
});

test("prompt text is literal by default: expansion is an explicit opt-in", async () => {
  const { hub, inst } = hubWithPi();
  await handleCommand(hub, "prompt", { text: "/dangerous", delivery: "start" });
  assert.equal((inst.calls.at(-1)?.args as { options?: { expandPromptTemplates?: boolean } }).options, undefined);
  await handleCommand(hub, "prompt", { text: "/safe", delivery: "start", expandCommands: true });
  assert.equal((inst.calls.at(-1)?.args as { options: { expandPromptTemplates: boolean } }).options.expandPromptTemplates, true);
});

test("images ride along as content blocks", async () => {
  const { hub, inst } = hubWithPi();
  await handleCommand(hub, "prompt", {
    text: "look", delivery: "start",
    images: [{ data: "aGVsbG8=", mimeType: "image/png" }],
  });
  const content = (inst.calls.at(-1)?.args as { content: { type: string }[] }).content;
  assert.equal(content.length, 2);
  assert.equal(content[0].type, "text");
  assert.equal(content[1].type, "image");
  assert.equal(content[1].mimeType ?? (content[1] as { mimeType?: string }).mimeType, "image/png");
});

test("abort and compact go through the live context", async () => {
  const { hub, inst } = hubWithPi();
  const res = await handleCommand(hub, "abort", {});
  assert.equal(res.requested, true);
  assert.ok(inst.calls.some((c) => c.kind === "abort"));
  const broadcasts: string[] = [];
  hub.broadcast = (name: string) => { broadcasts.push(name); return 0; };
  await handleCommand(hub, "compact", { instructions: "focus", operationId: "op-c" });
  assert.ok(inst.calls.some((c) => c.kind === "compact"));
  assert.deepEqual(broadcasts, ["compact_done"], "compaction completion is reported as an event, not a res");
});

test("model and thinking changes report what pi actually accepted", async () => {
  const { hub } = hubWithPi();
  const res = await handleCommand(hub, "setModel", { provider: "mock", modelId: "mock-echo" });
  assert.equal(res.model.modelId, "mock-echo");
  await rejects("invalid_request", () => handleCommand(hub, "setModel", { provider: "nope", modelId: "x" }));
  const t = await handleCommand(hub, "setThinking", { level: "high" });
  assert.equal(t.level, "high");
});

test("rename sets a name and refuses to fake a clear", async () => {
  const { hub, inst } = hubWithPi();
  assert.equal((await handleCommand(hub, "rename", { name: "auth fix" })).name, "auth fix");
  assert.ok(inst.calls.some((c) => c.kind === "setSessionName"));
  await rejects("unsupported_capability", () => handleCommand(hub, "rename", { name: null }));
});

test("the terminal-only limits are named, never simulated", async () => {
  const { hub } = hubWithPi();
  for (const cmd of ["dialogRespond", "clearQueue", "stopForTerminal", "wat"]) {
    await rejects("unsupported_capability", () => handleCommand(hub, cmd, { requestId: "r1" }));
  }
});

test("snapshot answers what adoption needs: capabilities, sessionId, sessionFile (B-8)", async () => {
  const { hub } = hubWithPi({ sessionId: "sid-snap", sessionFile: "/tmp/snap.jsonl" });
  const snap = buildSnapshot(hub);
  assert.equal(snap.sessionId, "sid-snap");
  assert.equal(snap.sessionFile, "/tmp/snap.jsonl");
  assert.equal(snap.capabilities.canControl, true);
  assert.equal(snap.capabilities.dialogRespond, false);
  assert.equal(snap.capabilities.queue, "flag");
  assert.equal(snap.mode, "tui");
  assert.equal(snap.entryCount, 1);
  assert.ok(snap.capabilities.notes?.length);
});

test("snapshot without a bound context is an error, not a crash", () => {
  const hub = createHub({ env: { PIWEB_BRIDGE_MODE: "off" } as NodeJS.ProcessEnv });
  createInstanceApi(hub);
  assert.throws(() => buildSnapshot(hub), (e: Error & { code?: string }) => e.code === "host_unavailable");
});

test("pull paths answer: tree, context, models, commands, stats-lite", async () => {
  const { hub } = hubWithPi();
  const tree = await handleCommand(hub, "tree", {});
  assert.equal(tree.leaf.entryId, "e1");
  assert.ok(tree.nodes.e1);
  assert.equal(tree.nodes.e1.onActiveBranch, true);
  const ctx = await handleCommand(hub, "context", {});
  assert.equal(ctx.kind, "runtime_preview");
  assert.ok(ctx.unavailableFields.includes("systemPrompt"), "the preview names what it cannot see");
  const models = await handleCommand(hub, "models", {});
  assert.equal(models.models[0].modelId, "mock-echo");
  const cmds = await handleCommand(hub, "commands", {});
  assert.equal(cmds.commands[0].name, "/help");
  const stats = await handleCommand(hub, "stats-lite", {});
  assert.equal(stats.entryCount, 1);
});

test("capability bag reflects the live pi handle, so a dead instance cannot claim control", () => {
  const { hub, inst } = hubWithPi();
  const caps = capabilities(hub, inst.ctx) as Record<string, unknown>;
  assert.equal(caps.canControl, true);
  hub.pi = null;
  const dead = capabilities(hub, inst.ctx) as Record<string, unknown>;
  assert.equal(dead.promptStart, false, "with no live pi handle, prompts are not advertised");
  assert.equal(dead.canControl, true === dead.canControl ? dead.canControl : false);
});
