# Prior art and positioning

The plan is an independent personal tool. Prior art can suggest UI/protocol ideas; it
cannot establish this project's safety, installed-Pi compatibility or requirements.
No code copying or upstream contribution is authorized merely by comparing projects.

## Checked reference

[agegr/pi-web README](https://github.com/agegr/pi-web/blob/main/README.md) documents the
existing `@agegr/pi-web` package, so the working name is not unique. Keep `pi-web` locally;
check ownership and choose a package scope before any future publication. Star counts,
private route names and changing dependency inventories from the original plan are
removed as unnecessary, unstable evidence. Reinspect source and license before reuse.

Other projects named in v0.1 (`ravshansbox/pi-web`, `ygncode/pi-web`, pi-web.dev) are
research leads, not verified feature/compatibility claims in this reviewed plan.

## Design references

Use a restrained central transcript, project-grouped session rail, rich but compact
composer and explicit source/run/connection state. Pi's own TUI/theme/export assets are
the main visual source. References to DeepSeek/Codex/Claude interface patterns describe
our chosen design direction; they do not require duplicating those products or assert
current feature inventories. Keep no terminal pane/editor/provider secret management.

## Distinct requirements

Same **live terminal runtime** controlled through a bridge; persisted-only mirror clearly
distinguished from live streaming; browser-created managed sessions resume in CLI only
after stop; four sessions survive browser absence; NetBird phone path. These need direct
proof against installed Pi rather than inference from another project's lease/SSE routes.

There are no "zero divergence by construction" or "zero filesystem mutation endpoints"
claims: local operation metadata, Pi-managed creation/rename and explicit lifecycle
operations do mutate state. The useful boundary is no independent agent/tool execution
and no direct conversation-file edits from the API/read path.

## NetBird deployment reference

[NetBird reverse proxy docs](https://docs.netbird.io/manage/reverse-proxy) describe public
internet exposure of internal services. That is **not** automatic authorization to expose
pi-web publicly. For this private phone workflow inspect the existing mesh and arrange
trusted HTTPS restricted to intended peers; a feature named "reverse proxy" is not proof
that it satisfies this requirement. No Tailscale-specific assumptions are carried over.
