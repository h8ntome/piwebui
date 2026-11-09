/**
 * The workspace folder picker's pure side: the rules the reference in-app browser
 * (`dsh-client-ui-directory-picker-browse`) applies to a listing, kept apart from
 * the component so they can be tested without a DOM and reviewed without a
 * screenshot.
 *
 * Everything here works on host-supplied paths only. The server hands out fully
 * qualified paths for the platform it runs on (see `packages/server/src/directories.ts`),
 * so the client never concatenates path segments to address a folder - that habit
 * is what made the old picker Linux/macOS-only.
 */

/** One picker row: a child directory or a breadcrumb ancestor. */
export interface DirEntry {
  name: string;
  path: string;
  hidden: boolean;
}

/** One directory level plus its ancestry, exactly as `/api/v1/browse` answers. */
export interface DirListing {
  path: string;
  home: string;
  parent: string | null;
  crumbs: DirEntry[];
  entries: DirEntry[];
  truncated: boolean;
}

/** How long a scan may stay visually silent before the floating "Loading…" pill appears. */
export const SLOW_SCAN_DELAY_MS = 300;
/** How long a navigation landing waits for its parent leg before committing the target alone. */
export const PARENT_LEG_WAIT_MS = 200;
/** How long a typed draft rests before the panes follow it to a directory no pane lists. */
export const DRAFT_PREVIEW_DEBOUNCE_MS = 250;

/**
 * The listing's platform separator, inferred from the home path the host stamped -
 * never from typed text or entry paths, where a backslash is a legal POSIX name
 * character. A POSIX home with a backslash in its own name would misread; that is
 * the known limit of inferring this instead of being told.
 */
export function separatorOf(listing: DirListing): string {
  return listing.home.includes("\\") ? "\\" : "/";
}

/** The listed level as a directory part: its own path, separator-terminated (a root already is). */
export function levelDirectory(listing: DirListing): string {
  const sep = separatorOf(listing);
  return listing.path.endsWith(sep) ? listing.path : `${listing.path}${sep}`;
}

/**
 * The draft's directory part - everything through its last separator - or null while
 * no separator has been typed at all. The platform comes from `listing`: on Windows a
 * forward slash separates too (the host's resolve accepts either), while on POSIX a
 * backslash is a legal name character and never separates.
 */
export function draftDirectory(listing: DirListing, draft: string): string | null {
  const cut = separatorOf(listing) === "\\"
    ? Math.max(draft.lastIndexOf("\\"), draft.lastIndexOf("/"))
    : draft.lastIndexOf("/");
  return cut === -1 ? null : draft.slice(0, cut + 1);
}

/** How a typed draft reads against one level: the directory it names, plus the tail that filters it. */
export interface DraftRead {
  /** The draft's directory part, or null while nothing addresses a directory yet. */
  directory: string | null;
  /** The final segment, when `listing` is the level that directory names; null otherwise. */
  tail: string | null;
}

/**
 * A level answers a directory part when its own path is that part, or when it is the
 * level a draft-following scan just produced (`scanned`): the host resolves what it is
 * given, so `..` segments and Windows forward slashes reach a level whose path spells
 * the request differently.
 */
export function readDraft(listing: DirListing, draft: string, scanned: { directory: string; landed: string } | null): DraftRead {
  const directory = draftDirectory(listing, draft);
  if (directory === null) return { directory: null, tail: null };
  const answered = directory === levelDirectory(listing)
    || (scanned !== null && scanned.directory === directory && scanned.landed === listing.path);
  return { directory, tail: answered ? draft.slice(directory.length) : null };
}

/**
 * Breadcrumb rows for display: inside the home subtree the chain starts at a
 * localized Home crumb; outside it the full ancestry shows, the topmost row already
 * labelled by its own path (`/`, `C:\`, `\\server\share`, or "This PC").
 */
export function displayCrumbs(listing: DirListing, homeLabel: string): DirEntry[] {
  const homeIndex = listing.crumbs.findIndex((crumb) => crumb.path === listing.home);
  if (homeIndex === -1) return listing.crumbs;
  const tail = listing.crumbs.slice(homeIndex + 1);
  return [{ name: homeLabel, path: listing.home, hidden: false }, ...tail];
}

/**
 * The rows one column renders. The selection is exempt from every filter: it anchors
 * the two-pane view, so neither the hidden filter after a dot-reveal pick nor a
 * prefix miss may orphan it. A prefix narrows the level only while some row it would
 * actually show matches - a tail nobody matches is a name being spelled, not a demand
 * for an empty pane.
 */
export function visibleEntries(entries: DirEntry[], selectedPath: string | null, showHidden: boolean, filterPrefix: string | null): DirEntry[] {
  const needle = filterPrefix === null ? "" : filterPrefix.toLowerCase();
  const displayable = (entry: DirEntry) => showHidden || !entry.hidden || needle.startsWith(".");
  const matches = (entry: DirEntry) => displayable(entry) && entry.name.toLowerCase().startsWith(needle);
  const narrowing = needle !== "" && entries.some(matches);
  return entries.filter((entry) => {
    if (entry.path === selectedPath) return true;
    if (narrowing) return matches(entry);
    return showHidden || !entry.hidden;
  });
}

/** Failure text from the browse call, so the dialog can say what the host said. */
export function failureText(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") return error.message;
  if (typeof error === "string" && error.trim() !== "") return error;
  return "The folder could not be opened.";
}

/**
 * The message shown when a listing fails. macOS privacy (TCC) refuses a plain
 * `readdir` on `~/Documents`, `~/Desktop`, `~/Downloads` and friends until the app
 * that launched the server is granted Files and Folders, and that denial used to
 * surface as a bare `EPERM` - so name the cause and the fix.
 */
export function friendlyBrowseError(error: unknown): string {
  const text = failureText(error);
  if (/EPERM|permission denied|Files and Folders/i.test(text)) {
    return /Files and Folders/i.test(text) ? text : `${text} - this folder is protected by your operating system`;
  }
  return text;
}
