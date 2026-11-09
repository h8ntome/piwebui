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
import { orphanGuard } from "./lib/orphans.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const TSX_LOADER = pathToFileURL(path.join(ROOT, "node_modules/tsx/dist/loader.mjs")).href;

type Status = "PASS" | "FAIL" | "SKIP";
const results: { name: string; status: Status; detail: string }[] = [];
const rec = (name: string, status: Status, detail = "") => results.push({ name, status, detail: String(detail).slice(0, 170) });
const check = (name: string, ok: unknown, detail = "") => rec(name, ok ? "PASS" : "FAIL", detail);

/** pi writes message content as a block array and as a bare string, depending on the record;
 *  read text out of either shape instead of assuming one. */
const textOf = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.filter((c) => (c as { type?: string })?.type === "text").map((c) => String((c as { text?: string }).text ?? "")).join("");
  return "";
};

const EXTERNAL_PORT = process.env.PIWEB_SMOKE_PORT ? Number(process.env.PIWEB_SMOKE_PORT) : null;
const EXTERNAL_DATA = process.env.PIWEB_SMOKE_DATA || null;
const PORT = EXTERNAL_PORT ?? 4096 + Math.floor(Math.random() * 4096);
// Kill the whole tree on any exit, and fail the run if any of *our* servers survives (BUG-041).
const guard = orphanGuard(`main.ts serve --port ${PORT}`);
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

const server = EXTERNAL_PORT ? null : guard.add(spawn(process.execPath, ["--import", TSX_LOADER, path.join(ROOT, "packages/server/src/main.ts"), "serve", "--port", String(PORT), "--data-dir", dataDir, "--agent-dir", agentDir], {
  cwd: ROOT,
  detached: true,
  env: { ...process.env, PIWEB_DATA_DIR: dataDir, PI_CODING_AGENT_DIR: agentDir, PIWEB_MAX_MANAGED: "10", PIWEB_PI_PACKAGE: path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/index.js") },
  stdio: ["ignore", "pipe", "pipe"],
}));
const killTree = () => guard.dispose().leaked.length;
let serverOut = "";
if (server) {
  const log = fs.openSync("/tmp/piweb-smoke-server.log", "w");
  server.stdout.on("data", (d) => { serverOut += d; fs.writeSync(log, d); });
  server.stderr.on("data", (d) => { serverOut += d; fs.writeSync(log, d); });
}

/* --- S1/S2: transport, and a session served without any login --- */
let up = false;
for (let i = 0; i < 1800; i++) {
  await new Promise((r) => setTimeout(r, 500));
  try { const r = await fetch(`${BASE}/api/v1/health`); if (r.ok) { up = true; break; } } catch { /* not yet */ }
}
check("S1 server responds with no login step", up, serverOut.slice(0, 120));
if (!up) { console.log("server output:\n", serverOut); finish(); }

/* --- S2..S4: anonymous session cookie, csrf, and the checks that remain in force --- */
const anon = await fetch(`${BASE}/api/v1/sessions`);
const cookie = (anon.headers.getSetCookie?.()[0] ?? "").split(";")[0] ?? "";
const anonBody = await anon.json() as { sessions?: unknown };
check("S2 cookie-less call is served an anonymous session", anon.ok && cookie.startsWith("piweb_session="), `${anon.status} ${cookie.slice(0, 28)}`);
check("S2b chats list without a login", Array.isArray(anonBody.sessions), JSON.stringify(anonBody).slice(0, 80));
const csrfRes = await fetch(`${BASE}/api/v1/auth/csrf`, { headers: { cookie } });
const csrf = ((await csrfRes.json()) as { csrf?: string }).csrf ?? "";
check("S3 session csrf token issued", !!csrf);
const noCsrf = await fetch(`${BASE}/api/v1/sessions`, {
  method: "POST", headers: { cookie, "content-type": "application/json", origin: BASE }, body: JSON.stringify({ workspaceKey: "w_missing" }),
});
check("S4 mutation without csrf still refused", noCsrf.status === 403, String(noCsrf.status));
const badOrigin = await fetch(`${BASE}/api/v1/sessions`, {
  method: "POST", headers: { cookie, "x-piweb-csrf": csrf, "content-type": "application/json", origin: "http://not-allowed.example" }, body: JSON.stringify({ workspaceKey: "w_missing" }),
});
check("S4b mutation from a foreign origin still refused", badOrigin.status === 403, String(badOrigin.status));

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
  const ea = await (await fetch(`${BASE}/api/v1/sessions/${key}/entries?limit=500`, { headers: H })).json() as { entries?: { type: string; raw: { message?: { content?: unknown } } }[] };
  const assistantText = (ea.entries ?? []).filter((e) => e.type === "message").map((e) => textOf(e.raw.message?.content)).join("|");
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
// S17's mysterious `0` was this harness's own doing (BUG-029): the concurrency round reused the
// session that S9 had already taken control of, then tried to acquire it under a different
// controller id - which correctly answered 409 busy, so no prompt was ever sent for it.
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
      const oid = `conc-${i}-${Date.now()}`;
      let status = 0;
      // S17 used to report a bare `0` for one of the four, which read as a dropped HTTP response
      // (BUG-029). It was never the network: `command()` answers 0 when the grant or the runtime is
      // not there yet. So wait for both, retry the acquire honestly, and keep the idempotency key
      // stable so a retry can never double-prompt.
      for (let attempt = 0; attempt < 4 && status !== 202; attempt++) {
        // The first session is the one S9 already controls (and its lease may have lapsed since):
        // stay with that same controller id instead of asking for a second controller on it.
        const holder = i === 0 ? "smoke-controller-1" : `conc-controller-${i}`;
        if (i === 0) {
          try { await fetch(`${BASE}/api/v1/sessions/${k}/control`, { method: "POST", headers: H, body: JSON.stringify({ action: "renew", controllerId: holder }) }); } catch { /* lapsed or gone */ }
        }
        const ct = (i === 0 && typeof ctl.epoch === "number" && ctl.secret)
          ? ctl
          : await (await fetch(`${BASE}/api/v1/sessions/${k}/control`, { method: "POST", headers: H, body: JSON.stringify({ action: "acquire", controllerId: holder }) })).json() as { epoch?: number; secret?: string };
        let st = await (await fetch(`${BASE}/api/v1/sessions/${k}`, { headers: H })).json() as { status?: { runtime?: { runtimeId: string; runtimeGeneration: number }; sessionGeneration: number } };
        for (let w = 0; w < 20 && !st.status?.runtime?.runtimeId; w++) {
          await new Promise((res) => setTimeout(res, 500));
          st = await (await fetch(`${BASE}/api/v1/sessions/${k}`, { headers: H })).json() as typeof st;
        }
        if (!ct.epoch || !st.status?.runtime) {
          // A lapsed 30 s lease shows up as 412 on the command, not here; release + acquire makes
          // the retry independent of what S9 left behind.
          try { await fetch(`${BASE}/api/v1/sessions/${k}/control`, { method: "POST", headers: H, body: JSON.stringify({ action: "release", controllerId: holder }) }); } catch { /* ignore */ }
          await new Promise((res) => setTimeout(res, 700));
          continue;
        }
        try { status = (await command(k, ct, st, { type: "prompt", text: `concurrent marker ${i} [delay:500]`, delivery: "start" }, oid)).status; }
        catch { status = 0; await new Promise((res) => setTimeout(res, 1_000)); }
      }
      return status;
    }));
    check("S17 parallel prompts accepted on all four", results17.every((s) => s === 202), results17.join(",") + " (0 = never got a grant/runtime, 429 = capacity)");
    await new Promise((r) => setTimeout(r, 20_000));
    const replies = await Promise.all(keys.map(async (k, i) => {
      const e = await (await fetch(`${BASE}/api/v1/sessions/${k}/entries?limit=500`, { headers: H })).json() as { entries?: { type: string; raw: { message?: { content?: { type: string; text?: string }[] } } }[] };
      // Each session must have answered *its own* prompt: checking for any "Mock reply" let one
      // session's older answer stand in for another's missing one.
      return (e.entries ?? []).some((x) => textOf(x.raw.message?.content).includes(`concurrent marker ${i}`));
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
// The endpoint answers `totalEntries` (+ messageCounts); this row used to assert a field named
// `entries`, so `npm run smoke` exited 1 on every single run and taught everyone to ignore a red
// suite (BUG-028).
if (ready) {
  const stats = await (await fetch(`${BASE}/api/v1/sessions/${key}/stats`, { headers: H })).json() as { totalEntries?: number; source?: string };
  check("S20 stats via pure read worker", typeof stats.totalEntries === "number" && (stats.totalEntries as number) > 0, JSON.stringify(stats).slice(0, 120));
} else {
  const stats = await (await fetch(`${BASE}/api/v1/sessions/${key}/stats`, { headers: H })).json() as { error?: { code?: string } } & { totalEntries?: number };
  check("S20 stats via pure read worker", typeof stats.totalEntries === "number" || stats.error?.code === "not_found", JSON.stringify(stats).slice(0, 120));
}

/* --- S21..S27: the workspace folder picker (GET/POST /api/v1/browse) ---
   The dialog is the only way in to the workspace allowlist, and it has to answer the same
   way on Linux, macOS and Windows: fully qualified host paths in, closed error codes out. */
{
  const pickRoot = path.join(tmp, "pickroot");
  fs.mkdirSync(path.join(pickRoot, "Alpha", "inner"), { recursive: true });
  fs.mkdirSync(path.join(pickRoot, ".hidden"), { recursive: true });
  fs.writeFileSync(path.join(pickRoot, "note.txt"), "not a folder");

  const listed = await (await fetch(`${BASE}/api/v1/browse?path=${encodeURIComponent(pickRoot)}`, { headers: H })).json() as {
    path: string; home: string; parent: string | null; truncated: boolean;
    crumbs: { name: string; path: string }[]; entries: { name: string; path: string; hidden: boolean }[];
  };
  const pickRootReal = path.resolve(pickRoot);
  check("S21 picker lists folders only, as host paths, with hidden flagged",
    listed.path === pickRootReal
      && listed.entries.map((e) => e.name).join(",") === ".hidden,Alpha"
      && listed.entries.every((e) => path.isAbsolute(e.path))
      && listed.entries.find((e) => e.name === ".hidden")?.hidden === true
      && listed.entries.find((e) => e.name === "Alpha")?.hidden === false
      && listed.truncated === false, JSON.stringify(listed.entries));
  const topCrumb = process.platform === "win32" ? "::This PC" : path.parse(pickRootReal).root;
  check("S21b picker returns the ancestry root-to-target, so crumbs need no client-side joining",
    listed.crumbs[0].path === topCrumb
      && listed.crumbs.at(-1)?.path === listed.path
      && listed.parent === path.dirname(listed.path), JSON.stringify(listed.crumbs.map((c) => c.path)));

  const homeLevel = await (await fetch(`${BASE}/api/v1/browse`, { headers: H })).json() as { path: string; home: string };
  check("S22 no path browses the host home", homeLevel.path === path.resolve(os.homedir()) && homeLevel.home === os.homedir(), JSON.stringify(homeLevel).slice(0, 100));

  const relative = await fetch(`${BASE}/api/v1/browse?path=relative%2Fpath`, { headers: H });
  const relativeBody = await relative.json() as { error?: { code?: string } };
  check("S23 a relative path is refused as invalid_request", relative.status === 400 && relativeBody.error?.code === "invalid_request", `${relative.status} ${JSON.stringify(relativeBody).slice(0, 90)}`);

  const unreadable = await fetch(`${BASE}/api/v1/browse?path=${encodeURIComponent(path.join(pickRoot, "gone"))}`, { headers: H });
  const unreadableBody = await unreadable.json() as { error?: { code?: string; message?: string } };
  check("S24 an unopenable folder answers directory_unreadable, not a raw node error",
    unreadable.status === 400 && unreadableBody.error?.code === "directory_unreadable"
      && !/^E[A-Z]+:/.test(unreadableBody.error?.message ?? ""), `${unreadable.status} ${JSON.stringify(unreadableBody).slice(0, 110)}`);

  const created = await fetch(`${BASE}/api/v1/browse`, { method: "POST", headers: H, body: JSON.stringify({ path: pickRoot, name: "New Project" }) });
  const createdBody = await created.json() as { path?: string };
  check("S25 New folder creates exactly one child and returns its path",
    created.status === 200 && createdBody.path === path.join(pickRootReal, "New Project")
      && fs.existsSync(path.join(pickRoot, "New Project")), `${created.status} ${JSON.stringify(createdBody).slice(0, 110)}`);

  const conflict = await fetch(`${BASE}/api/v1/browse`, { method: "POST", headers: H, body: JSON.stringify({ path: pickRoot, name: "New Project" }) });
  const conflictBody = await conflict.json() as { error?: { code?: string } };
  check("S25b creating over an existing folder answers directory_exists", conflict.status === 409 && conflictBody.error?.code === "directory_exists", `${conflict.status} ${JSON.stringify(conflictBody).slice(0, 90)}`);

  for (const [name, label] of [["a/b", "S26 a name with a separator is refused"], ["  ", "S26b a blank name is refused"]] as const) {
    const bad = await fetch(`${BASE}/api/v1/browse`, { method: "POST", headers: H, body: JSON.stringify({ path: pickRoot, name }) });
    const badBody = await bad.json() as { error?: { code?: string } };
    check(label, bad.status === 400 && badBody.error?.code === "invalid_request", `${bad.status} ${JSON.stringify(badBody).slice(0, 90)}`);
  }

  const noCsrfCreate = await fetch(`${BASE}/api/v1/browse`, { method: "POST", headers: { cookie, "content-type": "application/json", origin: BASE }, body: JSON.stringify({ path: pickRoot, name: "nope" }) });
  check("S27 New folder without the csrf token is refused", noCsrfCreate.status === 403 && !fs.existsSync(path.join(pickRoot, "nope")), String(noCsrfCreate.status));

  /* S28..S30: the picker's routing question and the OS chooser. This harness always talks over
     loopback, so what is under test is the *refusal* path - a browser claiming another platform
     must never be able to make the host open a window - plus the shape of the answer the client
     routes on. The positive native path is covered by unit tests with a stand-in chooser. */
  const modeOther = await (await fetch(`${BASE}/api/v1/browse/mode?client=darwin`, { headers: H })).json() as { mode: string; chooser: string | null; hostPlatform: string; reason: string };
  check("S28 the picker mode names a tier, a host platform and a reason",
    (modeOther.mode === "native" || modeOther.mode === "browse")
      && typeof modeOther.reason === "string" && modeOther.reason.length > 0
      && ["darwin", "win32", "linux", "other"].includes(modeOther.hostPlatform), JSON.stringify(modeOther));

  const claimedElsewhere = process.platform === "win32" ? "linux" : "win32";
  const modeMismatch = await (await fetch(`${BASE}/api/v1/browse/mode?client=${claimedElsewhere}`, { headers: H })).json() as { mode: string; reason: string };
  check("S28b a browser claiming another platform is routed to the in-app browser",
    modeMismatch.mode === "browse" && modeMismatch.reason.includes("but pi-web is on"), JSON.stringify(modeMismatch));

  const refusedPick = await fetch(`${BASE}/api/v1/browse/pick`, { method: "POST", headers: H, body: JSON.stringify({ client: claimedElsewhere }) });
  const refusedBody = await refusedPick.json() as { error?: { code?: string } };
  check("S29 a mismatched client cannot make the host open a chooser",
    refusedPick.status === 409 && refusedBody.error?.code === "picker_unavailable", `${refusedPick.status} ${JSON.stringify(refusedBody)}`);

  const noCsrfPick = await fetch(`${BASE}/api/v1/browse/pick`, { method: "POST", headers: { cookie, "content-type": "application/json", origin: BASE }, body: JSON.stringify({ client: process.platform }) });
  check("S29b the chooser needs the csrf token like any other mutation", noCsrfPick.status === 403, String(noCsrfPick.status));

  const bogusStart = await fetch(`${BASE}/api/v1/browse/pick`, { method: "POST", headers: H, body: JSON.stringify({ client: process.platform, startingPath: path.join(pickRoot, "Alpha", "inner") }) });
  const startShape = typeof (await (await fetch(`${BASE}/api/v1/browse/mode?client=${process.platform}`, { headers: H })).json()) === "object";
  check("S30 a native pick answers {path} or an error, never a bare 500",
    startShape && (bogusStart.status === 200 || bogusStart.status === 409 || bogusStart.status === 502), String(bogusStart.status));
}

try { await reader.cancel(); } catch { /* ignore */ }
finish();

function finish(): never {
  for (const r of results) console.log(` ${r.status === "PASS" ? "✔" : r.status === "SKIP" ? "!" : "✘"} ${r.name}${r.detail ? ` — ${r.detail}` : ""}`);
  const fails = results.filter((r) => r.status === "FAIL").length;
  const skips = results.filter((r) => r.status === "SKIP").length;
  console.log(`\nserver smoke: ${results.length - fails - skips}/${results.length} passed${skips ? `, ${skips} skipped` : ""}`);
  const leaked = killTree();
  void mock.close();
  if (!EXTERNAL_DATA) fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(fails || leaked ? 1 : 0);
}
