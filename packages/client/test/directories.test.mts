/**
 * The workspace picker's pure rules, ported from the reference browse client.
 * These are the rules that decide what the panes show, and they are all
 * platform-shaped: the same component has to read a `/Users/hadi/...` listing and a
 * `C:\Users\hadi\...` listing without either one being a special case.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  displayCrumbs,
  draftDirectory,
  failureText,
  friendlyBrowseError,
  levelDirectory,
  readDraft,
  separatorOf,
  visibleEntries,
  type DirEntry,
  type DirListing,
} from "../src/lib/directories.ts";

const listing = (over: Partial<DirListing> = {}): DirListing => ({
  path: "/Users/hadi/Documents",
  home: "/Users/hadi",
  parent: "/Users/hadi",
  crumbs: [
    { name: "/", path: "/", hidden: false },
    { name: "Users", path: "/Users", hidden: false },
    { name: "hadi", path: "/Users/hadi", hidden: false },
    { name: "Documents", path: "/Users/hadi/Documents", hidden: false },
  ],
  entries: [],
  truncated: false,
  ...over,
});

const rows = (...names: string[]): DirEntry[] => names.map((name) => ({ name, path: `/Users/hadi/Documents/${name}`, hidden: name.startsWith(".") }));

test("separatorOf reads the platform off the home path the host stamped", () => {
  assert.equal(separatorOf(listing()), "/");
  assert.equal(separatorOf(listing({ home: "C:\\Users\\hadi", path: "C:\\Users\\hadi" })), "\\");
  // Known limit, stated out loud: a POSIX home whose own name contains a backslash
  // reads as Windows. The heuristic is inferred from the home path because the wire
  // does not carry the separator; a name like that is rarer than the platform.
  assert.equal(separatorOf(listing({ home: "/Users/we\\ird" })), "\\");
});

test("levelDirectory terminates the level so a draft can be compared to it", () => {
  assert.equal(levelDirectory(listing()), "/Users/hadi/Documents/");
  assert.equal(levelDirectory(listing({ path: "/" })), "/");
  assert.equal(levelDirectory(listing({ home: "C:\\", path: "C:\\" })), "C:\\");
});

test("draftDirectory separates on the host's rules, not on whichever slash appeared", () => {
  const posix = listing();
  assert.equal(draftDirectory(posix, "/Users/hadi/Do"), "/Users/hadi/");
  assert.equal(draftDirectory(posix, "no-separator"), null);
  assert.equal(draftDirectory(posix, "/a\\b"), "/");
  const win = listing({ home: "C:\\Users\\hadi", path: "C:\\Users\\hadi" });
  assert.equal(draftDirectory(win, "C:\\Users\\hadi\\Do"), "C:\\Users\\hadi\\");
  assert.equal(draftDirectory(win, "C:/Users/hadi/Do"), "C:/Users/hadi/", "Windows accepts either separator");
});

test("readDraft names the level a draft addresses and the tail that filters it", () => {
  const level = listing();
  assert.deepEqual(readDraft(level, "/Users/hadi/Doc", null), { directory: "/Users/hadi/", tail: null }, "another level is not filtered by this draft");
  assert.deepEqual(readDraft(level, "/Users/hadi/Documents/Do", null), { directory: "/Users/hadi/Documents/", tail: "Do" });
  // A draft the host resolved differently still belongs to the level it landed on.
  const scanned = { directory: "/Users/hadi/Documents/../Documents/", landed: "/Users/hadi/Documents" };
  assert.equal(readDraft(level, "/Users/hadi/Documents/../Documents/No", scanned).tail, "No");
});

test("displayCrumbs folds the home subtree under a Home crumb and leaves everything else spelled out", () => {
  assert.deepEqual(displayCrumbs(listing(), "Home").map((c) => c.name), ["Home", "Documents"]);
  assert.deepEqual(displayCrumbs(listing({ path: "/Users/hadi", crumbs: [
    { name: "/", path: "/", hidden: false },
    { name: "Users", path: "/Users", hidden: false },
    { name: "hadi", path: "/Users/hadi", hidden: false },
  ] }), "Home").map((c) => c.name), ["Home"]);
  assert.deepEqual(displayCrumbs(listing({ path: "/tmp/audit/ws", crumbs: [
    { name: "/", path: "/", hidden: false },
    { name: "tmp", path: "/tmp", hidden: false },
    { name: "audit", path: "/tmp/audit", hidden: false },
    { name: "ws", path: "/tmp/audit/ws", hidden: false },
  ] }), "Home").map((c) => c.name), ["/", "tmp", "audit", "ws"]);
  // Windows: home folds the same way on every platform - the drive ancestry above it
  // is only shown when the level is outside the home subtree.
  assert.deepEqual(displayCrumbs(listing({ home: "C:\\Users\\hadi", path: "C:\\Users\\hadi\\proj", crumbs: [
    { name: "This PC", path: "::This PC", hidden: false },
    { name: "C:\\", path: "C:\\", hidden: false },
    { name: "Users", path: "C:\\Users", hidden: false },
    { name: "hadi", path: "C:\\Users\\hadi", hidden: false },
    { name: "proj", path: "C:\\Users\\hadi\\proj", hidden: false },
  ] }), "Home").map((c) => c.name), ["Home", "proj"]);
  assert.deepEqual(displayCrumbs(listing({ home: "C:\\Users\\hadi", path: "D:\\code", crumbs: [
    { name: "This PC", path: "::This PC", hidden: false },
    { name: "D:\\", path: "D:\\", hidden: false },
    { name: "code", path: "D:\\code", hidden: false },
  ] }), "Home").map((c) => c.name), ["This PC", "D:\\", "code"]);
});

test("visibleEntries hides dot-folders until asked, and a prefix narrows only when something matches", () => {
  const entries = rows("Documents", ".private", "Downloads");
  assert.deepEqual(visibleEntries(entries, null, false, null).map((e) => e.name), ["Documents", "Downloads"]);
  assert.deepEqual(visibleEntries(entries, null, true, null).map((e) => e.name), ["Documents", ".private", "Downloads"]);
  assert.deepEqual(visibleEntries(entries, null, false, "do").map((e) => e.name), ["Documents", "Downloads"]);
  assert.deepEqual(visibleEntries(entries, null, false, "pri").map((e) => e.name), ["Documents", "Downloads"], "a plain prefix does not go digging in the hidden rows");
  assert.deepEqual(visibleEntries(entries, null, false, ".pr").map((e) => e.name), [".private"], "a dot-led prefix reveals the hidden row it names");
  assert.deepEqual(visibleEntries(entries, null, false, "zzz").map((e) => e.name), ["Documents", "Downloads"], "a tail nobody matches leaves the level whole");
  assert.deepEqual(visibleEntries(entries, null, false, ".").map((e) => e.name), [".private"]);
  const selectedPath = "/Users/hadi/Documents/.private";
  assert.deepEqual(visibleEntries(entries, selectedPath, false, "do").map((e) => e.name), ["Documents", ".private", "Downloads"], "the selection is never orphaned by a narrowing filter");
  assert.deepEqual(visibleEntries(entries, null, false, "do").map((e) => e.name), ["Documents", "Downloads"], "with no selection the same filter hides it again");
});

test("a listing failure says something a person can act on", () => {
  assert.equal(failureText(new Error("cannot open /x: no such folder")), "cannot open /x: no such folder");
  assert.equal(failureText(null), "The folder could not be opened.");
  assert.match(friendlyBrowseError(new Error("cannot open /Users/hadi/Documents: access denied - macOS privacy may be blocking this folder (System Settings > Privacy & Security > Files and Folders)")), /Files and Folders/);
  assert.match(friendlyBrowseError(Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" })), /protected by your operating system/);
});
