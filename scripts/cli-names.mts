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
 */
export function docFiles(dir: string = ROOT): string[] {
  const out: string[] = [];
  for (const rel of ["README.md", "MAINTAINERS.md", "CHANGELOG.md", "docs"]) {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) {
      for (const e of fs.readdirSync(abs, { recursive: true })) {
        const p = path.join(abs, String(e));
        if (String(e).endsWith(".md") && fs.statSync(p).isFile()) out.push(p);
      }
    } else if (rel.endsWith(".md")) out.push(abs);
  }
  return out;
}

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
export function documentedCommands(files: string[], root: string = ROOT): DocCommand[] {
  const looksLikeCli = /^(pi[-_]?web|piweb)$/i;
  const found: DocCommand[] = [];
  for (const file of files) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    let inFence = false;
    lines.forEach((raw, i) => {
      if (/^\s*```/.test(raw)) {
        inFence = !inFence;
        return;
      }
      if (!inFence) return;
      // `# comment`, blank lines and continuation lines carry no command.
      if (!raw.trim() || /^\s*(#|\/\/)/.test(raw) || /^\s*[&\\|>]/.test(raw)) return;
      let rest = raw.replace(/^\s*(?:\$\s+)?/, "");
      // strip leading env assignments (FOO=bar cmd ...) and `npx`/`sudo`/`time` wrappers
      rest = rest.replace(/^(?:[A-Z_][A-Z0-9_]*=\S+\s+)+/, "");
      rest = rest.replace(/^(?:npx|sudo|time|env\s+\S+\s+)\s+/, "");
      const first = rest.split(/\s+/)[0] ?? "";
      if (!first) return;
      // Allow a path prefix (./px/bin/pi-web, $d/bin/piweb) and inspect the basename.
      const base = path.basename(first);
      if (looksLikeCli.test(base)) {
        found.push({ token: base, file: path.relative(root, file), line: i + 1 });
      }
    });
  }
  return found;
}
