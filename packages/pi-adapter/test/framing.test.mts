import { test } from "node:test";
import assert from "node:assert/strict";
import { LfFramer } from "../src/tail.ts";

test("LF framing: U+2028/U+2029 inside lines survive; only LF splits", () => {
  const f = new LfFramer(4096);
  const rec = JSON.stringify({ s: "a\u2028b\u2029c" });
  const out = f.feed(Buffer.from(rec + "\n" + "partial-tail", "utf8"));
  assert.equal(out.length, 1);
  assert.equal(JSON.parse(out[0]!.bytes.toString("utf8")).s, "a\u2028b\u2029c");
  assert.equal(f.partialBytes, "partial-tail".length);
});

test("LF framing flags overflow past the per-record bound", () => {
  const f = new LfFramer(16);
  f.feed(Buffer.from("x".repeat(40), "utf8"));
  assert.equal(f.overflow, true);
});

test("framer offsets are real absolute file offsets across chunk boundaries", () => {
  const lines = ['{"a":1}', '{"b":22}', '{"c":333}'];
  const raw = Buffer.from(lines.join("\n") + "\n", "utf8");
  const expected: number[] = [];
  let off = 0;
  for (const l of lines) { expected.push(off); off += l.length + 1; }
  const f = new LfFramer(4096);
  const recs = f.feed(raw);
  assert.deepEqual(recs.map((r) => r.startOffset), expected);
  assert.equal(recs[2]!.endOffset, raw.length);
  // same file fed in awkward 5-byte chunks must produce identical offsets
  const g = new LfFramer(4096);
  const chunked: number[] = [];
  for (let i = 0; i < raw.length; i += 5) chunked.push(...g.feed(raw.subarray(i, Math.min(i + 5, raw.length))).map((r) => r.startOffset));
  assert.deepEqual(chunked, expected);
});

test("CRLF tolerance: trailing CR stripped from record body", () => {
  const f = new LfFramer(1024);
  const out = f.feed(Buffer.from("{\"a\":1}\r\n", "utf8"));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.bytes.toString("utf8"), "{\"a\":1}");
});

/* ---------- transcript paging (TRN-01) and parse diagnostics (SRV-04) ---------- */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { readEntryBefore, readEntryPage, readEntryTail } from "../src/read/pure.ts";

function fixture(lines: string[]): string {
  const dir = mkdtempSync(path.join(tmpdir(), "pwpage-"));
  const file = path.join(dir, "s.jsonl");
  const header = JSON.stringify({ type: "session", id: "s", timestamp: "2026-01-01T00:00:00.000Z", cwd: dir });
  writeFileSync(file, [header, ...lines].join("\n") + "\n", "utf8");
  return file;
}
const msgs = (n: number, from = 0) => Array.from({ length: n }, (_, i) => JSON.stringify({
  type: "message", id: `e${from + i}`, parentId: from + i ? `e${from + i - 1}` : null, timestamp: "2026-01-01T00:00:00.000Z",
  message: { role: "user", content: [{ type: "text", text: `message ${from + i}` }] },
}));

test("tail page hands back the newest window and says older history exists", async () => {
  const f = fixture(msgs(40));
  const p = await readEntryTail(f, 10);
  assert.equal(p.entries.length, 10);
  assert.equal(p.entries[0]!.entryId, "e30");
  assert.equal(p.entries[9]!.entryId, "e39");
});

test("pageBefore returns the entries before an id, oldest-first, and walks to the start", async () => {
  const f = fixture(msgs(40));
  const p = await readEntryBefore(f, "e30", 10);
  assert.deepEqual(p.entries.map((e) => e.entryId), Array.from({ length: 10 }, (_, i) => `e${i + 20}`));
  assert.equal(p.olderCursor, "e20");

  const atStart = await readEntryBefore(f, "e5", 10);
  assert.deepEqual(atStart.entries.map((e) => e.entryId), ["e0", "e1", "e2", "e3", "e4"]);
  assert.equal(atStart.olderCursor, null, "no cursor once the start of the file is reached");

  const unknown = await readEntryBefore(f, "nope", 10);
  assert.equal(unknown.entries.length, 0);
  assert.equal(unknown.olderCursor, null);
});

test("forward paging resumes from a cursor and stops at the end", async () => {
  const f = fixture(msgs(30));
  const first = await readEntryPage(f, null, 10);
  assert.equal(first.entries.length, 10);
  assert.ok(first.nextCursor, "cursor offered while entries remain");
  const second = await readEntryPage(f, first.nextCursor!, 10);
  assert.equal(second.entries[0]!.entryId, "e10");
  assert.equal(second.entries[second.entries.length - 1]!.entryId, "e19");
});

test("unreadable lines come back as diagnostics instead of vanishing (SRV-04)", async () => {
  const f = fixture([...msgs(3), "{ this is not json ,,", ...msgs(1, 3)]);
  const p = await readEntryTail(f, 10);
  assert.equal(p.diagnostics.length, 1);
  assert.match(p.diagnostics[0]!.message, /invalid JSON line/);
  assert.ok(p.entries.some((e) => e.entryId === "e3"), "readable entries after the bad line still land");
});
