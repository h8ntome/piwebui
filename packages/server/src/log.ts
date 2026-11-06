/** Content-free structured logging: ids, codes, counts only. No prompts, tool args, outputs or secrets. */
const REDACT_KEYS = /text|content|prompt|token|secret|code|args|output|body/i;

export function logInfo(event: string, fields: Record<string, unknown> = {}) {
  emit("info", event, fields);
}
export function logWarn(event: string, fields: Record<string, unknown> = {}) {
  emit("warn", event, fields);
}
export function logError(event: string, fields: Record<string, unknown> = {}) {
  emit("error", event, fields);
}
function emit(level: string, event: string, fields: Record<string, unknown>) {
  const clean: Record<string, unknown> = { t: new Date().toISOString(), level, event };
  for (const [k, v] of Object.entries(fields)) {
    if (REDACT_KEYS.test(k)) continue; // fail-safe: content-ish keys never appear in logs at all
    clean[k] = typeof v === "string" ? v.slice(0, 300) : v;
  }
  process.stderr.write(JSON.stringify(clean) + "\n");
}
