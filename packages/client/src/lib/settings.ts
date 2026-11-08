/** Persisted UI settings. Every field here drives real behaviour; nothing is decorative.
    Stored in localStorage under one key so the settings dialog can reset it wholesale. */
import { useSyncExternalStore } from "react";
import { create } from "zustand";

export type ThemeChoice = "system" | "light" | "dark";
export type PanelTab = "session" | "files" | "tree" | "context";

export interface Settings {
  theme: ThemeChoice;
  /** 12..20 px, applied as --dsh-content-font-size (the reference token). */
  contentFontSize: number;
  /** 10..16 px, applied as --dsh-code-font-size. */
  codeFontSize: number;
  sidebarCollapsed: boolean;
  /** Right-hand panel: which tab is open; null means closed. */
  panel: PanelTab | null;
  panelWidth: number;
  /** Sidebar groups sessions by workspace (reference "WorkSpace" grouping). */
  groupByWorkspace: boolean;
  /** Show mirror/history (read-only) sessions in the list. */
  showReadOnly: boolean;
  showTimestamps: boolean;
  /** Reveal the row action buttons only on hover (reference behaviour). */
  revealActionsOnHover: boolean;
  /** Stick the transcript to the bottom while the model streams. */
  autoScroll: boolean;
  sendOnEnter: boolean;
  lastSessionKey: string | null;
}

const KEY = "piweb:settings:v1";

const DEFAULTS: Settings = {
  theme: "system",
  contentFontSize: 14,
  codeFontSize: 11,
  sidebarCollapsed: false,
  panel: null,
  panelWidth: 380,
  groupByWorkspace: true,
  showReadOnly: true,
  showTimestamps: true,
  revealActionsOnHover: true,
  autoScroll: true,
  sendOnEnter: true,
  lastSessionKey: null,
};

function load(): Settings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULTS };
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch { return { ...DEFAULTS }; }
}

interface SettingsStore extends Settings {
  set: (patch: Partial<Settings>) => void;
  reset: () => void;
}

export const useSettings = create<SettingsStore>((set, get) => ({
  ...load(),
  set: (patch) => set((s) => {
    const next = { ...s, ...patch };
    try { localStorage.setItem(KEY, JSON.stringify(next)); } catch { /* private mode */ }
    return patch;
  }),
  reset: () => {
    // "Reset interface settings" means appearance, not "lose my place" (SET-02): the open
    // session survives so a mis-click does not dump you back on the hero.
    const keep = { lastSessionKey: get().lastSessionKey };
    try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    set({ ...DEFAULTS, ...keep });
    try { localStorage.setItem(KEY, JSON.stringify({ ...DEFAULTS, ...keep })); } catch { /* ignore */ }
  },
}));

/** Apply the theme + font-size settings to the document (reference token names). */
export function applySettings(s: Settings): void {
  const dark = s.theme === "dark" || (s.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.body.toggleAttribute("data-ds-dark-theme", dark);
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
  document.documentElement.style.setProperty("--dsh-content-font-size", `${s.contentFontSize}px`);
  document.documentElement.style.setProperty("--dsh-code-font-size", `${s.codeFontSize}px`);
  // Never touch inputModality here: it is detected from real input events, and resetting it
  // to "pointer" on every settings change re-showed pointer-only styling after a theme switch.
}

/** True when the window is too narrow for the full sidebar / side panel. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const on = () => cb();
      window.addEventListener("resize", on);
      return () => window.removeEventListener("resize", on);
    },
    () => window.innerWidth < 900,
    () => false,
  );
}

/** Phone: the sidebar becomes a drawer and the side panel must never take the viewport. */
export function isPhoneWidth(w: number = window.innerWidth): boolean { return w < 640; }

/** Tablet-ish: too narrow for the full sidebar, wide enough to keep a labelled rail. */
export function useTablet(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const on = () => cb();
      window.addEventListener("resize", on);
      return () => window.removeEventListener("resize", on);
    },
    () => window.innerWidth >= 640 && window.innerWidth < 900,
    () => false,
  );
}

/** Ephemeral (never persisted) window-shape state: phone = sidebar becomes a drawer,
    panelSheet = the phone panel sheet was opened by a click in this visit (never restored
    from the desktop setting, which is what used to squeeze a phone to nothing). */
export const useUi = create<{ phone: boolean; drawerOpen: boolean; panelSheet: boolean; set: (p: Partial<{ phone: boolean; drawerOpen: boolean; panelSheet: boolean }>) => void }>((set) => ({
  phone: typeof window !== "undefined" && window.innerWidth < 640,
  drawerOpen: false,
  panelSheet: false,
  set: (p) => set(p),
}));

export function trackWindowShape(): () => void {
  const on = () => {
    const phone = window.innerWidth < 640;
    const prev = useUi.getState().phone;
    useUi.getState().set({ phone });
    if (prev !== phone) useUi.getState().set({ drawerOpen: false, panelSheet: false });
  };
  on();
  window.addEventListener("resize", on);
  return () => window.removeEventListener("resize", on);
}
