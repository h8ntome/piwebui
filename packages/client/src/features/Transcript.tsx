/** Transcript: turns, bubbles, thinking, tool calls, compaction and error rows. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, type EntryView, type PreviewState, type SessionView, type ToolStateView } from "../lib/store";
import { useSettings } from "../lib/settings";
import { Icon } from "../lib/icons";
import { timeFull, timeShort, copyText, oneLine } from "../lib/format";
import { Markdown } from "./Markdown";
import { ToolCall, type Block }
  from "./ToolCall";
import { toast } from "../ui/Toast";
import { Tip } from "../ui/Tooltip";

export type Row =
  | { kind: "message"; key: string; entry?: EntryView; preview?: PreviewState }
  | { kind: "system"; key: string; entry: EntryView }
  | { kind: "compaction"; key: string; entry: EntryView }
  | { kind: "invalid"; key: string; entry: EntryView };

function messageOf(e: EntryView): { role?: string; content?: unknown; isError?: boolean; timestamp?: string } | null {
  const m = (e.raw as { message?: unknown }).message;
  return m ? (m as { role?: string; content?: unknown; isError?: boolean; timestamp?: string }) : null;
}

export function blocksOfMessage(content: unknown): Block[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content as Block[];
  return [];
}

/** Tool results are stored as their own entries; fold them onto the call id. */
export function toolsFromEntries(entries: EntryView[] | undefined): Record<string, ToolStateView> {
  const out: Record<string, ToolStateView> = {};
  if (!entries) return out;
  for (const e of entries) {
    const m = messageOf(e);
    if (e.type === "message" && m?.role === "toolResult") {
      const r = m as unknown as { toolCallId?: string; toolName?: string; content?: unknown; isError?: boolean };
      if (!r.toolCallId) continue;
      out[r.toolCallId] = {
        toolCallId: r.toolCallId,
        toolName: String(r.toolName ?? "tool"),
        state: r.isError ? "error" : "ok",
        outputMode: "replace",
        outputContent: Array.isArray(r.content) ? (r.content as unknown as Record<string, unknown>[]) : undefined,
        startedAt: e.timestamp,
        endedAt: e.timestamp,
      } as ToolStateView;
    }
  }
  return out;
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((c) => (c as { text?: string })?.text ?? "").join("");
  return "";
}
function previewText(p: PreviewState): string {
  return p.blocks.map((b) => (b.block as { text?: string })?.text ?? "").join("");
}

export function buildRows(v: SessionView): Row[] {
  const rows: Row[] = [];
  for (const e of v.entries) {
    if (e.invalid) { rows.push({ kind: "invalid", key: e.entryId, entry: e }); continue; }
    const m = messageOf(e);
    if (e.type === "message") {
      if (m?.role === "toolResult" || m?.role === "system") continue; // rendered inside the tool card / hidden
      rows.push({ kind: "message", key: e.entryId, entry: e });
    } else if (e.type === "compaction") rows.push({ kind: "compaction", key: e.entryId, entry: e });
    else if (e.type === "model_change" || e.type === "thinking_level_change") rows.push({ kind: "system", key: e.entryId, entry: e });
  }
  // A prompt is echoed by the runtime as a live preview before its entry is written, and
  // user previews are never tagged with mappedEntryId — dedupe on role + text instead.
  const committed = new Set<string>();
  for (const e of v.entries) {
    const m = messageOf(e);
    if (m?.role === "user") committed.add(`user\u0000${textOf(m.content).trim()}`);
  }
  const live = Object.values(v.previews).filter((p) => !p.mappedEntryId && p.blocks.length > 0
    && !(p.role === "user" && committed.has(`user\u0000${previewText(p).trim()}`)));
  live.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const p of live) rows.push({ kind: "message", key: `pv:${p.liveMessageId}`, preview: p });
  return rows;
}

/* --------------------------------- thinking --------------------------------- */

function Thinking({ texts, streaming }: { texts: string[]; streaming: boolean }) {
  const [open, setOpen] = useState(false);
  const body = texts.filter(Boolean).join("\n\n");
  const label = streaming ? "Thinking" : "Thought";
  return (
    <div>
      <button className="pw-discRow pw-discRow--think" onClick={() => setOpen((o) => !o)} aria-expanded={open} disabled={!body}>
        <span className="pw-discLeading"><Icon name="think-outline" size={15} /></span>
        <span className="pw-discTitle">{label}</span>
        {body && <span className="pw-discSep" />}
        <span className="pw-shimmer pw-discSummary" data-open={open || undefined}>
          <span className="pw-shimmer__content"><span className="pw-discSummaryText">{open ? "" : oneLine(body, 80)}</span></span>
          {!open && body && streaming && (
            <span className="pw-shimmer__deco"><span className="pw-shimmer__bar" /></span>
          )}
        </span>
        <Icon name="chevron-down-outline" size={14} className="pw-discChevron" />
      </button>
      {open && <div className="pw-discBody" style={{ color: "var(--dsw-alias-label-tertiary)", whiteSpace: "pre-wrap" }}>{body}</div>}
    </div>
  );
}

/* ---------------------------------- blocks ---------------------------------- */

function BlockList({ blocks, tools, streaming }: { blocks: Block[]; tools: Record<string, ToolStateView>; streaming: boolean }) {
  const out: React.ReactNode[] = [];
  let think: string[] = [];
  const flush = (k: string) => {
    if (!think.length) return;
    out.push(<Thinking key={`t-${k}`} texts={think} streaming={false} />);
    think = [];
  };
  blocks.forEach((b, i) => {
    if (b.type === "thinking") { think.push(String(b.thinking ?? "")); return; }
    flush(String(i));
    if (b.type === "text") {
      const t = String(b.text ?? "");
      if (t.trim()) out.push(<Markdown key={i} text={t} />);
    } else if (b.type === "toolCall") {
      out.push(<ToolCall key={i} call={b} state={tools[String(b.id ?? "")]} />);
    } else if (b.type === "image") {
      const data = (b as Block).data ?? (b as Block).dataBase64;
      const mime = String((b as Block).mimeType ?? "image/png");
      out.push(
        data ? (
          <img key={i} className="pw-ioImage" alt={String((b as Block).filename ?? "image")} src={`data:${mime};base64,${String(data)}`} />
        ) : (
          <div key={i} className="pw-ioLabel">[image{(b as Block).filename ? `: ${String((b as Block).filename)}` : ""}]</div>
        ),
      );
    }
  });
  flush("end");
  if (streaming && !think.length) {
    out.push(
      <div key="live" className="pw-discRow" style={{ cursor: "default" }}>
        <span className="pw-discLeading"><Icon name="loading-outline" size={15} className="pw-spinIcon" /></span>
        <span className="pw-shimmer pw-discSummary pw-shimmer--on">
          <span className="pw-shimmer__content"><span className="pw-discSummaryText">working</span></span>
          <span className="pw-shimmer__deco"><span className="pw-shimmer__bar" /></span>
        </span>
      </div>,
    );
  }
  return <div className="pw-flow__content">{out}</div>;
}

/* ----------------------------------- rows ----------------------------------- */

type MessageRowT = Extract<Row, { kind: "message" }>;
function MessageRow({ row, tools }: { row: MessageRowT; tools: Record<string, ToolStateView> }) {
  const showTime = useSettings((s) => s.showTimestamps);
  const revealHover = useSettings((s) => s.revealActionsOnHover);
  const streaming = row.preview ? !row.preview.done : false;
  const blocks: Block[] = row.preview
    ? (row.preview.blocks.map((b) => b.block) as Block[])
    : blocksOfMessage(messageOf(row.entry!)?.content);
  const role = row.preview?.role ?? messageOf(row.entry!)?.role;
  const ts = row.preview?.startedAt ?? row.entry?.timestamp;
  const isUser = role === "user";

  if (isUser) {
    const text = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n");
    const images = blocks.filter((b) => b.type === "image");
    return (
      <div className="pw-turn pw-userRow" data-entry-id={row.entry?.entryId}>
        {images.length > 0 && (
          <div className="pw-userAtt">
            {images.map((im, i) => {
              const data = (im as Block).data ?? (im as Block).dataBase64;
              const mime = String((im as Block).mimeType ?? "image/png");
              return data ? <img key={i} className="pw-ioImage" style={{ margin: 0, width: 96, height: 96, objectFit: "cover" }} alt="" src={`data:${mime};base64,${String(data)}`} /> : null;
            })}
          </div>
        )}
        <div className="pw-bubble">{text}</div>
        <div className={`pw-actions${revealHover && showTime ? " pw-actions--reveal" : ""}`} style={{ marginTop: -2 }}>
          {showTime && <span className="pw-actionTime">{timeShort(ts)}</span>}
          <Tip label="Copy"><button className="pw-action" aria-label="Copy message" onClick={() => { void copyText(text).then((ok) => ok && toast.success("Copied")); }}><Icon name="copy-outline" size={15} /></button></Tip>
        </div>
      </div>
    );
  }

  return (
    <div className="pw-turn pw-answer" data-entry-id={row.entry?.entryId}>
      <div className="pw-answer__body">
        <BlockList blocks={blocks} tools={tools} streaming={streaming} />
      </div>
      {!streaming && (
        <div className={`pw-answer__actions pw-actions${revealHover && showTime ? " pw-actions--reveal" : ""}`}>
              {showTime && <span className="pw-actionTime">{timeShort(ts)}</span>}
          <Tip label="Copy answer">
            <button
              className="pw-action"
              aria-label="Copy answer"
              onClick={() => {
                const md = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n\n");
                void copyText(md).then((ok) => ok && toast.success("Copied"));
              }}
            ><Icon name="copy-outline" size={15} /></button>
          </Tip>
        </div>
      )}
    </div>
  );
}

function SystemRow({ entry }: { entry: EntryView }) {
  const raw = entry.raw as Record<string, unknown>;
  const isModel = entry.type === "model_change";
  const label = isModel
    ? `model → ${String(raw.provider ?? "")}/${String(raw.modelId ?? "")}`
    : `thinking → ${String(raw.thinkingLevel ?? "")}`;
  return (
    <div className="pw-turn pw-sysRow">
      <span className="pw-sysPill" title={timeFull(entry.timestamp)}>
        <Icon name={isModel ? "agent-preset-outline" : "think-outline"} size={14} />
        {label}
      </span>
    </div>
  );
}

function CompactionRow({ entry }: { entry: EntryView }) {
  const [open, setOpen] = useState(false);
  const summary = String((entry.raw as { summary?: string }).summary ?? "");
  return (
    <div className="pw-turn pw-compaction">
      <button className="pw-compaction__btn" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="pw-discLeading"><Icon name="compact-outline" size={14} /></span>
        <span className="pw-discTitle">Context compacted</span>
        {summary && <span className="pw-discSep" />}
        <span className="pw-discSummary">{oneLine(summary, 90)}</span>
      </button>
      {open && summary && <div className="pw-compaction__body"><Markdown text={summary} /></div>}
    </div>
  );
}

function InvalidRow({ entry }: { entry: EntryView }) {
  return (
    <div className="pw-turn pw-turnError">
      <span className="pw-turnError__dot"><span className="pw-dot" data-state="error" /></span>
      <div>
        <span className="pw-turnError__title">Unreadable entry</span>
        <span className="pw-turnError__msg">{entry.entryId} could not be parsed; the raw log is unchanged.</span>
      </div>
    </div>
  );
}

/* -------------------------------- transcript -------------------------------- */

export function Transcript({ v, boxRef }: { v: SessionView; boxRef: React.RefObject<HTMLDivElement | null> }) {
  const [pinned, setPinned] = useState(true);
  const autoScroll = useSettings((s) => s.autoScroll);
  const rows = useMemo(() => buildRows(v), [v]);
  const tools = useMemo(() => ({ ...toolsFromEntries(v.entries), ...v.tools }), [v.entries, v.tools]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !autoScroll || !pinned) return;
    el.scrollTop = el.scrollHeight;
  }, [rows.length, v.previews, v.runtime?.isStreaming, autoScroll, pinned]);

  useEffect(() => {
    const onGoto = (ev: Event) => {
      const id = (ev as CustomEvent<string>).detail;
      const el = document.querySelector(`[data-entry-id="${id}"]`);
      if (!el) { toast.warn("That entry is not loaded in this view."); return; }
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("pw-flash");
      window.setTimeout(() => el.classList.remove("pw-flash"), 1200);
    };
    window.addEventListener("pw:goto-entry", onGoto);
    return () => window.removeEventListener("pw:goto-entry", onGoto);
  }, []);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      setPinned(near);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <>
      {rows.map((r) => {
        if (r.kind === "system") return <SystemRow key={r.key} entry={r.entry} />;
        if (r.kind === "compaction") return <CompactionRow key={r.key} entry={r.entry} />;
        if (r.kind === "invalid") return <InvalidRow key={r.key} entry={r.entry} />;
        return <MessageRow key={r.key} row={r} tools={tools} />;
      })}
      {v.runtime?.retry?.active && (
        <div className="pw-turn pw-turnError">
          <span className="pw-turnError__dot"><span className="pw-dot" data-state="warning" /></span>
          <div><span className="pw-turnError__title" style={{ color: "var(--dsw-alias-state-warn-primary)" }}>Retrying</span><span className="pw-turnError__msg">{v.runtime.retry.reason ?? "the request failed and is being retried"}</span></div>
        </div>
      )}
      {v.runtime?.lastSettled?.aborted && rows.length > 0 && (
        <div className="pw-turn"><span className="pw-answer__stopped">stopped</span></div>
      )}
      {!pinned && autoScroll && (
        <button
          className="pw-pill pw-pill--interactive"
          style={{ position: "sticky", alignSelf: "center", bottom: 8, zIndex: 5, background: "var(--dsw-alias-button-floating-fill)" }}
          onClick={() => { const el = boxRef.current; if (el) el.scrollTop = el.scrollHeight; setPinned(true); }}
        >
          <Icon name="chevron-down-outline" size={12} /> Jump to latest
        </button>
      )}
    </>
  );
}
