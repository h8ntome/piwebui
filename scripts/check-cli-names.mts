/**
 * Gate: the command names users are told to type must be the names the package ships.
 *
 *   node scripts/check-cli-names.mts    # local manifest vs. local docs
 *
 * Fails (exit 1) when any of these drift apart:
 *   1. `bin` in packages/server/package.json vs. the required names in scripts/cli-names.mts
 *      (missing `pi-web` is the exact regression that broke `npm i -g @piwebui/pi-web`);
 *   2. `bin` entries vs. files on disk (a name pointing at a path that is not shipped, or is
 *      not covered by the `files` allowlist, installs a dead symlink);
 *   3. every command-like token in the fenced code blocks of README/MAINTAINERS/CHANGELOG/docs
 *      vs. the shipped names (documents `pi_web`, or drops `pi-web` from the docs, and this fails).
 *
 * Runs before the build: it needs only the manifests and the markdown, never `dist/`.
 */
import fs from "node:fs";
import path from "node:path";
import {
  CLI_NAMES,
  CLI_PRIMARY,
  LAUNCHER_REL,
  SERVER_PKG_DIR,
  docFiles,
  documentedCommands,
  readServerManifest,
} from "./cli-names.mts";

const ok = (m: string) => console.log(` ✔ ${m}`);
const problems: string[] = [];
const bad = (m: string) => {
  problems.push(m);
  console.error(` ✘ ${m}`);
};

const pkg = readServerManifest();
const bin = pkg.bin;

// 1. the bin map carries exactly the names we promise, all pointing at one launcher.
if (!bin || typeof bin !== "object" || Array.isArray(bin)) {
  bad("packages/server/package.json has no `bin` object — a global install would put nothing on PATH");
} else {
  const keys = Object.keys(bin);
  for (const name of CLI_NAMES) {
    if (!keys.includes(name)) {
      bad(
        `\`bin\` is missing the command \`${name}\` (ships ${JSON.stringify(bin)}). ` +
          `Users typing \`${name}\` after \`npm i -g ${pkg.name}\` get "command not found".`,
      );
      continue;
    }
    const target = bin[name];
    if (typeof target !== "string" || !target.trim()) {
      bad(`\`bin.${name}\` is not a usable path: ${JSON.stringify(target)}`);
      continue;
    }
    if (!target.startsWith("./") && !target.startsWith("/")) {
      console.error(`   note: \`bin.${name}\` = "${target}" is fine (npm tolerates a bare relative path)`);
    }
    if (path.normalize(target) !== LAUNCHER_REL && path.normalize(target) !== `./${LAUNCHER_REL}`) {
      bad(`\`bin.${name}\` points at ${target}, expected ${LAUNCHER_REL} — every name must launch the same entry`);
    }
  }
  for (const name of keys) {
    if (!CLI_NAMES.includes(name)) {
      bad(`\`bin.${name}\` ships a command nobody declared; add it to scripts/cli-names.mts and document it, or drop it`);
    }
  }

  // 2. each declared target exists and would actually be included in the tarball.
  const filesAllowlist = Array.isArray(pkg.files) ? pkg.files : null;
  for (const [name, target] of Object.entries(bin)) {
    if (typeof target !== "string") continue;
    const abs = path.join(SERVER_PKG_DIR, target);
    if (!fs.existsSync(abs)) {
      bad(`\`bin.${name}\` -> ${target}: no such file in packages/server`);
      continue;
    }
    if (!fs.statSync(abs).isFile()) bad(`\`bin.${name}\` -> ${target}: not a regular file`);
    const head = fs.readFileSync(abs, "utf8").split("\n", 1)[0] ?? "";
    if (!/^#!.*\b(node|env node)\b/.test(head)) {
      bad(`${target} has no node shebang (found "${head}"); the installed symlink would not execute`);
    }
    if (!(fs.statSync(abs).mode & 0o111)) {
      console.error(`   note: ${target} is not executable in git; npm sets the bit on install, keep it anyway`);
    }
    if (filesAllowlist) {
      const rel = path.normalize(target);
      const covered = filesAllowlist.some((entry) => {
        const e = entry.replace(/\/+$/, "");
        return rel === e || rel.startsWith(`${e}/`) || rel === `./${e}` || rel.startsWith(`./${e}/`);
      });
      if (!covered) {
        bad(`${target} is not covered by the \`files\` allowlist ${JSON.stringify(filesAllowlist)} — \`npm pack\` would ship the manifest without its launcher`);
      }
    }
  }
}

// 3. docs vs. shipped names.
const shipped = Object.keys(bin ?? {});
if (!shipped.includes(CLI_PRIMARY)) {
  bad(`the primary documented command \`${CLI_PRIMARY}\` is not shipped — docs and artifact disagree`);
}
const docs = documentedCommands(docFiles());
const unique = new Map<string, string[]>();
for (const d of docs) unique.set(d.token, [...(unique.get(d.token) ?? []), `${d.file}:${d.line}`]);
for (const [token, where] of [...unique.entries()].sort()) {
  if (!shipped.includes(token)) {
    const first = where.slice(0, 3).join(", ");
    bad(
      `docs run \`${token}\` (${first}${where.length > 3 ? ` +${where.length - 3} more` : ""}) ` +
        `but the package ships only ${JSON.stringify(shipped)} — fix the docs or ship the name`,
    );
  }
}
if (docs.length === 0) {
  bad("no command-like token found in any fenced code block: the docs no longer show how to launch pi-web");
} else {
  ok(`docs use ${[...unique.keys()].sort().map((t) => `\`${t}\``).join(", ")} — all shipped by \`bin\``);
}
if (shipped.length) ok(`bin ships ${shipped.map((n) => `\`${n}\``).join(", ")} (launcher ${LAUNCHER_REL})`);
ok(`manifest ${pkg.name}@${pkg.version}`);

if (problems.length) {
  console.error(`\ncli-name check FAILED: ${problems.length} problem(s).`);
  console.error("The command users type and the command npm installs must be the same name;");
  console.error("scripts/cli-names.mts is the list to update if that is a deliberate change.");
  process.exit(1);
}
console.log("cli-name check passed");
