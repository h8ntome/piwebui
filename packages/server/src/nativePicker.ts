/**
 * The native half of the workspace folder selector: which device gets the host's own
 * OS chooser (Finder on macOS, the Explorer folder dialog on Windows, Zenity/KDialog on
 * a Linux desktop), and how one is opened.
 *
 * The shape follows the shipped reference, `dsh-host-directory-picker-{native,auto,browse}`
 * in `@deepseek-ai/dsh@0.2.2-rc.1` (MIT), read with REA 6.8.0 on 2026-11-09 — parent
 * Evidence `ev_b905ad79f69e37d1a9ed30f733208e2d7db2bb1387735cd7c41ba93c28830498`, artifact
 * digest `sha256:a6c984654c0e87be76a4694153fca11197f34807ead1249e14292c2ca2b4f8c1`. The
 * reference resolves the backend once at boot from *host* facts only (loopback bind, no SSH
 * launch, platform, a Linux chooser on PATH), because a harness and its browser are assumed
 * to be the same machine. pi-web is not: its documented remote case is an SSH tunnel or a
 * mesh proxy, where a chooser on the server's display is worse than useless — it is on the
 * wrong computer. So two things are added here:
 *
 * 1. The *client's* platform must match the host's. A Mac browser on a Linux server gets the
 *    in-app browser, because nothing on that Linux box can open a Finder window.
 * 2. The connection must actually be local (socket peer is loopback), not merely bound local.
 *
 * Anything ambiguous falls back to `browse`, exactly as the reference's own resolver does.
 *
 * The chooser always runs as a child process with no shell, so a stalled or abandoned panel
 * can be killed instead of hanging the server, and the operator's folder name is never
 * interpolated into a command line (see SECURITY.md §5 for the no-shell boundary).
 */
import { spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import path from "node:path";
import { delimiter } from "node:path";
import type { DevicePlatform, DirectoryPickerMode, PickerPolicy } from "@piwebui/shared";
import { ApiError } from "./commands.ts";

/** The title every chooser shows; the reference uses the same string on all three platforms. */
export const PICKER_TITLE = "Select Workspace Directory";

/** A chooser may sit open while a person thinks; it may not answer with a megabyte of text. */
const MAX_CHOOSER_OUTPUT_BYTES = 16 * 1024;

/** Hard ceiling on one open panel: past this the child is killed and the pick fails. */
export const NATIVE_PICK_TIMEOUT_MS = 10 * 60_000;

/** The Linux choosers the native backend can drive, in the order it tries them. */
const LINUX_CHOOSERS = ["zenity", "kdialog"] as const;
export type LinuxChooser = (typeof LINUX_CHOOSERS)[number] | null;

/** The host facts the routing decision reads, all sampled by the caller. */
export interface PickerFacts {
  /** The host's own platform, already narrowed to the four the picker knows. */
  hostPlatform: DevicePlatform;
  /** What the browser claims to run on. Untrusted: it can only ever narrow toward browse. */
  clientPlatform: DevicePlatform;
  /** True when the request arrived over a loopback socket, i.e. the browser is on this box. */
  localPeer: boolean;
  /** True when pi-web itself was started from an SSH session (`SSH_CONNECTION`/`SSH_TTY`). */
  ssh: boolean;
  /** True when a Linux desktop session is reachable (`DISPLAY` or `WAYLAND_DISPLAY`). */
  display: boolean;
  /** Which Linux chooser is executable on PATH; null when there is none. */
  linuxChooser: LinuxChooser;
  /** Operator policy (`PIWEB_NATIVE_PICKER` / `server.json`). */
  policy: PickerPolicy;
}

/** Map any platform string (host or browser claim) onto the four the picker understands. */
export function normalizeDevicePlatform(platform: string | undefined): DevicePlatform {
  const p = (platform ?? "").toLowerCase();
  if (p === "darwin" || p === "mac" || p === "macos" || p.includes("mac")) return "darwin";
  if (p === "win32" || p === "windows" || p.includes("win")) return "win32";
  if (p === "linux" || p.includes("linux")) return "linux";
  return "other";
}

const DEVICE_LABELS: Record<DevicePlatform, string> = {
  darwin: "macOS",
  win32: "Windows",
  linux: "Linux",
  other: "an unknown device",
};

/**
 * The one decision: does this client get the host's OS chooser, or the in-app browser?
 *
 * Native needs every signal saying "the person clicking is at this machine's screen":
 * policy not off, a host we can drive a chooser on (macOS, Windows, or Linux with a desktop
 * session and a chooser installed), a browser that says it is on that same platform, and a
 * loopback connection. `force` drops the loopback and SSH gates — an `ssh -L` tunnel ends on
 * the operator's own machine, and they know it when the operator says so.
 */
export function resolvePickerMode(facts: PickerFacts): DirectoryPickerMode {
  const host = DEVICE_LABELS[facts.hostPlatform];
  if (facts.policy === "off") {
    return { mode: "browse", chooser: null, hostPlatform: facts.hostPlatform, reason: "native picking is turned off (PIWEB_NATIVE_PICKER=off)" };
  }
  if (facts.hostPlatform === "other") {
    return { mode: "browse", chooser: null, hostPlatform: facts.hostPlatform, reason: "this host has no OS folder chooser to open" };
  }
  if (facts.clientPlatform === "other") {
    return { mode: "browse", chooser: null, hostPlatform: facts.hostPlatform, reason: "this browser did not say what it runs on" };
  }
  if (facts.clientPlatform !== facts.hostPlatform) {
    return {
      mode: "browse",
      chooser: null,
      hostPlatform: facts.hostPlatform,
      reason: `the browser is on ${DEVICE_LABELS[facts.clientPlatform]} but pi-web is on ${host}, so its files are not what this folder list is reading`,
    };
  }
  if (facts.policy !== "force") {
    if (!facts.localPeer) {
      return { mode: "browse", chooser: null, hostPlatform: facts.hostPlatform, reason: `this browser is not connected to ${host} directly, so a chooser would open on the wrong machine` };
    }
    if (facts.ssh) {
      return { mode: "browse", chooser: null, hostPlatform: facts.hostPlatform, reason: `pi-web was started from an SSH session, so ${host} is not in front of you` };
    }
  }
  if (facts.hostPlatform === "darwin") {
    return { mode: "native", chooser: "Finder", hostPlatform: facts.hostPlatform, reason: "macOS: Finder's Open panel answers on this display" };
  }
  if (facts.hostPlatform === "win32") {
    return { mode: "native", chooser: "Windows Explorer", hostPlatform: facts.hostPlatform, reason: "Windows: the Explorer folder dialog answers on this display" };
  }
  if (!facts.display) {
    return { mode: "browse", chooser: null, hostPlatform: facts.hostPlatform, reason: "this Linux host has no desktop session (DISPLAY/WAYLAND_DISPLAY), so there is no chooser to open" };
  }
  if (facts.linuxChooser === null) {
    return { mode: "browse", chooser: null, hostPlatform: facts.hostPlatform, reason: "no Linux folder chooser is installed (install zenity or kdialog) " };
  }
  return { mode: "native", chooser: facts.linuxChooser === "zenity" ? "Zenity" : "KDialog", hostPlatform: facts.hostPlatform, reason: `Linux desktop: ${facts.linuxChooser} answers on this display` };
}

/** Whether one candidate file is executable by this process. */
export function isExecutable(candidate: string): boolean {
  try {
    accessSync(candidate, constants.X_OK);
  } catch {
    return false;
  }
  return true;
}

/** The first Linux folder chooser on PATH, or null when there is none. */
export function findLinuxChooser(pathValue: string | undefined, exists: (candidate: string) => boolean = isExecutable): LinuxChooser {
  for (const dir of (pathValue ?? "").split(delimiter)) {
    if (dir === "") continue;
    for (const name of LINUX_CHOOSERS) {
      if (exists(path.join(dir, name))) return name;
    }
  }
  return null;
}

/** Loopback in every spelling a socket peer arrives with, IPv4-mapped IPv6 included. */
export function isLoopbackAddress(address: string | undefined): boolean {
  const a = (address ?? "").trim().replace(/^\[|\]$/g, "").toLowerCase();
  if (a === "" ) return false;
  const bare = a.startsWith("::ffff:") ? a.slice(7) : a;
  if (bare === "127.0.0.1" || bare === "::1" || bare === "localhost") return true;
  // 127.0.0.0/8 is all loopback, not just 127.0.0.1.
  return /^127\./.test(bare);
}

export interface SampleOptions {
  /** The browser's platform claim from the query string. */
  clientPlatform: string | undefined;
  /** `req.ip` (trustProxy is off, so this is the real socket peer). */
  peerAddress: string | undefined;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  policy?: PickerPolicy;
  exists?: (candidate: string) => boolean;
}

/** Read every fact the resolver needs, in one call, from live process state. */
export function samplePickerFacts(options: SampleOptions): PickerFacts {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  return {
    hostPlatform: normalizeDevicePlatform(platform),
    clientPlatform: normalizeDevicePlatform(options.clientPlatform),
    localPeer: isLoopbackAddress(options.peerAddress),
    ssh: Boolean(env.SSH_CONNECTION || env.SSH_TTY),
    display: present(env.DISPLAY) || present(env.WAYLAND_DISPLAY),
    linuxChooser: findLinuxChooser(env.PATH, options.exists),
    policy: options.policy ?? "on",
  };
}

function present(value: string | undefined): boolean {
  return value !== undefined && value !== "";
}

/** The result of one chooser child process: its stdout, and why it stopped if that was odd. */
interface ChooserRun {
  stdout: string;
  /** Process exit code, or the errno string when the command never started. */
  code: number | string | null;
  /** Last stderr lines, for a message the operator can act on. */
  stderr: string;
}

/** How a chooser child is launched: extra environment, plus where it starts. */
export interface ChooserLaunch {
  env?: Record<string, string> | undefined;
  /**
   * Working directory for the chooser. It is how the starting folder reaches the Linux
   * choosers, which have no "open here" argument of their own and simply show the process's
   * own directory.
   */
  cwd?: string | undefined;
}

/**
 * How one chooser child runs. Injected everywhere so the abort, cancel and failure paths are
 * all testable without a desktop: production runs the real command, no shell.
 */
export type ChooserRunner = (command: string, args: string[], launch?: ChooserLaunch, signal?: AbortSignal) => Promise<ChooserRun>;

/** An error carrying the child's exit code, so callers can tell "cancelled" from "broken". */
export class ChooserError extends Error {
  constructor(message: string, readonly code: number | string | null = null) {
    super(message);
    this.name = "ChooserError";
  }
}

/**
 * Run one chooser command with no shell. Output is capped (a chooser answers with a path),
 * and an abort kills the child rather than leaving a panel nobody is looking at.
 */
export const runChooser: ChooserRunner = (command, args, launch = {}, signal) => new Promise<ChooserRun>((resolve, reject) => {
  if (signal?.aborted) {
    reject(new ChooserError("the folder chooser was cancelled", "ABORT"));
    return;
  }
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...(launch.env ?? {}) },
    ...(launch.cwd !== undefined ? { cwd: launch.cwd } : {}),
    windowsHide: true,
    shell: false,
  });
  let stdout = "";
  let stderr = "";
  let settled = false;
  const kill = () => { try { child.kill(); } catch { /* already gone */ } };
  const onAbort = () => kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  const finish = (run: ChooserRun | null, error: Error | null) => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", onAbort);
    if (error !== null) reject(error);
    else resolve(run as ChooserRun);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (stdout.length > MAX_CHOOSER_OUTPUT_BYTES) {
      kill();
      finish(null, new ChooserError(`${command} returned more than ${MAX_CHOOSER_OUTPUT_BYTES} bytes; that is not a folder path`));
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-400); });
  child.on("error", (error: NodeJS.ErrnoException) => finish(null, new ChooserError(describeSpawnFailure(command, error), error.code ?? null)));
  child.on("close", (code) => {
    if (signal?.aborted) {
      finish(null, new ChooserError("the folder chooser was cancelled", "ABORT"));
      return;
    }
    finish({ stdout, code, stderr }, null);
  });
});

/** Turn "the chooser binary is not here" into something an operator can act on. */
function describeSpawnFailure(command: string, error: NodeJS.ErrnoException): string {
  if (error.code === "ENOENT") return `no folder chooser available: ${command} is not installed or not on PATH`;
  return `cannot start ${command}: ${error.message}`;
}

/**
 * macOS's Open panel, run by the system JXA host.
 *
 * Two details are load-bearing, and both come from the reference reading: a panel with no
 * main menu cannot paste into "Go to Folder" (⌘V resolves against the menu, not the field),
 * and activation has to be queued onto the main operation queue so it runs inside the panel's
 * modal loop — asking synchronously leaves the panel behind the browser. `urls` still
 * carries the highlighted folder after a cancel, so only an OK response is read.
 *
 * The starting folder arrives as argv, never as source, and only when the host itself agreed
 * it is a directory.
 */
const MAC_PANEL = `
ObjC.import('AppKit');
function run(argv) {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var mainMenu = $.NSMenu.alloc.init;
  mainMenu.addItem($.NSMenuItem.alloc.init);
  var editItem = $.NSMenuItem.alloc.init;
  var editMenu = $.NSMenu.alloc.initWithTitle('Edit');
  editItem.submenu = editMenu;
  mainMenu.addItem(editItem);
  editMenu.addItemWithTitleActionKeyEquivalent('Undo', 'undo:', 'z');
  editMenu.addItemWithTitleActionKeyEquivalent('Redo', 'redo:', 'Z');
  editMenu.addItemWithTitleActionKeyEquivalent('Cut', 'cut:', 'x');
  editMenu.addItemWithTitleActionKeyEquivalent('Copy', 'copy:', 'c');
  editMenu.addItemWithTitleActionKeyEquivalent('Paste', 'paste:', 'v');
  editMenu.addItemWithTitleActionKeyEquivalent('Select All', 'selectAll:', 'a');
  app.mainMenu = mainMenu;
  var panel = $.NSOpenPanel.openPanel;
  panel.canChooseFiles = false;
  panel.canChooseDirectories = true;
  panel.canCreateDirectories = true;
  panel.allowsMultipleSelection = false;
  panel.message = argv[0];
  if (argv.length > 1 && ('' + argv[1]).length > 0) {
    var start = $.NSURL.fileURLWithPath(argv[1]);
    try { panel.setURL(start); } catch (e) {}
    try { panel.setDirectoryURL(start); } catch (e) {}
  }
  $.NSOperationQueue.mainQueue.addOperationWithBlock(function() {
    app.activateIgnoringOtherApps(true);
  });
  if (panel.runModal !== $.NSModalResponseOK) return '';
  var urls = panel.URLs;
  if (urls.count < 1) return '';
  return ObjC.unwrap(urls.objectAtIndex(0).path);
}`;

/**
 * The Explorer folder dialog, run by PowerShell in the child process. `AutoUpgradeEnabled`
 * is what makes WinForms show the modern dialog rather than the 1990s tree view; the title
 * and starting folder travel as environment variables, so a folder name is never code.
 * The owner window exists only to give the dialog a foreground claim: a dialog opened by a
 * background console process otherwise lands behind the browser, which is the failure mode
 * the reference works around with an injected Alt press on its own worker.
 */
const WIN_DIALOG = [
  "$ErrorActionPreference = 'Stop';",
  "Add-Type -AssemblyName System.Windows.Forms | Out-Null;",
  "Add-Type -AssemblyName System.Drawing | Out-Null;",
  "$owner = New-Object System.Windows.Forms.Form;",
  "$owner.ShowInTaskbar = $false; $owner.TopMost = $true; $owner.Opacity = 0;",
  "$owner.Size = New-Object System.Drawing.Size(0,0);",
  "$owner.Show();",
  "$dialog = New-Object System.Windows.Forms.FolderBrowserDialog;",
  "$dialog.Description = $env:PIWEB_PICKER_TITLE;",
  "$dialog.UseDescriptionForTitle = $true;",
  "$dialog.AutoUpgradeEnabled = $true;",
  "$dialog.ShowNewFolderButton = $true;",
  "$start = $env:PIWEB_PICKER_START;",
  "if ($start -and (Test-Path -LiteralPath $start)) { $dialog.SelectedPath = $start; }",
  "try {",
  "  if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($dialog.SelectedPath); }",
  "} finally {",
  "  $dialog.Dispose();",
  "  $owner.Close();",
  "}",
].join(" ");

/** The exit code or errno carried by any thrown value, ChooserError or plain Error alike. */
function errorCode(error: unknown): string | number | null {
  if (typeof error !== "object" || error === null || !("code" in error)) return null;
  const code = (error as { code: unknown }).code;
  return typeof code === "string" || typeof code === "number" ? code : null;
}

/** A caller that hung up: the panel should close, and nobody is left to report a failure to. */
function isAbort(error: unknown): boolean {
  return errorCode(error) === "ABORT";
}

/** The chooser binary is simply not installed (as opposed to installed and unhappy). */
function isMissingCommand(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

/** The path a chooser answered, or null for a cancel (empty stdout, the reference's signal). */
function outputPath(stdout: string): string | null {
  const trimmed = stdout.replace(/[\r\n]+$/, "");
  return trimmed === "" ? null : trimmed;
}

/** zenity exits 1 when the operator cancels; kdialog likewise. Anything else is a failure. */
const EXIT_CANCELLED = 1;

/** Message text of any thrown value, for an operator who has to read it. */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fail(chooser: string, run: ChooserRun): never {
  const detail = run.stderr.trim() || `exit ${String(run.code)}`;
  throw new ApiError("native_pick_failed", `${chooser} could not open a folder chooser: ${detail}`);
}

export interface PickOptions {
  signal?: AbortSignal;
  /** Where the chooser should open, when the client named a folder the host has already verified. */
  startingPath?: string | null;
  title?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  run?: ChooserRunner;
}

/**
 * Open one OS chooser on the host's display and resolve with the chosen absolute path, or
 * null when the operator cancelled. Every platform branch runs a child process, so an abort
 * (the browser tab went away, the request timed out) terminates the panel instead of leaving
 * it stranded on a screen nobody is watching.
 */
export async function pickNativeDirectory(options: PickOptions = {}): Promise<string | null> {
  const platform = options.platform ?? process.platform;
  const run = options.run ?? runChooser;
  const signal = options.signal;
  const title = options.title ?? PICKER_TITLE;
  const start = options.startingPath ?? null;
  const extraEnv: Record<string, string> = { PIWEB_PICKER_TITLE: title };
  if (start !== null) extraEnv.PIWEB_PICKER_START = start;

  if (platform === "darwin") {
    const argv = [title, ...(start !== null ? [start] : [])];
    const run_ = await run("osascript", ["-l", "JavaScript", "-e", MAC_PANEL, ...argv], { cwd: start ?? undefined }, signal).catch((error: unknown) => {
      if (isAbort(error)) return null;
      throw error;
    });
    if (run_ === null) return null;
    // Finder's cancel is the panel answering OK to nothing: exit 0 and an empty line. A
    // non-zero osascript is a real failure (no window server, a refused panel, a script
    // error), and hiding it as "cancelled" is how a picker ends up silently doing nothing.
    if (run_.code !== 0) fail("macOS Finder", run_);
    return outputPath(run_.stdout);
  }

  if (platform === "win32") {
    const out = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Sta", "-Command", WIN_DIALOG],
      { env: extraEnv, cwd: start ?? undefined },
      signal,
    ).catch((error: unknown) => {
      if (isAbort(error)) return null;
      throw error;
    });
    if (out === null) return null;
    if (out.code === 0) return outputPath(out.stdout);
    fail("Windows Explorer", out);
  }

  if (platform === "linux") {
    // zenity first (GTK desktops, and the one most users already have), kdialog as the
    // KDE fallback. A missing binary is the only reason to try the second; a chooser that is
    // installed and failing is reported, not papered over with another tool.
    try {
      const out = await run("zenity", ["--file-selection", "--directory", `--title=${title}`], { cwd: start ?? undefined }, signal);
      if (out.code === EXIT_CANCELLED) return null;
      if (out.code !== 0) fail("zenity", out);
      return outputPath(out.stdout);
    } catch (error) {
      if (isAbort(error)) return null;
      if (error instanceof ApiError) throw error;
      if (!isMissingCommand(error)) throw new ApiError("native_pick_failed", errorText(error));
    }
    try {
      const out = await run("kdialog", ["--getexistingdirectory", start ?? ".", "--title", title], { cwd: start ?? undefined }, signal);
      if (out.code === EXIT_CANCELLED) return null;
      if (out.code !== 0) fail("kdialog", out);
      return outputPath(out.stdout);
    } catch (error) {
      if (isAbort(error)) return null;
      if (error instanceof ApiError) throw error;
      if (isMissingCommand(error)) {
        throw new ApiError("native_pick_failed", "no Linux folder chooser is installed (install zenity or kdialog), or pick the folder in the in-app browser");
      }
      throw new ApiError("native_pick_failed", errorText(error));
    }
  }

  throw new ApiError("picker_unavailable", `there is no OS folder chooser for ${platform}`);
}

/**
 * One in-flight native pick at a time.
 *
 * A second "open the chooser" while a panel is already up would stack a second Finder window
 * on the same screen, and the two answers would land in whichever tab asked first. So every
 * caller joins the one open panel's outcome, which also makes the watchdog easy to reason
 * about: there is at most one child process to kill.
 */
interface InFlightPick {
  promise: Promise<string | null>;
  controller: AbortController;
  timer: NodeJS.Timeout;
  /** Callers still waiting on this one panel; when the last one goes, the panel closes. */
  callers: number;
}

export class NativePickerService {
  private current: InFlightPick | null = null;

  constructor(private readonly options: { pick?: (options: PickOptions) => Promise<string | null>; timeoutMs?: number } = {}) {}

  /** True while a chooser is open on the host's display. */
  get busy(): boolean {
    return this.current !== null;
  }

  /**
   * Ask for one pick, sharing a panel that is already open: two tabs that both press
   * "Add workspace" get one Finder window and the same answer, not two panels racing.
   * `signal` is the caller's own lifetime; aborting it closes the panel for everyone.
   */
  async pick(options: PickOptions = {}): Promise<string | null> {
    if (this.current === null) {
      const controller = new AbortController();
      const timeoutMs = this.options.timeoutMs ?? NATIVE_PICK_TIMEOUT_MS;
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      (timer as { unref?: () => void }).unref?.();
      const pick = this.options.pick ?? pickNativeDirectory;
      const entry: InFlightPick = { promise: Promise.resolve(null), controller, timer, callers: 0 };
      entry.promise = pick({ ...options, signal: controller.signal })
        .then((chosen) => chosen, (error: unknown) => {
          if (error instanceof ApiError) throw error;
          throw new ApiError("native_pick_failed", errorText(error));
        })
        .finally(() => {
          clearTimeout(timer);
          if (this.current === entry) this.current = null;
        });
      this.current = entry;
    }
    const live = this.current;
    live.callers += 1;
    // Whoever asked owns the panel's lifetime: if that tab goes away, the window goes with it,
    // and the ones still waiting are none the worse (the panel died while they were not looking).
    const caller = options.signal;
    const leave = () => {
      if (live.callers <= 0) return;
      live.callers -= 1;
      if (live.callers === 0) live.controller.abort();
    };
    if (caller !== undefined && !caller.aborted) caller.addEventListener("abort", leave, { once: true });
    else if (caller?.aborted) leave();
    try {
      return await live.promise;
    } catch (error) {
      // A caller that walked away gets "cancelled" rather than an error: there is nobody left
      // to read the difference, and their dialog must not show one.
      if (caller?.aborted) return null;
      throw error;
    } finally {
      caller?.removeEventListener("abort", leave);
      leave();
    }
  }

  /** Close any open chooser (server shutdown): the panel is killed, not orphaned. */
  cancelAll(): void {
    const live = this.current;
    if (live === null) return;
    this.current = null;
    clearTimeout(live.timer);
    live.controller.abort();
  }
}
