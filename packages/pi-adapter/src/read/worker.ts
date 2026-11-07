/**
 * Isolated read worker process. This is one of the few places pi-web imports Pi, and it
 * imports ONLY the pure exported helpers (never SessionManager.open on originals).
 * It loads no extensions, trust prompts or credentials.
 *
 * Protocol: process IPC ({id, op, args} in, {id, ok, data|error} out).
 * Roots are passed via PIWEB_READ_ROOTS (JSON array) and re-checked on every request.
 */
import path from "node:path";
import { open, stat } from "node:fs/promises";
import { buildTree, computeStats, encodeCursor, fileIdentity, listSessionFiles, projectContext, readEntryById, readEntryPage, readEntryTail, safeRealpath, summarizeSessionFile } from "./pure.ts";
import { importPi, resolvePiPackage } from "../pi-resolve.ts";
import { FINGERPRINT_BYTES } from "../tail.ts";
import { MAX_FILE_VIEW_BYTES, RAW_RANGE_MAX_BYTES } from "@piwebui/shared";

const rootsRaw = process.env.PIWEB_READ_ROOTS ?? "[]";
let roots: string[] = JSON.parse(rootsRaw);

function refreshRoots() {
  try {
    roots = JSON.parse(process.env.PIWEB_READ_ROOTS ?? "[]");
  } catch {
    /* keep previous roots */
  }
}

async function assertAllowed(file: string): Promise<string> {
  const real = await safeRealpath(file);
  const ok = roots.some((r) => {
    const rel = path.relative(r, real);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
  if (!ok) throw Object.assign(new Error("path outside registered session roots"), { code: "forbidden" });
  return real;
}

const summaryCache = new Map<string, { genId: string; summary: Awaited<ReturnType<typeof summarizeSessionFile>> }>();

async function opList(args: { roots?: string[] }) {
  refreshRoots();
  const scanRoots = args.roots ?? roots;
  const out: unknown[] = [];
  for (const root of scanRoots) {
    const realRoot = await safeRealpath(root);
    if (!roots.some((r) => r === realRoot)) continue;
    const files = await listSessionFiles(realRoot);
    for (const f of files) {
      try {
        const ident = await fileIdentity(f);
        if (!ident) continue;
        const cached = summaryCache.get(f);
        if (cached && cached.genId === ident.genId) {
          out.push(cached.summary);
          continue;
        }
        const summary = await summarizeSessionFile(f, "", null);
        summaryCache.set(f, { genId: ident.genId, summary });
        out.push(summary);
      } catch {
        /* ignore unreadable individual files */
      }
    }
  }
  return out;
}

const handlers: Record<string, (a: any) => Promise<unknown>> = {
  health: async () => {
    const pkg = resolvePiPackage();
    return { piVersion: pkg?.version ?? null, fingerprint: pkg?.fingerprint ?? null, roots };
  },
  list: opList as never,
  page: async ({ file, cursor, limit }) => {
    const f = await assertAllowed(file);
    return readEntryPage(f, cursor ?? null, Math.max(1, Math.min(1000, limit ?? 200)));
  },
  pageTail: async ({ file, limit }) => {
    const f = await assertAllowed(file);
    return readEntryTail(f, limit ?? 300);
  },
  entry: async ({ file, entryId }) => {
    const f = await assertAllowed(file);
    return readEntryById(f, String(entryId));
  },
  tree: async ({ file }) => {
    const f = await assertAllowed(file);
    return buildTree(f);
  },
  context: async ({ file }) => {
    const f = await assertAllowed(file);
    return projectContext(f, importPi);
  },
  stats: async ({ file }) => {
    const f = await assertAllowed(file);
    return computeStats(f);
  },
  raw: async ({ file, offset = 0, limit = 1024 * 1024 }) => {
    const f = await assertAllowed(file);
    const st = await stat(f);
    const len = Math.max(0, Math.min(Number(limit), RAW_RANGE_MAX_BYTES, st.size - Number(offset)));
    const fh = await open(f, "r");
    try {
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, Number(offset));
      return { base64: buf.subarray(0, bytesRead).toString("base64"), offset: Number(offset), size: st.size };
    } finally {
      await fh.close();
    }
  },
  identity: async ({ file }) => {
    const f = await assertAllowed(file);
    const ident = await fileIdentity(f);
    if (!ident) throw Object.assign(new Error("not found"), { code: "not_found" });
    return ident;
  },
  tailFingerprint: async ({ file }) => {
    const f = await assertAllowed(file);
    const st = await stat(f);
    const len = Math.min(FINGERPRINT_BYTES, st.size);
    const fh = await open(f, "r");
    try {
      const buf = Buffer.allocUnsafe(len);
      const { bytesRead } = await fh.read(buf, 0, len, st.size - len);
      return { genId: (await fileIdentity(f))?.genId, tail: buf.subarray(0, bytesRead).toString("base64"), size: st.size };
    } finally {
      await fh.close();
    }
  },
  fileView: async ({ file }: { file: string }) => {
    // Files drawer reads are authorized by the server's workspace containment BEFORE
    // dispatching here; this worker additionally refuses huge files and dotfile paths
    // are filtered server-side.
    const st = await stat(file);
    if (st.size > MAX_FILE_VIEW_BYTES) return { kind: "too_large", path: file, sizeBytes: st.size };
    const fh = await open(file, "r");
    try {
      const buf = Buffer.allocUnsafe(Math.min(st.size, MAX_FILE_VIEW_BYTES));
      const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
      const slice = buf.subarray(0, bytesRead);
      const isBinary = slice.subarray(0, 8000).includes(0);
      if (isBinary) return { kind: "binary", path: file, sizeBytes: st.size };
      return { kind: "text", path: file, sizeBytes: st.size, text: slice.toString("utf8"), truncated: false };
    } finally {
      await fh.close();
    }
  },
};

let ready = false;
async function main() {
  const pkg = resolvePiPackage();
  process.send?.({ t: "ready", piVersion: pkg?.version ?? null, fingerprint: pkg?.fingerprint ?? null });
  ready = true;
}

process.on("message", async (msg: { id: string; op: string; args?: unknown }) => {
  if (!msg || typeof msg !== "object" || !("id" in msg)) return;
  if (!ready) await new Promise<void>((r) => { const iv = setInterval(() => { if (ready) { clearInterval(iv); r(); } }, 20); });
  const h = handlers[msg.op];
  if (!h) {
    process.send?.({ id: msg.id, ok: false, error: { code: "unsupported_capability", message: `unknown op ${msg.op}` } });
    return;
  }
  try {
    const data = await h(msg.args ?? {});
    process.send?.({ id: msg.id, ok: true, data });
  } catch (e) {
    const err = e as { code?: string; message?: string };
    process.send?.({ id: msg.id, ok: false, error: { code: err.code ?? "internal", message: String(err.message ?? e).slice(0, 300) } });
  }
});

main().catch((e) => {
  console.error(JSON.stringify({ fatal: String(e?.message ?? e).slice(0, 200) }));
  process.exit(1);
});
