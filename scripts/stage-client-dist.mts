/**
 * Copies the built client into the server package so a packed/installed
 * `@pi-web/server` can serve the UI without the monorepo layout.
 * Runs as the last step of `npm run build`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const from = path.join(ROOT, "packages", "client", "dist");
const to = path.join(ROOT, "packages", "server", "client-dist");

if (!fs.existsSync(path.join(from, "index.html"))) {
  console.error(`stage-client-dist: no built client at ${from}; run npm run build -w @pi-web/client first`);
  process.exit(1);
}
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
const files = fs.readdirSync(to, { recursive: true }).filter((f) => typeof f === "string" && fs.statSync(path.join(to, f)).isFile());
console.log(`stage-client-dist: ${files.length} file(s) -> packages/server/client-dist`);
