# Workspace folder selector — the reference behaviour, and what pi-web had to change

Researched 2026-11-09 with REA 6.8.0 over the shipped reference artifact, then re-verified in a live
browser against both implementations.

Reference: the DeepSeek harness ("cordis" web app), `@deepseek-ai/dsh@0.2.2-rc.1`, MIT-licensed built
assets, installed at `~/.local/lib/node_modules/node/lib/node_modules/@deepseek-ai/dsh`.
REA evidence: `analyze_javascript_application` over the six shipped directory-picker packages
(`dsh-client-ui-directory-picker-{browse,native}`, `dsh-host-directory-picker`,
`dsh-host-directory-picker-{browse,native,auto}`) — parent Evidence
`ev_c87c17b32cd4723d0fab24423213893539375e06145d53a9b66c8337f91dec9b`, summary view
`ev_ca28e34f8b5830af347f85d945bdb26ae8adfe0521a3c10629387c8a18e58f9d`, artifact digest
`sha256:a6c984654c0e87be76a4694153fca11197f34807ead1249e14292c2ca2b4f8c1`; 31 static sources, 0 parse
failures, 8 child-process relations (the macOS/Linux chooser launches and the Windows dialog worker).
`dsh-client-ui-directory-picker-browse/lib/client.js` sha256 `dbb02027bc8d836c…`.
Static evidence only: nothing in the bundle was executed by REA. The live comparison below
(`dsh --profile web`, browse backend) is separate runtime evidence.

## 1. The reference is a seam, not a component

`ctx.directoryPicker` serves one of two interactions, chosen once at boot by
`dsh-host-directory-picker-auto`:

| backend | client face | host backend | when it is mounted |
| --- | --- | --- | --- |
| `native` | renderless; asks the host to open one OS chooser | `dsh-host-directory-picker-native` | loopback bind, no remote authorities, not launched through SSH, and a servable display (assumed on darwin/win32; on linux `DISPLAY`/`WAYLAND_DISPLAY` **and** an executable `zenity` or `kdialog` on PATH) |
| `browse` | the in-app "Select Workspace Directory" dialog | `dsh-host-directory-picker-browse` | everything else — anything ambiguous resolves to `browse`, "which works everywhere" |

The native backend drives exactly three platforms: macOS through `osascript -l JavaScript` (an
`NSOpenPanel` with a hand-built Edit menu, because a panel without one cannot paste into "Go to Folder"),
Windows through a spawned child process running the modern `IFileOpenDialog` over koffi/COM, and Linux
through `zenity --file-selection --directory` with a `kdialog` fallback.

pi-web is a browser surface whose server may be on another machine (the documented remote case is an SSH
forward or a mesh proxy). A chooser on the *server's* display would be worse than useless there, so
pi-web implements only the `browse` interaction and keeps it identical on every host OS. That is the
reference's own fallback, chosen for exactly this reason.

## 2. The `browse` contract (what pi-web now speaks)

Host side, `dsh-host-directory-picker-browse`:

- `list(path?)` — `path` omitted lists `os.homedir()`; anything else must be **fully qualified**:
  POSIX-absolute, or on Windows drive-qualified (`C:\…`) or a complete UNC share (`\\server\share\…`).
  Rooted drive-less Windows forms (`\foo`, `/foo`) pass `win32.isAbsolute` but still resolve against the
  current drive, so the reference refuses them instead of guessing.
- Resolution uses the platform's own path module — **`resolve`, never `realpath`** — so `..` segments are
  folded and nothing is canonicalised away.
- Rows are directories only (a symlink is stat'd and included when its target is a directory), name-sorted
  through a bounded insertion window (default 1000, the GitHub-web bound), each row
  `{ name, path, hidden }` where `path` is fully qualified and `hidden` is the dot-prefix convention.
  `truncated` says the name-sorted tail was cut. Files are never listed.
- `crumbs` are computed by the host: root → target inclusive, the topmost row labelled with its own path.
- `createDirectory(parent, name)` — one `mkdir`, `name` required to be a single segment.
- Failure vocabulary: `directory-unreadable`, `directory-exists`, `directory-create-failed`, projected on
  the wire as `directory-picker/unreadable|exists|create-failed`.

Client side, `dsh-client-ui-directory-picker-browse`:

- 680×500 dialog clamped to `min(680px,100%)` / `min(500px,100dvh-32px)`; the Miller row scrolls
  sideways, each column scrolls down.
- Header: title, then the selection-path breadcrumb (inside home it collapses to a localized "Home"
  crumb) and a click-to-edit path zone marked by a pencil glyph, lit by a bar-wide outline.
- Miller view: **one full-width level until a row is selected**, then two columns (256px floor) split
  around a 0.5px divider. A pick in the right column advances one level: the child becomes the level.
- Rows: 28px, 13px/20px medium, folder glyph (open + info-fill when selected), ellipsised name, trailing
  chevron.
- Navigations land selection-anchored and quiet: the previous panes keep rendering while a crumb jump or a
  submitted path is scanned; the target and its parent leg commit as **one** two-pane frame if the parent
  leg answers within 200 ms, otherwise the target lands alone and a late parent leg upgrades in place.
  A landing swaps panes; it never blanks them.
- The path editor is seeded with the target plus a trailing separator. Its last segment prefix-filters the
  last pane (250 ms debounce, a dot-led prefix reveals the hidden rows it names, an unmatched prefix
  releases the filter), any other directory part walks the panes, and cancellation keeps the panes where
  the walk ended.
- Footer: `New folder`, fixed-label `Show hidden files` (`aria-pressed`, check when on), spacer,
  `Cancel`, `Open`. Open adopts the selection, falling back to the listed level. `New folder` opens a
  nested dialog (`New folder in "{name}"`, 44px input, `Untitled folder` placeholder) and selects the
  created folder.
- Statuses: `Too many folders to list; only the beginning is shown.` for a cut listing, and a floating
  `Loading…` pill only if a scan stays silent for 300 ms — a fast host swaps panes with no intermediate
  frame at all.

Timing constants ported verbatim: `SLOW_SCAN_DELAY_MS=300`, `PARENT_LEG_WAIT_MS=200`,
`DRAFT_PREVIEW_DEBOUNCE_MS=250`.

## 3. What pi-web's picker was doing instead, and why it read as broken

| defect | evidence | consequence |
| --- | --- | --- |
| The browser rebuilt child paths as `` `${level}/${name}` `` and split breadcrumbs on `"/"`. | old `DirectoryPicker.tsx` | On Windows (`C:\Users\hadi`) the whole path became a single crumb and rows accumulated mixed separators (`C:\Users\hadi/proj`). The dialog could only ever work on POSIX hosts. |
| Clicking a row only *selected* it; double-click adopted it. | old `onClick`/`onDoubleClick` | There was no way to open a folder at all: to reach `~/code/project` you had to type `/Users/hadi/code/project`. On macOS the screenshot state — `Documents` selected, listing still `~` — is exactly this dead end. |
| `fsp.realpath` on every listing. | `curl /api/v1/browse?path=/tmp/secprobe/link` answered `{"path":"/tmp/secprobe/real"}` | Symlinks and macOS firmlinks/redirects (`/tmp` → `/private/tmp`, iCloud Desktop & Documents) silently moved the dialog somewhere the user did not click, and registered the workspace under that resolved path. |
| A failed `readdir` escaped as a raw node error. | `GET /api/v1/browse?path=<mode 0 dir>` → `500 {"code":"EACCES","message":"EACCES: permission denied, scandir …"}` | On macOS, TCC answers `EPERM` for `~/Documents`, `~/Desktop`, `~/Downloads`, `~/Pictures`, `~/Music`, `~/Movies` until the *app that launched the server* is granted Files and Folders — so the first folders a Mac user clicks were the ones that 500'd, with a code nobody can read. |
| Files were listed and counted against the cap. | `readdir` slice of 2000, client filtered `kind === "dir"` | A folder of mostly files could hide every real subfolder and still claim the listing was complete. |
| No `New folder`, no `Loading…`, no ancestor chain from the host. | — | Divergence from the reference; no way to name a new workspace where you stand. |
| `basename()` split on `"/"` only. | `basename("D:\\code\\proj")` → the whole path | On Windows the workspace label became the entire path. |
| `Dialog` re-armed its autofocus on every parent render, and its selector found the first *button* in document order. | focus was on the close button while typing the path | Every re-render stole focus out of the picker's path field or rows. |

Two deliberate departures from the reference, both in pi-web's favour:

- **A failed child listing keeps the selection.** The reference clears it, which on macOS means the folder
  you just clicked stops being the thing `Open` will adopt — so the dialog would add the *parent* of a
  privacy-protected folder. pi-web keeps the row selected, collapses back to one pane, names the folder in
  the breadcrumb and shows the reason; `Open` still adopts what you clicked (choosing a folder never
  needed the right to list it).
- **Windows gets a "This PC" level** above every drive root. On POSIX, pressing up forever reaches `/` and
  you can see everything; a drive root has no parent, so a browser that starts in `C:\Users\you` could
  never click its way to `D:\`. `listDirectory("::This PC")` answers the drive letters that answer
  `stat` within 250 ms (a stalled empty card reader is left out rather than hanging the dialog). The
  reference sidesteps this by preferring a native `IFileOpenDialog` on Windows; pi-web has no host display
  to open one on.

## 4. Per-platform behaviour after the port

| | Linux | macOS | Windows |
| --- | --- | --- | --- |
| starting level | `os.homedir()` | `os.homedir()` | `os.homedir()` (`C:\Users\you`) |
| separator for crumbs/drafts | `/` | `/` | `\` (forward slashes accepted on input, as the host resolves either) |
| top of the tree | `/` | `/` | `This PC` → `C:\`, `D:\`, … |
| protected folders | `EACCES` → `directory_unreadable` + "access denied" | `EPERM` (TCC) → `directory_unreadable` naming **System Settings ▸ Privacy & Security ▸ Files and Folders**, selection kept, `Open` still adopts the clicked folder | ACL denials → `directory_unreadable` |
| UNC | n/a | n/a | `\\server\share` listable; its share root is a dead end, not "This PC" |
| workspace label | last segment | last segment | last segment (backslash-aware) |

## 5. How to re-verify

```bash
npx tsx --test packages/server/test/directories.test.mts packages/client/test/directories.test.mts
npm run smoke          # rows S21…S27 drive the HTTP contract for real
npm run typecheck && npm run build

# real server on 4711, then one stub per simulated platform:
npx tsx e2e/lib/picker-platform-stub.mts 4831 win32  http://127.0.0.1:4711
npx tsx e2e/lib/picker-platform-stub.mts 4832 darwin http://127.0.0.1:4711
# open http://127.0.0.1:4831 (Windows tree, This PC, D:\ drives) or :4832 (macOS home with
# TCC-denied Documents/Desktop/Downloads) and drive the dialog with agent-browser.
```

The stub assembles its answers with the production pure rules (`surfaceFor`, `ancestryCrumbs`,
`parentOf`, `fullyQualified`), so it exercises the client against a faithful host listing without a
Windows or macOS machine; it is a dev harness, imported by nothing that ships.

For the reference side: `dsh --profile web --port <p> --no-open`, then `Add workspace` in the sidebar.
On a headless host the auto resolver picks `browse`, which is the dialog this document describes.
