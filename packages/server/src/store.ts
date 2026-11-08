/**
 * Private metadata store (plan D-10): allowlists, control grants, operation receipts,
 * auth principals, session registry. NEVER transcript content or prompt text.
 * Uses node:sqlite (built-in since Node 22.5) so there is no native module to build.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";

/** One row of the `runtimes` table: an attested bridge runtime and its trust state. */
export interface BridgeRuntimeRow {
  runtime_id: string;
  server_id: string | null;
  pid: number | null;
  proc_start: number | null;
  cwd: string | null;
  pi_version: string | null;
  protocol: number | null;
  adapter_version: string | null;
  caps: string | null;
  first_seen: number | null;
  last_seen: number | null;
  trusted: number;
  last_error: string | null;
  dropped_frames: number | null;
  last_seq: number | null;
}

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
    DROP TABLE IF EXISTS bootstrap_codes;
    `);
    // Idempotent column add: SQLite has no `ADD COLUMN IF NOT EXISTS`.
    const cols = new Set((this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name));
    if (!cols.has("pi_session_id")) this.db.exec("ALTER TABLE sessions ADD COLUMN pi_session_id TEXT");
    this.db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_piid ON sessions(pi_session_id) WHERE pi_session_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS runtimes(
      runtime_id TEXT PRIMARY KEY, server_id TEXT, pid INTEGER, proc_start INTEGER, cwd TEXT,
      pi_version TEXT, protocol INTEGER, adapter_version TEXT, caps TEXT,
      first_seen INTEGER, last_seen INTEGER, trusted INTEGER DEFAULT 1, last_error TEXT,
      dropped_frames INTEGER DEFAULT 0, last_seq INTEGER DEFAULT 0);
    `);
  }

  /* ---------------- runtime trust list (bridge_plan 03 §3, §4.2) ---------------- */

  runtimeGet(runtimeId: string): BridgeRuntimeRow | undefined {
    return this.db.prepare("SELECT * FROM runtimes WHERE runtime_id=?").get(runtimeId) as BridgeRuntimeRow | undefined;
  }

  runtimeUpsert(row: Partial<BridgeRuntimeRow> & { runtime_id: string }): void {
    const now = Date.now();
    const existing = this.db.prepare("SELECT first_seen FROM runtimes WHERE runtime_id=?").get(row.runtime_id) as { first_seen: number } | undefined;
    this.db.prepare(`
      INSERT INTO runtimes(runtime_id,server_id,pid,proc_start,cwd,pi_version,protocol,adapter_version,caps,first_seen,last_seen,trusted,last_error,dropped_frames,last_seq)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(runtime_id) DO UPDATE SET
        server_id=excluded.server_id, pid=excluded.pid, proc_start=excluded.proc_start, cwd=excluded.cwd,
        pi_version=excluded.pi_version, protocol=excluded.protocol, adapter_version=excluded.adapter_version,
        last_seen=excluded.last_seen, last_error=excluded.last_error
    `).run(
      row.runtime_id, row.server_id ?? null, row.pid ?? null, row.proc_start ?? null, row.cwd ?? null,
      row.pi_version ?? null, row.protocol ?? null, row.adapter_version ?? null, row.caps ?? null,
      existing?.first_seen ?? now, now, row.trusted ?? 1, row.last_error ?? null, row.dropped_frames ?? 0, row.last_seq ?? 0,
    );
  }

  runtimeSetTrusted(runtimeId: string, trusted: boolean): boolean {
    const r = this.db.prepare("UPDATE runtimes SET trusted=? WHERE runtime_id=?").run(trusted ? 1 : 0, runtimeId);
    return r.changes > 0;
  }

  runtimeNoteSeq(runtimeId: string, seq: number): void {
    this.db.prepare("UPDATE runtimes SET last_seq=MAX(last_seq,?), last_seen=? WHERE runtime_id=?").run(seq, Date.now(), runtimeId);
  }

  runtimeNoteError(runtimeId: string, error: string): void {
    this.db.prepare("UPDATE runtimes SET last_error=? WHERE runtime_id=?").run(error.slice(0, 200), runtimeId);
  }

  runtimeList(): BridgeRuntimeRow[] {
    return this.db.prepare("SELECT * FROM runtimes ORDER BY last_seen DESC LIMIT 200").all() as unknown as BridgeRuntimeRow[];
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
