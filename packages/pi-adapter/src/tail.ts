/**
 * Byte-level, LF-only JSONL framing (Node readline is deliberately avoided: it splits
 * U+2028/U+2029 which are valid characters inside JSON strings — see plan appendix).
 * Offsets are absolute byte offsets in the file.
 */
import type { EntryView } from "@pi-web/shared";

export interface FramedRecord {
  bytes: Buffer;
  startOffset: number;
  endOffset: number;
}

/** Incremental framer over a byte stream starting at `startOffset`. */
export class LfFramer {
  private held: Buffer[] = [];
  private heldLen = 0;
  private lineStart: number | null = null;
  pos: number;
  overflow = false;

  constructor(private maxPartial: number, startOffset = 0) {
    this.pos = startOffset;
  }

  get partialBytes(): number {
    return this.heldLen;
  }

  feed(data: Buffer): FramedRecord[] {
    const out: FramedRecord[] = [];
    let cursor = 0;
    while (cursor < data.length) {
      const nl = data.indexOf(0x0a, cursor);
      const segEnd = nl === -1 ? data.length : nl;
      const seg = data.subarray(cursor, segEnd);
      if (seg.length > 0) {
        if (this.heldLen === 0) this.lineStart = this.pos + cursor;
        this.held.push(Buffer.from(seg));
        this.heldLen += seg.length;
      }
      if (nl === -1) {
        this.pos += data.length - cursor;
        cursor = data.length;
        break;
      }
      // Complete record ends at absolute offset pos+nl (LF byte).
      let body: Buffer;
      if (this.held.length === 1) body = this.held[0]!;
      else body = Buffer.concat(this.held, this.heldLen);
      if (body.length > 0 && body[body.length - 1] === 0x0d) body = body.subarray(0, body.length - 1);
      const start = this.lineStart ?? this.pos + cursor;
      out.push({ bytes: body, startOffset: start, endOffset: this.pos + nl + 1 });
      this.held = [];
      this.heldLen = 0;
      this.lineStart = null;
      this.pos += nl + 1;
      cursor = nl + 1;
    }
    if (this.heldLen > this.maxPartial) {
      // A single record exceeded the partial buffer cap. Drop and mark a gap so the
      // caller can record a diagnostic instead of growing memory without bound.
      this.held = [];
      this.heldLen = 0;
      this.lineStart = null;
      this.overflow = true;
    }
    return out;
  }
}

export interface DecodeResult {
  entry?: EntryView;
  header?: Record<string, unknown>;
  diagnostic?: { message: string; byteOffset: number };
}

/** Decode one framed record. Never throws; invalid JSON becomes a diagnostic + invalid EntryView. */
export function decodeRecord(rec: FramedRecord, maxRawBytes: number): DecodeResult {
  const { bytes, startOffset } = rec;
  if (bytes.length === 0) return {};
  const text = bytes.toString("utf8");
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (e) {
    return { diagnostic: { message: `invalid JSON line: ${(e as Error).message}`.slice(0, 300), byteOffset: startOffset } };
  }
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    return { diagnostic: { message: "record is not a JSON object", byteOffset: startOffset } };
  }
  const recObj = obj as Record<string, unknown>;
  const truncated = bytes.length > maxRawBytes;
  const view: EntryView = {
    entryId: typeof recObj.id === "string" ? recObj.id : `noid-${startOffset}`,
    parentId: typeof recObj.parentId === "string" ? recObj.parentId : null,
    type: typeof recObj.type === "string" ? recObj.type : "unknown",
    timestamp: typeof recObj.timestamp === "string" ? recObj.timestamp : "",
    raw: truncated ? { _truncated: true, _preview: text.slice(0, 4000) } : recObj,
    byteOffset: startOffset,
    byteLength: bytes.length + 1,
  };
  if (truncated) view.truncated = true;
  if (recObj.type === "session") return { header: recObj };
  return { entry: view };
}

export interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

export function identityFromStats(st: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }): FileIdentity {
  return { dev: st.dev, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs };
}

/** Generation string changes on replacement (dev/ino change) or rewrite (same size but ctime/mtime change with shrink-rename patterns handled by caller fingerprint). */
export function generationId(id: FileIdentity): string {
  return `g${id.dev.toString(36)}-${id.ino.toString(36)}-${id.size.toString(36)}`;
}

export type ChangeKind = "append" | "replace" | "shrink" | "unchanged" | "deleted";

export interface TailState {
  identity: FileIdentity;
  offset: number;
  tailFingerprint: string;
}

/**
 * Classify a stat change. Same size + changed mtime alone is ambiguous (touch), so we
 * also compare the last-K-bytes fingerprint the caller maintains: identical offset/size
 * with a different fingerprint means same-size replacement.
 */
export function classifyChange(prev: TailState, next: FileIdentity, newTailFingerprint: string | null): ChangeKind {
  if (next.ino !== prev.identity.ino || next.dev !== prev.identity.dev) return "replace";
  if (next.size < prev.offset) return "shrink";
  if (next.size > prev.offset) return "append";
  if (newTailFingerprint !== null && newTailFingerprint !== prev.tailFingerprint) return "replace";
  return "unchanged";
}

export const FINGERPRINT_BYTES = 64;
