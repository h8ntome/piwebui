/**
 * Audit surface check (`full_audit/` of 2026-11-05).
 *
 * No existing suite touched this set of defects: paths outside an allowed root answered 403/500
 * instead of a clean refusal, an orphaned session file reported 403, a bad bearer token was
 * silently downgraded to anonymous, a "delete" had no undo route, a model set at creation came back
 * null, `/raw` truncated without saying so, and several fields lied about their own names.
 * Each row here is one of those; they stay checked because a fix nobody re-tests is a rumour.
 *
 *   npm run smoke:audit
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { orphanGuard } from "./lib/orphans.ts";
import { startMockProvider, mockModelsJson } from "./lib/mock-provider.ts";
import { API_RATE_PER_MINUTE } from "../packages/shared/src/constants.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-audit-"));
const AGENT = path.join(DATA, "agent");
const WS = path.join(DATA, "ws");
const rows: { id: string; ok: boolean; evidence: string }[] = [];
fs.mkdirSync(AGENT, { recursive: true });
fs.mkdirSync(WS, { recursive: true });
fs.writeFileSync(path.join(WS, "hello.txt"), "one\n");
fs.mkdirSync(path.join(AGENT, "sessions", "misc"), { recursive: true });

function check(id: string, ok: boolean, evidence: string) {
  rows.push({ id, ok, evidence });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${id}  ${evidence}`);
}

const mock = await startMockProvider();
fs.writeFileSync(path.join(AGENT, "models.json"), mockModelsJson(mock.url));
fs.writeFileSync(path.join(AGENT, "settings.json"), JSON.stringify({ quietStartup: true }));

const main = path.join(ROOT, "packages", "server", "src", "main.ts");
const serve = spawn(path.join(ROOT, "node_modules", ".bin", "tsx"),
  [main, "serve", "--data-dir", DATA, "--agent-dir", AGENT, "--port", "0", "--no-open"],
  {
    cwd: ROOT,
    env: {
      ...process.env, PIWEB_BRIDGE_DISABLE: "1", PIWEB_MAX_MANAGED: "10",
      PI_CODING_AGENT_DIR: AGENT, PIWEB_PI_PACKAGE: path.join(ROOT, "node_modules/@earendil-works/pi-coding-agent/dist/index.js"),
    },
    stdio: ["ignore", "pipe", "pipe"], detached: true,
  });
// The signature has to be something only this run passes: a broad pattern would report (or be read
// as) every process on the machine.
const guard = orphanGuard(`--data-dir ${DATA}`);
guard.add(serve as ChildProcess);
const log: string[] = [];
serve.stdout?.on("data", (d: Buffer) => log.push(d.toString()));
serve.stderr?.on("data", (d: Buffer) => log.push(d.toString()));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitForPort(): Promise<number> {
  for (let i = 0; i < 160; i++) {
    const m = log.join("").match(/http:\/\/127\.0\.0\.1:(\d+)/);
    if (m) return Number(m[1]);
    await sleep(250);
  }
  throw new Error("server never printed a URL: " + log.join("").slice(-600));
}

let base = "";
let cookie = "";
let csrfTok = "";
type Res = { status: number; json: Record<string, unknown> | null; text: string; headers: Record<string, string> };
async function call(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(base + p, {
    method,
    headers: {
      origin: base,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(cookie ? { cookie } : {}),
      ...(csrfTok ? { "x-piweb-csrf": csrfTok } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  for (const c of r.headers.getSetCookie?.() ?? []) if (c.startsWith("piweb_session=")) cookie = c.split(";")[0]!;
  const text = await r.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* not json */ }
  return { status: r.status, json, text, headers: Object.fromEntries(r.headers) };
}
/** The list route nests the row under `meta`; the live rows do not. Read either. */
type Row = { sessionKey?: string; meta?: { sessionKey?: string; path?: string } };
const rowKey = (r: Row | undefined) => String(r?.meta?.sessionKey ?? r?.sessionKey ?? "");
const errOf = (r: Res) => String((r?.json?.error as { message?: string } | undefined)?.message ?? r?.json?.error ?? r?.text ?? "").slice(0, 130);

async function run() {
  base = `http://127.0.0.1:${await waitForPort()}`;
  // The entry a browser takes: no login; the server issues the session cookie, then CSRF.
  await call("GET", "/api/v1/sessions");
  csrfTok = String((await call("GET", "/api/v1/auth/csrf")).json?.csrf ?? "");
  check("setup: an anonymous session and a CSRF token are issued", !!cookie && !!csrfTok, `${cookie.slice(0, 18)}… csrf=${csrfTok.length} chars`);

  const wsResp = await call("POST", "/api/v1/workspaces", { path: WS, label: "ws" });
  const wk = String((wsResp.json as { workspace?: { workspaceKey?: string } })?.workspace?.workspaceKey ?? "");
  check("an allowed root can be added over the API", !!wk, `workspaceKey=${wk || errOf(wsResp)}`);

  /* ---------------- BUG-043/045: the limit clients are told vs the one enforced ---------------- */
  const meta = (await call("GET", "/api/v1/meta")).json as { limits?: Record<string, number> } | null;
  check("BUG-043 /meta publishes the command rate limit it actually enforces",
    meta?.limits?.rateLimitPerMinute === API_RATE_PER_MINUTE,
    `meta=${meta?.limits?.rateLimitPerMinute} constant=${API_RATE_PER_MINUTE}: a client can back off from the real number`);

  /* ---------------- BUG-006: file paths are refused honestly, not escaped quietly ---------------- */
  const files = (p: string) => call("GET", `/api/v1/files?workspaceKey=${wk}&path=${encodeURIComponent(p)}`);
  const rEtc = await files("/etc");
  check("BUG-006 an absolute directory outside a root is refused with a reason (was 403)",
    (rEtc.status === 404 || rEtc.status === 400) && errOf(rEtc).length > 0, `${rEtc.status} ${errOf(rEtc).slice(0, 70)}`);
  const rPasswd = await files("/etc/passwd");
  check("BUG-006 an absolute file outside a root is a clean 4xx, never a 500",
    rPasswd.status >= 400 && rPasswd.status < 500 && errOf(rPasswd).length > 0, `${rPasswd.status} ${errOf(rPasswd).slice(0, 70)}`);
  const rMissing = await files("zzz-nonexistent");
  check("BUG-006 a missing path is a 404 that says so, not a bare []",
    rMissing.status === 404 && errOf(rMissing).length > 0, `${rMissing.status} ${errOf(rMissing).slice(0, 70)}`);
  const rRoot = await files(".");
  const names = ((rRoot.json?.entries ?? []) as { name: string }[]).map((i) => i.name);
  check("BUG-006 the root listing names what is really there", rRoot.status === 200 && names.includes("hello.txt"), `${rRoot.status} [${names.join(", ")}]`);
  const rAbsInside = await files(path.join(WS, "hello.txt"));
  check("BUG-006 the same file written absolute is refused, not silently served",
    rAbsInside.status >= 400 && rAbsInside.status < 500, `${rAbsInside.status} ${errOf(rAbsInside).slice(0, 60)}`);

  /* ---------------- BUG-007/016/018: what a session reports before it has run ---------------- */
  const created = await call("POST", "/api/v1/sessions", { workspaceKey: wk, name: "named hero", model: { provider: "mock", modelId: "mock-echo" }, thinkingLevel: "high" });
  const key1 = String((created.json as { sessionKey?: string })?.sessionKey ?? "");
  check("BUG-016 a session can be created with a name, a model and a thinking level", created.status === 201 && !!key1, `${created.status} ${errOf(created)}`);
  check("BUG-016 the name survives into the row", (v1meta(await view(key1))) === "named hero", `name=${JSON.stringify((await view(key1)).meta?.name)}`);
  // The host answers its model in the boot handshake; wait for it the way the UI does.
  let st1: Record<string, unknown> = {};
  for (let i = 0; i < 120; i++) {
    st1 = (await view(key1)).status ?? {};
    const rt = (st1.runtime ?? {}) as Record<string, unknown>;
    if ((rt.model as { modelId?: string } | undefined)?.modelId && rt.thinkingLevel) break;
    await sleep(500);
    if (i === 40) console.log("    debug status:", JSON.stringify(st1).slice(0, 400), "\n    log tail:", log.join("").slice(-500));
  }
  check("BUG-007 model and thinking are reported before the first run",
    (st1.runtime as { model?: { modelId?: string } } | undefined)?.model?.modelId === "mock-echo"
    && (st1.runtime as { thinkingLevel?: string } | undefined)?.thinkingLevel === "high",
    `runtime.model=${JSON.stringify((st1.runtime as { model?: unknown } | undefined)?.model)} thinking=${(st1.runtime as { thinkingLevel?: string } | undefined)?.thinkingLevel}`);
  check("BUG-018 the status names the file it reads and says whether it exists",
    !!st1.file && typeof (st1.file as { path?: string }).path === "string" && typeof (st1.file as { exists?: boolean }).exists === "boolean",
    `file=${JSON.stringify(st1.file)?.slice(0, 110)}`);

  /* ---------------- BUG-014/025/034: a file the browser did not start, then one that vanishes ---------------- */
  const orphan = path.join(AGENT, "sessions", "misc", "orphan.jsonl");
  fs.writeFileSync(orphan, JSON.stringify({ type: "session", id: "orph1", timestamp: new Date().toISOString(), cwd: WS, provider: "mock", modelId: "mock-echo" }) + "\n"
    + JSON.stringify({ type: "message", id: "m1", parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "from the terminal" }] } }) + "\n");
  let orph: string | undefined;
  for (let i = 0; i < 40 && !orph; i++) {
    const list = (await call("GET", "/api/v1/sessions")).json as { sessions?: Row[] } | null;
    orph = rowKey((list?.sessions ?? []).find((x) => String(x.meta?.path).endsWith("orphan.jsonl")));
    if (!orph) await sleep(500);
  }
  check("BUG-014 a session file in an allowed root is adopted for reading", !!orph, orph ?? "never listed");
  if (orph) {
    const ov = await call("GET", `/api/v1/sessions/${orph}`);
    const osv = (ov.json as { status?: Record<string, unknown> }).status ?? {};
    check("BUG-014 reading an adopted file is allowed (it answered 403)", ov.status === 200, `${ov.status} ${errOf(ov)}`);
    check("BUG-034 the mode comes from the filesystem, and state is not a misleading spinner",
      osv.mode !== "no file" && osv.state !== "unknown", `mode=${osv.mode} state=${osv.state}`);
    check("BUG-018 the status names the file it is reading", !!(osv.file as { path?: string; exists?: boolean } | null)?.exists,
      `file=${JSON.stringify(osv.file)?.slice(0, 90)}`);
    const delOrph = await call("DELETE", `/api/v1/sessions/${orph}`);
    check("BUG-015 DELETE /sessions/:key forgets the chat (the file stays on disk)", delOrph.status === 200 || delOrph.status === 204, `${delOrph.status} ${errOf(delOrph)}`);
    check("BUG-015 the file itself is untouched by a pi-web delete", fs.existsSync(orphan), orphan);
    const hidden = (await call("GET", "/api/v1/hidden-sessions")).json as { sessions?: unknown[]; note?: string } | null;
    check("BUG-016 the hidden list names the deleted path and how to undo it",
      JSON.stringify(hidden?.sessions ?? []).includes("orphan.jsonl") && /unhide|bring|back/i.test(hidden?.note ?? ""),
      `${JSON.stringify(hidden?.sessions).slice(0, 90)} note=${String(hidden?.note).slice(0, 40)}`);
    const unhide = await call("DELETE", `/api/v1/hidden-sessions?path=${encodeURIComponent(orphan)}`);
    check("BUG-016 unhide puts it back", (unhide.status === 204 || unhide.status === 200) && unhide.json?.ok === true, `${unhide.status} ${errOf(unhide)}`);
    fs.rmSync(orphan);
    const vanished = await call("GET", `/api/v1/sessions/${orph}`);
    check("BUG-025 a vanished file says so instead of a blank ok (was a stale read)",
      vanished.status === 404 || String(errOf(vanished)).length > 10, `${vanished.status} ${errOf(vanished).slice(0, 90)}`);
  }

  /* ---------------- BUG-015: deleting a live managed session ---------------- */
  const del = await call("DELETE", `/api/v1/sessions/${key1}`);
  check("BUG-015 DELETE works on a managed session too", del.status === 200 || del.status === 204, `${del.status} ${errOf(del)}`);
  const gone = await call("GET", `/api/v1/sessions/${key1}`);
  check("BUG-015 the removed chat stays gone across a refresh", gone.status === 404, `${gone.status}`);

  /* ---------------- BUG-030/028/034/044: a big mirror file ---------------- */
  const bigFile = path.join(AGENT, "sessions", "misc", "big.jsonl");
  const lines = [JSON.stringify({ type: "session", id: "big1", timestamp: new Date().toISOString(), cwd: WS, provider: "mock", modelId: "mock-echo" })];
  // Big enough that the default 1 MiB page really is partial: the honest `Content-Range` answer
  // (BUG-030) only exists to be tested if the file passes the cap.
  for (let i = 0; i < 5_000; i++) lines.push(JSON.stringify({ type: "message", id: `b${i}`, parentId: null, timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: `line ${i} ${"x".repeat(200)}` }] } }));
  fs.writeFileSync(bigFile, lines.join("\n") + "\n");
  let big: string | undefined;
  for (let i = 0; i < 40 && !big; i++) {
    const list = (await call("GET", "/api/v1/sessions")).json as { sessions?: Row[] } | null;
    big = rowKey((list?.sessions ?? []).find((x) => String(x.meta?.path).endsWith("big.jsonl")));
    if (!big) await sleep(500);
  }
  check("a large mirrored session is listed", !!big, big ?? "never listed");
  if (big) {
    const total = fs.statSync(bigFile).size;
    const raw = await fetch(`${base}/api/v1/sessions/${big}/raw`, { headers: { cookie } });
    const served = (await raw.text()).length;
    check("BUG-030 /raw says out loud when the body is only part of the file (it used to answer 200 + a silent truncation)",
      served === total || (raw.status === 206 && /^bytes 0-\d+\/\d+$/.test(raw.headers.get("content-range") ?? "") && served < total),
      `status=${raw.status} range=${raw.headers.get("content-range") ?? "none"} served=${served} of ${total}`);
    const full = await fetch(`${base}/api/v1/sessions/${big}/raw?limit=4194304`, { headers: { cookie } });
    const fullLen = (await full.text()).length;
    check("BUG-030 asking for the whole file gets the whole file as 200", full.status === 200 && fullLen === total, `status=${full.status} bytes=${fullLen} of ${total}`);

    const stats = (await call("GET", `/api/v1/sessions/${big}/stats`)).json as Record<string, unknown> | null;
    check("BUG-028 stats exposes totalEntries (the field that exists)", typeof stats?.totalEntries === "number", `totalEntries=${stats?.totalEntries} usageSource=${stats?.usageSource}`);
    const page = (await call("GET", `/api/v1/sessions/${big}/entries?limit=50`)).json as Record<string, unknown> | null;
    check("BUG-034 entryCount counts the session, pageCount the page",
      page?.pageCount === 50 && Number(page?.entryCount) > 50, `entryCount=${page?.entryCount} pageCount=${page?.pageCount}`);

    const noKey = await call("POST", `/api/v1/sessions/${big}/commands`,
      { operationId: "short", command: { type: "abort" }, runtimeId: "r", runtimeGeneration: 1, sessionGeneration: 1, controlEpoch: 1, controlSecret: "controller-secret-long-enough" });
    check("BUG-044 the idempotency error names the rule that is enforced",
      !String(errOf(noKey)).includes("Idempotency-Key header required") && /8 characters|operationId|Idempotency/i.test(errOf(noKey)),
      `${noKey.status} ${errOf(noKey).slice(0, 110)}`);
    const noControl = await call("POST", `/api/v1/sessions/${big}/commands`,
      { operationId: `mirror-${Date.now()}abcdefghijkl`, command: { type: "abort" }, runtimeId: "r", runtimeGeneration: 1, sessionGeneration: 1, controlEpoch: 1, controlSecret: "controller-secret-long-enough" });
    check("BUG-032 a mirror session refuses a command with a reason, not silence",
      noControl.status >= 400 && errOf(noControl).length > 10, `${noControl.status} ${errOf(noControl).slice(0, 90)}`);
  } else check("BUG-030 /raw honesty", false, "the mirrored session was never listed");

  /* ---------------- BUG-012: a bad token is refused, not anonymised ---------------- */
  const bad = await fetch(`${base}/api/v1/meta`, { headers: { authorization: "Bearer definitely-not-a-token" } });
  const badBody = await bad.text().catch(() => "");
  check("BUG-012 an unknown bearer token is 401, not a silent anonymous session", bad.status === 401, `${bad.status} ${badBody.slice(0, 80)}`);
  const keepCsrf = csrfTok; csrfTok = "";
  const noCsrf = await call("POST", "/api/v1/workspaces", { path: DATA });
  csrfTok = keepCsrf;
  check("CSRF is still enforced on mutations", noCsrf.status === 403, `${noCsrf.status} ${errOf(noCsrf)}`);

  /* ---------------- the stream still opens with a snapshot, notices included ---------------- */
  const evt = (await call("POST", "/api/v1/sessions", { workspaceKey: wk })).json as { sessionKey?: string } | null;
  const sse = await fetch(`${base}/api/v1/sessions/${evt!.sessionKey}/events`, { headers: { cookie, accept: "text/event-stream" } });
  const reader = sse.body!.getReader();
  const first = new TextDecoder().decode((await reader.read()).value ?? new Uint8Array());
  try { await reader.cancel(); } catch { /* ignore */ }
  check("the session stream opens with a snapshot", sse.status === 200 && first.includes("event: snapshot"), `status=${sse.status} ${first.slice(0, 32).replace(/\n/g, " ")}`);

  const fails = rows.filter((r) => !r.ok).length;
  console.log(`\naudit surface: ${rows.length - fails}/${rows.length} passed`);
  const leaked = guard.dispose().leaked.length;
  mock.close();
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(fails || leaked ? 1 : 0);
}

async function view(key: string) {
  const r = await call("GET", `/api/v1/sessions/${key}`);
  return (r.json ?? {}) as { meta?: { name?: string }; status?: Record<string, any> };
}
const v1meta = (v: { meta?: { name?: string } }) => v.meta?.name;

void run().catch((e) => { console.error(e); guard.dispose(); mock.close(); process.exit(1); });
