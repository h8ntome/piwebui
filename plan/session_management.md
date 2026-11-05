# Session management and continuity

## Modes and identity

| Mode | Source | Can send input? |
|---|---|---|
| `history` | persisted file snapshot | no |
| `mirror` | persisted complete-record tail | no; no live-token promise |
| `live` | bridge in the terminal owner | yes, supported bridge commands only |
| `managed` | Pi SDK child owned by pi-web | yes, supported managed commands |

Mode, writer runtime ID, Pi PID, file generation, controller and capabilities must be
visible/inspectable. A process can switch session files. Browser commands bind both
runtime generation and session key so a stale page cannot target its replacement.

Use a server-assigned opaque `sessionKey` for routes. Pi UUID is metadata, not a unique
locator across copies, roots or hosts. Canonical path + file identity are tracked on the
server. Match workspaces from header `cwd`; encoded directory names are not reversible.

## One runtime per file

A live terminal session is controlled through its bridge; never open it in a second SDK
host. A managed session's file stays owned until the run/queues/compaction settle and its
host is disposed. Releasing a browser control grant does not release that file.

Ordinary Pi does not participate in pi-web ownership. A quiet mtime, settled last entry,
process scan, advisory lock or random token cannot prove that an unbridged CLI exited.
Remove force takeover. Existing unregistered files default to history/mirror. To resume
one in a managed host, require explicit user acknowledgement that every other writer is
closed, stable-file checks and no discovered owner. If activity/ownership is uncertain,
refuse; offer mirror or an explicit new-session fork through Pi. This manual flow still
has residual risk against arbitrary uncooperative programs and must say so.

For browser-created files, hold a canonical-path runtime registry reservation before
opening. One server instance per canonical data/session-root set; cross-machine shared
filesystems are unsupported. Locks coordinate participating software only.

## Browser control grants

Grants arbitrate browser tabs within the **same** runtime. Many followers may watch.
The server issues `{controllerId, epoch, secret, expiresAt}`; `epoch` is a monotonic
transactional integer, secret is random. Every mutation validates grant and runtime/session
generation in the receiving bridge/host, not only at HTTP ingress.

Grant TTL 30 s, renew every 10 s while connected. Browser background throttling may expire
control: the next foreground tab reacquires a grant. Expiry never aborts the run or starts
a second writer. Old grants return `412 stale_control`. The terminal remains an input
surface of its own Pi runtime; web grants cannot fence it. Do not claim exclusive
terminal input unless an adapter actually implements that policy.

Arbitration/serialization occurs at the owner: simultaneous terminal/web prompts use Pi's
idle/steer/follow-up rules. Abort/dialog response must remain reachable while a prompt runs.

## External writes and divergence

The watcher compares file generation, offsets, entry IDs and owner-reported persisted
entries. `parentId != lastLeaf` alone is not evidence of a foreign writer: deliberate
branching creates that pattern too. Track legitimate runtime leaf changes explicitly.
A foreign append can also extend the expected leaf, so parent checks alone miss it.

On inconsistent ownership/file state, block new remote mutations, preserve evidence,
request Pi abort if supported, and display conflict. Abort cannot undo tools already run,
and detection after a write is not prevention. Do not claim no damage or no data loss.
No automatic merge/rebase/keep-mine. Resolve only after writers stop; inspect branches,
then use supported Pi navigation/fork on an isolated verified file. No direct file repair.

## Lifecycle

Terminal → browser: load bridge at idle/start → discover authenticated runtime → watch
live → acquire browser control → send to the same runtime. No terminal exit or new writer.
Without bridge: mirror only, with installation/reload instructions.

Browser → terminal (managed): choose Continue in terminal → wait for all work to settle,
or explicitly Stop and wait → dispose host and confirm exit → release file reservation
→ show a shell-escaped exact `pi --session <absolute-file>` command and `/resume` guidance.
Never offer release-while-running. `pi --continue` can choose a different session; do not
use it as the exact handoff command. A headless runtime cannot gain an existing TUI view.

Browser disconnect: ongoing runtime survives; managed hosts retained while active, queued,
compacting, retrying or awaiting a dialog. After settled with no work/dialogs/clients,
managed host MAY be disposed after 60 s. This is resource cleanup, not an execution limit.
Unsent drafts remain browser UI state. Pending new sessions remain discoverable while the
host exists even before first persisted message; on host loss show that loss honestly.

File-only leaf = last valid entry on disk. Live leaf = owner's current in-memory leaf.
A terminal tree navigation need not append anything; file-only mirrors cannot see it.
Pi migration/recovery may rewrite files; detect identity/replacement/shrink and resnapshot.

## Entry coverage

Render every entry type: `message`, `model_change`, `thinking_level_change`, `usage`,
`compaction`, `context_edit`, `branch_summary`, `custom`, `custom_message`, `label`,
`session_info`, plus raw unknowns. The v3 header is metadata. `usage` affects totals, not
a chat row. Honour `custom_message.display`; expose hidden source in raw inspection.
Compaction/context edits affect model projection, not archival deletion. Keep original
messages inspectable and show active-branch edits on targets. Missing tool results remain
missing; never invent success. System prompt/tool checkpoints are inspectable, collapsed.

## Acceptance scenarios

| ID | Scenario and pass condition |
|---|---|
| S-1 | Cold GET of current/legacy/empty files changes no source bytes, mtime or directory contents; projection matches Pi pure helpers on copies. |
| S-2 | Browser-created run → settled handoff → CLI opens exact file and sees final turn. |
| S-3 | Terminal Pi bridge → browser prompt/steer/abort; same PID/runtime, no second SessionManager. |
| S-4 | Unbridged CLI file mirror updates only persisted entries and never claims token state. |
| S-5 | Compaction/context edits/unknown entries faithfully displayed. |
| S-6 | In-memory terminal branch switch is reflected by bridge even without file growth; mirror says leaf is file-derived. |
| S-7 | Rename/model/thinking changes in either UI reconcile to owner state. |
| S-8 | Managed dialog appears on phone; one answer reaches Pi; expiry/reconnect/duplicate answer handled. |
| S-9 | Close all browsers during four runs; all continue; reconnect restores state. |
| S-10 | Two tabs: one web controller, follower observes; stale grant rejected; terminal remains same runtime. |
| S-11 | Host crash, file replacement/partial tail and foreign writes are reported without automatic rerun/repair. |
| S-12 | 5,000 entries plus giant single messages load within measured memory/render budgets. |
| S-13 | Terminal bridge dialog observation and answering proven, or clearly declared unsupported with affected workflow blocked. |
