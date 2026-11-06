/** Applies pi-derived theme colors to CSS custom properties. */
import { api } from "./api";

interface ThemeOutput {
  name: string;
  appearance: string;
  colors: Record<string, string>;
  exportColors: Record<string, string>;
}
interface CurrentTheme {
  dark: ThemeOutput;
  light: ThemeOutput;
  active: string;
  customNote: string | null;
}

export async function applyTheme(preferred?: string | null): Promise<void> {
  try {
    const t = await api.get<CurrentTheme>("/api/v1/themes/current");
    const which = (preferred === "light" || preferred === "dark") ? preferred : (localStorage.getItem("piweb-theme") === "light" ? "light" : "dark");
    const theme = (which === "light" ? t.light : t.dark) ?? t.dark;
    const root = document.documentElement;
    for (const [role, hex] of Object.entries(theme.colors)) root.style.setProperty(`--c-${role}`, hex);
    for (const [role, hex] of Object.entries(theme.exportColors)) root.style.setProperty(`--x-${role}`, hex);
    root.style.colorScheme = theme.appearance === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = theme.name;
  } catch {
    /* fallback variables in styles.css remain in effect */
  }
}
