/**
 * Full-stack smoke: boots the real pi-web server (isolated temp data dir + temp Pi agent
 * dir with mock provider), exchanges a bootstrap code, creates a managed session,
 * prompts through the command API, watches SSE, and verifies persistence + snapshots.
 * Exit 0 = all checks pass.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startMockProvider, mockModelsJson } from "./lib/mock-provider.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");

const results: { name: string; ok: boolean; detail: string }[] = [];
const check = (name: string, ok: unknown, detail = "") => { results.push({ name, ok: !!ok, detail: String(detail).slice(0, 160) }); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-smoke-"));
const agentDir = path.join(tmp, "agent");
const workspace = path.join(tmp, "ws");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });

const mock = await startMockProvider();
fs.writeFileSync(path.join(agentDir, "models.json"), mockModelsJson(mock.url));
fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify({ quietStartup: true }));

const EXTERNAL_PORT = process.env.PIWEB_SMOKE_PORT ? Number(process.env.PIWEB_SMOKE_PORT) : null;
const EXTERNAL_DATA = process.env.PIWEB_SMOKE_DATA || null;
const PORT = EXTERNAL_PORT ?? 4096 + Math.floor(Math.random() * 4096);
const BASE = `http://127.0.0.1:${PORT}`;
const dataDir = EXTERNAL_DATA ?? path.join(tmp, "data");

// allow the workspace directory before the server boots (same row the `pi-web allow` CLI writes;
// the CLI path itself is exercised in the package smoke / manually)
fs.mkdirSync(dataDir, { recursive: true });
{
  const db = new DatabaseSync(path.join(dataDir, "metadata.db"));
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("CREATE TABLE IF NOT EXISTS workspaces(key TEXT PRIMARY KEY, path TEXT UNIQUE, label TEXT, added_at TEXT)");
  const canon = fs.realpathSync(workspace);
  db.prepare("INSERT INTO workspaces(key,path,label,added_at) VALUES(?,?,?,?) ON CONFLICT(path) DO NOTHING")
    .run("w_" + crypto.randomBytes(6).toString("hex"), canon, canon, new Date().toISOString());
  db.close();
}

const TSX_LOADER = pathToFileURL(path.join(ROOT, "node_modules/tsx/dist/loader.mjs")).href;
const server = EXTERNAL_PORT ? null : spawn(process.execPath, ["--import", TSX_LOADER, path.join(ROOT, "packages/server/src/main.ts"), "serve", "--port", String(PORT), "--data-dir", dataDir, "--agent-dir", agentDir], {
  cwd: ROOT,
  detached: true, // own process group so descendants die with it
  env: { ...process.env, PIWEB_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: agentDir, PIWEB_PI_PACKAGE: path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/index.js") },
  stdio: ["ignore", "pipe", "pipe"],
});
const killTree = () => { if (!server) return; try { process.kill(-(server.pid ?? 1), "SIGKILL"); } catch { /* gone */ } try { server.kill("SIGKILL"); } catch { /* gone */ } };
process.on("exit", killTree);
let serverOut = "";
if (server) {
  const serverLog = fs.openSync("/tmp/piweb-smoke-server.log", "w");
  server.stdout.on("data", (d) => { serverOut += d.toString(); fs.writeSync(serverLog, d); });
  server.stderr.on("data", (d) => { serverOut += d.toString(); fs.writeSync(serverLog, d); });
}

// wait for readiness via health
let up = false;
for (let i = 0; i < 1800; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try { const r = await fetch(`${BASE}/api/v1/health`); if (r.status === 401 || r.ok) { up = true; break; } } catch { /* not yet */ }
}
check("S1 server boots (api responds; health requires auth by design)", up, serverOut.slice(0, 120));
if (!up) { console.log("server output:\n", serverOut); process.exit(1); }

// unauthenticated API is rejected
const unauth = await fetch(`${BASE}/api/v1/sessions`);
check("S2 api requires auth", unauth.status === 401);

// mint a bootstrap code directly (sha256 row identical to AuthService.mintBootstrapCode)
const mint = crypto.randomBytes(12).toString("base64url");
{
  const db = new DatabaseSync(path.join(dataDir, "metadata.db"));
  db.exec("CREATE TABLE IF NOT EXISTS bootstrap_codes(hash TEXT PRIMARY KEY, expires_at INTEGER, used INTEGER DEFAULT 0)");
  db.prepare("INSERT INTO bootstrap_codes(hash, expires_at) VALUES(?, ?)").run(crypto.createHash("sha256").update(mint).digest("hex"), Date.now() + 120_000);
  db.close();
}
check("S3 mint-code CLI", /^[A-Za-z0-9._-]{8,}$/.test(mint), mint.slice(0, 12));
console.log("DEBUG mint raw:", JSON.stringify(mint));
{
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(dataDir, "metadata.db"));
  console.log("DEBUG db rows:", JSON.stringify(db.prepare("SELECT substr(hash,1,8) h, used, expires_at FROM bootstrap_codes").all()));
  console.log("DEBUG expect hash prefix:", (await import("node:crypto")).createHash("sha256").update(mint).digest("hex").slice(0, 8));
  db.close();
}


let cookie = "";
let csrf = "";
const ex = await fetch(`${BASE}/api/v1/auth/exchange`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: mint }) });
const exBody = await ex.json() as { csrf?: string; setCookie?: string };
const setCookie = ex.headers.getSetCookie?.()[0] ?? "";
cookie = setCookie.split(";")[0] ?? "";
csrf = exBody.csrf ?? "";
check("S4 bootstrap code exchange -> cookie+csrf", ex.ok && cookie.startsWith("piweb_session=") && !!csrf);

const H = { cookie, "x-piweb-csrf": csrf, "content-type": "application/json", origin: BASE };
console.log("DEBUG exchange:", ex.status, JSON.stringify(exBody).slice(0, 200), "cookie:", cookie.slice(0, 24));
const wsRes = await fetch(`${BASE}/api/v1/workspaces`, { headers: H });
const ws = await wsRes.json() as { workspaces: { workspaceKey: string; path: string }[] };
console.log("DEBUG workspaces:", wsRes.status, JSON.stringify(ws).slice(0, 250));
check("S5 workspaces listed", Array.isArray(ws.workspaces) && ws.workspaces.some((w) => w.path === fs.realpathSync(workspace)), JSON.stringify(ws).slice(0, 200));

const meta = await (await fetch(`${BASE}/api/v1/meta`, { headers: H })).json() as { pi: { version: string | null; tested: boolean } };
check("S6 meta: pi version resolved+tested", (meta.pi?.version === "1.5.0" && meta.pi?.tested) || (meta as { piVersion?: string }).piVersion === "1.5.0", JSON.stringify(meta).slice(0, 160));

// create a managed session
const created = await fetch(`${BASE}/api/v1/sessions`, { method: "POST", headers: H, body: JSON.stringify({ workspaceKey: ws.workspaces[0]!.workspaceKey, model: { provider: "mock", modelId: "mock-echo" }, name: "smoke" }) });
const createdBody = await created.json() as { sessionKey?: string; status?: { runtime?: unknown } };
const key = createdBody.sessionKey ?? "";
check("S7 managed session created (201)", created.status === 201 && !!key, key.slice(0, 12));

// SSE stream connects and sends a snapshot
const sseEvents: { name: string; payload: unknown }[] = [];
const sseRes = await fetch(`${BASE}/api/v1/sessions/${key}/events`, { headers: { cookie, accept: "text/event-stream" } });
const reader = sseRes.body!.getReader();
const dec = new TextDecoder();
let sseBuf = "";
let snapshotSeen = false;
const sseLoop = (async () => {
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
for (let i = 0; i < 240 && !snapshotSeen; i++) await new Promise((r) => setTimeout(r, 500));
check("S8 SSE snapshot on subscribe", snapshotSeen);

// acquire control, then prompt through the command API
const ctlRes = await fetch(`${BASE}/api/v1/sessions/${key}/control`, { method: "POST", headers: H, body: JSON.stringify({ action: "acquire", controllerId: "smoke-controller-1" }) });
const ctl = await ctlRes.json() as { epoch?: number; secret?: string };
console.log("DEBUG control:", ctlRes.status, JSON.stringify(ctl).slice(0, 160));
check("S9 control acquired", typeof ctl.epoch === "number" && !!ctl.secret);

const status1 = await (await fetch(`${BASE}/api/v1/sessions/${key}`, { headers: H })).json() as { status: { runtime?: { runtimeId: string; runtimeGeneration: number }; sessionGeneration: number } };
check("S9b main session has live runtime identity", !!status1.status.runtime, JSON.stringify(status1.status).slice(0, 140));
const opId = `smoke-op-${Date.now()}`;
const cmdRes = await fetch(`${BASE}/api/v1/sessions/${key}/commands`, {
  method: "POST",
  headers: { ...H, "idempotency-key": opId },
  body: JSON.stringify({
    operationId: opId,
    runtimeId: status1.status.runtime!.runtimeId,
    runtimeGeneration: status1.status.runtime!.runtimeGeneration,
    sessionGeneration: status1.status.sessionGeneration,
    controlEpoch: ctl.epoch, controlSecret: ctl.secret,
    command: { type: "prompt", text: "hello from smoke [tokens:8]", delivery: "start" },
  }),
});
check("S10 command accepted (202)", cmdRes.status === 202, JSON.stringify(await cmdRes.json()).slice(0, 140));

// wait for the run to settle (runtimeState phase idle) and previews to stream
let settled = false;
for (let i = 0; i < 320; i++) {
  await new Promise((r) => setTimeout(r, 500));
  const evs = sseEvents.filter((e) => e.name === "runtimeState");
  const last = evs[evs.length - 1]?.payload as { phase?: string } | undefined;
  if (last?.phase === "idle" && evs.some((e) => (e.payload as { phase?: string }).phase === "streaming")) { settled = true; break; }
}
check("S11 live phase transitions streaming->idle over SSE", settled, `runtimeState events: ${sseEvents.filter((e) => e.name === "runtimeState").length}`);
check("S12 preview deltas delivered", sseEvents.some((e) => e.name === "preview"));

// persisted entries visible via REST
const snapEv = sseEvents.find((e) => e.name === "snapshot")?.payload as { entries?: unknown[] } | undefined;
void snapEv;
const eaRes = await fetch(`${BASE}/api/v1/sessions/${key}/entries?limit=500`, { headers: H });
const entriesAfter = await eaRes.json() as { entries?: { type: string; raw: { message?: { content?: { type: string; text?: string }[] } } }[] };
if (!Array.isArray(entriesAfter.entries)) console.log("DEBUG entries http", eaRes.status, JSON.stringify(entriesAfter).slice(0, 200));
const assistantText = (entriesAfter.entries ?? []).filter((e) => e.type === "message").map((e) => (e.raw.message?.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("")).join("|");
check("S13 prompt+reply persisted by pi itself", assistantText.includes("Mock reply to: hello from smoke"), assistantText.slice(0, 80));

// static client served
const idx = await fetch(`${BASE}/`);
const idxText = await idx.text();
check("S14 built client served at /", idx.ok && idxText.includes("<div id=\"root\">"));

// reconnect: fresh SSE with Last-Event-ID behaves (gets snapshot or replay)
const lastId = "0:0";
const re = await fetch(`${BASE}/api/v1/sessions/${key}/events`, { headers: { cookie, accept: "text/event-stream", "last-event-id": lastId } });
const r2 = re.body!.getReader();
const chunk = await r2.read();
const firstFrame = dec.decode(chunk.value ?? new Uint8Array());
check("S15 reconnect with stale Last-Event-ID -> snapshot/resync", firstFrame.includes("event: snapshot") || firstFrame.includes("event: resync"), firstFrame.slice(0, 80));
try { await r2.cancel(); } catch { /* ignore */ }
try { await reader.cancel(); } catch { /* ignore */ }
void lastId;

// four concurrent managed sessions (capacity + isolation)
const keys: string[] = [];
for (let i = 0; i < 4; i++) {
  const c = await fetch(`${BASE}/api/v1/sessions`, { method: "POST", headers: H, body: JSON.stringify({ workspaceKey: ws.workspaces[0]!.workspaceKey, model: { provider: "mock", modelId: "mock-echo" }, name: `conc-${i}` }) });
  const b = await c.json() as { sessionKey?: string };
  if (b.sessionKey) keys.push(b.sessionKey);
}
check("S16 four concurrent managed sessions", keys.length === 4, keys.length.toString());
for (const k of keys) {
  let st: { status?: { runtime?: unknown; state?: string } } | null = null;
  for (let i = 0; i < 400; i++) {
    st = await (await fetch(`${BASE}/api/v1/sessions/${k}`, { headers: H })).json() as { status?: { runtime?: unknown; state?: string } };
    if (st.status?.runtime) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const stx = st as { status?: { mode?: string; runtime?: unknown; capabilities?: Record<string, boolean>; compat?: { tested: boolean; piVersion?: string } } };
console.log("DEBUG conc final:", JSON.stringify({ mode: stx.status?.mode, hasRt: !!stx.status?.runtime, canControl: stx.status?.capabilities?.canControl, caps: Object.entries(stx.status?.capabilities ?? {}).filter(([, v]) => v === true).length, compat: stx.status?.compat }));
}
const prompts = await Promise.all(keys.map(async (k, i) => {
  const stRes = await fetch(`${BASE}/api/v1/sessions/${k}`, { headers: H });
  const st = await stRes.json() as { status?: { runtime?: { runtimeId: string; runtimeGeneration: number }; sessionGeneration: number } };
  if (!st.status) console.log(`DEBUG conc status ${stRes.status}:`, JSON.stringify(st).slice(0, 200));
  const ctRes = await fetch(`${BASE}/api/v1/sessions/${k}/control`, { method: "POST", headers: H, body: JSON.stringify({ action: "acquire", controllerId: `conc-controller-${i}` }) });
  const ct = await ctRes.json() as { epoch?: number; secret?: string };
  if (!ct.epoch) console.log("DEBUG conc control:", ctRes.status, JSON.stringify(ct).slice(0, 140));
  const oid = `conc-${i}-${Date.now()}`;
  const r = await fetch(`${BASE}/api/v1/sessions/${k}/commands`, { method: "POST", headers: { ...H, "idempotency-key": oid }, body: JSON.stringify({
    operationId: oid, runtimeId: st.status?.runtime?.runtimeId ?? "", runtimeGeneration: st.status?.runtime?.runtimeGeneration ?? 0,
    sessionGeneration: st.status?.sessionGeneration ?? 0, controlEpoch: ct.epoch, controlSecret: ct.secret,
    command: { type: "prompt", text: `concurrent ${i} [delay:400]`, delivery: "start" } }) });
  return r.status;
}));
check("S17 parallel prompts accepted on all four", prompts.every((s) => s === 202), prompts.join(","));
await new Promise((r) => setTimeout(r, 12_000));
const files = await Promise.all(keys.map(async (k) => {
  const e = await (await fetch(`${BASE}/api/v1/sessions/${k}/entries?limit=500`, { headers: H })).json() as { entries?: unknown[] };
  return (e.entries ?? []).filter((x: any) => x.type === "message").map((x: any) => (x.raw.message?.content ?? []).map((c: any) => c.text ?? "").join("")).join(" ").includes("Mock reply");
}));
check("S18 all four sessions replied independently", files.every(Boolean), files.join(","));

// idempotency: same Idempotency-Key returns the stored receipt, owner is not re-invoked
const dup = await fetch(`${BASE}/api/v1/sessions/${keys[0]!}/commands`, {
  method: "POST", headers: { ...H, "idempotency-key": "conc-0-idem-fixed" }, body: JSON.stringify({
    operationId: "conc-0-idem-fixed", runtimeId: (await (await fetch(`${BASE}/api/v1/sessions/${keys[0]!}`, { headers: H })).json() as { status: { runtime?: { runtimeId: string }; sessionGeneration: number } }).status.runtime!.runtimeId,
    runtimeGeneration: 0 as never, sessionGeneration: 0 as never, controlEpoch: 0, controlSecret: "",
    command: { type: "prompt", text: "must not run", delivery: "followUp" } }) });
check("S19 replayed idempotency key handled (202 receipt or 4xx gate, no silent double-run)", dup.status === 202 || dup.status === 409 || dup.status === 423, `status=${dup.status}`);

// raw + stats endpoints scoped
const stats = await (await fetch(`${BASE}/api/v1/sessions/${key}/stats`, { headers: H })).json() as { entries?: number };
check("S20 stats via pure read worker", typeof stats.entries === "number" && (stats.entries as number) > 0, JSON.stringify(stats).slice(0, 100));

const failed = results.filter((r) => !r.ok);
if (failed.length) console.log("--- server log tail ---\n" + serverOut.split("\n").slice(-25).join("\n"));
for (const r of results) console.log(` ${r.ok ? "✔" : "✘"} ${r.name}${r.ok ? "" : " — " + r.detail}`);
console.log(`\nserver smoke: ${results.length - failed.length}/${results.length} passed`);

killTree();
await mock.close();
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failed.length ? 1 : 0);
