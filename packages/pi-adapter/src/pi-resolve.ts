/**
 * Resolve the *installed* Pi package without ever importing it from the API server.
 * The server only uses path metadata; read workers / managed hosts call importPi().
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

export interface PiPackage {
  /** Absolute package root directory. */
  dir: string;
  /** Absolute path to the package entry (dist/index.js). */
  entry: string;
  name: string;
  version: string;
  /** Directory containing theme JSON assets. */
  themesDir: string | null;
  /** Stable fingerprint recorded in compatibility reports. */
  fingerprint: string;
  nodeRange?: string;
}

let cached: PiPackage | null | undefined;

function tryPackage(dir: string): PiPackage | null {
  try {
    const pkgPath = path.join(dir, "package.json");
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    if (pkg.name !== "@earendil-works/pi-coding-agent") return null;
    const entry = path.resolve(dir, pkg.main ?? "dist/index.js");
    if (!existsSync(entry)) return null;
    const themesCandidates = [
      path.join(dir, "dist/modes/interactive/theme"),
      path.join(dir, "dist/theme"),
    ];
    const themesDir = themesCandidates.find((c) => existsSync(c)) ?? null;
    const st = statSync(entry);
    const fingerprint = createHash("sha256")
      .update(`${pkg.name}@${pkg.version}:${entry}:${st.size}:${Math.floor(st.mtimeMs)}`)
      .digest("hex")
      .slice(0, 16);
    return { dir, entry, name: pkg.name, version: String(pkg.version), themesDir, fingerprint, nodeRange: pkg.engines?.node };
  } catch {
    return null;
  }
}

export function resolvePiPackage(opts: { agentDir?: string } = {}, force = false): PiPackage | null {
  if (cached !== undefined && !force) return cached;
  const candidates: string[] = [];
  const env = process.env.PIWEB_PI_PACKAGE;
  if (env) candidates.push(env);
  // Node module lookup from this file upward (covers devDependency installs).
  let d = path.dirname(new URL(import.meta.url).pathname);
  for (let i = 0; i < 8; i++) {
    candidates.push(path.join(d, "node_modules/@earendil-works/pi-coding-agent"));
    const parent = path.dirname(d);
    if (parent === d) break;
    d = parent;
  }
  candidates.push(
    path.join(homedir(), ".local/lib/node_modules/@earendil-works/pi-coding-agent"),
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent",
    "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent",
  );
  for (const c of candidates) {
    const found = tryPackage(c);
    if (found) {
      cached = found;
      return found;
    }
  }
  cached = null;
  return null;
}

/** Dynamic import of the resolved Pi package. Only allowed inside adapter entry processes. */
export async function importPi(): Promise<any> {
  const pkg = resolvePiPackage();
  if (!pkg) throw new Error("pi package not resolvable; set PIWEB_PI_PACKAGE");
  return import(pathToFileURL(pkg.entry).href);
}

/** Path to the bridge extension module (installed alongside this package). */
export function bridgeExtensionPath(): string {
  return path.join(path.dirname(new URL(import.meta.url).pathname), "bridge/extension.mjs");
}
