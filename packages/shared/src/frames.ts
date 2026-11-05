/**
 * Line-framed JSON protocol shared by the server with:
 *  - the terminal bridge extension (over a Unix socket)
 *  - the managed SDK host (over child IPC; same frame objects)
 * LF-only framing; frames are single-line JSON strings. UTF-8 U+2028/U+2029 inside
 * strings are data (Node readline would split on them, so we frame on raw 0x0A bytes).
 */
import { PROTOCOL_VERSION } from "./constants.ts";
import type { Capabilities, DialogRequest, PreviewState, ToolStateView, RunPhase, ModelRef, QueueState } from "./types.ts";

export const BRIDGE_PROTOCOL_VERSION = PROTOCOL_VERSION;

export type Frame = AuthFrame | AuthOkFrame | CmdFrame | ResFrame | EvFrame | PingFrame | PongFrame;

export interface AuthFrame { t: "auth"; token: string; serverId: string; }
export interface AuthOkFrame { t: "auth_ok"; protocol: number; }
export interface CmdFrame { t: "cmd"; id: string; cmd: DriverCommand; args: unknown; }
export interface ResFrame { t: "res"; id: string; ok: boolean; data?: unknown; error?: { code: string; message: string }; }
export interface EvFrame { t: "ev"; seq: number; name: AdapterEventName; payload: unknown; }
export interface PingFrame { t: "ping"; id: string; }
export interface PongFrame { t: "pong"; id: string; }

export type DriverCommand =
  | "snapshot"
  | "prompt"
  | "abort"
  | "compact"
  | "setModel"
  | "setThinking"
  | "rename"
  | "clearQueue"
  | "models"
  | "commands"
  | "context"
  | "dialogRespond"
  | "stopForTerminal"
  | "tree";

export interface SnapshotRequest {
  /** Ask the owner for at most this many in-flight previews. */
  previewLimit?: number;
}
export interface OwnerSnapshot {
  sessionFile: string | null;
  sessionId: string | null;
  cwd: string | null;
  piVersion: string;
  mode: string;
  leafEntryId: string | null;
  leafSource: "runtime";
  phase: RunPhase;
  stateRevision: number;
  isStreaming: boolean;
  previews: PreviewState[];
  tools: ToolStateView[];
  queue: QueueState;
  model: ModelRef | null;
  thinkingLevel: string | null;
  sessionName: string | null;
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  pendingDialogs: DialogRequest[];
  observedDialogs: DialogRequest[];
  lastSettled: { at: string; aborted: boolean } | null;
  retry: { active: boolean; reason?: string } | null;
  compaction: { active: boolean; reason?: string } | null;
  entryCount: number;
  capabilities: Capabilities;
}

export type AdapterEventName =
  | "message_start"
  | "message_update"
  | "message_end"
  | "user_message"
  | "tool_start"
  | "tool_update"
  | "tool_end"
  | "turn_end"
  | "agent_start"
  | "agent_settled"
  | "session_start"
  | "session_info_changed"
  | "session_shutdown"
  | "session_tree"
  | "model_select"
  | "thinking_level_select"
  | "dialog_request"
  | "dialog_resolved"
  | "dialog_observed"
  | "runtime_error"
  | "file_hint"
  | "unknown";

export interface AdapterEvent {
  name: AdapterEventName;
  payload: Record<string, unknown>;
}

export interface PromptArgs {
  text: string;
  images?: { mimeType: string; data: string }[];
  delivery: "start" | "steer" | "followUp";
  operationId: string;
}

export interface BridgeRegistryRecord {
  protocol: number;
  runtimeId: string;
  socketPath: string;
  tokenHash: string;
  pid: number;
  procStart: number;
  piVersion: string;
  startedAt: string;
  cwd: string;
  sessionFile: string | null;
  sessionId: string | null;
  mode: string;
  capabilities: Capabilities;
}

/** Hello metadata carried in the auth_ok payload as well for revalidation. */
export interface HelloInfo {
  protocol: number;
  runtimeId: string;
  pid: number;
  procStart: number;
  piVersion: string;
  cwd: string;
  sessionFile: string | null;
  sessionId: string | null;
  mode: string;
  capabilities: Capabilities;
}
