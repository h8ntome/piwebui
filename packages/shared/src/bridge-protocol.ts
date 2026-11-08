/**
 * pi-web bridge protocol (dial model, bridge_plan D-1/D-2/D-3).
 *
 * Transport: one Unix stream socket per pi-web server, `<dataDir>/bridge-<serverId>.sock`,
 * newline-delimited JSON frames. The *terminal pi* dials the server (the extension owns the
 * client role), so the server is the inbound listener and must therefore attest what a bridge
 * claims about itself (D-6): the claimed pid must be a live process that really looks like pi
 * and really started at the claimed time.
 *
 * This module is the single source of truth for frame and descriptor shapes. The extension
 * cannot import it (it must load with Node builtins alone inside pi's jiti), so
 * `packages/pi-extension/extensions/pi-web-bridge.js` keeps a deliberately small, structurally
 * identical copy; `packages/pi-extension/test/protocol-parity.test.mts` fails if the two
 * disagree on limits or frame names.
 */
import type { Capabilities } from "./types.ts";

export const BRIDGE_PROTOCOL = 1;
export const BRIDGE_MIN_PROTOCOL = 1;

/** Descriptor schema version (`bridge.json`'s `v`). */
export const BRIDGE_DESCRIPTOR_V = 1;

export const BRIDGE_MAX_CONNS = 32;
export const BRIDGE_AUTH_TIMEOUT_MS = 5_000;
/** Bounded replay window the *extension* keeps for reconnect replay (per runtime). */
export const BRIDGE_REPLAY_FRAMES = 2_000;
export const BRIDGE_REPLAY_BYTES = 4 * 1024 * 1024;
/** Per-connection inbound buffer ceiling (frame reassembly). */
export const BRIDGE_INBOUND_BYTES = 8 * 1024 * 1024;
/** Per-frame ceiling inside that buffer. */
export const BRIDGE_MAX_FRAME_BYTES = 4 * 1024 * 1024;
/** Sustained frames/second before a connection is shed (backpressure on the server side). */
export const BRIDGE_MAX_FRAMES_PER_SEC = 20;
/** How many servers one pi may connect to at once. */
export const BRIDGE_MAX_SERVERS = 4;
/** Attestation tolerance: |claimed procStart - OS-observed start| must stay inside this. */
export const BRIDGE_ATTEST_TOLERANCE_MS = 5_000;
/** Reject descriptors whose `updatedAt` is older than this (a dead server's leftover). */
export const BRIDGE_DESCRIPTOR_MAX_AGE_MS = 365 * 24 * 3600_000;

/* ------------------------------- frames ------------------------------- */

export interface BridgeHelloFrame {
  t: "hello";
  protocol: number;
  minProtocol: number;
  /** Per-process identity: survives /new, /resume, /fork, /reload. */
  runtimeId: string;
  pid: number;
  /** floor(performance.timeOrigin) in ms epoch; attested by the server. */
  procStart: number;
  /** pi session UUID — the primary identity for adoption (D-3). */
  sessionId: string;
  sessionFile: string | null;
  cwd: string;
  piVersion: string;
  piMode: "tui" | "rpc" | "json" | "print";
  adapterVersion: string;
  startedAt: string;
  sessionGeneration: number;
  capabilities: Capabilities;
  /** Optional extras; the server never trusts them, it re-derives them from the OS. */
  attest?: { cmdlineHash?: string; childOfPi?: boolean };
  /** Reconnect resume: "I have delivered up to this seq". */
  resume?: { lastSeq: number };
}

export type BridgeFrame =
  | { t: "auth"; token: string; clientVersion?: string }
  | ({ t: "hello" } & BridgeHelloFrame)
  | { t: "auth_ok"; serverId: string; protocol: number; minProtocol: number; resumedFrom: number | null }
  | { t: "auth_error"; code: string; message: string }
  | { t: "ev"; seq: number; name: string; payload: Record<string, unknown> }
  | { t: "cmd"; id: string; cmd: string; args?: unknown; sessionGeneration?: number; operationId?: string }
  | { t: "res"; id: string; ok: boolean; data?: unknown; error?: { code: string; message: string } }
  | { t: "ping"; id: string; lastSeenSeq?: number }
  | { t: "pong"; id: string; lastSeenSeq?: number }
  | { t: "replay"; fromSeq: number }
  | { t: "gap"; fromSeq: number; reason?: string };

export type BridgeFrameType = BridgeFrame["t"];

export const BRIDGE_FRAME_TYPES: readonly BridgeFrameType[] = [
  "auth", "hello", "auth_ok", "auth_error", "ev", "cmd", "res", "ping", "pong", "replay", "gap",
];

/** Event names the server understands (identical to the managed-host vocabulary). */
export const BRIDGE_EVENT_NAMES: readonly string[] = [
  "message_start", "message_update", "message_end", "turn_end", "tool_update",
  "agent_start", "agent_settled", "session_start", "session_shutdown", "session_info_changed",
  "session_tree", "model_select", "thinking_level_select", "runtime_state",
  "compacted", "compact_failed", "compact_done", "dialog_observed", "dialog_observed_end",
  "input_seen", "queue_state", "retry_state", "diag", "reauth_required", "gap", "host_exiting",
];

/** Machine-readable acceptance rejection reasons (03 §3). */
export type BridgeRejectReason =
  | "transport_disabled"
  | "too_many_conns"
  | "buffer_overflow"
  | "frame_too_large"
  | "throttled"
  | "auth_timeout"
  | "unauthorized"
  | "bad_frame"
  | "missing_hello"
  | "duplicate_runtime"
  | "attest_failed"
  | "unsupported_protocol"
  | "untrusted_runtime"
  | "cwd_denied";

/* ------------------------------ descriptor ------------------------------ */

/** `<dataDir>/bridge.json` — the only secret handoff that survives "pi started in a shell
 *  that never saw pi-web" (D-2). `0600` inside a `0700` directory; it *is* a secret. */
export interface BridgeDescriptor {
  v: number;
  serverId: string;
  protocol: number[];
  socket: string;
  token: string;
  http: string;
  dataDir: string;
  pid: number;
  procStart: number;
  piwebVersion?: string;
  startedAt?: string;
  updatedAt?: string;
}

/** `~/.pi-web/servers/<serverId>.json` pointer for a non-default `--data-dir`. */
export interface BridgeServerPointer {
  descriptor: string;
  serverId?: string;
  updatedAt?: string;
}

export type DescriptorRead =
  | { ok: true; descriptor: BridgeDescriptor; path: string }
  | { ok: false; reason: "missing" | "unreadable" | "malformed" | "no_token" | "no_socket" | "unsupported_version" | "unsupported_protocol"; path: string; detail?: string };

const b64url = /^[A-Za-z0-9_-]{16,}/;

/** Parse + sanity-check a descriptor. Never throws; every failure is a machine reason. */
export function parseBridgeDescriptor(raw: unknown, filePath: string): DescriptorRead {
  const fail = (reason: Exclude<DescriptorRead, { ok: true }>["reason"], detail?: string): DescriptorRead =>
    ({ ok: false, reason, path: filePath, ...(detail ? { detail } : {}) });
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("malformed");
  const o = raw as Record<string, unknown>;
  if (o.v !== BRIDGE_DESCRIPTOR_V) return fail("unsupported_version", `v=${String(o.v)}`);
  if (typeof o.socket !== "string" || !o.socket) return fail("no_socket");
  if (typeof o.token !== "string" || o.token.length < 16 || !b64url.test(o.token)) return fail("no_token");
  const protocol = Array.isArray(o.protocol) ? o.protocol.filter((p): p is number => typeof p === "number") : [];
  if (!protocol.includes(BRIDGE_PROTOCOL)) return fail("unsupported_protocol", JSON.stringify(o.protocol));
  const descriptor: BridgeDescriptor = {
    v: BRIDGE_DESCRIPTOR_V,
    serverId: typeof o.serverId === "string" && o.serverId ? o.serverId : "unknown",
    protocol,
    socket: o.socket,
    token: o.token,
    http: typeof o.http === "string" ? o.http : "",
    dataDir: typeof o.dataDir === "string" ? o.dataDir : "",
    pid: Number(o.pid) || 0,
    procStart: Number(o.procStart) || 0,
    ...(typeof o.piwebVersion === "string" ? { piwebVersion: o.piwebVersion } : {}),
    ...(typeof o.startedAt === "string" ? { startedAt: o.startedAt } : {}),
    ...(typeof o.updatedAt === "string" ? { updatedAt: o.updatedAt } : {}),
  };
  return { ok: true, descriptor, path: filePath };
}

/** Redact a descriptor for logs / API responses (the token never leaves the file). */
export function redactDescriptor(d: BridgeDescriptor | null | undefined): Record<string, unknown> | null {
  if (!d) return null;
  return {
    serverId: d.serverId, protocol: d.protocol, socket: d.socket, http: d.http, dataDir: d.dataDir,
    pid: d.pid, procStart: d.procStart, piwebVersion: d.piwebVersion ?? null,
    startedAt: d.startedAt ?? null, updatedAt: d.updatedAt ?? null, token: "<redacted>",
  };
}

/* ------------------------------ runtimes ------------------------------ */

/** One row of `GET /api/v1/runtimes` (the diagnostics panel's data). */
export interface RuntimeInfo {
  runtimeId: string;
  transport: "dial" | "legacy" | "managed";
  serverId: string;
  pid: number;
  procStart: number;
  piVersion: string;
  piMode: string;
  protocol: number;
  adapterVersion: string;
  cwd: string | null;
  runtimeGeneration: number;
  sessionGeneration: number;
  lastSeq: number;
  sessions: { key: string; piSessionId: string | null; mode: string }[];
  capabilities: Partial<Capabilities>;
  lastError: string | null;
  dropped: { previews: number; tools: number; throttled: number };
  attested: boolean;
  trusted: boolean;
  connectedAt: string;
}

/** `GET /api/v1/bridge/diagnose`: machine-readable "why is this not live". */
export interface BridgeDiagnose {
  mode: "dial" | "legacy" | "both" | "off";
  listener: "ok" | "disabled" | string;
  socketPath: string | null;
  descriptor: Record<string, unknown> | null;
  descriptorAgeMs: number | null;
  tokenPresent: boolean;
  attestationRequired: boolean;
  counts: { dial: number; legacy: number; managed: number; mirrors: number; rejected: number };
  rejects: Record<string, number>;
  versionGate: { serverPiVersion: string | null; validated: string[]; allowedByConfig: string[]; verdict: string };
  sessions: { key: string; mode: string; piSessionId: string | null; path: string | null; why: string }[];
  legacy: { dir: string; records: number; note: string };
}
