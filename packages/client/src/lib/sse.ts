/** EventSource wrapper. Cookies authenticate; Last-Event-ID reconnect is automatic.
    EventSource never tells the app "I gave up" while it keeps retrying, so this wrapper
    watches the traffic itself: a stream that has been silent past two server heartbeats
    (15 s apart) is reported as `closed`, which is what the UI shows as "stream disconnected". */
const EVENTS = ["snapshot", "resync", "entry", "preview", "toolState", "runtimeState", "queueState", "dialogRequest", "dialogResolved", "conflict", "operationState", "ownerChanged", "hostExited", "controlState", "heartbeat"] as const;

/** The server heartbeat is 15 s; allow two of them plus slack before calling it dead. */
const STALE_MS = 40_000;
const WATCH_MS = 5_000;

export interface SseHandlers {
  onEvent: (name: string, payload: unknown) => void;
  onOpen?: () => void;
  onStatus?: (s: "connecting" | "live" | "closed") => void;
}

export class SseManager {
  private es: EventSource | null = null;
  private closed = false;
  private lastEventAt = Date.now();
  private live = false;
  private retries = 0;
  private timer: number | null = null;

  constructor(key: string, private h: SseHandlers) {
    this.connect(key);
  }

  /** How many times the connection has dropped since it last worked (0 while healthy). */
  get reconnects(): number { return this.retries; }

  private mark(s: "connecting" | "live" | "closed") {
    if (s === "live") this.live = true;
    else if (s === "connecting" && this.live) this.retries++;
    if (s === "closed") this.live = false;
    this.h.onStatus?.(s);
  }

  private connect(key: string) {
    if (this.closed) return;
    this.h.onStatus?.("connecting");
    const es = new EventSource(`/api/v1/sessions/${encodeURIComponent(key)}/events`, { withCredentials: true });
    this.es = es;
    this.lastEventAt = Date.now();
    es.onopen = () => { this.mark("live"); this.h.onOpen?.(); };
    es.onerror = () => {
      // EventSource retries internally; only mark closed if it gave up (CONNECTING=0 impossible here after close)
      if (es.readyState === EventSource.CLOSED) this.mark("closed");
      else this.mark("connecting");
    };
    for (const name of EVENTS) {
      es.addEventListener(name, (ev: MessageEvent) => {
        this.lastEventAt = Date.now();
        if (!this.live) this.mark("live");
        try {
          const env = JSON.parse(ev.data) as { payload?: unknown };
          this.h.onEvent(name, env.payload ?? {});
        } catch { /* malformed frame: ignore, resync will follow if critical */ }
      });
    }
    if (this.timer == null) {
      this.timer = window.setInterval(() => {
        if (this.closed) return;
        const silentFor = Date.now() - this.lastEventAt;
        if (this.live && silentFor > STALE_MS) this.mark("closed");
      }, WATCH_MS);
    }
  }

  close() {
    this.closed = true;
    if (this.timer != null) { window.clearInterval(this.timer); this.timer = null; }
    try { this.es?.close(); } catch { /* ignore */ }
    this.es = null;
    this.h.onStatus?.("closed");
  }
}
