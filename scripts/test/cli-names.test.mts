/**
 * The command-name contract is a *checked* contract, and these tests are why it stays checked.
 *
 * Two real incidents sit behind this file, both of the same shape — "the docs promise something
 * the installed artifact does not have":
 *
 *   1. `npm i -g @piwebui/pi-web` printed a green install and then `zsh: command not found:
 *      pi-web`, because the artifact on `latest` declared only the `piweb` alias in `bin`.
 *   2. The same registry state, one level down: `latest` predates the terminal bridge entirely,
 *      so every `pi-web doctor` / `pi-web install-extension` in the README lands on usage text.
 *
 * `check-cli-names.mts` (tree side) and `verify-published.mts` (registry side) are the gates;
 * this file keeps their input parsers honest, because a gate whose parser silently matches
 * nothing is worse than no gate: it reports success on the exact drift it exists to catch.
 *
 *   npx tsx --test scripts/test/cli-names.test.mts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  CLI_NAMES,
  LAUNCHER_REL,
  ROOT,
  docFiles,
  dispatchedSubcommands,
  documentedCommands,
  documentedSubcommands,
  readServerManifest,
} from "../cli-names.mts";

/** A throwaway repo layout, so the parsers can be tested against text we control. */
function fixture(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-names-test-"));
  for (const [rel, body] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
  }
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("the manifest this repository ships declares both documented commands", () => {
  const pkg = readServerManifest();
  assert.equal(pkg.name, "@piwebui/pi-web");
  for (const name of CLI_NAMES) {
    assert.ok(pkg.bin && name in pkg.bin, `bin must declare \`${name}\` or \`${name}\` is not found after npm i -g`);
    assert.equal(path.normalize(String(pkg.bin![name])), LAUNCHER_REL);
  }
  // A launcher the pack step would drop is the same bug in a different costume.
  for (const entry of Object.values(pkg.bin ?? {})) {
    const rel = String(entry).replace(/^\.\//, "");
    const covered = (pkg.files ?? []).some((f) => rel === f.replace(/\/+$/, "") || rel.startsWith(`${f.replace(/\/+$/, "")}/`));
    assert.ok(covered, `${rel} must be inside the files allowlist or npm pack ships no launcher`);
  }
});

test("every command-like token in a docs code block is found, typos included", (t) => {
  const dir = fixture(t, {
    "README.md": [
      "```bash",
      "npm install -g @piwebui/pi-web",
      "pi-web",
      "$ piweb serve",
      "PIWEB_DATA_DIR=/tmp/x pi-web --port 5000",
      "```",
      "```bash",
      "pi_web doctor   # a typo, but exactly what a shell tab can produce",
      "```",
      "Prose mention of pi-web outside a fence must not count.",
    ].join("\n"),
  });
  const tokens = [...new Set(documentedCommands(docFiles(dir), dir).map((d) => d.token))].sort();
  assert.deepEqual(tokens, ["pi-web", "pi_web", "piweb"]);
  assert.ok(tokens.includes("pi_web"), "a near-miss name in a code block must be reported so the gate can reject it");
});

test("subcommands are read out of executable position, and arguments are not", (t) => {
  const dir = fixture(t, {
    "README.md": [
      "```bash",
      "pi-web doctor --json",
      "pi-web allow /absolute/path/to/your/project",
      "$ piweb install-extension",
      "pi-web <subcommand>        # placeholder",
      "pi-web --version           # a flag, not a subcommand",
      "pi-web serve | tee log     # pipe, not a subcommand",
      "```",
    ].join("\n"),
  });
  const subs = [...new Set(documentedSubcommands(docFiles(dir), dir).map((d) => d.token))].sort();
  assert.deepEqual(subs, ["allow", "doctor", "install-extension", "serve"]);
});

test("the shipped CLI dispatches every subcommand the repository documents", () => {
  const dispatched = new Set(dispatchedSubcommands());
  // The commands the README and MAINTAINERS tell people to run for the terminal bridge.
  for (const sub of ["serve", "allow", "workspaces", "mint-token", "doctor", "install-extension", "rotate-bridge-token", "pair"]) {
    assert.ok(dispatched.has(sub), `docs reference \`pi-web ${sub}\`; the CLI must dispatch it`);
  }
});

test("the real docs pass the real gate (no documented command the package does not ship)", () => {
  const files = docFiles();
  assert.ok(files.some((f) => f.endsWith(path.join("README.md"))), "the root README counts as documentation");
  assert.ok(
    files.some((f) => f.includes(`${path.sep}packages${path.sep}`)),
    "packages/<pkg>/README.md counts too: the bridge documents its own knobs there",
  );
  const shipped = Object.keys(readServerManifest().bin ?? {});
  for (const d of documentedCommands(files)) {
    assert.ok(shipped.includes(d.token), `${d.file}:${d.line} runs \`${d.token}\`, which bin does not ship`);
  }
  const dispatched = dispatchedSubcommands();
  for (const d of documentedSubcommands(files)) {
    assert.ok(dispatched.includes(d.token), `${d.file}:${d.line} runs \`pi-web ${d.token}\`, which the CLI does not dispatch`);
  }
});

test("docs the gate never looks at are docs that can rot silently", () => {
  const files = docFiles().map((f) => path.relative(ROOT, f));
  for (const must of ["README.md", "MAINTAINERS.md", "CHANGELOG.md"]) {
    assert.ok(files.includes(must), `${must} must be scanned`);
  }
  assert.ok(files.some((f) => f.startsWith(`docs${path.sep}`)), "docs/ must be scanned recursively");
  // research/ records third-party evidence (other people's CLIs); scanning it produces noise.
  assert.ok(!files.some((f) => f.startsWith(`docs${path.sep}research`)), "docs/research is deliberately excluded");
});
