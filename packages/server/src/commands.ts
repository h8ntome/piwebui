/**
 * Command dispatch: validation → control → capability/compat/conflict gates →
 * operation reservation → owner dispatch (never awaiting a full run for acceptance).
 */
import {
  DISPATCH_ACK_TIMEOUT_MS,
  type Capabilities,
  type Command,
  type CommandEnvelope,
  type OperationState,
} from "@pi-web/shared";
import { Sessions, type SessionRec } from "./sessions.ts";
import { Operations, sanitizeReceipt } from "./operations.ts";
import { ControlGrants } from "./control.ts";
import { logWarn } from "./log.ts";

export class ApiError extends Error {
  constructor(public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

const KIND_BY_COMMAND: Record<Command["type"], string> = {
  prompt: "prompt", abort: "abort", compact: "compact", setModel: "setModel", setThinking: "setThinking",
  rename: "rename", clearQueue: "clearQueue", dialogResponse: "dialogResponse", stopForTerminal: "stopForTerminal",
};

function capabilityFor(cmd: Command): keyof Capabilities | null {
  switch (cmd.type) {
    case "prompt": return cmd.delivery === "steer" ? "promptSteer" : cmd.delivery === "followUp" ? "promptFollowUp" : "promptStart";
    case "abort": return "abort";
    case "compact": return "compact";
    case "setModel": return "setModel";
    case "setThinking": return "setThinking";
    case "rename": return "rename";
    case "clearQueue": return "clearQueue";
    case "dialogResponse": return "dialogRespond";
    case "stopForTerminal": return "stopForTerminal";
  }
}

export class CommandDispatcher {
  constructor(private sessions: Sessions, private ops: Operations, private control: ControlGrants, private opEvents: OpEventSink) {
    // Owner lifecycle → operation completion mapping.
    this.sessions.opHook = (rec, kind, payload) => this.handleOwnerSignal(rec, kind, payload);
  }

  private handleOwnerSignal(rec: SessionRec, kind: string, payload: Record<string, unknown>) {
    switch (kind) {
      case "agent_settled":
        this.ops.promoteDispatchedToSucceeded(rec.key, { settled: true, aborted: !!payload.aborted });
        this.opEvents.operationsChanged(rec.key);
        break;
      case "run_completed":
        this.ops.completeOne(payload.operationId as string, !!payload.ok, payload.ok ? { ok: true } : { error: { code: "pi_command_failed", message: String(payload.error ?? "").slice(0, 200) } });
        this.opEvents.operationsChanged(rec.key);
        break;
      case "compact_done":
        this.ops.completeOne(payload.operationId as string, !!payload.ok, payload.ok ? { ok: true } : { error: { code: "pi_command_failed", message: String(payload.error ?? "") } });
        this.opEvents.operationsChanged(rec.key);
        break;
      case "compacted":
        this.ops.promoteDispatchedToSucceeded(rec.key, { ok: true });
        this.opEvents.operationsChanged(rec.key);
        break;
      case "compact_failed": {
        const rows = this.ops.activeFor(rec.key).filter((r) => r.kind === "compact");
        for (const r of rows) this.ops.mark(rec, r.operationId, "failed", undefined, { error: { code: "pi_command_failed", message: "compaction failed" } });
        this.opEvents.operationsChanged(rec.key);
        break;
      }
      default: break;
    }
  }

  notifyOwnerDead(rec: SessionRec, intentionalExit: boolean) {
    if (intentionalExit && rec.kind === "managed") {
      // stopForTerminal success path: pending dispatched stopForTerminal ops become succeeded + release.
      const rows = this.ops.activeFor(rec.key).filter((r) => r.kind === "stopForTerminal");
      for (const r of rows) this.ops.mark(rec, r.operationId, "succeeded", "acked", { released: true });
    } else {
      this.ops.ownerLost(rec.key);
    }
    this.opEvents.operationsChanged(rec.key);
  }

  async dispatch(params: {
    principal: string;
    rec: SessionRec;
    envelope: CommandEnvelope;
    idempotencyKey: string;
  }): Promise<{ operationId: string; state: OperationState; duplicate?: boolean }> {
    const { principal, rec, envelope, idempotencyKey } = params;
    const cmd = envelope.command;

    /* ---- gates ---- */
    if (!rec.driver) throw new ApiError("read_only", `No owning runtime for this ${this.sessions.mode(rec)} session; input requires a live bridge or a managed host.`);
    if (rec.conflict) throw new ApiError("read_only", "Session has an unresolved file/ownership conflict; remote writes are frozen until you stop all writers and inspect the branches.");
    const compat = this.sessions.compat(rec);
    if (!compat.tested) throw new ApiError("read_only", compat.detail);
    if (envelope.runtimeId !== rec.driver.runtimeId || envelope.runtimeGeneration !== rec.driver.generation) {
      throw new ApiError("stale_control", "Runtime generation changed (reload/session switch); refresh the page.");
    }
    if (envelope.sessionGeneration !== rec.sessionGeneration) throw new ApiError("stale_control", "Session generation changed on this runtime.");
    const controlOk = this.control.validate(rec.key, envelope.controlEpoch, envelope.controlSecret);
    if (!controlOk.ok) throw new ApiError("stale_control", controlOk.reason);
    const cap = capabilityFor(cmd);
    if (cap && !rec.driver.capabilities[cap as keyof typeof rec.driver.capabilities]) {
      throw new ApiError("unsupported_capability", `This ${rec.kind === "managed" ? "managed host" : "terminal bridge"} does not support ${cmd.type}: ${rec.driver.capabilities.notes?.[0] ?? "see capabilities"}`);
    }
    if (cmd.type === "dialogResponse") {
      const d = rec.state.dialogs.get(cmd.requestId);
      if (!d || d.answered) throw new ApiError("stale_control", "Dialog already answered, expired, or unknown.");
      if (cmd.requestGeneration !== d.requestGeneration) throw new ApiError("stale_control", "Stale dialog generation.");
    }

    /* ---- reservation (before any dispatch) ---- */
    const reservation = this.ops.reserve({
      operationId: envelope.operationId,
      principal,
      rec,
      runtimeGen: rec.driver.generation,
      idemKey: idempotencyKey,
      command: cmd,
      kind: KIND_BY_COMMAND[cmd.type],
    });
    if (!reservation.created) {
      if (!reservation.same) throw new ApiError("idempotency_conflict", "Idempotency key reused with a different payload.");
      return { operationId: reservation.row.id, state: reservation.row.state as OperationState, duplicate: true };
    }
    const opId = reservation.row.id;
    const driver = rec.driver;

    /* ---- dispatch (acceptance never waits for run completion) ---- */
    this.ops.markInvoking(opId);
    this.fireAndTrack(rec, driver, cmd, opId);
    this.opEvents.operationsChanged(rec.key);
    return { operationId: opId, state: "accepted" };
  }

  private fireAndTrack(rec: SessionRec, driver: NonNullable<SessionRec["driver"]>, cmd: Command, opId: string) {
    const finishFailed = (code: string, message: string) => {
      this.ops.mark(rec, opId, "failed", undefined, { error: { code, message: message.slice(0, 200) } });
      this.opEvents.operationsChanged(rec.key);
    };
    const markDispatched = (safe: Record<string, unknown>) => {
      this.ops.mark(rec, opId, "dispatched", "acked", safe);
      this.opEvents.operationsChanged(rec.key);
    };
    try {
      switch (cmd.type) {
        case "prompt": {
          void driver.cmd("prompt", { text: cmd.text, images: cmd.images, delivery: cmd.delivery, operationId: opId }, DISPATCH_ACK_TIMEOUT_MS)
            .then((ack) => markDispatched({ invoked: true, ...(ack as Record<string, unknown>), disposition: (ack as Record<string, unknown>)?.disposition ?? cmd.delivery }))
            .catch((e: Error & { code?: string }) => {
              if (e.code === "timeout") {
                this.ops.mark(rec, opId, "unknown", "ambiguous", { note: "dispatch outcome uncertain; inspect transcript, do not blindly resubmit" });
                this.opEvents.operationsChanged(rec.key);
              } else finishFailed(e.code ?? "pi_command_failed", e.message);
            });
          break;
        }
        case "abort": {
          void driver.cmd("abort", {}, driver.kind === "bridge" ? 10_000 : 60_000)
            .then((res) => {
              if (driver.kind === "managed") this.ops.mark(rec, opId, "succeeded", "acked", { settled: true, ...(res as object) });
              else markDispatched({ requested: true });
              this.opEvents.operationsChanged(rec.key);
            })
            .catch((e: Error & { code?: string }) => finishFailed(e.code ?? "pi_command_failed", e.message));
          break;
        }
        case "compact": {
          if (driver.kind === "bridge") {
            void driver.cmd("compact", { instructions: cmd.instructions, operationId: opId }, DISPATCH_ACK_TIMEOUT_MS)
              .then(() => markDispatched({ started: true }))
              .catch((e: Error & { code?: string }) => {
                if (e.code === "timeout") { this.ops.mark(rec, opId, "unknown", "ambiguous"); this.opEvents.operationsChanged(rec.key); }
                else finishFailed(e.code ?? "pi_command_failed", e.message);
              });
          } else {
            void driver.cmd("compact", { instructions: cmd.instructions }, 600_000)
              .then((res) => { this.ops.mark(rec, opId, "succeeded", "acked", sanitizeReceipt({ ok: true, ...(res as object) })); this.opEvents.operationsChanged(rec.key); })
              .catch((e: Error & { code?: string }) => finishFailed(e.code ?? "pi_command_failed", e.message));
          }
          break;
        }
        case "setModel": {
          void driver.cmd("setModel", { provider: cmd.provider, modelId: cmd.modelId }, 30_000)
            .then((res) => {
              const model = (res as Record<string, Record<string, unknown>>).model ?? {};
              this.ops.mark(rec, opId, "succeeded", "acked", { provider: String(model.provider ?? cmd.provider), modelId: String(model.modelId ?? cmd.modelId) });
              this.opEvents.operationsChanged(rec.key);
            })
            .catch((e: Error & { code?: string }) => finishFailed(e.code ?? "pi_command_failed", e.message));
          break;
        }
        case "setThinking": {
          void driver.cmd("setThinking", { level: cmd.level }, 15_000)
            .then((res) => { this.ops.mark(rec, opId, "succeeded", "acked", { level: (res as Record<string, unknown>).level ?? cmd.level }); this.opEvents.operationsChanged(rec.key); })
            .catch((e: Error & { code?: string }) => finishFailed(e.code ?? "pi_command_failed", e.message));
          break;
        }
        case "rename": {
          void driver.cmd("rename", { name: cmd.name }, 15_000)
            .then(() => { this.ops.mark(rec, opId, "succeeded", "acked", { renamed: true }); this.opEvents.operationsChanged(rec.key); })
            .catch((e: Error & { code?: string }) => finishFailed(e.code ?? "pi_command_failed", e.message));
          break;
        }
        case "dialogResponse": {
          if (driver.kind === "managed" && "dialogAnswer" in driver) {
            void (driver as { dialogAnswer: (id: string, gen: number, v: unknown) => Promise<{ ok: boolean }> })
              .dialogAnswer(cmd.requestId, cmd.requestGeneration, { value: cmd.value, confirmed: cmd.confirmed, cancelled: cmd.cancelled })
              .then(({ ok }) => {
                if (ok) { this.ops.mark(rec, opId, "succeeded", "acked", { resolved: true }); }
                else this.ops.mark(rec, opId, "failed", "acked", { error: { code: "stale_control", message: "dialog already answered/expired" } });
                this.opEvents.operationsChanged(rec.key);
              });
          } else {
            void driver.cmd("dialogRespond", { requestId: cmd.requestId, requestGeneration: cmd.requestGeneration, value: cmd.value, confirmed: cmd.confirmed, cancelled: cmd.cancelled }, 15_000)
              .then(() => { this.ops.mark(rec, opId, "succeeded", "acked", { resolved: true }); this.opEvents.operationsChanged(rec.key); })
              .catch((e: Error & { code?: string }) => finishFailed(e.code ?? "stale_control", e.message));
          }
          break;
        }
        case "stopForTerminal": {
          void driver.cmd("stopForTerminal", { mode: cmd.mode }, 120_000)
            .then(() => markDispatched({ exiting: true }))
            .catch((e: Error & { code?: string }) => finishFailed(e.code ?? "pi_command_failed", e.message));
          break;
        }
        case "clearQueue":
          finishFailed("unsupported_capability", "queue clearing not supported");
          break;
      }
    } catch (e) {
      logWarn("dispatch_error", { kind: cmd.type });
      finishFailed("internal", String((e as Error).message ?? e));
    }
  }
}

export interface OpEventSink {
  operationsChanged(sessionKey: string): void;
}

export function shellEscape(p: string): string {
  return `'${p.replace(/'/g, `'\\''`)}'`;
}
