#!/usr/bin/env node
/*
 * pi-web CLI launcher — the single entry point behind `pi-web`, `piweb` and
 * `npx @piwebui/pi-web`.
 *
 * Modelled on how the DeepSeek Harness ships `dsh web` (verified with REA
 * against @deepseek-ai/dsh@0.2.2-rc.1: lib/bin.js -> lib/profile-boot.js ->
 * @deepseek-ai/dsh-web-app): a dependency-free launcher that
 *
 *   - resolves its own install layout from this file's URL, never the caller's
 *     cwd, so the command works from any directory after `npm i -g`;
 *   - version-gates the runtime before touching app code;
 *   - boots the app in-process when compiled output (`dist/main.js`) is present,
 *     and falls back to the TypeScript sources through `tsx` in a source
 *     checkout, so packed artifacts need no separate compile step;
 *   - reports startup failures as one actionable line instead of a raw stack.
 *
 * App flags belong to the app (see src/main.ts); this file parses nothing but
 * its own layout decisions.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG_DIR = path.join(HERE, "..");

/** Print `pi-web: <message>` and exit; `PIWEB_DEBUG=1` rethrows for a stack. */
function die(message, cause, code = 1) {
  if (cause && process.env.PIWEB_DEBUG) {
    process.stderr.write(`pi-web: ${message}\n${cause.stack ?? String(cause)}\n`);
    process.exit(code);
  }
  process.stderr.write(`pi-web: ${message}\n`);
  process.exit(code);
}

/** `engines.node` of the installed package, e.g. ">=22.19.0" -> { major, minor }. */
function minimumNode() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PKG_DIR, "package.json"), "utf8"));
    const match = /(\d+)\.(\d+)/.exec(pkg.engines?.node ?? "");
    if (!match) return null;
    return { major: Number(match[1]), minor: Number(match[2]), spec: pkg.engines.node };
  } catch {
    return null;
  }
}

function checkNode() {
  const min = minimumNode();
  if (!min) return;
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < min.major || (major === min.major && minor < min.minor)) {
    die(
      `Node ${process.versions.node} is too old; pi-web needs ${min.spec}. ` +
      "Install a newer Node (https://nodejs.org) and run pi-web again.",
    );
  }
}

/** Compiled entry, present in every packed/installed artifact. */
const DIST_MAIN = path.join(PKG_DIR, "dist", "main.js");
/** Source entry, present in a repository checkout; needs tsx. */
const SRC_MAIN = path.join(PKG_DIR, "src", "main.ts");

/** tsx loader resolvable from this install (it is a declared dependency). */
function tsxLoader() {
  for (const cand of [
    path.join(PKG_DIR, "node_modules", "tsx", "dist", "loader.mjs"),
    path.join(PKG_DIR, "..", "tsx", "dist", "loader.mjs"),
  ]) {
    if (fs.existsSync(cand)) return pathToFileURL(cand).href;
  }
  return null;
}

/** Source checkout without a build: run the TypeScript entry through tsx. */
function runViaTsx(args) {
  const loader = tsxLoader() ?? "tsx";
  const r = spawnSync(process.execPath, ["--import", loader, SRC_MAIN, ...args], {
    stdio: "inherit",
    env: process.env,
  });
  if (r.error) die(`could not start pi-web from ${SRC_MAIN}: ${r.error.message}`, r.error);
  process.exit(r.status ?? 1);
}

const argv = process.argv.slice(2);
checkNode();

if (fs.existsSync(DIST_MAIN)) {
  // In-process boot: signals, exit codes and stdout stay owned by the server.
  try {
    const mod = await import(pathToFileURL(DIST_MAIN).href);
    await mod.runCli(argv);
  } catch (error) {
    die(`failed to start pi-web from ${DIST_MAIN}: ${error instanceof Error ? error.message : String(error)}`, error);
  }
} else if (fs.existsSync(SRC_MAIN)) {
  runViaTsx(argv);
} else {
  die(
    `this pi-web installation has no runnable entry (looked for ${DIST_MAIN} and ${SRC_MAIN}). ` +
    "Reinstall it (`npm i -g @piwebui/pi-web`) or, in a checkout, run `npm run build` first.",
  );
}
