# pi-web — Architecture & Implementation Plan

A minimalist web UI for the **pi** coding agent. pi-web is a *visualization and control
layer*: it renders what pi does and relays what the user asks. It never executes code,
never calls tools, and never writes session files itself. Pi remains the only executor.

| | |
|---|---|
| Status | Planning complete · no code written |
| Plan version | 0.1 (2026-11-05) |
| Target | pi `1.5.0` (`/Users/hadi/.local/lib/node_modules/@earendil-works/pi-coding-agent`) |
| Author | pi (planning session `01a1abb2-5acb-7431-a8e3-91d9e46de250`) |
| Decisions pending | 9 — see [risks_and_open_questions.md](risks_and_open_questions.md#open-questions) |

---

## How to read this set

Read in order the first time; afterwards use it as reference. Each file is self-contained
and states its own dependencies.

| # | File | What it answers |
|---|---|---|
| 1 | [vision_and_scope.md](vision_and_scope.md) | What we are building, for whom, and the explicit non-goals that keep it small |
| 2 | [architecture.md](architecture.md) | Layers, processes, tech stack per component, rejected alternatives, repo layout |
| 3 | [session_management.md](session_management.md) | CLI ↔ web continuity, the single-writer rule, leases, handoff, divergence recovery |
| 4 | [api_spec.md](api_spec.md) | The HTTP + SSE contract between frontend and backend |
| 5 | [ui_design.md](ui_design.md) | Layout, interaction model, composer/transcript/tree specs, all states, keyboard map |
| 6 | [visual_design.md](visual_design.md) | The Pi colour palette as actual tokens, typography, spacing, motion, "looks like pi" checklist |
| 7 | [event_rendering.md](event_rendering.md) | Pi events → UI state: authority rules, stream reconstruction, reconnects, perf budgets |
| 8 | [security.md](security.md) | Trust model, binding/auth, path containment, and what pi-web deliberately does **not** protect |
| 9 | [reliability.md](reliability.md) | Failure matrix, timeouts, reconnect/idempotency numbers, observability |
| 10 | [implementation_plan.md](implementation_plan.md) | Phases P0–P7 with exit criteria, testing strategy, packaging and release |
| 11 | [risks_and_open_questions.md](risks_and_open_questions.md) | Risk register + the 9 decisions needed from Hadi |
| 12 | [prior_art.md](prior_art.md) | Existing pi web UIs (one already named `pi-web`) and the reference harnesses |
| 13 | [appendix_pi_facts.md](appendix_pi_facts.md) | Verified facts about the installed pi build, with sources and re-verification commands |

**Start here if you have five minutes:** [vision_and_scope.md](vision_and_scope.md),
then [architecture.md](architecture.md#the-forcing-functions),
then [session_management.md](session_management.md#the-single-writer-rule).

---

## Document conventions

- ✓ **Verified** — checked against the installed pi 1.5.0 (docs and compiled `dist/`).
  Evidence and re-verification commands live in [appendix_pi_facts.md](appendix_pi_facts.md).
- **MUST / MUST NOT / SHOULD / MAY** carry their usual RFC-2119 meaning.
- `file.ts:123` references point into the pi package, not into pi-web (no pi-web code exists).
- JSON blocks are **interface contracts**, not implementations. No code is written in this plan.
- `D-nn` = a recorded decision. `Q-nn` = an open question needing Hadi's input.
- Numbers in `monospace` with a unit (ms, tokens, KB) are proposed defaults, tunable at P0.

## Decision log (summary)

Full rationale lives in the linked file. This table is the index.

| ID | Decision | Choice | Rationale |
|---|---|---|---|
| D-01 | Execution boundary | pi-web relays only; pi executes | Requirement; keeps UI a pure view layer → [vision](vision_and_scope.md#the-contract) |
| D-02 | pi integration | pi **SDK in-process**, inside a separate `agent-host` child process | Typed events, no per-session pipe management; child process isolates extension crashes → [architecture](architecture.md#layer-2-agent-host) |
| D-03 | Escape hatch integration | `RpcProcessDriver` behind the same interface | Language/isolation boundary if in-process proves unsafe → [architecture](architecture.md#driver-interface) |
| D-04 | Transport to browser | REST (POST) + **SSE** for events, not WebSocket | SSE auto-reconnect + `Last-Event-ID` map 1:1 onto pi's documented durable entry cursor → [api_spec](api_spec.md#why-sse-not-websocket) |
| D-05 | Session writes | pi-web NEVER appends to `.jsonl`; all writes via pi's `SessionManager` in agent-host | Avoids two divergent leaves in one file → [session_management](session_management.md#the-single-writer-rule) |
| D-06 | Continuity modes | `mirror` (read-only tail), `attach` (exclusive writer), `history` (closed) | Covers "watch my CLI" and "drive from browser" without pretending concurrency is safe → [session_management](session_management.md#three-modes) |
| D-07 | Ownership | Fenced lease in pi-web's own SQLite store + external-change detection on the file | pi does not lock session files ✓, so we must own the policy |
| D-08 | Frontend | Vite + React + TypeScript, **no component library**, Tailwind + tokens generated from pi theme JSON | Minimalism is a constraint on dependencies too → [architecture](architecture.md#layer-3-browser-frontend) |
| D-09 | Backend | Node 22 LTS + Fastify + TypeBox schemas | TypeBox is the same validation vocabulary pi's RPC surface uses ✓ |
| D-10 | Storage | pi files are the only conversation store; pi-web keeps only `piweb.db` (leases, prefs, workspace allowlist) | Zero duplication of truth |
| D-11 | No embedded terminal | Deliberate non-goal | A browser pty *is* independent execution; breaks D-01 → [vision](vision_and_scope.md#non-goals) |
| D-12 | v1 scope | single-user, localhost bind, one active attached session, mirror any number | Keeps the concurrency surface small → [vision](vision_and_scope.md#mvp-cut-line) |

## Glossary

| Term | Meaning |
|---|---|
| **pi core** | The installed pi coding agent: agent loop, tools, models, extensions, `SessionManager` |
| **agent-host** | pi-web's child process that embeds pi via the SDK; the only pi-web module that may import pi |
| **driver** | Interface (`SdkDriver` / `RpcProcessDriver`) that abstracts how agent-host talks to pi |
| **workspace** | A directory pi-web is allowed to run sessions in (allowlisted cwd) |
| **session** | One pi `.jsonl` session file, i.e. one entry tree with one current leaf |
| **leaf** | The current position in the entry tree. On open, pi sets it to the **last entry in the file** ✓ |
| **mirror** | Read-only live view of a session pi-web does not own (e.g. one open in a terminal) |
| **attach** | pi-web owns the writer for a session and can send prompts |
| **lease** | pi-web's fenced ownership record for a session; has a token and TTL (D-07) |
| **divergence** | Two processes appended independent children to one tree; detected, never silently merged |
| **entry cursor** | An entry id used as a durable resume point for `since=` replay ✓ |
| **transcript** | The rendered active branch plus its non-message entries |
| **harness** | The software around a model: prompts, tools, UI. pi-web is a harness for a harness |
