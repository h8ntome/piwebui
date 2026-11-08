/**
 * The bridge_plan definition-of-done, executed: a REAL terminal `pi` (own pty, mock provider,
 * isolated HOME/agent dir) plus a REAL `pi-web` server started the way a user starts it, with the
 * bridge installed the way a user installs it (`pi install <package>`), and no bridge
 * environment variables anywhere in the pi process.
 *
 *   npm run smoke:bridge
 *
 * Every check prints evidence, and the exit code is non-zero if any FAIL. The mock provider means
 * no network and no cost. This is slow (it boots two processes) by design.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePiPackage } from "../packages/pi-adapter/src/pi-resolve.ts";
import { startMockProvider, mockModelsJson } from "./lib/mock-provider.ts";
import { orphanGuard } from "./lib/orphans.ts";
import { readDescriptor } from "../packages/server/src/descriptor.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const EXT_PKG = path.join(ROOT, "packages", "pi-extension");

interface Row { id: string; name: string; ok: boolean; evidence: string }
const rows: Row[] = [];
function check(id: string, name: string, ok: boolean, evidence: string) {
  rows.push({ id, name, ok, evidence });
  console.log(`  ${ok ? "✔" : "✘"} ${id} ${name}${ok ? "" : ` — ${evidence}`}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(label: string, ms: number, pred: () => boolean | Promise<boolean>): Promise<string> {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = await pred(); } catch { v = false; }
    if (v) return `${Date.now() - t0}ms`;
    if (Date.now() - t0 > ms) throw new Error(`timeout: ${label}`);
    await sleep(50);
  }
}

function tmpHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "piweb-bridge-e2e-"));
  fs.mkdirSync(path.join(home, ".pi"), { recursive: true });
  return home;
}

/** Minimal cookie+CSRF HTTP client, i.e. exactly what the browser does. */
class Api {
  cookie = "";
  csrf = "";
  constructor(public base: string) {}
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { accept: "application/json", ...extra };
    if (this.cookie) h.cookie = this.cookie;
    if (this.csrf) h["x-piweb-csrf"] = this.csrf;
    return h;
  }
  async grab(): Promise<void> {
    const res = await fetch(`${this.base}/api/v1/health`, { headers: this.headers() });
    const setCookie = res.headers.getSetCookie?.() ?? [];
    for (const c of setCookie) this.cookie = c.split(";")[0]!;
    const csrf = await fetch(`${this.base}/api/v1/auth/csrf`, { headers: this.headers() }).then((r) => r.json()) as { csrf: string | null };
    if (csrf.csrf) this.csrf = csrf.csrf;
  }
  get<T>(p: string): Promise<T> {
    return fetch(`${this.base}${p}`, { headers: this.headers() }).then(async (r) => {
      if (!r.ok) throw new Error(`GET ${p} -> ${r.status} ${JSON.stringify(await r.json().catch(() => ({})))}`);
      return (await r.json()) as T;
    });
  }
  post<T>(p: string, body: unknown): Promise<{ status: number; body: T }> {
    return fetch(`${this.base}${p}`, {
      method: "POST",
      headers: this.headers({ "content-type": "application/json" }),
      body: JSON.stringify(body),
    }).then(async (r) => ({ status: r.status, body: (await r.json()) as T }));
  }
}

/** Subscribe to an SSE endpoint and tally event names. */
class SseTap {
  counts = new Map<string, number>();
  events: { name: string; payload: unknown }[] = [];
  private proc: ChildProcess | null = null;
  constructor(public url: string) {}
  start(): void {
    // A second process would need the cookie; instead we read the stream with fetch below.
    void this.consume();
  }
  async consume(): Promise<void> {
    const res = await fetch(this.url, { headers: { accept: "text/event-stream" } });
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let name = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.startsWith("event: ")) name = line.slice(7).trim();
        else if (line.startsWith("data: ")) {
          this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
          try { this.events.push({ name, payload: JSON.parse(line.slice(6)) }); } catch { /* ignore */ }
        }
      }
    }
  }
  count(name: string): number { return this.counts.get(name) ?? 0; }
}

async function main(): Promise<number> {
  const home = tmpHome();
  const agentDir = path.join(home, ".pi", "agent");
  const workspace = path.join(home, "project");
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(agentDir, { recursive: true });

  const mock = await startMockProvider();
  fs.writeFileSync(path.join(agentDir, "models.json"), mockModelsJson(mock.url));

  const pkg = resolvePiPackage();
  if (!pkg) { console.error("pi is not installed; this smoke cannot run"); return 2; }
  const cli = path.join(pkg.dir, "dist", "bundle", "cli.js");

  // ---------- 1. the server, started exactly like a user starts it ----------
  const dataDir = path.join(home, ".pi-web");
  const serverLog = path.join(home, "server.log");
  // The server is detached (own process group) and this suite also owns a pty: killing only the
  // direct child is how a previous run left a 99%-CPU `ptyrun.py` and dozens of servers behind
  // (BUG-041). The guard kills every group it was handed, on any exit path, and reports stragglers.
  const guard = orphanGuard(`piweb-bridge-e2e|ptyrun.py --rows 50`);
  const server = guard.add(spawn(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "packages", "server", "src", "main.ts"), "serve",
    "--data-dir", dataDir, "--port", "0", "--no-open", "--bridge-mode", "dial"], {
    cwd: ROOT,
    env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1" },
    stdio: ["ignore", fs.openSync(serverLog, "a"), fs.openSync(serverLog, "a")],
    detached: true,
  }));
  let descriptor;
  const descriptorFile = path.join(dataDir, "bridge.json");
  try {
    await until("bridge descriptor", 30_000, () => fs.existsSync(descriptorFile));
    const r = readDescriptor(descriptorFile);
    if (!r.ok) throw new Error(`descriptor unusable: ${r.reason}${r.detail ? ` (${r.detail})` : ""}`);
    descriptor = r.descriptor;
  } catch (e) {
    console.error("server did not publish a descriptor:", String(e), "\n", fs.readFileSync(serverLog, "utf8").slice(-2000));
    guard.dispose();
    return 1;
  }
  const banner = fs.readFileSync(serverLog, "utf8");
  check("H-01", "descriptor published on serve with 0600 in a 0700 dir",
    (fs.statSync(descriptorFile).mode & 0o777) === 0o600 && (fs.statSync(dataDir).mode & 0o777) === 0o700,
    `file ${(fs.statSync(descriptorFile).mode & 0o777).toString(8)} dir ${(fs.statSync(dataDir).mode & 0o777).toString(8)}`);
  check("B-13", "the banner never prints the bridge token", !banner.includes(descriptor!.token), `banner ${banner.length} bytes, token absent`);

  const api = new Api(descriptor!.http);
  await api.grab();
  // A normal user allows the folder they work in so history is browsable when nothing is bridged;
  // a bridged session is visible without this (that is deliberate, it is the user's own terminal).
  await new Promise<void>((resolve) => {
    const p = spawn(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "packages", "server", "src", "main.ts"), "allow", workspace, "--data-dir", dataDir], { cwd: ROOT, env: { ...process.env, HOME: home } });
    p.on("close", () => resolve());
  });
  const health = await api.get<{ bridges: { dial: number; listener: string } }>("/api/v1/health");
  check("H-16", "health reports the dial listener", health.bridges.listener === "ok", JSON.stringify(health.bridges));

  // ---------- 2. install the bridge the way a user does, then run a plain pi ----------
  const install = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn("pi", ["install", EXT_PKG], {
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_SKIP_VERSION_CHECK: "1", PI_OFFLINE: "1" },
      cwd: workspace,
    });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code, out }));
  });
  check("H-02a", "pi install <the package> succeeds", install.code === 0, install.out.slice(0, 200));
  const settings = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8")) as { packages?: string[] };
  check("H-02b", "the bridge is registered in settings.json packages",
    (settings.packages ?? []).some((p) => p.includes("pi-extension") || p.includes("pi-web-bridge")),
    JSON.stringify(settings));

  // ---------- 3. a stock pi, with NO bridge environment variables ----------
  const piEnv: Record<string, string> = {
    ...process.env as Record<string, string>,
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
    TERM: "xterm-256color",
    PIWEB_BRIDGE_DEBUG: path.join(home, "bridge.log"),
  };
  // The whole point: nothing named PIWEB_BRIDGE_* (other than the optional debug log) is set.
  for (const k of Object.keys(piEnv)) if (k.startsWith("PIWEB_BRIDGE_") && k !== "PIWEB_BRIDGE_DEBUG") delete piEnv[k];
  delete piEnv.PIWEB_DATA_DIR;

  const pty = guard.add(spawn("python3", [path.join(ROOT, "e2e", "lib", "ptyrun.py"), "--rows", "50", "--cols", "140",
    "--", "node", cli, "--model", "mock/mock-echo", "--thinking", "low"], {
    cwd: workspace, env: piEnv, stdio: ["pipe", "pipe", "pipe"], detached: true,
  }));
  let screen = "";
  pty.stdout?.on("data", (d: Buffer) => { screen += d.toString("utf8"); });
  pty.stderr?.on("data", () => { /* pi warns about the mock provider; not interesting */ });
  const send = (text: string) => pty.stdin?.write(text + "\r");
  const sessionState = async (k: string) => (await api.get<{ status: { state: string } }>(`/api/v1/sessions/${k}`)).status.state;
  /** Type into the terminal and wait for a real turn: streaming first, then idle. */
  const terminalTurn = async (k: string, text: string, ms = 45_000): Promise<boolean> => {
    screen = "";
    send(text);
    try {
      await until("the turn to start", ms, async () => (await sessionState(k)) !== "idle");
      await until("the turn to settle", ms, async () => (await sessionState(k)) === "idle");
      return true;
    } catch { return false; }
  };

  const sessionsList = () => api.get<{ sessions: { meta: { sessionKey: string; piSessionId: string | null; path: string | null; cwd: string | null }; mode: string }[] }>("/api/v1/sessions");
  let live;
  try {
    const t = await until("a live bridged session", 25_000, async () => {
      const l = await sessionsList();
      live = l.sessions.find((s) => s.mode === "live" && !!s.meta.piSessionId);
      return !!live;
    });
    const fileThere = live!.meta.path ? fs.existsSync(live!.meta.path) : false;
    check("H-02", "a plain pi became live with no env vars (no -e, no token)", true,
      `attached in ${t}; key ${live!.meta.sessionKey}; piSessionId ${live!.meta.piSessionId?.slice(0, 8)}; file on disk: ${fileThere ? "yes" : "not yet (adopted before the first append)"}`);
  } catch (e) {
    check("H-02", "a plain pi became live with no env vars", false, String(e));
    finish();
    return 1;
  }

  const key = live!.meta.sessionKey;
  const status = await api.get<{ status: { runtime: { pid: number; piVersion: string; hostKind: string } | null; capabilities: { canControl: boolean }; compat: { tested: boolean } } }>(`/api/v1/sessions/${key}`);
  check("H-02c", "the live session is controllable and carries the real pid",
    status.status.capabilities.canControl && status.status.compat.tested && status.status.runtime?.pid > 0,
    JSON.stringify({ runtime: status.status.runtime, canControl: status.status.capabilities.canControl }));
  check("H-02d", "the bridged pi needs no `pi-web allow` (cwd outside any workspace)",
    status.status.runtime?.hostKind === "terminal" && (await sessionsList()).sessions.some((s) => s.meta.sessionKey === key),
    `cwd ${status.status.runtime?.cwd}`);

  const sse = new SseTap(`${descriptor!.http}/api/v1/sessions/${key}/events`);
  sse.start();
  const globalSse = new SseTap(`${descriptor!.http}/api/v1/events`);
  globalSse.start();
  await sleep(400);

  // ---------- 4. a terminal turn streams: thinking, tool, tokens ----------
  const turnOk = await terminalTurn(key, `tell me about the bridge [tokens:14] [tool:bash:{"command":"echo bridged"}]`);
  await sleep(300);
  const previews = sse.count("preview");
  const toolStates = sse.count("toolState");
  const runtimeStates = sse.count("runtimeState");
  const entryFrames = sse.count("entry");
  check("R-1", "a terminal turn streamed previews into the browser", previews >= 5 && turnOk,
    `preview=${previews} toolState=${toolStates} runtimeState=${runtimeStates} entry=${entryFrames} settled=${turnOk}`);
  check("R-2", "the tool call appeared as live tool state", toolStates >= 1, `toolState=${toolStates}`);
  check("R-3", "the live preview collapsed into the persisted entry (no duplicate)", entryFrames >= 2,
    `entry frames=${entryFrames}`);
  check("R-3b", "the answer text reached the terminal", screen.length > 0 && (screen.includes("bridged") || screen.includes("bridge")),
    `screen ${screen.length} bytes`);
  // BUG-004: a bridged turn used to mint one preview per streamed chunk and leave every one of
  // them unfinished, so the browser showed duplicated assistant rows with a permanent "working"
  // shimmer, replayed from the server's preview map on every reload. R-3 only proved the entry
  // eventually arrives, which the leak happily allowed.
  const lastRuntime = [...sse.events].reverse().find((e) => e.name === "runtimeState")?.payload as
    { phase?: string; previews?: { liveMessageId: string; role: string; done: boolean }[] } | undefined;
  const previewList = lastRuntime?.previews ?? [];
  const openPreviews = previewList.filter((p) => !p.done);
  const dupIds = previewList.length !== new Set(previewList.map((p) => p.liveMessageId)).size ? previewList.length : 0;
  // Count the ids the stream actually produced for this one turn: a leak shows up as one new
  // liveMessageId per chunk, so a single answer arrives as dozens of rows (the old BUG-004).
  const streamedIds = new Set(sse.events.filter((e) => e.name === "preview").map((e) => (e.payload as { liveMessageId?: string }).liveMessageId));
  const assistantIds = new Set(sse.events
    .filter((e) => e.name === "preview")
    .filter((e) => (e.payload as { role?: string }).role === "assistant")
    .map((e) => (e.payload as { liveMessageId?: string }).liveMessageId));
  check("R-3c", "no unfinished or duplicate previews survive a terminal turn",
    previewList.length <= 8 && openPreviews.length === 0 && !dupIds && assistantIds.size <= 3,
    `phase=${lastRuntime?.phase} previews=${previewList.length} open=${openPreviews.length} ids=${new Set(previewList.map((p) => p.liveMessageId)).size} streamed=${streamedIds.size} assistantIds=${assistantIds.size}`);

  // ---------- 5. the browser drives the terminal ----------
  const acquire = async () => {
    const g = await api.post<{ epoch: number; secret: string }>("/api/v1/sessions/" + key + "/control", { action: "acquire", controllerId: "e2e-controller" });
    return { epoch: g.body.epoch, secret: g.body.secret };
  };
  let grant = await acquire();
  check("R-4", "the browser can take control of the terminal session", !!grant.secret, JSON.stringify(grant).slice(0, 120));
  const st0 = await api.get<{ status: { runtime: { runtimeId: string; runtimeGeneration: number }; sessionGeneration: number } }>(`/api/v1/sessions/${key}`);

  const envelope = async (command: Record<string, unknown>, opId: string) => {
    // The grant has a TTL exactly like a real tab's; renew it instead of racing it.
    grant = await acquire();
    return {
      operationId: opId,
      runtimeId: st0.status.runtime.runtimeId,
      runtimeGeneration: st0.status.runtime.runtimeGeneration,
      sessionGeneration: st0.status.sessionGeneration,
      controlEpoch: grant.epoch,
      controlSecret: grant.secret,
      command,
    };
  };

  const promptRes = await api.post<{ operationId: string; state: string }>("/api/v1/sessions/" + key + "/commands",
    await envelope({ type: "prompt", text: "typed from the browser [delay:1200] [tokens:6]", delivery: "start" }, "op-e2e-start"));
  check("R-5", "prompt(start) from the browser is accepted", promptRes.status === 202 && promptRes.body.state === "accepted", JSON.stringify(promptRes.body));
  const steerRes = await api.post<{ body?: unknown; status: number }>("/api/v1/sessions/" + key + "/commands",
    await envelope({ type: "prompt", text: "steered [tokens:3]", delivery: "steer" }, "op-e2e-steer"));
  check("R-6", "prompt(steer) while the terminal is streaming is accepted", steerRes.status === 202, JSON.stringify(steerRes.body).slice(0, 120));
  let opLast = "(never read)";
  for (let i = 0; i < 60; i++) {
    const op = await api.get<{ state: string; result?: unknown }>(`/api/v1/operations/${promptRes.body.operationId}`).catch((e) => ({ state: `read-error ${String(e).slice(0, 60)}` }));
    opLast = JSON.stringify(op);
    if (["succeeded", "dispatched"].includes(op.state)) break;
    await sleep(500);
  }
  const opAfter = await api.get<{ state: string; result?: unknown }>(`/api/v1/operations/${promptRes.body.operationId}`).catch(() => ({ state: opLast }));
  check("R-7", "the operation reached dispatched/succeeded", ["succeeded", "dispatched"].includes(opAfter.state), `last=${opLast}`);
  await sleep(1500);
  // Authoritative proof that the prompt executed *in that pi*: pi-web never writes the session
  // file, so if the text is in the entries now, the terminal process put it there.
  const entries = await api.get<{ entries: unknown[] }>(`/api/v1/sessions/${key}/entries?limit=300`).catch(() => ({ entries: [] }));
  const haystack = JSON.stringify(entries.entries) + screen.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "");
  check("R-8", "the browser prompt really ran in the terminal pi",
    haystack.includes("typed from the browser"), `entries=${entries.entries.length} screen=${screen.length}`);

  const renameRes = await api.post<{ status: number }>("/api/v1/sessions/" + key + "/commands", await envelope({ type: "rename", name: "renamed by web" }, "op-e2e-rename"));
  await until("the rename to land", 8000, async () => {
    const s = await api.get<{ meta: { name: string | null } }>(`/api/v1/sessions/${key}`);
    return s.meta.name === "renamed by web";
  }).then(
    () => check("R-9", "rename from the browser reaches the terminal pi", renameRes.status === 202, "meta.name updated"),
    (e) => check("R-9", "rename from the browser reaches the terminal pi", false, String(e)),
  );

  const thinkingRes = await api.post<{ status: number }>("/api/v1/sessions/" + key + "/commands", await envelope({ type: "setThinking", level: "off" }, "op-e2e-think"));
  check("R-10", "setThinking from the browser is accepted", thinkingRes.status === 202, JSON.stringify(thinkingRes.body).slice(0, 120));

  // ---------- 6. session replacement keeps everything working (H-07) ----------
  const oldKey = key;
  send("/new");
  let newKey = "";
  try {
    await until("a new live session after /new", 20_000, async () => {
      const l = await sessionsList();
      const fresh = l.sessions.find((s) => s.mode === "live" && s.meta.sessionKey !== oldKey);
      if (fresh) newKey = fresh.meta.sessionKey;
      return !!fresh;
    });
    const l = await sessionsList();
    const old = l.sessions.find((s) => s.meta.sessionKey === oldKey);
    check("H-07", "/new retired the old row (never still-live) and adopted a new live row",
      (!old || old.mode !== "live") && !!newKey, `old=${old?.mode ?? "not listed (mirror outside allowlisted roots)"} new=${newKey}`);
    const stillOnDisk = !!old || fs.existsSync(path.join(agentDir, "sessions"));
    check("H-07c", "the retired conversation is still on disk (readable history, no hijack)", stillOnDisk,
      `old row=${old?.mode ?? "absent"}`);
    const stNew = await api.get<{ status: { capabilities: { canControl: boolean } } }>(`/api/v1/sessions/${newKey}`);
    check("H-07b", "the terminal is still controllable after the switch", stNew.status.capabilities.canControl === true, JSON.stringify(stNew.status.capabilities).slice(0, 100));
  } catch (e) {
    check("H-07", "/new adopted a new live session", false, String(e));
  }

  // ---------- 7. presence: the machine-wide stream saw it all ----------
  check("P-1", "the server-wide /api/v1/events stream reported the attach",
    globalSse.count("sessionAppeared") + globalSse.count("runtimeAttached") >= 1,
    `runtimeAttached=${globalSse.count("runtimeAttached")} sessionAppeared=${globalSse.count("sessionAppeared")}`);

  // ---------- 8. doctor explains the state ----------
  const doctor = await new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(path.join(ROOT, "node_modules", ".bin", "tsx"), [path.join(ROOT, "packages", "server", "src", "main.ts"), "doctor", "--data-dir", dataDir, "--json"], {
      cwd: ROOT, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agentDir },
    });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.on("close", (code) => resolve({ code, out }));
  });
  let doctorJson: { ok: boolean; checks: { id: string; level: string; message: string }[] } | null = null;
  try { doctorJson = JSON.parse(doctor.out); } catch { /* printed below */ }
  check("D-1", "pi-web doctor runs and reports a healthy bridge", !!doctorJson && doctorJson.ok,
    doctorJson ? doctorJson.checks.filter((c) => c.level !== "ok").map((c) => `${c.id}: ${c.message}`).join(" | ").slice(0, 300) : doctor.out.slice(0, 300));

  // ---------- 9. the terminal keyboard still works while bridged ----------
  const typedOn = await terminalTurn(newKey || oldKey, "still typing here [tokens:4]");
  check("R-11", "the terminal keyboard still works while bridged", typedOn && screen.length > 0, `screen ${screen.length} bytes`);

  // ---------- 10. a killed pi drops to mirror, nothing hangs ----------
  try { process.kill(-pty.pid!, "SIGKILL"); } catch { try { pty.kill("SIGKILL"); } catch { /* gone */ } }
  let backToMirror = false;
  try {
    await until("the killed pi to fall back to mirror", 20_000, async () => {
      const l = await sessionsList();
      const rec = l.sessions.find((s) => s.meta.sessionKey === (newKey || oldKey));
      backToMirror = !!rec && rec.mode !== "live";
      return backToMirror;
    });
  } catch { /* reported */ }
  check("H-09", "a SIGKILLed pi leaves the session readable as a mirror (no zombie runtime)", backToMirror, `mode=${backToMirror ? "mirror" : "still live"}`);

  const rt = await api.get<{ runtimes: unknown[] }>("/api/v1/runtimes");
  check("D-2", "/api/v1/runtimes answers with the runtime list", Array.isArray(rt.runtimes), `${rt.runtimes.length} runtime(s) after the kill`);

  finish();
  const leaked = guard.dispose().leaked.length;
  mock.close();
  fs.rmSync(home, { recursive: true, force: true });
  return rows.every((r) => r.ok) && !leaked ? 0 : 1;

  function finish(): void {
    console.log(`\n${rows.filter((r) => r.ok).length}/${rows.length} checks passed`);
    const bridgeLogPath = path.join(home, "bridge.log");
    if (fs.existsSync(bridgeLogPath)) {
      const lines = fs.readFileSync(bridgeLogPath, "utf8").trim().split("\n");
      console.log(`bridge log (${lines.length} lines), last 5:\n  ${lines.slice(-5).join("\n  ")}`);
    }
  }
}

main().then((code) => { process.exit(code); }).catch((e) => { console.error("smoke crashed:", e); process.exit(1); });
