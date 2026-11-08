/**
 * The single source of truth for the command names `@piwebui/pi-web` puts on `PATH`.
 *
 * Why this exists as its own module: `npm i -g @piwebui/pi-web` followed by
 * `pi-web` produced `command not found` because the artifact sitting on the `latest`
 * dist-tag declared only the `piweb` alias in its `bin` map, while every document
 * told people to type `pi-web`. Nothing compared the two, so the mismatch shipped
 * silently. These checks are what close that gap:
 *
 *   - `scripts/check-cli-names.mts`  — manifest ↔ launcher ↔ docs, run on every build;
 *   - `scripts/verify-published.mts` — what the *registry* actually serves, run after publish.
 *
 * `piweb` is kept as the compatibility alias (it is what `0.1.0` shipped, and it is the
 * escape hatch when the unscoped `pi-web` package already owns that name in a global
 * prefix). Adding a third name here means: add it to `bin` in packages/server/package.json
 * and document it in the README — `check-cli-names.mts` fails if any leg is missing.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SERVER_PKG_DIR = path.join(ROOT, "packages", "server");
export const SERVER_PKG_NAME = "@piwebui/pi-web";
/** The CLI dispatcher: every `cmd === "..."` here is a subcommand users can type. */
export const SERVER_MAIN_REL = "packages/server/src/main.ts";

/** The command the README and every usage example tells users to type. */
export const CLI_PRIMARY = "pi-web";
/** Older/alternate name, kept installed forever so existing muscle memory and scripts survive. */
export const CLI_COMPAT_ALIAS = "piweb";
/** Every name that must appear as a key of `bin` in the server manifest. */
export const CLI_NAMES: readonly string[] = [CLI_PRIMARY, CLI_COMPAT_ALIAS];
/** The one launcher every name points at. */
export const LAUNCHER_REL = "bin/pi-web.mjs";

export interface ServerManifest {
  name: string;
  version: string;
  bin?: Record<string, string>;
  files?: string[];
}

/** Read and lightly validate the publishable server manifest. */
export function readServerManifest(dir: string = SERVER_PKG_DIR): ServerManifest {
  const file = path.join(dir, "package.json");
  const json = JSON.parse(fs.readFileSync(file, "utf8")) as ServerManifest;
  if (json.name !== SERVER_PKG_NAME) {
    throw new Error(`${file}: expected package name ${SERVER_PKG_NAME}, found ${json.name}`);
  }
  return json;
}

/**
 * Markdown files whose fenced code blocks count as user-facing command documentation.
 * `docs/research/` is excluded: it records third-party evidence, not our CLI surface.
 *
 * `packages/<pkg>/README.md` and `packages/<pkg>/CHANGELOG.md` are included because the terminal
 * bridge documents its own knobs there (and the root README points readers at it "for every
 * knob"), so a command written only there is still a command we have promised to users.
 */
export function docFiles(dir: string = ROOT): string[] {
  const out: string[] = [];
  const walk = (abs: string) => {
    if (!fs.existsSync(abs)) return;
    if (fs.statSync(abs).isDirectory()) {
      for (const e of fs.readdirSync(abs, { recursive: true })) {
        const p = path.join(abs, String(e));
        if (String(e).endsWith(".md") && fs.statSync(p).isFile()) out.push(p);
      }
    } else if (abs.endsWith(".md")) out.push(abs);
  };
  for (const rel of ["README.md", "MAINTAINERS.md", "CHANGELOG.md", "docs"]) walk(path.join(dir, rel));
  const pkgDir = path.join(dir, "packages");
  if (fs.existsSync(pkgDir)) {
    for (const p of fs.readdirSync(pkgDir)) {
      walk(path.join(pkgDir, p, "README.md"));
      walk(path.join(pkgDir, p, "CHANGELOG.md"));
    }
  }
  // `docs/research/` records third-party evidence (other people's CLIs, REA dumps). Its fenced
  // blocks quote someone else's command, and a gate that reads them would either reject a correct
  // document or get switched off wholesale — so it does not read them.
  const research = path.join(dir, "docs", "research") + path.sep;
  return [...new Set(out)].filter((f) => !f.startsWith(research)).sort();
}

/**
 * Strip the decorations that sit in front of a command in a docs code block: `$ ` prompts,
 * leading `FOO=bar` assignments, and `npx`/`sudo`/`time`/`env` wrappers.
 */
function stripCommandPrefix(raw: string): string {
  let rest = raw.replace(/^\s*(?:\$\s+)?/, "");
  rest = rest.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, "");
  rest = rest.replace(/^(?:npx|sudo|time|env\s+\S+\s+)\s+/, "");
  return rest;
}

/** The CLI-ish basename of the command on this docs line, or null when the line has none. */
function cliLineCommand(raw: string): { token: string; rest: string } | null {
  const rest = stripCommandPrefix(raw).trim();
  const first = rest.split(/\s+/)[0] ?? "";
  if (!first) return null;
  const base = path.basename(first);
  if (!CLI_TOKEN_RE.test(base)) return null;
  return { token: base, rest: rest.slice(first.length).trim() };
}

const CLI_TOKEN_RE = /^(pi[-_]?web|piweb)$/i;

export interface DocCommand {
  /** The token as written, e.g. `pi-web` or a typo like `pi_web`. */
  token: string;
  file: string;
  line: number;
}

/**
 * Collect every command-like token used in *executable position* inside fenced code
 * blocks: start of line, optionally after `$ ` / `npx ` / a path prefix.
 *
 * Only tokens that look like this project's CLI are returned (`pi-web`, `piweb`, and
 * near-misses such as `pi_web`), so prose mentions, package names like
 * `@piwebui/pi-web`, flags and unrelated commands are ignored.
 */
/** Walk the fenced code blocks of a markdown file, reporting (line, raw text) per command line. */
function eachCommandLine(file: string, fn: (raw: string, line: number) => void): void {
  let inFence = false;
  fs.readFileSync(file, "utf8").split("\n").forEach((raw, i) => {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      return;
    }
    if (!inFence) return;
    // `# comment`, blank lines and continuation lines carry no command.
    if (!raw.trim() || /^\s*(#|\/\/)/.test(raw) || /^\s*[&\\|>]/.test(raw)) return;
    fn(raw, i + 1);
  });
}

/**
 * Collect every command-like token used in *executable position* inside fenced code
 * blocks: start of line, optionally after `$ ` / `npx ` / a path prefix.
 *
 * Only tokens that look like this project's CLI are returned (`pi-web`, `piweb`, and
 * near-misses such as `pi_web`), so prose mentions, package names like
 * `@piwebui/pi-web`, flags and unrelated commands are ignored.
 */
export function documentedCommands(files: string[], root: string = ROOT): DocCommand[] {
  const found: DocCommand[] = [];
  for (const file of files) {
    eachCommandLine(file, (raw, line) => {
      const hit = cliLineCommand(raw);
      // Allow a path prefix (./px/bin/pi-web, $d/bin/piweb) and inspect the basename.
      if (hit) found.push({ token: hit.token, file: path.relative(root, file), line });
    });
  }
  return found;
}

/**
 * The first-argument subcommands the docs tell users to run: `pi-web doctor` -> `doctor`.
 *
 * Why a second pass over the same docs: `bin` names are only half of the CLI contract. The
 * artifact sitting on `latest` also lacks whole *subcommands* (`doctor`, `install-extension`,
 * `pair`, `rotate-bridge-token`, `trust-runtime`), so a reader who follows the README against a
 * plain `npm i -g` gets usage text where a feature should be — the same "docs are ahead of the
 * published artifact" failure as the missing `pi-web` name, one level down.
 */
export function documentedSubcommands(files: string[], root: string = ROOT): DocCommand[] {
  const found: DocCommand[] = [];
  for (const file of files) {
    eachCommandLine(file, (raw, line) => {
      const hit = cliLineCommand(raw);
      if (!hit) return;
      // First non-flag word after the command, with any argument/pipe/redirect trimmed off.
      const rest = hit.rest.replace(/^[|&;>]+\s*/, "");
      const word = (rest.split(/\s+/)[0] ?? "").replace(/[^A-Za-z0-9-].*$/, "");
      if (!word || word.startsWith("-")) return;
      // Only lowercase subcommand-shaped tokens; `<dir>`, `DIR`, `--flag` and `@scope/pkg` are not.
      if (!/^[a-z][a-z-]*$/.test(word)) return;
      found.push({ token: word, file: path.relative(root, file), line });
    });
  }
  return found;
}

/**
 * Every subcommand the CLI actually dispatches, read out of the entry source.
 *
 * Parsed rather than imported: the gate runs before `npm run build` (and must keep running on a
 * tree that does not compile), and `main.ts` dispatches with a plain `cmd === "..."` chain that is
 * unambiguous to read. `help` is handled before the chain, so it is added explicitly.
 */
export function dispatchedSubcommands(root: string = ROOT): string[] {
  const src = fs.readFileSync(path.join(root, SERVER_MAIN_REL), "utf8");
  const names = new Set<string>(["help"]);
  for (const m of src.matchAll(/\bcmd\s*===\s*["']([a-z][a-z-]*)["']/g)) names.add(m[1]!);
  return [...names].sort();
}

/** Commands whose tarball the checks below are about (only the server puts a CLI on PATH). */
export const CLI_PACKAGE_DIR = SERVER_PKG_DIR;
