/**
 * Pi theme -> CSS token pipeline. Reads the installed pi theme JSON (versioned asset
 * discovery; no deep imports into internals), resolves `vars` references, converts
 * okhsl -> hex with the vendored Ottosson math, and applies documented contrast
 * adjustments (`-piweb-adj`) when a role fails pi-web's accessibility targets.
 * Never executes theme content.
 */
import fs from "node:fs";
import path from "node:path";
import { contrastRatio, hexToRgb, parseOkhsl, rgbToHex, okhslToRgb, relLuminance } from "@pi-web/shared";
import { resolvePiPackage } from "@pi-web/pi-adapter";

const relLum = relLuminance;

export interface ThemeJson {
  name?: string;
  appearance?: string;
  vars?: Record<string, string>;
  colors?: Record<string, string>;
  export?: Record<string, string>;
}

export interface ThemeOutput {
  name: string;
  appearance: string;
  source: string;
  piFingerprint: string;
  colors: Record<string, string>; // role -> #rrggbb
  exportColors: Record<string, string>;
  adjusted: Record<string, { from: string; to: string; note: string }>;
}

function resolveRefs(value: string, vars: Record<string, string>, depth = 0): string {
  if (depth > 8) return value;
  const direct = vars[value];
  if (direct) return resolveRefs(direct, vars, depth + 1);
  return value;
}

function toColor(value: string, vars: Record<string, string>): { hex: string; okhsl: [number, number, number] | null } | null {
  const resolved = resolveRefs(value, vars);
  const ok = parseOkhsl(resolved);
  if (ok) return { hex: rgbToHex(ok), okhsl: parseOkhslComponents(resolved) };
  if (/^#[0-9a-f]{6}$/i.test(resolved)) {
    const rgb = hexToRgb(resolved);
    return rgb ? { hex: resolved.toLowerCase(), okhsl: null } : null;
  }
  return null;
}

function parseOkhslComponents(value: string): [number, number, number] | null {
  const m = /^okhsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/i.exec(value.trim());
  return m ? [parseFloat(m[1]!), parseFloat(m[2]!) / 100, parseFloat(m[3]!) / 100] : null;
}

export function buildTheme(themeFile: string, piFingerprint: string): ThemeOutput {
  const json = JSON.parse(fs.readFileSync(themeFile, "utf8")) as ThemeJson;
  const vars = json.vars ?? {};
  const colors: Record<string, string> = {};
  for (const [role, value] of Object.entries(json.colors ?? {})) {
    const c = toColor(String(value), vars);
    if (c) colors[role] = c.hex;
  }
  const exportColors: Record<string, string> = {};
  for (const [k, v] of Object.entries(json.export ?? {})) {
    const c = toColor(String(v), vars);
    if (c) exportColors[k] = c.hex;
  }
  const pageBg = hexToRgb(exportColors.pageBg ?? "#000000") ?? { r: 0, g: 0, b: 0 };
  const cardBg = hexToRgb(exportColors.cardBg ?? "#101010") ?? { r: 16, g: 16, b: 16 };
  const userBg = hexToRgb(colors.userMessageBg ?? exportColors.pageBg ?? "#000000") ?? { r: 0, g: 0, b: 0 };

  const adjusted: ThemeOutput["adjusted"] = {};
  const pageLum = relLum(pageBg);
  const bump = (role: string, against: { r: number; g: number; b: number }, target: number, note: string) => {
    const cur = colors[role];
    if (!cur) return;
    let rgb = hexToRgb(cur)!;
    if (contrastRatio(rgb, against) >= target) return;
    const src = resolveRefs((json.colors as Record<string, string>)[role]!, vars);
    const comp = parseOkhslComponents(src);
    const from = cur;
    if (!comp) return;
    const [h, s] = comp;
    let l = comp[2];
    const dir = relLum(against) < 0.5 ? 1 : -1; // lighten on dark bg, darken on light bg
    let guard = 0;
    while (contrastRatio(rgb, against) < target && guard++ < 80) {
      l = Math.min(0.985, Math.max(0.015, l + 0.01 * dir));
      rgb = okhslToRgb(h, s, l);
      if ((dir > 0 && l >= 0.985) || (dir < 0 && l <= 0.015)) break;
    }
    if (contrastRatio(rgb, against) >= target) {
      colors[role] = rgbToHex(rgb);
      adjusted[role] = { from, to: colors[role], note };
    }
  };

  // Targets from visual_design.md contrast audit.
  bump("text", pageBg, 7, "body text on page background");
  bump("muted", pageBg, 4.5, "secondary text");
  bump("dim", pageBg, 4.5, "known low-chroma role in pi dark set");
  bump("text", userBg, 7, "user band text");
  bump("success", hexToRgb(colors.toolSuccessBg ?? "#000000") ?? { r: 0, g: 0, b: 0 }, 4.5, "tool success text");
  bump("error", hexToRgb(colors.toolErrorBg ?? "#000000") ?? { r: 0, g: 0, b: 0 }, 4.5, "tool error text");
  bump("warning", pageBg, 4.5, "warning text");
  for (const lvl of ["thinkingOff", "thinkingMinimal", "thinkingLow", "thinkingMedium", "thinkingHigh", "thinkingXhigh", "thinkingMax", "thinkingText"]) {
    bump(lvl, pageBg, 4.5, "thinking level label (text, not graphic)");
  }
  bump("borderAccent", pageBg, 3, "focus ring vs background");

  return {
    name: String(json.name ?? path.basename(themeFile, ".json")),
    appearance: String(json.appearance ?? "dark"),
    source: themeFile,
    piFingerprint,
    colors,
    exportColors,
    adjusted,
  };
}

export interface CurrentThemeResult {
  dark: ThemeOutput;
  light: ThemeOutput;
  active: "dark" | "light" | string;
  customNote: string | null;
}

export function discoverThemes(agentDir: string | null): CurrentThemeResult | { error: string } {
  const pkg = resolvePiPackage();
  if (!pkg || !pkg.themesDir) return { error: "pi theme assets not found" };
  const darkFile = path.join(pkg.themesDir, "dark.json");
  const lightFile = path.join(pkg.themesDir, "light.json");
  if (!fs.existsSync(darkFile) || !fs.existsSync(lightFile)) return { error: "pi dark/light theme JSON missing" };
  let customNote: string | null = null;
  let darkFileFinal = darkFile;
  let lightFileFinal = lightFile;
  const dir = agentDir ?? path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(process.env.HOME ?? "", ".pi", "agent"));
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(dir, "settings.json"), "utf8"));
    const t = settings?.theme;
    if (typeof t === "string" && t !== "dark" && t !== "light" && t !== "system") {
      const custom = path.join(dir, "themes", `${t}.json`);
      if (fs.existsSync(custom)) {
        darkFileFinal = custom;
        customNote = `custom theme "${t}" from ${custom}`;
      } else {
        customNote = `settings theme "${t}" not found under ${path.join(dir, "themes")}; using pi defaults`;
      }
    } else if (t === "system" || t === undefined) {
      customNote = null; // default auto pairing
    }
  } catch { /* no settings file: defaults */ }
  const dark = buildTheme(darkFileFinal, pkg.fingerprint);
  const light = buildTheme(lightFileFinal, pkg.fingerprint);
  return { dark, light, active: "auto", customNote };
}
