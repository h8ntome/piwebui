/** Main column: header (breadcrumbs, context meter, panel toggles), hero or transcript, composer. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, type WireImage } from "../lib/store";
import { useSettings, useUi, type PanelTab } from "../lib/settings";
import { Icon } from "../lib/icons";
import { FloatingMenu, type MenuItem } from "../ui/Menu";
import { Tip } from "../ui/Tooltip";
import { basename, pct } from "../lib/format";
import { isReadOnlyMode } from "../lib/labels";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";
import { PiMark } from "./Sidebar";
import { ContextMeter } from "./RightPanel";

/** One abbreviation style for path hints: home-relative, then middle-ellipsised (HERO-01). */
export function shortPath(p: string, max = 34): string {
  const s = p.replace(/^\/home\//, "~/").replace(/^\/Users\//, "~/");
  if (s.length <= max) return s;
  return `…${s.slice(-(max - 1))}`;
}

function WorkspaceChip({ heroWorkspaceKey, onAddWorkspace }: { heroWorkspaceKey: string | null; onAddWorkspace: () => void }) {
  const workspaces = useStore((s) => s.workspaces);
  const setHeroWorkspace = useStore((s) => s.setHeroWorkspace);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const cur = workspaces.find((w) => w.key === heroWorkspaceKey);
  const items: MenuItem[] = [
    { kind: "heading", label: "Workspace" },
    ...workspaces.map((w) => ({
      kind: "item" as const,
      label: w.label ?? basename(w.path),
      icon: "folder-close",
      hint: shortPath(w.path),
      selected: w.key === heroWorkspaceKey,
      onSelect: () => { setHeroWorkspace(w.key); setAnchor(null); },
    })),
    { kind: "sep" },
    { kind: "item", label: "Add workspace…", icon: "project-add-outline", onSelect: () => { onAddWorkspace(); setAnchor(null); } },
  ];
  return (
    <>
      <button className="pw-hero__chip" aria-label={cur ? `Workspace ${basename(cur.path)}` : "Choose workspace"} aria-expanded={!!anchor} onClick={(e) => setAnchor(e.currentTarget)}>
        <span className="pw-hero__chipIcon"><Icon name="folder-open" size={15} /></span>
        <span className="pw-ellipsis">{cur ? (cur.label ?? basename(cur.path)) : "Choose workspace"}</span>
        <span className="pw-hero__chipChevron"><Icon name="chevron-down-outline" size={12} /></span>
      </button>
      {anchor && <FloatingMenu anchor={anchor} width={300} items={items} onClose={() => setAnchor(null)} />}
    </>
  );
}

function ContextTrigger() {
  const v = useStore((s) => (s.activeKey ? s.views[s.activeKey] : undefined));
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const usage = v?.runtime?.contextUsage;
  if (!usage || usage.tokens == null) return null;
  const pctValue = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
  // The two rings had no CSS at all, so both circles painted as a solid black disc (CTX-01).
  const dash = (Math.max(0, Math.min(100, pctValue)) / 100) * 40.8;
  return (
    <>
      <Tip label="Context used" side="bottom">
        <button className="pw-trigger" aria-label={`Context usage ${pct(pctValue)}`} aria-expanded={!!anchor} onClick={(e) => setAnchor(e.currentTarget)}>
          <svg className="pw-ring" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <circle className="pw-meter__track" cx="8" cy="8" r="6.5" />
            <circle className="pw-meter__fill" cx="8" cy="8" r="6.5" strokeDasharray={`${dash} 40.8`} transform="rotate(-90 8 8)" />
          </svg>
          {pct(pctValue)}
        </button>
      </Tip>
      {anchor && (
        <FloatingMenu anchor={anchor} align="end" items={[]} onClose={() => setAnchor(null)}
          footer={<div style={{ width: 240, padding: "4px 6px" }}><ContextMeter usage={usage} /></div>} />
      )}
    </>
  );
}

export function MainColumn({ onAddWorkspace, onRequestRename }: { onAddWorkspace: () => void; onRequestRename: (key: string) => void }) {
  const { activeKey, views, sessions, workspaces, heroWorkspace, startInWorkspace, openSession } = useStore();
  const phone = useUi((st) => st.phone);
  const settings = useSettings();
  const v = activeKey ? views[activeKey] : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [columnW, setColumnW] = useState(1100);
  const [booting, setBooting] = useState(false);

  const heroWorkspaceKey = useMemo(() => {
    if (heroWorkspace && workspaces.some((w) => w.key === heroWorkspace)) return heroWorkspace;
    const cur = sessions.find((s) => s.meta.sessionKey === activeKey);
    return cur?.meta.workspaceKey ?? workspaces[0]?.key ?? null;
  }, [heroWorkspace, workspaces, sessions, activeKey]);

  const hasMessages = !!v && (v.entryTotal > 0 || Object.keys(v.previews).length > 0);
  // "no session selected" (hero) and "session with no messages yet" are different states (GEN-04).
  const hero = !v;

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setColumnW(el.clientWidth));
    ro.observe(el);
    setColumnW(el.clientWidth);
    return () => ro.disconnect();
  }, [hero, activeKey]);

  const sendHero = async (text: string, images: WireImage[]) => {
    if (!heroWorkspaceKey || booting) return;
    setBooting(true);
    try {
      const key = await startInWorkspace(heroWorkspaceKey, text, images);
      if (key) await openSession(key);
    } finally { setBooting(false); }
  };

  const meta = v?.meta ?? sessions.find((s) => s.meta.sessionKey === activeKey)?.meta;
  const wsPath = meta?.cwd ?? workspaces.find((w) => w.key === meta?.workspaceKey)?.path ?? null;
  const title = v?.runtime?.sessionName ?? meta?.name?.trim() ?? basename(wsPath ?? "") ?? "New session";
  const readOnly = isReadOnlyMode(v?.status?.mode);
  // "session exists but has no messages yet" is its own state, not the hero (GEN-04).
  const sessionButEmpty = !!v && !hasMessages;

  const togglePanel = (tab: PanelTab | null) => {
    if (phone) {
      if (tab) { settings.set({ panel: tab }); useUi.getState().set({ panelSheet: true }); }
      else useUi.getState().set({ panelSheet: false });
      return;
    }
    settings.set({ panel: settings.panel === tab ? null : tab });
  };

  return (
    <div className="pw-main" style={{ ["--pw-column-w" as string]: `${columnW}px` }}>
      {/* One h1 per view, holding the session title (A11Y-01). */}
      <h1 className="pw-visually-hidden">{hero ? "pi-web — new session" : title}</h1>
      <header className={`pw-main__header${hero ? " pw-main__header--blank" : ""}`}>
        {phone && (
          <Tip label="Open sidebar (Ctrl+B)">
            <button className="pw-iconBtn pw-main__drawerBtn" aria-label="Open sidebar" onClick={() => useUi.getState().set({ drawerOpen: true })}>
              <Icon name="panel-left-outline" size={16} />
            </button>
          </Tip>
        )}
        {!hero && (
          <>
            <nav className="pw-crumbs" aria-label="Breadcrumb">
              {wsPath && <span className="pw-crumb pw-crumb--path" title={wsPath}>{basename(wsPath)}</span>}
              {wsPath && <span className="pw-crumb__sep">/</span>}
              <button className="pw-crumb pw-crumb--current" onClick={() => onRequestRename(activeKey!)} title="Rename session (F2)">
                {title}
              </button>
              {readOnly ? <span className="pw-pill" style={{ height: 20 }}>read-only</span> : null}
              {v?.status?.mode === "live" ? <span className="pw-pill" style={{ height: 20 }}>terminal</span> : null}
              {booting ? <span className="pw-pill" style={{ height: 20 }}>starting…</span> : null}
            </nav>
            <div className="pw-main__utilities"><ContextTrigger /></div>
            <div className="pw-main__corner">
              <Tip label="Session info" side="bottom" className="pw-utility--wide"><button className={`pw-iconBtn${settings.panel === "session" ? " pw-iconBtn--active" : ""}`} aria-label="Session panel" onClick={() => togglePanel("session")}><Icon name="gauge-outline" size={16} /></button></Tip>
              <Tip label="Workspace files" side="bottom" className="pw-utility--wide"><button className={`pw-iconBtn${settings.panel === "files" ? " pw-iconBtn--active" : ""}`} aria-label="Files panel" onClick={() => togglePanel("files")}><Icon name="folder-open" size={16} /></button></Tip>
              <Tip label={settings.panel ? "Close panel" : "Open panel"} side="bottom"><button className={`pw-iconBtn${settings.panel ? " pw-iconBtn--active" : ""}`} aria-label="Toggle right panel" onClick={() => togglePanel(null)}><Icon name="panel-left-outline" size={16} style={{ transform: "scaleX(-1)" }} /></button></Tip>
            </div>
          </>
        )}
        {hero && (
          <>
            <div className="pw-main__utilities" style={{ marginLeft: "auto" }} />
            <div className="pw-main__corner">
              <Tip label={settings.panel ? "Close panel" : "Open panel"} side="bottom"><button className={`pw-iconBtn${settings.panel ? " pw-iconBtn--active" : ""}`} aria-label="Toggle right panel" onClick={() => togglePanel(null)}><Icon name="panel-left-outline" size={16} style={{ transform: "scaleX(-1)" }} /></button></Tip>
            </div>
          </>
        )}
      </header>

      <div ref={bodyRef} className="pw-main__body">
        <div className={`pw-main__scroll${hero ? " pw-main__scroll--hero" : ""}`} ref={scrollRef}>
          {hero ? (
            <div className="pw-hero">
              <div className="pw-hero__stack">
                <div className="pw-hero__headline">
                  <span className="pw-hero__titleGroup">
                    <span className="pw-hero__mark"><PiMark size={34} /></span>
                    {/* The headline now carries the workspace that will actually be used (GEN-02). */}
                    <span>Into the Unknown</span>
                    {/* The badge now carries state instead of a static "local" (GEN-02). */}
                    <span className="pw-hero__badge">{sessionButEmpty ? "new session" : workspaces.length ? `${workspaces.length} workspace${workspaces.length === 1 ? "" : "s"} allowed` : "no workspace yet"}</span>
                  </span>
                </div>
                <div className="pw-hero__body">
                  <div className="pw-hero__row">
                    <WorkspaceChip heroWorkspaceKey={heroWorkspaceKey} onAddWorkspace={onAddWorkspace} />
                  </div>
                  <Composer v={v ?? null} keyName={activeKey ?? ""} hero pendingPick={!heroWorkspaceKey} onSendHero={(t, i) => void sendHero(t, i)} />
                </div>
              </div>
            </div>
          ) : sessionButEmpty ? (
            <>
              <div className="pw-main__chat">
                <div className="pw-emptySession" role="status">
                  <Icon name="new-chat-outline" size={22} />
                  <div className="pw-emptySession__title">This session has no messages yet</div>
                  <div className="pw-emptySession__hint">{readOnly ? "It is a read-only view of a session file with nothing in it." : `Send the first message — pi will start in ${basename(wsPath ?? "the current workspace")}.`}</div>
                </div>
              </div>
              <div className="pw-main__composerSeat">
                <Composer v={v!} keyName={activeKey ?? ""} hero={false} />
              </div>
            </>
          ) : (
            <>
              <div className="pw-main__chat">
                <Transcript v={v!} keyName={activeKey ?? ""} boxRef={scrollRef} />
              </div>
              <div className="pw-main__composerSeat">
                <Composer v={v!} keyName={activeKey ?? ""} hero={false} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
