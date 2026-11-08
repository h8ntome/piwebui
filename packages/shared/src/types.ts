/**
 * pi-web wire types (our own schemas; deliberately NOT leaked Pi internal objects).
 * Raw Pi session entries cross the wire inside EntryView.raw as plain JSON data.
 */

export type SessionMode = "history" | "mirror" | "live" | "managed";
export type RunPhase =
  | "idle"
  | "streaming"
  | "compacting"
  | "retrying"
  | "awaiting_dialog"
  | "unknown"
  | "unavailable";

export type SourceKind = "file" | "runtime" | "none";

/** Content block shape mirrored from Pi transcript values (plain JSON on the wire). */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string; thinkingSignature?: string | null }
  | { type: "image"; data: string; mimeType: string }
  | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }
  | { type: string; [k: string]: unknown };

/** Opaque resource keys issued by the server (plan: Pi UUID is metadata, not a locator). */
export type SessionKey = string;
export type WorkspaceKey = string;

export interface WorkspaceInfo {
  workspaceKey: WorkspaceKey;
  path: string;
  label: string;
  addedAt: string;
}

export interface SessionMeta {
  sessionKey: SessionKey;
  workspaceKey: WorkspaceKey | null;
  /** Canonical absolute session file path, or null for a pending managed session not yet flushed. */
  path: string | null;
  /** Pi session UUID (header id) — metadata only. */
  piSessionId: string | null;
  /** Header cwd — the grouping key. */
  cwd: string | null;
  name: string | null;
  created: string | null;
  modified: string | null;
  messageCount: number | null;
  firstPrompt: string | null;
  sizeBytes: number | null;
  version: number | null;
}

export interface RuntimeIdentity {
  runtimeId: string;
  runtimeGeneration: number;
  pid: number;
  piVersion: string;
  /** How the runtime is hosted: pi TUI (bridged), pi SDK child (managed). */
  hostKind: "terminal" | "managed";
  piMode: string;
  sessionFile: string | null;
  sessionId: string | null;
  cwd: string | null;
  model: ModelRef | null;
  thinkingLevel: string | null;
  sessionName: string | null;
}

export interface ModelRef {
  provider: string;
  modelId: string;
  name?: string;
  contextWindow?: number;
  maxTokens?: number;
  /** Whether this model is currently usable (auth configured) as reported by the owner. */
  available?: boolean;
  reasoning?: boolean;
}

export interface Capabilities {
  /** Owner can answer consistent live snapshots (leaf, preview, dialogs). */
  snapshot: boolean;
  /** Owner streams live previews before persistence. */
  livePreview: boolean;
  /** Owner can answer tree reads live (falls back to file tree). */
  liveTree: boolean;
  promptStart: boolean;
  promptSteer: boolean;
  promptFollowUp: boolean;
  abort: boolean;
  compact: boolean;
  setModel: boolean;
  setThinking: boolean;
  rename: boolean;
  modelsCatalog: boolean;
  commandList: boolean;
  /** "none": no queue info; "flag": pending flag only; "count": flag + count; "full": count + contents. */
  queue: "none" | "flag" | "count" | "full";
  clearQueue: boolean;
  dialogObserve: boolean;
  dialogRespond: boolean;
  stopForTerminal: boolean;
  contextUsage: boolean;
  /** Context source: runtime preview only when the owner answers `context` requests. */
  runtimeContext: boolean;
  /** Whether this mode can accept any input at all. */
  canControl: boolean;
  /** Notes surfaced to the UI about limits (e.g. terminal dialogs answer-only-in-terminal). */
  notes?: string[];
}

export type DriverKind = "bridge" | "managed" | "file";

export interface SessionStatus {
  sessionKey: SessionKey;
  mode: SessionMode;
  source: SourceKind;
  driver: DriverKind;
  state: RunPhase;
  runtime: RuntimeIdentity | null;
  fileGeneration: string;
  sessionGeneration: number;
  /** Current leaf id + where it came from: owner live leaf or last on-disk entry. */
  leaf: { entryId: string | null; source: "runtime" | "file" | null };
  capabilities: Capabilities;
  /** Adapter compatibility (Pi version gating). */
  compat: { piVersion: string | null; tested: boolean; detail: string };
  conflict: ConflictInfo | null;
  control: ControlState | null;
  pendingOperations: { operationId: string; state: OperationState }[];
}

export interface ControlState {
  controllerId: string | null;
  epoch: number;
  expiresAt: string | null;
  /** Whether THIS requesting client holds the grant (filled per-view). */
  heldByMe: boolean;
}

export interface ConflictInfo {
  kind: "foreign_write" | "file_replaced" | "owner_lost_midrun" | "shrink" | "unknown";
  observedAt: string;
  detail: string;
}

export type OperationState =
  | "accepted"
  | "dispatched"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "unknown";

export interface OperationReceipt {
  operationId: string;
  kind: string;
  state: OperationState;
  acceptedAt: string;
  finalizedAt: string | null;
  error?: { code: ErrorCodeLite; message: string };
  result?: unknown;
}
type ErrorCodeLite = string;

/** Persisted entry as delivered to clients. `raw` is the original JSON record (bounded). */
export interface EntryView {
  entryId: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  raw: Record<string, unknown>;
  /** Byte offset of the record start in the file at read time. */
  byteOffset: number;
  byteLength: number;
  /** Set when the record was too large to include fully. */
  truncated?: boolean;
  /** Set when the record failed JSON parsing (raw replaced by text preview). */
  invalid?: boolean;
}

export interface EntryPage {
  fileGeneration: string;
  entries: EntryView[];
  nextCursor: string | null;
  /** Set by backwards paging (`?before=`): cursor for the page older than this one. */
  olderCursor?: string | null;
  /** Lines that failed to parse on this pass (bounded to the first few). */
  diagnostics?: { message: string; byteOffset: number }[];
  leafEntryId: string | null;
  entryCount: number;
  totalBytes: number;
}

/** One node of the session tree (read-only). */
export interface TreeNodeView {
  entryId: string;
  parentId: string | null;
  type: string;
  timestamp: string;
  label?: string;
  preview: string;
  childIds: string[];
  onActiveBranch: boolean;
}
export interface TreeView {
  fileGeneration: string;
  leaf: { entryId: string | null; source: "runtime" | "file" };
  roots: string[];
  nodes: Record<string, TreeNodeView>;
}

/** Context: persisted projection or runtime preview. */
export interface ContextView {
  kind: "persisted_projection" | "runtime_preview";
  leafEntryId: string | null;
  capturedAt: string;
  model: ModelRef | null;
  thinkingLevel: string | null;
  messages: ContextMessage[];
  /** Honest availability flags; null fields are unavailable, not empty. */
  unavailableFields: string[];
  note: string;
}
export interface ContextMessage {
  role: string;
  content: unknown;
  entryId?: string | null;
}

export interface StatsView {
  source: "persisted_totals" | "owner_reported" | "none";
  totalEntries: number | null;
  messageCounts: { user: number; assistant: number; toolResult: number; other: number } | null;
  usageTotals: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number | null } | null;
  contextUsage: { tokens: number | null; contextWindow: number | null; percent: number | null } | null;
  runtimeUsage: unknown | null;
  note: string;
}

/* ---------------- live/state payloads ---------------- */

export interface PreviewState {
  liveMessageId: string;
  role: "assistant" | "user";
  rev: number;
  blocks: { index: number; block: ContentBlock }[];
  startedAt: string;
  done: boolean;
  mappedEntryId?: string;
  modelName?: string;
  truncated?: boolean;
}

export interface ToolStateView {
  toolCallId: string;
  toolName: string;
  label?: string;
  state: "running" | "ok" | "error" | "abandoned";
  argsPreview?: unknown;
  /** Cumulative snapshot policy: replace previous output (bash semantics in Pi 1.5.0). */
  outputMode: "replace" | "append";
  outputText?: string;
  outputContent?: ContentBlock[];
  details?: unknown;
  durationMs?: number;
  startedAt: string;
  endedAt?: string;
  truncated?: boolean;
  entryId?: string;
  parentToolCallId?: string;
}

export interface QueueState {
  hasPending: boolean | null;
  count: number | null;
  /** Queue contents when the owner exposes them (SDK hosts do; terminal bridges do not). */
  items?: { kind: "steer" | "followUp" | "other"; text: string }[];
  note: string;
}

export interface DialogRequest {
  requestId: string;
  requestGeneration: number;
  kind: "select" | "confirm" | "input" | "editor";
  title: string;
  message?: string;
  options?: string[];
  placeholder?: string;
  prefill?: string;
  timeoutMs?: number;
  expiresAt?: string | null;
  answered: boolean;
  answer?: { value?: string | null; confirmed?: boolean; cancelled?: boolean };
  /** true for dialogs observed in a terminal Pi (cannot be answered remotely). */
  terminalObserved: boolean;
  requestedBy?: string;
  createdAt: string;
}

export interface RuntimeStatePayload {
  phase: RunPhase;
  stateRevision: number;
  isStreaming: boolean;
  /** Cumulative previews of in-flight messages (owner-side). */
  previews: PreviewState[];
  tools: ToolStateView[];
  queue: QueueState;
  model: ModelRef | null;
  thinkingLevel: string | null;
  sessionName: string | null;
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  leafEntryId: string | null;
  lastSettled?: { at: string; aborted: boolean } | null;
  retry?: { active: boolean; reason?: string } | null;
  compaction?: { active: boolean; reason?: string } | null;
}

/* ---------------- commands ---------------- */

export interface WireImage {
  mimeType: string;
  dataBase64: string;
  name?: string;
}

export type Command =
  | { type: "prompt"; text: string; images?: WireImage[]; delivery: "start" | "steer" | "followUp" }
  | { type: "abort" }
  | { type: "compact"; instructions?: string }
  | { type: "setModel"; provider: string; modelId: string }
  | { type: "setThinking"; level: string }
  | { type: "rename"; name: string | null }
  | { type: "clearQueue" }
  | { type: "dialogResponse"; requestId: string; requestGeneration: number; value?: string | null; confirmed?: boolean; cancelled?: boolean }
  | { type: "stopForTerminal"; mode: "settle" | "abort" };

export interface CommandEnvelope {
  operationId: string;
  runtimeId: string;
  runtimeGeneration: number;
  sessionGeneration: number;
  controlEpoch: number;
  controlSecret: string;
  command: Command;
}

/* ---------------- SSE ---------------- */

export type StreamEventName =
  | "snapshot"
  | "entry"
  | "preview"
  | "runtimeState"
  | "toolState"
  | "queueState"
  | "dialogRequest"
  | "dialogResolved"
  | "operationState"
  | "controlState"
  | "ownerChanged"
  | "conflict"
  | "resync"
  | "heartbeat"
  | "hostExited"
  | "streamEnd"
  | "runtimeAttached"
  | "runtimeGone"
  | "sessionAppeared"
  | "sessionRetired"
  | "bridgeDisabled"
  | "unknown";

export interface StreamEnvelope<P = unknown> {
  name: StreamEventName;
  source: SourceKind;
  streamEpoch: string;
  seq: number;
  sessionGeneration: number;
  runtimeId?: string;
  runtimeGeneration?: number;
  entryId?: string;
  liveMessageId?: string;
  payload: P;
}

export interface ResyncPayload {
  reason: string;
}
export interface ControlChangedPayload {
  controllerId: string | null;
  epoch: number;
  heldByMe: boolean;
}
export interface HostExitedPayload {
  reason: "exited" | "crashed" | "lost";
  exitCode: number | null;
  signal: string | null;
}
export interface EntryEventPayload {
  fileGeneration: string;
  entry: EntryView;
  /** Owner-provided mapping from an observed live message to this entry. */
  replacesLiveMessageId?: string;
}

export interface SnapshotPayload {
  sessionKey: SessionKey;
  meta: SessionMeta;
  status: SessionStatus;
  fileGeneration: string;
  entries: EntryView[];
  nextEntriesCursor: string | null;
  entryTotal: number;
  /** True when the session holds entries older than this newest-first window. */
  olderAvailable?: boolean;
  /** Lines of the session file that could not be parsed (bounded, user-visible). */
  diagnostics?: { message: string; byteOffset: number }[];
  runtimeState: RuntimeStatePayload | null;
  pendingDialogs: DialogRequest[];
  observedDialogs: DialogRequest[];
  barrier: { streamEpoch: number; seq: number };
}

/* ---------------- health/meta ---------------- */

export interface HealthInfo {
  ok: boolean;
  version: string;
  uptimeMs: number;
  serverId: string;
  pi: { resolvedVersion: string | null; path: string | null; tested: boolean };
  managed: { active: number; limit: number };
  bridges: number;
  mirrors: number;
  capabilities: Capabilities & { server: string[] };
}

export interface MetaInfo {
  limits: {
    maxRequestBytes: number;
    entriesPageMax: number;
    /** Page size the transcript snapshot and a plain `GET /entries` actually use. */
    entriesPageDefault: number;
    /** Entries handed back by the SSE snapshot (newest-first window). */
    snapshotEntries: number;
    /** Largest page for `GET /sessions`. */
    sessionsPageMax: number;
    sseMaxFrames: number;
    sseMaxBytes: number;
    sseHeartbeatMs: number;
    sseClientSilenceMs: number;
    controlTtlMs: number;
    maxManagedRuntimes: number;
  };
  auth: { cookie: string; csrfHeader: string };
  protocolVersion: number;
}

export interface FileView {
  kind: "text" | "binary" | "directory" | "too_large";
  path: string;
  sizeBytes: number;
  text?: string;
  truncated?: boolean;
  entries?: { name: string; kind: "file" | "dir" | "other"; sizeBytes: number | null }[];
  mime?: string;
}
