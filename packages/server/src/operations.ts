/**
 * Idempotent operation tracking (plan rule 4).
 *
 * - Atomic reservation keyed by (principal, sessionKey, runtimeGeneration, idempotencyKey)
 *   with a canonical payload hash. Same key + different payload => 409.
 * - Dispatch is recorded BEFORE invoking the owner; a crash between invoke and ack is
 *   marked "unknown" and NEVER auto-resubmitted.
 * - Receipts store safe allowlisted result fields only — never transcript text or secrets.
 * - This is deduplicated delivery within a known owner generation, not exactly-once execution.
 */
import crypto from "node:crypto";
import { canonicalJson, OPERATION_RETENTION_MS, type OperationReceipt, type OperationState } from "@pi-web/shared";
import { Store } from "./store.ts";
import type { SessionRec } from "./sessions.ts";

export type DispatchState = "pending" | "invoked" | "acked" | "ambiguous";

interface OpRow {
  id: string; principal: string; session_key: string; runtime_gen: number; idem_key: string;
  payload_hash: string; kind: string; state: OperationState; dispatch_state: DispatchState;
  accepted_at: number; finalized_at: number | null; receipt: string | null;
}

export class Operations {
  constructor(private store: Store) {}

  private hashOf(command: unknown): string {
    return crypto.createHash("sha256").update(canonicalJson(command ?? {})).digest("hex");
  }

  reserve(params: { operationId: string; principal: string; rec: SessionKeyed; runtimeGen: number; idemKey: string; command: unknown; kind: string }):
    { created: true; row: OpRow } | { created: false; row: OpRow; same: boolean } {
    const hash = this.hashOf(params.command);
    const existing = this.store.db.prepare("SELECT * FROM operations WHERE principal=? AND session_key=? AND runtime_gen=? AND idem_key=?")
      .get(params.principal, params.rec.key, params.runtimeGen, params.idemKey) as unknown as OpRow | undefined;
    if (existing) return { created: false, row: existing, same: existing.payload_hash === hash };
    const now = Date.now();
    this.store.db.prepare(
      "INSERT INTO operations(id,principal,session_key,runtime_gen,idem_key,payload_hash,kind,state,dispatch_state,accepted_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(params.operationId, params.principal, params.rec.key, params.runtimeGen, params.idemKey, hash, params.kind, "accepted", "pending", now);
    const row = this.store.db.prepare("SELECT * FROM operations WHERE id=?").get(params.operationId) as unknown as OpRow;
    return { created: true, row };
  }

  mark(rec: SessionKeyed, operationId: string, state: OperationState, dispatch?: DispatchState, safeResult?: Record<string, unknown>) {
    const now = Date.now();
    const terminal = ["succeeded", "failed", "cancelled", "unknown"].includes(state);
    const receipt = safeResult !== undefined ? JSON.stringify(sanitizeReceipt(safeResult)) : undefined;
    if (receipt !== undefined) {
      this.store.db.prepare("UPDATE operations SET state=?, dispatch_state=COALESCE(?, dispatch_state), finalized_at=?, receipt=? WHERE id=?")
        .run(state, dispatch ?? null, terminal ? now : null, receipt, operationId);
    } else {
      this.store.db.prepare("UPDATE operations SET state=?, dispatch_state=COALESCE(?, dispatch_state), finalized_at=? WHERE id=?")
        .run(state, dispatch ?? null, terminal ? now : null, operationId);
    }
    void rec;
  }

  /** Called right before invoking the owner: crash after this point => ambiguous => unknown. */
  markInvoking(operationId: string) {
    this.store.db.prepare("UPDATE operations SET dispatch_state='invoked' WHERE id=?").run(operationId);
  }

  get(operationId: string): OperationReceipt | null {
    const row = this.store.db.prepare("SELECT * FROM operations WHERE id=?").get(operationId) as unknown as OpRow | undefined;
    if (!row) return null;
    return {
      operationId: row.id,
      kind: row.kind,
      state: row.state,
      acceptedAt: new Date(row.accepted_at).toISOString(),
      finalizedAt: row.finalized_at ? new Date(row.finalized_at).toISOString() : null,
      ...(row.receipt ? { result: JSON.parse(row.receipt) } : {}),
    };
  }

  activeFor(sessionKey: string): { operationId: string; state: OperationState; kind: string }[] {
    const rows = this.store.db.prepare("SELECT id,state,kind FROM operations WHERE session_key=? AND state IN ('accepted','dispatched') ORDER BY accepted_at DESC LIMIT 50")
      .all(sessionKey) as unknown as { id: string; state: OperationState; kind: string }[];
    return rows.map((r) => ({ operationId: r.id, state: r.state, kind: r.kind }));
  }

  /** Owner died: anything not finalized becomes unknown (never auto-resubmit). */
  ownerLost(sessionKey: string) {
    this.store.db.prepare("UPDATE operations SET state='unknown', finalized_at=? WHERE session_key=? AND state IN ('accepted','dispatched')").run(Date.now(), sessionKey);
  }

  promoteDispatchedToSucceeded(sessionKey: string, result?: Record<string, unknown>) {
    const rows = this.store.db.prepare("SELECT id,receipt FROM operations WHERE session_key=? AND state='dispatched'").all(sessionKey) as unknown as { id: string; receipt: string | null }[];
    for (const r of rows) {
      if (result !== undefined || r.receipt == null) {
        this.store.db.prepare("UPDATE operations SET state='succeeded', finalized_at=?, receipt=COALESCE(?, receipt) WHERE id=?")
          .run(Date.now(), result !== undefined ? JSON.stringify(sanitizeReceipt(result)) : null, r.id);
      } else {
        this.store.db.prepare("UPDATE operations SET state='succeeded', finalized_at=? WHERE id=?").run(Date.now(), r.id);
      }
    }
  }

  completeOne(operationId: string | null | undefined, ok: boolean, result?: Record<string, unknown>, failCode = "pi_command_failed", failMsg = "owner reported failure") {
    if (!operationId) return;
    const row = this.store.db.prepare("SELECT id FROM operations WHERE id=?").get(operationId) as unknown as { id: string } | undefined;
    if (!row) return;
    this.mark({ key: "" } as never, operationId, ok ? "succeeded" : "failed", "acked", result ?? { error: { code: failCode, message: failMsg } });
  }

  sweep() {
    this.store.db.prepare("DELETE FROM operations WHERE finalized_at IS NOT NULL AND state IN ('succeeded','failed','cancelled') AND finalized_at < ?")
      .run(Date.now() - OPERATION_RETENTION_MS);
    // keep opaque tombstones (row without receipt) for reused-id protection; unknown rows are retained until resolved.
  }
}

interface SessionKeyed { key: string }

/** Allowlisted receipt fields only; never transcript content. */
const SAFE_KEYS = new Set([
  "disposition", "invoked", "dedup", "provider", "modelId", "level", "renamed", "entryId",
  "settled", "aborted", "requested", "started", "exiting", "released", "resolved", "ok", "error", "model", "note",
]);
function sanitizeReceipt(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!SAFE_KEYS.has(k)) continue;
    if (v === null || typeof v === "number" || typeof v === "boolean") out[k] = v;
    else if (typeof v === "string" && v.length <= 200) out[k] = v;
    else if (typeof v === "object") {
      const j = JSON.stringify(v);
      if (j && j.length <= 512) out[k] = JSON.parse(j);
    }
  }
  return out;
}

export { sanitizeReceipt };
export type { OpRow, SessionRec };
