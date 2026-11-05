# pi-web — reviewed plan

| | |
|---|---|
| Status | Plan reviewed; application not implemented; integration feasibility gates remain |
| Version | 0.2 · 2026-11-05 |
| Target inspected | `@earendil-works/pi-coding-agent` 1.5.0, installed on this Mac |
| Review | [review_and_decisions.md](review_and_decisions.md) |
| Implementation handoff | [implementation_prompt.md](implementation_prompt.md) |

pi-web is a browser view and control surface over Pi. Pi owns agent execution,
tools, models, extensions and conversation persistence. The browser and API do not
implement another agent or directly edit Pi session files.

## Confirmed requirements

- Control a terminal-started **running Pi process**, through a bridge loaded in that
  process. Never open a second writer to accomplish live control.
- Browser-created sessions may run headlessly; stop and release them before resuming
  from the terminal with `/resume` or `pi --session <absolute-file>`.
- Runs continue when a browser closes, disconnects or sleeps. No browser-driven run timeout.
- Several distinct sessions run concurrently; initial tested capacity is four.
- Remote phone access uses the existing **NetBird** environment. Inspect its actual
  routing and HTTPS options before choosing deployment details; do not assume Tailscale.
- Keep the minimalist Pi-derived visual direction, separate client/API/backend layers,
  and no embedded shell or editor.

## Reading order

1. [vision_and_scope.md](vision_and_scope.md): contract and release scope.
2. [architecture.md](architecture.md): bridge, managed hosts and read worker.
3. [session_management.md](session_management.md): one runtime per file; control arbitration.
4. [api_spec.md](api_spec.md): API, operation tracking, SSE and snapshots.
5. [event_rendering.md](event_rendering.md): identity and reconstruction.
6. [ui_design.md](ui_design.md): interactions and honest states.
7. [visual_design.md](visual_design.md): preserved visual tokens and accessibility.
8. [security.md](security.md): authenticated access and file containment.
9. [reliability.md](reliability.md): lifecycle, recovery and bounded resources.
10. [implementation_plan.md](implementation_plan.md): feasibility first, then release gates.
11. [risks_and_open_questions.md](risks_and_open_questions.md): unresolved engineering evidence.
12. [prior_art.md](prior_art.md): references, not unverified compatibility evidence.
13. [appendix_pi_facts.md](appendix_pi_facts.md): inspected package facts and limits.
14. [review_and_decisions.md](review_and_decisions.md): corrections and user answers.
15. [implementation_prompt.md](implementation_prompt.md): ready-to-use implementation task.

## Decisions

| ID | Decision |
|---|---|
| D-01 | Pi executes; pi-web renders and relays. Read-only workspace viewing and fixed lifecycle operations are explicit service responsibilities. |
| D-02 | `LiveBridgeDriver` controls an existing terminal Pi; `SdkHostDriver` owns a separate browser-created session in its own child process. |
| D-03 | RPC is an optional later driver, not a second mandatory v1 implementation. |
| D-04 | REST commands + SSE; transport cursors and Pi entry IDs are different types. |
| D-05 | Never directly write/migrate/truncate a Pi session file from the API/read path. |
| D-06 | Modes: `history`, `mirror`, `live`, `managed`; source capabilities are explicit. |
| D-07 | Browser control grants arbitrate web clients only. They cannot fence an ordinary CLI process. |
| D-08 | Vite + React + TypeScript strict + Tailwind tokens; no component library. |
| D-09 | Node >=22.19.0; Fastify with a verified compatible schema adapter. Pin tested package versions during implementation. |
| D-10 | Session JSONL is conversation persistence; private SQLite contains metadata, operation receipts and control grants, never a transcript copy. |
| D-11 | No embedded terminal, arbitrary command API, file writes, credential editor or fake tool approvals. |
| D-12 | Four independent active sessions tested; no inactivity shutdown of an active run. |
| D-13 | Explicit workspace/session-root allowlists; localhost default; authenticated HTTPS over NetBird for phone access. |
| D-14 | Untested Pi version is read-only until its adapter passes compatibility checks; a matching version alone is insufficient. |

Normative requirements use MUST/SHOULD. Checked package facts are dated in the
appendix; proposed interfaces are not claims about existing Pi functionality.
Original v0.1 files were preserved in `../.plan-review-backup-2026-11-05/`.
