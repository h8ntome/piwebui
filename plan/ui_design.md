# UI and UX

Visual system: [visual_design.md](visual_design.md). Runtime/ownership meanings:
[session_management.md](session_management.md). No avatars, message bubbles, drop shadows,
fake tool approvals, embedded terminal or editor.

## Layout

Desktop: 44 px header, collapsible 256/64 px session rail, one transcript column,
sticky composer and 24 px footer. Transcript container owns remaining width; text measure
68–86 ch. Optional 320 px context/files/meta drawer, overlay on narrower screens.
Tablet rail collapses; no hover-only essential actions. Phone: one column, header menu
opens session sheet, sticky composer honours safe-area and virtual-keyboard viewport.
Touch targets >=44 px, text scales to 200%, 320 px width remains usable.

Take DeepSeek's quiet single column, project grouping/rich composer from desktop coding
interfaces and Pi's dense document/tool presentation as design references. These are
chosen patterns, not factual claims about current third-party product capabilities.

## Visible state

Always show source/mode (`history`, persisted `mirror`, terminal `live`, browser `managed`),
run status, workspace and host identity. Source, run phase, connection and controller are
orthogonal. A run can be streaming with queued inputs while this tab is a follower.
Mirror cannot truthfully claim "terminal closed", "idle", current live branch or token
progress from mtime. Use "saved history only; runtime state unavailable".

Rail groups by session header cwd, with plain text name/first-prompt/time and labelled
status. Concurrent sessions have independent running indicators and a total count.
Pin/unread/preferences are allowed UI metadata, never Pi session facts.

## Transcript

User full-width Pi blue band; assistant plain Markdown; separate collapsed thinking;
bordered expandable tool rows with tool name, target, status and owner-reported duration.
Show model/thinking changes as hairline separators, compaction summary boundary with
originals inspectable, branch summaries, branch-relative context edits, labels, system
checkpoints and custom/unknown raw nodes. Honour custom_message.display.

Read/edit/write/bash render **Pi-produced** args/results. Do not invent diffs when a tool
result has none; show literal content. Truncated outputs show marker/path but path does
not grant automatic read access. Unknown/custom output stays escaped text/JSON.
Only highlight closed code blocks; streaming must not re-highlight every token.

Auto-scroll only when pinned to bottom; scrolling away shows jump-to-latest/new-turn
count. Virtualize rows and lazily load bodies without breaking deep links or in-app find.
Native browser find alone cannot search unmounted rows. Find uses loaded text plus bounded
server reads for this session; no embeddings or cross-session indexing.

## Composer and keyboard

Idle Enter sends; Shift+Enter inserts newline. Cmd/Ctrl+Enter is an explicit send shortcut.
During a run the visible Steer/Follow-up selector determines delivery; shortcut
Cmd/Ctrl+Shift+Enter sends follow-up. No second-press or content-dependent newline heuristic.
Esc closes popup/dialog where valid; it does not silently clear a queue or abort a run.
Stop button and Cmd/Ctrl+. request abort; queue clear is a separate capability-gated action
that returns removed text to a draft. Never intercept unrelated browser shortcuts globally.
Cmd/Ctrl+K opens palette; Cmd/Ctrl+F invokes in-app session find; all actions keyboard reachable.

Offline/conflict/no-controller/read-only states disable send with precise reason. Compact
may block send according to actual Pi semantics. Queue chips coexist with streaming.
Unknown dispatch result shows "Delivery uncertain — inspect operation"; preserve draft,
never offer an automatic retry as if nothing executed. Pending echoes use operation IDs
and reconcile to real owner entries, not matching content.

Controls: capability-aware model and thinking selectors, source/controller, context meter,
usage/cost with provenance; null usage displays unavailable/measuring, not zero.
Pi commands autocomplete from that owner; no fake TUI built-ins. Literal @path is not
advertised as a working file attachment until the actual driver path is tested.
Raster image paste/drop only within encoded/decoded/pixel limits; no arbitrary uploads.
Draft persistence off by default, optional per browser/session with clear controls.

## Control and handoff

Terminal live: Connect to running Pi → acquire browser control → send through bridge.
Terminal stays open, same PID. Followers can read; old web controller epochs fail safely.
Unbridged terminal: offer installation/idle reload instructions and persisted mirror only.
No Force take control. Stable file or absent process scan is not proof of closed ownership.

Managed: Continue in terminal offers Wait for completion or explicit Stop and wait.
After settled/host exit, show exact shell-escaped session path command and `/resume` option.
Never show a runnable handoff command while the host still owns the file.
A browser-created headless session has no same-process terminal view.

## Dialogs and conflicts

Real extension select/confirm/input/editor dialogs display verbatim trusted chrome around
untrusted text, requester identity and actual timeout/cancellation semantics. Snapshot
restores pending dialogs. One controller answer, duplicate/expired answers rejected.
Managed dialog binding is mandatory before prompts. Terminal dialog response is a P0 gate;
unsupported terminal dialogs show "Answer in terminal" prominently, and phone-only control
must not be claimed complete. Notifications remain nonmodal. Arbitrary TUI components
are not rendered as HTML or auto-accepted.

Conflict card states what was observed and that further remote writes are blocked.
No promise that nothing was lost or that tool effects were prevented. Show branches/raw
history and stop-writers guidance; no unimplemented rebase/keep-mine buttons.
Confirmation dialogs for user actions are fine but do not imply tool-call security gates.

## Empty/error states

No allowlist → Add workspace. No sessions → New session and correct `cd <cwd>; pi`
guidance. Pending new session → Not saved yet, owner alive. Unknown Pi adapter → read-only
with compatibility report. Host exited → persisted view, interrupted/unknown operation
status, no automatic rerun. Phone offline → connection notice, run continues on host.

## Accessibility

Body contrast target 7:1, ordinary secondary text >=4.5:1; thinking labels are text and
need 4.5:1 too, not the 3:1 graphic exemption. Focus ring >=3:1, 2 px visible outline.
State uses text plus icon/colour. No live token announcements; announce turn completion,
errors and dialogs through a restrained live region. Preserve focus/scroll on resync;
focus trap/restore for modals; keyboard expansion/copy/raw/find. Respect reduced motion.
Screen-reader and real-phone checks are release requirements, not an after-v1 backlog item.
