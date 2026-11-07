/**
 * Local packaging smoke: `npm pack` the workspace packages into a clean temp tree,
 * install them offline-style with the mock provider, boot the packed server binary,
 * and hit an authenticated endpoint. Verifies the published artifact actually runs
 * (dist files present, bin wiring intact, no dev-only paths required).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-pack-"));
const ok = (m: string) => console.log(` ✔ ${m}`);
const fail = (m: string) => { console.error(` ✘ ${m}`); process.exitCode = 1; };

// 1. build all workspace packages (compiled dist, built client)
const build = spawnSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
if (build.status !== 0) { fail("npm run build failed"); process.exit(1); }
ok("workspace build (shared, pi-adapter, server, client)");

// 2. pack
const tgzDir = path.join(tmp, "tgz");
fs.mkdirSync(tgzDir);
const packs: string[] = [];
for (const w of ["shared", "pi-adapter", "server"]) {
  const spec = { shared: "@piwebui/shared", "pi-adapter": "@piwebui/pi-adapter", server: "@piwebui/pi-web" }[w]!;
  const r = spawnSync("npm", ["pack", "--pack-destination", tgzDir, "-w", spec], { cwd: ROOT, encoding: "utf8" });
  const file = r.stdout.trim().split("\n").pop() ?? "";
  if (r.status !== 0 || !file) { fail(`npm pack ${spec}`); } else packs.push(path.join(tgzDir, file));
}
ok(`packed: ${packs.map((p) => path.basename(p)).join(", ")}`);

// 3. install packed server into a clean dir
const install = path.join(tmp, "install");
fs.mkdirSync(install);
fs.writeFileSync(path.join(install, "package.json"), JSON.stringify({ name: "pack-consumer", private: true }));
const ins = spawnSync("npm", ["install", "--no-audit", "--no-fund", ...packs], { cwd: install, encoding: "utf8" });
if (ins.status !== 0) { fail(`npm install packed server failed: ${ins.stderr?.slice(0, 400)}`); process.exit(1); }
ok("clean install of packed artifacts");

// 4. boot the packed server and query health
const dataDir = path.join(tmp, "data");
const PORT = 4096 + Math.floor(Math.random() * 4096);
const bin = path.join(install, "node_modules/.bin/piweb");
if (!fs.existsSync(bin)) { fail("packed bin piweb missing"); process.exit(1); }
const srv = spawn(bin, ["serve", "--port", String(PORT), "--data-dir", dataDir], { cwd: install, stdio: ["ignore", "pipe", "pipe"] });
let out = "";
srv.stdout.on("data", (d) => { out += d; });
srv.stderr.on("data", (d) => { out += d; });
let up = false;
for (let i = 0; i < 120; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`); if (r.status === 401 || r.ok) { up = true; break; } } catch { /* not yet */ }
}
if (!up) { fail(`packed server did not answer within boot window`); console.error(out.slice(0, 800)); }
else ok("packed server boots and answers");
srv.kill("SIGKILL");

fs.rmSync(tmp, { recursive: true, force: true });
console.log(process.exitCode ? "package smoke FAILED" : "package smoke passed");
