# Repository settings — apply once, in the GitHub UI or with `gh`

Nothing in this file could be applied automatically: at review time the repository had **no git remote**
and `github.com/h8ntome/piweb` returned 404, so the GitHub repository does not exist yet and there
was no authenticated `gh` session. Everything below is therefore prepared, not applied.

The docs assume the repository will be published as `github.com/h8ntome/piweb`. `CONTRIBUTING.md` carries the matching clone URL.

## 1. Create the repository

```bash
# from the working checkout
git remote add origin git@github.com:h8ntome/piweb.git
git push -u origin main
```

Before the first push, confirm the history scrub items in `docs/SECURITY_REVIEW.md` are done:
absolute home paths out of `plan/`, no committed `*.db`, and no personal data in `docs/CHECKS.md`.
Fixing these before the first push avoids ever needing a history rewrite after publication.

Suggested settings: **Description** (one line) `Browser view and control surface for pi coding-agent
sessions — pi stays the only runtime and the only writer of session files.` **Website**: none (local
first; there is no hosted demo). Check **Include for this repository** → merge settings: *Allow squash
merging* only, to match CONTRIBUTING.

## 2. Topics (checklist item 6)

Settings → General → About → ⚙ (or `gh repo edit h8ntome/piweb --add-topic ...`):

```
pi, pi-coding-agent, coding-agent, ai-agent, agent-ui, web-ui, self-hosted, local-first,
privacy-first, developer-tools, devtools, typescript, react, vite, fastify, sse, open-source,
session-viewer, llm, monorepo
```

Rules applied: 20 topics maximum, all descriptive of what the code actually is; no trending terms the
project does not deliver (deliberately absent: `mcp`, `rag`, `gpt`, `automation`, `llm-ui`).

## 3. Social preview (checklist item 7)

Settings → General → Social preview → Image → upload `docs/assets/social-preview.png` (1280×640).
Then hard-refresh the card with `?v=2` in a picker preview. Do not claim the card works until
`https://github.com/h8ntome/piweb` renders the image in a Slack/Discord/Twitter preview.

## 4. GitHub Discussions (checklist item 13)

Settings → General → Features → **Discussions** → *Set up discussions*. Categories:

| Category | Use |
| --- | --- |
| General | Anything not covered below. |
| Q&A | Setup and usage questions; enable "assigned to answer" so they can be resolved. |
| Ideas | Feature exploration before it becomes an issue. |
| Show and tell | What people built with pi-web (forks, themes, integrations). |
| Announcements | Releases only, kept low-volume. |

Also tick *Enable upvotes* and add a `docs/` link in the discussion banner. Keep the issue template
banner pointing at Discussions for questions, which `.github/ISSUE_TEMPLATE/config.yml` already does.

## 5. Triage labels (checklist item 16)

Create the labels that the templates and `MAINTAINERS.md` reference (GitHub ships `bug`, `documentation`,
`duplicate`, `question`, `wontfix`; add the rest):

| Label | Colour | Meaning |
| --- | --- | --- |
| `bug` | `#d73a4a` | Existing behaviour is wrong. |
| `enhancement` | `#a2eeef` | New behaviour requested. |
| `good first issue` | `#7057ff` | Scoped for a first-time contributor, with file pointers. |
| `needs-repro` | `#fef2c0` | Reporter needs to add steps or versions. |
| `needs-triage` | `#ededed` | Not yet reviewed by a maintainer. |
| `pi-integration` | `#0e8a16` | Depends on pi internals or pi version behaviour. |
| `security` | `#e11d48` | Security-related; usually private, use with care. |
| `ui` | `#1d76db` | Client rendering or interaction. |
| `perf` | `#fbca04` | Latency, memory, large-session handling. |
| `help wanted` | `#008672` | Unblocked, no maintainer time; contributors welcome. |

`gh label create "<name>" --color <code> --repo h8ntome/piweb --description "<meaning>"` for each.

## 6. Branch protection and secrets scanning

- Settings → Branches → *Add branch protection rule* for `main`: require a passing `build` job from
  CI, require branches to be up to date, allow force pushes off, do not allow deletions. Keep it on
  `main` only while the project is small; rules on every branch become friction.
- Settings → Code security and analysis → enable **Secret scanning** and **Push protection** (both are
  free for public repositories) and Dependabot alerts + auto-updates for the security only.
- Do not add repository secrets for CI as it stands: the workflows install pi from the public registry
  and never contact a model provider. If a private registry is needed later, scope the secret to the
  environment that needs it rather than the whole repository.
