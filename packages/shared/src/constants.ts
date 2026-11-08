/** Shared constants and limits for pi-web v1. */

export const PROTOCOL_VERSION = 1;
export const API_BASE = "/api/v1";

/** Default bind/port (plan D-13, reliability.md). */
export const DEFAULT_PORT = 4319;
export const DEFAULT_BIND = "127.0.0.1";

/** Encoded request ceiling (api_spec.md: strict JSON, 8 MiB). */
export const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
/** Max images per prompt and per-image decoded bytes. */
export const MAX_IMAGES_PER_PROMPT = 4;
export const MAX_IMAGE_ENCODED_BYTES = 5 * 1024 * 1024;
export const MAX_IMAGE_PIXELS = 40_000_000;
/** JSON nesting depth cap for all untrusted JSON input. */
export const MAX_JSON_DEPTH = 64;
/** Max bytes of a single persisted session record we will parse. Larger records surface as diagnostics. */
export const MAX_RECORD_BYTES = 64 * 1024 * 1024;
/** File viewer text cap (security.md: 2 MiB). */
export const MAX_FILE_VIEW_BYTES = 2 * 1024 * 1024;
/** Text is handed to the browser in preview-sized pieces; the panel never injects a whole file. */
export const MAX_FILE_PREVIEW_BYTES = 256 * 1024;
/** Raw session download/read chunk bounds. */
export const RAW_RANGE_MAX_BYTES = 4 * 1024 * 1024;

/** Entries per page for paged reads. */
export const ENTRIES_PAGE_DEFAULT = 200;
export const ENTRIES_PAGE_MAX = 1000;
/** Session list page size. */
export const SESSIONS_PAGE_MAX = 200;

/** SSE transport limits (event_rendering.md / api_spec.md). */
export const SSE_MAX_FRAMES = 5000;
export const SSE_MAX_BYTES = 8 * 1024 * 1024;
export const SSE_HEARTBEAT_MS = 15_000;
export const SSE_CLIENT_SILENCE_MS = 45_000;
/** Max cumulative in-flight preview blocks retained per streaming message. */
export const MAX_PREVIEW_MESSAGE_BYTES = 2 * 1024 * 1024;
/** Max tool output bytes retained in live tool-state snapshots. */
export const MAX_TOOL_STATE_BYTES = 1 * 1024 * 1024;
/** Snapshot entry page default (bounded snapshot). */
export const SNAPSHOT_ENTRY_PAGE = 300;
/** Max pending dialogs tracked per runtime. */
export const MAX_PENDING_DIALOGS = 32;
/** Max observed (terminal) dialogs retained. */
export const MAX_OBSERVED_DIALOGS = 16;

/** Control grant lifecycle (api_spec.md). */
export const CONTROL_TTL_MS = 30_000;
export const CONTROL_RENEW_MS = 10_000;

/** Managed runtime capacity (reliability.md defaults). */
export const MAX_MANAGED_RUNTIMES = 4;
export const MAX_FILE_MIRROR_VIEWS = 8;
/** Settled, unobserved managed host cleanup delay. Resource cleanup, not an execution limit. */
export const SETTLED_HOST_CLEANUP_MS = 60_000;
/** Dispatch acknowledgement deadline; timeout => reconciliation, never automatic retry. */
export const DISPATCH_ACK_TIMEOUT_MS = 10_000;
/** Runtime health ping interval/misses. */
export const HEALTH_PING_MS = 5_000;
export const HEALTH_MAX_MISSES = 3;
/** File tail reconciliation target. */
export const TAIL_RECONCILE_MS = 250;
/** Tail read chunk and work burst. */
export const TAIL_CHUNK_BYTES = 64 * 1024;
export const TAIL_WORK_BURST_BYTES = 4 * 1024 * 1024;
/** Tail partial-record buffer cap. */
export const TAIL_PARTIAL_MAX = MAX_RECORD_BYTES;

/** Operation receipt retention after terminal state. */
export const OPERATION_RETENTION_MS = 24 * 3600_000;

export const SESSION_COOKIE_NAME = "piweb_session";
export const CSRF_HEADER_NAME = "x-piweb-csrf";

/** Pi versions whose adapter has been validated end-to-end by this build.
 * Unlisted versions are read-only until e2e compatibility probes pass (D-14).
 * Kept as the canonical list; `PI_VALIDATED_VERSIONS` is the plan-03 (§8) name for it. */
export const TESTED_PI_VERSIONS: readonly string[] = ["1.5.0"];
export const PI_VALIDATED_VERSIONS: readonly string[] = TESTED_PI_VERSIONS;
/** Bridge wire protocols this build speaks (03 §8). */
export const PI_SUPPORTED_PROTOCOLS: readonly number[] = [1];

/**
 * Escape hatch for the fail-closed version gate (B-10): `PIWEB_ALLOW_PI_VERSIONS=1.6.0,1.7.0`.
 * Writes stay disabled on any version that is neither validated nor listed here; reads never are.
 */
export function allowedPiVersions(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.PIWEB_ALLOW_PI_VERSIONS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
export function isPiVersionAllowed(version: string | null | undefined, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!version) return false;
  return TESTED_PI_VERSIONS.includes(version) || allowedPiVersions(env).includes(version);
}

export type ErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "owner_conflict"
  | "busy"
  | "idempotency_conflict"
  | "cursor_expired"
  | "stale_control"
  | "payload_too_large"
  | "read_only"
  | "capacity"
  | "unsupported_capability"
  | "pi_command_failed"
  | "host_unavailable"
  | "timeout";

export const ERROR_HTTP_STATUS: Record<ErrorCode, number> = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  owner_conflict: 409,
  busy: 409,
  idempotency_conflict: 409,
  cursor_expired: 410,
  stale_control: 412,
  payload_too_large: 413,
  read_only: 423,
  capacity: 429,
  unsupported_capability: 501,
  pi_command_failed: 502,
  host_unavailable: 503,
  timeout: 504,
};

/** Requests one principal may make per minute before the API answers 429 (see Auth.rateOk). */
export const API_RATE_PER_MINUTE = 600;
