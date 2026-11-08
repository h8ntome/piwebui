/** Left sidebar: brand, New Session, panel rows, workspace/session tree, footer menu. */
import { useMemo, useState } from "react";
import { useStore, type SessionListItem } from "../lib/store";
import { useSettings, useNarrow, useUi, type PanelTab } from "../lib/settings";
import { Icon } from "../lib/icons";
import { FloatingMenu, MenuTrigger, type MenuItem } from "../ui/Menu";
import { Tip } from "../ui/Tooltip";
import { basename, timeShort, relTime, oneLine } from "../lib/format";
import { toast } from "../ui/Toast";

const MODE_BADGE: Record<string, string> = { managed: "M", live: "L", mirror: "F", history: "H" };
const MODE_TITLE: Record<string, string> = {
  managed: "managed: a pi started by pi-web (fully controllable here)",
  live: "live: your terminal pi, bridged (controllable here)",
  mirror: "mirror: terminal session, not currently bridged (file contents only)",
  history: "history: file only",
};

/** Only sessions that need attention get a coloured dot; idle rows stay quiet. */
function dotState(phase: string | undefined, mode: string, busy: boolean): "warning" | "error" | null {
  void mode;
  if (busy) return "warning";
  if (phase === "error") return "error";
  return null;
}

export function Sidebar({ onAddWorkspace, onOpenSettings, onNewSession, onRequestRename }: {
  onAddWorkspace: () => void;
  onOpenSettings: () => void;
  onNewSession: (workspaceKey: string) => void;
  onRequestRename: (key: string) => void;
}) {
  const { sessions, workspaces, activeKey, views, openSession, refreshSessions, removeWorkspace, health } = useStore();
  const settings = useSettings();
  const { phone, drawerOpen } = useUi();
  const narrow = useNarrow();
  const collapsed = !phone && (settings.sidebarCollapsed || narrow);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const command = useStore((s) => s.command);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sessions.filter((s) => {
      if (!settings.showReadOnly && (s.mode === "mirror" || s.mode === "history")) return false;
      if (!q) return true;
      const hay = `${s.meta.name ?? ""} ${s.meta.firstPrompt ?? ""} ${s.meta.cwd ?? ""}`.toLowerCase();
      return hay.includes(q);
    });
  }, [sessions, search, settings.showReadOnly]);

  const grouped = useMemo(() => {
    const map = new Map<string, SessionListItem[]>();
    for (const s of visible) {
      const k = settings.groupByWorkspace ? (s.meta.workspaceKey ?? "__none") : "__all";
      const list = map.get(k) ?? [];
      list.push(s);
      map.set(k, list);
    }
    for (const [, list] of map) list.sort((a, b) => (b.meta.modified ?? "").localeCompare(a.meta.modified ?? ""));
    const entries = [...map.entries()];
    if (settings.groupByWorkspace) {
      entries.sort((a, b) => {
        const wa = workspaces.find((w) => w.key === a[0]);
        const wb = workspaces.find((w) => w.key === b[0]);
        if (!wa && !wb) return 0;
        if (!wa) return 1;
        if (!wb) return -1;
        return (b[1][0]?.meta.modified ?? "").localeCompare(a[1][0]?.meta.modified ?? "");
      });
    }
    return entries;
  }, [visible, settings.groupByWorkspace, workspaces]);

  const panelItem = (tab: PanelTab, label: string, icon: string): MenuItem => ({
    kind: "item", label, icon, selected: settings.panel === tab,
    onSelect: () => settings.set({ panel: settings.panel === tab ? null : tab }),
  });

  const viewItems = (close: () => void): MenuItem[] => [
    { kind: "heading", label: "Group by" },
    { kind: "item", label: "WorkSpace", icon: "folder-close", selected: settings.groupByWorkspace, onSelect: () => { settings.set({ groupByWorkspace: true }); close(); } },
    { kind: "item", label: "In one list", icon: "flat-list-outline", selected: !settings.groupByWorkspace, onSelect: () => { settings.set({ groupByWorkspace: false }); close(); } },
    { kind: "sep" },
    { kind: "heading", label: "Filter sessions" },
    { kind: "item", label: "All sessions (show read-only)", selected: settings.showReadOnly, onSelect: () => { settings.set({ showReadOnly: true }); close(); } },
    { kind: "item", label: "Controllable only", selected: !settings.showReadOnly, onSelect: () => { settings.set({ showReadOnly: false }); close(); } },
  ];

  const sessionRow = (s: SessionListItem) => {
    const key = s.meta.sessionKey;
    const v = views[key];
    const phase = v?.runtime?.phase ?? s.state;
    const active = key === activeKey;
    const title = s.meta.name?.trim() || oneLine(s.meta.firstPrompt ?? "", 60) || "untitled session";
    const busy = phase === "streaming" || phase === "tool";
    return (
      <div
        key={key}
        className={`pw-sessionRow${active ? " pw-sessionRow--selected" : ""}`}
        role="button"
        tabIndex={0}
        onClick={() => void openSession(key)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); void openSession(key); } }}
      >
        <span className="pw-row__slot pw-row__state" title={`${s.mode}: ${MODE_TITLE[s.mode] ?? ""}`}>
          {dotState(phase, s.mode, busy) && <span className="pw-dot" data-state={dotState(phase, s.mode, busy)!} />}
        </span>
        <span className="pw-row__title" title={title}>{title}</span>
        {settings.showTimestamps && <span className="pw-row__time">{relTime(s.meta.modified)}</span>}
        <span className="pw-row__actions">
          <Tip label="Copy path"><button className="pw-iconBtn" aria-label="Copy session path" onClick={(e) => { e.stopPropagation(); const p = s.meta.path ?? s.meta.piSessionId ?? key; void navigator.clipboard.writeText(p).then(() => toast.success("Copied")); }}><Icon name="copy-outline" size={13} /></button></Tip>
          <SessionMenu s={s} onRename={() => onRequestRename(key)} onAbort={(k) => void command({ type: "abort" }, k)} />
        </span>
      </div>
    );
  };

  return (
    <aside className={`pw-side${collapsed ? " pw-side--collapsed" : ""}${phone ? " pw-side--drawer" : ""}`} data-open={phone && drawerOpen || undefined}>
      <div className="pw-side__logo">
        <button
          className="pw-side__brand"
          title={`pi-web ${health?.version ?? ""}`}
          aria-label={phone ? "Close sidebar" : collapsed ? "Expand sidebar" : "pi-web"}
          onClick={() => { if (phone) useUi.getState().set({ drawerOpen: false }); else if (collapsed) settings.set({ sidebarCollapsed: false }); }}
        >
          <span className="pw-side__brandIdentity">
            <span className="pw-side__brandMark"><PiMark /></span>
            <span className="pw-side__brandName">pi<span className="pw-side__brandBadge">WEB</span></span>
            {health?.pi?.resolvedVersion && <span className="pw-side__version">pi {health.pi.resolvedVersion}</span>}
          </span>
        </button>
        {phone ? (
          <Tip label="Close sidebar (Ctrl+B)">
            <button className="pw-side__collapse" aria-label="Close sidebar" onClick={() => useUi.getState().set({ drawerOpen: false })}>
              <Icon name="close-outline" size={16} />
            </button>
          </Tip>
        ) : (!collapsed && (
          <Tip label="Collapse sidebar (Ctrl+B)">
            <button className="pw-side__collapse" aria-label="Collapse sidebar" onClick={() => settings.set({ sidebarCollapsed: true })}>
              <Icon name="panel-left-outline" size={16} />
            </button>
          </Tip>
        ))}
      </div>

      <Tip label={workspaces[0] ? `New session in ${workspaces[0].path}` : "Add a workspace first"} side="bottom" style={{ width: "100%", display: "block" }}>
        <button className="pw-newSession" aria-label="New session" disabled={!workspaces.length} onClick={() => onNewSession(activeWorkspaceKey(sessions, activeKey, workspaces) ?? workspaces[0]!.key)}>
          <Icon name="new-chat-outline" size={15} /><span>New Session</span>
        </button>
      </Tip>

      <nav className="pw-nav" aria-label="Panels">
          {([["files", "Workspace files", "folder-open"], ["tree", "Trajectory", "branch-outline"], ["context", "Context", "data-outline"]] as [PanelTab, string, string][]).map(([tab, label, icon]) => (
            <button key={tab} className={`pw-nav__row${settings.panel === tab ? " pw-nav__row--active" : ""}`} aria-pressed={settings.panel === tab}
              onClick={() => settings.set({ panel: settings.panel === tab ? null : tab })}>
              <span className="pw-nav__glyph"><Icon name={icon} size={16} /></span>
              <span className="pw-nav__title">{label}</span>
            </button>
          ))}
        </nav>

      <div className="pw-sessions" aria-hidden={collapsed || undefined}>
        {searchOpen ? (
          <div className="pw-sessions__header" style={{ padding: 0 }}>
            <span className="pw-sessions__search">
              <button className="pw-iconBtn" aria-label="Search sessions" onClick={() => { setSearchOpen(false); setSearch(""); }}><Icon name="search-outline" size={14} /></button>
              <input className="pw-sessions__searchInput" autoFocus placeholder="Search sessions" value={search} onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { setSearchOpen(false); setSearch(""); } }} />
              {search && <button className="pw-iconBtn" aria-label="Clear search" onClick={() => setSearch("")}><Icon name="close-outline" size={13} /></button>}
            </span>
          </div>
        ) : (
          <div className="pw-sessions__header">
            <span className="pw-sessions__label">{settings.groupByWorkspace ? "Workspaces" : "Sessions"}</span>
            <span className="pw-sessions__actions">
              <Tip label="Search sessions"><button className="pw-iconBtn" aria-label="Search sessions" onClick={() => setSearchOpen(true)}><Icon name="search-outline" size={14} /></button></Tip>
              <MenuTrigger align="end" render={({ open, ref, toggle }) => (
                <button ref={ref} className="pw-iconBtn" aria-label="View options" aria-expanded={open} onClick={toggle}><Icon name="sliders-two-outline" size={14} /></button>
              )}>{(close) => viewItems(close)}</MenuTrigger>
              <Tip label="Add workspace"><button className="pw-iconBtn" aria-label="Add workspace" onClick={onAddWorkspace}><Icon name="project-add-outline" size={14} /></button></Tip>
            </span>
          </div>
        )}

        <div className="pw-sessions__list">
          {grouped.length === 0 && (
            <div className="pw-sessions__empty">
              <Icon name="browse-outline" size={26} />
              <span>No sessions yet</span>
              <button className="pw-sessions__emptyAction" onClick={onAddWorkspace}>Add a workspace folder</button>
              <span style={{ fontSize: 12, textAlign: "center" }}>or start the bridge in a terminal pi</span>
            </div>
          )}
          {grouped.map(([wsKey, list]) => {
            const ws = workspaces.find((w) => w.key === wsKey);
            if (!settings.groupByWorkspace) return <div className="pw-group" key="all">{list.map(sessionRow)}</div>;
            return (
              <div className="pw-group" key={wsKey}>
                <div className="pw-projectRow" role="button" tabIndex={0} title={ws?.path ?? "sessions pi-web can see but not control"}
                  onClick={() => settings.set({ panel: "files" })}>
                  <span className="pw-row__slot pw-row__slot--folder"><Icon name={ws ? "folder-close" : "archive-outline"} size={15} /></span>
                  <span className="pw-row__title">{ws?.label ?? basename(ws?.path ?? "Unassigned")}</span>
                  <span className="pw-row__actions">
                    {ws && <Tip label="New session here"><button className="pw-iconBtn" aria-label="New session" onClick={(e) => { e.stopPropagation(); onNewSession(ws.key); }}><Icon name="plus-outline" size={13} /></button></Tip>}
                    {ws && <ProjectMenu path={ws.path} onRemove={() => void removeWorkspace(ws.key)} onNew={() => onNewSession(ws.key)} onFiles={() => settings.set({ panel: "files" })} />}
                  </span>
                </div>
                {list.map(sessionRow)}
              </div>
            );
          })}
        </div>
      </div>

      <div className="pw-side__foot">
        <MenuTrigger align="start" width={240} render={({ open, ref, toggle }) => (
          <button ref={ref} className="pw-side__account" aria-label="More" aria-expanded={open} onClick={toggle}>
            <span className="pw-nav__glyph"><Icon name="sliders-two-outline" size={16} /></span>
            <span className="pw-nav__title">More</span>
          </button>
        )}>
          {(close) => [
            { kind: "item", label: "Settings…", icon: "settings-outline", onSelect: () => { onOpenSettings(); close(); } } as MenuItem,
            { kind: "item", label: "Add workspace…", icon: "project-add-outline", onSelect: () => { onAddWorkspace(); close(); } } as MenuItem,
            { kind: "item", label: "Reload sessions", icon: "refresh-outline", hint: `${sessions.length}`, onSelect: () => { void refreshSessions().then(() => toast.success("Session list reloaded")); close(); } } as MenuItem,
            { kind: "sep" },
            { kind: "heading", label: "Panels" } as MenuItem,
            panelItem("session", "Session info", "gauge-outline"),
            panelItem("files", "Workspace files", "folder-open"),
            panelItem("tree", "Trajectory", "branch-outline"),
            panelItem("context", "Context", "data-outline"),
          ]}
        </MenuTrigger>
      </div>
    </aside>
  );
}

function activeWorkspaceKey(sessions: SessionListItem[], activeKey: string | null, workspaces: { key: string }[]): string | null {
  const cur = sessions.find((s) => s.meta.sessionKey === activeKey);
  if (cur?.meta.workspaceKey && workspaces.some((w) => w.key === cur.meta.workspaceKey)) return cur.meta.workspaceKey;
  return workspaces[0]?.key ?? null;
}

function SessionMenu({ s, onRename, onAbort }: { s: SessionListItem; onRename: () => void; onAbort: (key: string) => void }) {
  const command = useStore((st) => st.command);
  const v = useStore((st) => st.views[s.meta.sessionKey]);
  const caps = v?.status?.capabilities ?? ({} as Record<string, boolean>);
  return (
    <MenuTrigger align="end" width={230} render={({ open, ref, toggle }) => (
      <button ref={ref} className="pw-iconBtn" aria-label="Session options" aria-expanded={open} onClick={(e) => { e.stopPropagation(); toggle(); }}><Icon name="ellipsis-outline" size={13} /></button>
    )}>
      {(close) => {
        const items: MenuItem[] = [];
        if (caps.rename) items.push({ kind: "item", label: "Rename…", icon: "list-pen-outline", onSelect: () => { onRename(); close(); } });
        if (caps.compact) items.push({ kind: "item", label: "Compact context", icon: "compact-outline", onSelect: () => { void command({ type: "compact", instructions: "" }, s.meta.sessionKey); close(); } });
        if (v?.status?.mode === "managed" && caps.stopForTerminal) items.push({ kind: "item", label: "Return to terminal", icon: "right-up-outline", onSelect: () => { void command({ type: "stopForTerminal", mode: "settle" }, s.meta.sessionKey); close(); } });
        if (caps.abort) items.push({ kind: "item", label: "Stop run", icon: "stop-fill", danger: true, onSelect: () => { onAbort(s.meta.sessionKey); close(); } });
        if (s.meta.path) items.push({ kind: "item", label: "Download log", icon: "download-outline", onSelect: () => { window.open(`/api/v1/sessions/${encodeURIComponent(s.meta.sessionKey)}/raw`, "_blank"); close(); } });
        if (!items.length) items.push({ kind: "item", label: "Read-only session", disabled: true, onSelect: () => undefined });
        return items;
      }}
    </MenuTrigger>
  );
}

function ProjectMenu({ path, onNew, onRemove, onFiles }: { path: string; onNew: () => void; onRemove: () => void; onFiles: () => void }) {
  return (
    <MenuTrigger align="end" width={230} render={({ open, ref, toggle }) => (
      <button ref={ref} className="pw-iconBtn" aria-label="Workspace options" aria-expanded={open} onClick={(e) => { e.stopPropagation(); toggle(); }}><Icon name="ellipsis-outline" size={13} /></button>
    )}>
      {(close) => [
        { kind: "item", label: "New session here", icon: "plus-outline", onSelect: () => { onNew(); close(); } } as MenuItem,
        { kind: "item", label: "Open files panel", icon: "folder-open", onSelect: () => { onFiles(); close(); } } as MenuItem,
        { kind: "item", label: "Copy path", icon: "copy-outline", onSelect: () => { void navigator.clipboard.writeText(path).then(() => toast.success("Copied")); close(); } } as MenuItem,
        { kind: "sep" },
        { kind: "item", label: "Remove from allowlist", icon: "trash-outline", danger: true, hint: "runs are not interrupted", onSelect: () => { onRemove(); close(); } } as MenuItem,
      ]}
    </MenuTrigger>
  );
}

/** pi wordmark used in the brand row and the hero. */
export function PiMark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle cx="16" cy="16" r="14" stroke="currentColor" strokeWidth="2.2" />
      <path d="M11 11.5h6.6c2.6 0 4.2 1.6 4.2 4.1 0 2.6-1.7 4.2-4.4 4.2H13.6V25" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="21.6" cy="21.8" r="1.7" fill="currentColor" />
    </svg>
  );
}
