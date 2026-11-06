/* pi-web — minimal document-style UI for pi sessions. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, type DialogRequest, type EntryView, type PreviewState, type ToolStateView, type SessionView } from "./store";
import { renderMarkdown, highlightWithin, escapeHtml } from "./md";
import { applyTheme } from "./theme";

/* ------------------------------ small helpers ------------------------------ */

function cls(...xs: (string | false | null | undefined)[]) { return xs.filter(Boolean).join(" "); }

function Md({ text }: { text: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const html = useMemo(() => renderMarkdown(text), [text]);
  useEffect(() => { highlightWithin(ref.current); }, [html]);
  return <div ref={ref} className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

function thinkLabel(l: string | null | undefined) {
  return l && l !== "off" ? `think:${l}` : null;
}

function timeStr(ts: string) {
  try {
    const d = new Date(ts); const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    return sameDay ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

/* ------------------------------ content blocks ------------------------------ */

type Block = Record<string, unknown> & { type?: string };

function blockText(b: Block): string {
  if (b.type === "text") return String(b.text ?? "");
  return "";
}

function ToolCard({ call, state }: { call: Block | null; state?: ToolStateView | undefined }) {
  const [open, setOpen] = useState(false);
  const name = String(call?.name ?? state?.toolName ?? "tool");
  const args = (call?.arguments ?? state?.argsPreview) as unknown;
  const st = state?.state ?? "running";
  const dot = st === "running" ? "text-[var(--c-warning)]" : st === "error" ? "text-[var(--c-error)]" : "text-[var(--c-success)]";
  const output = state?.outputContent?.length
    ? state.outputContent.map((c) => (c.type === "text" ? String(c.text ?? "") : JSON.stringify(c, null, 1))).join("\n")
    : state?.outputText ?? "";
  return (
    <div className="my-1 border border-[var(--c-border)] rounded bg-[var(--c-bgPanel)] text-[0.9rem]">
      <button className="w-full flex items-center gap-2 px-2 py-1 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={cls("mono text-[0.8rem]", dot)}>{st === "running" ? "◐" : st === "error" ? "✗" : "✓"}</span>
        <span className="mono text-[var(--c-fgMuted)]">{name}</span>
        {args != null && <span className="mono text-[var(--c-fgDim)] truncate flex-1">{shortArgs(args)}</span>}
        {state?.durationMs != null && <span className="text-[var(--c-fgDim)] text-[0.75rem] ml-auto">{(state.durationMs / 1000).toFixed(1)}s</span>}
      </button>
      {open && (
        <div className="px-2 pb-2 space-y-1 border-t border-[var(--c-border)] pt-1">
          {args != null && <pre className="mono text-[0.78rem] text-[var(--c-fgMuted)] whitespace-pre-wrap">{JSON.stringify(args, null, 1).slice(0, 2000)}</pre>}
          {output && <pre className="mono text-[0.78rem] whitespace-pre-wrap max-h-64 overflow-auto bg-[var(--x-codeBg)] border border-[var(--c-border)] rounded p-1">{output.slice(0, 64 * 1024)}</pre>}
          {state?.truncated && <div className="text-[var(--c-fgDim)] text-[0.75rem]">output truncated by transport bound</div>}
        </div>
      )}
    </div>
  );
}

function shortArgs(a: unknown): string {
  try {
    const s = typeof a === "string" ? a : JSON.stringify(a);
    const one = s.replace(/\s+/g, " ");
    return one.length > 90 ? one.slice(0, 90) + "…" : one;
  } catch { return ""; }
}

function Blocks({ blocks, tools }: { blocks: Block[]; tools: Record<string, ToolStateView> }) {
  const out: React.ReactNode[] = [];
  let thinkBuf: string[] = [];
  const flushThink = (k: string) => {
    if (thinkBuf.length) {
      const t = thinkBuf.join("\n"); thinkBuf = [];
      out.push(
        <details key={`th-${k}`} className="my-1 text-[0.88rem] text-[var(--c-fgDim)] border-l-2 border-[var(--c-border)] pl-2">
          <summary className="cursor-pointer select-none">thinking</summary>
          <div className="md whitespace-pre-wrap pt-1">{t}</div>
        </details>);
    }
  };
  blocks.forEach((b, i) => {
    if (b.type === "thinking") { thinkBuf.push(String(b.thinking ?? "")); return; }
    flushThink(String(i));
    if (b.type === "text") out.push(<Md key={i} text={blockText(b)} />);
    else if (b.type === "toolCall") out.push(<ToolCard key={i} call={b} state={tools[String(b.id ?? "")]} />);
    else if (b.type === "image") out.push(<div key={i} className="my-1 text-[0.8rem] text-[var(--c-fgDim)] mono">[image: {String(b.name ?? "unnamed")}]</div>);
  });
  flushThink("end");
  return <>{out}</>;
}

/* ------------------------------ transcript ------------------------------ */

interface Row { kind: "message" | "system" | "compaction" | "invalid" | "preview"; key: string; entry?: EntryView; preview?: PreviewState; }

function buildRows(v: SessionView): Row[] {
  const rows: Row[] = [];
  const mapped = new Set<string>();
  for (const p of Object.values(v.previews)) if (p.mappedEntryId) mapped.add(p.mappedEntryId);
  for (const e of v.entries) {
    if (e.invalid) { rows.push({ kind: "invalid", key: e.entryId, entry: e }); continue; }
    const raw = e.raw as { type?: string; message?: { role?: string; content?: unknown }; summary?: string };
    if (e.type === "message") {
      if (raw.message?.role === "toolResult" || raw.message?.role === "system") continue; // tool results render inside tool cards; system noise hidden
      rows.push({ kind: "message", key: e.entryId, entry: e });
    } else if (e.type === "compaction") rows.push({ kind: "compaction", key: e.entryId, entry: e });
    else if (e.type === "model_change" || e.type === "thinking_level_change") rows.push({ kind: "system", key: e.entryId, entry: e });
    // label, session_info and unknown entry types are intentionally not shown as transcript rows
  }
  const live = Object.values(v.previews).filter((p) => !p.mappedEntryId && p.blocks.length > 0);
  live.sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  for (const p of live) rows.push({ kind: "preview", key: `pv:${p.liveMessageId}`, preview: p });
  return rows;
}

function toolsFromFileEntries(entries: EntryView[] | undefined): Record<string, ToolStateView> {
  const out: Record<string, ToolStateView> = {};
  if (!entries) return out;
  for (const e of entries) {
    const m = e.raw.message as { role?: string; toolCallId?: string; toolName?: string; content?: unknown; isError?: boolean } | undefined;
    if (e.type === "message" && m?.role === "toolResult" && m.toolCallId) {
      out[m.toolCallId] = {
        toolCallId: m.toolCallId, toolName: String(m.toolName ?? "tool"),
        state: m.isError ? "error" : "ok", outputMode: "replace",
        outputContent: Array.isArray(m.content) ? m.content as unknown as Record<string, unknown>[] : undefined,
        startedAt: e.timestamp, endedAt: e.timestamp,
      } as ToolStateView;
    }
  }
  return out;
}

function MessageRow({ entry }: { entry: EntryView }) {
  const m = entry.raw.message as { role?: string; content?: Block[] | string; timestamp?: string };
  const blocks: Block[] = Array.isArray(m.content) ? m.content as Block[] : typeof m.content === "string" ? [{ type: "text", text: m.content }] : [];
  const runtimeTools = useStore((s) => (s.activeKey ? s.views[s.activeKey]?.tools : {})) ?? {};
  const fileEntries = useStore((s) => (s.activeKey ? s.views[s.activeKey]?.entries : []));
  const tools = useMemo(() => ({ ...toolsFromFileEntries(fileEntries), ...runtimeTools }), [fileEntries, runtimeTools]);
  const isUser = m.role === "user";
  return (
    <div className={cls("group px-3 py-1.5", isUser ? "bg-[var(--c-bgSelected)]" : "")}>
      <div className="flex items-baseline gap-2 mb-0.5">
        <span className={cls("text-[0.75rem] uppercase tracking-wide", isUser ? "text-[var(--c-fg)] font-semibold" : "text-[var(--c-fgDim)]")}>{isUser ? "you" : "pi"}</span>
        <span className="text-[0.7rem] text-[var(--c-fgDim)] opacity-0 group-hover:opacity-100">{timeStr(entry.timestamp)}</span>
      </div>
      <Blocks blocks={blocks} tools={tools} />
    </div>
  );
}

function PreviewRow({ p }: { p: PreviewState }) {
  const tools = useStore((s) => (s.activeKey ? s.views[s.activeKey]?.tools : {})) ?? {};
  return (
    <div className="px-3 py-1.5 opacity-95">
      <div className="flex items-baseline gap-2 mb-0.5">
        <span className="text-[0.75rem] uppercase tracking-wide text-[var(--c-fgDim)]">{p.role === "user" ? "you" : "pi"}</span>
        {!p.done && <span className="blink text-[0.7rem] text-[var(--c-accent)]">streaming</span>}
      </div>
      <Blocks blocks={p.blocks as unknown as Block[]} tools={tools} />
    </div>
  );
}

function SystemRow({ entry }: { entry: EntryView }) {
  const raw = entry.raw as Record<string, unknown>;
  let msg = entry.type;
  if (entry.type === "model_change") msg = `model → ${String(raw.provider ?? "")}/${String(raw.modelId ?? raw.model ?? "")}`;
  if (entry.type === "thinking_level_change") msg = `thinking → ${String(raw.thinkingLevel ?? raw.level ?? "")}`;
  return <div className="px-3 py-0.5 text-[0.75rem] text-[var(--c-fgDim)] mono">{msg}</div>;
}

function CompactionRow({ entry }: { entry: EntryView }) {
  const raw = entry.raw as { summary?: string };
  const [open, setOpen] = useState(false);
  return (
    <div className="px-3 py-1">
      <button onClick={() => setOpen((o) => !o)} className="w-full flex items-center gap-2 text-[0.75rem] text-[var(--c-fgDim)]">
        <span className="flex-1 border-t border-dashed border-[var(--c-borderAccent)]" />
        <span className="mono">— compacted context {open ? "▴" : "▾"} —</span>
        <span className="flex-1 border-t border-dashed border-[var(--c-borderAccent)]" />
      </button>
      {open && raw.summary && <div className="mt-1 border border-[var(--c-border)] rounded bg-[var(--c-bgPanel)] p-2"><Md text={String(raw.summary)} /></div>}
    </div>
  );
}

function Transcript() {
  const activeKey = useStore((s) => s.activeKey);
  const v = useStore((s) => (s.activeKey ? s.views[s.activeKey] : undefined));
  const boxRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(true);
  const rows = useMemo(() => (v ? buildRows(v) : []), [v]);
  useEffect(() => {
    if (pinned && boxRef.current) boxRef.current.scrollTop = boxRef.current.scrollHeight;
  }, [rows.length, pinned, v?.previews]);
  const onScroll = () => {
    const el = boxRef.current; if (!el) return;
    setPinned(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
  };
  if (!activeKey) return <div className="flex-1 flex items-center justify-center text-[var(--c-fgDim)]">select or create a session</div>;
  if (!v || !v.loaded) return <div className="flex-1 flex items-center justify-center text-[var(--c-fgDim)]">loading…</div>;
  const usage = v.runtime?.contextUsage;
  return (
    <div ref={boxRef} onScroll={onScroll} className="flex-1 overflow-y-auto" role="log" aria-label="transcript">
      {v.hasOlder && <button className="w-full py-1 text-[0.8rem] text-[var(--c-fgDim)] hover:text-[var(--c-fg)]" onClick={() => void useStore.getState().loadOlder()}>load earlier messages</button>}
      {v.entryTotal > v.entries.length && <div className="px-3 py-1 text-[0.75rem] text-[var(--c-fgDim)]">showing {v.entries.length} of {v.entryTotal} entries (most recent)</div>}
      {rows.map((r) =>
        r.kind === "message" ? <MessageRow key={r.key} entry={r.entry!} />
        : r.kind === "preview" ? <PreviewRow key={r.key} p={r.preview!} />
        : r.kind === "compaction" ? <CompactionRow key={r.key} entry={r.entry!} />
        : r.kind === "system" ? <SystemRow key={r.key} entry={r.entry!} />
        : <div key={r.key} className="px-3 py-1 text-[0.8rem] text-[var(--c-error)] mono">unreadable record ({r.entry?.byteOffset}): {escapeHtml(String((r.entry?.raw as { textPreview?: string })?.textPreview ?? "").slice(0, 120))}</div>)}
      {usage?.percent != null && <div className="px-3 py-2 text-[0.72rem] text-[var(--c-fgDim)]">context {usage.percent.toFixed(0)}% of {Math.round((usage.contextWindow ?? 0) / 1000)}k tokens</div>}
      <div className="h-2" />
    </div>
  );
}

/* ------------------------------ status bar ------------------------------ */

const PHASE_LABEL: Record<string, string> = {
  idle: "idle", streaming: "streaming…", compacting: "compacting…", retrying: "retrying…",
  awaiting_dialog: "waiting for your answer", unavailable: "runtime offline", stale: "stale",
};

function StatusBar() {
  const v = useStore((s) => (s.activeKey ? s.views[s.activeKey] : undefined));
  if (!v) return null;
  const st = v.status;
  const phase = v.runtime?.phase ?? st?.state ?? "unavailable";
  const mode = st?.mode ?? "?";
  const src = v.sse === "live" ? "" : ` · stream: ${v.sse}`;
  const rt = st?.runtime;
  return (
    <div className="px-3 py-1 border-b border-[var(--c-border)] bg-[var(--x-cardBg)] flex items-center gap-2 text-[0.78rem] text-[var(--c-fgMuted)] flex-wrap">
      <span className={cls("mono", phase === "streaming" && "text-[var(--c-accent)]", phase === "awaiting_dialog" && "text-[var(--c-warning)]")}>{PHASE_LABEL[phase] ?? phase}</span>
      <span className="text-[var(--c-fgDim)]">·</span>
      <span title={mode === "managed" ? "managed pi SDK child process (created in the browser)" : mode === "live" ? "your terminal pi, controlled through the opt-in bridge" : mode === "mirror" ? "file mirror: terminal session, owner not connected" : "history: file only"}>{mode}{rt?.pid ? ` · pid ${rt.pid}` : ""}</span>
      {v.runtime?.model && <><span className="text-[var(--c-fgDim)]">·</span><span className="mono">{v.runtime.model.modelId}</span></>}
      {thinkLabel(v.runtime?.thinkingLevel) && <><span className="text-[var(--c-fgDim)]">·</span><span className="mono">{thinkLabel(v.runtime?.thinkingLevel)}</span></>}
      {(v.runtime?.queue?.count ?? 0) > 0 && <><span className="text-[var(--c-fgDim)]">·</span><span className="text-[var(--c-warning)]">{v.runtime?.queue?.count} queued</span></>}
      {st?.compat && !st.compat.tested && <span className="ml-2 text-[var(--c-error)]" title={st.compat.detail}>pi version not validated — commands disabled</span>}
      <span className="text-[var(--c-fgDim)]">{src}</span>
      {v.notes.map((n, i) => <span key={i} className="ml-auto text-[var(--c-warning)]">{n}</span>)}
    </div>
  );
}

/* ------------------------------ composer ------------------------------ */

function Composer() {
  const activeKey = useStore((s) => s.activeKey);
  const v = useStore((s) => (s.activeKey ? s.views[s.activeKey] : undefined));
  const command = useStore((s) => s.command);
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"start" | "steer" | "followUp">("start");
  const [renameOpen, setRenameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const busy = !!v?.runtime?.isStreaming || (v?.runtime?.phase ?? "") === "streaming";
  const caps = v?.status?.capabilities ?? ({} as Record<string, boolean>);
  const canSend = !!activeKey && !!caps.promptStart;
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => { setText(""); setMode("start"); }, [activeKey]);
  useEffect(() => {
    const ta = taRef.current; if (!ta) return;
    ta.style.height = "0px"; ta.style.height = Math.min(240, ta.scrollHeight + 2) + "px";
  }, [text]);

  const send = () => {
    const t = text.trim();
    if (!t || !canSend) return;
    if (busy && mode === "start") return; // would be rejected by the owner; switch to steer/followUp
    void command({ type: "prompt", text: t, delivery: busy ? mode : "start" });
    setText("");
  };

  const effMode = busy ? mode : "start";

  return (
    <div className="border-t border-[var(--c-border)] bg-[var(--x-cardBg)] px-3 py-2">
      {renameOpen ? (
        <div className="flex gap-2 mb-2">
          <input autoFocus className="flex-1 bg-[var(--c-bg)] border border-[var(--c-border)] rounded px-2 py-1 text-[0.9rem]" value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { void command({ type: "rename", name: nameDraft.trim() || null }); setRenameOpen(false); } if (e.key === "Escape") setRenameOpen(false); }} />
          <button className="px-2 text-[0.85rem] text-[var(--c-fgMuted)] hover:text-[var(--c-fg)]" onClick={() => { void command({ type: "rename", name: nameDraft.trim() || null }); setRenameOpen(false); }}>set</button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-[0.75rem] text-[var(--c-fgDim)] mb-1 flex-wrap">
          <span className="font-medium text-[var(--c-fgMuted)]">{v?.runtime?.sessionName ?? (v?.status?.runtime as { sessionId?: string | null } | undefined)?.sessionId?.slice(0, 8) ?? activeKey?.slice(0, 10) ?? ""}</span>
          {caps.rename && <button className="hover:text-[var(--c-fg)]" onClick={() => { setNameDraft(v?.runtime?.sessionName ?? ""); setRenameOpen(true); }}>rename</button>}
          {caps.setModel && v?.models?.length ? (
            <select className="bg-[var(--c-bg)] border border-[var(--c-border)] rounded px-1 py-0.5 mono text-[0.75rem]"
              value={v.runtime?.model ? `${v.runtime.model.provider}/${v.runtime.model.modelId}` : ""}
              onChange={(e) => { const [p, m] = e.target.value.split("/"); if (p && m) void command({ type: "setModel", provider: p, modelId: m }); }}>
              {!v.runtime?.model && <option value="">model…</option>}
              {v?.models.map((m) => <option key={`${m.provider}/${m.modelId}`} value={`${m.provider}/${m.modelId}`}>{m.provider}/{m.modelId}</option>)}
            </select>
          ) : null}
          {caps.setThinking && (
            <select className="bg-[var(--c-bg)] border border-[var(--c-border)] rounded px-1 py-0.5 mono text-[0.75rem]"
              value={v?.runtime?.thinkingLevel ?? "off"}
              onChange={(e) => void command({ type: "setThinking", level: e.target.value })}>
              {["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((l) => <option key={l} value={l}>think:{l}</option>)}
            </select>
          )}
          {caps.compact && <button className="hover:text-[var(--c-fg)]" disabled={busy} onClick={() => void command({ type: "compact", instructions: "" })}>compact</button>}
          {caps.clearQueue && (v?.runtime?.queue?.count ?? 0) > 0 && <button className="text-[var(--c-warning)] hover:underline" onClick={() => void command({ type: "clearQueue" })}>clear queue ({v?.runtime?.queue?.count})</button>}
          {v?.status?.mode === "managed" && caps.stopForTerminal && (
            <button className="ml-auto hover:text-[var(--c-fg)]" title="stop this managed run so the session can be resumed in your terminal" onClick={() => void command({ type: "stopForTerminal", mode: "settle" })}>
              return to terminal…
            </button>
          )}
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={taRef}
          rows={1}
          className="flex-1 resize-none bg-[var(--c-bg)] border border-[var(--c-border)] focus:border-[var(--c-borderAccent)] outline-none rounded px-2 py-1.5 text-[0.95rem]"
          placeholder={busy ? (mode === "steer" ? "steer the current run…" : "queue a follow-up…") : canSend ? "message pi — Enter to send, Shift+Enter for newline" : "no controllable runtime (file mirror / history)"}
          value={text} disabled={!canSend}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
          }}
        />
        <div className="flex flex-col gap-1">
          {busy && (
            <div className="flex gap-1 text-[0.7rem]">
              {(["steer", "followUp"] as const).map((m) => (
                <button key={m} onClick={() => setMode(m)} className={cls("px-1.5 py-0.5 rounded border", effMode === m ? "border-[var(--c-accent)] text-[var(--c-accent)]" : "border-[var(--c-border)] text-[var(--c-fgDim)]")}>{m === "steer" ? "steer" : "follow-up"}</button>
              ))}
            </div>
          )}
          <div className="flex gap-1">
            {busy && caps.abort && (
              <button className="px-2 py-1 rounded border border-[var(--c-error)] text-[var(--c-error)] text-[0.8rem]" onClick={() => void command({ type: "abort" })}>stop</button>
            )}
            <button className="px-3 py-1 rounded bg-[var(--c-accent)] text-black dark:text-black text-[0.9rem] font-medium disabled:opacity-40"
              disabled={!canSend || !text.trim() || (busy && effMode === "start")} onClick={send}>send</button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ dialogs ------------------------------ */

function DialogModal() {
  const v = useStore((s) => (s.activeKey ? s.views[s.activeKey] : undefined));
  const answer = useStore((s) => s.answerDialog);
  const pend = v?.dialogs?.filter((d) => !d.observed) ?? [];
  if (!pend.length) return null;
  const d = pend[0]!;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-md border border-[var(--c-borderAccent)] rounded bg-[var(--x-cardBg)] p-4 space-y-3">
        <div className="text-[1rem] font-medium">{d.title}</div>
        {d.message && <div className="text-[0.9rem] text-[var(--c-fgMuted)]"><Md text={d.message} /></div>}
        <DialogBody d={d} answer={answer} />
        <div className="text-[0.7rem] text-[var(--c-fgDim)]">extension dialog from the pi runtime · your answer is delivered exactly once</div>
      </div>
    </div>
  );
}

function DialogBody({ d, answer }: { d: DialogRequest; answer: (d: DialogRequest, v: unknown, cancel?: boolean) => Promise<void> }) {
  const [text, setText] = useState(d.prefill ?? d.placeholder ?? "");
  if (d.kind === "confirm") {
    return (
      <div className="flex gap-2 justify-end">
        <button className="px-3 py-1 rounded border border-[var(--c-border)] text-[var(--c-fgMuted)]" onClick={() => void answer(d, false)}>no</button>
        <button className="px-3 py-1 rounded bg-[var(--c-accent)] text-black font-medium" onClick={() => void answer(d, true)}>yes</button>
      </div>);
  }
  if (d.kind === "select") {
    return (
      <div className="space-y-1">
        {(d.options ?? []).map((o, i) => (
          <button key={i} className="w-full text-left px-2 py-1 rounded border border-[var(--c-border)] hover:border-[var(--c-borderAccent)] hover:bg-[var(--c-bgHover)]" onClick={() => void answer(d, i)}>{o}</button>
        ))}
        <button className="w-full text-left px-2 py-1 text-[var(--c-fgDim)] text-[0.85rem]" onClick={() => void answer(d, null, true)}>cancel</button>
      </div>);
  }
  return (
    <div className="space-y-2">
      {d.kind === "editor"
        ? <textarea className="w-full h-40 mono text-[0.85rem] bg-[var(--c-bg)] border border-[var(--c-border)] rounded p-2" value={text} onChange={(e) => setText(e.target.value)} />
        : <input autoFocus className="w-full bg-[var(--c-bg)] border border-[var(--c-border)] rounded px-2 py-1.5" value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void answer(d, text); }} />}
      <div className="flex gap-2 justify-end">
        <button className="px-3 py-1 rounded border border-[var(--c-border)] text-[var(--c-fgMuted)]" onClick={() => void answer(d, null, true)}>cancel</button>
        <button className="px-3 py-1 rounded bg-[var(--c-accent)] text-black font-medium" onClick={() => void answer(d, text)}>submit</button>
      </div>
    </div>);
}

/* ------------------------------ rail ------------------------------ */

function Rail() {
  const sessions = useStore((s) => s.sessions);
  const workspaces = useStore((s) => s.workspaces);
  const activeKey = useStore((s) => s.activeKey);
  const openSession = useStore((s) => s.openSession);
  const refresh = useStore((s) => s.refreshSessions);
  const create = useStore((s) => s.createSession);
  const logout = useStore((s) => s.logout);
  const [filter, setFilter] = useState("");

  useEffect(() => { const t = setInterval(() => void refresh(), 15_000); return () => clearInterval(t); }, [refresh]);

  const grouped = useMemo(() => {
    const by = new Map<string, typeof sessions>();
    for (const s of sessions) {
      const t = (s.meta.name ?? s.meta.firstPrompt ?? s.meta.cwd ?? "").toLowerCase();
      if (filter && !t.includes(filter.toLowerCase()) && !(s.meta.cwd ?? "").toLowerCase().includes(filter.toLowerCase())) continue;
      const k = s.meta.workspaceKey ?? s.meta.cwd ?? "other";
      if (!by.has(k)) by.set(k, []);
      by.get(k)!.push(s);
    }
    return [...by.entries()];
  }, [sessions, filter]);

  const modeBadge: Record<string, string> = { managed: "M", live: "L", mirror: "F", history: "H" };
  const modeTitle: Record<string, string> = {
    managed: "managed: pi SDK child started by pi-web",
    live: "live: your terminal pi session, bridged",
    mirror: "mirror: terminal session, not currently bridged (file contents only)",
    history: "history: file only",
  };

  return (
    <div className="w-72 shrink-0 border-r border-[var(--c-border)] bg-[var(--x-cardBg)] flex flex-col">
      <div className="p-2 border-b border-[var(--c-border)] space-y-2">
        <div className="flex items-center gap-2">
          <span className="mono font-semibold text-[0.95rem] tracking-tight">pi<span className="text-[var(--c-fgDim)]">/</span>web</span>
          <button className="ml-auto text-[0.75rem] text-[var(--c-fgDim)] hover:text-[var(--c-fg)]" title="refresh list" onClick={() => void refresh()}>⟳</button>
          <button className="text-[0.75rem] text-[var(--c-fgDim)] hover:text-[var(--c-fg)]" title="toggle light/dark" onClick={() => { const next = localStorage.getItem("piweb-theme") === "light" ? "dark" : "light"; localStorage.setItem("piweb-theme", next); void applyTheme(next); }}>◐</button>
          <button className="text-[0.75rem] text-[var(--c-fgDim)] hover:text-[var(--c-fg)]" onClick={() => void logout()}>sign out</button>
        </div>
        <div className="flex gap-2">
          <input className="flex-1 min-w-0 bg-[var(--c-bg)] border border-[var(--c-border)] rounded px-2 py-1 text-[0.82rem]" placeholder="filter sessions" value={filter} onChange={(e) => setFilter(e.target.value)} />
          {workspaces[0] && <button className="px-2 py-1 rounded border border-[var(--c-border)] text-[0.8rem] hover:border-[var(--c-borderAccent)]" title={`new session in ${workspaces[0].path}`} onClick={async () => { const k = await create(workspaces[0]!.key); if (k) { await refresh(); void openSession(k); } }}>+ new</button>}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {grouped.map(([wsKey, list]) => {
          const ws = workspaces.find((w) => w.key === wsKey);
          return (
            <div key={wsKey}>
              <div className="px-2 pt-3 pb-1 text-[0.68rem] uppercase tracking-wider text-[var(--c-fgDim)] mono truncate" title={ws?.path ?? wsKey}>{ws?.label ?? ws?.path ?? wsKey}</div>
              {list.map((s) => {
                const st = useStore.getState().views[s.meta.sessionKey]?.runtime?.phase;
                const phase = st && s.mode === s.mode ? st : s.state;
                const active = s.meta.sessionKey === activeKey;
                return (
                  <button key={s.meta.sessionKey} onClick={() => void openSession(s.meta.sessionKey)}
                    className={cls("w-full text-left px-2 py-1.5 text-[0.85rem] border-l-2", active ? "border-[var(--c-accent)] bg-[var(--c-bgSelected)]" : "border-transparent hover:bg-[var(--c-bgHover)]")}>
                    <div className="flex items-center gap-1.5">
                      <span className="mono text-[0.62rem] px-1 rounded border border-[var(--c-border)] text-[var(--c-fgDim)]" title={modeTitle[s.mode]}>{modeBadge[s.mode] ?? "?"}</span>
                      <span className={cls("truncate flex-1", s.meta.name ? "font-medium" : "text-[var(--c-fgMuted)]")}>{s.meta.name ?? s.meta.firstPrompt ?? "untitled"}</span>
                      {phase && phase !== "idle" && phase !== "unavailable" && <span className="w-1.5 h-1.5 rounded-full bg-[var(--c-accent)] shrink-0" title={phase} />}
                    </div>
                    <div className="text-[0.7rem] text-[var(--c-fgDim)] truncate">{(s.meta.cwd ?? "").split("/").filter(Boolean).pop() ?? ""}{s.meta.modified ? ` · ${timeStr(s.meta.modified)}` : ""}</div>
                  </button>
                );
              })}
            </div>
          );
        })}
        {!grouped.length && <div className="p-3 text-[0.8rem] text-[var(--c-fgDim)]">no sessions yet. Add a workspace directory on the server (`pi-web serve --allow-dir …`) or start the bridge in a terminal pi.</div>}
      </div>
    </div>
  );
}

/* ------------------------------ handoff ------------------------------ */

function HandoffHint() {
  const v = useStore((s) => (s.activeKey ? s.views[s.activeKey] : undefined));
  const [dismissed, setDismissed] = useState(false);
  if (!v || dismissed || v.status?.mode !== "managed" || v.runtime?.phase !== "idle" || !v.entries.length) return null;
  const file = (v.status?.runtime as { sessionFile?: string | null } | null)?.sessionFile;
  return (
    <div className="border-t border-[var(--c-border)] bg-[var(--c-bgPanel)] px-3 py-1.5 text-[0.78rem] text-[var(--c-fgMuted)] flex items-center gap-2">
      <span>To continue this session in your terminal, it must be stopped here first (use “return to terminal…” above), then:</span>
      {file && <code className="mono bg-[var(--x-codeBg)] border border-[var(--c-border)] rounded px-1 py-0.5">pi --session {file}</code>}
      <button className="ml-auto text-[var(--c-fgDim)]" onClick={() => setDismissed(true)}>✕</button>
    </div>
  );
}

/* ------------------------------ login ------------------------------ */

function Login() {
  const boot = useStore((s) => s.boot);
  const login = useStore((s) => s.login);
  const [code, setCode] = useState(localStorage.getItem("piweb-last-code") ?? "");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="h-full flex items-center justify-center p-4">
      <form className="w-full max-w-sm border border-[var(--c-border)] rounded bg-[var(--x-cardBg)] p-5 space-y-3"
        onSubmit={async (e) => { e.preventDefault(); setBusy(true); localStorage.setItem("piweb-last-code", code); const m = await login(code); setBusy(false); if (m) setErr(m); else void boot(); }}>
        <div className="mono text-lg font-semibold">pi<span className="text-[var(--c-fgDim)]">/</span>web</div>
        <div className="text-[0.85rem] text-[var(--c-fgMuted)]">Enter the bootstrap code printed by <span className="mono">pi-web serve</span> (or created with <span className="mono">pi-web mint-code</span>).</div>
        <input autoFocus type="password" className="w-full bg-[var(--c-bg)] border border-[var(--c-border)] rounded px-3 py-2 mono" value={code} onChange={(e) => { setCode(e.target.value); setErr(null); }} placeholder="bootstrap code" />
        {err && <div className="text-[0.82rem] text-[var(--c-error)]">{err}</div>}
        <button disabled={busy || !code.trim()} className="w-full py-2 rounded bg-[var(--c-accent)] text-black font-medium disabled:opacity-40">{busy ? "…" : "sign in"}</button>
        <div className="text-[0.72rem] text-[var(--c-fgDim)]">Codes are single-use. Sign in again with a new code after cookies expire (pi-web mint-code).</div>
      </form>
    </div>
  );
}

/* ------------------------------ app shell ------------------------------ */

export function App() {
  const authed = useStore((s) => s.authed);
  const boot = useStore((s) => s.boot);
  useEffect(() => { void boot(); }, [boot]);
  if (authed === null) return <div className="h-full flex items-center justify-center text-[var(--c-fgDim)]">connecting…</div>;
  if (!authed) return <Login />;
  return (
    <div className="h-full flex min-w-0">
      <Rail />
      <div className="flex-1 flex flex-col min-w-0">
        <StatusBar />
        <Transcript />
        <HandoffHint />
        <Composer />
      </div>
      <DialogModal />
    </div>
  );
}
