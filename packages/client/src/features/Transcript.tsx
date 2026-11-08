/** Transcript: turns, bubbles, thinking, tool calls, compaction and error rows. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, type EntryView, type PreviewState, type SessionView, type ToolStateView } from "../lib/store";
import { useSettings } from "../lib/settings";
import { Icon } from "../lib/icons";
import { timeFull, timeShort, copyText, oneLine, duration, safeJson } from "../lib/format";
import { humaniseError, isReadOnlyMode } from "../lib/labels";
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
      const r = m as unknown as { toolCallId?: string; toolName?: string; content?: unknown; isError?: boolean; durationMs?: number };
      if (!r.toolCallId) continue;
      const structured = r.content != null && !Array.isArray(r.content);
      out[r.toolCallId] = {
        toolCallId: r.toolCallId,
        toolName: String(r.toolName ?? "tool"),
        state: r.isError ? "error" : "ok",
        outputMode: "replace",
        // A structured (non-array) payload used to be dropped on the floor (TOOL-03).
        outputContent: Array.isArray(r.content) ? (r.content as unknown as Record<string, unknown>[]) : (structured ? [{ type: "text", text: safeJson(r.content) }] : undefined),
        startedAt: e.timestamp,
        endedAt: e.timestamp,
        // Real elapsed time is on the toolResult record; without it every card read "unknown ms".
        ...(typeof r.durationMs === "number" ? { durationMs: r.durationMs } : {}),
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

function BlockList({ blocks, tools, streaming, readOnly }: { blocks: Block[]; tools: Record<string, ToolStateView>; streaming: boolean; readOnly: boolean }) {
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
      out.push(<ToolCall key={i} call={b} state={tools[String(b.id ?? "")]} readOnly={readOnly} />);
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
function MessageRow({ row, tools, readOnly, queuedKind }: { row: MessageRowT; tools: Record<string, ToolStateView>; readOnly: boolean; queuedKind?: string | undefined }) {
  const showTime = useSettings((s) => s.showTimestamps);
  const revealHover = useSettings((s) => s.revealActionsOnHover);
  const streaming = row.preview ? !row.preview.done : false;
  const blocks: Block[] = row.preview
    ? (row.preview.blocks.map((b) => b.block) as Block[])
    : blocksOfMessage(messageOf(row.entry!)?.content);
  const role = row.preview?.role ?? messageOf(row.entry!)?.role;
  const ts = row.preview?.startedAt ?? row.entry?.timestamp;
  const isUser = role === "user";
  // Copy lives in the gutter so it never reserves a 44 px band under the turn (SPAC-01);
  // the timestamp is real information and follows its own setting.
  const meta = (label: string, text: string) => (
    <div className={`pw-turnMeta${revealHover && !showTime ? " pw-turnMeta--overlay" : ""}`} data-side={isUser ? "end" : "start"}>
      {showTime && <span className="pw-actionTime" title={timeFull(ts)}>{timeShort(ts)}</span>}
      {queuedKind && <span className="pw-queueTag">queued · {queuedKind}</span>}
      <Tip label={label}>
        <button className="pw-action" aria-label={label} onClick={() => { void copyText(text).then((ok) => (ok ? toast.success("Copied") : toast.error("Could not copy — your browser blocked clipboard access."))); }}><Icon name="copy-outline" size={15} /></button>
      </Tip>
    </div>
  );

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
        {(showTime || revealHover) && meta("Copy message", text)}
      </div>
    );
  }

  const answerText = blocks.filter((b) => b.type === "text").map((b) => String(b.text ?? "")).join("\n\n");
  return (
    <div className="pw-turn pw-answer" data-entry-id={row.entry?.entryId}>
      <div className="pw-answer__body">
        <BlockList blocks={blocks} tools={tools} streaming={streaming} readOnly={readOnly} />
      </div>
      {!streaming && (showTime || revealHover) && meta("Copy answer", answerText)}
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

export function Transcript({ v, keyName, boxRef }: { v: SessionView; keyName: string; boxRef: React.RefObject<HTMLDivElement | null> }) {
  const [pinned, setPinned] = useState(true);
  const [dismissedDiag, setDismissedDiag] = useState(false);
  const autoScroll = useSettings((s) => s.autoScroll);
  const loadOlder = useStore((s) => s.loadOlder);
  const readOnly = isReadOnlyMode(v.status?.mode);
  // Rebuild rows only when their inputs actually change; `v` is a new object on every preview
  // patch, which used to re-diff the whole transcript for each token batch (PERF-04).
  const rows = useMemo(() => buildRows(v), [v.entries, v.previews]);
  const tools = useMemo(() => ({ ...toolsFromEntries(v.entries), ...v.tools }), [v.entries, v.tools]);
  const queuedKinds = useMemo(() => {
    const map = new Map<string, string>();
    for (const it of v.runtime?.queue?.items ?? []) map.set(it.text.trim().slice(0, 200), it.kind === "steer" ? "steer" : "follow-up");
    return map;
  }, [v.runtime?.queue?.items]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el || !autoScroll || !pinned) return;
    // Scroll after layout has settled: while streaming, the queue dock and the composer seat
    // change height in the same frame, which left the newest line under the composer (TRN-03).
    const toBottom = () => { if (autoScroll && pinned) el.scrollTop = el.scrollHeight; };
    const raf = window.requestAnimationFrame(toBottom);
    const ro = new ResizeObserver(toBottom);
    const seat = el.querySelector(".pw-main__composerSeat") ?? el.parentElement?.querySelector(".pw-main__composerSeat");
    if (seat) ro.observe(seat);
    return () => { window.cancelAnimationFrame(raf); ro.disconnect(); };
  }, [rows.length, v.previews, v.runtime?.isStreaming, v.runtime?.queue?.count, autoScroll, pinned, boxRef]);

  useEffect(() => {
    const flash = (el: Element) => {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.classList.add("pw-flash");
      window.setTimeout(() => el.classList.remove("pw-flash"), 1200);
    };
    const onGoto = (ev: Event) => {
      const id = (ev as CustomEvent<string>).detail;
      const el = document.querySelector(`[data-entry-id="${CSS.escape(id)}"]`);
      if (el) { flash(el); return; }
      // A tree row can point at history the transcript has not fetched yet (TRJ-03). Walk
      // backwards a bounded number of pages instead of telling the user to do it by hand.
      const key = keyName;
      void (async () => {
        for (let i = 0; i < 5; i++) {
          const v = useStore.getState().views[key];
          if (!v?.hasOlder || v.loadingOlder) break;
          await useStore.getState().loadOlder(key);
          await new Promise((r) => window.setTimeout(r, 120));
          const hit = document.querySelector(`[data-entry-id="${CSS.escape(id)}"]`);
          if (hit) { flash(hit); return; }
        }
        toast.warn("That entry is not part of the loaded history for this view.");
      })();
    };
    window.addEventListener("pw:goto-entry", onGoto);
    return () => window.removeEventListener("pw:goto-entry", onGoto);
  }, [keyName]);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const onScroll = () => {
      const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
      setPinned(near);
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [boxRef]);

  const missing = Math.max(0, v.entryTotal - v.entries.length);
  return (
    <>
      {v.hasOlder && (
        <div className="pw-loadOlder">
          <button className="pw-pill pw-pill--interactive" onClick={() => void loadOlder(keyName)} disabled={v.loadingOlder}>
            <Icon name={v.loadingOlder ? "loading-outline" : "chevron-up-outline"} size={12} className={v.loadingOlder ? "pw-spinIcon" : ""} />
            {v.loadingOlder ? "Loading…" : `${missing} earlier ${missing === 1 ? "message" : "messages"} — load older`}
          </button>
        </div>
      )}
      {v.diagnostics.length > 0 && !dismissedDiag && (
        <div className="pw-notice pw-notice--warning" role="status">
          <Icon name="warning-outline" size={14} />
          <span>
            {v.diagnostics.length === 1
              ? <span>1 line could not be read at byte {v.diagnostics[0]!.byteOffset} — the raw log is unchanged.</span>
              : <span>{v.diagnostics.length} lines could not be read — the raw log is unchanged.</span>}
            <span className="pw-notice__detail"> {humaniseError(v.diagnostics[0]?.message)}</span>
          </span>
          <button className="pw-iconBtn" aria-label="Dismiss read warning" onClick={() => setDismissedDiag(true)}><Icon name="close-outline" size={12} /></button>
        </div>
      )}
      {rows.map((r) => {
        if (r.kind === "system") return <SystemRow key={r.key} entry={r.entry} />;
        if (r.kind === "compaction") return <CompactionRow key={r.key} entry={r.entry} />;
        if (r.kind === "invalid") return <InvalidRow key={r.key} entry={r.entry} />;
        const text = r.kind === "message" && r.preview
          ? r.preview.blocks.map((b) => (b.block as { text?: string })?.text ?? "").join("")
          : r.kind === "message" && r.entry ? textOf(messageOf(r.entry)?.content) : "";
        const queued = r.kind === "message" && r.preview?.role === "user" && v.runtime?.isStreaming
          ? queuedKinds.get(text.trim().slice(0, 200))
          : undefined;
        return <MessageRow key={r.key} row={r} tools={tools} readOnly={readOnly} queuedKind={queued} />;
      })}
      {v.runtime?.retry?.active && (
        <div className="pw-turn pw-turnError">
          <span className="pw-turnError__dot"><span className="pw-dot" data-state="warning" /></span>
          <div><span className="pw-turnError__title" style={{ color: "var(--dsw-alias-state-warn-primary)" }}>Retrying</span><span className="pw-turnError__msg">{v.runtime.retry.reason ?? "the request failed and is being retried"}</span></div>
        </div>
      )}
      {v.runtime?.lastSettled?.aborted && rows.length > 0 && (
        <div className="pw-turn"><span className="pw-answer__stopped">Run stopped{durationSince(v.runtime.lastSettled.at) ? ` after ${durationSince(v.runtime.lastSettled.at)}` : ""}</span></div>
      )}
      {!pinned && autoScroll && (
        <button
          className="pw-pill pw-pill--interactive pw-jumpLatest"
          onClick={() => { const el = boxRef.current; if (el) el.scrollTop = el.scrollHeight; setPinned(true); }}
        >
          <Icon name="chevron-down-outline" size={12} /> Jump to latest
        </button>
      )}
    </>
  );
}

/** "stopped after Ns" is only knowable from the settled timestamp; keep it honest otherwise. */
function durationSince(at: string | undefined): string {
  if (!at) return "";
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return "";
  const secs = (Date.now() - t) / 1000;
  // The marker is rendered right after settling, so this is the wall time of the run's tail.
  return secs > 0 && secs < 3600 ? duration(secs * 1000) : "";
}
