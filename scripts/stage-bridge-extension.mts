/**
 * Stage the bridge extension into the server package so `pi-web install-extension` works from a
 * packed install (where `packages/pi-extension` is not next door). The single source of truth
 * stays `packages/pi-extension/extensions/pi-web-bridge.js`; this only copies it, and CI fails if
 * the copy is missing or stale, so the two can never drift silently.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "packages", "pi-extension", "extensions", "pi-web-bridge.js");
const DEST_DIR = path.join(ROOT, "packages", "server", "bridge-extension");
const DEST = path.join(DEST_DIR, "pi-web-bridge.js");

if (!fs.existsSync(SRC)) {
  console.error(`stage-bridge-extension: source not found: ${SRC}`);
  process.exit(1);
}
fs.mkdirSync(DEST_DIR, { recursive: true });
const src = fs.readFileSync(SRC);
const same = fs.existsSync(DEST) && fs.readFileSync(DEST).equals(src);
fs.writeFileSync(DEST, src);
console.log(`staged bridge extension: ${path.relative(ROOT, SRC)} -> ${path.relative(ROOT, DEST)}${same ? " (unchanged)" : ""}`);
