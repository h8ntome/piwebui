/**
 * The "Select Workspace Directory" dialog, which is really two pickers behind one entry point.
 *
 * Which one you get is the host's answer to one question - can this browser's operator see the
 * host's screen? - and `GET /api/v1/browse/mode` decides it per client (see
 * `packages/server/src/nativePicker.ts` and `docs/research/directory-picker.md`). On a Mac or a
 * Windows box whose pi-web is the machine in front of you, the answer is your own OS chooser: the
 * dialog asks once, gets out of the way while Finder or the Explorer dialog is up, and closes when
 * the answer comes back. Everything else - a remote browser, an SSH tunnel, a headless host, a
 * chooser that failed to open - lands on the Miller-column browser below, which is also one click
 * away at any time ("Browse folders"). A browser never joins path segments in either tier.
 *
 * The browser half is ported from the reference in-app picker
 * (`dsh-client-ui-directory-picker-browse`, verified against the shipped artifact with
 * REA 6.8.0) so the same interaction works on Linux, macOS and Windows.
 *
 * What the port had to keep (the old single-column list broke all three ways):
 * - 680x500 dialog, clamped to short/narrow viewports. The Miller row scrolls sideways,
 *   the columns scroll down.
 * - Header carries the selection-path breadcrumb and a click-to-edit path zone; below it
 *   one full-width level until a row is selected, then two columns (256px floor) split
 *   around a hairline divider. Selecting in the right column steps one level deeper.
 * - Navigations land selection-anchored and quiet: the previous view keeps rendering while
 *   a crumb jump or a submitted path is scanned, then the target and its parent land as one
 *   two-pane frame, so stepping back never flashes an intermediate frame.
 * - "New folder" creates one child in the selection (or the level) and selects it.
 * - "Open" adopts the selection, falling back to the listed level.
 * - Hidden entries are host-flagged and hidden by default; the footer's fixed-label
 *   "Show hidden files" toggle (aria-pressed, check when on) reveals them client-side.
 *
 * And what makes it cross-platform: every path on screen came from the host, already fully
 * qualified for the host's platform, and the separator used for crumbs and drafts is the
 * host's (`separatorOf`). The previous version split paths on "/" and re-joined them in the
 * browser, which is why it could only ever work on POSIX hosts.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../lib/icons";
import { useStore } from "../lib/store";
import type { DirectoryPickerMode } from "@piwebui/shared";
import {
  DRAFT_PREVIEW_DEBOUNCE_MS,
  PARENT_LEG_WAIT_MS,
  SLOW_SCAN_DELAY_MS,
  displayCrumbs,
  failureText,
  friendlyBrowseError,
  readDraft,
  separatorOf,
  visibleEntries,
  type DirEntry,
  type DirListing,
} from "../lib/directories";

const TEXT = {
  home: "Home",
  newFolder: "New folder",
  folderName: "Folder name",
  createIn: (name: string) => `New folder in "${name}"`,
  untitledFolder: "Untitled folder",
  create: "Create",
  cancel: "Cancel",
  open: "Open",
  editPath: "Edit path",
  loading: "Loading…",
  truncated: "Too many folders to list; only the beginning is shown.",
  showHidden: "Show hidden files",
  /** The chooser panel is the OS's window, so the browser can only point at it. */
  nativeOpening: (chooser: string) => `${chooser} is asking you to choose a folder.`,
  nativeChecking: "Checking whether this machine can open its own folder chooser…",
  nativeBehind: "If no chooser appeared, it is behind this window - look for “Select Workspace Directory”.",
  nativeInstead: "Browse folders",
  nativeAgain: "Choose again",
};

/** One column of folder rows (the Miller view renders one or two of these). */
function LevelColumn({ entries, selectedPath, busy, onPick, showHidden, filterPrefix, pathEditing }: {
  entries: DirEntry[];
  selectedPath: string | null;
  busy: boolean;
  onPick: (entry: DirEntry) => void;
  showHidden: boolean;
  filterPrefix: string | null;
  pathEditing: boolean;
}) {
  const visible = visibleEntries(entries, selectedPath, showHidden, filterPrefix);
  if (visible.length === 0) {
    return <div className="pw-dirpick__column"><div className="pw-dirpick__empty">No folders here</div></div>;
  }
  return (
    <div className="pw-dirpick__column" role="list">
      {visible.map((entry) => {
        const selected = entry.path === selectedPath;
        return (
          <span key={entry.path} role="listitem" className="pw-dirpick__rowSeat">
            <button
              type="button"
              aria-current={selected || undefined}
              className={`pw-dirpick__row${selected ? " pw-dirpick__row--selected" : ""}`}
              disabled={busy}
              // While the path editor is open a row click must not steal the caret the typing
              // operator aimed at the field; the panes still answer the draft underneath.
              onMouseDown={pathEditing ? (event) => { event.preventDefault(); } : undefined}
              onClick={() => onPick(entry)}
            >
              <Icon name={selected ? "folder-open" : "folder-close"} size={16} style={{ color: selected ? "var(--dsw-alias-button-info-fill)" : "var(--dsw-alias-label-secondary)" }} />
              <span className="pw-dirpick__rowName">{entry.name}</span>
              <Icon name="chevron-right-outline" size={12} className="pw-dirpick__rowChevron" />
            </button>
          </span>
        );
      })}
    </div>
  );
}

export function DirectoryPicker({ initialPath, title = "Select Workspace Directory", confirmLabel = TEXT.open, onPick, onClose }: {
  initialPath?: string | null;
  title?: string;
  confirmLabel?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const browse = useStore((s) => s.browse);
  const createDirectory = useStore((s) => s.createDirectory);
  const loadDirectoryMode = useStore((s) => s.loadDirectoryMode);
  const pickNativeDirectory = useStore((s) => s.pickNativeDirectory);
  /** Which picker the host says this client gets; seeded from the boot prefetch so the dialog
      does not flash one UI before swapping to the other. */
  const directoryMode = useStore((s) => s.directoryMode);
  const [mode, setMode] = useState<DirectoryPickerMode | null>(directoryMode);
  /** `deciding`: still asking the host; `native`: the OS panel owns the pick; `browse`: the panes do. */
  const [phase, setPhase] = useState<"deciding" | "native" | "browse">(directoryMode === null ? "deciding" : directoryMode.mode);
  /** Why native picking gave up, when it did; shown once, above the panes.
      Not `error`: a browse navigation is allowed to clear that one, and this is not about a folder. */
  const [nativeNote, setNativeNote] = useState<string | null>(null);
  const nativeAbort = useRef<AbortController | null>(null);
  const nativeArmed = useRef(false);
  const [parent, setParent] = useState<DirListing | null>(null);
  const [selected, setSelected] = useState<DirEntry | null>(null);
  const [child, setChild] = useState<DirListing | null>(null);
  /** True when the selected folder refused to list: one pane, selection kept, reason shown. */
  const [unlistable, setUnlistable] = useState(false);
  const [loading, setLoading] = useState(false);
  const [slowScan, setSlowScan] = useState(false);
  const [scanWindow, setScanWindow] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pathDraft, setPathDraft] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [folderDraft, setFolderDraft] = useState<string | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const requestSeq = useRef(0);
  const scanController = useRef<AbortController | null>(null);
  const openGeneration = useRef(0);
  const crumbTrailRef = useRef<HTMLDivElement>(null);
  const millerRowRef = useRef<HTMLDivElement>(null);
  const pathInputRef = useRef<HTMLInputElement>(null);
  const editZoneRef = useRef<HTMLButtonElement>(null);
  const composingRef = useRef(false);
  const refocusPick = useRef(false);
  const refocusEditZone = useRef(false);
  const refocusPathInput = useRef(false);
  const previewSuspended = useRef(false);
  const scanned = useRef<{ directory: string; landed: string } | null>(null);
  const viewRef = useRef<{ parent: DirListing | null; child: DirListing | null }>({ parent: null, child: null });

  useEffect(() => () => {
    requestSeq.current += 1;
    openGeneration.current += 1;
    scanController.current?.abort();
    nativeAbort.current?.abort();
  }, []);
  useEffect(() => { viewRef.current = { parent, child }; }, [parent, child]);

  const compositionGuard = {
    onCompositionStart: () => { composingRef.current = true; },
    onCompositionEnd: () => { composingRef.current = false; },
  };

  /** Newer intent wins: invalidate the pending listing's settlement AND abort its wire request. */
  const supersede = useCallback(() => {
    scanController.current?.abort();
    scanController.current = null;
    return ++requestSeq.current;
  }, []);

  /** Hide any prior indicator and start a fresh silence window for one listing call. */
  const restartSlowScanWindow = useCallback(() => {
    setSlowScan(false);
    setScanWindow((value) => value + 1);
  }, []);

  /** Launch one listing under a fresh controller so a later supersession can abort it. */
  const launchListing = useCallback((path?: string) => {
    const seq = supersede();
    const controller = new AbortController();
    scanController.current = controller;
    restartSlowScanWindow();
    return { seq, scan: browse(path, controller.signal) };
  }, [browse, restartSlowScanWindow, supersede]);

  /** Launch a follow-up listing under the CURRENT supersession seq: it is aborted like the leg it continues, and supersedes nothing. */
  const continueScan = useCallback((path: string) => {
    const controller = new AbortController();
    scanController.current = controller;
    restartSlowScanWindow();
    return browse(path, controller.signal);
  }, [browse, restartSlowScanWindow]);

  /**
   * Replace the whole view with a freshly scanned level. Away from the display root the
   * landing is two-pane: the target's actual parent-level entry re-selected (left pane =
   * parent, right pane = the target), so a crumb jump reads as stepping back one pane.
   * Both legs land as one frame when the parent leg settles within PARENT_LEG_WAIT_MS;
   * past that the target commits alone and a late parent leg still upgrades in place.
   * Until whichever commit comes first, the previous view keeps rendering: a landing swaps
   * the panes, it never blanks them.
   */
  const land = useCallback((path: string | undefined, options: { closeEditor: boolean; announce: boolean }) => {
    const { seq, scan } = launchListing(path);
    setLoading(true);
    if (options.announce) setError(null);
    const settle = () => {
      setLoading(false);
      if (options.closeEditor) { setPathDraft(null); return; }
      setError(null);
      refocusPathInput.current = true;
    };
    scan.then((target) => {
      if (seq !== requestSeq.current) return;
      if (!options.closeEditor && path !== undefined) scanned.current = { directory: path, landed: target.path };
      let landed = false;
      const landSingle = () => {
        if (landed || seq !== requestSeq.current) return;
        landed = true;
        setParent(target);
        setSelected(null);
        setChild(null);
        setUnlistable(false);
        settle();
      };
      if (displayCrumbs(target, "").length < 2) { landSingle(); return; }
      const parentCrumb = target.crumbs.at(-2);
      if (parentCrumb === undefined) { landSingle(); return; }
      continueScan(parentCrumb.path).then((parentLevel) => {
        if (seq !== requestSeq.current) return;
        const sep = separatorOf(parentLevel);
        const fold = (value: string) => (sep === "\\" ? value.toLowerCase() : value);
        const match = parentLevel.entries.find((entry) => fold(entry.path) === fold(target.path));
        if (match === undefined) { landSingle(); return; }
        landed = true;
        setParent(parentLevel);
        setSelected(match);
        setChild(target);
        setUnlistable(false);
        settle();
      }, () => { landSingle(); });
      if (options.closeEditor) window.setTimeout(landSingle, PARENT_LEG_WAIT_MS);
    }, (reason) => {
      if (seq !== requestSeq.current) return;
      setLoading(false);
      if (options.announce) setError(friendlyBrowseError(reason));
    });
  }, [continueScan, launchListing]);

  /** Commit a submitted path (Enter, a crumb, the opening listing): the editor closes, failures surface. */
  const navigate = useCallback((path?: string) => {
    land(path, { closeEditor: true, announce: true });
  }, [land]);

  /**
   * Select a row of the listed level and preview its children on the right. Deliberately
   * NOT one-frame like navigate(): a pick's first duty is the immediate selected state on
   * the clicked row, and the pane split IS that feedback.
   *
   * When the child listing fails the selection *stays*: the row is still the folder the
   * operator chose, and on macOS a privacy-protected `~/Documents` is listed-denied but a
   * perfectly good workspace. Dropping the selection here used to move "Open" back to the
   * listed level, so the dialog would add the parent the user never clicked.
   */
  const select = useCallback((entry: DirEntry) => {
    const { seq, scan } = launchListing(entry.path);
    if (pathDraft !== null) refocusPick.current = true;
    setPathDraft(null);
    setSelected(entry);
    setChild(null);
    setUnlistable(false);
    setLoading(true);
    setError(null);
    scan.then((next) => {
      if (seq !== requestSeq.current) return;
      setChild(next);
      setLoading(false);
    }, (reason) => {
      if (seq !== requestSeq.current) return;
      setLoading(false);
      setUnlistable(true);
      setError(friendlyBrowseError(reason));
      refocusEditZone.current = true;
    });
  }, [launchListing, pathDraft]);

  /** Walk the panes to the directory the draft addresses, WITHOUT closing the editor. */
  const previewDraftLevel = useCallback((directory: string) => {
    land(directory, { closeEditor: false, announce: false });
  }, [land]);

  /** Abandon path editing (Escape or clicking away) and restore the crumb view. */
  const cancelPathEdit = useCallback(() => {
    supersede();
    setLoading(false);
    setPathDraft(null);
    setError(null);
    if (child === null) setSelected(null);
    if (parent === null) navigate();
  }, [child, navigate, parent, supersede]);

  /** A right-column pick advances the view one level: child becomes the level. */
  const advance = useCallback((entry: DirEntry) => {
    if (child === null) return;
    setParent(child);
    select(entry);
  }, [child, select]);

  /**
   * One trip to the host's own chooser. A cancel closes the dialog with nothing, the way the
   * reference's renderless native flow does; a chooser that could not open falls through to
   * the in-app browser with the reason on screen, so the picker is never a dead end.
   */
  const runNativePick = useCallback(() => {
    const controller = new AbortController();
    nativeAbort.current = controller;
    setNativeNote(null);
    return pickNativeDirectory(initialPath || null, controller.signal).then((picked) => {
      if (controller.signal.aborted) return;
      if (picked === null) {
        onClose();
        return;
      }
      onPick(picked);
    }, (reason: unknown) => {
      if (controller.signal.aborted) return;
      setPhase("browse");
      setNativeNote(failureText(reason));
      navigate(initialPath || undefined);
    });
  }, [initialPath, navigate, onClose, onPick, pickNativeDirectory]);

  /* The host decides whose picker this is, because only the host knows where its display is.
     Until it answers nothing browses: a folder list that flashes and is replaced by a Finder
     window is worse than a beat of silence. The answer is cached in the store from boot. */
  useEffect(() => {
    if (phase !== "native" || nativeArmed.current) return;
    nativeArmed.current = true;
    void runNativePick();
  }, [phase, runNativePick]);

  useEffect(() => {
    openGeneration.current += 1;
    setParent(null);
    setSelected(null);
    setChild(null);
    setCreatingFolder(false);
    setShowHidden(false);
    setPicking(false);
    setUnlistable(false);
    setNativeNote(null);
    nativeArmed.current = false;
    if (phase === "deciding") {
      // One question, asked once: whose chooser is this? The answer swaps the dialog's body.
      void loadDirectoryMode().then(
        (answer) => {
          const settled = answer ?? { mode: "browse" as const, chooser: null, hostPlatform: "other" as const, reason: "the server did not answer, so the folder browser is answering" };
          setMode(settled);
          setPhase(settled.mode);
        },
        () => setPhase("browse"),
      );
      return () => { supersede(); };
    }
    // While the OS panel owns the pick there is nothing to list: the panes are not on screen.
    if (phase !== "native") navigate(initialPath || undefined);
    return () => { supersede(); };
  }, [initialPath, loadDirectoryMode, navigate, phase, supersede]);

  /** The folder a create or Open acts on: the selection, else the listed level. */
  const targetPath = selected?.path ?? parent?.path ?? null;
  const targetName = selected?.name ?? (parent === null ? "" : displayCrumbs(parent, TEXT.home).at(-1)?.name ?? parent.path);

  const confirmCreate = () => {
    if (targetPath === null || folderDraft === null || creatingFolder) return;
    const name = folderDraft;
    if (name.trim() === "") return;
    setCreatingFolder(true);
    setCreateError(null);
    const generation = openGeneration.current;
    createDirectory(targetPath, name).then((createdPath) => {
      if (generation !== openGeneration.current) return;
      setCreatingFolder(false);
      setFolderDraft(null);
      const { seq, scan } = launchListing(targetPath);
      setLoading(true);
      setError(null);
      scan.then((level) => {
        if (seq !== requestSeq.current) return;
        setParent(level);
        setLoading(false);
        select({ name, path: createdPath, hidden: name.startsWith(".") });
      }, (reason) => {
        if (seq !== requestSeq.current) return;
        setLoading(false);
        setError(friendlyBrowseError(reason));
      });
    }, (reason) => {
      if (generation !== openGeneration.current) return;
      setCreatingFolder(false);
      setCreateError(friendlyBrowseError(reason));
    });
  };

  /* The floating "Loading…" pill only appears for a scan that stays silent this long. */
  useEffect(() => {
    if (!loading) { setSlowScan(false); return; }
    const timer = window.setTimeout(() => { setSlowScan(true); }, SLOW_SCAN_DELAY_MS);
    return () => { window.clearTimeout(timer); };
  }, [loading, scanWindow]);

  /* The panes follow a typed draft to the directory it names, after a short rest. */
  useEffect(() => {
    if (pathDraft === null) return;
    const timer = window.setTimeout(() => {
      if (previewSuspended.current) return;
      const current = viewRef.current.child ?? viewRef.current.parent;
      if (current === null) return;
      const { directory, tail } = readDraft(current, pathDraft, scanned.current);
      if (directory === null || tail !== null) return;
      previewDraftLevel(directory);
    }, DRAFT_PREVIEW_DEBOUNCE_MS);
    return () => { window.clearTimeout(timer); };
  }, [pathDraft, previewDraftLevel]);

  const crumbSource = child ?? parent;
  const typedPrefix = crumbSource === null || pathDraft === null ? null : readDraft(crumbSource, pathDraft, scanned.current).tail;
  const crumbs = useMemo(() => {
    const base = crumbSource === null ? [] : displayCrumbs(crumbSource, TEXT.home);
    // A folder that refused to list is still the folder on screen: name it in the trail so the
    // dialog reads "Home > Documents" next to the reason it could not be opened.
    if (unlistable && child === null && selected !== null) return [...base, { name: selected.name, path: selected.path, hidden: selected.hidden }];
    return base;
  }, [child, crumbSource, selected, unlistable]);
  const crumbTail = crumbs.at(-1)?.path;

  // A long path walks the breadcrumb trail to its end, the way a Finder title bar does.
  useEffect(() => {
    const trail = crumbTrailRef.current;
    if (trail !== null) trail.scrollLeft = trail.scrollWidth;
  }, [crumbTail]);

  const childPath = child?.path;
  useEffect(() => {
    const row = millerRowRef.current;
    if (row !== null && childPath !== undefined) row.scrollLeft = row.scrollWidth;
  }, [childPath]);

  // A landing may replace the pane a keyboard operator had tabbed into; park the focus back
  // where they were working rather than dropping it on the body.
  useEffect(() => {
    if (refocusPathInput.current) {
      refocusPathInput.current = false;
      if (document.activeElement === document.body) pathInputRef.current?.focus();
    }
    if (pathDraft !== null) return;
    if (refocusPick.current) {
      refocusPick.current = false;
      refocusEditZone.current = false;
      const rowHost = millerRowRef.current;
      if (rowHost === null) return;
      rowHost.querySelector<HTMLButtonElement>("button[aria-current=\"true\"]")?.focus();
      return;
    }
    if (refocusEditZone.current) {
      refocusEditZone.current = false;
      if (document.activeElement !== document.body) return;
      editZoneRef.current?.focus();
    }
  });

  /** Escape/ dismissal order: the create dialog first, then the path editor, then the picker. */
  const requestDismiss = () => {
    if (folderDraft !== null || picking) return;
    if (phase === "native") { nativeAbort.current?.abort(); onClose(); return; }
    if (pathDraft !== null) { cancelPathEdit(); return; }
    onClose();
  };

  // The split appears the moment a row is picked - the pane split IS the click feedback - and
  // collapses again when the chosen folder refuses to list (there is no second pane to show).
  const twoPane = selected !== null && (child !== null || (loading && !unlistable));
  const panesInert = picking || folderDraft !== null;
  const draftPending = pathDraft !== null;

  const openPicker = () => {
    if (targetPath === null || picking) return;
    setPicking(true);
    onPick(targetPath);
  };

  /** Leave the OS panel behind and drive the panes by hand instead. */
  const switchToBrowse = () => {
    nativeAbort.current?.abort();
    nativeArmed.current = true;
    setPhase("browse");
    if (parent === null) navigate(initialPath || undefined);
  };

  /* The native half: the host's own panel is doing the choosing, so all this dialog can do is
     point at it and keep a way out. The reference's client face for this mode renders nothing
     at all, which works only because its chooser is guaranteed to appear; a browser tab that
     goes silent with no explanation is a bug report waiting to happen. */
  if (phase !== "browse") {
    const chooser = mode?.chooser ?? "the folder chooser";
    return (
      <Dialog
        title={title}
        onClose={requestDismiss}
        size="sm"
        footer={
          <>
            <button className="pw-btn pw-btn--sm pw-btn--outline pw-dirpick__nativeAction" onClick={switchToBrowse}>{TEXT.nativeInstead}</button>
            <span className="pw-dirpick__footerGap" />
            <button className="pw-btn pw-btn--sm pw-btn--outline pw-dirpick__nativeAction" onClick={requestDismiss}>{TEXT.cancel}</button>
            {phase === "native" && (
              // Asking twice is harmless: the host shares one open panel between every caller.
              <button className="pw-btn pw-btn--sm pw-btn--primary pw-dirpick__nativeAction" data-autofocus onClick={() => void runNativePick()}>
                {TEXT.nativeAgain}
              </button>
            )}
          </>
        }
      >
        <div className="pw-dirpick__native" role="status">
          <Icon name="folder-open" size={18} />
          <div className="pw-dirpick__nativeText">
            <div>{phase === "native" ? TEXT.nativeOpening(chooser) : TEXT.nativeChecking}</div>
            {phase === "native" && <div className="pw-dirpick__nativeHint">{TEXT.nativeBehind}</div>}
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <>
      <Dialog
        title={title}
        onClose={requestDismiss}
        size="picker"
        footer={
          <>
            <button
              className="pw-btn pw-btn--sm pw-btn--outline pw-dirpick__newFolder"
              disabled={parent === null || loading || panesInert || draftPending}
              onClick={() => { setFolderDraft(""); setCreateError(null); }}
            >
              <Icon name="plus-outline" size={14} /> {TEXT.newFolder}
            </button>
            <button
              type="button"
              className={`pw-dirpick__showHidden${showHidden ? " pw-dirpick__showHidden--on" : ""}`}
              aria-pressed={showHidden}
              disabled={panesInert}
              onMouseDown={draftPending ? (event) => { event.preventDefault(); } : undefined}
              onClick={() => setShowHidden((prev) => !prev)}
            >
              {TEXT.showHidden}{showHidden && <Icon name="check-outline" size={14} />}
            </button>
            <span className="pw-dirpick__footerGap" />
            <button className="pw-btn pw-btn--sm pw-btn--outline pw-dirpick__action" disabled={panesInert} onClick={onClose}>{TEXT.cancel}</button>
            <button className="pw-btn pw-btn--sm pw-btn--primary pw-dirpick__action" data-autofocus disabled={targetPath === null || loading || panesInert || draftPending} onClick={openPicker} title={targetPath ?? undefined}>
              {picking ? "Opening…" : confirmLabel}
            </button>
          </>
        }
      >
        <div
          className="pw-dirpick"
          onBlur={(event) => {
            if (pathDraft === null) return;
            if (!document.hasFocus()) return;
            const card = (event.currentTarget as HTMLElement).closest("[role=\"dialog\"]");
            if (card === null) return;
            if (event.relatedTarget instanceof Node && card.contains(event.relatedTarget)) return;
            refocusEditZone.current = false;
            cancelPathEdit();
          }}
        >
          <div className="pw-dirpick__head">
            <div className="pw-dirpick__crumbBar">
            {pathDraft === null ? (
              <>
                <div className="pw-dirpick__crumbTrail" role="navigation" aria-label="Folder path" ref={crumbTrailRef}>
                  {crumbs.map((crumb, index) => (
                    <span key={crumb.path} className="pw-dirpick__crumbSeat">
                      {index > 0 && <Icon name="chevron-right-outline" size={12} className="pw-dirpick__crumbChevron" />}
                      <button type="button" className="pw-dirpick__crumb" disabled={panesInert} onClick={() => navigate(crumb.path)}>{crumb.name}</button>
                    </span>
                  ))}
                </div>
                <button
                  type="button"
                  className="pw-dirpick__crumbEditZone"
                  aria-label={TEXT.editPath}
                  title={TEXT.editPath}
                  disabled={panesInert}
                  ref={editZoneRef}
                  onClick={() => {
                    supersede();
                    setLoading(false);
                    previewSuspended.current = false;
                    if (parent === null) { setPathDraft(""); return; }
                    const base = selected?.path ?? parent.path;
                    const sep = separatorOf(parent);
                    setPathDraft(base.endsWith(sep) ? base : `${base}${sep}`);
                  }}
                >
                  <Icon name="edit-outline" size={14} className="pw-dirpick__crumbEditGlyph" />
                </button>
              </>
            ) : (
              <input
                className="pw-dirpick__pathInput"
                value={pathDraft}
                aria-label={TEXT.editPath}
                spellCheck={false}
                autoComplete="off"
                autoFocus
                disabled={panesInert}
                ref={pathInputRef}
                onChange={(event) => {
                  supersede();
                  setLoading(false);
                  previewSuspended.current = false;
                  setPathDraft(event.target.value);
                }}
                {...compositionGuard}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !composingRef.current) {
                    event.preventDefault();
                    if (pathDraft.trim() !== "") {
                      refocusEditZone.current = true;
                      previewSuspended.current = true;
                      navigate(pathDraft.trim());
                    }
                  }
                }}
              />
            )}
            </div>
          </div>

          <div className="pw-dirpick__content">
            <div className="pw-dirpick__millerRow" ref={millerRowRef}>
              {parent !== null && (
                <LevelColumn
                  entries={parent.entries}
                  selectedPath={selected?.path ?? null}
                  busy={panesInert}
                  onPick={select}
                  showHidden={showHidden}
                  filterPrefix={child === null ? typedPrefix : null}
                  pathEditing={draftPending}
                />
              )}
              {twoPane && <span className="pw-dirpick__divider" />}
              {twoPane && child !== null && (
                <LevelColumn
                  entries={child.entries}
                  selectedPath={null}
                  busy={panesInert}
                  onPick={advance}
                  showHidden={showHidden}
                  filterPrefix={typedPrefix}
                  pathEditing={draftPending}
                />
              )}
            </div>
            {parent !== null && !loading && visibleEntries(parent.entries, selected?.path ?? null, showHidden, child === null ? typedPrefix : null).length === 0 && (
              <div className="pw-dirpick__status" role="status">No folders here.</div>
            )}
            {loading && slowScan && (
              <div className="pw-dirpick__status pw-dirpick__loadingFloat" role="status">{TEXT.loading}</div>
            )}
            {(parent?.truncated === true || child?.truncated === true) && (
              <div className="pw-dirpick__status" role="status">{TEXT.truncated}</div>
            )}
            {nativeNote !== null && (
              <div className="pw-dirpick__status" role="status">{nativeNote}</div>
            )}
            {error !== null && (
              <div className="pw-dirpick__error" role="alert">{failureText(error)}</div>
            )}
          </div>
        </div>
      </Dialog>

      {folderDraft !== null && (
        <Dialog
          title={TEXT.newFolder}
          onClose={() => { if (!creatingFolder) setFolderDraft(null); }}
          size="sm"
          footer={
            <>
              <button className="pw-btn pw-btn--sm pw-btn--outline" disabled={creatingFolder} onClick={() => setFolderDraft(null)}>{TEXT.cancel}</button>
              <button
                className="pw-btn pw-btn--sm pw-btn--primary"
                disabled={creatingFolder || folderDraft.trim() === ""}
                onClick={confirmCreate}
              >
                {creatingFolder ? "Creating…" : TEXT.create}
              </button>
            </>
          }
        >
          <div className="pw-dirpick__create">
            <p className="pw-dirpick__createIn">{TEXT.createIn(targetName)}</p>
            <input
              className="pw-input pw-input--big"
              value={folderDraft}
              aria-label={TEXT.folderName}
              placeholder={TEXT.untitledFolder}
              spellCheck={false}
              data-autofocus
              disabled={creatingFolder}
              onChange={(event) => setFolderDraft(event.target.value)}
              {...compositionGuard}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !composingRef.current) { event.preventDefault(); confirmCreate(); }
              }}
            />
            {createError !== null && <div className="pw-dirpick__error" role="alert">{failureText(createError)}</div>}
          </div>
        </Dialog>
      )}
    </>
  );
}

/** Rename / new-session-name prompt, reusing the same modal skin. */
export function PromptDialog({ title, label, initial, hint, placeholder, confirmLabel = "Save", onConfirm, onClose }: {
  title: string; label: string; initial: string; hint?: string | undefined; placeholder?: string | undefined; confirmLabel?: string;
  onConfirm: (value: string) => void; onClose: () => void;
}) {
  const [value, setValue] = useState(initial);
  const trimmed = value.trim();
  const tooLong = trimmed.length > 120;
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button className="pw-btn pw-btn--sm pw-btn--outline" onClick={onClose}>Cancel</button>
          <button className="pw-btn pw-btn--sm pw-btn--primary" disabled={!trimmed || tooLong} onClick={() => onConfirm(trimmed)}>{confirmLabel}</button>
        </>
      }
    >
      <div style={{ paddingBottom: 24 }}>
        <div className="pw-row__title" style={{ marginBottom: 6 }}>{label}</div>
        <input className="pw-input pw-input--big" value={value} data-autofocus maxLength={140}
          placeholder={placeholder}
          aria-describedby={hint ? "pw-prompt-hint" : undefined}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && trimmed && !tooLong) onConfirm(trimmed); }} />
        <div className="pw-row__desc" id="pw-prompt-hint" style={{ marginTop: 6, display: "flex", justifyContent: "space-between", gap: 12 }}>
          <span>{tooLong ? "Keep it under 120 characters." : (hint ?? "Up to 120 characters.")}</span>
          <span style={{ flex: "none", opacity: 0.7 }}>{trimmed.length}/120</span>
        </div>
      </div>
    </Dialog>
  );
}
