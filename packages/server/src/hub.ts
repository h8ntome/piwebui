/**
 * SSE transport hub. Per session: transport epoch + monotonic seq + bounded replay log
 * (frames AND bytes). Transport cursors (epoch:seq) are separate from persisted page
 * cursors. Delivery is at-least-once; the client reducer reconciles duplicates.
 *
 * Ordering barrier: subscribe() registers a buffering subscriber and returns the barrier
 * seq. The caller captures its snapshot afterwards, sends it with id=barrier, then calls
 * goLive() which flushes buffered frames with seq > barrier. Events never fall into a
 * snapshot/subscribe gap.
 */
import crypto from "node:crypto";
import { SSE_HEARTBEAT_MS, SSE_MAX_BYTES, SSE_MAX_FRAMES } from "@pi-web/shared";
import type { StreamEventName, StreamEnvelope } from "@pi-web/shared";

export interface Subscriber {
  id: number;
  state: "buffering" | "live" | "closing";
  barrier: number;
  queue: string[];
  queueBytes: number;
  write: (frame: string) => void;
  onResync: () => void;
  closed: boolean;
}

class SessionStream {
  epoch = crypto.randomBytes(4).toString("hex");
  seq = 0;
  ring: { seq: number; frame: string; bytes: number }[] = [];
  ringBytes = 0;
  subs = new Set<Subscriber>();
  private subSeq = 0;
  private heartbeat: NodeJS.Timeout | null = null;
  sessionGeneration = 1;

  constructor(public sessionKey: string) {}

  bumpGeneration() { this.sessionGeneration++; }

  subscribe(write: (frame: string) => void, onResync: () => void): Subscriber {
    const sub: Subscriber = { id: ++this.subSeq, state: "buffering", barrier: this.seq, queue: [], queueBytes: 0, write, onResync, closed: false };
    this.subs.add(sub);
    this.ensureHeartbeat();
    return sub;
  }

  goLive(sub: Subscriber) {
    const buffered = sub.queue;
    sub.queue = [];
    sub.queueBytes = 0;
    sub.state = "live";
    for (const f of buffered) if (!sub.closed) sub.write(f);
  }

  unsubscribe(sub: Subscriber) {
    sub.closed = true;
    this.subs.delete(sub);
    if (this.subs.size === 0 && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }

  /**
   * Emit a transport event. Returns null for no subscribers (still records ring).
   * opts.noReplay: exclude from replay log (heartbeats), opts.replaceKey: coalesce
   * superseded previews (replace older frame with same key in ring + subscriber queues
   * is approximated by dropping identical-key frames from the queue).
   */
  emit(name: StreamEventName, payload: unknown, opts: { noReplay?: boolean | undefined; replaceKey?: string | undefined; entryId?: string | undefined; liveMessageId?: string | undefined; source?: "file" | "runtime" | undefined } = {}): number {
    const seq = ++this.seq;
    const env: StreamEnvelope = {
      name,
      source: opts.source ?? (name === "entry" ? "file" : "runtime"),
      streamEpoch: this.epoch,
      seq,
      sessionGeneration: this.sessionGeneration,
      payload,
      ...(opts.entryId ? { entryId: opts.entryId } : {}),
      ...(opts.liveMessageId ? { liveMessageId: opts.liveMessageId } : {}),
    };
    const frame = encodeFrame(name, `${this.epoch}:${seq}`, env);
    if (!opts.noReplay) {
      this.ring.push({ seq, frame, bytes: frame.length });
      this.ringBytes += frame.length;
      while (this.ring.length > SSE_MAX_FRAMES || this.ringBytes > SSE_MAX_BYTES) {
        const drop = this.ring.shift();
        if (!drop) break;
        this.ringBytes -= drop.bytes;
      }
    }
    for (const sub of this.subs) {
      if (sub.closed) continue;
      if (sub.state === "buffering") {
        if (seq > sub.barrier) this.enqueue(sub, frame, opts.replaceKey);
      } else {
        this.enqueue(sub, frame, opts.replaceKey);
      }
    }
    return seq;
  }

  private enqueue(sub: Subscriber, frame: string, replaceKey?: string) {
    if (sub.queueBytes > SSE_MAX_BYTES / 2) {
      // Slow consumer: force resync instead of unbounded buffering (F-16).
      sub.queue = [];
      sub.queueBytes = 0;
      sub.state = "buffering";
      sub.barrier = this.seq;
      try { sub.onResync(); } catch { /* ignore */ }
      return;
    }
    if (replaceKey) sub.queue = sub.queue.filter((f) => !f.includes(`"replaceKey":"${replaceKey}"`));
    sub.queue.push(frame);
    sub.queueBytes += frame.length;
    if (sub.state === "live") this.drain(sub);
  }

  drain(sub: Subscriber) {
    const q = sub.queue;
    sub.queue = [];
    sub.queueBytes = 0;
    for (const f of q) { if (sub.closed) break; sub.write(f); }
  }

  resyncNow(sub: Subscriber, reason: string) {
    const frame = encodeFrame("resync", undefined, { name: "resync", source: "none", streamEpoch: this.epoch, seq: this.seq, sessionGeneration: this.sessionGeneration, payload: { reason } } as never);
    try { sub.write(frame); } catch { /* ignore */ }
    sub.state = "buffering";
    sub.barrier = this.seq;
    sub.queue = [];
    sub.queueBytes = 0;
  }

  /** Resume a subscriber from "epoch:seq". Returns false when a full resnapshot is required. */
  resume(sub: Subscriber, cursor: string | null): { ok: boolean; reason?: string } {
    if (!cursor) return { ok: true };
    const [epoch, seqStr] = cursor.split(":");
    if (epoch !== this.epoch) return { ok: false, reason: "stream_epoch_changed" };
    const lastSeq = Number(seqStr);
    if (!Number.isFinite(lastSeq)) return { ok: false, reason: "bad_cursor" };
    if (this.ring.length === 0 || lastSeq < this.ring[0]!.seq - 1) return { ok: false, reason: "evicted" };
    // buffered frames > lastSeq are already in sub.queue only if emitted after subscribe;
    // for resume we replay from the ring directly:
    for (const item of this.ring) {
      if (item.seq > lastSeq) sub.write(item.frame);
    }
    return { ok: true };
  }

  private ensureHeartbeat() {
    if (this.heartbeat) return;
    this.heartbeat = setInterval(() => {
      const frame = encodeFrame("heartbeat", undefined, {
        name: "heartbeat", source: "none", streamEpoch: this.epoch as never, seq: this.seq,
        sessionGeneration: this.sessionGeneration, payload: { at: new Date().toISOString() },
      } as never);
      for (const sub of this.subs) if (!sub.closed && sub.state === "live") sub.write(frame);
    }, SSE_HEARTBEAT_MS);
    this.heartbeat.unref?.();
  }

  hasSubs() { return this.subs.size > 0; }
}

export function encodeFrame(name: string, id: string | undefined, env: unknown): string {
  let out = `event: ${name}\n`;
  if (id) out += `id: ${id}\n`;
  out += `data: ${JSON.stringify(env)}\n\n`;
  return out;
}

export class StreamHub {
  private streams = new Map<string, SessionStream>();

  stream(sessionKey: string): SessionStream {
    let s = this.streams.get(sessionKey);
    if (!s) { s = new SessionStream(sessionKey); this.streams.set(sessionKey, s); }
    return s;
  }

  drop(sessionKey: string) {
    const s = this.streams.get(sessionKey);
    if (!s) return;
    for (const sub of [...s.subs]) { try { sub.write(encodeFrame("streamEnd", undefined, { name: "streamEnd", source: "none", streamEpoch: s.epoch as never, seq: s.seq, sessionGeneration: s.sessionGeneration, payload: {} }) ); } catch { /* ignore */ } sub.closed = true; }
    this.streams.delete(sessionKey);
  }

  epoch(sessionKey: string): string {
    return this.stream(sessionKey).epoch;
  }
  generation(sessionKey: string): number {
    return this.stream(sessionKey).sessionGeneration;
  }
  bumpGeneration(sessionKey: string) {
    this.stream(sessionKey).bumpGeneration();
  }
  emit(sessionKey: string, name: StreamEventName, payload: unknown, opts?: Parameters<SessionStream["emit"]>[2]) {
    return this.stream(sessionKey).emit(name, payload, opts);
  }
  subscribe(sessionKey: string, write: (f: string) => void, onResync: () => void) {
    return this.stream(sessionKey).subscribe(write, onResync);
  }
  getStream(sessionKey: string) { return this.stream(sessionKey); }
}
