/** Small formatting helpers shared by the transcript and sidebar. */

export function timeShort(ts: string | null | undefined): string {
  if (!ts) return "";
  try {
    const d = new Date(ts);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
    return d.toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
  } catch { return ""; }
}

export function timeFull(ts: string | null | undefined): string {
  if (!ts) return "";
  try { return new Date(ts).toLocaleString(); } catch { return ""; }
}

export function relTime(ts: string | null | undefined): string {
  if (!ts) return "";
  const then = new Date(ts).getTime();
  if (!Number.isFinite(then)) return "";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return timeShort(ts);
}

export function bytes(n: number | null | undefined): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function tokens(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** One percent voice for the header trigger, the popover and the session panel (TYPO-03). */
export function pct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const v = Math.max(0, n);
  if (v > 0 && v < 1) return "<1%";
  return `${v < 10 ? v.toFixed(1) : Math.round(v)}%`;
}

/** Tool durations: sub-second runs read as `120 ms`, never as a bare `0.0s` (TOOL-06). */
export function toolDuration(ms: number): string {
  if (ms < 50) return "";
  // One unit style for both sides of the second boundary: "460 ms" / "1.1 s", not "460 ms"/"1.1s".
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  return `${s < 10 ? s.toFixed(1).replace(/\.0$/, "") : Math.round(s)} s`;
}

export function duration(ms: number | null | undefined): string {
  if (ms == null) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`;
}

export function basename(p: string | null | undefined): string {
  if (!p) return "";
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

export function oneLine(s: unknown, max = 90): string {
  const str = typeof s === "string" ? s : safeJson(s);
  const one = str.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export function safeJson(v: unknown): string {
  try { return JSON.stringify(v) ?? ""; } catch { return String(v); }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }
}
