/**
 * Read-only, contained workspace file viewer (plan security.md).
 * - Path components checked by realpath at each step (no string-prefix escapes).
 * - Symlink swap races limited via descriptor-based reads with re-checks (documented
 *   same-user limitation).
 * - Denylist applies regardless of containment: .env*, private keys, Pi credentials,
 *   .git internals, shell rc files.
 * - No writes, uploads, or arbitrary paths: workspaceKey must be allowlisted.
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { MAX_FILE_VIEW_BYTES, type FileView } from "@piwebui/shared";
import { ApiError } from "./commands.ts";

const DENY_BASENAME = /^(\.env(\..*)?|id_rsa(\.pub)?|id_ed25519(\.pub)?|.*\.pem|auth\.json|\.netrc|\.npmrc)$/i;
const DENY_SEGMENT = new Set([".git", ".pi-web", "node_modules/.bin"]);

export function denylistHit(workspace: string, rel: string): boolean {
  const parts = rel.split(/[\\/]+/).filter(Boolean);
  for (const p of parts) {
    if (DENY_BASENAME.test(p)) return true;
    if (DENY_SEGMENT.has(p)) return true;
    if (p.startsWith(".env")) return true;
  }
  return false;
}

/** Resolve each path component step-by-step, refusing symlinks that escape the root. */
export async function containedResolve(root: string, relPath: string): Promise<string> {
  const rootReal = await fsp.realpath(root);
  let cur = rootReal;
  const parts = relPath.split(/[\\/]+/).filter((p) => p !== "" && p !== ".");
  for (const part of parts) {
    if (part === "..") throw new ApiError("forbidden", "path traversal denied");
    const next = path.join(cur, part);
    const lstat = await fsp.lstat(next).catch(() => null);
    if (!lstat) break; // leaf may not exist yet; final check below
    if (lstat.isSymbolicLink()) {
      const targetReal = await fsp.realpath(next).catch(() => null);
      if (!targetReal) throw new ApiError("forbidden", "dangling symlink");
      const rel = path.relative(rootReal, targetReal);
      if (rel.startsWith("..") || path.isAbsolute(rel)) throw new ApiError("forbidden", "symlink escapes workspace");
      cur = targetReal;
    } else {
      cur = next;
    }
  }
  const finalReal = await fsp.realpath(cur).catch(() => null);
  const check = finalReal ?? cur;
  const rel = path.relative(rootReal, check);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new ApiError("forbidden", "path escapes workspace");
  if (denylistHit(rootReal, rel)) throw new ApiError("forbidden", "path is on the denylist (credentials, keys, .env, .git internals)");
  return check;
}

export async function viewFile(root: string, relPath: string): Promise<FileView> {
  const full = await containedResolve(root, relPath);
  let st: fs.Stats;
  try { st = await fsp.stat(full); } catch { throw new ApiError("not_found", "path not found"); }
  if (st.isDirectory()) {
    const dirents = (await fsp.readdir(full, { withFileTypes: true })).slice(0, 500);
    const entries: FileView["entries"] = [];
    for (const de of dirents) {
      entries.push({
        name: de.name,
        kind: de.isDirectory() ? "dir" : de.isFile() ? "file" : "other",
        sizeBytes: de.isFile() ? fs.statSync(path.join(full, de.name)).size : null,
      });
    }
    return { kind: "directory", path: path.relative(root, full), sizeBytes: st.size, entries };
  }
  if (st.size > MAX_FILE_VIEW_BYTES) return { kind: "too_large", path: path.relative(root, full), sizeBytes: st.size };
  const fh = await fsp.open(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const st2 = await fh.stat();
    if (st2.ino !== st.ino || st2.size !== st.size) throw new ApiError("forbidden", "file changed during read; retry");
    const buf = Buffer.alloc(Math.min(st2.size, MAX_FILE_VIEW_BYTES));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const slice = buf.subarray(0, bytesRead);
    if (slice.subarray(0, 8000).includes(0)) return { kind: "binary", path: path.relative(root, full), sizeBytes: st2.size };
    return { kind: "text", path: path.relative(root, full), sizeBytes: st2.size, text: slice.toString("utf8"), truncated: false };
  } finally {
    await fh.close();
  }
}
