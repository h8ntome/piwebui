import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import {
  ENTRIES_PAGE_MAX,
  MAX_IMAGES_PER_PROMPT,
  MAX_IMAGE_ENCODED_BYTES,
  MAX_JSON_DEPTH,
} from "./constants.ts";

/** Validate + decode against a TypeBox schema. Returns error string list. */
export function validate<T extends TSchema>(schema: T, data: unknown): { ok: true; value: Static<T> } | { ok: false; errors: string[] } {
  if (exceedsDepth(data, MAX_JSON_DEPTH)) return { ok: false, errors: ["max JSON depth exceeded"] };
  const errors = [...Value.Errors(schema, data)];
  if (errors.length > 0) return { ok: false, errors: errors.map((e) => `${(e as { path?: string }).path || "$"}: ${e.message}`) };
  return { ok: true, value: data as Static<T> };
}

/** Query params arrive as strings; Convert coerces numeric/boolean-typed fields before validation. */
export function validateQuery<T extends TSchema>(schema: T, data: unknown): { ok: true; value: Static<T> } | { ok: false; errors: string[] } {
  let converted: unknown = data;
  try { converted = Value.Convert(schema, structuredClone(data)); } catch { converted = data; }
  return validate(schema, converted);
}

export function exceedsDepth(v: unknown, max: number, seen = new Set<unknown>()): boolean {
  if (max <= 0) return false;
  if (v === null || typeof v !== "object") return false;
  if (seen.has(v)) return true;
  seen.add(v);
  const arr = Array.isArray(v) ? v : Object.values(v);
  for (const item of arr) if (exceedsDepth(item, max - 1, seen)) return true;
  seen.delete(v);
  return false;
}

const WireImageSchema = Type.Object({
  mimeType: Type.Union([
    Type.Literal("image/png"),
    Type.Literal("image/jpeg"),
    Type.Literal("image/gif"),
    Type.Literal("image/webp"),
  ]),
  dataBase64: Type.String({ maxLength: MAX_IMAGE_ENCODED_BYTES }),
  name: Type.Optional(Type.String({ maxLength: 256 })),
});

const CommandSchema = Type.Union([
  Type.Object({
    type: Type.Literal("prompt"),
    text: Type.String({ minLength: 1, maxLength: 1_000_000 }),
    images: Type.Optional(Type.Array(WireImageSchema, { maxItems: MAX_IMAGES_PER_PROMPT })),
    delivery: Type.Union([Type.Literal("start"), Type.Literal("steer"), Type.Literal("followUp")]),
  }),
  Type.Object({ type: Type.Literal("abort") }),
  Type.Object({ type: Type.Literal("compact"), instructions: Type.Optional(Type.String({ maxLength: 20_000 })) }),
  Type.Object({ type: Type.Literal("setModel"), provider: Type.String({ minLength: 1, maxLength: 200 }), modelId: Type.String({ minLength: 1, maxLength: 300 }) }),
  Type.Object({ type: Type.Literal("setThinking"), level: Type.String({ minLength: 1, maxLength: 40 }) }),
  Type.Object({ type: Type.Literal("rename"), name: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]) }),
  Type.Object({ type: Type.Literal("clearQueue") }),
  Type.Object({
    type: Type.Literal("dialogResponse"),
    requestId: Type.String({ minLength: 1, maxLength: 200 }),
    requestGeneration: Type.Number(),
    value: Type.Optional(Type.Union([Type.String({ maxLength: 200_000 }), Type.Null()])),
    confirmed: Type.Optional(Type.Boolean()),
    cancelled: Type.Optional(Type.Boolean()),
  }),
  Type.Object({ type: Type.Literal("stopForTerminal"), mode: Type.Union([Type.Literal("settle"), Type.Literal("abort")]) }),
]);

export const CommandEnvelopeSchema = Type.Object({
  operationId: Type.String({ minLength: 8, maxLength: 64 }),
  runtimeId: Type.String({ minLength: 1, maxLength: 128 }),
  runtimeGeneration: Type.Integer({ minimum: 0 }),
  sessionGeneration: Type.Integer({ minimum: 0 }),
  controlEpoch: Type.Integer({ minimum: 0 }),
  controlSecret: Type.String({ minLength: 8, maxLength: 128 }),
  command: CommandSchema,
});

export const CreateSessionSchema = Type.Object({
  workspaceKey: Type.String({ minLength: 1, maxLength: 64 }),
  model: Type.Optional(Type.Object({ provider: Type.String({ minLength: 1, maxLength: 200 }), modelId: Type.String({ minLength: 1, maxLength: 300 }) })),
  thinkingLevel: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })),
  name: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
});

export const AddWorkspaceSchema = Type.Object({
  path: Type.String({ minLength: 1, maxLength: 4096 }),
  label: Type.Optional(Type.String({ maxLength: 120 })),
});

export const ControlActionSchema = Type.Object({
  action: Type.Union([Type.Literal("acquire"), Type.Literal("renew"), Type.Literal("release")]),
  controllerId: Type.String({ minLength: 8, maxLength: 64 }),
});

export const BootstrapExchangeSchema = Type.Object({
  code: Type.String({ minLength: 8, maxLength: 256 }),
});

export const ListSessionsQuerySchema = Type.Object({
  workspaceKey: Type.Optional(Type.String({ maxLength: 64 })),
  q: Type.Optional(Type.String({ maxLength: 200 })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: 200 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
});

export const EntriesQuerySchema = Type.Object({
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  limit: Type.Optional(Type.Number({ minimum: 1, maximum: ENTRIES_PAGE_MAX })),
  branch: Type.Optional(Type.Union([Type.Literal("active"), Type.Literal("all")])),
});

export const FilesQuerySchema = Type.Object({
  workspaceKey: Type.String({ minLength: 1, maxLength: 64 }),
  path: Type.String({ maxLength: 4096 }),
});

export const RawQuerySchema = Type.Object({
  offset: Type.Optional(Type.Number({ minimum: 0 })),
  limit: Type.Optional(Type.Number({ minimum: 1 })),
});

export const ControlGrantBodySchema = Type.Object({
  controllerId: Type.String({ minLength: 8, maxLength: 64 }),
});
