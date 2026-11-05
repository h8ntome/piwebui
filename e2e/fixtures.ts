/**
 * Fixture generation + read-path fixtures (synthetic, scrubbed — no real user data).
 * Each fixture specifies its expected branch/context and provenance.
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export interface FixtureFiles {
  dir: string;
  v3Current: string;
  v3Branched: string;
  legacyV2: string;
  empty: string;
  invalidTail: string;
  giantRecord: string;
  manyEntries?: string;
  v3CurrentExpect?: { leafId: string; entryCount: number; cwd: string };
}

const id = () => crypto.randomUUID();

function header(cwd: string, version = 3) {
  return { type: "session", version, id: id(), timestamp: "2026-01-01T00:00:00.000Z", cwd };
}

function msg(idp: string | null, role: string, text: string, ts = "2026-01-01T00:00:01.000Z", extra: Record<string, unknown> = {}) {
  const message: Record<string, unknown> = { role, content: [{ type: "text", text }] };
  if (role === "assistant") {
    message.usage = { input: 100, output: 25, cacheRead: 0, cacheWrite: 0, cost: 0 };
    message.stopReason = "stopReason" in extra ? extra.stopReason : "stop";
    if (extra.model) message.model = extra.model;
  }
  return { type: "message", id: id(), parentId: idp, timestamp: ts, message, ...extra };
}

export function generateFixtures(base: string): FixtureFiles {
  fs.rmSync(base, { recursive: true, force: true });
  fs.mkdirSync(base, { recursive: true });
  const files: FixtureFiles = {
    dir: base, v3Current: "", v3Branched: "", legacyV2: "", empty: "", invalidTail: "", giantRecord: "",
  };

  // v3 current: linear conversation + model/thinking changes + usage + label + session name + custom + context_edit + compaction boundary
  {
    const cwd = path.join(base, "workspace-a");
    const lines: Record<string, unknown>[] = [header(cwd)];
    const u1 = msg(null, "user", "What does src/index.ts do?\nWith a ünique ünïcode line \u2028 and \u2029 inside.");
    lines.push(u1);
    const a1 = msg(u1.id, "assistant", "It is the entry module. ```ts\nexport const x = 1;\n```", undefined, { model: "claude-mock" });
    lines.push(a1);
    lines.push({ type: "model_change", id: id(), parentId: a1.id, timestamp: "2026-01-01T00:01:00Z", provider: "mock", modelId: "mock-echo-2" });
    lines.push({ type: "thinking_level_change", id: id(), parentId: lines[lines.length - 1]!.id, timestamp: "2026-01-01T00:01:01Z", thinkingLevel: "high" });
    const u2 = msg(lines[lines.length - 1]!.id, "user", "thanks");
    lines.push(u2);
    lines.push({ type: "session_info", id: id(), parentId: u2.id, timestamp: "2026-01-01T00:01:02Z", name: "Fixture chat A" });
    lines.push({ type: "usage", id: id(), parentId: lines[lines.length - 1]!.id, timestamp: "2026-01-01T00:01:03Z", kind: "cache_warm", provider: "mock", model: "mock-echo-2", usage: { input: 0, output: 0, cacheRead: 5, cacheWrite: 0, cost: 0 } });
    lines.push({ type: "label", id: id(), parentId: lines[lines.length - 1]!.id, timestamp: "2026-01-01T00:01:04Z", targetId: u1.id, label: "start" });
    lines.push({ type: "custom", id: id(), parentId: lines[lines.length - 1]!.id, timestamp: "2026-01-01T00:01:05Z", customType: "test.state", data: { hello: true } });
    lines.push({ type: "custom_message", id: id(), parentId: lines[lines.length - 1]!.id, timestamp: "2026-01-01T00:01:06Z", customType: "test.note", content: "visible custom message", display: true });
    lines.push({ type: "context_edit", id: id(), parentId: lines[lines.length - 1]!.id, timestamp: "2026-01-01T00:01:07Z", targetId: u1.id, replacement: { content: "REPLACED: what does index.ts do?" } });
    lines.push({ type: "a_brand_new_type", id: id(), parentId: lines[lines.length - 1]!.id, timestamp: "2026-01-01T00:01:08Z", whatever: { nested: [1, 2, 3] } });
    files.v3Current = path.join(base, "v3-current.jsonl");
    writeLines(files.v3Current, lines);
    files.v3CurrentExpect = { leafId: lines[lines.length - 1]!.id as string, entryCount: lines.length - 1, cwd };
  }

  // v3 branched: two branches from same parent; leaf is second branch (file semantics)
  {
    const cwd = path.join(base, "workspace-b");
    const lines: Record<string, unknown>[] = [header(cwd)];
    const u1 = msg(null, "user", "branch point?");
    lines.push(u1);
    const b1 = msg(u1.id, "assistant", "branch one answer");
    const b2 = msg(u1.id, "assistant", "branch two answer (leaf)");
    lines.push(b1, b2);
    files.v3Branched = path.join(base, "v3-branched.jsonl");
    writeLines(files.v3Branched, lines);
  }

  // legacy v2 (older version marker, entries otherwise v2-style)
  {
    const cwd = path.join(base, "workspace-legacy");
    const lines: Record<string, unknown>[] = [header(cwd, 2)];
    const u1 = msg(null, "user", "old session prompt");
    lines.push(u1, msg(u1.id, "assistant", "old answer"));
    files.legacyV2 = path.join(base, "legacy-v2.jsonl");
    writeLines(files.legacyV2, lines);
  }

  // empty file (SessionManager.open would initialize/rewrite this!)
  files.empty = path.join(base, "empty.jsonl");
  fs.writeFileSync(files.empty, "");

  // invalid tail: valid records then a truncated JSON line + non-object line
  {
    const cwd = path.join(base, "workspace-corrupt");
    const lines: Record<string, unknown>[] = [header(cwd)];
    const u1 = msg(null, "user", "tail check");
    lines.push(u1);
    files.invalidTail = path.join(base, "invalid-tail.jsonl");
    fs.writeFileSync(files.invalidTail, lines.map((l) => JSON.stringify(l)).join("\n") + "\n" + '{"type":"message","id":"cut","parentId":\n' + "not json at all\n");
  }

  // giant single record (~6 MiB text inside one assistant message)
  {
    const cwd = path.join(base, "workspace-giant");
    const lines: Record<string, unknown>[] = [header(cwd)];
    const u1 = msg(null, "user", "huge output test");
    lines.push(u1);
    lines.push(msg(u1.id, "assistant", "x".repeat(6 * 1024 * 1024)));
    files.giantRecord = path.join(base, "giant-record.jsonl");
    writeLines(files.giantRecord, lines);
  }

  // 5000-entry session for perf reference fixture
  {
    const cwd = path.join(base, "workspace-many");
    const lines: Record<string, unknown>[] = [header(cwd)];
    let prev = lines[0]!.id as string;
    for (let i = 0; i < 2500; i++) {
      const u = msg(prev, "user", `question ${i} \u2028 unicode keeps framing honest`);
      lines.push(u);
      const a = msg(u.id, "assistant", `answer ${i} with some payload text for measurement purposes`);
      lines.push(a);
      prev = a.id as string;
    }
    files.manyEntries = path.join(base, "many-entries.jsonl");
    writeLines(files.manyEntries, lines);
  }
  return files;
}

function writeLines(file: string, objs: Record<string, unknown>[]) {
  fs.writeFileSync(file, objs.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
}
