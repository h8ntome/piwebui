/** One vocabulary for everything the UI shows about a session, and one place that turns
    internal strings (enums, Node errors, wire shapes) into user-facing copy.
    Kept free of React so tests and every component can share it. */

/** Anything unknown renders as this, never as "undefined". */
export const NA = "—";

const MODE_LABEL: Record<string, string> = {
  managed: "Web session",
  live: "Terminal (bridged)",
  mirror: "Terminal session (read-only)",
  history: "Terminal session (read-only)",
};

/** `mirror` and `history` are the same thing to a reader: a file pi-web can read, not drive. */
export function modeLabel(mode: string | null | undefined): string {
  if (!mode) return NA;
  return MODE_LABEL[mode] ?? mode;
}

export function isReadOnlyMode(mode: string | null | undefined): boolean {
  return mode === "mirror" || mode === "history";
}

const STATE_LABEL: Record<string, string> = {
  idle: "Idle",
  unavailable: "Not running",
  streaming: "Streaming",
  tool: "Running a tool",
  waiting: "Waiting for input",
  error: "Error",
  compacting: "Compacting",
  settled: "Idle",
  ready: "Ready",
  none: NA,
};

/**
 * A managed runtime that has booted but never run reports `state:"unknown"` (nothing has happened
 * yet, so there is no phase to name). "Unknown" on a healthy session frightened users and testers
 * alike (BUG-016); say "Ready" when there is a live runtime behind it, and keep "Unknown" when
 * there is genuinely nothing to go by.
 */
export function stateLabelFor(state: string | null | undefined, runtimeAlive: boolean): string {
  if ((state === "unknown" || state == null) && runtimeAlive) return STATE_LABEL.ready!;
  return stateLabel(state);
}

/** A file mirror is not a fault, so it must not read like one (SRV-06 / PNL-04). */
export function stateLabel(state: string | null | undefined): string {
  if (!state) return NA;
  return STATE_LABEL[state] ?? state.charAt(0).toUpperCase() + state.slice(1);
}

const DRIVER_LABEL: Record<string, string> = {
  file: "Session file",
  managed: "Started by pi-web",
  bridge: "Terminal bridge",
  none: NA,
};

export function driverLabel(driver: string | null | undefined): string {
  if (!driver) return NA;
  return DRIVER_LABEL[driver] ?? driver;
}

/** Entry shapes pi writes; used by the trajectory tree when a row has no preview. */
const ENTRY_LABEL: Record<string, string> = {
  message: "Message",
  model_change: "Model change",
  thinking_level_change: "Thinking level change",
  compaction: "Context compacted",
  session_start: "Session started",
  header: "Session header",
  custom: "Extension entry",
  invalid: "Unreadable line",
  unknown: "Unknown entry",
};

export function entryTypeLabel(type: string | null | undefined): string {
  if (!type) return "Entry";
  return ENTRY_LABEL[type] ?? type.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase());
}

/** Raw markdown never belongs in a one-line preview. */
export function plainPreview(s: string | null | undefined, max = 140): string {
  if (!s) return "";
  const flat = s
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~#>|]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

const NOTE_PATTERNS: [RegExp, string][] = [
  [/first argument must be.*(string|Buffer|ArrayBuffer)/i, "This pi version could not read the attachment. Send the message again without it, or update pi."],
  [/no tree source/i, "This session has no entries yet."],
  [/failed to fetch|net::err|ERR_CONNECTION|Load failed|NetworkError/i, "No response from the server at this address."],
  [/\btimeout\b|timed out/i, "The server took too long to answer. Try again."],
  [/not found/i, "That item is no longer here."],
  [/forbidden/i, "You do not have access to this."],
  [/cursor_expired/i, "That part of the conversation moved on; reload to continue."],
  [/^(TypeError|RangeError|Error):?\s*/i, ""],
  [/^\s*$/, "Something went wrong."],
];

/** Translate transport/Node noise into something a person can act on (audit: raw internals
    leaking into copy — ATT-01, SRV-04/05/08, TRJ-02). */
export function humaniseError(raw: string | null | undefined): string {
  const s = (raw ?? "").toString().trim();
  if (!s) return "Something went wrong.";
  for (const [re, out] of NOTE_PATTERNS) {
    if (re.test(s)) {
      if (out) return out;
      const stripped = s.replace(re, "").trim();
      if (stripped) return stripped.charAt(0).toUpperCase() + stripped.slice(1);
    }
  }
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

/** Copy voice: sentence case, no trailing junk (TYPO-04). */
export function sentenceCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
