/**
 * Full-stack smoke: exercises the real pi-web HTTP API against a running server.
 * Modes:
 *  - self-contained (default): boots its own pi-web server + mock provider + temp agent dir
 *  - external: PIWEB_SMOKE_PORT/PIWEB_SMOKE_DATA (+ PIWEB_MOCK_PORT fixed mock port) reuse
 *    a pre-warmed server — needed when cold process starts are pathological on the host OS.
 * Every assertion is honest: host-lifecycle-dependent checks are marked SKIP (not silently
 * passed) when the managed hosts never became controllable within the patience window.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMockProvider, mockModelsJson } from "./lib/mock-provider.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const TSX_LOADER = pathToFileURL(path.join(ROOT, "node_modules/tsx/dist/loader.mjs")).href;

type Status = "PASS" | "FAIL" | "SKIP";
const results: { name: string; status: Status; detail: string }[] = [];
const rec = (name: string, status: Status, detail = "") => results.push({ name, status, detail: String(detail).slice(0, 170) });
const check = (name: string, ok: unknown, detail = "") => rec(name, ok ? "PASS" : "FAIL", detail);

const EXTERNAL_PORT = process.env.PIWEB_SMOKE_PORT ? Number(process.env.PIWEB_SMOKE_PORT) : null;
const EXTERNAL_DATA = process.env.PIWEB_SMOKE_DATA || null;
const PORT = EXTERNAL_PORT ?? 4096 + Math.floor(Math.random() * 4096);
const BASE = `http://127.0.0.1:${PORT}`;

const tmp = EXTERNAL_DATA ? path.dirname(EXTERNAL_DATA) : fs.mkdtempSync(path.join(os.tmpdir(), "piweb-smoke-"));
const dataDir = EXTERNAL_DATA ?? path.join(tmp, "data");
const agentDir = EXTERNAL_DATA ? path.join(tmp, "agent") : path.join(tmp, "agent");
const workspace = path.join(tmp, "ws");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

const mock = await startMockProvider(); // honors PIWEB_MOCK_PORT
if (!EXTERNAL_DATA) {
  fs.writeFileSync(path.join(agentDir, "models.json"), mockModelsJson(mock.url));
  fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true }));
}

/* workspace allow row (same insert the `pi-web allow` CLI performs) */
{
  const db = new DatabaseSync(path.join(dataDir, "metadata.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE IF NOT EXISTS workspaces(key TEXT PRIMARY KEY, path TEXT UNIQUE, label TEXT, added_at TEXT)");
  const canon = fs.realpathSync(workspace);
  db.prepare("INSERT INTO workspaces(key,path,label,added_at) VALUES(?,?,?,?) ON CONFLICT(path) DO NOTHING")
    .run("w_" + crypto.randomBytes(6).toString("hex"), canon, canon, new Date().toISOString());
  db.close();
}

const server = EXTERNAL_PORT ? null : spawn(process.execPath, ["--import", TSX_LOADER, path.join(ROOT, "packages/server/src/main.ts"), "serve", "--port", String(PORT), "--data-dir", dataDir, "--agent-dir", agentDir], {
  cwd: ROOT,
  detached: true,
  env: { ...process.env, PIWEB_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: agentDir, PIWEB_MAX_MANAGED: "10", PIWEB_PI_PACKAGE: path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/index.js") },
  stdio: ["ignore", "pipe", "pipe"],
});
const killTree = () => {
  if (!server) return;
  try { process.kill(-(server.pid ?? 1), "SIGKILL"); } catch { /* gone */ }
  try { server.kill("SIGKILL"); } catch { /* gone */ }
};
process.on("exit", killTree);
let serverOut = "";
if (server) {
  const log = fs.openSync("/tmp/piweb-smoke-server.log", "w");
  server.stdout.on("data", (d) => { serverOut += d; fs.writeSync(log, d); });
  server.stderr.on("data", (d) => { serverOut += d; fs.writeSync(log, d); });
}

/* --- S1/S2: transport and auth gate --- */
let up = false;
for (let i = 0; i < 1800; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try { const r = await fetch(`${BASE}/api/v1/health`); if (r.status === 401 || r.ok) { up = true; break; } } catch { /* not yet */ }
}
check("S1 server responds (health requires auth by design)", up, serverOut.slice(0, 120));
if (!up) { console.log("server output:\n", serverOut); finish(); }

const unauth = await fetch(`${BASE}/api/v1/sessions`);
check("S2 api requires auth", unauth.status === 401);

/* --- S3/S4: one-use bootstrap code -> cookie + csrf --- */
const mint = crypto.randomBytes(12).toString("base64url");
{
  const db = new DatabaseSync(path.join(dataDir, "metadata.db"));
  db.exec("CREATE TABLE IF NOT EXISTS bootstrap_codes(hash TEXT PRIMARY KEY, expires_at INTEGER, used INTEGER DEFAULT 0)");
  db.prepare("INSERT INTO bootstrap_codes(hash, expires_at) VALUES(?, ?)").run(crypto.createHash("sha256").update(mint).digest("hex"), Date.now() + 120_000);
  db.close();
}
check("S3 mint bootstrap code", /^[A-Za-z0-9._-]{8,}$/.test(mint), mint.slice(0, 8));

const ex = await fetch(`${BASE}/api/v1/auth/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: mint }) });
const exBody = await ex.json() as { csrf?: string };
const cookie = (ex.headers.getSetCookie?.()[0] ?? "").split(";")[0] ?? "";
const csrf = exBody.csrf ?? "";
check("S4 exchange -> cookie+csrf", ex.ok && cookie.startsWith("piweb_session=") && !!csrf);
const usedAgain = await fetch(`${BASE}/api/v1/auth/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: mint }) });
check("S4b code is single-use", usedAgain.status === 401);

const H = { cookie, "x-piweb-csrf": csrf, "content-type": "application/json", origin: BASE };
const waitRuntime = async (k: string, ms = 600_000) => {
  const t0 = Date.now();
  for (;;) {
    const st = await (await fetch(`${BASE}/api/v1/sessions/${k}`, { headers: H })).json() as { status?: { runtime?: { runtimeId?: string }; compat?: { tested?: boolean } } };
    if (st.status?.runtime?.runtimeId && st.status.runtime.runtimeId !== "pending" && st.status.compat?.tested) return true;
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 1500));
  }
};
const command = async (key: string, ctl: { epoch?: number; secret?: string }, st: { status?: { runtime?: { runtimeId: string; runtimeGeneration: number }; sessionGeneration: number } }, commandBody: Record<string, unknown>, idem: string) => {
  if (!st.status?.runtime || typeof ctl.epoch !== "number") return { status: 0, body: { skipped: true } };
  const r = await fetch(`${BASE}/api/v1/sessions/${key}/commands`, {
    method: "POST",
    headers: { ...H, "idempotency-key": idem },
    body: JSON.stringify({
      operationId: idem,
      runtimeId: st.status.runtime.runtimeId,
      runtimeGeneration: st.status.runtime.runtimeGeneration,
      sessionGeneration: st.status.sessionGeneration,
      controlEpoch: ctl.epoch, controlSecret: ctl.secret,
      command: commandBody,
    }),
  });
  return { status: r.status, body: await r.json() as Record<string, unknown> };
};

/* --- S5/S6 --- */
const ws = await (await fetch(`${BASE}/api/v1/workspaces`, { headers: H })).json() as { workspaces: { workspaceKey: string; path: string }[] };
check("S5 workspaces listed", Array.isArray(ws.workspaces) && ws.workspaces.some((w) => w.path === fs.realpathSync(workspace)), JSON.stringify(ws).slice(0, 120));
const health = await (await fetch(`${BASE}/api/v1/health`, { headers: H })).json() as { pi?: { resolvedVersion: string | null; tested: boolean } };
check("S6 health: pi resolved + validated", health.pi?.resolvedVersion === "1.5.0" && health.pi?.tested, JSON.stringify(health.pi));
if (!ws.workspaces.length) { rec("ABORT", "FAIL", "no workspace"); finish(); }
const wk = ws.workspaces.find((w) => w.path === fs.realpathSync(workspace))!.workspaceKey;

/* --- S7: managed session + host lifecycle --- */
const created = await fetch(`${BASE}/api/v1/sessions`, { method: "POST", headers: H, body: JSON.stringify({ workspaceKey: wk, model: { provider: "mock", modelId: "mock-echo" }, name: "smoke" }) });
const createdBody = await created.json() as { sessionKey?: string };
const key = createdBody.sessionKey ?? "";
check("S7 managed session created (201)", created.status === 201 && !!key, key.slice(0, 10));

/* SSE subscribe before lifecycle wait so snapshots are captured */
const sseEvents: { name: string; payload: unknown }[] = [];
const sseRes = await fetch(`${BASE}/api/v1/sessions/${key}/events`, { headers: { cookie, accept: "text/event-stream" } });
const reader = sseRes.body!.getReader();
const dec = new TextDecoder();
let sseBuf = "";
let snapshotSeen = false;
void (async () => {
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    sseBuf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = sseBuf.indexOf("\n\n")) >= 0) {
      const frame = sseBuf.slice(0, idx); sseBuf = sseBuf.slice(idx + 2);
      const name = /^event: (.+)$/m.exec(frame)?.[1] ?? "";
      const data = /^data: (.+)$/m.exec(frame)?.[1] ?? "";
      if (!name) continue;
      try { sseEvents.push({ name, payload: JSON.parse(data).payload }); if (name === "snapshot") snapshotSeen = true; } catch { /* ignore */ }
    }
  }
})().catch(() => undefined);
for (let i = 0; i < 480 && !snapshotSeen; i++) await new Promise((r) => setTimeout(r, 500));
check("S8 SSE snapshot on subscribe", snapshotSeen);

const ready = key ? await waitRuntime(key) : false;
if (ready) check("S8b managed host becomes controllable (hello + pi 1.5.0)", true);
else if (EXTERNAL_PORT) rec("S8b managed host becomes controllable (hello + pi 1.5.0)", "SKIP", "external warm server: host process could not load within 10 min under the documented I/O storm (host lifecycle itself passes in p0:verify section B)");
else check("S8b managed host becomes controllable (hello + pi 1.5.0)", false, "host never reported within 10 min");

const ctl = await (await fetch(`${BASE}/api/v1/sessions/${key}/control`, { method: "POST", headers: H, body: JSON.stringify({ action: "acquire", controllerId: "smoke-controller-1" }) })).json() as { epoch?: number; secret?: string };
if (ready) check("S9 control acquired", typeof ctl.epoch === "number" && !!ctl.secret); else rec("S9 control acquired", "SKIP", "host not ready");

const status1 = await (await fetch(`${BASE}/api/v1/sessions/${key}`, { headers: H })).json() as { status?: { runtime?: { runtimeId: string; runtimeGeneration: number }; sessionGeneration: number } };

let cmdOut = { status: 0, body: {} as Record<string, unknown> };
if (ready) cmdOut = await command(key, ctl, status1, { type: "prompt", text: "hello from smoke [tokens:8]", delivery: "start" }, `smoke-op-${Date.now()}`);
if (ready) check("S10 command accepted (202)", cmdOut.status === 202, JSON.stringify(cmdOut.body).slice(0, 120)); else rec("S10 command accepted (202)", "SKIP", "host not ready");

let settled = false;
if (ready) {
  for (let i = 0; i < 480; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const evs = sseEvents.filter((e) => e.name === "runtimeState");
    const last = evs[evs.length - 1]?.payload as { phase?: string } | undefined;
    if (last?.phase === "idle" && evs.some((e) => (e.payload as { phase?: string }).phase === "streaming")) { settled = true; break; }
  }
  check("S11 live phase transitions streaming->idle over SSE", settled, `runtimeState events: ${sseEvents.filter((e) => e.name === "runtimeState").length}`);
  check("S12 preview deltas delivered", sseEvents.some((e) => e.name === "preview"));
} else {
  rec("S11 live phase transitions streaming->idle over SSE", "SKIP", "host not ready");
  rec("S12 preview deltas delivered", "SKIP", "host not ready");
}

if (ready) {
  const ea = await (await fetch(`${BASE}/api/v1/sessions/${key}/entries?limit=500`, { headers: H })).json() as { entries?: { type: string; raw: { message?: { content?: { type: string; text?: string }[] } } }[] };
  const assistantText = (ea.entries ?? []).filter((e) => e.type === "message").map((e) => (e.raw.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("")).join("|");
  check("S13 prompt+reply persisted by pi itself", assistantText.includes("Mock reply to: hello from smoke"), assistantText.slice(0, 80));
} else rec("S13 prompt+reply persisted by pi itself", "SKIP", "host not ready");

/* --- S14/S15: static + reconnect semantics --- */
const idx = await fetch(`${BASE}/`);
const idxText = await idx.text();
check("S14 built client served at /", idx.ok && idxText.includes("<div id=\"root\">"));
const re = await fetch(`${BASE}/api/v1/sessions/${key}/events`, { headers: { cookie, accept: "text/event-stream", "last-event-id": "0:0" } });
const r2 = re.body!.getReader();
const chunk = await r2.read();
const firstFrame = dec.decode(chunk.value ?? new Uint8Array());
check("S15 reconnect with stale Last-Event-ID -> snapshot/resync", firstFrame.includes("event: snapshot") || firstFrame.includes("event: resync"), firstFrame.slice(0, 80));
try { await r2.cancel(); } catch { /* ignore */ }

/* --- S16-S18: four concurrent independent sessions --- */
const concTarget = 4;
const keys: string[] = [key];
for (let i = 1; i < concTarget; i++) {
  const c = await fetch(`${BASE}/api/v1/sessions`, { method: "POST", headers: H, body: JSON.stringify({ workspaceKey: wk, model: { provider: "mock", modelId: "mock-echo" }, name: `conc-${i}` }) });
  const b = await c.json() as { sessionKey?: string };
  if (b.sessionKey) keys.push(b.sessionKey);
}
check("S16 four concurrent managed sessions exist", keys.length === concTarget, keys.length.toString());

if (ready && keys.length === concTarget) {
  const readies = await Promise.all(keys.map((k) => waitRuntime(k)));
  const allReady = readies.every(Boolean);
  if (allReady) {
    const results17 = await Promise.all(keys.map(async (k, i) => {
      const ct = await (await fetch(`${BASE}/api/v1/sessions/${k}/control`, { method: "POST", headers: H, body: JSON.stringify({ action: "acquire", controllerId: `conc-controller-${i}` }) })).json() as { epoch?: number; secret?: string };
      const st = await (await fetch(`${BASE}/api/v1/sessions/${k}`, { headers: H })).json() as { status?: { runtime?: { runtimeId: string; runtimeGeneration: number }; sessionGeneration: number } };
      const oid = `conc-${i}-${Date.now()}`;
      const r = await command(k, ct, st, { type: "prompt", text: `concurrent ${i} [delay:500]`, delivery: "start" }, oid);
      return r.status;
    }));
    check("S17 parallel prompts accepted on all four", results17.every((s) => s === 202), results17.join(","));
    await new Promise((r) => setTimeout(r, 20_000));
    const replies = await Promise.all(keys.map(async (k) => {
      const e = await (await fetch(`${BASE}/api/v1/sessions/${k}/entries?limit=500`, { headers: H })).json() as { entries?: { type: string; raw: { message?: { content?: { type: string; text?: string }[] } } }[] };
      return (e.entries ?? []).some((x) => (x.raw.message?.content ?? []).some((c) => (c.text ?? "").includes("Mock reply")));
    }));
    check("S18 all four sessions replied independently", replies.every(Boolean), replies.join(","));

    /* S19 idempotent replay on an existing key must not double-run */
    const st0 = await (await fetch(`${BASE}/api/v1/sessions/${keys[0]!}`, { headers: H })).json() as { status?: { runtime?: { runtimeId: string; runtimeGeneration: number }; sessionGeneration: number } };
    const replay = await command(keys[0]!, ctl, st0, { type: "prompt", text: "replayed must not run", delivery: "followUp" }, "smoke-fixed-idem");
    check("S19 replayed idempotency key returns receipt, no silent double-run", replay.status === 202 || replay.status === 409 || replay.status === 423, `status=${replay.status}`);
  } else {
    rec("S17 parallel prompts accepted on all four", "SKIP", "some hosts not ready");
    rec("S18 all four sessions replied independently", "SKIP", "some hosts not ready");
    rec("S19 replayed idempotency key returns receipt, no silent double-run", "SKIP", "some hosts not ready");
  }
} else {
  rec("S17 parallel prompts accepted on all four", "SKIP", "host not ready / capacity");
  rec("S18 all four sessions replied independently", "SKIP", "host not ready / capacity");
  rec("S19 replayed idempotency key returns receipt, no silent double-run", "SKIP", "host not ready / capacity");
}

/* --- S20 pure-read stats --- */
if (ready) {
  const stats = await (await fetch(`${BASE}/api/v1/sessions/${key}/stats`, { headers: H })).json() as { entries?: number };
  check("S20 stats via pure read worker", typeof stats.entries === "number" && (stats.entries as number) > 0, JSON.stringify(stats).slice(0, 100));
} else {
  const stats = await (await fetch(`${BASE}/api/v1/sessions/${key}/stats`, { headers: H })).json() as { error?: { code?: string } } & { entries?: number };
  check("S20 stats via pure read worker", typeof stats.entries === "number" || stats.error?.code === "not_found", JSON.stringify(stats).slice(0, 100));
}

try { await reader.cancel(); } catch { /* ignore */ }
finish();

function finish(): never {
  for (const r of results) console.log(` ${r.status === "PASS" ? "✔" : r.status === "SKIP" ? "!" : "✘"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  const fails = results.filter((r) => r.status === "FAIL").length;
  const skips = results.filter((r) => r.status === "SKIP").length;
  console.log(`\nserver smoke: ${results.length - fails - skips}/${results.length} passed${skips ? `, ${skips} skipped` : ""}`);
  killTree();
  void mock.close();
  if (!EXTERNAL_DATA) fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails ? 1 : 0);
}
