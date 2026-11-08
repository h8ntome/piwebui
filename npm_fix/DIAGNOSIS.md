# `npm install -g @piwebui/pi-web` → `zsh: command not found: pi-web`

> **Update 2026-11-08 (later the same day): done.** `v0.1.1` is published and `latest` is one
> coherent set again (`pi-web` + `piweb`, bridge included); the three commands listed at the bottom
> of this file were run, and `verify:published --tag latest --expect-version 0.1.1 --all` passes.
> That pass also found two things this write-up could not see from the tree — `latest` was not one
> release at all (the bridge's `0.1.0` was hand-published 18 h after the server's), and a warm npm
> packument cache can install the old artifact after a good publish. Both are documented, gated and
> dated in [`README.md`](README.md); read that file for the current state.

Logged on `hadi@MacBook-Air` in `npm_fix/npm_install_error.md`. Reproduced, root-caused, fixed, and
guarded on 2026-11-08.

## 1. What the log actually says

The install did **not** fail. npm resolved the `latest` dist-tag, downloaded it, and reported success:

```
npm warn deprecated node-domexception@1.0.0   # from the dependency tree, harmless
added 176 packages in 3s                       # success
```

The failure is the *next* line: `pi-web` is not on `PATH` after that successful install. So the
question is not "why did npm fail?" but "why did the installed package not put `pi-web` on `PATH`?"

## 2. Root cause — a `bin` map in the published artifact that does not match the documented command

`npm view @piwebui/pi-web --json` (registry truth, `latest` = `0.1.0`):

```json
"bin": { "piweb": "bin/pi-web.mjs" }
```

One command, named **`piweb`**. The README, the CLI table, the CHANGELOG and every example tell users
to type **`pi-web`**. That artifact therefore installs a `piweb` symlink and no `pi-web` symlink —
which is exactly `zsh: command not found: pi-web` with a green install above it.

History of the name (git):

| commit | date | `bin` in `packages/server/package.json` |
| --- | --- | --- |
| `6096807` | earlier | `pi-web` |
| `3cf2852` | 2026-11-07 13:45 | renamed to `piweb` ("`pi-web` is used by an unrelated npm package") |
| — | 2026-11-07 17:08 | **`0.1.0` published by hand with a granular token**, i.e. `bin: {piweb}` |
| `f78ff29` | 2026-11-08 06:13 | `pi-web` restored, `piweb` kept as alias; canary `0.1.1-canary.5` published to `next` |

The repository is now correct; the **published `latest` is not**, and cannot be: npm versions are
immutable (`E403` on re-publishing `0.1.0`), and nothing moves `latest` except a tag push. The
manifests were never version-bumped past `0.1.0`, so every plain `npm install -g` keeps landing on the
`piweb`-only artifact. Reproduced here on the same day:

```
$ npm i -g --prefix /tmp/gprepro/latest  @piwebui/pi-web@latest
/tmp/gprepro/latest/bin:  piweb            # no pi-web  -> the reported error
$ npm i -g --prefix /tmp/gprepro/next    @piwebui/pi-web@next
/tmp/gprepro/next/bin:    pi-web  piweb    # pi-web 0.1.1-canary.5.512e9a3
```

Secondary defect found on the way: the README's "command not found" troubleshooting section blamed
only `PATH`, which sends users into their shell config for what is a version/content problem.

Tertiary note: the unscoped `pi-web` package on npm (v0.15.5) also ships a `pi-web` bin, so a global
prefix that already has *that* one can fail this install with `EEXIST` on the symlink. `piweb` stays
shipped as the escape hatch. This is why both names are declared.

## 3. Fix

**Ship the documented command, and make the mismatch impossible to repeat.**

1. `packages/{shared,pi-adapter,server}/package.json` (and the lockfile): `0.1.0` → `0.1.1`.
   `0.1.0` is immutable, so the repaired manifest must go out under a new version; tagging `v0.1.1`
   moves `latest`, and `npm install -g @piwebui/pi-web` then gets `bin: {pi-web, piweb}`.
2. `scripts/cli-names.mts` (new): the single declaration of the command names (`pi-web`, `piweb`) and
   of the doc files that count as user-facing instructions.
3. `scripts/check-cli-names.mts` (new) — pre-build gate, wired into `npm run build` and CI:
   - `bin` must contain every declared name, all pointing at `bin/pi-web.mjs`, and no undeclared ones;
   - each declared target must exist, carry a node shebang, and be covered by the `files` allowlist
     (otherwise `npm pack` ships a manifest whose launcher is missing);
   - every command-like token in executable position inside fenced code blocks in
     `README.md` / `MAINTAINERS.md` / `CHANGELOG.md` / `docs/**` must be a name the package ships
     (catches `pi_web`, and catches docs that drop the shipped name).
4. `scripts/verify-published.mts` (new) — registry-side gate, wired as the last step of `release.yml`:
   resolves the dist-tag, checks the *published* manifest's `bin` map, packs the published tarball and
   checks each declared bin plus `dist/main.js` and `client-dist/index.html` actually ship inside it,
   then runs a real `npm install -g` into a scratch prefix and executes `pi-web --version` /
   `piweb --version` from an unrelated cwd. `--settle` waits out npm's read-replica lag;
   `--expect-version` asserts the dist-tag really moved to the version just published.
5. `scripts/package-smoke.ts`: the tree-side gate now asserts the *installed* bin map (and the packed
   manifest's `bin` keys) instead of checking one hardcoded filename, and fails with the user-visible
   consequence ("`npm i -g` then reports command not found for the documented command").
6. Docs: README troubleshooting rewritten to check the installed artifact before `PATH` (and records
   the `pi-web` name collision); `MAINTAINERS.md` corrected (it still claimed bin was deliberately
   `piweb`-only) with the release-cut procedure, the registry-side verification command, and the
   "command names are a checked contract" rule; CHANGELOG entry under Fixed.

## 4. Verification

| check | result |
| --- | --- |
| `npm run check:cli` on the fixed tree | pass — `bin ships pi-web, piweb`; `docs use pi-web, piweb — all shipped by bin` |
| `verify-published.mts` against **`latest` (0.1.0, the broken artifact)** | **fails exactly as the log predicts**: "`0.1.0 ships bin = {"piweb":...}: the documented command `pi-web` is absent, so `npm i -g @piwebui/pi-web` succeeds and then `pi-web` is not found`" (exit 1) |
| `verify-published.mts` against **`next`** | pass — `bin map declares pi-web, piweb`; tarball has launcher + `dist/main.js` + `client-dist/index.html`; `npm i -g` into scratch prefix; `pi-web --version` → `pi-web 0.1.1-canary.5.512e9a3`; `piweb --version` same |
| Full `npm run package:smoke` at version `0.1.1` (clean worktree, `npm ci`) | pass — pack → clean install → `packed bins: pi-web, piweb` → boot → `pi-web --version` = `0.1.1` → `--help` → mistyped flag exit 2 → port-in-use line → `--port 0` → **`npm i -g` into a fresh prefix: `pi-web --version` = `pi-web 0.1.1`** → globally installed server answers `/api/v1/health` |
| Regression tests of the new gate (scratch copy) | removing `pi-web` from `bin` → 4 actionable failures; docs using `pi_web` → fails; extra undeclared bin name → fails; bin target missing from `files`/disk → fails (each exit 1) |
| `npm ci` with the patched lockfile | clean (`262 packages`), so lock and manifests are in sync |

Remaining step to make it true for strangers (a public npm publish — needs Hadi's go-ahead):

```bash
git push origin main                     # canary on `next`, exercises the new release gates in CI
git tag v0.1.1 && git push origin v0.1.1 # publishes 0.1.1 and moves `latest` onto the fixed bin map
npm run verify:published -- --tag latest --expect-version 0.1.1   # the error is gone for new installs
```

Until then the workaround for anyone hitting the logged error is `piweb` (any version) or
`npm i -g @piwebui/pi-web@next`.
