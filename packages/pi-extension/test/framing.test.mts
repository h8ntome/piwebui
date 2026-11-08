/**
 * Framing, ordering, replay window and the backpressure drop policy (bridge_plan 02 §5.1).
 * These are the pieces that decide whether a reconnect duplicates a preview or loses a turn_end.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { BRIDGE_PROTOCOL, LIMITS, LineFramer, ReplayRing, encodeFrame } from "../extensions/pi-web-bridge.js";

function frame(name: string, payload: Record<string, unknown> = {}, seq = 1) {
  const line = encodeFrame({ t: "ev", seq, name, payload });
  return { seq, name, payload, line, bytes: line.length };
}

test("encodeFrame is newline-terminated JSON (the whole wire contract)", () => {
  assert.equal(encodeFrame({ t: "ping", id: "x" }), '{"t":"ping","id":"x"}\n');
});

test("LineFramer reassembles split frames and keeps the remainder", () => {
  const f = new LineFramer();
  assert.deepEqual(f.feed(Buffer.from('{"a":1}\n{"b":')), ['{"a":1}']);
  assert.deepEqual(f.feed(Buffer.from('2}\n')), ['{"b":2}']);
  assert.deepEqual(f.feed(Buffer.from("\n")), []); // blank lines are ignored, not errors
});

test("LineFramer flags a buffer overflow instead of growing forever", () => {
  const f = new LineFramer(32);
  f.feed(Buffer.from("x".repeat(40)));
  assert.equal(f.overflow, true);
});

test("the replay ring is bounded by frames and bytes, oldest first out", () => {
  const ring = new ReplayRing(3, 10_000);
  for (let i = 1; i <= 5; i++) ring.push(frame("message_update", { i }, i));
  assert.equal(ring.size, 3);
  assert.equal(ring.lastSeq, 5);
  assert.equal(ring.oldestDroppedSeq, 2);
  const since = ring.since(0);
  assert.equal(since.contiguous, false, "frames 1-2 are gone: the server must resnapshot");
  assert.deepEqual(since.frames.map((f: { seq: number }) => f.seq), [3, 4, 5]);
});

test("replay is contiguous when the peer kept up, and empty when it saw everything", () => {
  const ring = new ReplayRing(10, 10_000);
  for (let i = 1; i <= 4; i++) ring.push(frame("tool_update", { i }, i));
  const mid = ring.since(2);
  assert.equal(mid.contiguous, true);
  assert.deepEqual(mid.frames.map((f: { seq: number }) => f.seq), [3, 4]);
  assert.equal(ring.since(4).frames.length, 0);
  assert.equal(ring.since(4).contiguous, true);
});

test("byte bound evicts before the frame bound does", () => {
  const ring = new ReplayRing(1000, 400);
  let seq = 0;
  while (ring.size < 50 && seq < 200) { seq++; ring.push(frame("message_update", { pad: "y".repeat(100) }, seq)); }
  assert.ok(ring.bytes <= 400, `ring bytes ${ring.bytes}`);
  assert.ok(ring.size < 50);
});

test("limits match what the server enforces (no surprise truncation on either side)", () => {
  assert.equal(BRIDGE_PROTOCOL, 1);
  assert.equal(LIMITS.replayFrames, 2000);
  assert.equal(LIMITS.previewBytes, 2 * 1024 * 1024);
  assert.equal(LIMITS.toolStateBytes, 1 * 1024 * 1024);
  assert.equal(LIMITS.authDeadlineMs, 5000);
});
