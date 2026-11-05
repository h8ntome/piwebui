/**
 * Browser control grants. These arbitrate browser tabs within one runtime generation
 * ONLY. They cannot and do not fence the terminal or other ordinary Pi processes.
 */
import crypto from "node:crypto";
import { CONTROL_TTL_MS, type ControlState } from "@pi-web/shared";
import { Store } from "./store.ts";

function h(s: string): string { return crypto.createHash("sha256").update(s).digest("hex"); }

export interface Grant { controllerId: string; epoch: number; secret: string; expiresAt: number }

export class ControlGrants {
  constructor(private store: Store) {}

  get(sessionKey: string): (Grant & { secret: null }) | null {
    const row = this.store.db
      .prepare("SELECT controller_id, epoch, secret_hash, expires_at FROM control_grants WHERE session_key=?")
      .get(sessionKey) as { controller_id: string; epoch: number; secret_hash: string; expires_at: number } | undefined;
    if (!row) return null;
    return { controllerId: row.controller_id, epoch: row.epoch, secret: null as never, expiresAt: row.expires_at, secretHash: row.secret_hash } as never;
  }

  raw(sessionKey: string) {
    return this.store.db.prepare("SELECT * FROM control_grants WHERE session_key=?").get(sessionKey) as
      | { session_key: string; controller_id: string; epoch: number; secret_hash: string; expires_at: number }
      | undefined;
  }

  state(sessionKey: string, meControllerId?: string): ControlState | null {
    const r = this.raw(sessionKey);
    const now = Date.now();
    if (!r) return { controllerId: null, epoch: 0, expiresAt: null, heldByMe: false };
    const expired = r.expires_at < now;
    return {
      controllerId: expired ? null : r.controller_id,
      epoch: r.epoch,
      expiresAt: expired ? null : new Date(r.expires_at).toISOString(),
      heldByMe: !expired && meControllerId === r.controller_id,
    };
  }

  acquire(sessionKey: string, controllerId: string): { grant: Grant } | { busy: ControlState } {
    const now = Date.now();
    const cur = this.raw(sessionKey);
    if (cur && cur.expires_at >= now && cur.controller_id !== controllerId) {
      return { busy: this.state(sessionKey, controllerId)! };
    }
    const epoch = (cur?.epoch ?? 0) + 1;
    const secret = crypto.randomBytes(18).toString("base64url");
    const expires = now + CONTROL_TTL_MS;
    if (cur) {
      this.store.db.prepare("UPDATE control_grants SET controller_id=?, epoch=?, secret_hash=?, expires_at=? WHERE session_key=?")
        .run(controllerId, epoch, h(secret), expires, sessionKey);
    } else {
      this.store.db.prepare("INSERT INTO control_grants(session_key, controller_id, epoch, secret_hash, expires_at) VALUES(?,?,?,?,?)")
        .run(sessionKey, controllerId, epoch, h(secret), expires);
    }
    return { grant: { controllerId, epoch, secret, expiresAt: expires } };
  }

  renew(sessionKey: string, controllerId: string): { grant: Grant } | { stale: ControlState } | { none: true } {
    const cur = this.raw(sessionKey);
    if (!cur) return { none: true };
    if (cur.controller_id !== controllerId) return { stale: this.state(sessionKey, controllerId)! };
    const expires = Math.max(Date.now(), Math.min(cur.expires_at, Date.now())) + CONTROL_TTL_MS;
    this.store.db.prepare("UPDATE control_grants SET expires_at=? WHERE session_key=?").run(expires, sessionKey);
    return { grant: { controllerId, epoch: cur.epoch, secret: null as never, expiresAt: expires } };
  }

  release(sessionKey: string, controllerId: string): boolean {
    return this.store.db.prepare("DELETE FROM control_grants WHERE session_key=? AND controller_id=?").run(sessionKey, controllerId).changes > 0;
  }

  /** Validate an incoming command envelope; returns ok or a rejection state. */
  validate(sessionKey: string, epoch: number, secret: string): { ok: true } | { ok: false; reason: string } {
    const cur = this.raw(sessionKey);
    if (!cur) return { ok: false, reason: "no controller: acquire control first" };
    if (cur.expires_at < Date.now()) return { ok: false, reason: "control grant expired" };
    if (cur.epoch !== epoch) return { ok: false, reason: "stale control epoch" };
    if (h(secret) !== cur.secret_hash) return { ok: false, reason: "control secret mismatch" };
    return { ok: true };
  }
}
