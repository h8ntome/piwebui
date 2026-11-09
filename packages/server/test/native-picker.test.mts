/**
 * The workspace picker's routing and its OS choosers. Two things are under test here, and
 * both are the parts that were wrong on a Mac: which device gets the host's own chooser
 * (`resolvePickerMode`), and what happens when a chooser is asked to open, including the
 * two answers that matter most - "the operator cancelled" and "there is no chooser here".
 *
 * Nothing spawns a real process: every chooser call goes through the injected runner.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NativePickerService,
  type ChooserRunner,
  isLoopbackAddress,
  normalizeDevicePlatform,
  pickNativeDirectory,
  resolvePickerMode,
  findLinuxChooser,
  type ChooserRun,
  type PickerFacts,
} from "../src/nativePicker.ts";
import { ApiError } from "../src/commands.ts";
import { isExistingDirectory } from "../src/directories.ts";
import os from "node:os";

const base: PickerFacts = {
  hostPlatform: "darwin",
  clientPlatform: "darwin",
  localPeer: true,
  ssh: false,
  display: false,
  linuxChooser: null,
  policy: "on",
};

test("a Mac browser on a Mac host sitting at the display gets Finder", () => {
  const mode = resolvePickerMode(base);
  assert.equal(mode.mode, "native");
  assert.equal(mode.chooser, "Finder");
});

test("a Windows browser on a Windows host gets the Explorer folder dialog", () => {
  const mode = resolvePickerMode({ ...base, hostPlatform: "win32", clientPlatform: "win32" });
  assert.equal(mode.mode, "native");
  assert.equal(mode.chooser, "Windows Explorer");
});

test("a Mac browser on a Linux host gets the in-app browser, and is told why", () => {
  const mode = resolvePickerMode({ ...base, hostPlatform: "linux", clientPlatform: "darwin", display: true, linuxChooser: "zenity" });
  assert.equal(mode.mode, "browse");
  assert.match(mode.reason, /browser is on macOS but pi-web is on Linux/);
});

test("a remote browser never gets a chooser on the host's display", () => {
  const mode = resolvePickerMode({ ...base, localPeer: false });
  assert.equal(mode.mode, "browse");
  assert.match(mode.reason, /wrong machine/);
});

test("an SSH-launched server keeps its chooser to itself", () => {
  const mode = resolvePickerMode({ ...base, ssh: true });
  assert.equal(mode.mode, "browse");
  assert.match(mode.reason, /SSH/);
  // The operator who knows their tunnel ends at the same machine can override both gates.
  assert.equal(resolvePickerMode({ ...base, ssh: true, localPeer: false, policy: "force" }).mode, "native");
});

test("a headless Linux host with no chooser installed falls back; a desktop one does not", () => {
  assert.equal(resolvePickerMode({ ...base, hostPlatform: "linux", clientPlatform: "linux" }).mode, "browse");
  assert.match(resolvePickerMode({ ...base, hostPlatform: "linux", clientPlatform: "linux", display: true }).reason, /zenity or kdialog/);
  assert.equal(
    resolvePickerMode({ ...base, hostPlatform: "linux", clientPlatform: "linux", display: true, linuxChooser: "kdialog" }).chooser,
    "KDialog",
  );
});

test("an unidentifiable browser or host is never handed a native chooser", () => {
  assert.equal(resolvePickerMode({ ...base, clientPlatform: "other" }).mode, "browse");
  assert.equal(resolvePickerMode({ ...base, hostPlatform: "freebsd", clientPlatform: "freebsd" as PickerFacts["hostPlatform"] }).mode, "browse");
  assert.equal(resolvePickerMode({ ...base, policy: "off" }).mode, "browse");
});

test("loopback is every spelling a socket peer arrives with", () => {
  for (const address of ["127.0.0.1", "127.0.1.5", "::1", "[::1]", "::ffff:127.0.0.1", "localhost"]) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ["", undefined, "10.0.0.7", "192.168.1.20", "::ffff:10.0.0.7", "2001:db8::1"]) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }
});

test("platform claims normalize to the four the picker knows", () => {
  assert.equal(normalizeDevicePlatform("MacIntel"), "darwin");
  assert.equal(normalizeDevicePlatform("macos"), "darwin");
  assert.equal(normalizeDevicePlatform("Win32"), "win32");
  assert.equal(normalizeDevicePlatform("Linux x86_64"), "linux");
  assert.equal(normalizeDevicePlatform("iPhone"), "other");
  assert.equal(normalizeDevicePlatform(undefined), "other");
});

test("findLinuxChooser walks PATH for zenity first and reports nothing when neither is there", () => {
  const seen: string[] = [];
  const chooser = findLinuxChooser(`/a:/b`, (candidate) => { seen.push(candidate); return candidate.endsWith("kdialog"); });
  assert.equal(chooser, "kdialog");
  assert.ok(seen.some((c) => c.endsWith("zenity")), "zenity is probed before kdialog");
  assert.equal(findLinuxChooser("/a", () => false), null);
  assert.equal(findLinuxChooser(undefined), null);
});

/* ------------------------------- the choosers ------------------------------- */

/** A runner that records what was asked and answers with a canned chooser result. */
function fakeRun(answer: Partial<ChooserRun> | Error): { calls: { command: string; args: string[]; env: Record<string, string>; cwd?: string }[]; run: ChooserRunner } {
  const calls: { command: string; args: string[]; env: Record<string, string>; cwd?: string }[] = [];
  return {
    calls,
    run: async (command, args, launch = {}) => {
      calls.push({ command, args, env: launch.env ?? {}, cwd: launch.cwd });
      if (answer instanceof Error) throw answer;
      return { stdout: "", code: 0, stderr: "", ...answer };
    },
  };
}

test("macOS drives Finder's Open panel, with the title as data and never as code", async () => {
  const runner = fakeRun({ stdout: "/Users/hadi/code/api\n" });
  const picked = await pickNativeDirectory({ platform: "darwin", startingPath: "/Users/hadi/code", run: runner.run });
  assert.equal(picked, "/Users/hadi/code/api");
  assert.equal(runner.calls.length, 1);
  const call = runner.calls[0];
  assert.equal(call.command, "osascript");
  assert.deepEqual(call.args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  // The prompt and the starting folder arrive after the script: argv, not source.
  assert.deepEqual(call.args.slice(-2), ["Select Workspace Directory", "/Users/hadi/code"]);
  assert.match(call.args[3], /NSOpenPanel/);
  assert.match(call.args[3], /canChooseDirectories = true/);
  assert.match(call.args[3], /canChooseFiles = false/);
  assert.match(call.args[3], /setDirectoryURL/);
});

test("a Finder cancel is a cancel, not a failure", async () => {
  const runner = fakeRun({ stdout: "\n", code: 0 });
  assert.equal(await pickNativeDirectory({ platform: "darwin", run: runner.run }), null);
});

test("a Finder that could not open says so, with the reason", async () => {
  const runner = fakeRun({ stdout: "", code: 1, stderr: "The application is not allowed to open a panel." });
  await assert.rejects(
    () => pickNativeDirectory({ platform: "darwin", run: runner.run }),
    (error: unknown) => error instanceof ApiError && error.code === "native_pick_failed" && /not allowed/.test(error.message),
  );
});

test("Windows asks PowerShell for the folder dialog and passes the folder through the environment", async () => {
  const runner = fakeRun({ stdout: "C:\\Users\\hadi\\code\\api" });
  const picked = await pickNativeDirectory({ platform: "win32", startingPath: "C:\\Users\\hadi\\code", run: runner.run });
  assert.equal(picked, "C:\\Users\\hadi\\code\\api");
  const call = runner.calls[0];
  assert.equal(call.command, "powershell.exe");
  assert.ok(call.args.includes("-Sta"), "the dialog needs a single-threaded apartment");
  const script = call.args[call.args.length - 1];
  assert.match(script, /FolderBrowserDialog/);
  assert.match(script, /AutoUpgradeEnabled/);
  assert.ok(!script.includes("C:\\Users\\hadi\\code"), "the starting folder never gets interpolated into the script");
  assert.equal(call.env?.PIWEB_PICKER_START, "C:\\Users\\hadi\\code");
  assert.equal(call.env?.PIWEB_PICKER_TITLE, "Select Workspace Directory");
});

test("Linux tries zenity, then kdialog only when zenity is not installed", async () => {
  const missing = new Error("spawn zenity ENOENT") as Error & { code: string };
  missing.code = "ENOENT";
  const first = fakeRun(missing);
  const second = fakeRun({ stdout: "/home/hadi/code\n" });
  // The fallback needs both calls, so hand it one recorder that fails then succeeds.
  const calls: string[] = [];
  const picked = await pickNativeDirectory({
    platform: "linux",
    run: async (command) => {
      calls.push(command);
      if (command === "zenity") throw missing;
      return { stdout: "/home/hadi/code\n", code: 0, stderr: "" };
    },
  });
  assert.equal(picked, "/home/hadi/code");
  assert.deepEqual(calls, ["zenity", "kdialog"]);
  assert.equal(first.calls.length, 0);
  assert.equal(second.calls.length, 0);
});

test("zenity's exit 1 means the operator cancelled", async () => {
  const runner = fakeRun({ stdout: "", code: 1 });
  assert.equal(await pickNativeDirectory({ platform: "linux", run: runner.run }), null);
});

test("no chooser at all is an actionable error, not a silent nothing", async () => {
  const missing = new Error("spawn kdialog ENOENT") as Error & { code: string };
  missing.code = "ENOENT";
  const zenityMissing = new Error("spawn zenity ENOENT") as Error & { code: string };
  zenityMissing.code = "ENOENT";
  await assert.rejects(
    () => pickNativeDirectory({
      platform: "linux",
      run: async (command) => { throw command === "zenity" ? zenityMissing : missing; },
    }),
    (error: unknown) => error instanceof ApiError && error.code === "native_pick_failed" && /install zenity or kdialog/.test(error.message),
  );
});

test("an unsupported platform refuses instead of guessing", async () => {
  await assert.rejects(
    () => pickNativeDirectory({ platform: "freebsd" as NodeJS.Platform, run: fakeRun({}).run }),
    (error: unknown) => error instanceof ApiError && error.code === "picker_unavailable",
  );
});

test("one chooser at a time: a second request joins the open panel instead of stacking another", async () => {
  let releases: ((value: ChooserRun) => void)[] = [];
  let opens = 0;
  const service = new NativePickerService({
    timeoutMs: 5_000,
    pick: async () => {
      opens += 1;
      const answer = await new Promise<ChooserRun>((done) => releases.push(done));
      return answer.stdout === "" ? null : answer.stdout;
    },
  });
  const first = service.pick({});
  const second = service.pick({});
  assert.equal(opens, 1, "no second chooser was opened for the second caller");
  assert.equal(service.busy, true);
  releases[0]({ stdout: "/picked", code: 0, stderr: "" });
  assert.equal(await first, "/picked");
  assert.equal(await second, "/picked");
  assert.equal(service.busy, false);
});

test("the chooser is released when the caller walks away, and the service is free again", async () => {
  let aborted = false;
  const service = new NativePickerService({
    timeoutMs: 5_000,
    pick: async (options) => await new Promise<string | null>((resolve, reject) => {
      options.signal?.addEventListener("abort", () => { aborted = true; reject(new Error("aborted by caller")); }, { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = service.pick({ signal: controller.signal });
  controller.abort();
  // A caller that hung up is not an error: there is nothing left to report to them.
  assert.equal(await pending, null);
  assert.equal(aborted, true);
  assert.equal(service.busy, false);
});

test("a hung chooser is killed by the watchdog rather than held forever", async () => {
  let killed = false;
  const service = new NativePickerService({
    timeoutMs: 20,
    pick: async (options) => await new Promise<string | null>((_resolve, reject) => {
      options.signal?.addEventListener("abort", () => { killed = true; reject(new Error("watchdog")); }, { once: true });
    }),
  });
  await assert.rejects(() => service.pick({}), (error: unknown) => error instanceof ApiError && error.code === "native_pick_failed");
  assert.equal(killed, true);
  assert.equal(service.busy, false);
});

test("isExistingDirectory only says yes to a folder the host can actually see", async () => {
  assert.equal(await isExistingDirectory(os.tmpdir()), true);
  assert.equal(await isExistingDirectory(`${os.tmpdir()}/definitely-not-here-41f2`), false);
  assert.equal(await isExistingDirectory("relative/never"), false);
  assert.equal(await isExistingDirectory("C:\\Users\\hadi"), false, "a Windows path is not valid on this host");
});
