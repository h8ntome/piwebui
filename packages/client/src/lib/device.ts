/**
 * What kind of device this browser is running on, for exactly one decision: whether the
 * pi-web host could open a folder chooser that the operator can actually see.
 *
 * Browsers are deliberately vague about their platform, so this is a *claim*, not proof, and
 * the server treats it that way (nativePicker.ts): a claim can only ever push the answer
 * toward the in-app folder browser, never toward opening something on a machine the operator
 * is not sitting at. Nothing here is used for styling or behaviour beyond the picker.
 */

import type { DevicePlatform } from "@piwebui/shared";

/** What the caller hands in, so the detection is testable without a navigator. */
export interface DeviceProbes {
  /** `navigator.userAgentData?.platform` (Chromium only, and the most honest of the three). */
  uaDataPlatform?: string | null;
  /** `navigator.userAgent`. */
  userAgent?: string | null;
  /** `navigator.platform`, deprecated but still the only hint in older Safari/Firefox. */
  navigatorPlatform?: string | null;
}

function readProbes(): DeviceProbes {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  const uaData = (nav as { userAgentData?: { platform?: string } } | undefined)?.userAgentData;
  return {
    uaDataPlatform: uaData?.platform ?? null,
    userAgent: nav?.userAgent ?? null,
    navigatorPlatform: nav?.platform ?? null,
  };
}

/**
 * Map the browser's own hints onto the four platforms the picker knows. A phone or tablet is
 * `other` on purpose: there is no desktop folder chooser to open there, and saying "macOS"
 * for an iPhone would invite the host to look for a Finder panel that cannot exist.
 */
export function detectDevicePlatform(probes: DeviceProbes = readProbes()): DevicePlatform {
  const ua = (probes.userAgent ?? "").toLowerCase();
  if (/iphone|ipad|ipod|android|mobile/.test(ua)) return "other";
  const hints = [probes.uaDataPlatform ?? "", probes.navigatorPlatform ?? "", ua];
  for (const hint of hints) {
    const h = hint.toLowerCase();
    if (h === "") continue;
    if (/mac|darwin/.test(h)) return "darwin";
    if (/win/.test(h)) return "win32";
    if (/linux|chrome os|cros|x11/.test(h)) return "linux";
  }
  return "other";
}

/** What to call the chooser in copy, once the host has said which one it will open. */
export function deviceLabel(platform: DevicePlatform): string {
  switch (platform) {
    case "darwin": return "this Mac";
    case "win32": return "this PC";
    case "linux": return "this Linux desktop";
    default: return "this machine";
  }
}
