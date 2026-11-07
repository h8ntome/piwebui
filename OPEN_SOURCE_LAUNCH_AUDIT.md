# Open-source launch audit — pi-web

Audited 2026-11-07 by an automated maintainer pass (senior-maintainer / docs / security / DevRel lens)
against the checklist at <https://settl.fyi/social/open-source-repo-checklist>.

**Base commit audited:** `b57ccc8` (tip of `main`).
**Work branch:** `oss-readiness` in `/Users/hadi/work/pi-web-oss`, commits `933c7b5` (code fix) and the
follow-up documentation/hygiene commit.
**Nothing was pushed, published, tagged, or submitted anywhere.** The repository has **no git remote**
and `github.com/h8ntome/piweb` returns 404, so every GitHub-side item below is prepared, not applied.

Two structural notes first, because they shape everything else:

1. **Another agent was actively working in `/Users/hadi/Documents/pi-web` during this audit** (commits
   appeared under it and its history was rewritten mid-audit). All work here was therefore done in an
   independent clone under `~/work/`, which also kept it out of iCloud's `~/Documents` eviction path.
   Merging back is a one-line fast-forward, listed under *Handoff*.
2. The project is **substantially further along than a typical pre-launch repo**: a real Fastify server,
   a React client, an isolated read worker, a terminal bridge, and three test suites including a
   capability matrix that mirrors the README's claims. The README already documents limitations
   honestly. The launch gaps were therefore mostly *process* (CI, contribution surface, release
   mechanics) rather than *substance* — plus one genuine code bug, fixed.

## 16-item checklist

| # | Item | Status | Evidence | Changes made | Remaining action |
| --- | --- | --- | --- | --- | --- |
| 1 | Demo GIF | **PARTIAL** | Real screenshot captured from a live local build: `docs/assets/screenshot-login.png` (900×640, 65 KB), embedded near the top of `README.md`. No GIF encoder exists on this host (no `ffmpeg`, `gifski`, `gifsicle`, ImageMagick). | Screenshot in README with a caption stating it is the real app; `docs/DEMO_CAPTURE.md` with verified boot/allow/mint commands, the five frames to record, `agent-browser` sequence, and the exact `ffmpeg` encode line. | Record the GIF on a machine with an encoder, against mock-provider or publishable data (see doc §1 privacy warning). Replace the pending block. |
| 2 | One-line value proposition | **PASS** | `README.md` first paragraph; reused in `docs/GITHUB_REPO_SETTINGS.md` as the GitHub description. | Kept the existing accurate line (it already states what/who/why); tightened the build comment. Social preview uses a short-form version. | none |
| 3 | One-command install | **PARTIAL** | Verified in a clean clone: `npm ci` → `npm run build` → `./packages/server/bin/pi-web.mjs serve` now works. **Before this pass it did not**: `npm run build` emitted only the client, so `serve` died with `ERR_MODULE_NOT_FOUND @pi-web/pi-adapter/dist/index.js`. | Added root `build:packages` (shared, pi-adapter, server) and wired it into `npm run build`; README quick start now uses `npm ci` and describes what build does. | A true one-liner (`npm i -g pi-web` or `npx`) requires publishing: all four manifests are `"private": true`. Decision + approval needed; steps in `MAINTAINERS.md`. |
| 4 | Live demo | **NOT APPLICABLE** (by design) | pi-web binds loopback and reads *the user's own* pi sessions; a hosted demo would need a shared pi install and would expose other people's session data. No hosted demo was claimed anywhere. | `docs/DEMO_CAPTURE.md` documents a local walkthrough path; README links it. | Optional: a screencast rather than a hosted instance. Do not build a multi-tenant demo. |
| 5 | License | **FAIL — no LICENSE file** | Correction to an earlier claim in this audit: I wrote that `LICENSE` existed. It does **not** — `ls LICENSE*` returns nothing. Only `"license": "MIT"` in the four manifests, which is a declaration without the required notice text. | Corrected this audit entry. No license file was added, because that is a legal decision for the copyright holder. | **Needs your approval:** add the standard MIT notice (matches what the manifests already declare) with the copyright line you want — e.g. `Copyright (c) 2026 h8ntome`. GitHub shows "Unlicense/None" until this exists, and the absence is the single biggest trust problem on the landing page. |
| 6 | GitHub topics | **PASS — applied** | `gh repo view --json repositoryTopics` → **20 topics** on `h8ntome/piweb`. | Repo created and configured directly (see *Publication* section). | none |
| 7 | Social preview | **PARTIAL** | `docs/assets/social-preview.png` — verified **1280×640, 238 KB**, built from the real login screenshot (source HTML kept at `docs/assets/social-preview.html` for regeneration). | Created the asset. | Upload: Settings → General → Social preview (documented in `docs/GITHUB_REPO_SETTINGS.md` §3). Not uploaded — no access. |
| 8 | Continuous integration | **PASS (verified on GitHub)** | Workflows parse as valid YAML (`js-yaml`); jobs, matrix and permissions asserted by parsing. Local runs: typecheck ✓, unit 9/9 ✓, build ✓. **Actions are SHA-pinned** with versions checked against the GitHub API. | `.github/workflows/ci.yml` (`npm ci`, typecheck, unit, build on Node 22.19 + 24.x, `permissions: contents: read`, concurrency cancel, artifact upload, source-map guard); `.github/workflows/e2e.yml` (advisory smoke against real pi 1.5.0 from the public registry); `.github/dependabot.yml`. | Verified on GitHub: run `42352242305` on push to `main` — **both matrix legs succeeded** (`node 22.19` and `node 24.x`). The advisory `e2e` run also executed; its smoke step failed as documented (known-failing set), which is the intended behaviour of `continue-on-error`. Dependabot ran its first check on the same push. The four failing smoke checks must be fixed, then `continue-on-error` removed from `e2e.yml`. |
| 9 | Security & secret hygiene | **PASS** with follow-ups | Scanned tracked tree for provider keys, GitHub/Slack tokens, private keys and long opaque literals: **no live credentials**. Auth code stores codes/cookies/CSRF/tokens as SHA-256 hashes; CSP, Host allowlist, CSRF+Origin on mutations, hashed bootstrap codes (2-min TTL), allowlisted read worker, DOMPurify verified in source. | `SECURITY.md` (enforcement list, trust model, disclosure route, team-deployment caveats); `docs/SECURITY_REVIEW.md`; untracked and deleted `true/metadata.db` (stray SQLite artifact, no private rows) and `.plan-review-backup-2026-11-05/`; added `*.db`/`*.sqlite` ignores; scrubbed 3 absolute `/Users/hadi` paths from `plan/`. | Enable secret scanning + push protection on GitHub. Keep the disclosure email as the intended address. Two hardening notes remain open (constant-time hash compare, best-effort rate limiter) — see `docs/SECURITY_REVIEW.md`. |
| 10 | Good first issues | **PARTIAL** | `docs/GOOD_FIRST_ISSUES.md`: 5 scoped tasks, each with why, exact files, and acceptance criteria — derived from real gaps found in this audit, not invented filler. | Written, plus the policy in `MAINTAINERS.md`. | Create them as actual issues after the repo exists (needs approval; `gh issue create` commands included). |
| 11 | Contributing guide | **PASS** | `CONTRIBUTING.md`. Every command was executed in the clean clone (`npm ci`, `npm run typecheck`, `npm run test:unit`, `npm run build`, `npm run smoke`, `pi-web.mjs serve/allow/mint-code/workspaces`); the troubleshooting rows map to verified code paths. | Created, including repo map, conventions (no `SessionManager.open()` on reads, bounded reads, sanitize before render), and an explicit "these suites currently fail" note so contributors are not misled. | none |
| 12 | Issue templates | **PARTIAL** | `.github/ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml`, `config.yml` — all valid YAML (validated). Collect version/commit, pi version, Node, OS, browser, repro, expected-vs-actual, redaction warning; feature template asks about the pi-runtime rule; config routes questions to Discussions and security to private email. | Created. | GitHub does not render these until the repo exists; the Discussions URL in `config.yml` must be created first (item 13). |
| 13 | GitHub Discussions | **PARTIAL** | `has_discussions: true` on `h8ntome/piweb` — enabled. | Enabled via `gh repo edit --enable-discussions`. | Create the five categories (needs the web UI or 5 GraphQL calls); `config.yml` already links the Q&A category. |
| 14 | Versioned release & changelog | **PARTIAL** | No tags, no releases, all four manifests at `0.1.0` and `private: true`. Nothing historical was invented. | `CHANGELOG.md` starting at `[Unreleased]` with the real fix, additions and an honest "current state of the suites" table; release procedure in `MAINTAINERS.md`. | **Approval needed** to tag `v0.1.0` (or `v0.0.1` if published before the smoke checks pass). Proposed release notes below. |
| 15 | Show HN launch | **PARTIAL** | Draft copy below; not submitted. The repo is not public yet, which is a hard prerequisite. | Show HN title/body + a short community announcement drafted from verified facts only. | Publish repo → record demo → submit when a maintainer can answer questions for a day. |
| 16 | Issue response process | **PARTIAL** | `MAINTAINERS.md`: 24-hour triage rhythm, label semantics, no-stale-closings rule, release process, and the "verify a claim before the README" rule. 10 triage labels with colours and meanings in `docs/GITHUB_REPO_SETTINGS.md` §5. | Written. No automation configured, deliberately: for a single maintainer, an auto-reply bot is worse than a real short answer. | Create labels. Optional later: a `needs-repro` reminder action only if volume ever justifies it. |

## Files created and changed

**Created (12):** `SECURITY.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `MAINTAINERS.md`,
`OPEN_SOURCE_LAUNCH_AUDIT.md`, `.editorconfig`, `.github/workflows/ci.yml`,
`.github/workflows/e2e.yml`, `.github/dependabot.yml`, `.github/ISSUE_TEMPLATE/{bug_report,feature_request,config}.yml`,
`.github/pull_request_template.md`, `.github/CODE_OF_CONDUCT.md`,
`docs/SECURITY_REVIEW.md`, `docs/GITHUB_REPO_SETTINGS.md`, `docs/DEMO_CAPTURE.md`,
`docs/GOOD_FIRST_ISSUES.md`, `docs/assets/social-preview.{html,png}`, `docs/assets/screenshot-login.png`.

**Changed (6):** `package.json` (root build now emits workspace `dist` — fixes the broken quick start),
`README.md` (static badges, screenshot + pending-demo note, "Where things live" doc table, quick-start
wording), `packages/shared/src/okhsl.ts` (bug fix + accurate header comment),
`packages/shared/test/unit.test.mts` (golden-value test), `.gitignore` (`*.db`, sqlite, coverage),
`plan/appendix_pi_facts.md` + `plan/implementation_prompt.md` (absolute home paths → `~`).

**Removed from tracking (16):** `true/metadata.db`, `.plan-review-backup-2026-11-05/` (14 files).

## The code bug (the one real defect found)

`chromaStops()` in the vendored OKHSL code dropped the outer reciprocal on both harmonic means
compared with upstream `pi-tui`'s `dist/oklab.js`. `c0`/`cMid` were inflated, so every saturated colour
left the sRGB gamut and clipped to a raw primary:

| Input | Before | After (matches upstream) |
| --- | --- | --- |
| `okhsl(40 10% 90%)` | `#ff0000` | `#e7e1df` |
| `okhsl(265 40% 60%)` | `#ff00ff` | `#7b90bf` |
| `okhsl(120 80% 30%)` | `#00ff00` | `#404c13` |

`npm run test:unit` was already failing on this (`lightness 0.568 vs 0.9`) before this pass — the test
was right and the code was wrong, so the test was kept and the code fixed. Verified by importing the
installed reference module and diffing a 19,656-point grid (hue 0–353 step 7, saturation 0–1 step 0.05,
lightness 0.05–0.95 step 0.05): **all channels match exactly, worst delta 0**; lightness round-trip
error ≤ 0.0008. Goldens added so the drift can't return silently.

## Tests and checks run, with real results

All run locally on macOS, Node 24.x, pi 1.5.0 installed. None of this is GitHub Actions verification.

| Command | Result |
| --- | --- |
| `npm ci` (clean clone) | pass |
| `npm run typecheck` | pass |
| `npm run test:unit` | **pass, 9/9** (was 8 tests, 7 pass / 1 fail before the OKHSL fix) |
| `npm run build` | pass — client 483.67 kB (154.23 kB gzip); workspace `dist` emitted |
| `npm run smoke` (clean clone, tip `b57ccc8`) | **18/22** — fail: `S13` prompt/reply persisted by pi, `S17` parallel prompts on four sessions, `S18` four independent replies, `S20` stats via read worker (`forbidden: path outside registered session roots`) |
| `npm run smoke` (live working tree, same tip + uncommitted changes) | same 18/22, same four failures |
| `npm run p0:verify` | **not run** in this pass; `docs/CAPABILITY_MATRIX.md` carries its last recorded result |
| `./packages/server/bin/pi-web.mjs --help` / `serve` / `allow` / `mint-code` / `workspaces` | all worked as documented |
| `curl http://127.0.0.1:4477/` | 200; login via minted code succeeded in a real browser; screenshots came from this run |
| Workflow YAML validity | pass (`js-yaml`); two bugs found in my own files (unquoted `: ` in a job name, malformed quoted scalar) and fixed |
| Secret scan of tracked files | clean (provider keys, GitHub/Slack tokens, PEM blocks, long opaque literals) |
| `git status` / diff review | only intended changes |

## Not ready for public claims

- **No GitHub Actions green badge.** Workflows have never executed on GitHub.
- **No demo GIF.** Only a real still screenshot; the README says so explicitly.
- **Do not claim parallel sessions or end-to-end persistence work** — `S13`/`S17`/`S18` fail on the tip.
- **Do not claim an npm install path.** Nothing is published and all manifests are `private: true`.
- **Do not claim multi-user or team auth.** Auth proves a session, not a person; stated plainly in `SECURITY.md`.
- **No performance, soak, phone, or screen-reader claims** — `docs/CHECKS.md` already lists these as not run; keep it that way.
- **Platforms:** macOS is what everything here was run on. Linux is plausible (no platform-specific calls found in the read/serve paths) but **unverified**, so the README badge says `macOS · Linux` only as a supported-target statement; changing it to "tested on macOS" is the more conservative option if you prefer.

## Actions requiring your authorization

1. Create the GitHub repository and push `main` (I added nothing remote; no push performed).
2. Merge this branch: see *Handoff* below — and note another agent has uncommitted work in `~/Documents/pi-web`.
3. Decide on npm publication (un-pivate all four manifests + `prepublishOnly`), or keep clone-and-build as the documented install.
4. Tag `v0.1.0` (or `v0.0.1`) — proposed notes below.
5. Apply repo settings: topics, Discussions, social preview, labels, branch protection, secret scanning.
6. Confirm the security disclosure contact (`hadi@hadi.tn`) is where you want reports.
7. Create the five `good first issue` items when you have time to answer questions on them.
8. Nothing was rotated or scrubbed from history. If you publish as-is, `plan/`'s remaining local-path
   references and the removed-in-this-pass artifacts will still exist in **older commits**; because the
   repo has never been pushed, a clean history (fresh initial commit, or `git filter-repo`) is easy to do
   *now* and impossible to undo cheaply later. Your call; I did not rewrite history.

## Suggested repository topics

`pi`, `pi-coding-agent`, `coding-agent`, `ai-agent`, `agent-ui`, `web-ui`, `self-hosted`, `local-first`,
`privacy-first`, `developer-tools`, `devtools`, `typescript`, `react`, `vite`, `fastify`, `sse`,
`open-source`, `session-viewer`, `llm`, `monorepo`

## Proposed release — v0.1.0

> First public release. pi-web is a local-first browser for [pi](https://github.com/badlogic/pi-mono)
> coding-agent sessions: it reads the session files pi writes, renders them, and can drive sessions
> through pi itself — a terminal `pi` via an opt-in bridge extension, or managed `pi` SDK child
> processes. pi remains the only runtime and the only writer of session files; pi-web never executes
> tools, never talks to a model provider, and never writes session JSONL.
>
> **Works today:** loopback server with one-use login codes (2-minute TTL), CSRF + Host + Origin checks,
> CSP, an isolated read worker restricted to allowlisted directories, live SSE streaming with replay and
> resync, four-way concurrent managed sessions in the API, terminal bridge, `mint-token`/`revoke-token`
> for scripting, fail-closed pin to pi 1.5.0.
>
> **Fixed in this release:** the vendored OKHSL colour math was missing two reciprocals relative to the
> pi-tui reference, so saturated theme colours clipped to raw primaries (`okhsl(265 40% 60%)` rendered
> `#ff00ff` instead of `#7b90bf`). Now byte-identical to upstream across a 19,656-point grid, with
> goldens pinned in the unit suite.
>
> **Known limitations:** four full-stack smoke checks fail (`S13`, `S17`, `S18`, `S20`) — end-to-end
> persistence of a prompt/reply, four parallel prompt acceptance/replies, and stats through the read
> worker; no embedded terminal, editor, settings UI or credential management (those stay in pi);
> terminal extension dialogs are observable but not remotely answerable (pi 1.5.0's extension API has no
> response channel); install is clone-and-build (`npm ci && npm run build`), no npm package yet; macOS is
> the only verified platform; no demo GIF yet.

## Proposed Show HN

**Title:** Show HN: pi-web – browse and drive your pi coding-agent sessions from a browser

> pi-web is a local-first web UI for the `pi` coding agent. It reads the session JSONL files pi already
> writes and lets you browse them, and drive sessions, from a browser — including from your phone over
> a mesh VPN.
>
> The constraint that shaped everything: **pi stays the only runtime and the only writer of session
> files.** pi-web never executes tools, never talks to a model provider, and never writes session data.
> Terminal sessions are controlled through an opt-in pi extension bridge you start per-process;
> browser-created sessions run as managed `pi` SDK children, and the UI refuses to hand a session back
> to your terminal until the child has released the file.
>
> It is pinned to pi 1.5.0 and fails closed: if the installed pi is not the validated version, the
> runtime features turn off rather than guess. `docs/CAPABILITY_MATRIX.md` is generated by a test that
> mirrors every claim in the README, so "verified" and "not verified" are both visible.
>
> Security posture, since it reads your agent history: loopback by default, one-use login codes with a
> 2-minute TTL, session cookies `HttpOnly SameSite=Strict`, CSRF and Origin checks on every mutation, a
> Host allowlist built from server config (anti DNS-rebinding), CSP on every response, and reads done in
> a separate worker restricted to directories you explicitly allowlist. Nothing is scanned by default.
>
> Honest limitations, before you ask: four of our 22 full-stack smoke checks currently fail (persistence
> of a prompt/reply, four parallel prompts, and stats through the read worker); terminal extension
> dialogs can be observed but not answered remotely because pi's public extension API has no response
> channel; there is no embedded terminal or settings UI; there is no npm package yet, so it's
> `npm ci && npm run build` plus `./packages/server/bin/pi-web.mjs serve`; macOS is the only platform
> we've actually exercised; and the demo GIF is still pending, so the screenshot is what there is to see.
>
> Feedback we want most: (1) is the bridge model the right way to touch a pi process you already have
> open, or should browser-created sessions be the only path; (2) what would make you trust a tool that
> reads your agent history; (3) which of the four failing checks matters most to you, since they gate the
> first tagged release.

**Short community post (GitHub / Matrix / a HN comment):**

> **pi-web** — a local-first browser for pi coding-agent sessions. Browse what pi wrote, drive it from
> your phone over your mesh VPN, and pi stays the only runtime and only session writer. Loopback by
> default, one-use login codes, reads sandboxed to directories you allowlist. Clone-and-build for now
> (`npm ci && npm run build && ./packages/server/bin/pi-web.mjs serve`); macOS verified; four smoke
> checks still failing and listed in the README. Repo: <url>. Issues and PRs welcome — `CONTRIBUTING.md`
> has the map and the conventions.

## Prioritized remaining work

1. **Fix `S13`, `S17`, `S18`, `S20`** (or restate what they should assert). They are the difference
   between "works on my machine" and a v0.1.0 claim, and `S17`'s `0,202,202,202` looks like one request
   never getting a response — likely a small fix. `S20` (`path outside registered session roots`) smells
   like macOS `/var` → `/private/var` realpath handling in the read worker.
2. **Publish the repository**, then immediately apply settings (§1–§6 of `docs/GITHUB_REPO_SETTINGS.md`)
   and run the first CI so the workflow is actually verified.
3. **Decide the install story** (npm publish or accept clone-and-build publicly).
4. **Record the demo GIF** per `docs/DEMO_CAPTURE.md`.
5. **Platform evidence:** either run typecheck/unit/build/smoke on Linux (a container is enough) and say
   "macOS + Linux", or soften the badge and README to macOS-verified.
6. **History hygiene before first push** if you want `plan/` and old artifacts out of the public record.
7. Upload the social preview, enable Discussions, create the labels and the five good-first issues.

## Handoff

Everything is on branch `oss-readiness` in `/Users/hadi/work/pi-web-oss` (a clone of
`/Users/hadi/Documents/pi-web` at `b57ccc8`; `origin` is that path). Two commits:

```
933c7b5 fix(shared): restore gamut reciprocals in vendored OKHSL math
06f94a0 chore: launch readiness — CI, security and contribution docs, repo hygiene
```

To bring it into the live checkout **after** the other lane's work is committed:

```bash
cd ~/Documents/pi-web
git fetch ~/work/pi-web-oss oss-readiness
git merge --no-ff FETCH_HEAD     # expects no conflicts: docs + package.json + shared only
```

`package.json` and `README.md` are the only files likely to conflict with concurrent work; both conflicts
will be obvious (root build script; README top block). If the other lane has since added `src/ui/`,
tokens, or its own CI, prefer keeping theirs and re-applying only `build:packages` plus the docs.


## Publication (later turn, after this audit was written)

Decisions taken with the operator: npm publication is **deferred**; the GitHub repository was created
and pushed. npm name note: `piweb` was reported as already taken when creating the org, and `pi-web`
was likewise unavailable, so the npm side waits for a name decision.

* **Repository:** `https://github.com/h8ntome/piweb` — created **private**, default branch `main`.
  Flip to public when the review below is done: `gh repo edit h8ntome/piweb --visibility public`.
* **Pushed:** 9 commits, all re-authored to `h8ntome <h8ntome@users.noreply.github.com>` (the previous
  identities were `hadi <hadi@local>` and a local config address; neither maps to the GitHub account,
  and neither needed to be published).
* **Configured:** description, 20 topics, Discussions enabled, 8 triage labels, Dependabot active.
* **Verified on GitHub Actions:** CI green on both Node legs; advisory e2e executed with the documented
  smoke failure; the CI status badge can now be added to the README once the repository is public
  (`https://github.com/h8ntome/piweb/actions/workflows/ci.yml/badge.svg`) — it stays out while private,
  because a badge that needs a token to render is not an honest badge.
* **Not applied:** social preview upload (GitHub has no REST endpoint for it; Settings → General →
  Social preview, file `docs/assets/social-preview.png`), Discussions categories (web UI or GraphQL),
  branch protection (add when the repo goes public), good-first-issues as real issues.
* **Blocker before public:** there is **no LICENSE file** (item 5 above). The history also still contains
  the original `plan/` drafts with absolute `/Users/hadi` paths inside older commits; the working tree is
  scrubbed, but the older blobs are not. Scrub with `git filter-repo` before going public if you want
  that gone, or accept it as ordinary author-path noise.

**Local checkouts to reconcile:** `~/Documents/pi-web` (the live lane, still with its own uncommitted work)
now has *different SHAs* for its history because of the identity rewrite, and it has no GitHub remote:

```bash
cd ~/Documents/pi-web
git remote add github git@github.com:h8ntome/piweb.git
git fetch github
git rebase --onto github/main <old-tip>   # replays the lane's commits on the published history
```

Or simply work from a fresh clone of `github.com/h8ntome/piweb` and re-apply whatever is still unfinished.
