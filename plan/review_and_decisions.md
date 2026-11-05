# Review and decisions · 2026-11-05

All fourteen original plan documents were read. Their originals are preserved in
`../.plan-review-backup-2026-11-05/`. This review changes the plan only; no application,
Pi/Paseo installation, active process, production session or network setup was modified.

## User answers and interpretation

| Topic | User answer | Resulting requirement |
|---|---|---|
| Terminal → browser | “Control the same running process” | Install opt-in bridge in the terminal Pi; route control there, no second writer. |
| Browser absence | “Keep running until finished” | Remove 120 s disconnect abort and conflicting 60 s active-host disposal. |
| First release | “Several sessions + NetBird phone access” | Four-session acceptance target; NetBird deployment in v1, not Tailscale-only later work. |
| Browser-created → terminal | “I can do /resume no need for live session” | Headless browser-created session may stop/release then resume in terminal; no same-process TUI required for this direction. |

The final answer is interpreted in the context of the question about **browser-created**
sessions. It does not cancel the earlier request for live browser control of a terminal
Pi. Defaults retained: working name pi-web, React, explicit allowlists, port 4319,
independent project, Pi palette follow with override and Pi-result diff viewing. Initial
four-session capacity is a proposed testable default, not a user-specified numeric limit.

## Material corrections

1. **Lease != CLI lock.** Random tokens are not monotonically ordered fences, a SQLite
   row cannot stop an uncooperative CLI append, and quiet files may belong to idle live Pi.
   Removed forced takeover and safety claims. Browser epochs arbitrate only web input.
2. **Same session != same process.** Existing terminal control now uses a live extension
   bridge. SDK child is only for browser-created or explicitly confirmed closed sessions.
3. **File mirror != token stream.** A file tail cannot reproduce unpersisted tokens,
   queues, dialogs or in-memory branch selection. Labelled persisted-only vs live.
4. **Read can mutate.** Inspected SessionManager.open path initializes empty files and
   rewrites migrated sessions. GETs now use pure helpers in an isolated read worker.
5. **API != RPC != extension.** SDK prompt resolves after work; extension sendUserMessage
   is void; command-context methods are not normal extension methods. Defined own operation
   receipts, capability gates and an early terminal-bridge/dialog feasibility proof.
6. **Mixed SSE IDs were invalid recovery design.** Pi entry IDs and transient seq cannot
   share durable resume meaning. Separate epoch:seq transport cursor from persisted page
   cursor, add subscribe/snapshot barrier and complete runtime previews. Delivery is at
   least once with deduplication, not exactly once. Named data heartbeats make JS watchdogs
   observable; native EventSource uses cookie auth and does not expose custom headers.
7. **No disconnect abort.** Four concurrent independent runtimes survive browser/phone
   absence. Only fully settled unobserved managed hosts may be cleaned up.
8. **Snapshot state is not last-event dependence.** Reconnect can report idle directly;
   it does not need to replay agent_settled. Never rebuild a prefix from a missed suffix.
9. **Bash updates replace.** Installed bash tool emits cumulative output.snapshot; append
   would duplicate output. Custom/codemode policies must be verified, default replacement.
10. **Projection != exact next provider payload.** Runtime hooks/routing/conversion may
    still change context. Preview shows source/capture time and unavailable fields.
11. **Operations are not exactly-once effects.** Atomic reservation + owner deduplication
    handles retries while owner lives; crash between invocation/ack creates unknown state.
    No automatic prompt replay, and receipts cannot contain transcript/secrets.
12. **Handoff waits for exit.** No release without abort/settle, no `--continue` guessing
    the newest file, no claim dispose alone proves flushing. Exact shell-escaped path.
13. **Security is coherent from the first server.** Host allowlist independent of request
    Host, CSRF on all mutations, auth even through SSH, scoped raw/session reads, path races,
    owner-only bridge sockets, no raw stderr exposure, CSP-compatible theme bootstrap.
14. **Scope has one release definition.** Essential extension state/dialogs, concurrency,
    NetBird phone checks, security and packaging are v1 gates. Advanced tree mutations,
    mandatory dual drivers, export/trash and costly unrelated features are deferred.
15. **Resource limits use bytes too.** Row windowing does not bound text memory; giant
    records, previews and per-client queues require byte caps and body pagination.
16. **Evidence is dated.** Removed unstable star/dependency claims and automatic public
    publishing. Pi compatibility probes are actual adapter checks, not grep-as-capability.
    Kept detailed aesthetic spec, fixed text contrast and contradictory keyboard bindings.

## Verification performed for this review

Read installed package metadata, public exports, manager persistence/open/branch paths,
extension types, SDK prompt/UI bindings/dispose, and bash output code. Ran local Node
readline framing experiment and checked runtime versions. Checked WHATWG EventSource
contract and primary Node/NetBird/prior-art references. Concrete source locators are in
[appendix_pi_facts.md](appendix_pi_facts.md). Checked document links/required decisions
with local consistency validation after edits.

This is **not** a bridge implementation or proof that every P0 capability is available.
Terminal remote dialog response and consistent snapshot/mapping remain the main integration
uncertainties. Implementation must surface a demonstrated missing API, not invent support.
