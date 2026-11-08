/**
 * Local packaging smoke: `npm pack` the workspace packages into a clean temp tree,
 * install them offline-style, and exercise the `pi-web` command exactly the way a
 * user does after `npm i -g @piwebui/pi-web`: bare launch, `--version`, `--help`,
 * `--port 0`, the port-in-use report, and the login-free API. Verifies the published
 * artifact actually runs (dist present, client staged, bin wiring intact, no
 * dev-only paths or cwd assumptions).
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_NAMES, CLI_PRIMARY } from "./cli-names.mts";

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
const binDir = path.join(install, "node_modules/.bin");
// The install is the truth about `bin`: npm only creates a shim for each declared name,
// so a manifest that forgot `pi-web` fails here instead of shipping a broken command.
const packedPkg = JSON.parse(
  fs.readFileSync(path.join(install, "node_modules", "@piwebui", "pi-web", "package.json"), "utf8"),
) as { bin?: Record<string, string> };
const declaredBin = Object.keys(packedPkg.bin ?? {});
for (const name of CLI_NAMES) {
  if (!declaredBin.includes(name)) fail(`packed manifest declares no \`${name}\` in \`bin\` (${JSON.stringify(packedPkg.bin)})`);
  if (!fs.existsSync(path.join(binDir, name))) fail(`packed install produced no \`${name}\` command in node_modules/.bin`);
}
if (declaredBin.length && declaredBin.every((n) => CLI_NAMES.includes(n))) {
  ok(`packed bins: ${CLI_NAMES.map((n) => `\`${n}\``).join(", ")}`);
}
const bin = path.join(binDir, CLI_PRIMARY);
if (!fs.existsSync(bin)) { fail(`packed bin ${CLI_PRIMARY} missing`); process.exit(1); }

/** Run the packed CLI from a directory unrelated to the install (launch is cwd-independent). */
const runBin = (args: string[], extra: Record<string, string> = {}) =>
  spawnSync(bin, args, { cwd: os.tmpdir(), encoding: "utf8", env: { ...process.env, ...extra }, timeout: 120_000 });

// flags-only launch (no subcommand) is the documented one-command UX; --no-open keeps CI headless.
const srv = spawn(bin, ["--port", String(PORT), "--data-dir", dataDir, "--no-open"], { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"], detached: true });
let out = "";
srv.stdout?.on("data", (d) => { out += d; });
srv.stderr?.on("data", (d) => { out += d; });
srv.unref();
let up = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  try { const r = await fetch(`http://127.0.0.1:${PORT}/api/v1/health`); if (r.ok) { up = true; break; } } catch { /* not yet */ }
}
if (!up) { fail(`packed server did not answer within boot window`); console.error(out.slice(0, 800)); }
else ok("packed server boots and answers (bare `pi-web --port N --no-open`, foreign cwd)");

// 4a. --version and --help from the installed command.
const ver = runBin(["--version"]);
if (ver.status === 0 && /^pi-web \d+\.\d+\.\d+/m.test(ver.stdout)) ok(`pi-web --version -> ${ver.stdout.trim()}`);
else fail(`pi-web --version failed (status ${ver.status}): ${ver.stdout.slice(0, 120)}${ver.stderr.slice(0, 200)}`);
const help = runBin(["--help"]);
if (help.status === 0 && /pi-web serve/.test(help.stdout) && /--port <n>/.test(help.stdout)) ok("pi-web --help documents the serve flags");
else fail(`pi-web --help unusable (status ${help.status})`);

// 4a-ii. a mistyped flag is reported instead of being silently ignored.
const typo = runBin(["--pot", "4321", "--no-open"]);
if (typo.status === 2 && /unknown flag\(s\): --pot/.test(typo.stderr)) ok("mistyped flag -> actionable error, exit 2");
else fail(`mistyped flag mishandled (status ${typo.status}): ${(typo.stderr || typo.stdout).slice(0, 200)}`);

// 4b. a busy port reports one actionable line instead of a stack trace.
const clash = runBin(["--port", String(PORT), "--data-dir", path.join(tmp, "data2"), "--no-open"]);
if (clash.status !== 0 && /already in use/.test(clash.stderr) && !/\n\s+at\s/.test(clash.stderr)) {
  ok("port in use -> concise actionable error, non-zero exit");
} else {
  fail(`port-in-use report wrong (status ${clash.status}): ${(clash.stderr || clash.stdout).slice(0, 300)}`);
}

// 4c. `--port 0`: the OS picks the port, the banner prints the real one, and the
// Host fence admits it (the SPA would otherwise 400 on every fetch).
const zero = path.join(tmp, "zero");
const zsrv = spawn(bin, ["--port", "0", "--data-dir", zero, "--no-open"], { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"], detached: true });
let zout = "";
zsrv.stdout?.on("data", (d) => { zout += d; });
zsrv.stderr?.on("data", (d) => { zout += d; });
zsrv.unref();
let zport = 0;
for (let i = 0; i < 60 && !zport; i++) {
  await new Promise((r) => setTimeout(r, 500));
  zport = Number(/listening on http:\/\/127\.0\.0\.1:(\d+)/.exec(zout)?.[1] ?? 0);
}
if (!zport) fail(`--port 0 never announced a bound port: ${zout.slice(0, 300)}`);
else {
  let okZero = false;
  let indexStatus = 0;
  for (let i = 0; i < 40 && !okZero; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${zport}/api/v1/health`, { headers: { host: `localhost:${zport}` } });
      indexStatus = (await fetch(`http://127.0.0.1:${zport}/`, { headers: { host: `localhost:${zport}` } })).status;
      okZero = r.ok && indexStatus === 200;
    } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  if (okZero) ok(`--port 0 bound :${zport}, announced it, and serves API + SPA under that Host`);
  else fail(`--port 0 listener unusable (health/index -> ${indexStatus})`);
}
try { process.kill(-(zsrv.pid ?? 1), "SIGKILL"); } catch { /* gone */ }
try { process.kill(-(srv.pid ?? 1), "SIGKILL"); } catch { /* gone */ }
try { zsrv.kill("SIGKILL"); srv.kill("SIGKILL"); } catch { /* gone */ }

// 5. the real user path: install globally into a fresh prefix and launch `pi-web`
// from an unrelated cwd, exactly as the README tells people to.
const prefix = path.join(tmp, "global-prefix");
const gins = spawnSync("npm", ["install", "-g", "--no-audit", "--no-fund", "--prefix", prefix, ...packs], { cwd: os.tmpdir(), encoding: "utf8" });
const gbin = path.join(prefix, "bin", CLI_PRIMARY);
if (gins.status !== 0) fail(`global install failed: ${gins.stderr?.slice(0, 300)}`);
else {
  const missing = CLI_NAMES.filter((n) => !fs.existsSync(path.join(prefix, "bin", n)));
  if (missing.length) fail(`global install put no ${missing.map((n) => `\`${n}\``).join(" or ")} in ${prefix}/bin — \`npm i -g\` then reports "command not found" for the documented command`);
  else {
    const gv = spawnSync(gbin, ["--version"], { cwd: os.tmpdir(), encoding: "utf8", timeout: 60_000 });
    if (gv.status === 0 && /^pi-web \d/m.test(gv.stdout)) ok(`npm i -g -> \`${CLI_PRIMARY} --version\` = ${gv.stdout.trim()}`);
    else fail(`global ${CLI_PRIMARY} did not run (status ${gv.status}): ${(gv.stderr || gv.stdout).slice(0, 300)}`);
  }
}
if (fs.existsSync(gbin)) {
  const gdata = path.join(tmp, "gdata");
  const gport = 4096 + Math.floor(Math.random() * 4096);
  const gsrv = spawn(gbin, ["--port", String(gport), "--data-dir", gdata, "--no-open"], { cwd: os.tmpdir(), stdio: ["ignore", "pipe", "pipe"], detached: true });
  let gup = false;
  for (let i = 0; i < 60 && !gup; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try { gup = (await fetch(`http://127.0.0.1:${gport}/api/v1/health`)).ok; } catch { /* not yet */ }
  }
  if (gup) ok("globally installed pi-web serves the login-free API");
  else fail("globally installed pi-web did not answer");
  try { process.kill(-(gsrv.pid ?? 1), "SIGKILL"); } catch { /* gone */ }
  try { gsrv.kill("SIGKILL"); } catch { /* gone */ }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(process.exitCode ? "package smoke FAILED" : "package smoke passed");
process.exit(process.exitCode ?? 0);
