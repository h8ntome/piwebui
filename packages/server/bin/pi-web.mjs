#!/usr/bin/env node
/* pi-web CLI entry: runs the TypeScript sources through tsx (declared dependency),
 * so packed artifacts need no separate compile step. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const distMain = fileURLToPath(new URL("../dist/main.js", import.meta.url));
let args;
if (fs.existsSync(distMain)) {
  args = [distMain];
} else {
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const loader = new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url);
  args = fs.existsSync(fileURLToPath(loader)) ? ["--import", loader.href, main] : ["--import", "tsx", main];
}
const r = spawnSync(process.execPath, [...args, ...process.argv.slice(2)], { stdio: "inherit", env: process.env });
process.exit(r.status ?? 1);
