# Session Management & CLI ↔ Web Continuity

Decisions: D-01, D-05, D-06, D-07. Depends on facts F-1…F-4 in
[architecture.md](architecture.md#the-forcing-functions).

---

## What a pi session actually is (✓ verified)

| Fact | Consequence for pi-web |
|---|---|
| JSONL file: `~/.pi/agent/sessions/--<cwd>--/<timestamp>_<id>.jsonl`; `<cwd>` = path with leading separator dropped and `/ \ :` → `-` ✓ | The directory name *is* the workspace. pi-web derives "project grouping" from it for free and must not invent its own mapping |
| Line 1 = `session` header (v3): `id`, `timestamp`, `cwd`, optional `parentSession` ✓ | Header is metadata, not part of the tree ✓; `parentSession` gives us fork lineage for the UI |
| Entries form a tree via `id`/`parentId`; unknown/absent → migrated ✓ | The renderer must be tree-aware, not list-aware |
| Entry types: `message`, `model_change`, `thinking_level_change`, `usage`, `compaction`, `context_edit`, `branch_summary`, `custom`, `custom_message`, `label`, `session_info` ✓ | One rendering rule per type, table below |
| **On open, `leafId` = last entry in the file** ✓ | Handoff is automatic; last writer wins the resume position |
| The model sees the **active branch** with compaction applied, not the whole file ✓ | "What will the model see?" is a real question the UI must answer correctly, not approximately |
| File is created lazily: a session with no user/assistant message leaves no file ✓ | A "new session" that was never prompted does not exist on disk — the UI must not show a phantom |
| `SessionManager` does **not** lock the file ✓ | Everything in the rest of this document exists because of this row |
| Session deletion = delete the file (pi uses `trash` when available) ✓ | pi-web's delete uses the same policy, moves to trash, and never rewrites in place |
| Listing: `SessionManager.list(cwd)`, `listAll()`, `findById()` ✓ returning `path,id,cwd,name,parentSessionPath,created,modified,messageCount,firstMessage,allMessagesText` ✓ | The picker is one call; `allMessagesText` gives us search for free in v1 |

**Rule D-05 (absolute):** pi-web never appends, rewrites, or truncates a session file.
Every mutation goes through a live pi process (`SessionManager` / `AgentSession` / RPC
command). If no live process is available, the UI offers the terminal command instead of
doing it itself. This is what makes requirement #2 (control layer only) true in the file
layer as well as the execution layer.

---

## Three modes

Every session view in pi-web is in exactly one mode at a time. The mode is always visible
in the UI (a coloured rail chip + composer placeholder) because a wrong assumption here is
the most expensive user error available.

| Mode | Who writes | pi process | UI affordance | Use |
|---|---|---|---|---|
| **`history`** | nobody | none | full transcript, controls disabled except "Open" / "Mirror" / "Take control" | Cold read of any session on disk |
| **`mirror`** | an external pi (a terminal, another host) | external only | live transcript + **read-only composer** ("Watching — click Take control"), keystrokes do nothing | G-2: watch your CLI session from the browser |
| **`attach`** | pi-web's agent-host, exclusively | pi-web's | full composer: prompt / steer / follow-up / abort / compact / model / thinking / rename / fork | G-3: drive from the browser |

```
                 ┌────────────┐  open w/o lease   ┌────────────┐
   (on disk) ───▶│  history   ├──────────────────▶│   mirror   │
                 └─────┬──────┘                   └─────┬──────┘
                       │ acquire lease                  │ external writes stop
                       │ (conflict check)               │ (quiet ≥ quietWindow)
                       ▼                                ▼
                 ┌────────────┐   release / ttl   ┌────────────┐
                 │   attach   ├──────────────────▶│  history   │
                 └────────────┘                   └────────────┘
                        ▲  take control (forced, confirmed)
                        └─────────────────────────  mirror
```

State transitions and their UI copy are specified in
[ui_design.md](ui_design.md#session-lifecycle-states).

---

## The single-writer rule

**Two live pi processes on one session file do not corrupt it, and that is precisely why it
is dangerous.** Writes are whole-line appends, so torn lines are unlikely, but each process
maintains its own in-memory tree and appends children of *its own* leaf. The result is a
file with two leaves branching from a shared ancestor: the CLI and the browser each continue
from a different point and each silently miss the other's turns. F-3 then picks an
arbitrary winner on next open. Symptom: "my browser prompt disappeared."

Design consequences:

1. **One writer per session file**, enforced at two levels:
   - *pi-web level:* the lease (below).
   - *host level:* the agent-host keeps a `Set<resolvedPath>` and refuses a second handle
     for the same file even if two browser tabs both hold valid leases.
2. **Cross-boundary with the terminal is enforced by politeness + detection, not locks** —
   we cannot modify pi. Two guards:
   - **Quiet window.** Attach requires the file to be unmodified for `quietWindowMs = 1 500`
     and for the last entry to be a "settled" kind (not a half-open assistant turn).
   - **Divergence detector.** While attached, the mirror tail keeps running on the same
     file. If an appended entry's `parentId` ≠ our last known leaf, someone else wrote.
     Immediate action: stop writing, freeze the composer, show the conflict card.
3. **No automatic merge.** Divergence is a user decision, presented as three options in
   [ui_design.md](ui_design.md#divergence-card): keep the terminal line (pi-web re-reads and
   re-bases), keep the browser line (abandon ours by moving our leaf away — we do not delete
   anything), or fork both (`SessionManager.forkFrom` / `--fork` ✓, creating separate files).

### Lease design

pi-web's own SQLite (`~/.pi/agent/piweb/piweb.db`) table `leases`:

| Column | Notes |
|---|---|
| `session_path` | PK, canonical absolute path |
| `token` | random 128-bit **fencing token**; monotonically issued so a stale holder can be rejected |
| `owner` | `host:<n>:<pid>` |
| `client` | hashed browser client id (for multi-tab arbitration) |
| `mode` | `mirror` \| `attach` (mirrors are recorded so attach can detect them) |
| `acquired_at`, `renewed_at` | |
| `expires_at` | `renewed_at + ttl`, `ttl = 30 s` |
| `pi_pid` | OS pid of the pi process, when known — used for liveness checks |

Rules:

- Renew every `10 s` from the owning browser tab; a tab that goes background keeps renewing
  (the writer is the host, not the tab — see below).
- Release on: explicit stop, tab `pagehide` + no reconnect within TTL, lease conflict,
  divergence, host death, server shutdown.
- **The lease is held by the server on the client's behalf.** The browser's connection
  dropping does not drop the writer; that is what keeps a long run alive across a refresh.
  `detachTtl = 120 s` of no client → auto-release and stop the run (configurable; `0` = never).
- Stale lease takeover: allowed immediately if `expires_at` passed **and** `pi_pid` is dead;
  otherwise requires `force:true` + explicit UI confirmation, and bumps the token so any
  late writer from the old lease is rejected on its next write attempt (fencing).
- Because SQLite gives us transactions, lease ops are atomic; no lock file needed. If we
  later need cross-machine coordination we add `proper-lockfile` (already a pi dep ✓) on
  the session path — noted as an option, not v1.

### Takeover and conflict

Two situations where someone else may already own the file. Both are refusals with an
alternative, never a silent override:

| Situation | Server answer | UI | Escape hatch |
|---|---|---|---|
| File written within `quietWindowMs` | `409 lease_conflict` + `suggestMirror` ✓ details | [Conflict card](ui_design.md#conflict-card) | `force:true` after a stated-risk confirm, which bumps the fencing token |
| Foreign child detected while attached | next write rejected; `divergence_detected` | [Divergence card](ui_design.md#divergence-card) | rebase / keep mine / fork both — never auto-merge |
| Our lease token superseded | `412` on renew | auto-downgrade to mirror + notice | user re-acquires explicitly |

The rule underneath both: **pi-web refuses to guess.** A lost turn is invisible; a blocked
write with an explanation is visible, and visible is the whole point of a view layer.

### Liveness: is the CLI still holding this session?

Best-effort, in order of strength:

1. `pi_pid` from our own lease is alive → ours.
2. `ps` scan for a pi process whose argv contains `--session <path>` / `--session-id <id>` /
   `--continue` in that cwd → terminal is holding it (used only to warn, never to block).
3. mtime quiet < `quietWindowMs` → assume someone is active.
4. Divergence detector as the backstop after the fact.

We MUST NOT present these as guarantees. The UI language is "looks like it's in use", and
the forced-takeover path always states the risk in one sentence.

---

## Continuity in practice

### What "shared state" means here

There is no sync protocol. Continuity works because both ends read and write the same tree:

| State | Where it lives | Shared how |
|---|---|---|
| Conversation, tool calls, results | session `.jsonl` ✓ | The file |
| Active branch / resume position | derived from last line ✓ | The file (last writer wins) |
| Model + thinking level | `model_change` / `thinking_level_change` entries ✓ | The file — a model picked in the browser is what the CLI resumes with |
| Session name | `session_info` entry ✓ | The file |
| Compaction state | `compaction` entry with `firstKeptEntryId` ✓ | The file |
| Context edits, labels, usage | `context_edit` / `label` / `usage` entries ✓ | The file |
| Credentials, settings, trust | `auth.json`, `settings.json`, `trust.json` ✓ | pi's own files; pi-web never copies them and never proxies secrets |
| Project trust decision | `trust.json` ✓ | Shared; note RPC/non-interactive modes cannot prompt (see [security.md](security.md#project-trust)) |
| **Not shared:** scroll position, selected tab, sidebar filter, theme, pending unsent draft text | `piweb.db` + `localStorage` | pi-web only — these are UI state and MUST NOT leak into session data |

The last row matters: the temptation to store "nice" metadata on the session is strong and
is exactly how a viewer starts lying. pi-web's private state is namespaced to pi-web and
labelled as such in the settings view.

### Handoff: terminal → browser

```
Terminal:  $ pi --continue                 # or pi --session <id>, pi --resume
           … work … Ctrl-C /exit          # pi flushes; process gone
Browser:   rail chip: "in terminal" → "available"; user clicks Take control
           POST /lease {mode:attach}      → 200 {token}
           composer live; prompt continues the same tree from the same leaf
```

Nothing is imported. If step 2 was skipped (terminal still open), the quiet-window check
answers `409` and the UI offers **Mirror** instead — see
[ui_design.md](ui_design.md#conflict-card).

### Handoff: browser → terminal

The browser shows a persistent "Continue in terminal" affordance with copyable commands,
using pi's real documented entry points ✓:

```
pi --continue                       # newest session for this directory
pi --session <id>                   # by id or path; runs in the session's own cwd ✓
pi --resume                         # picker
pi --fork <id>                      # copy into current dir as a new session ✓
```

Sequence: **Stop writing → release lease → print commands → user runs one.** pi-web does
not kill the user's terminal and cannot open one (D-01: no execution) — it hands over a
string, and that is the correct scope. If the run is active, "hand off" first offers
`abort` (which pi answers once idle ✓) or "release without abort" for users who intend to
`Ctrl-C` the host later; the difference is spelled out in the dialog.

### Mirror mode mechanics (how G-2 works without touching pi)

```
fs.watch(sessionFile)  +  incremental tail
  on change:
    read from lastByteOffset → split on LF only ✓ (do NOT use Node readline:
      it also splits on U+2028/U+2029, valid inside JSON strings ✓)
    last (possibly partial) line is held back until a LF arrives
    parse each complete line → project to view model → emit as SSE 'entry' frames
  on rotation / shrink (offset > size): full re-read
  every N entries / T ms: recompute leaf + "what the model will see" using the
    documented context-build rules ✓
```

Cost bound: incremental only, never re-read the head; cap at `4 MB` per change burst, then
re-snapshot. Mirror mode emits `source:"mirror"` on every frame so the client can
visually distinguish it from live events.

### New sessions from the browser

1. Choose workspace from the allowlist (or type one — validated against the allowlist and
   required to exist and be a directory).
2. `POST /sessions {cwd, model?, thinkingLevel?, name?}` → agent-host creates via
   `SessionManager.create(cwd, …)` / `AgentSessionRuntime.newSession()` ✓.
3. **The file does not exist until the first user/assistant message** ✓. API returns the
   session id + a `pending: true` flag; the rail shows it as "not yet on disk"; a browser
   refresh before the first message drops it (documented, matches `pi` behaviour where an
   unprompted session leaves nothing to `--continue`).
4. Naming at creation uses `--name`/`set_session_name` semantics ✓ so the terminal picker
   shows the same name.

### Concurrency limits

| Knob | Default | Rationale |
|---|---|---|
| `maxAttached` | `1` (Q-05) | One writer is trivially safe; each extra multiply-tests the lease |
| `maxMirrored` | `8` | Tailers are cheap file watchers |
| `maxHosts` | `1` | Extension isolation is per-host, not per-session, in v1 |
| `idleDetachMs` | `60 000` | Frees pi processes and their context when nobody watches |

### Entry-type rendering matrix

Required handling for every documented entry type ✓ — nothing silently dropped (G-9).

| Entry | Transcript rendering | Feeds model context |
|---|---|---|
| `message` (user) | user band, `--pi-user-msg-bg` | yes |
| `message` (assistant) | markdown + thinking blocks + tool calls; shows model + thinking level of that reply ✓ | yes |
| `message` (toolResult) | attached to its tool-call row | yes |
| `message` (system) | collapsed "prompt/tools checkpoint" node, off by default | yes (replayed in order ✓) |
| `model_change` | inline hairline rule: `model → provider/id` | selection state |
| `thinking_level_change` | inline hairline rule | selection state |
| `usage` | counted in totals only; hidden row, never shown as a message; unknown `kind` treated as normal usage ✓ | no |
| `compaction` | distinct divider block: "context compacted · tokensBefore → estAfter", expandable summary; **never** hides the summarized originals | replaces older ✓ |
| `branch_summary` | italic block "abandoned branch: …" | yes |
| `context_edit` | badge on the *target* entry: "edited for context" / "omitted from context" + raw on expand; branch-relative ✓ | modifies target only |
| `label` | bookmark marker on target entry, filterable | no |
| `custom` | raw collapsible node with `customType`; virtual-model state ✓ rendered as a small state chip | no |
| `custom_message` | rendered with distinct "extension" styling honouring `display` ✓ | yes |
| unknown | labelled `unknown entry: <type>` raw JSON node | unknown → conservative: show, do not act |

### Continuity test scenarios

| ID | Scenario | Pass condition |
|---|---|---|
| S-1 | CLI prompt ×3 → open in browser | identical transcript, same leaf, same computed context |
| S-2 | browser prompt → release → `pi --continue` | CLI resumes with the browser's last turn present |
| S-3 | browser attach → `--session <id>` in terminal | terminal opens and shows history; browser's next write triggers divergence card, no lost turns in either file view |
| S-4 | CLI mid-run + browser mirror + browser refresh | browser reconstructs the full in-flight transcript, no duplicates |
| S-5 | compaction triggered in CLI while mirrored | divider renders at the right place, originals still visible |
| S-6 | `/tree` branch switch in CLI | browser leaf chip updates to the new leaf id and shows the branch as active |
| S-7 | browser rename → CLI `/resume` | same name visible in pi's picker |
| S-8 | browser model change → CLI `pi --continue` | model matches last `model_change` ✓ |
| S-9 | browser close during long run, reopen | run continued (lease held server-side within `detachTtl`), full transcript intact |
| S-10 | two browser tabs, one session | second tab becomes mirror/follower, never a second writer |
| S-11 | kill agent-host mid-run | clients get `pi-host-exited`, lease released, file contains only complete entries |
| S-12 | 5 000-entry session open | first paint < 1.5 s local, virtualization holds DOM < 600 |
