/**
 * The workspace folder picker's server side, per platform. The point of the
 * `platform` / `home` / `driveProbe` injection points is that the Windows and
 * macOS rules are checked from any host: half of these rules are about separators
 * and roots, and a Linux box can verify them just as well as the OS they describe.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ancestryCrumbs,
  boundedInsert,
  createDirectory,
  fullyQualified,
  listDirectory,
  parentOf,
  unreadableError,
  windowsRootsListing,
  WINDOWS_ROOTS,
  WINDOWS_ROOTS_LABEL,
} from "../src/directories.ts";

/** A temp tree, built once per call; `mode 0` on purpose so the unreadable rows really fail. */
function fixture(): { root: string; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pw-dirs-"));
  const root = path.join(base, "level");
  fs.mkdirSync(path.join(root, "bravo"), { recursive: true });
  fs.mkdirSync(path.join(root, "Alpha"), { recursive: true });
  fs.mkdirSync(path.join(root, "Alpha", "inner"), { recursive: true });
  fs.mkdirSync(path.join(root, ".hidden"), { recursive: true });
  fs.writeFileSync(path.join(root, "a-file.txt"), "not a folder");
  fs.mkdirSync(path.join(base, "target", "deep"), { recursive: true });
  fs.symlinkSync(path.join(base, "target"), path.join(root, "link-to-target"), "dir");
  fs.mkdirSync(path.join(base, "locked"), { recursive: true });
  fs.chmodSync(path.join(base, "locked"), 0o000);
  return {
    root,
    cleanup: () => { fs.chmodSync(path.join(base, "locked"), 0o755); fs.rmSync(base, { recursive: true, force: true }); },
  };
}

/* ------------------------------ platform rules ------------------------------ */

test("fullyQualified accepts only paths that name one fixed location", () => {
  assert.equal(fullyQualified("/home/dev", "linux"), true);
  assert.equal(fullyQualified("/Users/hadi", "darwin"), true);
  assert.equal(fullyQualified("relative", "linux"), false);
  assert.equal(fullyQualified("~/x", "darwin"), false);
  assert.equal(fullyQualified("", "linux"), false);
  // Windows: drive-qualified or complete UNC only.
  assert.equal(fullyQualified("C:\\Users\\hadi", "win32"), true);
  assert.equal(fullyQualified("C:\\", "win32"), true);
  assert.equal(fullyQualified("D:/code/x", "win32"), true);
  assert.equal(fullyQualified("\\\\server\\share\\x", "win32"), true);
  assert.equal(fullyQualified("C:x", "win32"), false, "drive-relative is not absolute");
  assert.equal(fullyQualified("/foo", "win32"), false, "rooted on the current drive is not fully qualified");
  assert.equal(fullyQualified("\\\\server", "win32"), false, "an unfinished UNC prefix names no share");
});

test("parentOf walks to the top of the filesystem on every platform", () => {
  assert.equal(parentOf("/home/dev/piwebui", "linux"), "/home/dev");
  assert.equal(parentOf("/home", "linux"), "/");
  assert.equal(parentOf("/", "darwin"), null, "the POSIX root has no parent");
  assert.equal(parentOf("C:\\Users\\hadi", "win32"), "C:\\Users");
  assert.equal(parentOf("C:\\", "win32"), WINDOWS_ROOTS, "above a drive root sits This PC");
  assert.equal(parentOf(WINDOWS_ROOTS, "win32"), null);
  assert.equal(parentOf("\\\\server\\share", "win32"), null, "a UNC share root is a dead end, not This PC");
});

test("ancestryCrumbs runs root to target and labels each top with its own path", () => {
  assert.deepEqual(ancestryCrumbs("/Users/hadi/Documents", "darwin").map((c) => [c.name, c.path]), [
    ["/", "/"], ["Users", "/Users"], ["hadi", "/Users/hadi"], ["Documents", "/Users/hadi/Documents"],
  ]);
  assert.deepEqual(ancestryCrumbs("/", "linux").map((c) => c.path), ["/"]);
  assert.deepEqual(ancestryCrumbs("C:\\Users\\hadi", "win32").map((c) => [c.name, c.path]), [
    [WINDOWS_ROOTS_LABEL, WINDOWS_ROOTS], ["C:\\", "C:\\"], ["Users", "C:\\Users"], ["hadi", "C:\\Users\\hadi"],
  ]);
  assert.deepEqual(ancestryCrumbs(WINDOWS_ROOTS, "win32").map((c) => c.path), [WINDOWS_ROOTS]);
});

test("boundedInsert keeps the name-smallest window and says when it evicted", () => {
  const win: { name: string }[] = [];
  assert.equal(boundedInsert(win, { name: "b" }, 2), false);
  assert.equal(boundedInsert(win, { name: "a" }, 2), false);
  assert.equal(boundedInsert(win, { name: "c" }, 2), true);
  assert.deepEqual(win.map((e) => e.name), ["a", "b"]);
  assert.equal(boundedInsert(win, { name: "d" }, 2), true, "past the window, larger names are refused cheaply");
});

/* ------------------------------- real listings ------------------------------ */

test("listDirectory lists folders only, name-sorted, with host paths and hidden flags", async () => {
  const f = fixture();
  try {
    const out = await listDirectory(f.root, { home: "/home/dev" });
    assert.equal(out.path, fs.realpathSync(f.root));
    assert.deepEqual(out.entries.map((e) => e.name), [".hidden", "Alpha", "bravo", "link-to-target"], "files are not listed; the symlinked folder is");
    assert.deepEqual(out.entries.map((e) => e.hidden), [true, false, false, false]);
    for (const entry of out.entries) assert.ok(path.isAbsolute(entry.path));
    assert.equal(out.home, "/home/dev");
    assert.equal(out.parent, path.dirname(fs.realpathSync(f.root)));
    assert.equal(out.truncated, false);
  } finally { f.cleanup(); }
});

test("a symlinked folder keeps the path the user clicked, instead of its target", async () => {
  const f = fixture();
  try {
    const link = path.join(fs.realpathSync(f.root), "link-to-target");
    const out = await listDirectory(link, { home: "/home/dev" });
    assert.equal(out.path, link, "no realpath: the dialog never jumps to the link target");
    assert.deepEqual(out.entries.map((e) => e.name), ["deep"]);
    assert.equal(out.parent, fs.realpathSync(f.root));
  } finally { f.cleanup(); }
});

test("the listing above a nested level reaches the top, and blank asks for home", async () => {
  const f = fixture();
  try {
    const deep = await listDirectory(path.join(fs.realpathSync(f.root), "Alpha", "inner"), { home: "/home/dev" });
    assert.deepEqual(deep.entries, []);
    assert.equal(deep.crumbs.at(-1)!.path, path.join(fs.realpathSync(f.root), "Alpha", "inner"));
    const home = await listDirectory("", { home: fs.realpathSync(f.root) });
    assert.equal(home.path, fs.realpathSync(f.root));
    assert.equal(home.crumbs.some((c) => c.path === home.home), true, "the ancestry carries home, so the dialog can label it Home");
  } finally { f.cleanup(); }
});

const ROOT = typeof process.getuid === "function" && process.getuid() === 0;

test("listing failures are one closed code, not a raw node error", { skip: ROOT ? "root reads anything" : false }, async () => {
  const f = fixture();
  try {
    const real = fs.realpathSync(f.root);
    await assert.rejects(listDirectory(path.join(real, "nope"), { home: "/home/dev" }), (e: unknown) => (e as { code: string }).code === "directory_unreadable");
    await assert.rejects(listDirectory(path.join(real, "a-file.txt"), { home: "/home/dev" }), (e: unknown) => (e as { code: string }).code === "directory_unreadable");
    await assert.rejects(listDirectory(path.join(path.dirname(real), "locked"), { home: "/home/dev" }), (e: unknown) => (e as { code: string }).code === "directory_unreadable");
    await assert.rejects(listDirectory("relative/x", { home: "/home/dev" }), (e: unknown) => (e as { code: string }).code === "invalid_request");
  } finally { f.cleanup(); }
});

test("a macOS privacy denial is named as one", () => {
  const err = Object.assign(new Error("EPERM: operation not permitted, scandir '/Users/hadi/Documents'"), { code: "EPERM" });
  assert.match(unreadableError("/Users/hadi/Documents", err, "darwin").message, /Files and Folders/);
  assert.equal(unreadableError("/x", err, "linux").message, "cannot open /x: access denied");
  assert.equal(unreadableError("/x", Object.assign(new Error("nope"), { code: "ENOENT" }), "linux").message, "cannot open /x: no such folder");
});

test("a listing bound truncates the name-sorted tail instead of the middle", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pw-dirs-cap-"));
  try {
    for (const name of ["n1", "n2", "n3", "n4", "n5"]) fs.mkdirSync(path.join(base, name));
    const out = await listDirectory(base, { home: base, maxEntries: 3 });
    assert.deepEqual(out.entries.map((e) => e.name), ["n1", "n2", "n3"]);
    assert.equal(out.truncated, true);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test("directory rows survive a broken symlink by dropping it", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pw-dirs-link-"));
  try {
    fs.symlinkSync(path.join(base, "does-not-exist"), path.join(base, "broken"), "dir");
    fs.mkdirSync(path.join(base, "real"));
    const out = await listDirectory(base, { home: base });
    assert.deepEqual(out.entries.map((e) => e.name), ["real"], "a link that cannot be entered is not offered");
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

/* --------------------------------- creating -------------------------------- */

test("createDirectory makes one child and hands back its full path", async () => {
  const f = fixture();
  try {
    const real = fs.realpathSync(f.root);
    const created = await createDirectory(real, "New Project");
    assert.equal(created, path.join(real, "New Project"));
    assert.equal(fs.statSync(created).isDirectory(), true);
  } finally { f.cleanup(); }
});

test("createDirectory refuses names that are not one segment", { skip: ROOT ? "root writes anywhere" : false }, async () => {
  const f = fixture();
  try {
    for (const name of ["", "  ", ".", "..", "a/b", "a\\b"]) {
      await assert.rejects(createDirectory(fs.realpathSync(f.root), name), (e: unknown) => (e as { code: string }).code === "invalid_request", `"${name}"`);
    }
    await assert.rejects(createDirectory(fs.realpathSync(f.root), "Alpha"), (e: unknown) => (e as { code: string }).code === "directory_exists");
    await assert.rejects(createDirectory(path.join(fs.realpathSync(f.root), "Alpha", "gone"), "x"), (e: unknown) => (e as { code: string }).code === "directory_create_failed");
    await assert.rejects(createDirectory("relative", "x"), (e: unknown) => (e as { code: string }).code === "invalid_request");
  } finally { f.cleanup(); }
});

test("createDirectory checks the platform's own shape before touching the disk", { skip: ROOT ? "root writes anywhere" : false }, async () => {
  await assert.rejects(createDirectory("/foo", "x", { platform: "linux" }), (e: unknown) => (e as { code: string }).code === "directory_create_failed");
  await assert.rejects(createDirectory("C:x", "x", { platform: "win32" }), (e: unknown) => (e as { code: string }).code === "invalid_request");
  await assert.rejects(createDirectory(WINDOWS_ROOTS, "x", { platform: "win32" }), (e: unknown) => (e as { code: string }).code === "invalid_request");
  // A foreign platform's shape is refused outright instead of being written literally.
  await assert.rejects(createDirectory("C:\\Users", "x", { platform: "win32" }), (e: unknown) => (e as { code: string }).code === "invalid_request" && /win32 path on a/.test((e as Error).message));
  await assert.rejects(listDirectory("C:\\Users", { platform: "win32" }), (e: unknown) => (e as { code: string }).code === "invalid_request" && /win32 path on a/.test((e as Error).message));
});

/* ------------------------------- This PC level ------------------------------ */

test("This PC lists the drives that answer, and nothing else", async () => {
  const seen = new Set(["C:\\", "D:\\"]);
  const out = await windowsRootsListing("C:\\Users\\hadi", async (candidate) => {
    if (candidate === "E:\\") throw new Error("device not ready");
    return seen.has(candidate);
  }, ["A", "C", "D", "E"]);
  assert.deepEqual(out.entries.map((e) => [e.name, e.path]), [["C:\\", "C:\\"], ["D:\\", "D:\\"]]);
  assert.equal(out.path, WINDOWS_ROOTS);
  assert.equal(out.parent, null);
  assert.equal(out.home, "C:\\Users\\hadi");
  assert.deepEqual(out.crumbs.map((c) => c.path), [WINDOWS_ROOTS]);
});

test("listDirectory reaches This PC only on Windows", async () => {
  const out = await listDirectory(WINDOWS_ROOTS, { platform: "win32", driveProbe: async (c) => c === "C:\\" });
  assert.deepEqual(out.entries.map((e) => e.path), ["C:\\"]);
  await assert.rejects(listDirectory(WINDOWS_ROOTS, { platform: "darwin" }), (e: unknown) => (e as { code: string }).code === "invalid_request");
});
