/** Settings: everything here changes real behaviour, and About reports the live server. */
import { useEffect, useRef, useState } from "react";
import { Dialog, ConfirmDialog } from "../ui/Dialog";
import { Icon } from "../lib/icons";
import { FloatingMenu, type MenuItem } from "../ui/Menu";
import { useSettings, type ThemeChoice } from "../lib/settings";
import { shortcutRows } from "../lib/shortcuts";
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
    kind: "item", label: o.label, selected: o.value === value, role: "menuitemradio",
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

/**
 * Stepper with direct text entry: reaching 720 px from 380 with 20 px steps used to cost 17
 * clicks (SET-05). Input is clamped on blur/Enter and accepts a bare number.
 */
function Stepper({ value, min, max, step = 1, unit, onChange }: { value: number; min: number; max: number; step?: number; unit?: string; onChange: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  const commit = () => {
    if (draft === null) return;
    const n = Number.parseInt(draft.replace(/[^\d]/g, ""), 10);
    onChange(Number.isFinite(n) ? clamp(n) : value);
    setDraft(null);
  };
  return (
    <span className="pw-stepper">
      <input
        className="pw-stepper__input"
        inputMode="numeric"
        aria-label={`Value in ${unit ?? "units"} (between ${min} and ${max})`}
        value={draft ?? `${value}${unit ?? ""}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") { e.preventDefault(); commit(); }
          if (e.key === "ArrowUp") { e.preventDefault(); onChange(clamp((draft !== null ? Number.parseInt(draft.replace(/[^\d]/g, ""), 10) : value) + step)); }
          if (e.key === "ArrowDown") { e.preventDefault(); onChange(clamp((draft !== null ? Number.parseInt(draft.replace(/[^\d]/g, ""), 10) : value) - step)); }
        }}
      />
      <span style={{ display: "flex", flexDirection: "column", gap: 2, paddingRight: 6 }}>
        <button aria-label="Increase" disabled={value >= max} onClick={() => onChange(clamp(value + step))} style={{ height: 12 }}><Icon name="chevron-up-outline" size={9} /></button>
        <button aria-label="Decrease" disabled={value <= min} onClick={() => onChange(clamp(value - step))} style={{ height: 12 }}><Icon name="chevron-down-outline" size={9} /></button>
      </span>
    </span>
  );
}

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const s = useSettings();
  const health = useStore((st) => st.health);
  const workspaces = useStore((st) => st.workspaces);
  const sessions = useStore((st) => st.sessions);
  const [tab, setTab] = useState<Tab>("appearance");
  const [meta, setMeta] = useState<{ limits?: Record<string, number>; protocolVersion?: number } | null>(null);
  const [caps, setCaps] = useState<{ pi: { version: string | null; tested: boolean }; server: string[] } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [filter, setFilter] = useState("");
  const navRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void api.get("/api/v1/meta").then((m) => setMeta(m as never)).catch(() => undefined);
    void api.get("/api/v1/capabilities").then((c) => setCaps(c as never)).catch(() => undefined);
  }, []);

  // Arrow keys walk the section rail, and only the active item claims aria-current (SET-07).
  const moveTab = (delta: number) => {
    const i = TABS.findIndex((t) => t.id === tab);
    const next = TABS[(i + delta + TABS.length) % TABS.length]!;
    setTab(next.id);
    window.requestAnimationFrame(() => {
      navRef.current?.querySelectorAll<HTMLButtonElement>("button")[TABS.indexOf(next)]?.focus();
    });
  };

  const rows = shortcutRows().filter((r) => !filter || `${r.keys} ${r.label}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <Dialog title="Settings" onClose={onClose} size="wide">
      <div className="pw-settings">
        <nav className="pw-settings__nav" aria-label="Settings sections" ref={navRef}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); moveTab(1); }
            else if (e.key === "ArrowUp") { e.preventDefault(); moveTab(-1); }
          }}>
          {TABS.map((t) => (
            <button key={t.id} className={`pw-nav__row${tab === t.id ? " pw-nav__row--active" : ""}`} style={{ minHeight: 32, padding: "5px 8px" }} aria-current={tab === t.id ? "page" : undefined} onClick={() => setTab(t.id)}>
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
              <Row title="Right panel width" desc="Width of the session, files and context panel. Drag the panel edge to set it too.">
                <Stepper value={s.panelWidth} min={280} max={720} step={20} unit="px" onChange={(v) => s.set({ panelWidth: v })} />
              </Row>
            </>
          )}
          {tab === "sidebar" && (
            <>
              <Row title="Group sessions by workspace" desc="Off lists every session in one flat list.">
                <Toggle label="Group by workspace" checked={s.groupByWorkspace} onChange={(v) => s.set({ groupByWorkspace: v })} />
              </Row>
              <Row title="Show read-only sessions" desc="Terminal sessions pi-web can read but not control.">
                <Toggle label="Show read-only sessions" checked={s.showReadOnly} onChange={(v) => s.set({ showReadOnly: v })} />
              </Row>
              <Row title="Collapsed sidebar" desc="Keep only the icon rail visible.">
                <Toggle label="Collapsed sidebar" checked={s.sidebarCollapsed} onChange={(v) => s.set({ sidebarCollapsed: v })} />
              </Row>
            </>
          )}
          {tab === "transcript" && (
            <>
              <Row title="Show timestamps" desc="Time under each message, always visible.">
                <Toggle label="Show timestamps" checked={s.showTimestamps} onChange={(v) => s.set({ showTimestamps: v })} />
              </Row>
              <Row title="Reveal row actions on hover" desc="Copy buttons appear when you point at a message. Off keeps them always visible.">
                <Toggle label="Reveal actions on hover" checked={s.revealActionsOnHover} onChange={(v) => s.set({ revealActionsOnHover: v })} />
              </Row>
              <Row title="Follow the stream" desc="Keep the transcript pinned to the newest content while pi works.">
                <Toggle label="Auto-scroll" checked={s.autoScroll} onChange={(v) => s.set({ autoScroll: v })} />
              </Row>
              <Row title="Enter sends" desc={s.sendOnEnter ? "Off: Enter inserts a newline and Shift+Enter sends." : "On: Enter sends, Shift+Enter inserts a newline."}>
                <Toggle label="Enter sends" checked={s.sendOnEnter} onChange={(v) => s.set({ sendOnEnter: v })} />
              </Row>
            </>
          )}
          {tab === "shortcuts" && (
            <div style={{ paddingBottom: 24 }}>
              <input
                className="pw-input"
                style={{ marginBottom: 10, height: 30 }}
                placeholder="Filter shortcuts"
                aria-label="Filter shortcuts"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
              <dl className="pw-kv">
                {rows.map((r) => (<div key={`${r.keys}-${r.label}`} style={{ display: "contents" }}><dt><span className="pw-key">{r.keys}</span></dt><dd style={{ color: "var(--dsw-alias-label-secondary)" }}>{r.label}</dd></div>))}
                {!rows.length && <div className="pw-row__desc">No shortcut matches “{filter}”.</div>}
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
                <dt>Workspaces</dt><dd>{workspaces.length} allowlisted</dd>
                <dt>Sessions visible</dt><dd>{sessions.length}</dd>
                <dt>Server features</dt><dd>{caps?.server?.join(", ") ?? "—"}</dd>
                {/* Say what the server actually pages at, not the maximum it would accept (SET-06 / SRV-03). */}
                <dt>Page sizes</dt><dd>{meta?.limits ? `${meta.limits.entriesPageDefault ?? "?"} entries per request · ${meta.limits.snapshotEntries ?? "?"} per stream snapshot · max ${meta.limits.entriesPageMax ?? "?"} · ${Math.round((meta.limits.sseMaxBytes ?? 0) / 65536)} KB stream buffer` : "—"}</dd>
              </dl>
              <div className="pw-row__desc" style={{ marginTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
                <a className="pw-link" href="https://github.com/h8ntome/piwebui" target="_blank" rel="noopener noreferrer">Repository</a>
                <a className="pw-link" href="https://github.com/h8ntome/piwebui/blob/main/README.md" target="_blank" rel="noopener noreferrer">Documentation</a>
                <a className="pw-link" href="https://github.com/h8ntome/piwebui/blob/main/SECURITY.md" target="_blank" rel="noopener noreferrer">Security</a>
                <a className="pw-link" href="https://github.com/h8ntome/piwebui/blob/main/LICENSE" target="_blank" rel="noopener noreferrer">MIT licence</a>
              </div>
              <div className="pw-row__desc" style={{ marginTop: 12 }}>
                Styling reuses the reference product&rsquo;s MIT-licensed design tokens, icon set and Montserrat font;
                functionality is wired to the pi-web REST + SSE API.
              </div>
              <div style={{ marginTop: 16 }}>
                <button className="pw-btn pw-btn--sm pw-btn--outline" onClick={() => setConfirmReset(true)}>Reset interface settings</button>
              </div>
            </div>
          )}
        </div>
      </div>
      {confirmReset && (
        <ConfirmDialog
          title="Reset interface settings?"
          body="Theme, font sizes, panel choice and view options go back to their defaults, and the page reloads. Your sessions and workspaces are untouched."
          confirmLabel="Reset and reload"
          onConfirm={() => { s.reset(); window.location.reload(); }}
          onCancel={() => setConfirmReset(false)}
        />
      )}
    </Dialog>
  );
}
