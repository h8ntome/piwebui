/** Tool call rendering: disclosure row + io/structured body, in the reference tool styles. */
import { useMemo, useState } from "react";
import { Icon } from "../lib/icons";
import { oneLine, safeJson } from "../lib/format";
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
  ls: "List", find: "Find", glob: "Find", grep: "Search", task: "Subagent", subagent: "Subagent",
  webfetch: "Fetch", web_search: "Search", todowrite: "Todos", todo_write: "Todos",
};

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
  return oneLine(args, 80);
}

function Leading({ state, icon }: { state: string; icon: string }) {
  if (state === "running") return <Icon name="loading-outline" size={15} className="pw-spinIcon" />;
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

/** Removed lines then added lines, each tinted the way the reference tints a diff. */
function DiffLines({ oldText, newText }: { oldText: string; newText: string }) {
  const line = (t: string, kind: "del" | "add") =>
    t.split("\n").map((l, i) => (
      <span key={`${kind}-${i}`} className={`pw-diff__${kind}`}>{kind === "del" ? "-" : "+"}{l + "\n"}</span>
    ));
  return <>{line(oldText, "del")}{line(newText, "add")}</>;
}

export function ToolCall({ call, state }: { call: Block | null; state?: ToolStateView | undefined }) {
  const [open, setOpen] = useState(false);
  const name = String(call?.name ?? state?.toolName ?? "tool");
  const icon = TOOL_ICON[name] ?? "sparkle";
  const title = TOOL_TITLE[name] ?? name;
  const args = useMemo(() => argsOf(call, state), [call, state]);
  const status = state?.state ?? "running";

  const output = useMemo(() => {
    if (state?.outputContent?.length) return contentText(state.outputContent);
    if (state?.outputText) return state.outputText;
    return "";
  }, [state]);
  const isError = status === "error" || (state as unknown as { isError?: boolean })?.isError === true;
  const edits = Array.isArray(args.edits) ? (args.edits as Block[]) : [];
  const hasBody = Boolean(output) || Object.keys(args).length > 0;

  return (
    <div className="pw-tool" data-tool={name}>
      <button className="pw-discRow pw-discRow--tool" onClick={() => hasBody && setOpen((o) => !o)} aria-expanded={open} disabled={!hasBody}>
        <span className="pw-discLeading"><Leading state={status} icon={icon} /></span>
        <span className="pw-discTitle">{title}</span>
        <span className="pw-discSep" />
        <span className={`pw-discSummary${isError ? " pw-discSummary--error" : ""}`}>{toolSummary(name, args)}</span>
        {state?.durationMs != null && <span className="pw-discSummary" style={{ flex: "none", marginLeft: 8 }}>{(state.durationMs / 1000).toFixed(1)}s</span>}
        {hasBody && <Icon name="chevron-down-outline" size={14} className="pw-discChevron" />}
      </button>

      {open && (
        <div style={{ display: "flex", flexDirection: "column" }}>
          {name === "bash" && args.command != null && (
            <div className="pw-ioCard">
              <div className="pw-ioSection">
                <span className="pw-ioLabel">in</span>
                <span className="pw-ioText">$ {String(args.command)}</span>
              </div>
              {output && (<><div className="pw-ioDivider" /><div className="pw-ioSection"><span className="pw-ioLabel">out</span><span className="pw-ioText">{output}</span></div></>)}
            </div>
          )}

          {(name === "edit" || name === "str_replace_editor") && edits.length > 0 && (
            <div className="pw-toolBlock">
              {edits.map((e, i) => (
                <div key={i} className="pw-toolBlock__item" style={{ display: "block" }}>
                  <div className="pw-toolBlock__heading">
                    <span className="pw-toolBlock__badge" data-tone="error">removed</span>
                    <span className="pw-toolBlock__badge" data-tone="success">added</span>
                  </div>
                  <pre className="pw-ioText pw-diff" style={{ margin: "6px 0 0", fontFamily: "var(--ds-font-family-code)", fontSize: 11 }}>
                    {DiffLines({ oldText: String((e as Block).oldText ?? ""), newText: String((e as Block).newText ?? "") })}
                  </pre>
                </div>
              ))}
            </div>
          )}

          {name !== "bash" && !(name === "edit" && edits.length) && Object.keys(args).length > 0 && (
            <div className="pw-ioCard">
              <div className="pw-ioSection">
                <span className="pw-ioLabel">in</span>
                <span className="pw-ioText">{Object.entries(args).map(([k, v]) => `${k}: ${typeof v === "string" ? v : safeJson(v)}`).join("\n")}</span>
              </div>
            </div>
          )}

          {output && name !== "bash" && (
            <div className="pw-ioCard">
              <div className="pw-ioSection">
                <span className="pw-ioLabel">out</span>
                <span className="pw-ioText" data-error={isError ? "true" : undefined}>{output}</span>
              </div>
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
