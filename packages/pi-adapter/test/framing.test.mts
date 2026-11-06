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

test("CRLF tolerance: trailing CR stripped from record body", () => {
  const f = new LfFramer(1024);
  const out = f.feed(Buffer.from("{\"a\":1}\r\n", "utf8"));
  assert.equal(out.length, 1);
  assert.equal(out[0]!.bytes.toString("utf8"), "{\"a\":1}");
});
