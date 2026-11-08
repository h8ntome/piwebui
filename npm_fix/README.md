# `npm i -g @piwebui/pi-web` succeeded, then `zsh: command not found: pi-web`

**Status: fixed, published and verified on 2026-11-08.** `latest` is `0.1.1` across all four
packages, published as one set, and a clean `npm i -g @piwebui/pi-web` now produces both `pi-web` and
`piweb` and runs `pi-web doctor`. This file is the full record: what was reported, every cause that
was checked (including the ones that were ruled out), what was changed, how each claim was verified,
and the invariants the next agent must not break.

Read [`DIAGNOSIS.md`](DIAGNOSIS.md) for the first pass (same report, root-caused and fixed **in the
tree** on 2026-11-08 morning). The part that pass could not finish is step 3 here: the tree being
correct is not the same as `latest` being correct, and nothing in CI was watching the difference.

Reported by `hadi@MacBook-Air` in [`npm_install_error.md`](npm_install_error.md):

```
npm install -g @piwebui/pi-web
npm warn deprecated node-domexception@1.0.0: Use your platform's native DOMException instead
added 176 packages in 3s
pi-web
zsh: command not found: pi-web
```

The shape that matters: **the old UI and the old commands still work; the new ones do not.** That is
not a shell, a PATH or a broken-install problem. It is exactly what a stale `latest` dist-tag looks
like from the outside — and there were two independent stale things under it.

---

## 1. Root cause A — `latest` is `0.1.0`, and `0.1.0` ships only the `piweb` command

`npm install -g @piwebui/pi-web` resolves the `latest` dist-tag. The registry answered (verified
twice, once through npm and once with `curl` straight at the packument so no cache or client could
be involved):

```jsonc
// https://registry.npmjs.org/@piwebui%2Fpi-web
"dist-tags": { "latest": "0.1.0", "next": "0.1.2-canary.11.b6d0576" }
"versions"."0.1.0".bin   = { "piweb": "bin/pi-web.mjs" }     // no "pi-web"
"versions"."0.1.0".time  = "2026-11-07T17:08:19.611Z"
```

`bin` is the *only* thing that puts a command on `PATH`. A manifest that declares `piweb` installs a
`piweb` symlink and nothing else, so a perfectly green install is followed by `command not found`
for the name the README uses. Reproduced from scratch in this session:

```
$ npm i -g --prefix /tmp/scratch/latest @piwebui/pi-web@latest
/tmp/scratch/latest/bin:  piweb                       # pi-web absent  -> the report

$ npm i -g --prefix /tmp/scratch/next   @piwebui/pi-web@next
/tmp/scratch/next/bin:    pi-web  piweb               # 0.1.2-canary.11.b6d0576
```

Why it stayed broken after being fixed: npm versions are **immutable** (re-publishing `0.1.0` answers
`E409`/`E403`), and nothing moves a dist-tag except a publish with `--tag` or a manual
`npm dist-tag add`. The manifests were bumped to `0.1.1` in the tree, but a version bump in git does
nothing to the registry until a **tag push** cuts the release (`release.yml` publishes `v*` tags to
`latest`; every `main` push publishes a canary to `next` only). At the time of writing, the only tag
in the repo was `v0.1.0`. So the repaired manifest existed only inside canaries nobody installs.

That is also why "the **old UI** still works": `0.1.0` shipped the pre-rebuild client. Its
`client-dist/assets/*.js` still contains the login surface (`Sign in`, `login`, the `mint-code`
flow), while the `0.1.1` bundle contains none of it and does contain `Terminal (bridged)`. Anyone on
`latest` was looking at the interface from 2026-11-07 — which is the experience in the report, and
why "the install is green, the app opens, and the new thing is simply not there" was never one bug
but a whole stale artifact.

## 2. Root cause B — `latest` was not one release: same version numbers, 18 hours apart

This is the half that explains that explains "**the new** stuff doesn't work" rather than just "one name is
missing". The four publishable packages share one version number by design, but their `latest` tags
had been moved independently:

| package | `latest` | when that version was published | what that artifact contains |
| --- | --- | --- | --- |
| `@piwebui/shared` | `0.1.0` | 2026-11-07 17:06:22Z | pre-bridge |
| `@piwebui/pi-adapter` | `0.1.0` | 2026-11-07 17:07:00Z | pre-bridge |
| `@piwebui/pi-web` (the CLI + server) | `0.1.0` | 2026-11-07 **17:08:19Z** | **no terminal bridge at all** |
| `@piwebui/pi-web-bridge` (the `pi` extension) | `0.1.0` | 2026-11-08 **11:25:32Z** | the **new dial-mode bridge** |

The bridge needed a one-time hand-publish to exist on npm at all (npm cannot register a trusted
publisher for a package that does not exist — npm/cli#8544), and that bootstrap uploaded the
manifest as committed at the time, which happened to be version `0.1.0`. A version number that a
released sibling had already used.

Consequence for the user who follows the README today:

```bash
npm install -g @piwebui/pi-web                    # server 0.1.0  -> no bridge listener
pi install npm:@piwebui/pi-web-bridge            # bridge 0.1.0  -> dials ~/.pi-web/bridge.json
```

Verified against the published artifacts, not inferred:

- `@piwebui/pi-web@0.1.0` `dist/*.js` contains **zero** references to `bridge.json`/descriptor and
  three to the *legacy* `PIWEB_BRIDGE_TOKEN` transport (`pi-web print-bridge-command` was its
  pairing command);
- `@piwebui/pi-web-bridge@0.1.0` `extensions/pi-web-bridge.js` references the descriptor **25**
  times and dials a per-server Unix socket that the `0.1.0` server never opens.

So the bridge installs, loads, finds no descriptor, and the terminal `pi` never appears in the
browser. "Old UI works, new feature silently does nothing."

## 3. Root cause C — the docs promise subcommands the released artifact does not have

`0.1.0`'s published `dist/main.js` dispatches exactly these subcommands:

```
allow  install-bridge  logout-all  mint-code  mint-token  print-bridge-command  revoke-token  serve  workspaces
```

The README and `MAINTAINERS.md` instruct `pi-web doctor`, `pi-web install-extension`,
`pi-web pair`, `pi-web rotate-bridge-token`, `pi-web trust-runtime`, `pi-web revoke-runtime`. None
of them existed in the artifact a plain install produces. Worse, `0.1.0` answered an unknown
subcommand with usage text and **exit 0**:

```
$ ./scratch/latest/bin/piweb doctor
usage: pi-web [serve|allow <dir>|workspaces|mint-code|mint-token|revoke-token|logout-all|install-bridge|print-bridge-command]
$ echo $?
0
```

so scripts and humans both read that as "it ran". (The current tree exits `2` with
`unknown command: doctor` — fixed as part of the CLI rebuild, another thing `latest` did not have.)

## 3b. Root cause D — a correct release can still install as the old one (packument cache)

Found *after* the fix shipped, while verifying it, and the reason a user can report "I reinstalled and
it is still broken" minutes after everything was correct on the registry:

```
$ npm i -g --prefix /tmp/t1 @piwebui/pi-web@latest   # warm cache
0.1.0     bin: piweb            <- the broken artifact, again
$ npm i -g --prefix /tmp/t2 --prefer-online @piwebui/pi-web@latest
0.1.1     bin: pi-web piweb     <- what the registry actually serves
$ npm cache clean --force && npm i -g --prefix /tmp/t3 @piwebui/pi-web@latest
0.1.1     bin: pi-web piweb
```

The registry answers the *abbreviated* packument (the one `npm install` resolves from — different
from the one `npm view` reads, and cached under a different key) with:

```
cache-control: public, max-age=300     age: 197
```

so npm is allowed to resolve `latest` from a copy up to five minutes old, and npm's read replicas can
hand back a lagging copy that then gets cached for another five. Two independent staleness layers on
top of the dist-tag problem, both transient, both indistinguishable from "the fix did not work". This
also bit the release gate itself: `verify:published` installed `0.1.0` from a warm cache and failed a
release that was fine, which is why every registry read in that script now passes `--prefer-online`
(`PIWEB_VERIFY_USE_CACHE=1` restores the old behaviour for debugging).

## 4. Everything else checked, and what ruled it out

Each row is a candidate cause for "the new package/command is not recognised", checked in this
session against the live registry or a scratch prefix.

| Candidate cause | Verdict | Evidence |
| --- | --- | --- |
| `bin` map of the installed artifact missing `pi-web` | **CONFIRMED (A)** | `npm view @piwebui/pi-web bin` → `{"piweb":"bin/pi-web.mjs"}`; scratch `npm i -g` produced `bin/piweb` only |
| `latest` a mixed set across the four packages | **CONFIRMED (B)** | publish timestamps above, 18 h apart under the same version number |
| Docs ahead of the released CLI (subcommands) | **CONFIRMED (C)** | `0.1.0` `dist/main.js` grep; `piweb doctor` → usage, exit 0 |
| `PATH` does not include the npm global bin dir | ruled out | the *same* install produced a working `piweb` from that directory; `command not found` for one name and not the other cannot be PATH |
| npm packument cache resolving `latest` from a stale copy | **CONFIRMED as a transient cause (D)** | warm-cache `npm i -g` installed `0.1.0` (`bin: piweb`) after `0.1.1` was published; `--prefer-online` and `npm cache clean --force` both install `0.1.1`; the registry sends `cache-control: public, max-age=300` for the abbreviated packument |
| npm registry read-replica lag | **CONFIRMED as a transient cause**, not the root cause | the same packument request returned different `latest` values minutes apart during the release; `verify-published.mts` waits it out with `--settle`, and now always reads with `--prefer-online` |
| npm registry read-replica lag | handled | see the row above; `--settle` in `verify-published.mts` is the mitigation, not a cause |
| `npm i -g` failing for a dependency/peer reason (e.g. `@earendil-works/pi-coding-agent` peer pin) | ruled out | the install reported `added 176 packages`; reproduced identically here |
| `files` allowlist shipping a manifest whose launcher is absent | ruled out | `tar tzf piwebui-pi-web-0.1.0.tgz` contains `package/bin/pi-web.mjs` |
| launcher broken (shebang, cwd assumptions, no `dist/`) | ruled out | shebang present, `dist/main.js` present; `piweb --version` works on the old artifact |
| `engines.node` too old on the Mac | ruled out | the launcher prints `pi-web: Node X is too old; pi-web needs >=22.19.0` rather than a syntax error, and the install ran |
| name collision: unscoped **`pi-web@0.15.5`** also installs a `pi-web` command | **CONFIRMED as a second, independent failure mode** | `npm i -g --prefix P pi-web@0.15.5` then `npm i -g --prefix P @piwebui/pi-web@next` → `EEXIST: file already exists, .../bin/pi-web`. Repair: `npm rm -g pi-web` first, or use `piweb` |
| publish blocked for lack of a trusted publisher | ruled out | the canary run for the release commit published all four packages (`blocked` was empty; the "Fail the run…" step was skipped) |
| tag/manifest version mismatch refusing the release | ruled out | all four publishable manifests at `0.1.1`; `Refuse a tag that does not match the manifests` passes for `v0.1.1` |
| lockfile/manifest drift (`npm ci` failing, so CI never publishes) | ruled out | `npm ci` clean; `npm run build`, `test:unit`, `package:smoke` all green on this tree |

## 5. The fix

**Ship the documented command as a real release, then make every layer of this drift fail loudly.**

1. **Cut `v0.1.1` and let CI publish it to `latest`** (the only supported way `latest` moves):

   ```bash
   git tag v0.1.1 && git push origin v0.1.1
   ```

   `release.yml` then runs `check:cli` → `build` → `package:smoke` (pack → clean install →
   boot → `npm i -g` into a scratch prefix → `pi-web --version`) before publishing anything,
   publishes all four packages in dependency order with `--tag latest`, and finishes with
   `verify-published.mts` against the registry.
2. **`scripts/verify-published.mts` — release-set integrity (new step 2).** Every publishable
   package must be on the requested dist-tag at the same version **and** that version must have been
   published within one window (`--set-window-hours`, default 6). This is the only check that can see
   cause B: same version number, different release. It runs before any install work because it is the
   cheapest check and it explains the shape of every other failure here.
3. **`scripts/verify-published.mts` — published subcommands (new step 6).** Every
   `pi-web <subcommand>` documented in the repo must appear in the **published** `dist/main.js`.
   It self-disables when the checkout's manifest version differs from the version under test, so
   main's normal lead over the last stable can never read as drift.
4. **`scripts/check-cli-names.mts` — the tree-side half of the same contract.** Documented
   subcommands must be dispatched by `packages/server/src/main.ts`; `docFiles()` now also reads
   `packages/<pkg>/README.md`, and `docs/research/` is excluded for real (the comment claimed it,
   the code walked it).
5. **`.github/workflows/registry-drift.yml` (new).** Daily (`17 6 * * *`), on demand, and whenever
   the release scripts or the server manifest change: runs `check:cli` and
   `verify:published --tag latest --all --settle 300`, and prints what each package's `latest`
   resolves to. There was no watcher between "release shipped" and "a user notices"; now a stale or
   mixed `latest` is a red run. It needs no credentials — it only reads and installs.
6. **`verify-published.mts` reads the registry with `--prefer-online` on every call.** Without it the
   gate measures what npm *remembers* (cause D) and fails a release that is fine; it did exactly that
   during this session. `PIWEB_VERIFY_USE_CACHE=1` restores cached reads for debugging.
7. **Docs.** `README.md` troubleshooting now leads with "ask npm what your artifact declares", covers
   the mixed-set case, the stale-cache case, the `EEXIST` collision repair, and points here.
   `MAINTAINERS.md` gained *A release is a set, not a package* (including the rule that a
   bootstrap hand-publish must use a scratch version, never a number a released sibling already used).
   `docs/CHECKS.md`, `CHANGELOG.md` and this file record the verification.

## 6. Verification

| Check | Result |
| --- | --- |
| `npm run check:cli` | pass — `bin ships pi-web, piweb`; `12 documented subcommands all dispatched (allow, doctor, help, install-bridge, install-extension, mint-token, pair, revoke-token, rotate-bridge-token, serve, trust-runtime, workspaces)` |
| `npx tsx --test scripts/test/cli-names.test.mts` | 6/6 pass (parsers: command tokens incl. the `pi_web` typo, subcommands vs. arguments/flags, real docs vs. real dispatcher, scanned-file list) |
| Gate negative tests (scratch tree) | docs promise a dropped subcommand → **fail**; `bin` without `pi-web` → **fail (3 problems)**; good tree → pass |
| `verify-published --tag latest --all` **before** the release | **fails naming cause B**: `"latest" is not one release … published more than 6h before the newest` (with all four timestamps) |
| `verify-published --tag next --all` | pass — `release set on "next" is one cut: 4 packages at 0.1.2-canary.11.b6d0576, published within 1 min`; tarball, `npm i -g`, `pi-web --version`, `piweb --version` |
| `npm run package:smoke` (this tree, `0.1.1`) | pass — pack → clean install → `packed bins: pi-web, piweb` → boot → `--version`/`--help` → mistyped flag exit 2 → port-in-use line → `--port 0` → `npm i -g` → `pi-web --version = pi-web 0.1.1` → globally installed server answers the API |
| `npm run build`, `npm run typecheck`, `npm run test:unit`, `npm ci` | all green |
| CI on the release commit `c0e4502` | `CI` ✅, `e2e (advisory)` ✅, `release` (canary) ✅ — proves the exact tag commit publishes and self-verifies; `registry drift` ❌ **by design** (it is reporting cause B) |
| `v0.1.1` tag publish (`release.yml`, run 42485393540) | **success** — tag/manifest check, build, `package:smoke`, all four published to `latest`, then `verify:published --version 0.1.1 --all` and `--tag latest --expect-version 0.1.1 --all` |
| `npm run verify:published -- --tag latest --expect-version 0.1.1 --all` (from this box, after the release) | **pass** — `release set on "latest" is one cut: 4 packages at 0.1.1, published within 4 min`; `bin map declares pi-web, piweb`; tarball has launcher + `dist/main.js` + `client-dist/index.html` (97 files); `npm i -g` → `pi-web --version` = `pi-web 0.1.1` and `piweb --version` = `pi-web 0.1.1`; **12 documented subcommands dispatch in the published `dist/main.js`**; shared/adapter/bridge verified at `0.1.1` |
| The reported commands, verbatim, in a scratch prefix | `npm install -g @piwebui/pi-web` → `added 176 packages`; `ls bin` → `pi-web  piweb`; `pi-web --version` → `pi-web 0.1.1`; `pi-web doctor --json` → real JSON report (a command `0.1.0` did not have) |
| `registry drift` workflow, re-run after the release (run 42486570361) | **green** — same run that was red 22 minutes earlier on the same code path: `release set on "latest" is one cut: 4 packages at 0.1.1, published within 4 min`, `12 documented subcommands dispatch in the published dist/main.js` |
| Cause D reproduced after the fix (warm cache) | `npm i -g --prefix /tmp/t1 @piwebui/pi-web@latest` → `0.1.0` / `piweb` only; with `--prefer-online` → `0.1.1` / both names; after `npm cache clean --force` → `0.1.1`. Registry headers: `cache-control: public, max-age=300`, `age: 197` |

## 7. If you are hitting this on a Mac right now

```bash
# what do you actually have, and what does npm think latest is?
npm ls -g @piwebui/pi-web ; npm view @piwebui/pi-web dist-tags ; npm view @piwebui/pi-web bin

# the repair
npm install -g @piwebui/pi-web@latest        # 0.1.1+ answers to pi-web
pi-web --version
pi install npm:@piwebui/pi-web-bridge        # bridge + server are now the same cut
pi-web doctor                                # says why a terminal pi is not live, if it is not
```

If you ran those and *still* got `command not found`, that is cause D, not a bad release — your npm
cached the old `latest` (max-age 300, plus replica lag). Force a fresh resolve:

```bash
npm install -g --prefer-online @piwebui/pi-web@latest
# or, if something else has poisoned the cache:
npm cache clean --force && npm install -g @piwebui/pi-web@latest
npm view @piwebui/pi-web bin        # must show both pi-web and piweb
```

If `npm install -g` dies with `EEXIST: file already exists … bin/pi-web`, the unrelated unscoped
`pi-web` package owns that symlink: `npm rm -g pi-web` (not `@piwebui/pi-web`), then reinstall.
If `latest` has not been cut yet, `@next` is the same code as `main`. If you published a fix minutes
ago and your terminal still shows the old one, that is npm's read replica and/or your local
packument cache: `npm view --prefer-online` or `npm cache clean --force`.

## 8. For the next agent editing this

**Invariants, all of them broken at least once in this repository's history:**

1. `bin` is the contract for what lands on `PATH`. The published artifact's `bin` must contain every
   name the docs use — see `scripts/cli-names.mts`; add a name in three places or not at all.
2. Subcommands are part of the contract too. If the README shows `pi-web <thing>` in a fenced block,
   `packages/server/src/main.ts` must dispatch it **and** the released artifact must contain it.
3. **A release is the set of all publishable packages, moved together.** Versions are per package and
   immutable; `latest` is per package too, so "same version number" ≠ "same release". Never hand-publish
   one package of the set as an escape hatch, and never move `latest` with `npm dist-tag add`.
4. A bootstrap hand-publish (needed once per package, because npm cannot register a trusted publisher
   for a package that does not exist) must use a **scratch version** such as `0.0.0-stage`, never a
   number a released sibling already used. `0.0.0-stage` exists on all four packages for this reason.
5. Docs describing an unreleased feature are a claim about the registry. Either release it or mark it
   unreleased; `check:cli` will not catch "documented in the README, true on main, absent on npm" —
   `verify:published` and the drift workflow do.
6. Any check that asks "what does npm serve?" must read with `--prefer-online` (or a cold cache).
   `max-age=300` plus lagging read replicas means npm can happily install a version it cached five
   minutes ago, and a gate that measures that memory reports a good release as broken.

**Where things live:**

| File | Role |
| --- | --- |
| `scripts/cli-names.mts` | the names, the launcher path, the doc scanner, the subcommand parsers — single source of truth |
| `scripts/check-cli-names.mts` | tree gate: `bin` ↔ launcher ↔ `files` ↔ docs ↔ dispatcher; runs first in `npm run build` and in `ci.yml` |
| `scripts/verify-published.mts` | registry gate: what a stranger's `npm i -g` gets — release set, `bin`, tarball, real install, published subcommands |
| `scripts/package-smoke.ts` | artifact gate on the tree: pack → clean install → boot → global install |
| `scripts/publish-list.mts` | the publishable set, derived from the workspace; CI loops over it so a new package cannot be forgotten |
| `.github/workflows/release.yml` | canary on every `main` push, stable on `v*` tag; verification is the last step, so a release that does not answer to `pi-web` fails red |
| `.github/workflows/registry-drift.yml` | the daily watcher for everything this incident was about |
| `packages/server/bin/pi-web.mjs` | the launcher behind both names |
| `packages/server/src/main.ts` (`runCli`, `HELP`) | the subcommand dispatcher; the gate parses `cmd === "…"` here |
| `npm_fix/DIAGNOSIS.md` | the first pass: tree-side fix and the guards it added |

**Cutting the next release:** bump every publishable manifest (and the lockfile) to one version,
commit, push `main`, wait for the canary `release` run to go green, then `git tag v<ver> && git push
origin v<ver>`, then `npm run verify:published -- --tag latest --expect-version <ver> --all`. The tag
must match the manifests exactly or the workflow refuses before publishing anything.

**Known residual risks / follow-ups:**

- `next` will keep floating ahead of `latest`; anything merged after `v0.1.1` is only in canaries
  until the next tag. That is the design, not drift.
- The 6-hour release-window heuristic is a proxy for "one cut". A publish that is retried hours later
  can trip it; `--set-window-hours` is the dial, and the message names every timestamp it compared.
- The unscoped `pi-web` name collision is npm's, not ours; `piweb` stays shipped as the escape hatch,
  and the README says so.
- The drift workflow reads `docs/` from `main`, so it compares the registry against *current* docs.
  The subcommand check self-disables when main's version has moved past the release; the `bin` and
  release-set checks never do, which is what keeps them honest.
- `0.1.0` stays on npm forever, broken, unfixable. Nothing should try to repair it; the only lever is
  a newer version on the tag.
