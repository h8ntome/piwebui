/** Settings: everything here changes real behaviour, and About reports the live server. */
import { useEffect, useState } from "react";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../lib/icons";
import { FloatingMenu, type MenuItem } from "../ui/Menu";
import { useSettings, type ThemeChoice } from "../lib/settings";
import { api } from "../lib/api";
import { useStore } from "../lib/store";

type Tab = "appearance" | "sidebar" | "transcript" | "shortcuts" | "about";

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: "appearance", label: "Appearance", icon: "dark-outline" },
  { id: "sidebar", label: "Sidebar", icon: "panel-left-outline" },
  { id: "transcript", label: "Transcript", icon: "list-pen-outline" },
  { id: "shortcuts", label: "Keyboard", icon: "code-outline" },
  { id: "about", label: "About", icon: "info-outline" },
];

function Row({ title, desc, children }: { title: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="pw-row">
      <div className="pw-row__text">
        <div className="pw-row__title">{title}</div>
        {desc && <div className="pw-row__desc">{desc}</div>}
      </div>
      <div className="pw-row__control">{children}</div>
    </div>
  );
}

function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button className="pw-switch" role="switch" aria-checked={checked} aria-label={label} onClick={() => onChange(!checked)}><span className="pw-switch__thumb" /></button>;
}

function Choice({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (v: string) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const items: MenuItem[] = options.map((o) => ({
    kind: "item", label: o.label, selected: o.value === value,
    onSelect: () => { onChange(o.value); setAnchor(null); },
  }));
  return (
    <>
      <button className="pw-selector" onClick={(e) => setAnchor(e.currentTarget)} aria-expanded={!!anchor}>
        {options.find((o) => o.value === value)?.label ?? value}
        <Icon name="chevron-down-outline" size={13} style={{ color: "var(--dsw-alias-label-caption)" }} />
      </button>
      {anchor && <FloatingMenu anchor={anchor} align="end" width={180} items={items} onClose={() => setAnchor(null)} />}
    </>
  );
}

function Stepper({ value, min, max, step = 1, unit, onChange }: { value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  return (
    <span className="pw-stepper">
      <span style={{ padding: "0 8px" }}>{value}{unit}</span>
      <span style={{ display: "flex", flexDirection: "column", gap: 2, paddingRight: 6 }}>
        <button aria-label="Increase" disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))} style={{ height: 12 }}><Icon name="chevron-up-outline" size={9} /></button>
        <button aria-label="Decrease" disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))} style={{ height: 12 }}><Icon name="chevron-down-outline" size={9} /></button>
      </span>
    </span>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Enter", "Send the message"],
  ["Shift+Enter", "Insert a newline"],
  ["Ctrl/⌘ + K", "Focus the composer"],
  ["Ctrl/⌘ + B", "Collapse or expand the sidebar"],
  ["Ctrl/⌘ + N", "New session in the current workspace"],
  ["Ctrl/⌘ + .", "Stop the current run"],
  ["Esc", "Close the open menu or dialog"],
  ["Alt + ↑ / ↓", "Previous / next session"],
];

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const health = useStore((st) => st.health);
  const [tab, setTab] = useState<Tab>("appearance");
  const [meta, setMeta] = useState<{ limits?: Record<string, number>; protocolVersion?: number } | null>(null);
  const [caps, setCaps] = useState<{ pi: { version: string | null; tested: boolean }; server: string[] } | null>(null);

  useEffect(() => {
    void api.get("/api/v1/meta").then((m) => setMeta(m as never)).catch(() => undefined);
    void api.get("/api/v1/capabilities").then((c) => setCaps(c as never)).catch(() => undefined);
  }, []);

  return (
    <Dialog title="Settings" onClose={onClose} size="wide">
      <div className="pw-settings">
        <nav className="pw-settings__nav" aria-label="Settings sections">
          {TABS.map((t) => (
            <button key={t.id} className="pw-nav__row" style={{ minHeight: 32, padding: "5px 8px" }} aria-current={tab === t.id} onClick={() => setTab(t.id)}>
              <span className="pw-nav__glyph"><Icon name={t.icon} size={15} /></span>
              <span className="pw-nav__title">{t.label}</span>
            </button>
          ))}
        </nav>
        <div className="pw-settings__pane">
          {tab === "appearance" && (
            <>
              <Row title="Theme" desc="Follow the system, or pin light or dark.">
                <Choice
                  value={s.theme}
                  onChange={(v) => s.set({ theme: v as ThemeChoice })}
                  options={[{ value: "system", label: "Follow system" }, { value: "light", label: "Light" }, { value: "dark", label: "Dark" }]}
                />
              </Row>
              <Row title="Content size" desc="Message and composer text size.">
                <Stepper value={s.contentFontSize} min={12} max={20} unit="px" onChange={(v) => s.set({ contentFontSize: v })} />
              </Row>
              <Row title="Code size" desc="Code blocks and tool output.">
                <Stepper value={s.codeFontSize} min={9} max={16} unit="px" onChange={(v) => s.set({ codeFontSize: v })} />
              </Row>
              <Row title="Right panel width" desc="Width of the session, files and context panel.">
                <Stepper value={s.panelWidth} min={280} max={720} step={20} unit="px" onChange={(v) => s.set({ panelWidth: v })} />
              </Row>
            </>
          )}
          {tab === "sidebar" && (
            <>
              <Row title="Group sessions by workspace" desc="Off lists every session in one flat list.">
                <Toggle label="Group by workspace" checked={s.groupByWorkspace} onChange={(v) => s.set({ groupByWorkspace: v })} />
              </Row>
              <Row title="Show read-only sessions" desc="Terminal sessions pi-web can read but not control (mirror/history).">
                <Toggle label="Show read-only sessions" checked={s.showReadOnly} onChange={(v) => s.set({ showReadOnly: v })} />
              </Row>
              <Row title="Collapsed sidebar" desc="Keep only the icon rail visible.">
                <Toggle label="Collapsed sidebar" checked={s.sidebarCollapsed} onChange={(v) => s.set({ sidebarCollapsed: v })} />
              </Row>
            </>
          )}
          {tab === "transcript" && (
            <>
              <Row title="Show timestamps" desc="Time under each message.">
                <Toggle label="Show timestamps" checked={s.showTimestamps} onChange={(v) => s.set({ showTimestamps: v })} />
              </Row>
              <Row title="Reveal row actions on hover" desc="Copy buttons appear when you point at a message.">
                <Toggle label="Reveal actions on hover" checked={s.revealActionsOnHover} onChange={(v) => s.set({ revealActionsOnHover: v })} />
              </Row>
              <Row title="Follow the stream" desc="Keep the transcript pinned to the newest content while pi works.">
                <Toggle label="Auto-scroll" checked={s.autoScroll} onChange={(v) => s.set({ autoScroll: v })} />
              </Row>
              <Row title="Enter sends" desc="Off: Enter inserts a newline and Shift+Enter sends.">
                <Toggle label="Enter sends" checked={s.sendOnEnter} onChange={(v) => s.set({ sendOnEnter: v })} />
              </Row>
            </>
          )}
          {tab === "shortcuts" && (
            <div style={{ paddingBottom: 24 }}>
              <dl className="pw-kv">
                {SHORTCUTS.map(([k, v]) => (<div key={k} style={{ display: "contents" }}><dt><span className="pw-key">{k}</span></dt><dd style={{ color: "var(--dsw-alias-label-secondary)" }}>{v}</dd></div>))}
              </dl>
            </div>
          )}
          {tab === "about" && (
            <div style={{ paddingBottom: 24 }}>
              <dl className="pw-kv">
                <dt>pi-web</dt><dd>{health?.version ?? "—"}</dd>
                <dt>Pi adapter</dt><dd>{health?.pi?.resolvedVersion ?? "not resolved"}{health?.pi?.tested ? " · tested" : " · untested"}</dd>
                <dt>Protocol</dt><dd>{meta?.protocolVersion ?? 1}</dd>
                <dt>Managed runtimes</dt><dd>{health ? `${health.managed.active} / ${health.managed.limit}` : "—"}</dd>
                <dt>Workspaces</dt><dd>{useStore.getState().workspaces.length} allowlisted</dd>
                <dt>Sessions visible</dt><dd>{useStore.getState().sessions.length}</dd>
                <dt>Server features</dt><dd>{caps?.server?.join(", ") ?? "—"}</dd>
                <dt>Limits</dt><dd>{meta?.limits ? `${meta.limits.entriesPageMax ?? "?"} entries/page · ${Math.round((meta.limits.sseMaxBytes ?? 0) / 65536)} KB stream buffer` : "—"}</dd>
              </dl>
              <div className="pw-row__desc" style={{ marginTop: 16 }}>
                Styling reuses the reference product&rsquo;s MIT-licensed design tokens, icon set and Montserrat font;
                functionality is wired to the pi-web REST + SSE API.
              </div>
              <div style={{ marginTop: 16 }}>
                <button className="pw-btn pw-btn--sm pw-btn--outline" onClick={() => { s.reset(); window.location.reload(); }}>Reset interface settings</button>
              </div>
            </div>
          )}
        </div>
      </div>
    </Dialog>
  );
}
