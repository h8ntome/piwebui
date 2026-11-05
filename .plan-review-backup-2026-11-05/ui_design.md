# UI / UX Design

Decisions: D-01 (control layer, not executor), D-11, D-12. Palette and type scale:
[visual_design.md](visual_design.md). Rendering rules per entry:
[session_management.md](session_management.md#entry-type-rendering-matrix).

---

## Design principles

Each principle is written so a reviewer can falsify it.

| # | Principle | Test |
|---|---|---|
| P-1 | **The transcript is the product.** Everything else is chrome | ≥ 78 % of viewport width at 1 440 px belongs to the transcript when the rail is open and no panel is open |
| P-2 | **State is never implied** | Mode (`attach`/`mirror`/`history`), model, thinking level, and run status are each visible in ≤ 1 glance without hovering |
| P-3 | **Nothing pretends to be a safety gate** | No button says approve/allow for pi's own tool calls; only real `extension_ui_request` dialogs block ✓ |
| P-4 | **Density over decoration** | Zero avatars, zero chat bubbles, zero drop shadows, zero card-in-card; information reaches the edge with hairline separators |
| P-5 | **One primary input** | Exactly one composer per session; secondary input only inside dialogs and the command palette |
| P-6 | **Never block on the network** | Every action shows optimistic state + a named failure state; no spinner with no explanation |
| P-7 | **Reader-first typography** | Transcript measure 68–86 ch, `16 px` base, `line-height 1.65`, no justification |
| P-8 | **Keyboard-complete** | Every action reachable without a mouse; palette is the escape hatch |

## Reference analysis

What we take from the three named interfaces — and what we refuse.

### DeepSeek web (the harness we are visually closest to)

| Observed | Verdict |
|---|---|
| Single centre column, generous top whitespace, composer near vertical centre when the transcript is empty | **Adopt.** This is the correct empty state; ours shows session picker + composer, not marketing |
| Very low chrome: no headers on every block, thin left rail | **Adopt.** Rail collapses to `64 px`, transcript owns the space |
| Thread list as plain text rows with timestamp, no cards | **Adopt** with one addition: a mode/status dot per row (P-2) |
| Bubble-style messages | **Refuse.** Bubbles imply a two-party chat; pi is an agent emitting heterogeneous entries |
| Model picker as a prominent dropdown in the header | **Adopt, demoted**: it belongs in the composer's bottom row, which is where Codex also puts it |

### Codex desktop

| Observed | Verdict |
|---|---|
| Threads grouped by project in the sidebar; multiple agents in parallel, separated by project | **Adopt grouping by cwd** — free from pi's session directory naming ✓. Parallel multi-session: after v1 (D-12) |
| Composer bottom row carries permission mode · model · reasoning effort | **Adopt directly** — minus the permission control (N-2), which pi has no equivalent of. Ours: thinking level · model · context meter |
| Bottom status bar: `Local · permissions · branch · changed lines` | **Adopt, reduced** to: mode · cwd · branch (read-only) · tokens/cost · connection |
| Explicit **"Hand off"** action in the top bar | **Strong validation** for G-4. Ours is *Continue in terminal* and it is a first-class button, not a menu item |
| Diff review inside the thread | Deferred to P4 stretch (read-only diff text only) |
| Complaints in the wild about added chrome/frames around the window | Cautionary: no fake window chrome, no custom title bar |

### Claude Code desktop

| Observed | Verdict |
|---|---|
| Drag-and-drop pane grid (terminal, preview, diff, chat) | **Refuse for v1.** Panes are how a UI admits the transcript alone is not enough; ours must be enough. Multi-pane is P6+ and only for two *sessions*, not mixed tool panes |
| Side chat (`⌘+;`) for a parallel conversation about the main one | **Refuse** — that is a second session, i.e. real feature = fork; we expose fork instead of inventing a shadow conversation |
| Parallel sessions with git isolation (worktrees) | **Refuse:** that is pi/the user's job; pi-web must not create worktrees (execution boundary) |
| Integrated terminal + editor | Explicitly excluded (N-1, N-3) |
| Sidebar with `New / Artifacts / Customize / More` then sessions | **Adopt** the shape: `New session` pinned at top, then filter, then sessions |
| Landing stats card (Overview / Models, date range) | **Refuse:** a dashboard invites pi-web to become an account/analytics product |

**Synthesis:** DeepSeek's single-column restraint, Codex's session-rail-with-rich-composer
and hand-off button, none of Claude-desktop's pane sprawl. The result looks like a text
document with controls, because that is what a pi session is.

---

## Layout

### Desktop ≥ 1 200 px

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ ⌘K  pi-web                       explain the failing test…  ·  attach · 3 active      ⚙ │  44  header
├───────────────┬──────────────────────────────────────────────────────────────────────────┬┤
│ [ + New ]     │                                                                          │
│ ─ filter ───  │   09:14  you ─────────────────────────────────────────────────────────   │
│ ▸ ~/proj/api  │   fix the flaky test in test/x.ts                                        │
│   ● refau…    │                                                                          │  RAIL   256
│   ○ mirror    │   ┌ pi · qwen3.8-flash-next · high ────────────────────────────────┐     │         (coll
│ ▸ ~/web       │   │ Thinking                                                       │     │        apsed
│   ○ buy UI    │   ▸ 2 skipped · 2 431 chars                              (12.1 s)  │     │         64)
│ ─ today ────  │   ▸ read  test/x.ts                                        ok 12ms  │     │
│               │   ▸ edit  test/x.ts                                     ok  3ms    │     │
│ 3 sessions    │   └──────────────────────────────────────────────────────────────────┘     │
│               │                                                                            │
│               │   09:16  you ──────────────────────────────────────────────────────────    │
│               │   focus on the assertion            ⟳ steering · queued 1                  │
│               ├──────────────────────────────────────────────────────────────────────────┤
│               │  ┌────────────────────────────────────────────────────────────────────┐  │
│               │  │ Type a prompt, or /command.  Enter sends · ⌘⏎ sends as follow-up  │  │  COMPOSER
│               │  │                                                                    │  │
│               │  ├────────────────────────────────────────────────────────────────────┤  │
│               │  │ [attach ▾] [high ▾] [qwen3.8-flash-next ▾]   ▓▓▓▓░░ 61k/200k $0.45│  │  status row
│               │  └────────────────────────────────────────────────────────────────────┘  │
├───────────────┴──────────────────────────────────────────────────────────────────────────┤
│  ~/proj/api · main · +42 −7 · pi 1.5.0 · pi-web 0.1.0 · connected 3s ago           ▓  │  24 footer
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

### Tablet 768–1 199 px

Rail collapses to icons (`64 px`) with hover-expand; the contextual panel becomes an
overlay drawer from the right; transcript keeps full width.

### Phone ≤ 767 px

Single column. Rail is a bottom-sheet opened by the header menu. Header: menu, session
name, mode chip, settings. Footer: mode, tokens, connection. Composer is sticky with
`env(safe-area-inset-bottom)`. Transcript rows lose their timestamps to a tap detail.

### Regions

| Region | Contents | Behaviour |
|---|---|---|
| **Header** (44 px) | Command-palette trigger, session title + rename inline, global status, settings | Static; no per-view title bars |
| **Rail** (256 / 64) | New session, filter, workspaces → sessions tree, per-session status dot, running count | Collapsible, state persisted; scroll independent of transcript |
| **Transcript** | Entry list, sticky "jump to latest", in-page find | Windowed; owns remaining width |
| **Composer** (auto, 3 rows min) | Input, attachments, hint line, status row | Sticky bottom; grows to `40 vh` then scrolls internally |
| **Panel** (optional, 320, overlay < 1 400) | Context breakdown · files (read-only) · session meta · hand-off commands | Opens on demand only; never auto-opens |
| **Footer** (24) | cwd, git branch (read-only), pi version, pi-web version, connection state, lease TTL | Always visible; it is where "which machine am I on" gets answered |

## Navigation & IA

```
/pi-web                          → last session, else the picker/empty state
/s                               → session rail full-width as a table (search, sort, filter)
/w/:workspaceId                  → sessions in that cwd
/s/:sessionId                    → transcript view
/s/:sessionId?at=<entryId>       → deep link to one entry (permanent, since entry ids are durable ✓)
/settings                        → prefs: theme, allowlist, limits, pi version, capabilities
```

Deep links into entries work because an entry id is a durable cursor ✓ — a URL sent to a
phone resolves to the same row, provided the session file is on the machine pi-web runs on.

### Command palette (`⌘K`)

Single palette, fuzzy, grouped, every item a real API call or navigation:
switch session · new session · set model · set thinking level · compact now · abort run ·
continue in terminal · toggle panel · jump to entry by id · pi/pi-web version · open
settings. Slash-commands from `GET /commands` ✓ appear here too (`/fix-tests` etc.). Built-in
TUI commands are excluded from that list by pi ✓, so the palette does not invent them.

### Keyboard map

| Keys | Action | Scope |
|---|---|---|
| `⌘K` | Palette | global |
| `⌘⌥←` / `⌘⌥→` | Previous / next session | global |
| `⌘N` | New session | global |
| `⌘F` | Find in transcript (native find if the window keeps it, else in-app) | transcript |
| `Enter` | Send | composer, empty buffer OR single-line |
| `⌥Enter` / `⌘⏎` | Newline in buffer when text present; **second** press sends as follow-up | composer |
| `↑` on empty buffer | Edit-last-user-message → sends as a **new** prompt (pi's `/tree` semantic, not an edit-in-place) | composer |
| `Esc` | Clear queued steering + restore text into editor (pi's own Esc recipe: `clear_queue` then `abort` ✓), then blur | streaming |
| `⌘.` | Abort run | streaming |
| `⌘⇧M` / `⌘⇧T` | Cycle model / thinking level (`cycle_model`, `cycle_thinking_level` ✓) | attached |
| `j` / `k`, `g` / `G` | Scroll by entry / jump | transcript, when input not focused |
| `1`–`9` | Open nth session in rail | rail |

Send-vs-newline is the single most argued interaction in chat-like UIs, so the composer
label states the current binding dynamically and the setting offers all three modes
(`Enter`, `⌘Enter`, `auto` — auto = `Enter` when empty, `⌘Enter` when multiline).

## Session rail

Each row: status dot, name-or-first-prompt (truncated, 1 line), relative time, message
count. Grouped by workspace (`cwd` from the path encoding ✓), then by date bucket.
Supports rename (`PATCH` → `session_info` ✓), delete (trash, confirm), pin, filter to
named sessions only ✓.

Status dot vocabulary (also used in the header chip):

| Dot | Meaning |
|---|---|
| ● green, pulse | attached and streaming |
| ● green, still | attached, idle |
| ◐ blue | mirroring an external writer |
| ○ muted | history, openable |
| ▲ amber | degraded: version warning / read-only / capacity |
| ■ red | diverged or host exited — click required |

## Transcript specification

**Row anatomy.** Left gutter = time (`HH:MM`, hover → absolute) + entry id (short, `7 ch`,
copyable ✓). Column = the entry body. Right edge = per-entry actions on hover: copy,
link here, expand raw, label (`label` entry ✓).

| Element | Rendering |
|---|---|
| User message | Full-bleed band in `--pi-user-msg-bg` with `--pi-text` ✓; images as thumbnails → lightbox; **no avatar** |
| Assistant text | Plain markdown on the page background; no bubble; heading/bullet/code colours follow pi's `md*` roles ✓ |
| Thinking | Collapsed one-line by default (`▸ Thinking · 2 skipped`); the level tints the label (`thinkingLow … thinkingMax` ✓); `redacted` blocks show "redacted by provider" and never fake text ✓ |
| Tool call | One hairline-bordered row: verb + primary target + status + duration ✓ (`durationMs` ✓). Expand → args/results. Table below |
| Tool error | `--pi-tool-error-bg` tint + `isError` marker ✓, first line of error inline, rest collapsed |
| `model_change`, `thinking_level_change` | Full-width hairline rule with centred label, `--pi-dim` ✓ |
| `compaction` | Distinct block: "context compacted · 150k → ~32k", expandable summary; the summarized originals stay above it, visually dimmed with a bracket, never removed ✓ |
| `branch_summary` | Italic `--pi-muted` block with lineage arrow ✓ |
| `context_edit` | Badge on the *target* row: "edited for context" / "omitted"; hover explains branch-relative behaviour ✓ |
| `custom` / `custom_message` | `--pi-custom-msg-bg` chip style with `customType` shown ✓ |
| Interrupted/aborted turn | Trailing marker on the assistant row (`aborted` from `agent_settled` ✓) |
| Unknown | Openable raw JSON node (G-9) |

**Streaming.** Tokens append into the live assistant row with no reflow of prior rows;
thinking and text blocks stream separately (`contentIndex` identifies the block ✓).
Code fences render as plain monospace while open and only highlight after `text_end`
(never re-highlight per token). Auto-scroll follows output only while pinned to bottom;
scrolling up releases it and reveals a `↓ 3 new turns` pill.

**Tool rendering table** (primary row label, expand behaviour). Never re-interprets
content; only labels it:

| Tool | Row label | Expanded body |
|---|---|---|
| `read` | `read <path>` | line-numbered text, collapsed to `60` lines |
| `bash` | `bash <first 80 ch>` | `$ cmd` then raw output, `white-space: pre-wrap`, max-height + scroll; note: pi-web NEVER runs bash itself (D-01) — this row is a record of pi having run it |
| `edit` | `edit <path>` | unified diff, `--pi-diff-added/removed` ✓ |
| `write` | `write <path>` | new content, size badge |
| `grep` / `find` / `ls` | `grep "<pat>" in <dir>` | result list, monospace |
| `codemode` | `codemode <first line>` | script + result |
| unknown tool | `tool · <name>` ✓ | raw args + raw result ✓ |

**Virtualization threshold:** window when > `150` rows visible-or-renderable; keep a
±`30` row overscan; entry heights cached by id. Budget: DOM nodes < 600,
first paint < 1.5 s on 5 000 entries (S-12).

**Find:** in-page only (N-7). Marks matches with `--pi-search-*` ✓ and jumps.

## Composer specification

States (mutually exclusive, always exactly one visible):

| State | Control row | Placeholder | Send behaviour |
|---|---|---|---|
| `idle` | attach · model · thinking · meter | "Type a prompt, or /command" | `replace` ✓ |
| `streaming` | + `steer` / `follow-up` toggle | "Running… Enter steers, ⌘⏎ queues as follow-up" | `steer` or `followUp` ✓; sending without a choice is rejected by pi ✓ — the UI forces the choice |
| `queued` | shows queue chips with ⤺ remove | "1 queued" | queue contents from `queue_update` ✓ (complete lists ✓) |
| `compacting` | disabled + progress | "Compacting context…" | disabled |
| `mirroring` | read-only banner | "Watching a terminal session — Take control to write" | none |
| `history` | disabled + CTA | "Open this session to write" | none |
| `diverged` | blocked + conflict card | "This session was written elsewhere" | none until resolved |
| `read-only` | disabled | "pi version not verified — mirror only" | none |
| `offline` | disabled + Reconnect | "Disconnected (3 s)" | none |

Controls in the bottom row:
`mode chip` · `thinking level` (`get_available_thinking_levels` ✓, hidden when `["off"]` ✓) ·
`model` (grouped by provider, shows `contextWindow` and `cost` ✓) · right-aligned
`context meter` (`tokens/contextWindow`, `percent` ✓; `null` right after compaction ✓ →
shows "measuring…"), and `cost` total ✓.

Attachments: paste or drop → base64 `ImageContent` ✓ (`{type:"image",data,mimeType}`), max
`4`, ≤ `8 MB` total, thumbnails removable. Non-image files: **not** attached as binaries —
the UI offers to insert a `@path` reference string (pi resolves `@path` from cwd ✓), which
keeps pi-web out of the file-transport business.

Slash autocomplete: from `GET /commands` ✓, showing `name`, `description`, and a source
badge (`extension` / `prompt` / `skill` ✓) with scope (`user`/`project` ✓). Selected
command is sent as text through `prompt` (pi expands templates/skills itself ✓).

Draft persistence: per-session, `localStorage`, cleared on send. Never synced, never on
the server (it is UI state — see the last row of
[session_management.md](session_management.md#what-shared-state-means-here)).

## Session lifecycle states

The mode machine from [session_management.md](session_management.md#three-modes), rendered.
One chip in the header, one in each rail row, and the composer placeholder always agree.

| State | Enters when | Chip | Composer | Primary action |
|---|---|---|---|---|
| `history` | session on disk, no live writer, no lease held | `○ history` muted | disabled, "Open this session to write" | **Open** (mirror) · **Take control** |
| `mirroring` | viewing a session another pi holds, or user chose Mirror | `◐ mirror` blue | read-only banner | **Take control** · Stop mirroring |
| `attaching` | lease granted, pi process starting | `◐ attach…` dim | disabled, "Opening session…" | Cancel |
| `attached idle` | host ready, no run | `● attach` green | live | type a prompt |
| `attached streaming` | `agent_start`…`agent_settled` ✓ | `● attach` pulse + elapsed clock | steer / follow-up forced choice ✓ | **Stop** (`⌘.`) |
| `attached compacting` | `compaction_start` ✓ | `▲ compacting` amber | disabled | none (can abort ✓) |
| `attached retrying` | `auto_retry_start` ✓ | `▲ retrying` amber | live (queueing allowed) | `abort_retry` ✓ |
| `conflict` | take-control refused | `■ conflict` red | blocked, reason line | **Mirror instead** · Force (confirm) |
| `diverged` | foreign `parentId` observed | `■ diverged` red | frozen | 3 resolutions below |
| `read-only` | pi version unverified (F-14) | `▲ read-only` amber | disabled | view capabilities |
| `offline` | SSE dead > `45 s` | `○ offline` dim | disabled + retry count | none (auto) |

Transition rules: any state → `offline` on dead stream (the underlying lease may still be
held server-side — that is why `offline` ≠ released). `conflict`/`diverged` are the only
states that require a click to leave; nothing self-heals silently, because a silently
repaired write conflict is how a turn disappears.

### Divergence card

Shown when the watcher sees an appended entry whose `parentId` is not our leaf
([session_management.md](session_management.md#the-single-writer-rule)). Never auto-resolves.

```
■ This session was written somewhere else

Two lines of history now exist. Nothing has been deleted or lost; pi-web has stopped
writing so the choice stays yours.

  your last entry        their last entry
  a1b2c3d4               f6g7h8i9
  "focus on the assert…"  "also fix the fixture"

  [ Rebase onto the terminal ]   [ Keep this line ]   [ Keep both as separate sessions ]
```

| Action | Does | Never does |
|---|---|---|
| Rebase onto the terminal | re-read the file, move our leaf to the foreign leaf, keep the composer draft | delete anything |
| Keep this line | continue from our own leaf (the file keeps both branches; the next pi open resumes from whichever line was written last ✓) | rewrite history |
| Keep both | fork the foreign line into a new session file (pi's own `--fork`/`forkFrom` ✓) so both lines are addressable | merge them into one branch |

### Conflict card

Shown on `409 lease_conflict` when the quiet window was not met
([session_management.md](session_management.md#takeover-and-conflict)):

```
▲ This session looks like it is still running in a terminal

The session file was written 0.4 s ago. Taking control now can make both sides
write to the same history — turns can end up on two different branches.

  [ Watch it instead (mirror) ]   [ Force take control ]   [ Cancel ]
```

**Force take control** is a two-step confirm that states the risk verbatim and records the
fencing-token bump, so the previous holder's next write is rejected (F-21).

## Branches and the tree view

Pi's tree is a first-class model ✓; the UI exposes it honestly rather than flattening:

- `⌘⇧J` or footer chip opens **Tree**: a vertical outline of the entry tree with the
  active branch in full opacity, abandoned branches dimmed at `0.5`, `branch_summary` and
  `compaction` markers visible, roots shown when there are multiple ✓.
- Clicking a **user** entry → "Branch from here" (`fork` ✓ — returns the text, prefilled in
  the editor exactly like pi's `/tree` ✓) or "Fork to a new session" (`--fork` semantics ✓).
- Clicking any other entry → move the leaf after it (pi's own behaviour: continuing with an
  empty editor ✓).
- `clone` (duplicate active branch ✓) is under the session menu, labelled
  "Duplicate this branch as a new session".
- The tree view is read-mostly: the only mutation it performs is pi's own branch/fork
  command; nothing is deleted, ever.

## Extension dialogs

When pi emits `extension_ui_request` for `select`/`confirm`/`input`/`editor`, the agent is
**actually blocked** waiting for the response ✓ — so these render as a real modal with the
title/message/options verbatim, and answer via `/extension-ui-response`. If the request
carried a `timeout`, the modal shows a countdown and states that pi will auto-resolve with
a default if the client does not answer ✓ (the agent-side timer, not ours). Notification
methods (`notify`, `setStatus`, `setWidget`, `setTitle`) appear in a low-key stack at the
top-right, auto-dismiss, no modality ✓. Copy on this modal must include the extension path
(`extensionPath`) so the user knows *which* extension is asking.

This is the only modal class in the app. Its existence is documented in the same sentence
as what it is **not**: "pi itself does not ask permission to run tools."

## Everything-states

| Situation | Screen |
|---|---|
| No sessions on disk | Centre column: pi wordmark, one line "No sessions yet", workspace picker, "New session" primary, and the exact terminal command `pi <path>` in a copyable line |
| pi-web can see pi's dir but allowlist is empty | "Add a workspace folder" primary; explains why (allowlist policy Q-02) |
| Session file 0 bytes / header only | "This session has no messages yet" (matches lazy-create ✓) |
| Unknown pi version | Amber banner: "pi 1.6.0 not verified against pi-web 0.1.0 — running in mirror-only mode", link to capabilities |
| agent-host died | Red banner "agent host exited (code 1)". Transcript stays readable (mirror of the file), controls disabled, "Retry" = restart host |
| Lease fenced out (`412`) | Downgrade to mirror + card: "Another window took control at 14:22" |
| Divergence | Card: two leaves, side-by-side last-3-entry comparison, 3 resolution actions (above) |
| Long run ( > 5 min ) | Streaming indicator keeps a ticking elapsed clock; footer shows last-event age; no "stuck" claim unless the silence threshold trips |
| SSE dead (`45 s` silence) | "Connection lost · retrying (3)" inline in footer; composer disabled with reason; auto-recovers via `Last-Event-ID` |
| Session deleted while open | View switches to "This session was deleted (14:22)" and rail row fades out |

## Accessibility

| Area | Requirement |
|---|---|
| Contrast | Body text ≥ 7:1 (pi's own `system` theme targets `4.5:1` minimum for body ✓; we hold body higher, chrome at 4.5:1) — audited in [visual_design.md](visual_design.md#contrast-audit) |
| Motion | `prefers-reduced-motion`: no token-fade, no auto-scroll easing, streaming still updates |
| Screen readers | `role="log"` + `aria-live="polite"` on the transcript region **but** `aria-live` disabled during token streaming (it would scream); announce turn completion instead: "pi finished, 3 tool calls" |
| Focus | Visible 2 px ring `--pi-border-accent`; roving tabindex through tool rows; `Esc` never leaves the user without a visible change |
| Targets | ≥ 44 × 44 px on touch; hairline rows are clickable by their full width |
| Type | Honours `100–200 %` browser text scale without clipping; rems only |
| Colour | Mode is never colour-only: dot + text label ("mirror", "attach") |
| Streaming content | Live region never announces partial code; `text_end`/`message_end` are the announcement points ✓ |

## Anti-features

Avatars · message bubbles · thumbs up/down · "regenerate" that secretly re-prompts ·
confetti · animated agent "thinking" blobs · per-block card shadows · right-side
suggestion panel · dark-only · fake window chrome · "AI-generated" watermarks · inline
approval buttons for tool calls · any toast that cannot be dismissed by keyboard.
