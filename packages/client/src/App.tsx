/** pi-web — app shell. Layout, colours and interaction language follow the reference
    product; every control is wired to the pi-web REST + SSE API. */
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "./lib/store";
import { applySettings, useSettings, useNarrow, useUi, trackWindowShape } from "./lib/settings";
import { Sidebar, PiMark } from "./features/Sidebar";
import { MainColumn } from "./features/MainColumn";
import { RightPanel } from "./features/RightPanel";
import { SettingsDialog } from "./features/SettingsDialog";
import { DirectoryPicker, PromptDialog } from "./features/DirectoryPicker";
import { Toasts, toast } from "./ui/Toast";
import { Icon } from "./lib/icons";

function BootScreen({ error, onRetry }: { error: string; onRetry: () => void }) {
  return (
    <div className="pw-boot">
      <div className="pw-boot__card">
        <span style={{ color: "var(--dsw-alias-label-primary)" }}><PiMark size={34} /></span>
        <div className="pw-boot__wordmark">pi WEB</div>
        <div className="pw-boot__hint">Cannot reach the pi-web server. Start it with <span className="pw-mono">pi-web</span> and this page retries by itself.</div>
        <div className="pw-boot__error">{error}</div>
        <button className="pw-btn pw-btn--primary pw-btn--sm" onClick={onRetry}>Retry</button>
      </div>
    </div>
  );
}

export function App() {
  const { ready, error, boot, activeKey, views, refreshSessions, createSession, openSession, addWorkspace, workspaces, command } = useStore();
  const sessionCount = useStore((st) => st.sessions.length);
  const settings = useSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [picker, setPicker] = useState<{ open: boolean } | null>(null);
  const [renameKey, setRenameKey] = useState<string | null>(null);
  const mounted = useRef(false);
  const { phone, drawerOpen } = useUi();

  // Narrow windows get the collapsed rail and no side panel; phones get a drawer instead.
  const narrow = useNarrow();
  const collapsed = !phone && (settings.sidebarCollapsed || narrow);
  const showPanel = !!settings.panel && (!narrow || phone);

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
    document.documentElement.dataset.inputModality = "pointer";
    const onPointer = (e: PointerEvent) => {
      const k = e.pointerType === "mouse" ? "pointer" : "keyboard";
      document.documentElement.dataset.inputModality = k;
    };
    window.addEventListener("pointerdown", onPointer, true);
    return () => window.removeEventListener("pointerdown", onPointer, true);
  }, []);

  useEffect(() => { void boot(); }, [boot]);

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
        document.querySelector<HTMLTextAreaElement>(".pw-composer__input")?.focus();
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
        e.preventDefault();
        if (activeKey) setRenameKey(activeKey);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [settings, newSession, command, v?.runtime?.isStreaming, activeKey]);

  if (!ready) {
    if (error) return <><BootScreen error={error} onRetry={() => void boot()} /><Toasts /></>;
    return (
      <div className="pw-boot">
        <div className="pw-boot__card">
          <span className="pw-spinner" />
          <div className="pw-boot__hint">Connecting to pi-web…</div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="pw-frame" data-animating="true" data-sidebar-collapsed={collapsed || undefined} data-phone={phone || undefined} data-drawer-open={phone && drawerOpen || undefined} style={{ ["--pw-sidebar-w" as string]: phone ? "0px" : collapsed ? "56px" : "280px", ["--pw-right-w" as string]: showPanel ? `${settings.panelWidth}px` : "0px" }}>
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
        <div className="pw-centerCol">
          <MainColumn onAddWorkspace={() => setPicker({ open: true })} onRequestRename={(key) => key && setRenameKey(key)} />
        </div>
        {showPanel && (
          <div className="pw-rightCol">
            <RightPanel v={v ?? null} keyName={activeKey} />
          </div>
        )}
      </div>

      {v && v.sse === "closed" && (
        <div style={{ position: "fixed", bottom: 12, left: "50%", transform: "translateX(-50%)", zIndex: 900 }}>
          <span className="pw-indicator pw-indicator--warning"><Icon name="warning-outline" size={13} /> stream disconnected — reconnecting</span>
        </div>
      )}

      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
      {picker?.open && (
        <DirectoryPicker
          onClose={() => setPicker(null)}
          onPick={async (path) => {
            const key = await addWorkspace(path, basenameOf(path));
            setPicker(null);
            if (key) toast.success(`Workspace ${basenameOf(path)} added`);
          }}
        />
      )}
      {renameKey && (
        <PromptDialog
          title="Rename session"
          label="Session name"
          initial={views[renameKey]?.runtime?.sessionName ?? views[renameKey]?.meta?.name ?? ""}
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

function basenameOf(p: string) {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function stepSession(delta: number) {
  const { sessions, activeKey, openSession } = useStore.getState();
  if (!sessions.length) return;
  const i = sessions.findIndex((s) => s.meta.sessionKey === activeKey);
  const next = sessions[Math.max(0, Math.min(sessions.length - 1, (i < 0 ? 0 : i) + delta))];
  if (next) void openSession(next.meta.sessionKey);
}
