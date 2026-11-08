/** EventSource wrapper. Cookies authenticate; Last-Event-ID reconnect is automatic. */
const EVENTS = ["snapshot", "resync", "entry", "preview", "toolState", "runtimeState", "queueState", "dialogRequest", "dialogResolved", "conflict", "operationState", "ownerChanged", "hostExited", "controlState"] as const;

export interface SseHandlers {
  onEvent: (name: string, payload: unknown) => void;
  onOpen?: () => void;
  onStatus?: (s: "connecting" | "live" | "closed") => void;
}

export class SseManager {
  private es: EventSource | null = null;
  private closed = false;

  constructor(key: string, private h: SseHandlers) {
    this.connect(key);
  }

  private connect(key: string) {
    if (this.closed) return;
    this.h.onStatus?.("connecting");
    const es = new EventSource(`/api/v1/sessions/${encodeURIComponent(key)}/events`, { withCredentials: true });
    this.es = es;
    es.onopen = () => this.h.onOpen?.();
    es.onerror = () => {
      // EventSource retries internally; only mark closed if it gave up (CONNECTING=0 impossible here after close)
      if (es.readyState === EventSource.CLOSED) this.h.onStatus?.("closed");
      else this.h.onStatus?.("connecting");
    };
    for (const name of EVENTS) {
      es.addEventListener(name, (ev: MessageEvent) => {
        try {
          const env = JSON.parse(ev.data) as { payload?: unknown };
          this.h.onEvent(name, env.payload ?? {});
        } catch { /* malformed frame: ignore, resync will follow if critical */ }
      });
    }
  }

  close() {
    this.closed = true;
    try { this.es?.close(); } catch { /* ignore */ }
    this.es = null;
    this.h.onStatus?.("closed");
  }
}
