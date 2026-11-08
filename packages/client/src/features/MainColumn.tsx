/** Main column: header (breadcrumbs, context meter, panel toggles), hero or transcript, composer. */
import { useEffect, useMemo, useRef, useState } from "react";
import { useStore, type WireImage } from "../lib/store";
import { useSettings, useUi } from "../lib/settings";
import { Icon } from "../lib/icons";
import { FloatingMenu, type MenuItem } from "../ui/Menu";
import { Tip } from "../ui/Tooltip";
import { basename } from "../lib/format";
import { Composer } from "./Composer";
import { Transcript } from "./Transcript";
import { PiMark } from "./Sidebar";
import { ContextMeter } from "./RightPanel";

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
      hint: w.path.replace(/^\/home\//, "~/").length > 22 ? `…${w.path.slice(-20)}` : w.path.replace(/^\/home\//, "~/"),
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
  const pct = usage.percent ?? (usage.tokens / usage.contextWindow) * 100;
  return (
    <>
      <button className="pw-trigger" aria-label="Context usage" aria-expanded={!!anchor} onClick={(e) => setAnchor(e.currentTarget)}>
        <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
          <circle className="pw-meter__track" cx="8" cy="8" r="6.5" />
          <circle className="pw-meter__fill" cx="8" cy="8" r="6.5" strokeDasharray={`${(pct / 100) * 40.8} 40.8`} transform="rotate(-90 8 8)" />
        </svg>
        {pct < 10 ? `${pct.toFixed(0)}%` : `${pct.toFixed(0)}%`}
      </button>
      {anchor && (
        <FloatingMenu anchor={anchor} align="end" items={[]} onClose={() => setAnchor(null)}
          footer={<div style={{ width: 240 }}><ContextMeter usage={usage} /></div>} />
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
  const hero = !v || !hasMessages;

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

  return (
    <div className="pw-main" style={{ ["--pw-column-w" as string]: `${columnW}px` }}>
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
              {wsPath && <span className="pw-crumb pw-crumb--path">{basename(wsPath)}</span>}
              {wsPath && <span className="pw-crumb__sep">/</span>}
              <button className="pw-crumb pw-crumb--current" onClick={() => onRequestRename(activeKey!)} title="Rename session (Ctrl+R)">
                {title}
              </button>
              {v?.status?.mode === "mirror" || v?.status?.mode === "history" ? <span className="pw-pill" style={{ height: 20 }}>read-only</span> : null}
              {v?.status?.mode === "live" ? <span className="pw-pill" style={{ height: 20 }}>terminal</span> : null}
              {booting ? <span className="pw-pill" style={{ height: 20 }}>starting…</span> : null}
            </nav>
            <div className="pw-main__utilities"><ContextTrigger /></div>
            <div className="pw-main__corner">
              <Tip label="Session info"><button className={`pw-iconBtn${settings.panel === "session" ? " pw-iconBtn--active" : ""}`} aria-label="Session panel" onClick={() => settings.set({ panel: settings.panel === "session" ? null : "session" })}><Icon name="gauge-outline" size={16} /></button></Tip>
              <Tip label="Workspace files"><button className={`pw-iconBtn${settings.panel === "files" ? " pw-iconBtn--active" : ""}`} aria-label="Files panel" onClick={() => settings.set({ panel: settings.panel === "files" ? null : "files" })}><Icon name="folder-open" size={16} /></button></Tip>
              <Tip label={settings.panel ? "Close panel" : "Open panel"}><button className={`pw-iconBtn${settings.panel ? " pw-iconBtn--active" : ""}`} aria-label="Toggle right panel" onClick={() => settings.set({ panel: settings.panel ? null : "session" })}><Icon name="panel-left-outline" size={16} style={{ transform: "scaleX(-1)" }} /></button></Tip>
            </div>
          </>
        )}
        {hero && (
          <>
            <div className="pw-main__utilities" style={{ marginLeft: "auto" }} />
            <div className="pw-main__corner">
              <Tip label={settings.panel ? "Close panel" : "Open panel"}><button className={`pw-iconBtn${settings.panel ? " pw-iconBtn--active" : ""}`} aria-label="Toggle right panel" onClick={() => settings.set({ panel: settings.panel ? null : "session" })}><Icon name="panel-left-outline" size={16} style={{ transform: "scaleX(-1)" }} /></button></Tip>
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
                    <span>Into the Unknown</span>
                    <span className="pw-hero__badge">local</span>
                  </span>
                </div>
                <div className="pw-hero__body">
                  <div className="pw-hero__row">
                    <WorkspaceChip heroWorkspaceKey={heroWorkspaceKey} onAddWorkspace={onAddWorkspace} />
                  </div>
                  <Composer v={v ?? null} hero onSendHero={(t, i) => void sendHero(t, i)} />
                </div>
              </div>
            </div>
          ) : (
            <>
              <div className="pw-main__chat">
                <Transcript v={v!} boxRef={scrollRef} />
              </div>
              <div className="pw-main__composerSeat">
                <Composer v={v!} hero={false} />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
