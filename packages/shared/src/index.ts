export * from "./constants.ts";
export * from "./types.ts";
export * from "./frames.ts";
export { validate, validateQuery, exceedsDepth, CommandEnvelopeSchema, CreateSessionSchema, AddWorkspaceSchema, ControlActionSchema, BootstrapExchangeSchema, ListSessionsQuerySchema, EntriesQuerySchema, FilesQuerySchema, RawQuerySchema, ControlGrantBodySchema } from "./schemas.ts";
export { parseOkhsl, rgbToHex, hexToRgb, contrastRatio, relLuminance, okhslToRgb } from "./okhsl.ts";

/** Canonical JSON stringify (sorted keys) used for operation payload hashes. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
}

export function newOpaqueId(bytes = 12): string {
  const arr = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(arr);
  let bin = "";
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
