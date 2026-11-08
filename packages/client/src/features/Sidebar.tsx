/** Left sidebar: brand, New Session, panel rows, workspace/session tree, footer menu. */
import { useEffect, useMemo, useState } from "react";
import { useStore, visibleSessionKeys, type SessionListItem } from "../lib/store";
import { useSettings, useNarrow, useUi, type PanelTab } from "../lib/settings";
import { Icon } from "../lib/icons";
import { FloatingMenu, MenuTrigger, type MenuItem } from "../ui/Menu";
import { Tip } from "../ui/Tooltip";
import { ConfirmDialog } from "../ui/Dialog";
import { basename, relTime, oneLine, copyText, timeFull } from "../lib/format";
import { downloadSessionLog } from "../lib/api";
import { modeLabel } from "../lib/labels";
import { toast } from "../ui/Toast";

/** Controllable here vs. read-only file view, as an icon you can actually see in the row (SB-01). */
const MODE_ICON: Record<string, string> = { managed: "play-outline", live: "code-outline", mirror: "inspect-outline", history: "inspect-outline" };

function modeIcon(mode: string): string { return MODE_ICON[mode] ?? "inspect-outline"; }

/** Only sessions that need attention get a coloured dot; idle rows stay quiet. */
function dotState(phase: string | undefined, mode: string, busy: boolean): "warning" | "error" | null {
  void mode;
  if (busy) return "warning";
  if (phase === "error") return "error";
  return null;
}

/** Title preference: an explicit name, then the first user line, then a real placeholder (SB-06). */
export function sessionTitle(s: SessionListItem): string {
  const name = s.meta.name?.trim();
  if (name) return name;
  const first = oneLine(s.meta.firstPrompt ?? "", 46);
  if (first) return first;
  return "Untitled session";
}

/** Highlight what the search matched, so a filtered list explains itself (SB-03). */
function highlight(text: string, needle: string): React.ReactNode {
  const q = needle.trim();
  if (!q) return text;
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return text;
  return <>{text.slice(0, i)}<mark className="pw-mark">{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}

export function Sidebar({ onAddWorkspace, onOpenSettings, onNewSession, onRequestRename }: {
  onAddWorkspace: () => void;
  onOpenSettings: () => void;
  onNewSession: (workspaceKey: string) => void;
  onRequestRename: (key: string) => void;
}) {
  const { sessions, workspaces, activeKey, views, openSession, refreshSessions, removeWorkspace, setFilesWorkspaceKey, health } = useStore();
  const settings = useSettings();
  const { phone, drawerOpen } = useUi();
  const narrow = useNarrow();
  const collapsed = !phone && (settings.sidebarCollapsed || narrow);
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<{ key: string; path: string } | null>(null);
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
    // Workspaces with no sessions still get a group, so "Add workspace" has a visible result (WS-01).
    if (settings.groupByWorkspace) for (const w of workspaces) map.set(w.key, []);
    for (const s of visible) {
      const k = settings.groupByWorkspace ? (s.meta.workspaceKey ?? "__none") : "__all";
      const list = map.get(k) ?? [];
      list.push(s);
      map.set(k, list);
    }
    // Newest first, but a session that has no mtime yet (just created) goes to the top (SB-05).
    for (const [, list] of map) {
      list.sort((a, b) => {
        const am = a.meta.modified ?? "";
        const bm = b.meta.modified ?? "";
        if (!am && bm) return -1;
        if (!bm && am) return 1;
        return bm.localeCompare(am);
      });
    }
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

  // Publish what is on screen so Alt+↑/↓ steps the same list the user sees (SB-09).
  useEffect(() => {
    visibleSessionKeys.length = 0;
    for (const [, list] of grouped) for (const s of list) visibleSessionKeys.push(s.meta.sessionKey);
  }, [grouped]);

  // "/" opens search (there was no way to reach it from the keyboard before, SB-03).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      if (e.key === "/" && !typing && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        if (collapsed) settings.set({ sidebarCollapsed: false });
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [collapsed, settings]);

  // Bring the selected row into view when the selection changes from elsewhere (SB-05).
  useEffect(() => {
    if (!activeKey || collapsed) return;
    const el = document.querySelector<HTMLElement>(`[data-session-key="${CSS.escape(activeKey)}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [activeKey, collapsed, sessions.length]);

  const panelItem = (tab: PanelTab, label: string, icon: string): MenuItem => ({
    kind: "item", label, icon, selected: settings.panel === tab, role: "menuitemcheckbox",
    onSelect: () => settings.set({ panel: settings.panel === tab ? null : tab }),
  });

  const viewItems = (close: () => void): MenuItem[] => [
    { kind: "heading", label: "Group by" },
    { kind: "item", label: "Workspace", icon: "folder-close", selected: settings.groupByWorkspace, onSelect: () => { settings.set({ groupByWorkspace: true }); close(); } },
    { kind: "item", label: "One list", icon: "flat-list-outline", selected: !settings.groupByWorkspace, onSelect: () => { settings.set({ groupByWorkspace: false }); close(); } },
    { kind: "sep" },
    { kind: "heading", label: "Filter sessions" },
    { kind: "item", label: "All sessions", hint: "including read-only", selected: settings.showReadOnly, onSelect: () => { settings.set({ showReadOnly: true }); close(); } },
    { kind: "item", label: "Controllable only", selected: !settings.showReadOnly, onSelect: () => { settings.set({ showReadOnly: false }); close(); } },
  ];

  const copySessionPath = (s: SessionListItem) => {
    const p = s.meta.path ?? s.meta.piSessionId ?? s.meta.sessionKey;
    // copyText() has the execCommand fallback and a real failure path (SB-07).
    void copyText(p).then((ok) => (ok ? toast.success("Session path copied") : toast.error("Could not copy — your browser blocked clipboard access.")));
  };

  const sessionRow = (s: SessionListItem) => {
    const key = s.meta.sessionKey;
    const v = views[key];
    const phase = v?.runtime?.phase ?? s.state;
    const active = key === activeKey;
    const title = sessionTitle(s);
    const busy = phase === "streaming" || phase === "tool";
    const dot = dotState(phase, s.mode, busy);
    return (
      <div
        key={key}
        data-session-key={key}
        className={`pw-sessionRow${active ? " pw-sessionRow--selected" : ""}`}
      >
        <button
          className="pw-sessionRow__main"
          aria-current={active ? "true" : undefined}
          title={`${title}\n${s.meta.cwd ?? ""}\n${modeLabel(s.mode)}`}
          onClick={() => void openSession(key)}
        >
          <span className="pw-row__slot pw-row__state">
            {dot ? <span className="pw-dot" data-state={dot} /> : <span className={`pw-modeGlyph`} title={modeLabel(s.mode)}><Icon name={modeIcon(s.mode)} size={12} /></span>}
          </span>
          <span className="pw-row__title">{highlight(title, search)}</span>
          {settings.showTimestamps && <span className="pw-row__time" title={timeFull(s.meta.modified)}>{relTime(s.meta.modified)}</span>}
        </button>
        <span className="pw-row__actions">
          <Tip label="Copy path"><button className="pw-iconBtn" aria-label="Copy session path" onClick={() => copySessionPath(s)}><Icon name="copy-outline" size={13} /></button></Tip>
          <SessionMenu s={s} onRename={() => onRequestRename(key)} onAbort={(k) => void command({ type: "abort" }, k)} />
        </span>
      </div>
    );
  };

  const q = search.trim();
  return (
    <aside className={`pw-side${collapsed ? " pw-side--collapsed" : ""}${phone ? " pw-side--drawer" : ""}`} data-open={phone && drawerOpen || undefined}>
      <div className="pw-side__logo">
        <Tip label={collapsed ? "Expand sidebar (Ctrl+B)" : `pi-web ${health?.version ?? ""}`}>
          <button
            className="pw-side__brand"
            aria-label={phone ? "Close sidebar" : collapsed ? "Expand sidebar" : "pi-web"}
            onClick={() => { if (phone) useUi.getState().set({ drawerOpen: false }); else if (collapsed) settings.set({ sidebarCollapsed: false }); }}
          >
            <span className="pw-side__brandIdentity">
              <span className="pw-side__brandMark"><PiMark /></span>
              <span className="pw-side__brandName">pi<span className="pw-side__brandBadge">WEB</span></span>
              {health?.pi?.resolvedVersion && <span className="pw-side__version">pi {health.pi.resolvedVersion}</span>}
            </span>
          </button>
        </Tip>
        {/* The collapse control stays in the rail (rotated): before, a collapsed sidebar had
            no visible way back (SB-04). */}
        {phone ? (
          <Tip label="Close sidebar (Ctrl+B)">
            <button className="pw-side__collapse" aria-label="Close sidebar" onClick={() => useUi.getState().set({ drawerOpen: false })}>
              <Icon name="close-outline" size={16} />
            </button>
          </Tip>
        ) : (
          <Tip label={collapsed ? "Expand sidebar (Ctrl+B)" : "Collapse sidebar (Ctrl+B)"}>
            <button className="pw-side__collapse" aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!collapsed} onClick={() => settings.set({ sidebarCollapsed: !settings.sidebarCollapsed })}>
              <Icon name="panel-left-outline" size={16} {...(collapsed ? { style: { transform: "scaleX(-1)" } } : {})} />
            </button>
          </Tip>
        )}
      </div>

      <Tip label={workspaces[0] ? `New session in ${workspaces[0].path}` : "Add a workspace first"} side="bottom" style={{ width: "100%", display: "block" }}>
        <button className="pw-newSession" aria-label="New session" disabled={!workspaces.length} onClick={() => onNewSession(activeWorkspaceKey(sessions, activeKey, workspaces) ?? workspaces[0]!.key)}>
          <Icon name="new-chat-outline" size={15} /><span>New Session</span>
        </button>
      </Tip>

      <nav className="pw-nav" aria-label="Panels">
        {([["files", "Workspace files", "folder-open"], ["tree", "Trajectory", "workspace-tree-outline"], ["context", "Context", "data-outline"]] as [PanelTab, string, string][]).map(([tab, label, icon]) => (
          <button key={tab} className={`pw-nav__row${settings.panel === tab ? " pw-nav__row--active" : ""}`} aria-pressed={settings.panel === tab}
            onClick={() => {
              if (phone) { settings.set({ panel: tab }); useUi.getState().set({ panelSheet: true, drawerOpen: false }); return; }
              settings.set({ panel: settings.panel === tab ? null : tab });
            }}>
            <span className="pw-nav__glyph"><Icon name={icon} size={16} /></span>
            <span className="pw-nav__title">{label}</span>
          </button>
        ))}
      </nav>

      {/* Collapsed rail: keep the tabbable content out of the a11y/tab order instead of hiding
          it with aria-hidden while it stays focusable (SB-11). */}
      <div className="pw-sessions" inert={collapsed || undefined}>
        {searchOpen ? (
          <div className="pw-sessions__header" style={{ padding: 0 }}>
            <span className="pw-sessions__search">
              <input className="pw-sessions__searchInput" autoFocus placeholder="Search sessions" aria-label="Search sessions" value={search} onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Escape") { setSearchOpen(false); setSearch(""); } }} />
              {search
                ? <button className="pw-iconBtn" aria-label="Clear search" onClick={() => setSearch("")}><Icon name="close-outline" size={13} /></button>
                : <span className="pw-sessions__searchHint">Esc</span>}
              <button className="pw-iconBtn" aria-label="Close search" onClick={() => { setSearchOpen(false); setSearch(""); }}><Icon name="search-outline" size={14} /></button>
            </span>
          </div>
        ) : (
          <div className="pw-sessions__header">
            <span className="pw-sessions__label">{settings.groupByWorkspace ? "Workspaces" : "Sessions"}</span>
            <span className="pw-sessions__actions">
              <Tip label="Search sessions (/)"><button className="pw-iconBtn" aria-label="Search sessions" onClick={() => setSearchOpen(true)}><Icon name="search-outline" size={14} /></button></Tip>
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
              {q
                ? <>
                  <span>No sessions match “{q}”</span>
                  <button className="pw-sessions__emptyAction" onClick={() => setSearch("")}>Clear search</button>
                </>
                : <>
                  <span>No sessions yet</span>
                  <button className="pw-sessions__emptyAction" onClick={onAddWorkspace}>Add a workspace folder</button>
                  <span style={{ fontSize: 12, textAlign: "center" }}>or start the bridge in a terminal pi</span>
                </>}
            </div>
          )}
          {/* A search that filters everything out must not fall back to the first-run state (SB-02). */}
          {grouped.length > 0 && q && !visible.length && (
            <div className="pw-sessions__empty" style={{ marginTop: 24 }}>
              <span>No sessions match “{q}”</span>
              <button className="pw-sessions__emptyAction" onClick={() => setSearch("")}>Clear search</button>
            </div>
          )}
          {grouped.map(([wsKey, list]) => {
            const ws = workspaces.find((w) => w.key === wsKey);
            if (!settings.groupByWorkspace) return <div className="pw-group" key="all">{list.map(sessionRow)}</div>;
            return (
              <div className="pw-group" key={wsKey}>
                <div className="pw-projectRow"
                  title={ws?.path ?? "sessions pi-web can see but not control"}>
                  <button
                    className="pw-projectRow__main"
                    onClick={() => {
                      // Open the files of the workspace that was clicked, not whatever the
                      // active session happens to live in (SB-08).
                      if (ws) setFilesWorkspaceKey(ws.key);
                      if (phone) { settings.set({ panel: "files" }); useUi.getState().set({ panelSheet: true, drawerOpen: false }); return; }
                      settings.set({ panel: "files" });
                    }}
                  >
                    <span className="pw-row__slot pw-row__slot--folder"><Icon name={ws ? "folder-close" : "archive-outline"} size={15} /></span>
                    <span className="pw-row__title">{ws?.label ?? basename(ws?.path ?? "Unassigned")}</span>
                    <span className="pw-row__count">{list.length || ""}</span>
                  </button>
                  <span className="pw-row__actions">
                    {ws && <Tip label="New session here"><button className="pw-iconBtn" aria-label="New session here" onClick={(e) => { e.stopPropagation(); onNewSession(ws.key); }}><Icon name="plus-outline" size={13} /></button></Tip>}
                    {ws && <ProjectMenu path={ws.path} onNew={() => onNewSession(ws.key)} onRemove={() => setConfirmRemove({ key: ws.key, path: ws.path })} onFiles={() => { setFilesWorkspaceKey(ws.key); settings.set({ panel: "files" }); }} />}
                  </span>
                </div>
                {list.map(sessionRow)}
                {!list.length && !q && (
                  <div className="pw-groupEmpty">
                    <span>No sessions here yet</span>
                    {ws && <button className="pw-sessions__emptyAction" onClick={() => onNewSession(ws.key)}>New session in {basename(ws.path)}</button>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="pw-side__foot">
        <MenuTrigger align="start" width={250} render={({ open, ref, toggle }) => (
          <button ref={ref} className="pw-side__account" aria-label="More" aria-expanded={open} onClick={toggle}>
            <span className="pw-nav__glyph"><Icon name="ellipsis-outline" size={16} /></span>
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
            panelItem("tree", "Trajectory", "workspace-tree-outline"),
            panelItem("context", "Context", "data-outline"),
          ]}
        </MenuTrigger>
      </div>

      {confirmRemove && (
        <ConfirmDialog
          title="Remove workspace from allowlist?"
          body={<span><span className="pw-mono">{confirmRemove.path}</span> will no longer be listed, and pi-web will stop reading the session files inside it. Running sessions are not interrupted.</span>}
          confirmLabel="Remove"
          danger
          onCancel={() => setConfirmRemove(null)}
          onConfirm={() => { void removeWorkspace(confirmRemove.key); setConfirmRemove(null); }}
        />
      )}
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
  // The same commands are confirmed here as in the composer; a menu row that changes the run
  // with one click is how "Compact context" got fired by accident (CTL-11).
  const [confirmCmd, setConfirmCmd] = useState<{ title: string; body: string; run: () => void } | null>(null);
  return (
    <>
    <MenuTrigger align="end" width={230} render={({ open, ref, toggle }) => (
      <button ref={ref} className="pw-iconBtn" aria-label="Session options" aria-expanded={open} onClick={(e) => { e.stopPropagation(); toggle(); }}><Icon name="ellipsis-outline" size={13} /></button>
    )}>
      {(close) => {
        const items: MenuItem[] = [];
        if (caps.rename) items.push({ kind: "item", label: "Rename…", icon: "list-pen-outline", onSelect: () => { onRename(); close(); } });
        if (caps.compact) items.push({ kind: "item", label: "Compact context", icon: "compact-outline", onSelect: () => { close(); setConfirmCmd({ title: "Compact the context now?", body: "pi will summarise the older history of this session. The full transcript on disk is not changed.", run: () => void command({ type: "compact", instructions: "" }, s.meta.sessionKey) }); } });
        if (v?.status?.mode === "managed" && caps.stopForTerminal) items.push({ kind: "item", label: "Return to terminal", icon: "right-up-outline", onSelect: () => { close(); setConfirmCmd({ title: "Return this run to a terminal?", body: "The current run is stopped so the same session can be resumed from a terminal pi.", run: () => void command({ type: "stopForTerminal", mode: "settle" }, s.meta.sessionKey) }); } });
        if (caps.abort) items.push({ kind: "item", label: "Stop run", icon: "stop-fill", danger: true, onSelect: () => { onAbort(s.meta.sessionKey); close(); } });
        if (s.meta.path) items.push({ kind: "item", label: "Copy session path", icon: "copy-outline", onSelect: () => { void copyText(s.meta.path!).then((ok) => ok ? toast.success("Copied") : toast.error("Could not copy.")); close(); } });
        if (s.meta.path) items.push({ kind: "item", label: "Download log", icon: "download-outline", onSelect: () => {
          close();
          void downloadSessionLog(s.meta.sessionKey, `pi-session-${(s.meta.piSessionId ?? s.meta.sessionKey ?? "session").slice(0, 24)}.jsonl`)
            .then((r) => { if (r.truncated) toast.error("Saved part of the log: the server sent fewer bytes than the file holds."); })
            .catch(() => toast.error("Could not download this session log."));
        } });
        items.push({ kind: "item", label: "Delete from pi-web…", icon: "trash-outline", danger: true, onSelect: () => {
          close();
          setConfirmCmd({
            title: "Remove this session from pi-web?",
            body: "The session file on disk is pi's and is never deleted: pi-web just stops listing this row. You can bring it back with `pi-web hidden` / `pi-web unhide <path>`.",
            run: () => void useStore.getState().deleteSession(s.meta.sessionKey),
          });
        } });
        if (!items.length) items.push({ kind: "item", label: "Read-only session", disabled: true, onSelect: () => undefined });
        return items;
      }}
    </MenuTrigger>
    {confirmCmd && (
      <ConfirmDialog title={confirmCmd.title} body={confirmCmd.body} confirmLabel="Continue"
        onConfirm={() => { confirmCmd.run(); setConfirmCmd(null); }} onCancel={() => setConfirmCmd(null)} />
    )}
    </>
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
        { kind: "item", label: "Copy path", icon: "copy-outline", onSelect: () => { void copyText(path).then((ok) => ok ? toast.success("Path copied") : toast.error("Could not copy — your browser blocked clipboard access.")); close(); } } as MenuItem,
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
