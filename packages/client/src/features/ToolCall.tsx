/** Tool call rendering: disclosure row + io/structured body, in the reference tool styles. */
import { useMemo, useState } from "react";
import { Icon } from "../lib/icons";
import { oneLine, safeJson, toolDuration } from "../lib/format";
import type { ToolStateView } from "../lib/store";

export type Block = Record<string, unknown> & { type?: string };

const TOOL_ICON: Record<string, string> = {
  bash: "code-outline", read: "inspect-outline", write: "save-outline", edit: "edit-outline",
  str_replace_editor: "edit-outline", ls: "folder-open", list_dir: "folder-open",
  find: "folder-open", glob: "folder-open", grep: "search-outline", search: "search-outline",
  todowrite: "checklist-outline", todo_write: "checklist-outline", task: "agent-preset-outline",
  subagent: "users-outline", webfetch: "globe-outline", web_search: "globe-outline",
  browser: "browse-outline", question: "question-outline", ask_user: "question-outline",
};

const TOOL_TITLE: Record<string, string> = {
  bash: "Bash", read: "Read", write: "Write", edit: "Edit", str_replace_editor: "Edit",
  ls: "List", find: "Find", glob: "Find", grep: "Search", search: "Search", question: "Question",
  ask_user: "Ask user", task: "Subagent", subagent: "Subagent", webfetch: "Fetch",
  web_search: "Search", todowrite: "Todos", todo_write: "Todos", list_dir: "List",
};

/** Display name for any tool: known map first, then "snake_case → Snake case" (TOOL-04). */
export function toolTitle(name: string): string {
  if (TOOL_TITLE[name]) return TOOL_TITLE[name];
  const spaced = name.replace(/[_-]+/g, " ").trim();
  if (!spaced) return "Tool";
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}

function argsOf(call: Block | null, state?: ToolStateView): Record<string, unknown> {
  const a = (call?.arguments ?? state?.argsPreview) as unknown;
  if (a && typeof a === "object") return a as Record<string, unknown>;
  if (typeof a === "string") { try { return JSON.parse(a) as Record<string, unknown>; } catch { return { value: a }; } }
  return {};
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : safeJson(content);
  return content.map((c) => (c && typeof c === "object" && (c as Block).type === "text" ? String((c as Block).text ?? "") : safeJson(c))).join("\n");
}

export function toolSummary(name: string, args: Record<string, unknown>): string {
  if (name === "bash") return oneLine(args.command ?? "", 100);
  const p = args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.prompt ?? args.url;
  if (p != null) return oneLine(p, 90);
  const known = Object.entries(args).filter(([, v]) => typeof v === "string" || typeof v === "number" || typeof v === "boolean");
  if (known.length) return oneLine(known.slice(0, 3).map(([k, v]) => `${k}=${v}`).join(" · "), 90);
  return oneLine(args, 80);
}

function Leading({ state, icon, readOnly }: { state: string; icon: string; readOnly: boolean }) {
  if (state === "running") {
    // A mirror session with no result recorded is not a run in progress (TOOL-05).
    if (readOnly) return <Icon name="inspect-outline" size={15} style={{ color: "var(--dsw-alias-label-caption)" }} />;
    return <Icon name="loading-outline" size={15} className="pw-spinIcon" />;
  }
  if (state === "error") return <Icon name="warning-outline" size={15} style={{ color: "var(--dsw-alias-state-error-primary)" }} />;
  if (state === "abandoned") return <Icon name="warning-outline" size={15} style={{ color: "var(--dsw-alias-state-warn-label)" }} />;
  return <Icon name={icon} size={15} />;
}

function Field({ k, v }: { k: string; v: unknown }) {
  return (
    <div className="pw-toolBlock__item" style={{ display: "grid", gridTemplateColumns: "5.5em minmax(0,1fr)", gap: 12 }}>
      <span style={{ color: "var(--dsw-alias-label-caption)" }}>{k}</span>
      <span className="pw-ioText">{typeof v === "string" ? v : safeJson(v)}</span>
    </div>
  );
}

export type DiffRow = { kind: "ctx" | "del" | "add"; text: string };

/** Line diff (LCS) with 2 lines of context, so a multi-edit call reads as a diff instead of
    "all deletions then all additions" (TOOL-01). Bounded: huge inputs fall back to blocks. */
export function diffLines(oldText: string, newText: string, contextLines = 2): DiffRow[] {
  const a = oldText.split("\n");
  const b = newText.split("\n");
  if (a.length * b.length > 250_000) {
    return [...a.map((t) => ({ kind: "del" as const, text: t })), ...b.map((t) => ({ kind: "add" as const, text: t }))];
  }
  const n = a.length;
  const m = b.length;
  // Classic LCS table; sessions edit small hunks, so this stays comfortably cheap.
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const raw: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { raw.push({ kind: "ctx", text: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { raw.push({ kind: "del", text: a[i]! }); i++; }
    else { raw.push({ kind: "add", text: b[j]! }); j++; }
  }
  while (i < n) raw.push({ kind: "del", text: a[i++]! });
  while (j < m) raw.push({ kind: "add", text: b[j++]! });

  // Keep context around changed rows only.
  const keep = new Set<number>();
  raw.forEach((r, idx) => {
    if (r.kind === "ctx") return;
    for (let k = idx - contextLines; k <= idx + contextLines; k++) if (k >= 0 && k < raw.length) keep.add(k);
  });
  const out: DiffRow[] = [];
  let skipped = 0;
  raw.forEach((r, idx) => {
    if (keep.has(idx)) {
      if (skipped) { out.push({ kind: "ctx", text: `… ${skipped} unchanged ${skipped === 1 ? "line" : "lines"}` }); skipped = 0; }
      out.push(r);
    } else if (r.kind === "ctx") skipped++;
  });
  if (skipped) out.push({ kind: "ctx", text: `… ${skipped} unchanged ${skipped === 1 ? "line" : "lines"}` });
  return out;
}

function DiffBody({ rows }: { rows: DiffRow[] }) {
  return (
    <pre className="pw-ioText pw-diff" style={{ margin: "6px 0 0", fontFamily: "var(--ds-font-family-code)", fontSize: 11 }}>
      {rows.map((r, i) => (
        <span key={i} className={r.kind === "ctx" ? "pw-diff__ctx" : `pw-diff__${r.kind}`}>
          {r.kind === "del" ? "-" : r.kind === "add" ? "+" : " "}{r.text}{"\n"}
        </span>
      ))}
    </pre>
  );
}

export function ToolCall({ call, state, readOnly = false }: { call: Block | null; state?: ToolStateView | undefined; readOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  const name = String(call?.name ?? state?.toolName ?? "tool");
  const icon = TOOL_ICON[name] ?? "sparkle";
  const title = toolTitle(name);
  const args = useMemo(() => argsOf(call, state), [call, state]);
  // In a file mirror, a call with no result never "ran": say that instead of spinning forever.
  const status = state?.state ?? "running";
  const settledStatus = readOnly && status === "running" ? "abandoned" : status;
  const noResult = readOnly && !state;

  const output = useMemo(() => {
    if (state?.outputContent?.length) return contentText(state.outputContent);
    if (state?.outputText) return state.outputText;
    return "";
  }, [state]);
  const isError = settledStatus === "error" || (state as unknown as { isError?: boolean })?.isError === true;
  const edits = Array.isArray(args.edits) ? (args.edits as Block[]) : [];
  const hasBody = Boolean(output) || Object.keys(args).length > 0;
  const dur = state?.durationMs != null ? toolDuration(state.durationMs) : "";
  const sections: { label: string; body: React.ReactNode; error?: boolean }[] = [];

  if (name === "bash" && args.command != null) sections.push({ label: "in", body: `$ ${String(args.command)}` });
  if (name !== "bash" && !(name === "edit" || name === "str_replace_editor") && Object.keys(args).length > 0) {
    sections.push({ label: "in", body: Object.entries(args).map(([k, v]) => `${k}: ${typeof v === "string" ? v : safeJson(v)}`).join("\n") });
  }
  if (output) sections.push({ label: "out", body: <span data-error={isError ? "true" : undefined}>{output}</span>, error: isError });

  return (
    <div className="pw-tool" data-tool={name}>
      <button className="pw-discRow pw-discRow--tool" onClick={() => hasBody && setOpen((o) => !o)} aria-expanded={open} disabled={!hasBody}>
        <span className="pw-discLeading"><Leading state={noResult ? "abandoned" : settledStatus} icon={icon} readOnly={readOnly} /></span>
        <span className="pw-discTitle">{title}</span>
        <span className="pw-discSep" />
        <span className={`pw-discSummary${isError ? " pw-discSummary--error" : ""}`}>
          {noResult ? `${toolSummary(name, args) || title} — no result recorded` : toolSummary(name, args)}
        </span>
        {dur && <span className="pw-discSummary pw-discDuration" title={`${state?.durationMs} ms`}>{dur}</span>}
        {hasBody && <Icon name="chevron-down-outline" size={14} className="pw-discChevron" />}
      </button>

      {open && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {/* One card with dividers for every tool, not one card per section (TOOL-02). */}
          {(sections.length > 0 || edits.length > 0) && (
            <div className="pw-ioCard">
              {sections.map((s, i) => (
                <div key={i}>
                  {i > 0 && <div className="pw-ioDivider" />}
                  <div className="pw-ioSection">
                    <span className="pw-ioLabel">{s.label}</span>
                    <span className={`pw-ioText${s.error ? "" : ""}`} data-error={s.error ? "true" : undefined}>{s.body}</span>
                  </div>
                </div>
              ))}
              {edits.length > 0 && (
                <div className="pw-ioSection" style={{ display: "block" }}>
                  <span className="pw-ioLabel">diff</span>
                  {/* One legend for the whole card instead of one per edit block (TOOL-01). */}
                  {edits.length > 0 && (
                    <div className="pw-toolBlock__heading">
                      <span className="pw-toolBlock__badge" data-tone="error">removed</span>
                      <span className="pw-toolBlock__badge" data-tone="success">added</span>
                    </div>
                  )}
                  {edits.map((e, i) => (
                    <div key={i} className="pw-toolBlock__item">
                      {edits.length > 1 && <div className="pw-toolBlock__heading"><span className="pw-toolBlock__badge">edit {i + 1}</span></div>}
                      <DiffBody rows={diffLines(String((e as Block).oldText ?? ""), String((e as Block).newText ?? ""))} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          {state?.truncated && <div className="pw-ioLabel" style={{ padding: "2px 4px" }}>output truncated by transport bound</div>}
        </div>
      )}
    </div>
  );
}

export function FieldList({ fields }: { fields: { k: string; v: unknown }[] }) {
  return <div className="pw-toolBlock">{fields.map((f, i) => <Field key={i} k={f.k} v={f.v} />)}</div>;
}
