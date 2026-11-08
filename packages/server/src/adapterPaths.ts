/**
 * Locate executable files inside the `@piwebui/pi-adapter` package.
 *
 * Why this exists: npm puts dependencies in different places depending on how the package was
 * installed, and plain string arithmetic on this module's own directory only ever satisfies one of
 * those shapes.
 *
 *   workspace checkout  packages/server/dist/main.js          -> packages/pi-adapter/dist/...
 *   hoisted install     <p>/node_modules/@piwebui/pi-web/dist -> <p>/node_modules/@piwebui/pi-adapter/dist/...
 *   global (`-g`) install                                     -> <p>/node_modules/@piwebui/pi-web/node_modules/@piwebui/pi-adapter/dist/...
 *
 * A global install *nests* its dependencies inside the depending package, so the sibling guess
 * misses and `node` is handed a nonexistent worker/host script. Ask Node to walk the package graph
 * first (that works for every npm layout) and keep the filesystem guesses as fallbacks for a source
 * checkout, where the adapter may only exist as TypeScript.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Candidate adapter package roots, most trustworthy first. */
let cachedRoots: string[] | null = null;
export function adapterRoots(): string[] {
  if (cachedRoots) return cachedRoots;
  const roots: string[] = [];
  const push = (p: string) => {
    const r = path.resolve(p);
    if (!roots.includes(r)) roots.push(r);
  };
  try {
    // Any subpath export resolves to <adapter>/dist/<file>.js; two dirnames back that up to the
    // package root, and Node's own algorithm handles hoisted, nested and workspace layouts alike.
    const resolved = createRequire(import.meta.url).resolve("@piwebui/pi-adapter/tail");
    push(path.dirname(path.dirname(resolved)));
  } catch {
    /* not installed as a package (or no build yet): the filesystem guesses below take over */
  }
  // Source checkout: packages/server/{src,dist} sits beside packages/pi-adapter.
  push(path.join(HERE, "..", "..", "pi-adapter"));
  cachedRoots = roots;
  return roots;
}

/** Absolute path to the tsx ESM loader, or null when tsx is not installed. */
function tsxLoader(): string | null {
  try {
    return createRequire(import.meta.url).resolve("tsx");
  } catch {
    /* fall through to the filesystem guesses */
  }
  for (const c of [
    path.join(HERE, "..", "..", "..", "tsx", "dist", "loader.mjs"),
    path.join(process.cwd(), "node_modules", "tsx", "dist", "loader.mjs"),
  ]) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

/**
 * Resolve one adapter entrypoint. `distRel` is the built path (preferred, and the only one that
 * exists in an installed package); `srcRel` is the source path used in a checkout with no build.
 * Throws a legible `adapter_not_found` error instead of letting the child fail on a bare ENOENT.
 */
export function resolveAdapterScript(distRel: string, srcRel: string): { script: string; execArgv: string[] } {
  const roots = adapterRoots();
  for (const root of roots) {
    const js = path.join(root, "dist", distRel);
    if (fs.existsSync(js)) return { script: js, execArgv: [] };
  }
  for (const root of roots) {
    const ts = path.join(root, "src", srcRel);
    if (fs.existsSync(ts)) {
      const loader = tsxLoader();
      return { script: ts, execArgv: ["--import", loader ? pathToFileURL(loader).href : "tsx"] };
    }
  }
  throw Object.assign(
    new Error(`cannot find ${distRel} in @piwebui/pi-adapter (looked in ${roots.map((r) => path.join(r, "dist", distRel)).join(", ") || "nothing"})`),
    { code: "adapter_not_found" },
  );
}
