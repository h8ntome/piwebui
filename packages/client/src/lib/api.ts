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
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown, idem?: string) =>
    request<T>(path, { method: "POST", body: body === undefined ? null : JSON.stringify(body) }, idem),
  del: <T,>(path: string) => request<T>(path, { method: "DELETE" }),
  setCsrf: (t: string) => { csrfToken = t; },
  getCsrf: () => csrfToken,
};

export function newOperationId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `op-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
