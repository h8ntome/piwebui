/**
 * Private metadata store (plan D-10): allowlists, control grants, operation receipts,
 * auth principals, session registry. NEVER transcript content or prompt text.
 * Uses node:sqlite (built-in since Node 22.5) so there is no native module to build.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

export class Store {
  db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    this.migrate();
  }
  private migrate() {
    this.db.exec(`
    CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS workspaces(key TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, label TEXT, added_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions(key TEXT PRIMARY KEY, path TEXT UNIQUE, kind TEXT NOT NULL, workspace_key TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, origin TEXT NOT NULL, note TEXT);
    CREATE TABLE IF NOT EXISTS file_claims(path TEXT PRIMARY KEY, owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, generation INTEGER NOT NULL, acquired_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS control_grants(session_key TEXT PRIMARY KEY, controller_id TEXT NOT NULL, epoch INTEGER NOT NULL, secret_hash TEXT NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS operations(
      id TEXT PRIMARY KEY, principal TEXT NOT NULL, session_key TEXT NOT NULL, runtime_gen INTEGER NOT NULL,
      idem_key TEXT NOT NULL, payload_hash TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL,
      dispatch_state TEXT NOT NULL, accepted_at INTEGER NOT NULL, finalized_at INTEGER, receipt TEXT,
      UNIQUE(principal, session_key, runtime_gen, idem_key));
    CREATE INDEX IF NOT EXISTS idx_operations_session ON operations(session_key, accepted_at DESC);
    CREATE TABLE IF NOT EXISTS principals(id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS web_sessions(id TEXT PRIMARY KEY, csrf_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS bootstrap_codes(hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
    `);
  }
  kvGet(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as { value: string } | undefined;
    return r?.value;
  }
  kvSet(key: string, value: string) {
    this.db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }
  close() { this.db.close(); }
}
