# Maintainer guide

Small project, one maintainer, no bot army. This is the workflow that is actually sustainable.

## The 24-hour rhythm (when you have time)

The goal is that nobody files an issue into a void, not that everything is fixed quickly.

1. **New issue → triage the same day if possible, within a few days at worst.**
   - Read it. If the repro is missing, comment one specific question and add `needs-repro`.
   - If it is real and scoped, add `bug`/`enhancement` plus one area label (`ui`, `pi-integration`, `perf`).
   - Add `needs-triage` when you cannot get to it yet; remove it once handled. It is the "seen, not forgotten" marker.
2. **Acknowledge with something useful.** A one-line "Confirmed on <commit>, this is the read worker
   refusing a non-allowlisted root — I think the fix is X, no workaround yet" is worth more than any
   auto-reply. Never close as `stale` without a human note.
3. **Feature requests** get either a pointer to the capability matrix row that governs them or a short
   "out of scope because pi stays the only runtime/writer" with a link to the rule. Both are answers.
4. **Bots and Dependabot PRs** are merged when CI is green and the change is patch/minor; version bumps
   of majors wait for a manual check, since the client pins `marked`, `dompurify` and `highlight.js`.

Do not run stale-issue automation. For a project this size, closing three-month-old issues that nobody
answered produces a worse repository than leaving them open.

## Issue hygiene worth keeping

- Reproduce locally with a throwaway `--data-dir` before believing a report; several classes of bug here
  are environment-specific (Node version, installed pi version, macOS case-insensitive paths).
- When a report is really "pi behaves differently", label `pi-integration` and add the exact pi version.
- Convert good support answers into Discussions threads rather than long issue comment chains.
- Add a `good first issue` only when you would genuinely accept a stranger's patch for it, and include
  the file paths that need to change — `docs/GOOD_FIRST_ISSUES.md` has the current set.

## Release process (automated)

npm packages live under the `piwebui` org: `@piwebui/shared`, `@piwebui/pi-adapter` and
`@piwebui/pi-web` (the server + CLI; `bin` is `piweb`, deliberately not `pi-web`, which is
already used by an unrelated package on npm). The web client is `private: true` and is not
published — it is built into `@piwebui/pi-web` as `client-dist`.

Every commit to `main` and every version tag publishes — `.github/workflows/release.yml` handles
both, and both run the same gate first (`npm run build` then `npm run package:smoke`: pack → clean
install → boot → authenticated probe), so a commit that does not produce a working artifact never
reaches npm.

| push | version | dist-tag | install |
| --- | --- | --- | --- |
| `main` | `0.1.1-canary.<run>.<sha>` | `next` | `npm i -g @piwebui/pi-web@next` |
| tag `v0.1.1` | `0.1.1` | `latest` | `npm i -g @piwebui/pi-web` |

A stable release is still one command:

```bash
# 1. bump all three manifests to the same version, commit
# 2. tag it and push the tag
git tag v0.1.1 && git push origin v0.1.1
```

Release state worth remembering: the `0.1.0` on npm predates the `pi-web` command name (it ships only
the `piweb` alias) — `docs/research/dsh-web-launch.md`. Cutting `v0.1.1` from bumped manifests is what
puts a plain `npm i -g @piwebui/pi-web` onto a CLI that answers to `pi-web`; until then
`npm i -g @piwebui/pi-web@next` from `main` is the artifact that has it.

Canary versions are stamped inside the job by `scripts/set-canary-version.mts` and never committed,
so main's manifests keep the last released version and a canary can never collide with a future
stable. The script also pins the internal `@piwebui/*` ranges to the canary version, so a canary
server cannot resolve its own dependencies to an older stable release. The workflow refuses to run
either path unless all three manifests carry the same version; the tag must match it too.

Publishes are serialised (`concurrency: npm-publish`) because npm versions are immutable, and the
`latest` tag is only ever moved by a tag push, so main's churn can never become what a normal
`npm install -g` picks up.

One-time bootstrap, per package, because npm cannot configure a trusted publisher for a
package that does not exist yet (npm/cli#8544) — a CI publish of a brand-new package fails
with a misleading `EOTP`. Do it once from a logged-in terminal, **without** `--provenance`
(there is no OIDC context locally, so provenance cannot be signed):

```bash
npm login --auth-type=web        # interactive 2FA; a token cannot satisfy this for new packages
npm run build
npm publish -w ./packages/shared     --access public
npm publish -w ./packages/pi-adapter --access public
npm publish -w ./packages/server     --access public
```

Then, on each package's npm page: **Settings → Trusted Publishing → Add trusted publisher**,
provider GitHub Actions, repo `h8ntome/piwebui`, workflow file `release.yml` (the filename must
match exactly). Every later tag then publishes itself with no stored secret. Skipping trusted
publishing instead: store a granular publish token as the repo secret `NPM_TOKEN` — the workflow
picks it up automatically and drops `--provenance` in that mode, and it can also do the bootstrap
above from CI. Note npm is removing direct publish from 2FA-bypass tokens in January 2027, so
this is a bridge, not a destination.

Internal dependency ranges are caret versions (`^0.1.0`), not the `workspace:*` protocol:
`npm pack` does not rewrite `workspace:*` in this layout, so a published tarball carrying it
is uninstallable (`EUNSUPPORTEDPROTOCOL`). Bump all three manifests together.

`0.1.0` is live on npm (published 2026-11-07 from the `v0.1.0` tag commit `3265ba7`, by hand with a
granular token, so those three tarballs carry **no** provenance attestation — releases from here on
via OIDC will). The tag's own CI run had failed with `EOTP` for exactly the bootstrap reason below.
Expect a `404` from `npm view`/`GET` for up to a minute after a successful publish: the registry's
read replica lags the write, while `PUT` already refuses the same version. Verify with
`npm access get status <pkg>` if you are unsure whether a publish landed.

## Verifying a claim before it reaches the README

`docs/CAPABILITY_MATRIX.md` is generated from `e2e/p0-capability-matrix.ts` and mirrors the README's
runtime claims. If you add a claim to the README, add the matrix row that proves it, or the project
loses the one property that makes it trustworthy: every promise is checked.
