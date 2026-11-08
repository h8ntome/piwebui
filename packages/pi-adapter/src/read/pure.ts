/**
 * Pure, side-effect-free session file reading. NEVER uses SessionManager.open on an
 * original file (it can initialize empty files / rewrite migrations — plan D-05).
 * All reads are fs.open('r'); migration happens only on in-memory parsed copies via
 * Pi's exported pure helpers.
 */
import { open, stat, realpath, lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import { decodeRecord, generationId, identityFromStats, LfFramer, type FramedRecord } from "../tail.ts";
import { MAX_RECORD_BYTES, type ContextView, type EntryPage, type EntryView, type StatsView, type TreeView, type TreeNodeView, type SessionMeta } from "@piwebui/shared";

export interface ReadableFileIdentity {
  genId: string;
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
}

export async function fileIdentity(file: string): Promise<ReadableFileIdentity | null> {
  try {
    const st = await stat(file);
    const id = identityFromStats(st);
    return { genId: generationId(id), dev: id.dev, ino: id.ino, size: id.size, mtimeMs: id.mtimeMs };
  } catch {
    return null;
  }
}

export function encodeCursor(o: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
}
export function decodeCursor(c: string | undefined | null): Record<string, unknown> | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, "base64url").toString("utf8"));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export interface StreamOptions {
  startOffset?: number;
  maxBytes?: number;
  onRecord: (rec: FramedRecord) => void;
  onDiagnostic?: (d: { message: string; byteOffset: number }) => void;
  onGap?: (byteOffset: number) => void;
}

/** Stream LF-framed records from a file with chunked reads and periodic yields. */
export async function streamRecords(file: string, opts: StreamOptions): Promise<{ endOffset: number; diagnostics: number; gaps: number }> {
  const fh = await open(file, "r");
  try {
    return await streamRecordsHandle(fh, opts);
  } finally {
    await fh.close();
  }
}

export async function streamRecordsHandle(fh: FileHandle, opts: StreamOptions): Promise<{ endOffset: number; diagnostics: number; gaps: number }> {
  const st = await fh.stat();
  const start = opts.startOffset ?? 0;
  const limit = opts.maxBytes ?? st.size;
  const framer = new LfFramer(MAX_RECORD_BYTES, start);
  const buf = Buffer.allocUnsafe(64 * 1024);
  let pos = start;
  let diagnostics = 0;
  let gaps = 0;
  let sinceYield = 0;
  while (pos < Math.min(st.size, limit)) {
    const { bytesRead } = await fh.read(buf, 0, Math.min(buf.length, Math.min(st.size, limit) - pos), pos);
    if (bytesRead === 0) break;
    pos += bytesRead;
    sinceYield += bytesRead;
    for (const rec of framer.feed(buf.subarray(0, bytesRead))) {
      const r = decodeRecord(rec, MAX_RECORD_BYTES);
      if (r.entry) opts.onRecord(rec), (diagnostics += 0);
      if (r.header) opts.onRecord(rec);
      if (r.diagnostic) {
        diagnostics++;
        opts.onDiagnostic?.(r.diagnostic);
      }
    }
    if (framer.overflow) {
      gaps++;
      opts.onGap?.(framer.pos ?? pos);
      framer.overflow = false;
    }
    if (sinceYield >= 4 * 1024 * 1024) {
      sinceYield = 0;
      await new Promise((r) => setImmediate(r));
    }
  }
  return { endOffset: Math.min(st.size, limit), diagnostics, gaps };
}

/** Parse all records (header separated) using Pi's pure parser semantics for projection parity. */
export interface FullParse {
  header: Record<string, unknown> | null;
  entries: Record<string, unknown>[];
  diagnostics: { message: string; byteOffset: number }[];
  gaps: number;
}

export async function parseFull(file: string, maxBytes = 256 * 1024 * 1024): Promise<FullParse> {
  const st = await stat(file).catch(() => null);
  if (!st) throw Object.assign(new Error("file not found"), { code: "not_found" });
  if (st.size > maxBytes) throw new Error(`session file exceeds bounded read budget (${st.size} > ${maxBytes})`);
  const header: Record<string, unknown> | null = null;
  const out: FullParse = { header, entries: [], diagnostics: [], gaps: 0 };
  await streamRecords(file, {
    onRecord: (rec) => {
      const obj = JSON.parse(rec.bytes.toString("utf8")) as Record<string, unknown>;
      if (obj.type === "session") {
        if (!out.header) out.header = obj;
        else out.entries.push(obj);
      } else out.entries.push(obj);
    },
    onDiagnostic: (d) => out.diagnostics.push(d),
    onGap: () => out.gaps++,
  });
  return out;
}

export interface EntryPageResult extends EntryPage {
  diagnostics: { message: string; byteOffset: number }[];
}

/** Page entries from a byte offset (cursor). Returns the page + next cursor. */
export async function readEntryPage(file: string, cursor: string | null | undefined, limit: number): Promise<EntryPageResult> {
  const ident = await fileIdentity(file);
  if (!ident) throw Object.assign(new Error("file not found"), { code: "not_found" });
  const cur = decodeCursor(cursor);
  let startOffset = 0;
  if (cursor) {
    if (!cur || cur.f !== ident.genId) {
      const err = new Error("cursor_expired") as Error & { code?: string };
      err.code = "cursor_expired";
      throw err;
    }
    startOffset = typeof cur.o === "number" ? cur.o : 0;
  }
  const entries: EntryView[] = [];
  const diagnostics: { message: string; byteOffset: number }[] = [];
  let leaf: string | null = null;
  let headerVersion: unknown;
  let done = false;
  let nextOffset = startOffset;
  // Records past the page are still counted (framing only, no decode) so `entryCount` means the
  // same thing here as it does on every other read: the size of the file (BUG-035).
  let seen = 0;
  void headerVersion;
  await streamRecords(file, {
    startOffset,
    onRecord: (rec) => {
      const r = done ? null : decodeRecord(rec, MAX_RECORD_BYTES);
      if (done || !r) { if (done) seen++; return; }
      if (r.header) {
        headerVersion = r.header.version;
        return;
      }
      if (!r.entry) return;
      if (entries.length >= limit) {
        done = true;
        seen++;
        return;
      }
      seen++;
      entries.push(r.entry);
      leaf = r.entry.entryId;
      nextOffset = rec.endOffset;
    },
    onDiagnostic: (d) => { if (!done) diagnostics.push(d); },
  });
  const reachedEOF = !done;
  return {
    fileGeneration: ident.genId,
    entries,
    nextCursor: done ? encodeCursor({ f: ident.genId, o: nextOffset }) : null,
    leafEntryId: reachedEOF ? leaf : null,
    entryCount: seen,
    pageCount: entries.length,
    totalBytes: ident.size,
    diagnostics,
  };
}

/**
 * Read the LAST `limit` entries that come before the entry `beforeId` (exclusive), i.e. page
 * *backwards* through a session so a client holding the newest window can walk to the start.
 * Entry ids are the identity here (not byte offsets): the framer's offsets are chunk-relative
 * and must not be round-tripped by callers. `olderCursor` is the id of the oldest entry handed
 * back, or null when the start of the file was reached.
 */
export async function readEntryBefore(file: string, beforeId: string, limit: number): Promise<EntryPage & { olderCursor: string | null; diagnostics: { message: string; byteOffset: number }[] }> {
  const ident = await fileIdentity(file);
  if (!ident) throw Object.assign(new Error("file not found"), { code: "not_found" });
  const limitN = Math.max(1, Math.min(1000, limit));
  const window: EntryView[] = [];
  const diagnostics: { message: string; byteOffset: number }[] = [];
  let total = 0;
  let found = false;
  await streamRecords(file, {
    onRecord: (rec) => {
      const r = decodeRecord(rec, MAX_RECORD_BYTES);
      if (r.header || !r.entry) {
        if (r.diagnostic && diagnostics.length < 5) diagnostics.push(r.diagnostic);
        return;
      }
      if (r.entry.entryId === beforeId) {
        found = true;
        return;
      }
      if (found) return; // entries after the anchor belong to the caller's window already
      total++;
      window.push(r.entry);
      if (window.length > limitN) window.shift();
    },
    onDiagnostic: (d) => { if (diagnostics.length < 5) diagnostics.push(d); },
  });
  const hasOlder = total > window.length;
  return {
    fileGeneration: ident.genId,
    // An unknown anchor means "nothing before what you hold": hand back nothing rather than a
    // window of the newest records, which a caller would splice in as if it were history.
    entries: found ? window : [],
    nextCursor: null,
    olderCursor: hasOlder && window.length && found ? window[0]!.entryId : null,
    leafEntryId: null,
    entryCount: total,
    pageCount: window.length,
    totalBytes: ident.size,
    diagnostics,
  };
}

/** Read the LAST n entries (full pass; used for bounded snapshots of cold files). */
export async function readEntryTail(file: string, limit: number): Promise<EntryPage & { diagnostics: { message: string; byteOffset: number }[] }> {
  const ident = await fileIdentity(file);
  if (!ident) throw Object.assign(new Error("file not found"), { code: "not_found" });
  const window: EntryView[] = [];
  const limitN = Math.max(1, Math.min(1000, limit));
  let count = 0;
  const diagnostics: { message: string; byteOffset: number }[] = [];
  await streamRecords(file, {
    onRecord: (rec) => {
      const r = decodeRecord(rec, MAX_RECORD_BYTES);
      if (r.header || !r.entry) {
        if (r.diagnostic && diagnostics.length < 5) diagnostics.push(r.diagnostic);
        return;
      }
      count++;
      window.push(r.entry);
      if (window.length > limitN) window.shift();
    },
    onDiagnostic: (d) => { if (diagnostics.length < 5) diagnostics.push(d); },
  });
  return {
    fileGeneration: ident.genId,
    entries: window,
    nextCursor: null,
    leafEntryId: window.length ? window[window.length - 1]!.entryId : null,
    entryCount: count,
    pageCount: window.length,
    totalBytes: ident.size,
    diagnostics,
  };
}

export async function readEntryById(file: string, entryId: string): Promise<EntryView | null> {
  let found: EntryView | null = null;
  await streamRecords(file, {
    onRecord: (rec) => {
      if (found) return;
      const r = decodeRecord(rec, MAX_RECORD_BYTES);
      if (r.entry && r.entry.entryId === entryId) found = r.entry;
    },
  });
  return found;
}

/** Build the read-only tree from file entries; active branch = ancestors of last-on-disk entry. */
export async function buildTree(file: string): Promise<TreeView & { diagnostics: unknown[] }> {
  const parsed = await parseFull(file);
  const nodes: Record<string, TreeNodeView> = {};
  const order: string[] = [];
  for (const e of parsed.entries) {
    const id = typeof e.id === "string" ? e.id : null;
    if (!id) continue;
    const prev = nodes[id];
    if (prev) {
      // duplicate id: later wins for leaf semantics; keep first preview, mark diagnostics via count
      prev.onActiveBranch = false;
    }
    nodes[id] = {
      entryId: id,
      parentId: typeof e.parentId === "string" ? e.parentId : null,
      type: typeof e.type === "string" ? e.type : "unknown",
      timestamp: typeof e.timestamp === "string" ? e.timestamp : "",
      preview: previewOf(e),
      childIds: [],
      onActiveBranch: false,
    };
    if (!prev) order.push(id);
  }
  for (const id of order) {
    const n = nodes[id]!;
    if (n.parentId && nodes[n.parentId] && nodes[n.parentId] !== n) nodes[n.parentId]!.childIds.push(id);
  }
  const roots = order.filter((id) => !nodes[id]!.parentId || !nodes[nodes[id]!.parentId!] );
  const leafId = order.length ? order[order.length - 1]! : null;
  // active branch walk from leaf
  let cur = leafId;
  while (cur && nodes[cur]) {
    nodes[cur]!.onActiveBranch = true;
    cur = nodes[cur]!.parentId;
  }
  const ident = await fileIdentity(file);
  return {
    fileGeneration: ident?.genId ?? "unknown",
    leaf: { entryId: leafId, source: "file" },
    roots,
    nodes,
    diagnostics: parsed.diagnostics,
  };
}

/** User-facing wording for the non-message record types pi writes into a session file. */
const TREE_ENTRY_LABEL: Record<string, string> = {
  model_change: "Model change",
  thinking_level_change: "Thinking level change",
  compaction: "Context compacted",
  session_start: "Session started",
  session_init: "Session started",
  header: "Session header",
  custom: "Extension entry",
  invalid: "Unreadable line",
};

const BLOCK_LABEL: Record<string, string> = {
  text: "Text",
  thinking: "Reasoning",
  toolCall: "Tool call",
  toolResult: "Tool result",
  image: "Image",
};

function flatten(s: string): string {
  return s.replace(/```/g, " ").replace(/[*_`~#>|]+/g, " ").replace(/\s+/g, " ").trim();
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function blocksText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      const o = b as Record<string, unknown>;
      return o && o.type === "text" ? String(o.text ?? "") : "";
    })
    .join(" ");
}

/** One-line, human-readable preview for a tree row: no raw markdown, no internal enums. */
function previewOf(e: Record<string, unknown>): string {
  if (e.type === "message") {
    const m = (e.message ?? {}) as Record<string, unknown>;
    const role = String(m.role ?? "");
    const content = m.content;
    const body = typeof content === "string" ? content : blocksText(content);
    if (m.isError) return flatten(`Error: ${body}`) || "Error turn";
    const text = flatten(body);
    if (text) return text.slice(0, 160);
    if (Array.isArray(content)) {
      const kinds = [...new Set(content.map((b) => String((b as Record<string, unknown>)?.type ?? "")).filter(Boolean))];
      if (kinds.length) return kinds.map((k) => BLOCK_LABEL[k] ?? cap(k)).join(" · ");
    }
    return role ? `${cap(role)} (no text)` : "Empty message";
  }
  const known = TREE_ENTRY_LABEL[String(e.type ?? "")];
  if (known) return known;
  const t = String(e.type ?? "");
  return t ? cap(t.replace(/[_-]+/g, " ")) : "Entry";
}

export interface SessionSummary {
  meta: SessionMeta;
  diagnostics: number;
}

/** Bounded metadata scan for session lists (no transcript copy is retained). */
export async function summarizeSessionFile(file: string, sessionKey: string, workspaceKey: string | null): Promise<SessionSummary> {
  const ident = await fileIdentity(file);
  let header: Record<string, unknown> | null = null;
  let name: string | null = null;
  let firstPrompt: string | null = null;
  let messageCount = 0;
  let diagnostics = 0;
  let searchText = "";
  const SCAN_CAP = 2 * 1024 * 1024;
  await streamRecords(file, {
    maxBytes: SCAN_CAP,
    onRecord: (rec) => {
      const obj = JSON.parse(rec.bytes.toString("utf8")) as Record<string, unknown>;
      if (obj.type === "session" && !header) {
        header = obj;
        return;
      }
      if (obj.type === "message") {
        messageCount++;
        const m = obj.message as Record<string, unknown> | undefined;
        const role = m?.role;
        const text = extractText(m?.content);
        if (role === "user" && !firstPrompt && text) firstPrompt = text.slice(0, 240);
        if (searchText.length < 64 * 1024 && text) searchText += "\n" + text.slice(0, 2000);
      } else if (obj.type === "session_info" && typeof obj.name === "string") {
        name = obj.name;
      }
    },
    onDiagnostic: () => diagnostics++,
  });
  const st = await lstat(file).catch(() => null);
  const h = header as Record<string, unknown> | null;
  return {
    meta: {
      sessionKey,
      workspaceKey,
      path: file,
      piSessionId: typeof h?.id === "string" ? h.id : null,
      cwd: typeof h?.cwd === "string" ? h.cwd : "",
      name,
      created: typeof h?.timestamp === "string" ? h.timestamp : st ? new Date(st.birthtimeMs).toISOString() : null,
      modified: st ? new Date(st.mtimeMs).toISOString() : null,
      messageCount,
      firstPrompt,
      sizeBytes: ident?.size ?? null,
      version: typeof h?.version === "number" ? h.version : null,
    },
    diagnostics,
  };
}

export function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const b of content) {
      if (b && typeof b === "object" && (b as Record<string, unknown>).type === "text") parts.push(String((b as Record<string, unknown>).text ?? ""));
    }
    return parts.join("\n");
  }
  return "";
}

/** List candidate session files under a root (recursive .jsonl scan with depth/count bounds). */
export async function listSessionFiles(root: string, maxDepth = 3, maxFiles = 5000): Promise<string[]> {
  const out: string[] = [];
  const stack: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (stack.length && out.length < maxFiles) {
    const { dir, depth } = stack.pop()!;
    let dirents;
    try {
      dirents = await (await import("node:fs/promises")).readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const de of dirents) {
      const full = path.join(dir, de.name);
      if (de.isFile() && de.name.endsWith(".jsonl")) out.push(full);
      else if (de.isDirectory() && depth < maxDepth && !de.name.startsWith(".")) stack.push({ dir: full, depth: depth + 1 });
      if (out.length >= maxFiles) break;
    }
  }
  return out.sort();
}

/* ---------- projections through Pi pure helpers (in-memory only) ---------- */

export async function projectContext(file: string, importPi: () => Promise<any>): Promise<ContextView> {
  const pi = await importPi();
  const parsed = await parseFull(file);
  // migrateSessionEntries inspects the file-entry list INCLUDING the header to decide
  // whether a version migration applies; passing entries only would make it treat a v3
  // file as legacy and rewrite ids/parents in memory. The original file is never touched.
  const all: any[] = parsed.header ? [parsed.header, ...parsed.entries] : [...parsed.entries];
  try {
    pi.migrateSessionEntries(all);
  } catch {
    /* already-current or unknown shape: keep raw entries; projection helpers are defensive */
  }
  const sessionEntries = all.filter((e) => e.type !== "session");
  const leaf = sessionEntries.length ? sessionEntries[sessionEntries.length - 1]?.id ?? null : null;
  const projection = pi.buildSessionContext(sessionEntries, leaf, undefined);
  const messages: ContextView["messages"] = (projection.messages ?? []).map((m: any) => ({
    role: String(m.role ?? m.type ?? "unknown"),
    content: m.content ?? null,
    entryId: m.entryId ?? null,
  }));
  return {
    kind: "persisted_projection",
    leafEntryId: leaf,
    capturedAt: new Date().toISOString(),
    model: projection.model ?? null,
    thinkingLevel: projection.thinkingLevel ?? null,
    messages,
    unavailableFields: ["systemPrompt", "toolDeclarations", "routing", "providerPayload"],
    note: "Persisted projection from Pi pure helpers. Not the exact next provider request: runtime hooks, model routing, tools and provider conversion may change it.",
  };
}

export async function computeStats(file: string): Promise<StatsView> {
  const parsed = await parseFull(file);
  const counts = { user: 0, assistant: 0, toolResult: 0, other: 0 };
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let hasUsage = false;
  const addUsage = (u: any) => {
    if (!u || typeof u !== "object") return;
    hasUsage = true;
    for (const [k, t] of [["input", "input"], ["output", "output"], ["cacheRead", "cacheRead"], ["cacheWrite", "cacheWrite"], ["cost", "cost"], ["costUSD", "cost"], ["totalCost", "cost"]] as const) {
      const v = u[k];
      if (typeof v === "number") totals[t as keyof typeof totals] += v;
    }
  };
  for (const e of parsed.entries) {
    if (e.type === "message") {
      const m = e.message as Record<string, unknown> | undefined;
      const role = String(m?.role ?? "");
      if (role === "user") counts.user++;
      else if (role === "assistant") {
        counts.assistant++;
        addUsage(m?.usage);
      } else if (role === "toolResult") counts.toolResult++;
      else counts.other++;
    } else if (e.type === "usage") {
      addUsage((e as Record<string, unknown>).usage);
    } else counts.other++;
  }
  return {
    source: "persisted_totals",
    totalEntries: parsed.entries.length,
    messageCounts: counts,
    usageTotals: hasUsage ? { ...totals, cost: totals.cost || null } : null,
    contextUsage: null,
    runtimeUsage: null,
    note: "Persisted totals computed from usage records on file. Runtime usage/context accounting is only available from the owning runtime.",
  };
}

export async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}
