/** Typed HTTP client for the pi-web API. Cookie auth + CSRF header; never sends bearer here. */
let csrfToken = "";

export class ApiError extends Error {
  code: string;
  status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, init: RequestInit = {}, idempotencyKey?: string): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(init.body ? { "content-type": "application/json" } : {}),
    ...(csrfToken ? { "x-piweb-csrf": csrfToken } : {}),
    ...((init.headers as Record<string, string>) ?? {}),
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const res = await fetch(path, { ...init, headers, credentials: "same-origin" });
  const text = await res.text();
  let data: unknown = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text.slice(0, 2000) }; }
  if (!res.ok) {
    const e = (data as { error?: { code?: string; message?: string } })?.error;
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? `${res.status} ${res.statusText}`);
  }
  return data as T;
}

export const api = {
  get: <T,>(path: string, init?: RequestInit) => request<T>(path, init ?? {}),
  post: <T,>(path: string, body?: unknown, idem?: string) =>
    request<T>(path, { method: "POST", body: body === undefined ? null : JSON.stringify(body) }, idem),
  del: <T,>(path: string) => request<T>(path, { method: "DELETE" }),
  setCsrf: (t: string) => { csrfToken = t; },
  getCsrf: () => csrfToken,
};

export function newOperationId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Download a session log in full. `GET /sessions/:key/raw` answers at most one range
 * (RAW_RANGE_MAX_BYTES) per request, so a plain link to it silently saves the first megabyte of a
 * large session (BUG-005). Walk the file with `Content-Range` and hand the assembled bytes over as
 * one file instead; if a server does not send `Content-Range`, fall back to that first body.
 */
export async function downloadSessionLog(sessionKey: string, filename: string): Promise<{ bytes: number; truncated: boolean }> {
  const chunks: BlobPart[] = [];
  let offset = 0;
  let total = Number.POSITIVE_INFINITY;
  let guard = 0;
  for (;;) {
    if (++guard > 4_096) break;
    const res = await fetch(`/api/v1/sessions/${encodeURIComponent(sessionKey)}/raw?offset=${offset}`, { credentials: "same-origin" });
    if (!res.ok) throw new ApiError(res.status, "error", `${res.status} ${res.statusText}`);
    const buf = await res.arrayBuffer();
    if (buf.byteLength === 0) break;
    chunks.push(buf);
    offset += buf.byteLength;
    const cr = res.headers.get("content-range");
    const fromRange = cr ? Number(cr.split("/")[1]) : NaN;
    if (Number.isFinite(fromRange)) total = fromRange;
    else if (res.status === 200) break; // whole remainder in one go
    if (offset >= total) break;
  }
  const blob = new Blob(chunks, { type: "application/x-ndjson" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return { bytes: blob.size, truncated: Number.isFinite(total) && blob.size < total };
}
