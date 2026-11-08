/** Right-hand panel: session info, workspace files, entry tree and context usage.
    Every tile and row renders live data from the pi-web API. */
import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/api";
import { useStore, type FileView, type SessionView } from "../lib/store";
import { useSettings, type PanelTab } from "../lib/settings";
import { Icon } from "../lib/icons";
import { basename, bytes, timeShort, tokens, copyText } from "../lib/format";
import { toast } from "../ui/Toast";
import { Tip } from "../ui/Tooltip";

interface TreeNode { entryId: string; parentId: string | null; type: string; timestamp: string; preview?: string; childIds: string[]; onActiveBranch?: boolean }
interface TreeResult { roots: string[]; nodes: Record<string, TreeNode>; leaf: { entryId: string | null } }
interface ContextResult { kind: string; capturedAt: string; model: { provider: string; modelId: string; name?: string; contextWindow?: number } | null; thinkingLevel: string | null; messages: { role: string; content: unknown }[]; systemPromptTokens?: number; note?: string }
interface StatsResult { totalEntries: number; messageCounts: Record<string, number>; usageTotals: { input: number; output: number; cacheRead: number; cost: number | null }; runtimeUsage?: { contextUsage: { tokens: number | null; contextWindow: number; percent?: number | null } | null } | null }

function KV({ rows }: { rows: [string, React.ReactNode][] }) {
  return <dl className="pw-kv">{rows.map(([k, v]) => (<div key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{v}</dd></div>))}</dl>;
}

function SessionTab({ v, keyName }: { v: SessionView; keyName: string }) {
  const st = v.status;
  const caps = st?.capabilities ?? {};
  return (
    <>
      <KV rows={[
        ["Mode", <span key="m" className="pw-pill" style={{ height: 20 }}>{st?.mode ?? "—"}</span>],
        ["State", st?.state ?? "—"],
        ["Driver", st?.driver ?? "none"],
        ["Workspace", basename(v.meta?.cwd ?? "") || "—"],
        ["Session", v.meta?.piSessionId ? <button className="pw-fileRow" style={{ padding: 0, justifyContent: "flex-start" }} onClick={() => { void copyText(v.meta!.piSessionId!).then(() => toast.success("Session id copied")); }}><span className="pw-ellipsis">{v.meta.piSessionId.slice(0, 13)}…</span><Icon name="copy-outline" size={12} /></button> : "not created yet"],
        ["Messages", v.entryTotal],
        ["Pi", st?.runtime?.piVersion ?? "—"],
        ["Model", v.runtime?.model ? `${v.runtime.model.name ?? v.runtime.model.modelId}` : "—"],
        ["Thinking", v.runtime?.thinkingLevel ?? "off"],
      ]} />
      <div style={{ marginTop: 20, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {v.meta?.path && <a className="pw-btn pw-btn--sm pw-btn--outline" href={`/api/v1/sessions/${encodeURIComponent(keyName)}/raw`} download style={{ textDecoration: "none" }}><Icon name="download-outline" size={13} /> Session log</a>}
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
  const pct = usage.percent ?? (usage.tokens != null ? (usage.tokens / usage.contextWindow) * 100 : 0);
  return (
    <>
      <div className="pw-meter__bar" style={{ margin: "6px 0" }}>
        <span className="pw-meter__segment" style={{ flex: `0 0 ${Math.min(100, pct)}%`, background: "var(--dsw-static-blue-450)" }} />
      </div>
      <div className="pw-meter__row" style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ color: "var(--dsw-alias-label-tertiary)" }}>{tokens(usage.tokens)} / {tokens(usage.contextWindow)} tokens</span>
        <span style={{ color: "var(--dsw-alias-label-primary)", fontVariantNumeric: "tabular-nums" }}>{pct.toFixed(1)}%</span>
      </div>
    </>
  );
}

function FilesTab({ keyName }: { keyName: string }) {
  const workspaces = useStore((s) => s.workspaces);
  const meta = useStore((s) => (s.activeKey ? s.views[s.activeKey]?.meta : null));
  const readFile = useStore((s) => s.readFile);
  const ws = useMemo(() => workspaces.find((w) => w.key === meta?.workspaceKey) ?? workspaces[0], [workspaces, meta?.workspaceKey]);
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
  return (
    <div style={{ minWidth: 0 }}>
      <div className="pw-crumbPath">
        <button onClick={() => void load("")}>{basename(ws.path)}</button>
        {segs.map((sg, i) => (<span key={i} style={{ display: "inline-flex", alignItems: "center" }}><span>/</span><button onClick={() => void load(segs.slice(0, i + 1).join("/"))}>{sg}</button></span>))}
        {busy && <Icon name="loading-outline" size={12} className="pw-spinIcon" />}
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
        </div>
      )}
      {view?.kind === "text" && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
            <span className="pw-row__title pw-ellipsis">{basename(path)}</span>
            <Tip label="Copy file"><button className="pw-iconBtn" aria-label="Copy file" onClick={() => { void copyText(view.text ?? "").then(() => toast.success("Copied")); }}><Icon name="copy-outline" size={13} /></button></Tip>
            <button className="pw-iconBtn" aria-label="Close file" onClick={() => void load(segs.slice(0, -1).join("/"))}><Icon name="close-outline" size={13} /></button>
          </div>
          <pre className="pw-ioText" style={{ border: "0.5px solid var(--dsw-alias-border-l1)", borderRadius: "var(--dsw-radius-md)", padding: "10px 12px", fontFamily: "var(--ds-font-family-code)", fontSize: "var(--dsh-code-font-size, 11px)", maxHeight: "60vh", overflow: "auto" }}>{view.text}</pre>
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

function TreeTab({ keyName }: { keyName: string }) {
  const v = useStore((s) => (s.activeKey ? s.views[s.activeKey] : null));
  const [tree, setTree] = useState<TreeResult | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    setBusy(true);
    try { setTree(await api.get<TreeResult>(`/api/v1/sessions/${encodeURIComponent(keyName)}/tree`)); }
    catch (e) { toast.error((e as Error).message); }
    setBusy(false);
  }, [keyName]);

  const entryTotal = useStore((st) => (st.activeKey ? st.views[st.activeKey]?.entryTotal : 0) ?? 0);
  useEffect(() => { void refresh(); }, [refresh, entryTotal]);

  if (!tree) return <div className="pw-row__desc">Loading tree…</div>;
  const leafId = v?.runtime?.leafEntryId ?? tree.leaf?.entryId ?? null;

  const renderNode = (id: string, depth: number): React.ReactNode => {
    const n = tree.nodes[id];
    if (!n) return null;
    const isLeaf = !n.childIds.length;
    return (
      <div key={id}>
        <div
          className={`pw-treeRow${id === leafId ? " pw-treeRow--current" : ""}`}
          style={{ paddingLeft: 6 + depth * 12 }}
          title={id === leafId ? "current leaf" : n.preview || n.type}
          role="button"
          tabIndex={0}
          onClick={() => gotoEntry(id)}
          onKeyDown={(e) => { if (e.key === "Enter") gotoEntry(id); }}
        >
          <Icon name={isLeaf ? "tree-corner" : "branch-outline"} size={12} style={{ color: "var(--dsw-alias-label-caption)" }} />
          <span className="pw-ellipsis">{n.preview?.trim() || n.type}</span>
          <span className="pw-treeRow__meta">{timeShort(n.timestamp)}</span>
        </div>
        {n.childIds.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
        <span className="pw-row__desc">{tree.roots.length} root(s) · {Object.keys(tree.nodes).length} entries</span>
        <button className="pw-iconBtn" style={{ marginLeft: "auto" }} aria-label="Reload tree" onClick={() => void refresh()}><Icon name={busy ? "loading-outline" : "refresh-outline"} size={13} className={busy ? "pw-spinIcon" : ""} /></button>
      </div>
      {tree.roots.map((r) => renderNode(r, 0))}
      <div className="pw-row__desc" style={{ marginTop: 10 }}>Highlighted row is the current leaf — the point the next message is appended to.</div>
    </div>
  );
}

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
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10 }}>
        <span className="pw-row__title">Context</span>
        <button className="pw-iconBtn" style={{ marginLeft: "auto" }} aria-label="Reload context" onClick={() => void refresh()}><Icon name={busy ? "loading-outline" : "refresh-outline"} size={13} className={busy ? "pw-spinIcon" : ""} /></button>
      </div>
      {usage ? <ContextMeter usage={usage} /> : <div className="pw-row__desc">No usage reported by this runtime.</div>}
      {ctx && (
        <div style={{ marginTop: 16 }}>
          <KV rows={[
            ["Source", ctx.kind.replace("_", " ")],
            ["Captured", timeShort(ctx.capturedAt)],
            ["Model", ctx.model?.name ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.modelId}` : "—")],
            ["Window", ctx.model?.contextWindow ? tokens(ctx.model.contextWindow) : "—"],
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
            ["Cost", stats.usageTotals?.cost != null ? `$${stats.usageTotals.cost.toFixed(4)}` : "not reported"],
          ]} />
        </div>
      )}
      {ctx?.messages?.length ? (
        <details style={{ marginTop: 16 }}>
          <summary className="pw-row__desc" style={{ cursor: "pointer" }}>Show the prompt ({ctx.messages.length} messages)</summary>
          <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 6 }}>
            {ctx.messages.map((m, i) => (
              <div key={i} className="pw-ioCard" style={{ margin: 0 }}>
                <div className="pw-ioSection" style={{ padding: "8px 12px" }}>
                  <span className="pw-ioLabel">{m.role}</span>
                  <span className="pw-ioText" style={{ maxHeight: 140, overflow: "auto" }}>{typeof m.content === "string" ? m.content : JSON.stringify(m.content).slice(0, 4000)}</span>
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

const TITLES: Record<PanelTab, string> = { session: "Session", files: "Workspace files", tree: "Trajectory", context: "Context" };

export function RightPanel({ v, keyName }: { v: SessionView | null; keyName: string | null }) {
  const { panel, set } = useSettings();
  const tabs: PanelTab[] = ["session", "files", "tree", "context"];

  if (!panel) {
    return (
      <div className="pw-panel">
        <div className="pw-panel__header">
          <span className="pw-panel__title"><Icon name="play-outline" size={14} /> Start</span>
          <span className="pw-panel__actions">
            <Tip label="Session"><button className="pw-iconBtn" aria-label="Open session panel" onClick={() => set({ panel: "session" })}><Icon name="gauge-outline" size={15} /></button></Tip>
            <Tip label="Close panel"><button className="pw-iconBtn" aria-label="Close panel" onClick={() => set({ panel: null })}><Icon name="panel-left-outline" size={15} /></button></Tip>
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
                <Icon name="branch-outline" size={22} style={{ color: "var(--dsw-static-deepseek-450)" }} />
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
        <span className="pw-panel__title">{TITLES[panel]}</span>
        <span className="pw-panel__actions">
          {tabs.filter((t) => t !== panel).map((t) => (
            <Tip key={t} label={TITLES[t]}>
              <button className="pw-iconBtn" aria-label={`Open ${TITLES[t]} panel`} onClick={() => set({ panel: t })}>
                <Icon name={t === "session" ? "gauge-outline" : t === "files" ? "folder-open" : t === "tree" ? "branch-outline" : "data-outline"} size={15} />
              </button>
            </Tip>
          ))}
          <Tip label="Close panel"><button className="pw-iconBtn" aria-label="Close panel" onClick={() => set({ panel: null })}><Icon name="close-outline" size={15} /></button></Tip>
        </span>
      </div>
      <div className="pw-panel__body">
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

