/**
 * Verification harness (dev-only, never shipped or imported by the server): serve the real
 * pi-web client against a *simulated* host platform, so the workspace folder picker can be
 * driven end-to-end for Windows and macOS listings from a Linux box.
 *
 * The listings come from the production code's own pure path rules
 * (`packages/server/src/directories.ts`: surfaceFor / ancestryCrumbs / parentOf /
 * fullyQualified / WINDOWS_ROOTS) applied to a small virtual tree, so the client sees the
 * shape a Windows or macOS host really produces: separators, drive roots and "This PC",
 * hidden flags, and the closed `directory_unreadable` / `invalid_request` codes. macOS also
 * gets the folders TCC denies, which is the failure the picker used to report as a bare EPERM.
 * Everything that is not `/api/v1/browse` proxies through to a real server, so sessions,
 * CSRF and the app itself stay real.
 *
 *   npx tsx e2e/lib/picker-platform-stub.mts 4831 win32  http://127.0.0.1:4711
 *   npx tsx e2e/lib/picker-platform-stub.mts 4832 darwin http://127.0.0.1:4711
 *   then point a browser (or agent-browser) at http://127.0.0.1:4831
 */
import http from "node:http";
import { ancestryCrumbs, fullyQualified, parentOf, surfaceFor, WINDOWS_ROOTS } from "../../packages/server/src/directories.ts";

const [, , portArg, flavorArg, upstreamArg] = process.argv;
const PORT = Number(portArg);
const PLATFORM = flavorArg as NodeJS.Platform;
const UPSTREAM = upstreamArg ?? "http://127.0.0.1:4711";
const surface = surfaceFor(PLATFORM);
const home = PLATFORM === "win32" ? "C:\\Users\\hadi" : "/Users/hadi";

/** Virtual tree: level path -> child directory names (dot-prefixed = hidden). */
const LEVELS: Record<string, string[]> = PLATFORM === "win32"
  ? {
    "C:\\": ["Users", "Program Files", "we ird"],
    "C:\\Users": ["hadi", "Public"],
    "C:\\Users\\hadi": [".aws", "Documents", "Pictures", "Projects"],
    "C:\\Users\\hadi\\Documents": ["Secret Project", "notes"],
    "C:\\Users\\hadi\\Projects": ["dsh-web", "pi-web"],
    "D:\\": ["code", "games"],
    "D:\\code": ["side-project"],
    [WINDOWS_ROOTS]: ["C:\\", "D:\\"],
  }
  : {
    "/": ["Applications", "Library", "System", "Users", "private", "tmp"],
    "/Users": ["hadi", "Shared"],
    "/Users/hadi": [".agent", ".config", "agent", "Applications", "Desktop", "Documents", "Downloads", "Library", "Movies", "Music", "OpenBot", "Pi-setup", "Pictures"],
    "/Users/hadi/Documents": ["Work", "Scratch"],
    "/Users/hadi/Documents/Work": ["pi-web"],
    "/Users/hadi/Library": ["Mobile Documents"],
    "/Users/hadi/Library/Mobile Documents": ["com~apple~CloudDocs"],
    "/tmp": [],
  };

/** macOS privacy (TCC) refuses these; the reference host reports it as unreadable. */
const DENIED = PLATFORM === "darwin" ? ["/Users/hadi/Documents", "/Users/hadi/Desktop", "/Users/hadi/Downloads"] : [];

const child = (parent: string, name: string) => surface.join(parent, name);

function levelFor(requested: string | null) {
  const wanted = (requested ?? "").trim();
  if (wanted === WINDOWS_ROOTS && PLATFORM === "win32") {
    const names = LEVELS[WINDOWS_ROOTS] ?? [];
    return {
      status: 200,
      body: { path: WINDOWS_ROOTS, home, parent: null, crumbs: ancestryCrumbs(WINDOWS_ROOTS, PLATFORM), entries: names.map((name) => ({ name, path: name, hidden: false })), truncated: false },
    };
  }
  if (wanted !== "" && !fullyQualified(wanted, PLATFORM)) {
    return { status: 400, body: { error: { code: "invalid_request", message: `path must be a full drive or UNC path (C:\\Users\\you or \\\\server\\share), not ${wanted}` } } };
  }
  const target = wanted === "" ? home : surface.resolve(wanted);
  if (DENIED.some((denied) => target === denied || target.startsWith(denied + "/"))) {
    return {
      status: 400,
      body: { error: { code: "directory_unreadable", message: `cannot open ${target}: access denied - macOS privacy may be blocking this folder (System Settings > Privacy & Security > Files and Folders)`, details: "EPERM" } },
    };
  }
  const names = LEVELS[target];
  if (names === undefined) {
    return { status: 400, body: { error: { code: "directory_unreadable", message: `cannot open ${target}: no such folder`, details: "ENOENT" } } };
  }
  const entries = [...names]
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name, path: target === surface.parse(target).root ? `${target}${name}` : child(target, name), hidden: name.startsWith(".") }));
  return {
    status: 200,
    body: { path: target, home, parent: parentOf(target, PLATFORM), crumbs: ancestryCrumbs(target, PLATFORM), entries, truncated: false },
  };
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = new URL(req.url ?? "/", "http://stub");
  if (url.pathname === "/api/v1/browse") {
    const raw: Buffer[] = [];
    for await (const chunk of req) raw.push(chunk as Buffer);
    if (req.method === "POST") {
      const { path: parent, name } = JSON.parse(Buffer.concat(raw).toString() || "{}") as { path?: string; name?: string };
      const trimmed = (name ?? "").trim();
      if (!parent || trimmed === "" || /[/\\]/.test(trimmed)) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { code: "invalid_request", message: `"${name}" is not a single folder name` } }));
        return;
      }
      const targetParent = surface.resolve(parent);
      const target = child(targetParent, trimmed);
      LEVELS[target] = [];
      LEVELS[targetParent] = [...(LEVELS[targetParent] ?? []), trimmed];
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ path: target }));
      return;
    }
    const out = levelFor(url.searchParams.get("path"));
    res.writeHead(out.status, { "content-type": "application/json" });
    res.end(JSON.stringify(out.body));
    return;
  }
  const body: Buffer[] = [];
  for await (const chunk of req) body.push(chunk as Buffer);
  const upstream = await fetch(UPSTREAM + (req.url ?? "/"), {
    method: req.method,
    headers: {
      cookie: req.headers.cookie ?? "",
      "x-piweb-csrf": req.headers["x-piweb-csrf"] ?? "",
      "content-type": req.headers["content-type"] ?? "application/json",
      origin: UPSTREAM,
      accept: req.headers.accept ?? "*/*",
    },
    ...(body.length ? { body: Buffer.concat(body), duplex: "half" as const } : {}),
  });
  const headers: Record<string, string | string[]> = { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" };
  const cookies = upstream.headers.getSetCookie();
  if (cookies.length) headers["set-cookie"] = cookies;
  res.writeHead(upstream.status, headers);
  res.end(Buffer.from(await upstream.arrayBuffer()));
}

http.createServer((req, res) => { void handle(req, res); }).listen(PORT, "127.0.0.1", () => {
  console.log(`picker stub (${PLATFORM}) on http://127.0.0.1:${PORT} -> ${UPSTREAM}`);
});
