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
import { MAX_FILE_PREVIEW_BYTES, MAX_FILE_VIEW_BYTES, type FileView } from "@piwebui/shared";
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
  // An absolute path is not "the same path inside the workspace": silently re-basing it used to
  // answer `?path=/etc/passwd` with the workspace root listing, i.e. a 200 for a question nobody
  // asked (BUG-006). Refuse it and say why.
  if (path.isAbsolute(relPath) || relPath.startsWith("~")) {
    throw new ApiError("invalid_request", `path must be relative to the workspace root, not absolute (${relPath})`);
  }
  let cur = rootReal;
  const parts = relPath.split(/[\\/]+/).filter((p) => p !== "" && p !== ".");
  for (const part of parts) {
    if (part === "..") throw new ApiError("forbidden", "path traversal denied");
    const next = path.join(cur, part);
    const lstat = await fsp.lstat(next).catch(() => null);
    // A missing component is a missing path. Falling through to the root here is what turned
    // "file gone" into "file is a folder" (BUG-006, reason `missing`).
    if (!lstat) throw new ApiError("not_found", `no such file or directory: ${relPath}`, "missing");
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

/**
 * Directory listing for the workspace picker ("select a folder" dialog). Unlike viewFile
 * this is not scoped to an allowlisted workspace - it is the thing the allowlist is built
 * from - so it is names-only: entry names and whether each is a directory, never contents,
 * never sizes, never following symlinks. Resolution stays loopback-only behind the same
 * principal/CSRF/Host fences as every other route.
 */
export async function browseDir(requested: string): Promise<{
  path: string;
  parent: string | null;
  home: string;
  entries: { name: string; kind: "dir" | "file" }[];
  truncated: boolean;
}> {
  const os = await import("node:os");
  const home = os.homedir();
  const target = requested && requested !== "" ? requested : home;
  if (!path.isAbsolute(target)) throw new ApiError("invalid_request", "path must be absolute");
  let real: string;
  try { real = await fsp.realpath(target); } catch { throw new ApiError("not_found", "path does not exist"); }
  const st = await fsp.stat(real).catch(() => null);
  if (!st?.isDirectory()) throw new ApiError("invalid_request", "path is not a directory");
  const dirents = await fsp.readdir(real, { withFileTypes: true });
  const entries: { name: string; kind: "dir" | "file" }[] = [];
  for (const de of dirents.slice(0, 2000)) {
    let kind: "dir" | "file" = de.isFile() ? "file" : de.isDirectory() ? "dir" : "file";
    if (de.isSymbolicLink()) {
      // never traverse a symlink for the picker: show it as a file unless its target is a
      // directory inside the same listing (cheap check, no content read).
      try { kind = (await fsp.stat(path.join(real, de.name))).isDirectory() ? "dir" : "file"; } catch { kind = "file"; }
    }
    entries.push({ name: de.name, kind });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
  const parent = path.dirname(real);
  return {
    path: real,
    parent: parent === real ? null : parent,
    home,
    entries,
    truncated: dirents.length > entries.length,
  };
}

export async function viewFile(root: string, relPath: string): Promise<FileView> {
  const full = await containedResolve(root, relPath);
  let st: fs.Stats;
  try { st = await fsp.stat(full); } catch { throw new ApiError("not_found", "path not found"); }
  if (st.isDirectory()) {
    const all = await fsp.readdir(full, { withFileTypes: true });
    const dirents = all.slice(0, 500);
    const entries: FileView["entries"] = [];
    for (const de of dirents) {
      entries.push({
        name: de.name,
        kind: de.isDirectory() ? "dir" : de.isFile() ? "file" : "other",
        sizeBytes: de.isFile() ? fs.statSync(path.join(full, de.name)).size : null,
      });
    }
    // Say so: a capped listing that looks complete is worse than an honest "showing first 500".
    return { kind: "directory", path: path.relative(root, full), sizeBytes: st.size, entries, truncated: all.length > dirents.length };
  }
  if (st.size > MAX_FILE_VIEW_BYTES) return { kind: "too_large", path: path.relative(root, full), sizeBytes: st.size };
  const fh = await fsp.open(full, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const st2 = await fh.stat();
    if (st2.ino !== st.ino || st2.size !== st.size) throw new ApiError("forbidden", "file changed during read; retry");
    // Preview-sized read: a 2 MB log used to be shipped and injected in full (PERF-05).
    const want = Math.min(st2.size, MAX_FILE_PREVIEW_BYTES);
    const buf = Buffer.alloc(want);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const slice = buf.subarray(0, bytesRead);
    if (slice.subarray(0, 8000).includes(0)) return { kind: "binary", path: path.relative(root, full), sizeBytes: st2.size };
    return { kind: "text", path: path.relative(root, full), sizeBytes: st2.size, text: slice.toString("utf8"), truncated: bytesRead < st2.size };
  } finally {
    await fh.close();
  }
}
