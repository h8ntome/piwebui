# Vision & Scope

## Problem

pi is excellent in a terminal and invisible everywhere else. Real workflow for a single
developer running several agents:

1. Start work in a terminal in `/Users/hadi/project`, step away.
2. Want to check progress, read the transcript, or redirect the agent — from a laptop,
   phone, or a second window — without SSH-ing and squinting at a tmux pane.
3. Want the browser to be a *window into* that session, not a different product with a
   different history.

Existing browser UIs for pi solve parts of this but each picks a side: either they are a
read-only session browser, or they become a full parallel product with their own
terminal pane, own execution path, and their own notion of "session". The requirement
here is narrower and stricter: **a clean web view and control surface over exactly the
sessions pi already has, with zero divergence in state.**

## Who it is for

Single user (Hadi), own machines, trusted network. Secondary: another developer adopting
the same pattern. Explicitly not: teams, multi-tenant hosting, or a hosted service.

## Product statement

> pi-web is to pi what the TUI is to pi — another rendering of the same agent over the
> same session file. A session started in the terminal resumes in the browser, and a
> session started in the browser resumes in the terminal, with no import, export, sync
> step, or separate database.

Three properties define success:

| Property | Test |
|---|---|
| **Faithful** | The browser transcript matches what `pi --continue` would send to the model for that session — same branch, same compaction summary, same tool results |
| **Thin** | pi-web contains no agent logic, no tool execution, no approval engine, no model calls of its own |
| **Reversible** | Turning pi-web off never leaves a session in a state the CLI cannot open and continue |

---

## The contract

This is the governing constraint of the entire system. Every other decision follows from it.

**pi-web is a visualization and control layer only.**

**MUST:**
- Render session state that pi produced.
- Relay user intent to pi as pi-level operations: a prompt, a steer, a follow-up, an
  abort, a model change, a thinking-level change, a compaction, a branch/fork, a rename.
- Show pi's own errors, retries, compaction events, and usage — as pi reports them.
- Keep the session file as the single source of truth.

**MUST NOT:**
- Execute shell commands, read/write project files, or call model APIs in its own process.
- Maintain a parallel copy of conversation history that can drift from the session file.
- Synthesize, re-order, summarise, or edit transcript content on its own initiative.
- Present any confirmation dialog as a security boundary (pi does not gate tool calls;
  see [security.md](security.md#what-pi-web-does-not-protect)).
- Write to a `.jsonl` session file with anything other than pi's own `SessionManager`.

**The one deliberate exception.** The read-only file browser (P3) lets the user look at
files in an allowlisted workspace. It is a *viewer* for context, not a tool: its results
never enter model context unless the user pastes them into a prompt. It is listed here
rather than hidden because "no file access" would be a lie we would break on day one.

### Consequence worth stating out loud

Because pi-web does not execute, it also **cannot approve**. When the agent runs
`rm -rf /`, pi-web shows a `bash` tool row with that command — after or while it ran,
because pi already ran it. Any UI that looks like a permission gate would be theatre.
Where extensions use pi's `extension_ui_request` `confirm`/`select` subprotocol ✓,
pi-web *does* surface a real blocking dialog, because that dialog genuinely blocks the
agent. The distinction is documented in the UI copy so the user is never misled
([ui_design.md](ui_design.md#extension-dialogs)).

---

## Goals

| ID | Goal | Acceptance criterion |
|---|---|---|
| G-1 | Session parity | Open any existing session from disk in the browser; rendered context equals pi's own `buildSessionContext()` output for that leaf ✓ |
| G-2 | Live tail of a CLI session | Watch a session running in a terminal, in the browser, updating within ~150 ms of the file growing, with zero risk to that session |
| G-3 | Drive from the browser | Prompt, steer, follow-up, abort, compact, change model/thinking, rename, fork — each mapping 1:1 to a documented pi operation ✓ |
| G-4 | Handoff both ways | Clean handoff terminal → browser and browser → terminal in ≤ 2 user actions, with an explicit "copy this command" affordance |
| G-5 | Minimalist fidelity | Visually reads as pi: pi's palette, pi's information density, no chat-app ornament ([visual_design.md](visual_design.md)) |
| G-6 | Resilience | Browser close/refresh/network drop mid-stream loses nothing; reconnect resumes gaplessly via entry cursor |
| G-7 | Small install | One command, no build step for the user, no database server, no Docker requirement |
| G-8 | Upgrade tolerance | A pi version change is detected and reported, and degrades to read-only rather than corrupting |
| G-9 | Honesty about unknowns | Every unknown pi entry type, event, or field renders as a labelled raw node instead of being dropped |

## Non-goals

Each one is a decision to *not* build something that is easy to scope-creep into.

| ID | Not building | Why |
|---|---|---|
| N-1 | Embedded xterm/pty terminal pane | A browser terminal is independent execution by definition; violates the contract. Prior art does this; we deliberately do not ([prior_art.md](prior_art.md#what-we-avoid)) |
| N-2 | Tool approval / permission engine | pi has none; a fake gate is worse than none. Real gating belongs in a pi extension |
| N-3 | Code editor | Reviewing a diff is in scope (P4, read-only); editing files from a browser is a different product |
| N-4 | Its own agent loop, subagents, or model calls | pi's job |
| N-5 | Multi-user auth, accounts, orgs, RBAC | Single trusted user; tokens only ([security.md](security.md)) |
| N-6 | Hosted/cloud deployment | Local or self-hosted tailnet only |
| N-7 | Session search index, embeddings, cross-session memory | pi's session picker + browser find is enough for v1 |
| N-8 | Mobile-native app / push notifications | Responsive web covers phone; push is a P8 candidate |
| N-9 | Its own plugin/extension system | pi extensions already reach the client via the RPC UI subprotocol ✓ |
| N-10 | Analytics or telemetry | Off by default; on never ([security.md](security.md#logging-and-privacy)) |
| N-11 | Git UI (commit, PR, branch mgmt) | A status/diff line for review context only; git belongs in the terminal |
| N-12 | Windows-first support | macOS primary, Linux secondary; Windows best-effort later (pi uses `proper-lockfile` Windows workarounds on its own files ✓ — we inherit that care in P6) |

---

## MVP cut line

**v1 ships** (P0–P4 in [implementation_plan.md](implementation_plan.md)): health/meta,
workspace allowlist, session list grouped by cwd, open any session read-only, live tail,
attach + prompt/steer/abort, model & thinking pickers, context/usage meter, compaction
display, rename, new session, slash-command autocomplete, mirror mode, reconnect,
light/dark/auto theming, read-only file viewer.

**Deliberately after v1:** tree/fork/clone UI (P5), diff rendering (P4 stretch),
multi-pane, session export, tailnet auth hardening, extension dialog surfacing (P5),
context-edit badges (P5).

**Ship test:** a session created in the browser at 09:00, handed off to the terminal at
11:00, handed back at 14:00, shows one continuous correct tree with no lost turns, and
`pi --session <id>` agrees with the browser about what the model will see next.

## Success metrics

| Metric | Target |
|---|---|
| Time from open to first token rendered on attach | p95 < 400 ms (local) |
| Reconnect to fully-correct transcript | p95 < 1 s, 0 lost events |
| Transcript divergence incidents (file vs UI) | 0 |
| Sessions corrupted attributable to pi-web | 0 — hard requirement |
| Installed size (server + client, no pi) | < 40 MB |
| Cold start `npx pi-web` → ready | < 5 s |
| Browser memory on a 5 000-entry session | < 250 MB, DOM nodes < 600 |

## Definition of done for v1

1. Every G-1…G-9 criterion met and covered by a named test in
   [implementation_plan.md](implementation_plan.md#testing-strategy).
2. All 9 open questions resolved or explicitly deferred with a default taken.
3. `README.md` at repo root: install, run, workspace allowlist, handoff commands,
   "pi-web does not execute or approve" statement, tailnet recipe.
4. A recorded 90-second demo script: terminal session → browser mirror → take control →
   steer → hand back to terminal.
5. Compatibility statement written against the pi version tested, with the capability
   probe in place so an unknown pi version warns and restricts to mirror mode.
