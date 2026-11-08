/** Right-hand panel: session info, workspace files, entry tree and context usage.
    Every tile and row renders live data from the pi-web API. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, downloadSessionLog } from "../lib/api";
import { useStore, type FileView, type SessionView } from "../lib/store";
import { useSettings, useUi, type PanelTab } from "../lib/settings";
import { Icon } from "../lib/icons";
import { basename, bytes, timeShort, tokens, copyText, pct, oneLine } from "../lib/format";
import { modeLabel, stateLabel, driverLabel, entryTypeLabel, plainPreview, humaniseError, NA } from "../lib/labels";
import { toast } from "../ui/Toast";
import { Tip } from "../ui/Tooltip";

interface TreeNode { entryId: string; parentId: string | null; type: string; timestamp: string; preview?: string; childIds: string[]; onActiveBranch?: boolean }
interface TreeResult { roots: string[]; nodes: Record<string, TreeNode>; leaf: { entryId: string | null } }
interface ContextResult { kind: string; capturedAt: string; model: { provider?: string; modelId?: string; name?: string; contextWindow?: number } | null; thinkingLevel: string | null; messages: { role: string; content: unknown }[]; systemPromptTokens?: number; note?: string }
interface StatsResult { totalEntries: number; messageCounts: Record<string, number>; usageTotals: { input: number; output: number; cacheRead: number; cost: number | null }; runtimeUsage?: { contextUsage: { tokens: number | null; contextWindow: number; percent?: number | null } | null } | null }

function KV({ rows }: { rows: [string, React.ReactNode][] }) {
  return <dl className="pw-kv">{rows.map(([k, v]) => (<div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>))}</dl>;
}

function SessionTab({ v, keyName }: { v: SessionView; keyName: string }) {
  const st = v.status;
  const caps = st?.capabilities ?? {};
  const metaPath = v.meta?.path ?? null;
  return (
    <>
      {/* One placeholder vocabulary, translated enums (PNL-04 / GEN-05). */}
      <KV rows={[
        ["Mode", <span key="m" className="pw-pill" style={{ height: 20 }}>{modeLabel(st?.mode)}</span>],
        ["State", stateLabel(st?.state)],
        ["Driver", driverLabel(st?.driver)],
        ["Workspace", basename(v.meta?.cwd ?? "") || NA],
        ["Session", v.meta?.piSessionId ? <button key="s" className="pw-fileRow" style={{ padding: 0, justifyContent: "flex-start" }} onClick={() => { void copyText(v.meta!.piSessionId!).then((ok) => ok ? toast.success("Session id copied") : toast.error("Could not copy.")); }}><span className="pw-ellipsis">{v.meta.piSessionId.slice(0, 13)}…</span><Icon name="copy-outline" size={12} /></button> : NA],
        ["Messages", v.entryTotal || 0],
        ["Pi", st?.runtime?.piVersion ?? NA],
        ["Model", v.runtime?.model ? `${v.runtime.model.name ?? v.runtime.model.modelId}` : NA],
        ["Thinking", v.runtime?.thinkingLevel ?? "off"],
      ]} />
      <div style={{ marginTop: 20, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {metaPath && (
          <button
            className="pw-btn pw-btn--sm pw-btn--outline"
            onClick={() => {
              void downloadSessionLog(keyName, `pi-session-${(v.meta?.piSessionId ?? keyName ?? "session").slice(0, 24)}.jsonl`)
                .then((r) => { if (r.truncated) toast.error("Saved part of the log: the server sent fewer bytes than the file holds."); })
                .catch(() => toast.error("Could not download this session log."));
            }}
            title={`${bytes(v.meta?.sizeBytes) || "session log"} — downloads the whole file, not a browser page`}
          >
            <Icon name="download-outline" size={13} /> Session log{v.meta?.sizeBytes ? ` (${bytes(v.meta.sizeBytes)})` : ""}
          </button>
        )}
        {/* README promises this handoff; the path alone made the user build the command (BUG-013). */}
        {metaPath && (
          <button
            className="pw-btn pw-btn--sm pw-btn--outline"
            onClick={() => { void copyText(`pi --session ${metaPath}`).then((ok) => ok ? toast.success("Copied: pi --session <path>") : toast.error("Could not copy.")); }}
            title={`pi --session ${metaPath}`}
          >
            <Icon name="copy-outline" size={13} /> Continue in terminal
          </button>
        )}
      </div>
      {st?.compat && !st.compat.tested && <div className="pw-indicator pw-indicator--warning" style={{ marginTop: 16 }}><Icon name="warning-outline" size={13} /> adapter untested</div>}
      {Array.isArray(caps.notes) && (
        <div style={{ marginTop: 20 }}>
          <div className="pw-row__title" style={{ marginBottom: 6 }}>Runtime notes</div>
          {(caps.notes as string[]).map((n) => <div key={n} className="pw-row__desc" style={{ marginBottom: 4 }}>{n}</div>)}
        </div>
      )}
      {v.runtime?.contextUsage && (
        <div style={{ marginTop: 20 }}>
          <div className="pw-row__title" style={{ marginBottom: 6 }}>Context</div>
          <ContextMeter usage={v.runtime.contextUsage} />
        </div>
      )}
    </>
  );
}

export function ContextMeter({ usage }: { usage: { tokens: number | null; contextWindow: number; percent?: number | null } }) {
  const p = usage.percent ?? (usage.tokens != null ? (usage.tokens / usage.contextWindow) * 100 : 0);
  return (
    <>
      <div className="pw-meter__bar" style={{ margin: "6px 0" }}>
        <span className="pw-meter__segment" style={{ flex: `0 0 ${Math.min(100, p)}%`, background: "var(--dsw-static-blue-450)" }} />
      </div>
      <div className="pw-meter__row" style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ color: "var(--dsw-alias-label-tertiary)" }}>{tokens(usage.tokens)} / {tokens(usage.contextWindow)} tokens</span>
        {/* Same formatter as the header trigger, so the two can never disagree (CTX-01). */}
        <span style={{ color: "var(--dsw-alias-label-primary)", fontVariantNumeric: "tabular-nums" }}>{pct(p)}</span>
      </div>
    </>
  );
}

const PREVIEW_CAP = 200_000;

function FilesTab({ keyName }: { keyName: string }) {
  void keyName;
  const workspaces = useStore((s) => s.workspaces);
  const filesWorkspaceKey = useStore((s) => s.filesWorkspaceKey);
  const meta = useStore((s) => (s.activeKey ? s.views[s.activeKey]?.meta : null));
  const readFile = useStore((s) => s.readFile);
  // A workspace row click wins over the active session's folder (SB-08).
  const ws = useMemo(
    () => workspaces.find((w) => w.key === filesWorkspaceKey) ?? workspaces.find((w) => w.key === meta?.workspaceKey) ?? workspaces[0],
    [workspaces, filesWorkspaceKey, meta?.workspaceKey],
  );
  const [path, setPath] = useState("");
  const [view, setView] = useState<FileView | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (p: string) => {
    if (!ws) return;
    setBusy(true);
    const out = await readFile(ws.key, p);
    setBusy(false);
    setView(out);
    setPath(p);
  }, [readFile, ws]);

  useEffect(() => { void load(""); }, [load]);
  if (!ws) return <div className="pw-row__desc">No allowlisted workspace for this session.</div>;

  const segs = path ? path.split("/") : [];
  const text = view?.kind === "text" ? (view.text ?? "") : "";
  const total = view?.sizeBytes ?? text.length;
  const shown = text.length > PREVIEW_CAP || (view?.truncated ?? false)
    ? `${text.slice(0, PREVIEW_CAP)}\n\n… showing the first ${bytes(Math.min(PREVIEW_CAP, text.length))} of ${bytes(total)} …`
    : text;
  return (
    <div style={{ minWidth: 0 }}>
      <div className="pw-crumbPath">
        <button onClick={() => void load("")}>{basename(ws.path)}</button>
        {segs.map((sg, i) => (<span key={i} style={{ display: "inline-flex", alignItems: "center" }}><span>/</span><button onClick={() => void load(segs.slice(0, i + 1).join("/"))}>{sg}</button></span>))}
        {busy && <Icon name="loading-outline" size={12} className="pw-spinIcon" />}
        {/* Parity with the other tabs: the tree used to go stale until you switched away (PNL-01). */}
        <Tip label="Reload this folder">
          <button className="pw-iconBtn" style={{ marginLeft: "auto" }} aria-label="Reload files" onClick={() => void load(path)}>
            <Icon name={busy ? "loading-outline" : "refresh-outline"} size={13} className={busy ? "pw-spinIcon" : ""} />
          </button>
        </Tip>
      </div>
      {view?.kind === "directory" && (
        <div>
          {(view.entries ?? []).map((e) => (
            <button key={e.name} className="pw-fileRow" onClick={() => void load(path ? `${path}/${e.name}` : e.name)}>
              <Icon name={e.kind === "dir" ? "folder-close" : "code-outline"} size={14} style={{ color: e.kind === "dir" ? "var(--dsw-static-deepseek-500)" : "var(--dsw-alias-label-tertiary)" }} />
              <span className="pw-ellipsis">{e.name}</span>
              {e.kind !== "dir" && <span className="pw-fileRow__size">{bytes(e.sizeBytes)}</span>}
            </button>
          ))}
          {!(view.entries ?? []).length && <div className="pw-row__desc">Empty directory.</div>}
          {view.truncated && <div className="pw-row__desc" style={{ marginTop: 6 }}>Listing is capped at {(view.entries ?? []).length} entries — more exist in this folder.</div>}
        </div>
      )}
      {view?.kind === "text" && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            {/* The breadcrumb already ends with this file's name; no second title row (SPAC-05). */}
            <span className="pw-row__desc pw-ellipsis" style={{ flex: 1 }}>{bytes(view.sizeBytes)}</span>
            <Tip label="Copy file"><button className="pw-iconBtn" aria-label="Copy file" onClick={() => { void copyText(text).then((ok) => ok ? toast.success("Copied") : toast.error("Could not copy.")); }}><Icon name="copy-outline" size={13} /></button></Tip>
            <button className="pw-iconBtn" aria-label="Close file" onClick={() => void load(segs.slice(0, -1).join("/"))}><Icon name="close-outline" size={13} /></button>
          </div>
          <pre className="pw-ioText pw-filePreview">{shown}</pre>
        </>
      )}
      {(view?.kind === "binary" || view?.kind === "too_large") && <div className="pw-row__desc">{view.kind === "binary" ? "Binary file — not shown." : `Too large to preview (${bytes(view.sizeBytes)}).`}</div>}
      {view?.kind === "error" && <div className="pw-row__desc">This path is not readable (denylist or outside the workspace).</div>}
    </div>
  );
}

/** Ask the transcript to bring an entry into view (used by the trajectory tree). */
function gotoEntry(entryId: string) {
  window.dispatchEvent(new CustomEvent("pw:goto-entry", { detail: entryId }));
}

/** Indentation is capped: pi sessions are one long chain, and a linear 300-entry session used
    to reach padding-left: 3594px inside a 379px panel, i.e. nothing readable (TRJ-01). */
const MAX_TREE_DEPTH = 5;
const TREE_STEP = 10;

function TreeTab({ keyName }: { keyName: string }) {
  const v = useStore((s) => (s.activeKey ? s.views[s.activeKey] : null));
  const [tree, setTree] = useState<TreeResult | null>(null);
  const [empty, setEmpty] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const out = await api.get<TreeResult>(`/api/v1/sessions/${encodeURIComponent(keyName)}/tree`);
      setTree(out);
      setEmpty(!Object.keys(out.nodes).length);
    } catch (e) {
      // An empty session is a normal state, not an error toast (TRJ-02).
      setTree(null);
      setEmpty(true);
      const msg = (e as Error).message ?? "";
      if (!/no tree source/i.test(msg)) toast.error(humaniseError(msg));
    }
    setBusy(false);
  }, [keyName]);

  const entryTotal = useStore((st) => (st.activeKey ? st.views[st.activeKey]?.entryTotal : 0) ?? 0);
  // Never show the previous session's tree while the new one loads (TRJ-02).
  useEffect(() => { setTree(null); setEmpty(false); }, [keyName]);
  useEffect(() => { void refresh(); }, [refresh, entryTotal]);

  if (empty) return <div className="pw-row__desc">No entries yet — this session is empty.</div>;
  if (!tree) return <div className="pw-row__desc">Loading tree…</div>;
  const leafId = v?.runtime?.leafEntryId ?? tree.leaf?.entryId ?? null;
  const nodeCount = Object.keys(tree.nodes).length;

  const renderNode = (id: string, depth: number): React.ReactNode => {
    const n = tree.nodes[id];
    if (!n) return null;
    const isLeaf = !n.childIds.length;
    const label = plainPreview(n.preview) || entryTypeLabel(n.type);
    const capped = Math.min(depth, MAX_TREE_DEPTH);
    return (
      <div key={id}>
        <div
          className={`pw-treeRow${id === leafId ? " pw-treeRow--current" : ""}`}
          style={{ paddingLeft: 6 + capped * TREE_STEP }}
          title={id === leafId ? "current leaf" : (n.preview || entryTypeLabel(n.type))}
          role="button"
          tabIndex={0}
          aria-current={id === leafId ? "true" : undefined}
          onClick={() => gotoEntry(id)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); gotoEntry(id); } }}
        >
          <Icon name={isLeaf ? "tree-corner" : "branch-outline"} size={12} style={{ color: "var(--dsw-alias-label-caption)" }} />
          <span className="pw-ellipsis">{label}</span>
          {depth > MAX_TREE_DEPTH && <span className="pw-treeRow__depth" title={`${depth + 1} levels deep`}>+{depth - MAX_TREE_DEPTH}</span>}
          <span className="pw-treeRow__meta">{timeShort(n.timestamp)}</span>
        </div>
        {n.childIds.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <span className="pw-row__desc">{tree.roots.length} root(s) · {nodeCount} {nodeCount === 1 ? "entry" : "entries"}</span>
        <Tip label="Jump to the current leaf" side="bottom">
          <button className="pw-iconBtn" style={{ marginLeft: "auto" }} aria-label="Reveal current leaf" onClick={() => { if (leafId) gotoEntry(leafId); }}><Icon name="goal-outline" size={13} /></button>
        </Tip>
        <Tip label="Reload tree" side="bottom">
          <button className="pw-iconBtn" aria-label="Reload tree" onClick={() => void refresh()}><Icon name={busy ? "loading-outline" : "refresh-outline"} size={13} className={busy ? "pw-spinIcon" : ""} /></button>
        </Tip>
      </div>
      {tree.roots.map((r) => renderNode(r, 0))}
      <div className="pw-row__desc" style={{ marginTop: 10 }}>Highlighted row is the current leaf. Click a row to jump to it; entries above the loaded window need “Load older” in the transcript.</div>
    </div>
  );
}

/** Block-aware plain text for the prompt view (PNL-03). */
function promptText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => {
      const o = (b ?? {}) as Record<string, unknown>;
      if (o.type === "text") return String(o.text ?? "");
      if (o.type === "thinking") return `[reasoning]\n${String(o.thinking ?? "")}`;
      if (o.type === "toolCall") return `[tool call ${String(o.name ?? "")}] ${oneLine(o.arguments ?? "", 160)}`;
      if (o.type === "image") return `[image ${String(o.mimeType ?? "")}]`;
      return oneLine(o, 200);
    }).join("\n");
  }
  if (content == null) return "";
  return JSON.stringify(content);
}

const ROLE_LABEL: Record<string, string> = { user: "User", assistant: "Assistant", system: "System", toolResult: "Tool result", tool: "Tool" };

function ContextTab({ keyName }: { keyName: string }) {
  const v = useStore((s) => (s.activeKey ? s.views[s.activeKey] : null));
  const [ctx, setCtx] = useState<ContextResult | null>(null);
  const [stats, setStats] = useState<StatsResult | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = useCallback(async () => {
    setBusy(true);
    try {
      const [c, s] = await Promise.all([
        api.get<ContextResult>(`/api/v1/sessions/${encodeURIComponent(keyName)}/context`).catch(() => null),
        api.get<StatsResult>(`/api/v1/sessions/${encodeURIComponent(keyName)}/stats`).catch(() => null),
      ]);
      setCtx(c); setStats(s);
    } finally { setBusy(false); }
  }, [keyName]);
  useEffect(() => { void refresh(); }, [refresh]);

  const usage = v?.runtime?.contextUsage ?? stats?.runtimeUsage?.contextUsage ?? null;
  const modelLabel = ctx?.model?.name || (ctx?.model?.modelId ? `${ctx.model.provider ?? ""}/${ctx.model.modelId}`.replace(/^\//, "") : NA);
  const promptDump = (ctx?.messages ?? []).map((m) => `${ROLE_LABEL[m.role] ?? m.role}:\n${promptText(m.content)}`).join("\n\n");
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <span className="pw-row__desc">{usage ? "Runtime usage" : "No usage reported by this runtime."}</span>
        <Tip label="Reload context" side="bottom">
          <button className="pw-iconBtn" style={{ marginLeft: "auto" }} aria-label="Reload context" onClick={() => void refresh()}><Icon name={busy ? "loading-outline" : "refresh-outline"} size={13} className={busy ? "pw-spinIcon" : ""} /></button>
        </Tip>
      </div>
      {usage ? <ContextMeter usage={usage} /> : null}
      {ctx && (
        <div style={{ marginTop: 16 }}>
          <KV rows={[
            ["Source", ctx.kind.replace("_", " ")],
            ["Captured", ctx.capturedAt ? timeShort(ctx.capturedAt) : NA],
            ["Model", modelLabel],
            ["Window", ctx.model?.contextWindow ? tokens(ctx.model.contextWindow) : NA],
            ["Messages in prompt", ctx.messages?.length ?? 0],
          ]} />
        </div>
      )}
      {stats && (
        <div style={{ marginTop: 16 }}>
          <div className="pw-row__title" style={{ marginBottom: 6 }}>Usage totals</div>
          <KV rows={[
            ["Entries", stats.totalEntries],
            ["User / assistant", `${stats.messageCounts.user ?? 0} / ${stats.messageCounts.assistant ?? 0}`],
            ["Tool results", stats.messageCounts.toolResult ?? 0],
            ["Input tokens", tokens(stats.usageTotals?.input)],
            ["Output tokens", tokens(stats.usageTotals?.output)],
            ["Cache read", tokens(stats.usageTotals?.cacheRead)],
            ["Cost", stats.usageTotals?.cost != null ? `$${stats.usageTotals.cost.toFixed(4)}` : NA],
          ]} />
        </div>
      )}
      {ctx?.messages?.length ? (
        <details style={{ marginTop: 16 }}>
          <summary className="pw-row__desc" style={{ cursor: "pointer" }}>Show the prompt ({ctx.messages.length} messages)</summary>
          <div style={{ display: "flex", alignItems: "center", gap: 6, margin: "8px 0 6px" }}>
            <Tip label="Copy the whole prompt"><button className="pw-iconBtn" aria-label="Copy prompt" onClick={() => { void copyText(promptDump).then((ok) => ok ? toast.success("Prompt copied") : toast.error("Could not copy.")); }}><Icon name="copy-outline" size={13} /></button></Tip>
          </div>
          {/* One scroll container for the whole list, plain text per block (PNL-03). */}
          <pre className="pw-ioText pw-promptDump">{promptDump}</pre>
        </details>
      ) : null}
    </div>
  );
}

const TITLES: Record<PanelTab, string> = { session: "Session", files: "Workspace files", tree: "Trajectory", context: "Context" };
const TAB_ICONS: Record<PanelTab, string> = { session: "gauge-outline", files: "folder-open", tree: "workspace-tree-outline", context: "data-outline" };

export function RightPanel({ v, keyName }: { v: SessionView | null; keyName: string | null }) {
  const { panel, set } = useSettings();
  const phone = useUi((s) => s.phone);
  const tabs: PanelTab[] = ["session", "files", "tree", "context"];
  const closePanel = () => { if (phone) useUi.getState().set({ panelSheet: false }); else set({ panel: null }); };

  if (!panel) {
    return (
      <div className="pw-panel">
        <div className="pw-panel__header">
          <span className="pw-panel__title"><Icon name="play-outline" size={14} /> Start</span>
          <span className="pw-panel__actions">
            <Tip label="Session" side="bottom"><button className="pw-iconBtn" aria-label="Open session panel" onClick={() => set({ panel: "session" })}><Icon name="gauge-outline" size={15} /></button></Tip>
            <Tip label="Close panel" side="bottom"><button className="pw-iconBtn" aria-label="Close panel" onClick={closePanel}><Icon name="panel-left-outline" size={15} /></button></Tip>
          </span>
        </div>
        <div className="pw-panel__body" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="pw-panel__empty">
            <span className="pw-panel__emptyCircle"><Icon name="browse-outline" size={22} /></span>
            <div className="pw-cards">
              <button className="pw-cardTile" onClick={() => set({ panel: "files" })}>
                <Icon name="folder-open" size={22} style={{ color: "var(--dsw-static-amber-400)" }} />
                <span><span className="pw-cardTile__title">Workspace files</span><br /><span className="pw-cardTile__desc">Browse files in this session&rsquo;s workspace</span></span>
              </button>
              <button className="pw-cardTile" onClick={() => set({ panel: "tree" })}>
                <Icon name="workspace-tree-outline" size={22} style={{ color: "var(--dsw-static-deepseek-450)" }} />
                <span><span className="pw-cardTile__title">Trajectory</span><br /><span className="pw-cardTile__desc">Walk the branch structure of this session</span></span>
              </button>
              <button className="pw-cardTile" onClick={() => set({ panel: "context" })}>
                <Icon name="gauge-outline" size={22} style={{ color: "var(--dsw-static-neutral-bluish-500)" }} />
                <span><span className="pw-cardTile__title">Context and usage</span><br /><span className="pw-cardTile__desc">Token meter, prompt view, usage totals</span></span>
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="pw-panel">
      <div className="pw-panel__header">
        {/* Real tabs: a tablist with selection state, not three unlabeled icons (PNL-05). */}
        <div className="pw-panel__tabs" role="tablist" aria-label="Session panels">
          {tabs.map((t) => (
            <Tip key={t} label={TITLES[t]} side="bottom">
              <button
                role="tab"
                aria-selected={panel === t}
                className={`pw-panel__tab${panel === t ? " pw-panel__tab--active" : ""}`}
                aria-label={`${TITLES[t]} panel`}
                onClick={() => set({ panel: t })}
              >
                <Icon name={TAB_ICONS[t]} size={15} />
              </button>
            </Tip>
          ))}
        </div>
        <span className="pw-panel__actions">
          <Tip label="Close panel" side="bottom"><button className="pw-iconBtn" aria-label="Close panel" onClick={closePanel}><Icon name="close-outline" size={15} /></button></Tip>
        </span>
      </div>
      <div className="pw-panel__body" role="tabpanel" aria-label={TITLES[panel]}>
        {!v && panel !== "files" ? <div className="pw-row__desc">Open a session first.</div>
          : panel === "session" && v ? <SessionTab v={v} keyName={keyName ?? ""} />
          : panel === "files" ? <FilesTab keyName={keyName ?? ""} />
          : panel === "tree" && v ? <TreeTab keyName={keyName ?? ""} />
          : panel === "context" && v ? <ContextTab keyName={keyName ?? ""} />
          : <div className="pw-row__desc">Nothing open here yet.</div>}
      </div>
    </div>
  );
}
