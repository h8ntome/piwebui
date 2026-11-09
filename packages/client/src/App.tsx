/** pi-web — app shell. Layout, colours and interaction language follow the reference
    product; every control is wired to the pi-web REST + SSE API. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore, visibleSessionKeys } from "./lib/store";
import { applySettings, useSettings, useNarrow, useTablet, useUi, trackWindowShape } from "./lib/settings";
import { Sidebar, PiMark } from "./features/Sidebar";
import { MainColumn } from "./features/MainColumn";
import { RightPanel } from "./features/RightPanel";
import { SettingsDialog } from "./features/SettingsDialog";
import { DirectoryPicker, PromptDialog } from "./features/DirectoryPicker";
import { Toasts, toast } from "./ui/Toast";
import { Icon } from "./lib/icons";
import { basename } from "./lib/format";

function BootScreen({ error, onRetry, attempts }: { error: string; onRetry: () => void; attempts: number }) {
  return (
    <div className="pw-boot">
      <div className="pw-boot__card">
        <span style={{ color: "var(--dsw-alias-label-primary)" }}><PiMark size={34} /></span>
        <div className="pw-boot__wordmark">pi WEB</div>
        <div className="pw-boot__hint">Cannot reach the pi-web server. Start it with <span className="pw-mono">pi-web</span> and this page retries by itself.</div>
        {/* The two things you need when it is stuck: which address, and whether we are still trying (GEN-01/SRV-08). */}
        <div className="pw-boot__hint pw-boot__hint--meta">
          <span className="pw-mono">{window.location.origin}</span>
          {attempts > 1 ? <span> · retry #{attempts}</span> : <span> · retrying every 3 s</span>}
        </div>
        <details className="pw-boot__details">
          <summary>Technical detail</summary>
          <div className="pw-boot__error">{error}</div>
        </details>
        <button className="pw-btn pw-btn--primary pw-btn--sm" onClick={onRetry}>Retry</button>
      </div>
    </div>
  );
}

export function App() {
  const { ready, error, bootAttempts, serverDown, boot, activeKey, views, refreshSessions, createSession, openSession, addWorkspace, workspaces, command } = useStore();
  const sessionCount = useStore((st) => st.sessions.length);
  const settings = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [picker, setPicker] = useState<{ open: boolean } | null>(null);
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const mounted = useRef(false);
  const { phone, drawerOpen, panelSheet } = useUi();

  // Window shape: phones get a drawer plus a sheet they open deliberately, tablets keep a
  // compact labelled rail, and the side panel never gets to squeeze a small viewport.
  const narrow = useNarrow();
  const tablet = useTablet();
  const collapsed = !phone && !tablet && (settings.sidebarCollapsed || narrow);
  const showPanel = phone ? panelSheet : (!!settings.panel && !narrow);
  const sidebarW = phone ? "0px" : collapsed ? "56px" : tablet ? "208px" : "280px";

  // theme + font tokens
  useEffect(() => {
    applySettings(settings);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const on = () => applySettings(useSettings.getState());
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [settings.theme, settings.contentFontSize, settings.codeFontSize, settings.panelWidth]);

  useEffect(() => trackWindowShape(), []);

  useEffect(() => {
    // Real input-modality detection: touch is touch, not "keyboard", and settings changes
    // must not stamp it back to "pointer" (THEM-01, MOB-03, A11Y-03).
    const root = document.documentElement;
    if (!root.dataset.inputModality) {
      root.dataset.inputModality = window.matchMedia("(pointer: coarse)").matches && !window.matchMedia("(pointer: fine)").matches ? "touch" : "pointer";
    }
    const onPointer = (e: PointerEvent) => {
      root.dataset.inputModality = e.pointerType === "mouse" ? "pointer" : e.pointerType === "touch" || e.pointerType === "pen" ? "touch" : "keyboard";
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Tab" || e.key.startsWith("Arrow")) root.dataset.inputModality = "keyboard";
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, []);

  useEffect(() => { void boot(); }, [boot]);

  useEffect(() => {
    // While the app is up, one health call every 10 s makes a restarted or killed server visible
    // instead of leaving a confidently stale tab (SRV-05). Paused while a live stream is running,
    // because that stream already reports its own silence.
    if (!ready) return;
    const t = window.setInterval(() => {
      const st = useStore.getState();
      const k = st.activeKey;
      if (k && st.views[k]?.sse === "live") return;
      void st.pingServer();
    }, 10_000);
    return () => window.clearInterval(t);
  }, [ready]);

  // Retry contact with the server when it is not answering (restart, port change).
  useEffect(() => {
    if (!error) return;
    const t = window.setInterval(() => void boot(), 3000);
    return () => window.clearInterval(t);
  }, [error, boot]);

  // Refresh the session list periodically so terminal sessions and names appear.
  useEffect(() => {
    if (!ready) return;
    const t = window.setInterval(() => void refreshSessions().catch(() => undefined), 20_000);
    return () => window.clearInterval(t);
  }, [ready, refreshSessions]);

  // Restore the last open session once the list has actually arrived.
  useEffect(() => {
    if (!ready || mounted.current) return;
    const { sessions } = useStore.getState();
    if (!sessions.length) return;
    mounted.current = true;
    const last = settings.lastSessionKey;
    const pick = last && sessions.some((s) => s.meta.sessionKey === last) ? last : null;
    if (pick) void openSession(pick);
  }, [ready, openSession, settings.lastSessionKey, sessionCount]);

  useEffect(() => {
    if (activeKey) settings.set({ lastSessionKey: activeKey });
    if (useUi.getState().phone) useUi.getState().set({ drawerOpen: false });
  }, [activeKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const newSession = useCallback(async (workspaceKey: string) => {
    const key = await createSession(workspaceKey);
    if (key) await openSession(key);
  }, [createSession, openSession]);

  const v = activeKey ? views[activeKey] : undefined;

  // Global shortcuts (all of them do something real).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === "F2" && activeKey) { e.preventDefault(); setRenameKey(activeKey); return; }
      if (!mod) {
        if (e.altKey && e.key === "ArrowDown") {
          e.preventDefault();
          stepSession(1);
        } else if (e.altKey && e.key === "ArrowUp") {
          e.preventDefault();
          stepSession(-1);
        }
        return;
      }
      const k = e.key.toLowerCase();
      if (k === "k") {
        e.preventDefault();
        const ta = document.querySelector<HTMLTextAreaElement>(".pw-composer__input");
        if (ta && !ta.disabled) ta.focus();
        else toast.info("This session is read-only — there is nothing to type into.");
      } else if (k === "b") {
        e.preventDefault();
        if (useUi.getState().phone) useUi.getState().set({ drawerOpen: !useUi.getState().drawerOpen });
        else settings.set({ sidebarCollapsed: !useSettings.getState().sidebarCollapsed });
      } else if (k === "n") {
        e.preventDefault();
        const ws = useStore.getState().heroWorkspace ?? useStore.getState().workspaces[0]?.key;
        if (ws) void newSession(ws); else toast.warn("Add a workspace folder first");
      } else if (k === ".") {
        e.preventDefault();
        if (v?.runtime?.isStreaming) void command({ type: "abort" });
      } else if (k === ",") {
        e.preventDefault();
        setSettingsOpen(true);
      } else if (k === "r") {
        // Ctrl/Cmd+R belongs to the browser (reload); stealing it made the app un-reloadable (CTL-12).
        // Rename lives on F2 instead, and is listed in Settings ▸ Keyboard.
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settings, newSession, command, v?.runtime?.isStreaming, activeKey]);

  if (!ready) {
    if (error) return <><BootScreen error={error} attempts={bootAttempts} onRetry={() => void boot()} /><Toasts /></>;
    return (
      <div className="pw-boot">
        <div className="pw-boot__card">
          <span className="pw-spinner" />
          <div className="pw-boot__hint">Connecting to pi-web…</div>
          {/* Say which address is being tried: that is the first thing to check when it hangs. */}
          <div className="pw-boot__hint pw-boot__hint--meta"><span className="pw-mono">{window.location.origin}</span></div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="pw-frame" data-animating="true" data-sidebar-collapsed={collapsed || undefined} data-sidebar-tablet={tablet && !phone || undefined} data-phone={phone || undefined} data-drawer-open={phone && drawerOpen || undefined} data-panel-sheet={phone && showPanel || undefined} style={{ ["--pw-sidebar-w" as string]: sidebarW, ["--pw-right-w" as string]: showPanel ? `min(${settings.panelWidth}px, calc(100vw - 32px))` : "0px" }}>
        {phone && drawerOpen && (
          <div className="pw-drawerScrim" aria-hidden="true" onClick={() => useUi.getState().set({ drawerOpen: false })} />
        )}
        <div className="pw-sidebarCol">
          <Sidebar
            onAddWorkspace={() => setPicker({ open: true })}
            onOpenSettings={() => setSettingsOpen(true)}
            onNewSession={(ws) => void newSession(ws)}
            onRequestRename={(key) => setRenameKey(key)}
          />
        </div>
        <main className="pw-centerCol">
          <MainColumn onAddWorkspace={() => setPicker({ open: true })} onRequestRename={(key) => key && setRenameKey(key)} />
        </main>
        {showPanel && (
          <aside className="pw-rightCol" aria-label="Session panels">
            {!phone && <PanelResizer value={settings.panelWidth} onChange={(w) => settings.set({ panelWidth: w })} />}
            <RightPanel v={v ?? null} keyName={activeKey} />
          </aside>
        )}
      </div>

      {v && v.sse === "closed" && (
        <div className="pw-statusPill" role="status" aria-live="polite">
          <span className="pw-indicator pw-indicator--warning"><Icon name="warning-outline" size={13} /> stream disconnected — reconnecting</span>
        </div>
      )}
      {serverDown && (
        <div className="pw-statusPill" role="status" aria-live="polite">
          <span className="pw-indicator pw-indicator--error">
            <Icon name="warning-outline" size={13} /> cannot reach pi-web at {location.host} — retrying
          </span>
        </div>
      )}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {picker?.open && (
        <DirectoryPicker
          onClose={() => setPicker(null)}
          onPick={async (path) => {
            const key = await addWorkspace(path, basename(path));
            setPicker(null);
            if (key) {
              // A workspace with no sessions still has to be usable from the toast (WS-01).
              toast.warn(`Workspace ${basename(path)} added · ${path}`, { label: "New session here", run: () => void newSession(key) });
            }
          }}
        />
      )}
      {renameKey && (
        <PromptDialog
          title="Rename session"
          label="Session name"
          hint={renameInitialHint(views[renameKey])}
          initial={renameInitial(views[renameKey])}
          placeholder={renamePlaceholder(views[renameKey])}
          onClose={() => setRenameKey(null)}
          onConfirm={async (value) => {
            await command({ type: "rename", name: value }, renameKey);
            setRenameKey(null);
            toast.success("Session renamed");
          }}
        />
      )}
      <Toasts />
    </>
  );
}

/** What the header currently shows is what the rename field should start with (CTL-06). */
function renameInitial(v?: { runtime?: { sessionName?: string | null } | null; meta?: { name?: string | null; firstPrompt?: string | null; cwd?: string | null } | null }): string {
  return (v?.runtime?.sessionName ?? v?.meta?.name?.trim() ?? "") || "";
}

/** What the sidebar/header shows right now, shown as the placeholder so the field is never a
   blank mystery for sessions that are titled by their first message (CTL-06). */
function renamePlaceholder(v?: { runtime?: { sessionName?: string | null } | null; meta?: { name?: string | null; firstPrompt?: string | null; cwd?: string | null } | null }): string | undefined {
  if (renameInitial(v)) return undefined;
  const derived = v?.meta?.firstPrompt?.trim();
  return derived ? (derived.length > 60 ? derived.slice(0, 57) + "..." : derived) : "name this session";
}

function renameInitialHint(v?: { runtime?: { sessionName?: string | null } | null; meta?: { name?: string | null; firstPrompt?: string | null } | null }): string | undefined {
  if (v?.runtime?.sessionName || v?.meta?.name?.trim()) return undefined;
  if (v?.meta?.firstPrompt) return "The title you see now comes from your first message. Naming it here replaces that.";
  return "This session has no title yet.";
}

/** Drag the panel edge instead of walking a stepper 17 times (PNL-06). */
function PanelResizer({ value, onChange }: { value: number; onChange: (w: number) => void }) {
  const clamp = (w: number) => Math.max(280, Math.min(720, Math.round(w)));
  const start = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => onChange(clamp(window.innerWidth - ev.clientX));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  return (
    <div
      className="pw-panelResize"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the session panel"
      aria-valuenow={value}
      tabIndex={0}
      onPointerDown={start}
      onKeyDown={(e) => {
        if (e.key === "ArrowLeft") { e.preventDefault(); onChange(clamp(value + 20)); }
        if (e.key === "ArrowRight") { e.preventDefault(); onChange(clamp(value - 20)); }
      }}
    />
  );
}

function stepSession(delta: number) {
  const { sessions, activeKey, openSession } = useStore.getState();
  // Walk what the user can actually see (search + filters applied), not the raw list (SB-09).
  const order = visibleSessionKeys.length ? visibleSessionKeys : sessions.map((s) => s.meta.sessionKey);
  if (!order.length) return;
  const i = order.indexOf(activeKey ?? "");
  const next = order[Math.max(0, Math.min(order.length - 1, (i < 0 ? 0 : i) + delta))];
  if (next) void openSession(next);
}
