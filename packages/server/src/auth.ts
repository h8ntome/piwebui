import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BOOTSTRAP_CODE_TTL_MS, CSRF_HEADER_NAME, DEFAULT_BIND, DEFAULT_PORT, SESSION_COOKIE_NAME } from "@pi-web/shared";
import { Store } from "./store.ts";

export interface TlsConfig { certFile: string; keyFile: string; }

export interface Config {
  bind: string;
  port: number;
  dataDir: string;
  tls?: TlsConfig;
  /** Allowed Host header values (independent of requests). Port variants accepted automatically. */
  hostsAllow: string[];
  /** Allowed browser Origins for mutations (exact match). */
  originsAllow: string[];
  /** Pi agent dir override (defaults to ~/.pi/agent when reading settings/themes). */
  agentDir: string | null;
  maxManaged: number;
  sessionRootsExtra: string[];
  logLevel: "info" | "warn" | "error";
}

export function defaultDataDir(): string {
  return process.env.PIWEB_DATA_DIR || path.join(os.homedir(), ".pi-web");
}

export function loadConfig(flags: Partial<Config> = {}): Config {
  const dataDir = flags.dataDir || defaultDataDir();
  let fileCfg: Partial<Config> = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(path.join(dataDir, "server.json"), "utf8"));
  } catch { /* first run */ }
  const env: Partial<Config> = {};
  if (process.env.PIWEB_PORT) env.port = Number(process.env.PIWEB_PORT);
  if (process.env.PIWEB_BIND) env.bind = process.env.PIWEB_BIND;
  if (process.env.PIWEB_HOSTS_ALLOW) env.hostsAllow = process.env.PIWEB_HOSTS_ALLOW.split(",").map((s) => s.trim());
  if (process.env.PIWEB_ORIGINS_ALLOW) env.originsAllow = process.env.PIWEB_ORIGINS_ALLOW.split(",").map((s) => s.trim());
  if (process.env.PIWEB_AGENT_DIR) env.agentDir = process.env.PIWEB_AGENT_DIR;
  if (process.env.PIWEB_TLS_CERT && process.env.PIWEB_TLS_KEY) env.tls = { certFile: process.env.PIWEB_TLS_CERT, keyFile: process.env.PIWEB_TLS_KEY };
  const merged = { ...structured({ ...fileCfg, ...env, ...stripUndefined(flags) }) };
  return merged;
}

function stripUndefined(o: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

function structured(c: Record<string, unknown>): Config {
  const bind = (c.bind as string) ?? DEFAULT_BIND;
  const port = (c.port as number) ?? DEFAULT_PORT;
  const hosts = new Set<string>([
    `localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`, `localhost`, `127.0.0.1`, `[::1]`,
    ...(c.hostsAllow as string[] | undefined ?? []),
  ]);
  if (c.hostsAllow) for (const h of c.hostsAllow as string[]) { hosts.add(`${h}:${port}`); hosts.add(h); }
  const origins = new Set<string>([
    `http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`,
    ...(c.originsAllow as string[] | undefined ?? []),
  ]);
  if (c.tls) for (const h of hosts) { if (!origins.has(`https://${h}`)) origins.add(`https://${h}`); }
  return {
    bind, port,
    dataDir: (c.dataDir as string) ?? defaultDataDir(),
    ...(c.tls ? { tls: c.tls as TlsConfig } : {}),
    hostsAllow: [...hosts],
    originsAllow: [...origins],
    agentDir: (c.agentDir as string) ?? null,
    maxManaged: (c.maxManaged as number) ?? 4,
    sessionRootsExtra: (c.sessionRootsExtra as string[]) ?? [],
    logLevel: (c.logLevel as Config["logLevel"]) ?? "info",
  };
}

export function saveConfigDir(cfg: Config) {
  fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
}

function hash(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export function randomSecret(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}

export interface Principal {
  id: string; // "web:<sid>" or "api:<pid>" or "anonymous"
  name: string;
  kind: "web" | "api";
  csrf?: string; // plaintext for web sessions (returned once at exchange)
}

export class AuthService {
  constructor(private store: Store, private cfg: Config) {}

  /** Bridge shared token: created once, used for every bridge socket handshake. */
  bridgeToken(): string {
    let t = this.store.kvGet("bridge_token");
    if (!t) { t = randomSecret(24); this.store.kvSet("bridge_token", t); }
    return t;
  }

  serverId(): string {
    let t = this.store.kvGet("server_id");
    if (!t) { t = randomSecret(8); this.store.kvSet("server_id", t); }
    return t;
  }

  mintBootstrapCode(ttlMs = BOOTSTRAP_CODE_TTL_MS): string {
    const code = crypto.randomBytes(12).toString("base64url");
    this.store.db
      .prepare("INSERT INTO bootstrap_codes(hash, expires_at) VALUES(?, ?)")
      .run(hash(code), Date.now() + ttlMs);
    return code;
  }

  /** One-use exchange: returns a new web principal or null. */
  exchangeBootstrap(code: string): { principal: Principal; csrf: string; cookieValue: string } | null {
    const now = Date.now();
    this.store.db.prepare("DELETE FROM bootstrap_codes WHERE expires_at < ?").run(now);
    const row = this.store.db.prepare("SELECT hash FROM bootstrap_codes WHERE hash=? AND used=0").get(hash(code)) as { hash: string } | undefined;
    if (!row) return null;
    this.store.db.prepare("UPDATE bootstrap_codes SET used=1 WHERE hash=?").run(row.hash);
    return this.createWebSession();
  }

  createWebSession(): { principal: Principal; csrf: string; cookieValue: string } {
    const id = randomSecret(24);
    const csrf = randomSecret(24);
    const hId = hash(id);
    this.store.db
      .prepare("INSERT INTO web_sessions(id, csrf_hash, created_at, last_seen) VALUES(?,?,?,?)")
      .run(hId, hash(csrf), Date.now(), Date.now());
    return { principal: { id: `web:${hId}`, name: "browser", kind: "web", csrf }, csrf, cookieValue: id };
  }

  webSessionByCookie(cookieValue: string): { principal: Principal; csrfOk: (supplied: string | undefined) => boolean } | null {
    if (!cookieValue) return null;
    const h = hash(cookieValue);
    const row = this.store.db.prepare("SELECT csrf_hash FROM web_sessions WHERE id=?").get(h) as { csrf_hash: string } | undefined;
    if (!row) return null;
    this.store.db.prepare("UPDATE web_sessions SET last_seen=? WHERE id=?").run(Date.now(), h);
    return {
      principal: { id: `web:${h}`, name: "browser", kind: "web" },
      csrfOk: (supplied) => !!supplied && hash(supplied) === row.csrf_hash,
    };
  }

  rotateCsrf(principalId: string, csrf: string): boolean {
    const idPart = principalId.startsWith("web:") ? principalId.slice(4) : principalId;
    const res = this.store.db.prepare("UPDATE web_sessions SET csrf_hash=? WHERE id=?").run(hash(csrf), idPart);
    return res.changes > 0;
  }

  logoutWeb(cookieValue: string) {
    this.store.db.prepare("DELETE FROM web_sessions WHERE id=?").run(hash(cookieValue));
  }
  logoutAllWeb() {
    this.store.db.prepare("DELETE FROM web_sessions").run();
  }

  mintApiToken(name: string): { token: string; id: string } {
    const token = "piweb_" + randomSecret(32);
    const id = randomSecret(8);
    this.store.db.prepare("INSERT INTO principals(id, name, token_hash, created_at) VALUES(?,?,?,?)").run(id, name, hash(token), new Date().toISOString());
    return { token, id };
  }
  revokeApiToken(id: string): boolean {
    return this.store.db.prepare("DELETE FROM principals WHERE id=?").run(id).changes > 0;
  }
  listApiTokens(): { id: string; name: string; created_at: string }[] {
    return this.store.db.prepare("SELECT id,name,created_at FROM principals").all() as never;
  }

  principalFromBearer(token: string): Principal | null {
    const row = this.store.db.prepare("SELECT id,name FROM principals WHERE token_hash=?").get(hash(token)) as { id: string; name: string } | undefined;
    if (!row) return null;
    return { id: `api:${row.id}`, name: row.name, kind: "api" };
  }

  hostAllowed(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    const h = hostHeader.toLowerCase();
    return this.cfg.hostsAllow.includes(h);
  }
  originAllowed(origin: string): boolean {
    return this.cfg.originsAllow.includes(origin);
  }
  get csrfHeaderName() { return CSRF_HEADER_NAME; }

  /** Simple token-bucket per principal for non-SSE API traffic. */
  private buckets = new Map<string, { tokens: number; last: number }>();
  rateOk(principalId: string): boolean {
    const now = Date.now();
    const b = this.buckets.get(principalId) ?? { tokens: 600, last: now };
    b.tokens = Math.min(600, b.tokens + ((now - b.last) / 60000) * 600);
    b.last = now;
    if (b.tokens < 1) { this.buckets.set(principalId, b); return false; }
    b.tokens -= 1;
    this.buckets.set(principalId, b);
    if (this.buckets.size > 1000) this.buckets.clear();
    return true;
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const COOKIE_NAME = SESSION_COOKIE_NAME;
