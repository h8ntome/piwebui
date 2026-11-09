/**
 * The server side of the "Select Workspace Directory" picker: one directory level
 * at a time, plus single-segment child creation. Shape and semantics follow the
 * reference in-app picker's browse backend (`dsh-host-directory-picker-browse`
 * in the shipped DeepSeek harness, verified with REA 6.8.0 on 2026-11-09), so the
 * dialog can be identical on every host OS.
 *
 * Why the host owns paths and the browser never joins them: the client used to
 * rebuild child paths and breadcrumbs by splitting on "/". That is right on Linux
 * and macOS and wrong on Windows (backslash separators, drive roots, UNC shares),
 * and it made the dialog disagree with itself about where it was. Every path this
 * module hands out is fully qualified on the *host's* platform, and the browser
 * only ever echoes one back.
 *
 * Also deliberately not here: `realpath`. Canonicalising the listing made the
 * dialog wander away from where the user clicked - `/tmp/x` became `/private/tmp/x`
 * on macOS, an iCloud-redirected `~/Documents` became
 * `~/Library/Mobile Documents/...`, and any symlinked folder registered a
 * workspace under a path nobody typed. The reference resolves; it does not
 * canonicalise. Symlinks that point at directories stay enterable, under their own
 * name.
 *
 * Names only: entry names, the platform's hidden flag, and whether each row is
 * enterable. Never contents, never sizes. Every non-GET verb here is a mutation,
 * so it rides the same principal/CSRF/Host fences as the rest of the API, and
 * resolution stays loopback-only by default (see SECURITY.md).
 */
import { mkdir, opendir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ApiError } from "./commands.ts";

/** One picker row: a child directory or a breadcrumb ancestor. */
export interface DirectoryEntry {
  /** Base name shown in a row; a root row carries its own path as its name. */
  name: string;
  /** Fully qualified host path - clients never join path segments themselves. */
  path: string;
  /** Hidden by the platform convention (dot-prefixed on POSIX, and on Windows too). */
  hidden: boolean;
}

/** One directory level plus its ancestry, as the browse backend reports it. */
export interface DirectoryListing {
  path: string;
  /** The host account's home directory - what roots the "Home" crumb. */
  home: string;
  /** Where "up" goes, or null at a level with no parent. */
  parent: string | null;
  /** Ancestry from the top of the filesystem to `path` inclusive; every crumb is a jump target. */
  crumbs: DirectoryEntry[];
  /** Direct child directories, name-sorted; symlinks to directories included. */
  entries: DirectoryEntry[];
  /** True when `entries` was cut at the bound: the missing rows are the name-sorted tail. */
  truncated: boolean;
}

/**
 * Bound on the rows one listing may carry (hidden rows count toward it). The
 * reference picks this because GitHub's web file picker truncates at 1000.
 */
export const MAX_LIST_ENTRIES = 1000;

/**
 * Windows-only synthetic level above every drive root - the equivalent of macOS's
 * `/` or Linux's `/` for "keep pressing up". Without it a browser that starts in
 * `C:\Users\you` can never reach `D:\` by clicking, because a drive root has no
 * parent. Never produced on POSIX platforms.
 */
export const WINDOWS_ROOTS = "::This PC";
/** The row/crumb label for {@link WINDOWS_ROOTS}. */
export const WINDOWS_ROOTS_LABEL = "This PC";

/** How long a drive may answer `stat` for before it is left out of "This PC". */
const DRIVE_PROBE_TIMEOUT_MS = 250;

/** The platform's own path arithmetic; the picker never hand-rolls separators. */
type Surface = Pick<typeof path.posix, "sep" | "isAbsolute" | "dirname" | "basename" | "join" | "resolve">;

export function surfaceFor(platform: NodeJS.Platform): Surface {
  return platform === "win32" ? path.win32 : path.posix;
}

const DRIVE_ROOT = /^[A-Za-z]:[\\/]$/;

/**
 * Whether a candidate names one fixed filesystem location regardless of process
 * state: POSIX-absolute on POSIX; on Windows only drive-qualified (`C:\...`) or
 * complete UNC (`\\server\share\...`) forms. Rooted drive-less forms (`\foo`,
 * `/foo`) pass win32 `isAbsolute` yet still resolve against the process's current
 * drive, so they are refused rather than guessed at.
 */
export function fullyQualified(candidate: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32"
    ? path.win32.isAbsolute(candidate) && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(candidate)
    : path.posix.isAbsolute(candidate);
}

/** The level above `target`, or null when there is nothing above it. */
export function parentOf(target: string, platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "win32") {
    if (target === WINDOWS_ROOTS) return null;
    if (DRIVE_ROOT.test(target)) return WINDOWS_ROOTS;
    const up = path.win32.dirname(target);
    // A UNC share root (`\\server\share`) is its own parent: a dead end, not "This PC".
    return up === target ? null : up;
  }
  const up = path.posix.dirname(target);
  return up === target ? null : up;
}

/**
 * Breadcrumb rows for a level: the ancestry from the top of the filesystem down to
 * `target` inclusive, root-to-target ordered. The topmost row is labelled with its
 * own path (`/`, `C:\`, `\\server\share`) because it has no basename; on Windows
 * "This PC" sits above every drive.
 */
export function ancestryCrumbs(target: string, platform: NodeJS.Platform = process.platform): DirectoryEntry[] {
  if (platform === "win32" && target === WINDOWS_ROOTS) {
    return [{ name: WINDOWS_ROOTS_LABEL, path: WINDOWS_ROOTS, hidden: false }];
  }
  const surface = surfaceFor(platform);
  const crumbs: DirectoryEntry[] = [];
  let current = target;
  for (;;) {
    const up = surface.dirname(current);
    crumbs.unshift({ name: up === current ? current : surface.basename(current), path: current, hidden: false });
    if (up === current) break;
    current = up;
  }
  if (platform === "win32") crumbs.unshift({ name: WINDOWS_ROOTS_LABEL, path: WINDOWS_ROOTS, hidden: false });
  return crumbs;
}

/** Insert into a name-ascending window, evicting the largest name when it overflows `keep`. */
export function boundedInsert<T extends { name: string }>(window: T[], candidate: T, keep: number): boolean {
  if (keep < 1) return true;
  const last = window[window.length - 1];
  if (window.length === keep && last !== undefined && candidate.name.localeCompare(last.name) >= 0) return true;
  let lo = 0;
  let hi = window.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const at = window[mid];
    if (at === undefined || candidate.name.localeCompare(at.name) < 0) hi = mid;
    else lo = mid + 1;
  }
  window.splice(lo, 0, candidate);
  if (window.length <= keep) return false;
  window.pop();
  return true;
}

/** Message text of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Code of an unknown thrown value (`ENOENT`, `EACCES`, ...). */
function codeOf(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error ? String((error as { code: unknown }).code) : "";
}

/**
 * One listing failure, phrased for the person who clicked. Every failure is the
 * same closed code (the reference collapses them: the caller cannot fix any of
 * them differently), but macOS privacy denials get named - a `~/Documents` or
 * `~/Downloads` refusal there is not a permissions bug in this app, it is TCC
 * asking for a grant the operator has to make in System Settings.
 */
export function unreadableError(target: string, error: unknown, platform: NodeJS.Platform = process.platform): ApiError {
  const code = codeOf(error);
  const why = code === "ENOENT" || code === "ENOTDIR"
    ? code === "ENOTDIR" ? "not a directory" : "no such folder"
    : code === "EACCES" || code === "EPERM"
      ? platform === "darwin"
        ? "access denied - macOS privacy may be blocking this folder (System Settings > Privacy & Security > Files and Folders)"
        : "access denied"
      : messageOf(error);
  return new ApiError("directory_unreadable", `cannot open ${target}: ${why}`, code || undefined);
}

/**
 * Whether a failed `stat` means "the OS refused to look" rather than "there is nothing
 * there". The first is a folder the operator can absolutely pick - on macOS that is TCC
 * keeping this process from seeing inside a symlinked `~/Documents`, an iCloud placeholder,
 * or an asleep NAS mount - and dropping its row made such folders impossible to select.
 * A broken symlink is the second kind, and stays hidden.
 */
function refusedByPolicy(error: unknown): boolean {
  const code = codeOf(error);
  return code === "EACCES" || code === "EPERM";
}

/** One row for a scanned child, or null when it is not an enterable directory. */
async function directoryRow(surface: Surface, parent: string, name: string, isDirectory: boolean, isSymbolicLink: boolean): Promise<DirectoryEntry | null> {
  let enterable = isDirectory;
  if (!enterable && isSymbolicLink) {
    // Follow the link to decide enterability only; the row keeps its own path. A link the OS
    // refused to describe stays in the list (see {@link refusedByPolicy}): the folder it
    // points at is still a workspace, and the level itself will say why it will not list.
    enterable = await stat(surface.join(parent, name)).then((s) => s.isDirectory(), (error) => refusedByPolicy(error));
  }
  if (!enterable) return null;
  return { name, path: surface.join(parent, name), hidden: name.startsWith(".") };
}

/**
 * Whether the host can see `candidate` as a directory right now. Used for a native chooser's
 * starting folder: the client may name one, but only the host decides whether to honour it.
 */
export async function isExistingDirectory(candidate: string, platform: NodeJS.Platform = process.platform): Promise<boolean> {
  if (!fullyQualified(candidate, platform)) return false;
  try {
    const info = await stat(candidate);
    return info.isDirectory();
  } catch {
    return false;
  }
}

/** Probe one Windows drive root; slow or unreadable drives are treated as absent. */
async function drivePresent(candidate: string): Promise<boolean> {
  return await new Promise<boolean>((done) => {
    const timer = setTimeout(() => done(false), DRIVE_PROBE_TIMEOUT_MS);
    (timer as { unref?: () => void }).unref?.();
    void stat(candidate).then(
      (s) => { clearTimeout(timer); done(s.isDirectory()); },
      () => { clearTimeout(timer); done(false); },
    );
  });
}

/** The "This PC" level: every drive root that answers quickly, name-sorted. */
export async function windowsRootsListing(
  home: string,
  probe: (candidate: string) => Promise<boolean> = drivePresent,
  letters: string[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split(""),
): Promise<DirectoryListing> {
  const candidates = letters.map((letter) => ({ name: `${letter}:\\`, path: `${letter}:\\` }));
  const present = await Promise.all(candidates.map((entry) => probe(entry.path).catch(() => false)));
  const entries = candidates.filter((_, index) => present[index]).map((entry) => ({ ...entry, hidden: false }));
  return {
    path: WINDOWS_ROOTS,
    home,
    parent: null,
    crumbs: ancestryCrumbs(WINDOWS_ROOTS, "win32"),
    entries,
    truncated: false,
  };
}

export interface ListOptions {
  /** Replaces `process.platform` for the shape rules and the "This PC" level. */
  platform?: NodeJS.Platform;
  /** Replaces `os.homedir()`. */
  home?: string;
  maxEntries?: number;
  /** Windows drive probe, injected for tests. */
  driveProbe?: (candidate: string) => Promise<boolean>;
}

/**
 * Talking to the filesystem in another platform's shape would create nonsense - a
 * POSIX host asked for `C:\Users\x` happily makes one directory literally named
 * `C:\Users\x`. The per-platform rules stay testable from anywhere (see
 * {@link fullyQualified}, {@link parentOf}, {@link ancestryCrumbs},
 * {@link windowsRootsListing}); anything that actually touches disk refuses a
 * platform the host is not.
 */
function hostFilesystemOnly(platform: NodeJS.Platform, verb: string): void {
  if (platform !== process.platform) {
    throw new ApiError("invalid_request", `cannot ${verb} a ${platform} path on a ${process.platform} host`);
  }
}

/** The default drive probe: a drive that errors or stalls is a drive that is not there. */
async function driveAnswers(candidate: string): Promise<boolean> {
  return await drivePresent(candidate).catch(() => false);
}

/**
 * List one directory level. An absent/blank `requested` lists the host's home; any
 * other value must already be fully qualified on this platform.
 */
export async function listDirectory(requested?: string | null, options: ListOptions = {}): Promise<DirectoryListing> {
  const platform = options.platform ?? process.platform;
  const home = options.home ?? os.homedir();
  const maxEntries = options.maxEntries ?? MAX_LIST_ENTRIES;
  const surface = surfaceFor(platform);
  const wanted = (requested ?? "").trim();

  if (platform === "win32" && wanted === WINDOWS_ROOTS) {
    return windowsRootsListing(home, options.driveProbe ?? driveAnswers);
  }
  hostFilesystemOnly(platform, "list");
  if (wanted !== "" && !fullyQualified(wanted, platform)) {
    throw new ApiError(
      "invalid_request",
      platform === "win32"
        ? `path must be a full drive or UNC path (C:\\Users\\you or \\\\server\\share), not ${wanted}`
        : `path must be absolute, not ${wanted}`,
    );
  }

  const target = surface.resolve(wanted === "" ? home : wanted);
  const keep = maxEntries + 1;
  const scanned: { name: string; isDirectory: boolean; isSymbolicLink: boolean }[] = [];
  let evicted = false;
  let handle;
  try {
    handle = await opendir(target);
  } catch (error) {
    throw unreadableError(target, error, platform);
  }
  try {
    for (;;) {
      const dirent = await handle.read();
      if (dirent === null) break;
      if (!dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
      if (boundedInsert(scanned, { name: dirent.name, isDirectory: dirent.isDirectory(), isSymbolicLink: dirent.isSymbolicLink() }, keep)) evicted = true;
    }
  } catch (error) {
    throw unreadableError(target, error, platform);
  } finally {
    await handle.close().catch(() => undefined);
  }

  const entries: DirectoryEntry[] = [];
  let truncated = evicted;
  for (const candidate of scanned) {
    const row = await directoryRow(surface, target, candidate.name, candidate.isDirectory, candidate.isSymbolicLink);
    if (row === null) continue;
    if (entries.length === maxEntries) { truncated = true; break; }
    entries.push(row);
  }
  return {
    path: target,
    home,
    parent: parentOf(target, platform),
    crumbs: ancestryCrumbs(target, platform),
    entries,
    truncated,
  };
}

/**
 * Create one child directory. `name` must be a single segment: the picker creates
 * one folder at a time, exactly where it is pointed, and never interprets the name
 * as a path of its own.
 */
export async function createDirectory(parent: string, name: string, options: ListOptions = {}): Promise<string> {
  const platform = options.platform ?? process.platform;
  const surface = surfaceFor(platform);
  const trimmed = name.trim();
  if (trimmed === "" || trimmed === "." || trimmed === ".." || /[/\\]/.test(trimmed)) {
    throw new ApiError("invalid_request", `"${name}" is not a single folder name`);
  }
  if (platform === "win32" && parent === WINDOWS_ROOTS) {
    throw new ApiError("invalid_request", "cannot create a folder in This PC; pick a drive first");
  }
  hostFilesystemOnly(platform, "create");
  if (!fullyQualified(parent, platform)) {
    throw new ApiError("invalid_request", platform === "win32" ? `parent must be a full drive or UNC path, not ${parent}` : `parent must be absolute, not ${parent}`);
  }
  const target = surface.join(surface.resolve(parent), trimmed);
  try {
    await mkdir(target);
  } catch (error) {
    if (codeOf(error) === "EEXIST") throw new ApiError("directory_exists", `${target} already exists`, target);
    throw new ApiError("directory_create_failed", `cannot create ${target}: ${messageOf(error)}`, target);
  }
  return target;
}
