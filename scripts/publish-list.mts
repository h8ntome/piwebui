/**
 * The one list of packages this repository publishes to npm.
 *
 *   node scripts/publish-list.mts            # human-readable
 *   node scripts/publish-list.mts --json     # machine-readable
 *   node scripts/publish-list.mts --gh       # `key=value` lines for $GITHUB_OUTPUT
 *
 * Why this exists as a module instead of a `for p in shared pi-adapter server` written
 * out in each workflow step: adding a package means touching the version-consistency
 * check, the tag check, the registry preflight, the canary stamp, the publish loop and
 * the run summary. A list copied six times is six chances to forget one, and the
 * failure is silent — the forgotten package simply never updates on npm. `@piwebui/pi-web-bridge`
 * (`packages/pi-extension`) is the case in point: it shipped in the tree while the release
 * config still only knew three packages.
 *
 * The list is *derived*, not declared: every entry in the root `workspaces` array whose
 * manifest is not `private: true` is publishable, in the order the workspaces are
 * declared — which is dependency order (shared -> pi-adapter -> pi-extension -> server),
 * the order `npm publish` needs. `packages/client` is `private` because the built client
 * ships *inside* `@piwebui/pi-web` as `client-dist`.
 *
 * `scripts/test/publish-list.test.mts` fails if this drifts from the manifests or from
 * what the release workflow actually loops over.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface PublishablePackage {
  /** Directory under `packages/`, e.g. `pi-extension`. */
  dir: string;
  /** Full npm name, e.g. `@piwebui/pi-web-bridge`. */
  name: string;
  /** Manifest version, as committed (canaries are stamped separately). */
  version: string;
  /** True when the package puts a command on PATH (only the server does). */
  cli: boolean;
  /** `pi` extension entry points, e.g. the bridge's `extensions/pi-web-bridge.js`. */
  piExtensions: string[];
}

interface RawManifest {
  name: string;
  version: string;
  private?: boolean;
  bin?: Record<string, string> | string;
  pi?: { extensions?: unknown };
  publishConfig?: { access?: string };
}

/** Workspace directories, in the order the root manifest declares them. */
export function workspaceDirs(root: string = ROOT): string[] {
  const root_ = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    workspaces?: string[];
  };
  return (root_.workspaces ?? []).map((w) => path.normalize(w).replace(/^packages\//, ""));
}

/**
 * Every non-private workspace package, in publish order.
 * Throws rather than returns a partial list: an unreadable or nameless manifest means a
 * package would be skipped in CI, which is the exact silent failure this prevents.
 */
export function publishablePackages(root: string = ROOT): PublishablePackage[] {
  const out: PublishablePackage[] = [];
  for (const dir of workspaceDirs(root)) {
    const file = path.join(root, "packages", dir, "package.json");
    if (!fs.existsSync(file)) continue; // not a package dir (workspace glob that matched nothing)
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as RawManifest;
    if (json.private === true) continue;
    if (!json.name) throw new Error(`${file}: publishable package has no name`);
    out.push({
      dir,
      name: json.name,
      version: json.version,
      cli: !!json.bin,
      piExtensions: Array.isArray(json.pi?.extensions) ? (json.pi!.extensions as string[]).map(String) : [],
    });
  }
  if (!out.length) throw new Error(`${root}: no publishable packages found — the workspaces list is wrong`);
  return out;
}

/** The dirs to feed a shell loop: `shared pi-adapter pi-extension server`. */
export const dirList = (pkgs = publishablePackages()): string => pkgs.map((p) => p.dir).join(" ");
/** The registry names, in publish order. */
export const nameList = (pkgs = publishablePackages()): string => pkgs.map((p) => p.name).join(" ");

if (import.meta.url === `file://${process.argv[1]}`) {
  const mode = process.argv[2] ?? "";
  const pkgs = publishablePackages();
  const server = pkgs.find((p) => p.cli);
  if (mode === "--json") {
    console.log(JSON.stringify(pkgs, null, 2));
  } else if (mode === "--gh") {
    // Consumed by release.yml: `node scripts/publish-list.mts --gh >> "$GITHUB_OUTPUT"`.
    console.log(`dirs=${dirList(pkgs)}`);
    console.log(`names=${nameList(pkgs)}`);
    console.log(`serverDir=${server?.dir ?? ""}`);
    console.log(`serverName=${server?.name ?? ""}`);
  } else {
    for (const p of pkgs) {
      console.log(`${p.name}\t${p.version}\tpackages/${p.dir}${p.cli ? " (cli)" : ""}${p.piExtensions.length ? " (pi extension)" : ""}`);
    }
  }
}
