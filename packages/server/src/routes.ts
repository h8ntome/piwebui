/**
 * REST + SSE surface per plan api_spec.md. All session resources use server-issued
 * opaque sessionKeys; unsupported driver capabilities return 501; unvalidated Pi
 * adapters are read-only (423).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  AddWorkspaceSchema,
  CommandEnvelopeSchema,
  ControlActionSchema,
  CreateSessionSchema,
  ENTRIES_PAGE_DEFAULT,
  ENTRIES_PAGE_MAX,
  EntriesQuerySchema,
  FilesQuerySchema,
  ListSessionsQuerySchema,
  RawQuerySchema,
  SESSIONS_PAGE_MAX,
  SNAPSHOT_ENTRY_PAGE,
  validate, validateQuery,
  newOpaqueId,
  type Capabilities,
  type CommandEnvelope,
  type EntryPage,
  type EntryView,
  type MetaInfo,
  type SessionMeta,
  type SnapshotPayload,
  type WorkspaceInfo,
} from "@piwebui/shared";
import type { AuthService } from "./auth.ts";
import type { Config } from "./auth.ts";
import type { Store } from "./store.ts";
import type { ReadClient } from "./readClient.ts";
import type { StreamHub } from "./hub.ts";
import type { Sessions, SessionRec } from "./sessions.ts";
import type { ControlGrants } from "./control.ts";
import type { Operations } from "./operations.ts";
import { ApiError, shellEscape, type CommandDispatcher } from "./commands.ts";
import { discoverThemes } from "./themes.ts";
import { viewFile, browseDir } from "./files.ts";
import type { BridgeDiscovery } from "./drivers.ts";
import type { BridgeServer } from "./bridgeServer.ts";
import type { BridgeWire } from "./bridgeWire.ts";
import { descriptorPath, readDescriptor, writeDescriptor } from "./descriptor.ts";
import { GLOBAL_STREAM_KEY } from "./sessions.ts";
import { encodeFrame } from "./hub.ts";
import { logWarn } from "./log.ts";

export interface AppCtx {
  cfg: Config;
  auth: AuthService;
  store: Store;
  read: ReadClient;
  hub: StreamHub;
  sessions: Sessions;
  control: ControlGrants;
  ops: Operations;
  dispatcher: CommandDispatcher;
  /** The dial listener (terminal pis connect to it). */
  bridge: BridgeServer;
  /** Adoption wiring behind that listener. */
  wire: BridgeWire;
  /** Pre-1.0 discovery (the server dials each terminal pi); empty unless mode is legacy/both. */
  legacyBridges: BridgeDiscovery;
  bridgeMode: string;
  piPkg: { version: string | null; path: string | null };
  serverId: string;
  startedAt: number;
  manifest: { version: string };
}

function principal(req: FastifyRequest) {
  const ctx = (req as unknown as { ctx: { principal: import("./auth.ts").Principal | null } }).ctx;
  if (!ctx?.principal) throw new ApiError("unauthorized", "no principal");
  return ctx.principal;
}

function visible(sessions: Sessions, rec: SessionRec): boolean {
  if (rec.kind === "managed" || rec.kind === "bridged") return true;
  return rec.workspaceKey !== null;
}

function recByKey(ctx: AppCtx, key: string): SessionRec {
  const rec = ctx.sessions.byKey.get(key);
  if (!rec) throw new ApiError("not_found", "unknown sessionKey");
  if (!visible(ctx.sessions, rec)) throw new ApiError("not_found", "unknown sessionKey");
  return rec;
}

function body<T>(req: FastifyRequest, schema: Parameters<typeof validate>[0]): T {
  const r = validate(schema, req.body);
  if (!r.ok) throw new ApiError("invalid_request", r.errors.join("; "));
  return r.value as T;
}
function query<T>(req: FastifyRequest, schema: Parameters<typeof validate>[0]): T {
  const r = validateQuery(schema, req.query);
  if (!r.ok) throw new ApiError("invalid_request", r.errors.join("; "));
  return r.value as T;
}

export function registerRoutes(app: FastifyInstance, ctx: AppCtx) {
  const { auth, sessions, hub, control, ops, dispatcher, cfg } = ctx;

  /* ---------------- identity (there is no login) ----------------
   * The session cookie is issued by the request pipeline itself (see http.ts), so these two
   * reads only say who you are and hand over the double-submit CSRF token. */
  app.get("/api/v1/auth/me", async (req) => {
    const p = principal(req);
    return { id: p.id, name: p.name, kind: p.kind };
  });

  app.get("/api/v1/auth/csrf", async (req) => {
    const p = principal(req);
    if (p.kind !== "web") return { csrf: null };
    // Rotate: double-submit token bound to the web session (unusable without the cookie).
    const csrf = newOpaqueId(18);
    auth.rotateCsrf(p.id, csrf);
    return { csrf };
  });

  /* ---------------- meta ---------------- */
  app.get("/api/v1/health", async (req) => {
    principal(req);
    const desc = readDescriptor(descriptorPath(cfg.dataDir));
    return {
      ok: true,
      version: ctx.manifest.version,
      uptimeMs: Date.now() - ctx.startedAt,
      serverId: ctx.serverId,
      pi: { resolvedVersion: ctx.piPkg.version, path: ctx.piPkg.path ? "resolved" : null, tested: !!ctx.piPkg.version && isPiVersionAllowed(ctx.piPkg.version) },
      managed: { active: sessions.managedCount(), limit: cfg.maxManaged },
      bridges: {
        dial: ctx.wire.counts().dial,
        legacy: ctx.legacyBridges.handlesSnapshot().length,
        listener: bridgeListenerState(ctx),
        descriptorAgeMs: desc.ok ? Date.now() - Math.floor(new Date(desc.descriptor.updatedAt ?? 0).getTime() || 0) : null,
      },
      mirrors: [...sessions.byKey.values()].filter((r) => !r.driver && r.file.exists).length,
    };
  });

  /* ---------------- bridge diagnostics (D-8: say why) ---------------- */

  app.get("/api/v1/runtimes", async (req) => {
    principal(req);
    const managed = [...sessions.byKey.values()]
      .filter((rec) => rec.kind === "managed" && rec.driver)
      .map((rec) => ({
        runtimeId: rec.driver!.runtimeId,
        transport: "managed" as const,
        serverId: ctx.serverId,
        pid: rec.driver!.pid,
        procStart: 0,
        piVersion: rec.driver!.piVersion,
        piMode: "sdk",
        protocol: 1,
        adapterVersion: ctx.manifest.version,
        cwd: rec.driver!.cwd,
        runtimeGeneration: rec.driver!.generation,
        sessionGeneration: rec.sessionGeneration,
        lastSeq: 0,
        sessions: [{ key: rec.key, piSessionId: rec.meta.piSessionId, mode: sessions.mode(rec) }],
        capabilities: rec.driver!.capabilities,
        lastError: null,
        dropped: { previews: 0, tools: 0, throttled: 0 },
        attested: true,
        trusted: true,
        connectedAt: rec.createdAt,
      }));
    return { serverId: ctx.serverId, mode: ctx.bridgeMode, runtimes: [...ctx.wire.runtimes(), ...managed] };
  });

  app.post("/api/v1/runtimes/:runtimeId/revoke", async (req) => {
    principal(req);
    const { runtimeId } = req.params as { runtimeId: string };
    const dropped = ctx.bridge.revoke(runtimeId);
    if (!dropped) ctx.store.runtimeSetTrusted(runtimeId, false);
    return { ok: true, runtimeId, wasConnected: dropped, trusted: false };
  });

  app.delete("/api/v1/runtimes/:runtimeId", async (req) => {
    principal(req);
    const { runtimeId } = req.params as { runtimeId: string };
    ctx.bridge.revoke(runtimeId);
    const forgot = ctx.store.runtimeSetTrusted(runtimeId, false);
    return { ok: true, runtimeId, forgotten: forgot };
  });

  app.get("/api/v1/bridge/diagnose", async (req) => {
    principal(req);
    const d = ctx.wire.diagnose();
    const file = descriptorPath(cfg.dataDir);
    const desc = readDescriptor(file);
    let ageMs: number | null = null;
    try { ageMs = Date.now() - fs.statSync(file).mtimeMs; } catch { ageMs = null; }
    return {
      ...d,
      mode: ctx.bridgeMode,
      listener: bridgeListenerState(ctx),
      descriptor: desc.ok ? redactDescriptor(desc.descriptor) : { error: desc.reason, path: desc.path },
      descriptorAgeMs: ageMs,
      tokenPresent: desc.ok,
      attestationRequired: cfg.bridge?.requireAttestation !== false,
    };
  });

  app.post("/api/v1/bridge/rotate-token", async (req) => {
    principal(req);
    const next = auth.rotateBridgeToken();
    const file = descriptorPath(cfg.dataDir);
    const current = readDescriptor(file);
    writeDescriptor({
      dataDir: cfg.dataDir,
      serverId: ctx.serverId,
      socket: ctx.bridge.socketPath,
      token: next,
      http: current.ok ? current.descriptor.http : `${cfg.tls ? "https" : "http"}://${cfg.bind}:${cfg.port}`,
      piwebVersion: ctx.manifest.version,
    });
    // Live bridges keep the old secret, so they are told to re-read and then dropped: the bridge
    // rescans its descriptor on `reauth_required` and reconnects inside its retry window.
    ctx.bridge.broadcastControl("reauth_required", { reason: "token_rotated" });
    setTimeout(() => { for (const c of ctx.bridge.connections()) c.die("revoked"); }, 5000).unref?.();
    return { rotated: true, descriptor: file, note: "bridges reconnect within <= 15 s; sessions in flight are untouched" };
  });

  /** Server-wide stream: "a terminal just became controllable" (fixes E15). */
  app.get("/api/v1/events", (req, reply) => {
    principal(req);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    raw.flushHeaders?.();
    const stream = hub.getStream(GLOBAL_STREAM_KEY);
    const write = (frame: string) => { try { raw.write(frame); } catch { /* closed */ } };
    const sub = hub.subscribe(GLOBAL_STREAM_KEY, write, () => { /* the global stream has no snapshot to resync from */ });
    hub.getStream(GLOBAL_STREAM_KEY).goLive(sub);
    void stream;
    req.raw.on("close", () => { hub.getStream(GLOBAL_STREAM_KEY).unsubscribe(sub); });
  });

  app.get("/api/v1/meta", async (req) => {
    principal(req);
    const meta: MetaInfo = {
      limits: {
        maxRequestBytes: 8 * 1024 * 1024, entriesPageMax: ENTRIES_PAGE_MAX, entriesPageDefault: ENTRIES_PAGE_DEFAULT,
        snapshotEntries: SNAPSHOT_ENTRY_PAGE, sessionsPageMax: SESSIONS_PAGE_MAX,
        sseMaxFrames: 5000, sseMaxBytes: 8 * 1024 * 1024,
        sseHeartbeatMs: 15000, sseClientSilenceMs: 45000, controlTtlMs: 30000, maxManagedRuntimes: cfg.maxManaged,
      },
      auth: { cookie: "piweb_session", csrfHeader: "x-piweb-csrf" },
      protocolVersion: 1,
    };
    return meta;
  });

  app.get("/api/v1/capabilities", async (req) => {
    principal(req);
    const tested = !!ctx.piPkg.version && isPiVersionAllowed(ctx.piPkg.version);
    return {
      server: ["rest-v1", "sse-v1", "managed-sessions", "bridge-control", "file-mirror", "bridge-dial", "global-events"],
      pi: { version: ctx.piPkg.version, tested, validated: [...TESTED_PI_VERSIONS], allowedByConfig: allowedPiVersions() },
      bridge: { mode: ctx.bridgeMode, dial: ctx.wire.counts().dial, legacy: ctx.legacyBridges.handlesSnapshot().length },
      drivers: {
        bridge: tested ? bridgeCaps() : "disabled-untested",
        managed: tested ? managedCaps() : "disabled-untested",
        file: { mirror: true, commands: false },
      },
    };
  });

  app.get("/api/v1/themes/current", async (req) => {
    principal(req);
    const t = discoverThemes(cfg.agentDir);
    if ("error" in t) throw new ApiError("not_found", t.error);
    return t;
  });

  /* ---------------- workspaces ---------------- */
  app.get("/api/v1/workspaces", async (req) => {
    principal(req);
    // `pi-web allow <dir>` runs in another process against the same SQLite file: re-read the
    // table so a running server picks the allowlist up without a restart.
    sessions.reloadWorkspaces();
    return { workspaces: [...sessions.workspaces.values()] };
  });
  app.post("/api/v1/workspaces", async (req) => {
    principal(req);
    const { path: p, label } = body<{ path: string; label?: string }>(req, AddWorkspaceSchema);
    const fs = await import("node:fs");
    const path = await import("node:path");
    let real: string;
    try { real = fs.realpathSync(p); } catch { throw new ApiError("invalid_request", "path does not exist"); }
    const st = fs.statSync(real);
    if (!st.isDirectory()) throw new ApiError("invalid_request", "path is not a directory");
    return { workspace: sessions.addWorkspace(real, label) };
  });
  app.delete("/api/v1/workspaces/:key", async (req) => {
    principal(req);
    const { key } = req.params as { key: string };
    if (!sessions.removeWorkspace(key)) throw new ApiError("not_found", "unknown workspaceKey");
    return { ok: true, note: "Allowlist entry removed; in-progress runs were NOT interrupted." };
  });

  /* ---------------- sessions ---------------- */
  app.get("/api/v1/sessions", async (req) => {
    principal(req);
    sessions.reloadWorkspaces();
    const q = query<{ workspaceKey?: string; q?: string; limit?: number; cursor?: string }>(req, ListSessionsQuerySchema);
    await ctx.read.ensure(sessions.sessionRoots());
    let summaries = await ctx.read.call<{ meta: SessionMeta; diagnostics: number }[]>("list", {});
    // Allowlist by header cwd (never by encoded directory names).
    summaries = summaries.filter((s) => sessions.workspaceForCwd(s.meta.cwd ?? "") !== null);
    const recs = summaries.map((s) => {
      const rec = sessions.ensureFromFileNoWatch(s.meta.path!);
      return { meta: { ...s.meta, sessionKey: rec.key, workspaceKey: rec.workspaceKey }, mode: sessions.mode(rec), state: rec.driver ? rec.state.phase : "unavailable" as const };
    });
    // Include live/managed/bridged sessions even without files.
    for (const rec of sessions.byKey.values()) {
      if (rec.path && recs.some((r) => r.meta.path === rec.path)) continue;
      if (!rec.path || recs.every((r) => r.meta.path !== rec.path)) {
        if (rec.driver || !rec.path) recs.push({ meta: { ...rec.meta, sessionKey: rec.key }, mode: sessions.mode(rec), state: rec.state.phase });
      }
    }
    let filtered = recs;
    if (q.workspaceKey) {
      const ws = sessions.workspaces.get(q.workspaceKey);
      filtered = filtered.filter((r) => r.meta.workspaceKey === q.workspaceKey || (ws && r.meta.cwd === ws.path));
    }
    if (q.q) {
      const needle = q.q.toLowerCase();
      filtered = filtered.filter((r) =>
        (r.meta.name ?? "").toLowerCase().includes(needle) ||
        (r.meta.firstPrompt ?? "").toLowerCase().includes(needle) ||
        (r.meta.cwd ?? "").toLowerCase().includes(needle));
    }
    filtered.sort((a, b) => (b.meta.modified ?? "").localeCompare(a.meta.modified ?? ""));
    const limit = q.limit ?? 100;
    const offset = q.cursor ? Number(Buffer.from(q.cursor, "base64url").toString("utf8")) : 0;
    const page = filtered.slice(offset, offset + limit);
    return { sessions: page, nextCursor: offset + limit < filtered.length ? Buffer.from(String(offset + limit)).toString("base64url") : null };
  });

  app.post("/api/v1/sessions", async (req, reply) => {
    principal(req);
    const input = body<{ workspaceKey: string; model?: { provider: string; modelId: string }; thinkingLevel?: string; name?: string }>(req, CreateSessionSchema);
    const ws = sessions.workspaces.get(input.workspaceKey);
    if (!ws) throw new ApiError("not_found", "unknown workspaceKey");
    if (!sessions.hasCapacity()) throw new ApiError("capacity", `managed runtime limit (${cfg.maxManaged}) reached; finish or release a session first`);
    if (!ctx.piPkg.version || !["1.5.0"].includes(ctx.piPkg.version)) throw new ApiError("read_only", "Pi adapter not validated for the resolved Pi version; managed sessions disabled");
    const rec = await createManagedSession(ctx, ws, input);
    reply.code(201);
    return { sessionKey: rec.key, status: sessions.status(rec) };
  });

  app.get("/api/v1/sessions/:key", async (req) => {
    principal(req);
    const rec = recByKey(ctx, (req.params as { key: string }).key);
    sessions.ensureWatch(rec);
    return { meta: rec.meta, status: sessions.status(rec, control.state(rec.key, (req.headers["x-piweb-controller"] as string) ?? undefined)) };
  });

  app.get("/api/v1/sessions/:key/entries", async (req) => {
    principal(req);
    const rec = recByKey(ctx, (req.params as { key: string }).key);
    const q = query<{ cursor?: string; limit?: number; branch?: string; before?: string }>(req, EntriesQuerySchema);
    if (!rec.path) throw new ApiError("not_found", "no persisted file for this session yet");
    if (rec.workspaceKey === null && !rec.driver) throw new ApiError("forbidden", "session outside allowlisted roots");
    await ctx.read.ensure(sessions.sessionRoots());
    try {
      if (q.before != null) {
        return await ctx.read.call<EntryPage & { nextCursor: string | null; olderCursor?: string | null }>("pageBefore", {
          file: rec.path, before: q.before, limit: q.limit ?? ENTRIES_PAGE_DEFAULT,
        });
      }
      const page = await ctx.read.call<EntryPage & { nextCursor: string | null }>("page", { file: rec.path, cursor: q.cursor ?? null, limit: q.limit ?? ENTRIES_PAGE_DEFAULT });
      return page;
    } catch (e) {
      if ((e as { code?: string }).code === "cursor_expired") throw new ApiError("cursor_expired", "page cursor expired; refetch from a fresh snapshot");
      throw e;
    }
  });

  app.get("/api/v1/sessions/:key/entries/:entryId", async (req) => {
    principal(req);
    const rec = recByKey(ctx, (req.params as { key: string }).key);
    if (!rec.path) throw new ApiError("not_found", "no persisted file");
    await ctx.read.ensure(sessions.sessionRoots());
    const entry = await ctx.read.call<EntryView | null>("entry", { file: rec.path, entryId: (req.params as { key: string; entryId: string }).entryId });
    if (!entry) throw new ApiError("not_found", "entry not found");
    return entry;
  });

  app.get("/api/v1/sessions/:key/tree", async (req) => {
    principal(req);
    const rec = recByKey(ctx, (req.params as { key: string }).key);
    const caps = sessions.capabilities(rec);
    if (rec.driver && caps.liveTree) {
      try { return await rec.driver.cmd("tree", {}, 10_000); } catch (e) { logWarn("owner_tree_failed", { err: String((e as Error).message).slice(0, 80) }); }
    }
    if (!rec.path) throw new ApiError("not_found", "no tree source");
    await ctx.read.ensure(sessions.sessionRoots());
    return ctx.read.call("tree", { file: rec.path });
  });

  app.get("/api/v1/sessions/:key/context", async (req) => {
    principal(req);
    const rec = recByKey(ctx, (req.params as { key: string }).key);
    const caps = sessions.capabilities(rec);
    if (rec.driver && caps.runtimeContext && req.headers["x-source"] !== "persisted") {
      try { return await rec.driver.cmd("context", {}, 10_000); } catch { /* fall back to persisted projection */ }
    }
    if (!rec.path) throw new ApiError("not_found", "no persisted file");
    await ctx.read.ensure(sessions.sessionRoots());
    return ctx.read.call("context", { file: rec.path });
  });

  app.get("/api/v1/sessions/:key/stats", async (req) => {
    principal(req);
    const rec = recByKey(ctx, (req.params as { key: string }).key);
    if (!rec.path) throw new ApiError("not_found", "no persisted file");
    await ctx.read.ensure(sessions.sessionRoots());
    const stats = await ctx.read.call<Record<string, unknown>>("stats", { file: rec.path });
    return { ...stats, runtimeUsage: rec.driver ? { note: "runtime usage available via live snapshot", contextUsage: rec.state.contextUsage } : null };
  });

  app.get("/api/v1/sessions/:key/raw", async (req, reply) => {
    principal(req);
    const rec = recByKey(ctx, (req.params as { key: string }).key);
    if (!rec.path) throw new ApiError("not_found", "no file");
    if (rec.workspaceKey === null && !rec.driver) throw new ApiError("forbidden", "session outside allowlisted roots");
    await ctx.read.ensure(sessions.sessionRoots());
    const q = query<{ offset?: number; limit?: number }>(req, RawQuerySchema);
    let offset = q.offset ?? 0;
    let limit = Math.min(q.limit ?? 1024 * 1024, 4 * 1024 * 1024);
    const range = req.headers.range;
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m) {
        if (m[1]) offset = Number(m[1]);
        if (m[2]) limit = Math.min(Number(m[2]) - offset + 1, limit);
      }
    }
    const out = await ctx.read.call<{ base64: string; offset: number; size: number }>("raw", { file: rec.path, offset, limit });
    reply.header("content-type", "application/x-ndjson");
    reply.header("accept-ranges", "bytes");
    reply.header("content-disposition", `attachment; filename="session-${rec.key.slice(2, 10)}.jsonl"`);
    reply.code(206);
    return Buffer.from(out.base64, "base64");
  });

  app.get("/api/v1/sessions/:key/models", async (req) => {
    principal(req);
    const rec = recByKey(ctx, (req.params as { key: string }).key);
    if (!rec.driver || !sessions.capabilities(rec).modelsCatalog) throw new ApiError("unsupported_capability", "no owning runtime exposes a model catalogue");
    return rec.driver.cmd("models", {}, 15_000);
  });

  app.get("/api/v1/sessions/:key/commands", async (req) => {
    principal(req);
    const rec = recByKey(ctx, (req.params as { key: string }).key);
    if (!rec.driver || !sessions.capabilities(rec).commandList) throw new ApiError("unsupported_capability", "no owning runtime exposes the command list");
    return rec.driver.cmd("commands", {}, 10_000);
  });

  /* ---------------- control ---------------- */
  app.get("/api/v1/sessions/:key/control", async (req) => {
    principal(req);
    const rec = recByKey(ctx, (req.params as { key: string }).key);
    return control.state(rec.key, (req.query as { controllerId?: string }).controllerId);
  });

  app.post("/api/v1/sessions/:key/control", async (req) => {
    principal(req);
    const rec = recByKey(ctx, (req.params as { key: string }).key);
    const b = body<{ action: "acquire" | "renew" | "release"; controllerId: string }>(req, ControlActionSchema);
    if (b.action === "acquire") {
      const { controllerId } = b;
      if (!sessions.capabilities(rec).canControl) throw new ApiError("read_only", "this session has no controllable owning runtime");
      const out = control.acquire(rec.key, controllerId);
      if ("busy" in out) throw new ApiError("busy", `another browser tab holds control (since ${out.busy.expiresAt ?? "?"})`);
      hub.emit(rec.key, "controlState", { controllerId, epoch: out.grant.epoch, heldByMe: true });
      return { controllerId, epoch: out.grant.epoch, secret: out.grant.secret, expiresAt: new Date(out.grant.expiresAt).toISOString() };
    }
    if (b.action === "renew") {
      const { controllerId } = b;
      const out = control.renew(rec.key, controllerId);
      if ("stale" in out) throw new ApiError("stale_control", "control is held by another controller");
      if ("none" in out) throw new ApiError("stale_control", "no control grant to renew; acquire first");
      return { ok: true, expiresAt: new Date(out.grant.expiresAt).toISOString() };
    }
    const { controllerId } = b;
    const released = control.release(rec.key, controllerId);
    if (released) hub.emit(rec.key, "controlState", { controllerId: null, epoch: (control.state(rec.key)?.epoch ?? 0), heldByMe: false });
    return { ok: released };
  });

  /* ---------------- commands ---------------- */
  app.post("/api/v1/sessions/:key/commands", async (req, reply) => {
    const p = principal(req);
    const rec = recByKey(ctx, (req.params as { key: string }).key);
    const v = validate(CommandEnvelopeSchema, req.body);
    if (!v.ok) throw new ApiError("invalid_request", v.errors.join("; "));
    const envelope = v.value as CommandEnvelope;
    const idemKey = (req.headers["idempotency-key"] as string) ?? envelope.operationId;
    if (!idemKey || idemKey.length < 8) throw new ApiError("invalid_request", "Idempotency-Key header required");
    const out = await dispatcher.dispatch({ principal: p.id, rec, envelope, idempotencyKey: idemKey });
    reply.code(202);
    return out;
  });

  app.get("/api/v1/operations/:operationId", async (req) => {
    principal(req);
    const rec = ops.get((req.params as { operationId: string }).operationId);
    if (!rec) throw new ApiError("not_found", "unknown operation");
    return rec;
  });

  /* ---------------- files ---------------- */
  app.get("/api/v1/files", async (req) => {
    principal(req);
    const q = query<{ workspaceKey: string; path: string }>(req, FilesQuerySchema);
    const ws = sessions.workspaces.get(q.workspaceKey);
    if (!ws) throw new ApiError("not_found", "unknown workspaceKey");
    return viewFile(ws.path, q.path);
  });

  /* Names-only directory listing for the "select workspace directory" picker. */
  app.get("/api/v1/browse", async (req) => {
    principal(req);
    const q = (req.query ?? {}) as { path?: string };
    return browseDir(q.path ?? "");
  });

  /* ---------------- SSE ---------------- */
  app.get("/api/v1/sessions/:key/events", (req, reply) => {
    const rec = recByKey(ctx, (req.params as { key: string }).key);
    sessions.ensureWatch(rec);
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
      connection: "keep-alive",
    });
    raw.flushHeaders?.();
    const stream = hub.getStream(rec.key);
    const write = (frame: string) => { try { raw.write(frame); } catch { /* closed */ } };
    let snapshotting = false;
    let dirty = true;
    const sendSnapshot = async () => {
      if (snapshotting) return;
      snapshotting = true;
      try {
        while (dirty) {
          dirty = false;
          const snap: SnapshotPayload = await sessions.snapshot(rec);
          snap.barrier = { streamEpoch: 0, seq: sub.barrier };
          const frame = encodeFrame("snapshot", `${stream.epoch}:${sub.barrier}`, {
            name: "snapshot", source: sessions.sourceKind(rec), streamEpoch: stream.epoch, seq: sub.barrier,
            sessionGeneration: rec.sessionGeneration, payload: snap,
          });
          write(frame);
          hub.getStream(rec.key).goLive(sub);
        }
      } catch (e) {
        logWarn("snapshot_failed", { err: String((e as Error).message).slice(0, 100) });
        write(encodeFrame("resync", undefined, { name: "resync", source: "none", streamEpoch: stream.epoch, seq: stream.seq, sessionGeneration: rec.sessionGeneration, payload: { reason: "snapshot_failed" } }));
        dirty = true;
      } finally {
        snapshotting = false;
      }
    };
    const cursor = (req.query as { cursor?: string }).cursor ?? (req.headers["last-event-id"] as string | undefined) ?? null;
    const onResync = () => {
      write(encodeFrame("resync", undefined, { name: "resync", source: "none", streamEpoch: stream.epoch, seq: stream.seq, sessionGeneration: rec.sessionGeneration, payload: { reason: "queue_overflow" } }));
      dirty = true;
      void sendSnapshot();
    };
    const sub = hub.subscribe(rec.key, write, onResync);
    if (cursor) {
      const resume = hub.getStream(rec.key).resume(sub as never, cursor);
      if (resume.ok) {
        hub.getStream(rec.key).goLive(sub);
        return;
      }
      write(encodeFrame("resync", undefined, { name: "resync", source: "none", streamEpoch: stream.epoch, seq: stream.seq, sessionGeneration: rec.sessionGeneration, payload: { reason: resume.reason ?? "resync" } }));
    }
    void sendSnapshot();
    req.raw.on("close", () => { hub.getStream(rec.key).unsubscribe(sub); });
  });
}

/* ---------------- bridge helpers ---------------- */
import fs from "node:fs";
import { TESTED_PI_VERSIONS, allowedPiVersions, isPiVersionAllowed, redactDescriptor } from "@piwebui/shared";

function bridgeListenerState(ctx: AppCtx): string {
  if (ctx.bridgeMode === "off") return "disabled";
  const s = ctx.bridge.statsSnapshot(null, ctx.legacyBridges.handlesSnapshot().length);
  return s.listener === "ok" ? "ok" : String(s.listener);
}

/* ---------------- managed session creation ---------------- */
import { spawnManagedHost } from "./drivers.ts";

async function createManagedSession(ctx: AppCtx, ws: WorkspaceInfo, input: { model?: { provider: string; modelId: string }; thinkingLevel?: string; name?: string }): Promise<SessionRec> {
  const { sessions, cfg } = ctx;
  const key = newOpaqueId(8);
  const rec = sessions.blankRec(key, null, "managed");
  rec.workspaceKey = ws.workspaceKey;
  rec.meta.workspaceKey = ws.workspaceKey;
  rec.meta.cwd = ws.path;
  if (input.name) { rec.meta.name = input.name; rec.state.sessionName = input.name; }
  sessions.attach(rec); // visible immediately; host readiness updates path/runtime afterwards
  const gen = ++managedGen;
  const handle = spawnManagedHost(
    {
      cwd: ws.path,
      ...(cfg.agentDir ? { agentDir: cfg.agentDir } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.thinkingLevel ? { thinkingLevel: input.thinkingLevel } : {}),
      ...(input.name ? { name: input.name } : {}),
    },
    gen,
    ctx.piPkg.path ? { PIWEB_PI_PACKAGE: ctx.piPkg.path } : {},
  );
  rec.driver = handle as unknown as SessionRec["driver"];
  void handle.ready.then(() => {
    if (handle.sessionFile) {
      rec.path = handle.sessionFile;
      rec.meta.path = handle.sessionFile;
      sessions.byPath.set(handle.sessionFile, rec);
      ctx.store.db.prepare("INSERT INTO file_claims(path,owner_kind,owner_id,generation,acquired_at) VALUES(?,?,?,?,?) ON CONFLICT(path) DO NOTHING")
        .run(handle.sessionFile, "managed", handle.runtimeId, gen, new Date().toISOString());
      ctx.store.db.prepare("INSERT OR REPLACE INTO sessions(key,path,kind,workspace_key,created_at,updated_at,origin) VALUES(?,?,?,?,?,?,?)")
        .run(rec.key, handle.sessionFile, "managed", ws.workspaceKey, rec.createdAt, new Date().toISOString(), "browser");
    }
    if (handle.runtimeId !== "pending") rec.driver!.runtimeId = handle.runtimeId;
    sessions.attach(rec);
    hub_emitOwnerChanged(ctx, rec);
  }).catch((e) => {
    logWarn("managed_boot_failed", { err: String((e as Error).message).slice(0, 120) });
    rec.driver = null;
    rec.state.phase = "unknown";
    sessions.attach(rec);
    ctx.hub.emit(rec.key, "hostExited", { reason: "lost", exitCode: null, signal: null });
  });
  handle.onEvent((ev) => sessions.applyDriverEvent(rec, ev as { name: string; payload: Record<string, unknown> }));
  handle.onDead((reason: "exited" | "lost" | "disposed", code: number | null, signal: string | null) => {
    const intentional = handle.intentionalExit;
    if (rec.driver === (handle as unknown as SessionRec["driver"])) rec.driver = null;
    rec.state.phase = "unknown";
    rec.state.previews.clear();
    rec.state.tools.clear();
    rec.state.dialogs.clear();
    ctx.hub.emit(rec.key, "hostExited", { reason: intentional ? "exited" : reason === "disposed" ? "exited" : "crashed", exitCode: code, signal });
    ctx.hub.bumpGeneration(rec.key);
    ctx.dispatcher.notifyOwnerDead(rec, intentional);
    if (intentional && rec.path) {
      rec.released = true;
      ctx.store.db.prepare("DELETE FROM file_claims WHERE path=?").run(rec.path);
    }
    ctx.hub.emit(rec.key, "resync", { reason: "owner_changed" });
    hub_emitOwnerChanged(ctx, rec);
  });
  return rec;
}
let managedGen = 100;
function hub_emitOwnerChanged(ctx: AppCtx, rec: SessionRec) {
  ctx.hub.emit(rec.key, "ownerChanged", { runtime: ctx.sessions.identity(rec), mode: ctx.sessions.mode(rec) });
}

function bridgeCaps(): Partial<Capabilities> {
  return { snapshot: true, livePreview: true, promptStart: true, promptSteer: true, promptFollowUp: true, abort: true, compact: true, setModel: true, setThinking: true, rename: true, dialogObserve: true, dialogRespond: false, queue: "flag" };
}
function managedCaps(): Partial<Capabilities> {
  return { snapshot: true, livePreview: true, promptStart: true, promptSteer: true, promptFollowUp: true, abort: true, compact: true, setModel: true, setThinking: true, rename: true, dialogObserve: true, dialogRespond: true, queue: "full", stopForTerminal: true };
}
void shellEscape;
