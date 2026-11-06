import { test } from "node:test";
import assert from "node:assert/strict";
import { okhslToRgb, rgbToHex, parseOkhsl, contrastRatio, hexToRgb, rgbToOkhsl } from "../src/okhsl.ts";
import { validate, CommandEnvelopeSchema, EntriesQuerySchema, validateQuery } from "../src/schemas.ts";

test("okhsl matches the reference implementation on known colors", () => {
  // Goldens captured from @earendil-works/pi-tui dist/oklab.js (the upstream reference
  // this file is vendored from). Guards chromaStops against transcription drift.
  const cases: [number, number, number, string][] = [
    [40, 0.1, 0.9, "#e7e1df"],
    [265, 0.4, 0.6, "#7b90bf"],
    [120, 0.8, 0.3, "#404c13"],
    [0, 0, 0.5, "#777777"],
    [230, 0.55, 0.45, "#39728c"],
    [180, 0.9, 0.75, "#2bd5bc"],
    [300, 0.02, 0.15, "#222223"],
  ];
  for (const [h, s, l, expected] of cases) {
    assert.equal(rgbToHex(okhslToRgb(h, s, l)), expected, `okhsl(${h} ${s} ${l})`);
  }
});

test("okhsl round-trips within tolerance", () => {
  for (const [h, s, l] of [[0, 0, 0.5], [40, 0.1, 0.9], [265, 0.4, 0.6], [120, 0.8, 0.3]] as [number, number, number][]) {
    const rgb = okhslToRgb(h, s, l);
    const back = rgbToOkhsl(rgb.r, rgb.g, rgb.b);
    assert.ok(Math.abs(back.l - l) < 0.02, `lightness ${back.l} vs ${l}`);
    if (s > 0.05) assert.ok(Math.abs(((back.h - h + 540) % 360) - 180) < 12, `hue drift ${back.h} vs ${h}`);
  }
});

test("parseOkhsl accepts pi's exact serialization", () => {
  const ok = parseOkhsl("okhsl(265.0 0.355% 71.765%)");
  assert.ok(ok && /^#[0-9a-f]{6}$/.test(rgbToHex(ok)));
  assert.equal(parseOkhsl("oklab(0.5 0 0)"), null);
  assert.equal(parseOkhsl("  "), null);
});

test("contrast ratio is symmetric and bounded", () => {
  const black = hexToRgb("#000000")!, white = hexToRgb("#ffffff")!;
  assert.equal(contrastRatio(black, white), 21);
  assert.equal(contrastRatio(white, black), 21);
  assert.ok(contrastRatio(white, white) === 1);
});

test("command envelope schema gates required fields", () => {
  const good = {
    operationId: "o".repeat(8), runtimeId: "r", runtimeGeneration: 1,
    sessionGeneration: 2, controlEpoch: 3, controlSecret: "s".repeat(8),
    command: { type: "prompt", text: "hi", delivery: "start" },
  };
  assert.equal(validate(CommandEnvelopeSchema, good).ok, true);
  assert.equal(validate(CommandEnvelopeSchema, { ...good, controlSecret: undefined }).ok, false);
  assert.equal(validate(CommandEnvelopeSchema, { ...good, command: { type: "prompt", text: "hi" } }).ok, false);
});

test("query validation coerces numeric query strings", () => {
  const r = validateQuery(EntriesQuerySchema, { limit: "500", cursor: "abc" });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal((r.value as { limit?: number }).limit, 500);
  assert.equal(validateQuery(EntriesQuerySchema, { limit: "not-a-number" }).ok, false);
});
