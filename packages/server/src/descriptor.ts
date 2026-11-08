/**
 * The bridge descriptor (bridge_plan D-2, 03 §2): the one file pi-web publishes so that a
 * terminal pi started in a shell that never saw pi-web can still find it with zero configuration.
 *
 * It is a secret: `bridge.json` (0600, in a 0700 directory) carries the shared bridge token, and
 * `~/.pi-web/servers/<serverId>.json` is a plain pointer for servers started on a non-default
 * `--data-dir`. Nothing here may ever log the token.
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  BRIDGE_DESCRIPTOR_V,
  BRIDGE_PROTOCOL,
  parseBridgeDescriptor,
  type BridgeDescriptor,
  type DescriptorRead,
} from "@piwebui/shared";

/** Unix socket paths are limited by the sockaddr_un sun_path (104 bytes on macOS, 108 on Linux). */
export const MAX_SOCKET_PATH_BYTES = 100;

export function descriptorPath(dataDir: string): string {
  return path.join(dataDir, "bridge.json");
}

export function bridgeSocketPath(dataDir: string, serverId: string): string {
  return path.join(dataDir, `bridge-${serverId}.sock`);
}

export function pointerPath(serverId: string, homedir: string = os.homedir()): string {
  return path.join(homedir, ".pi-web", "servers", `${serverId}.json`);
}

export function processStartMs(): number {
  return Math.floor(performance.timeOrigin);
}

function writePrivateJson(file: string, value: unknown): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  try { fs.chmodSync(tmp, 0o600); } catch { /* best effort */ }
  fs.renameSync(tmp, file);
}

export interface WriteDescriptorArgs {
  dataDir: string;
  serverId: string;
  socket: string;
  token: string;
  http: string;
  piwebVersion: string;
  startedAt?: string;
  /** Publish the `~/.pi-web/servers/<id>.json` pointer when the data dir is not the default. */
  publishPointer?: boolean;
  homedir?: string;
  pid?: number;
  procStart?: number;
}

/** Publish (or republish after a token rotation) the descriptor and, when needed, the pointer. */
export function writeDescriptor(args: WriteDescriptorArgs): { descriptor: BridgeDescriptor; path: string; pointerPath: string | null } {
  const now = new Date().toISOString();
  const descriptor: BridgeDescriptor = {
    v: BRIDGE_DESCRIPTOR_V,
    serverId: args.serverId,
    protocol: [BRIDGE_PROTOCOL],
    socket: args.socket,
    token: args.token,
    http: args.http,
    dataDir: args.dataDir,
    pid: args.pid ?? process.pid,
    procStart: args.procStart ?? processStartMs(),
    piwebVersion: args.piwebVersion,
    startedAt: args.startedAt ?? now,
    updatedAt: now,
  };
  const file = descriptorPath(args.dataDir);
  writePrivateJson(file, descriptor);
  let pointer: string | null = null;
  const home = args.homedir ?? os.homedir();
  const defaultDir = process.env.PIWEB_DATA_DIR || path.join(home, ".pi-web");
  const wantsPointer = args.publishPointer ?? path.resolve(args.dataDir) !== path.resolve(defaultDir);
  if (wantsPointer && path.resolve(path.dirname(file)) !== path.resolve(path.join(home, ".pi-web"))) {
    pointer = pointerPath(args.serverId, home);
    writePrivateJson(pointer, { descriptor: file, serverId: args.serverId, updatedAt: now });
  }
  return { descriptor, path: file, pointerPath: pointer };
}

export function readDescriptor(file: string): DescriptorRead {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return { ok: false, reason: code === "ENOENT" ? "missing" : "unreadable", path: file, detail: code ?? String((e as Error).message).slice(0, 80) };
  }
  return parseBridgeDescriptor(raw, file);
}

/** Read the pointer directory; unknown/malformed pointers are skipped, never fatal. */
export function readPointerDescriptors(homedir: string = os.homedir()): { path: string; descriptor: BridgeDescriptor }[] {
  const dir = path.join(homedir, ".pi-web", "servers");
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out: { path: string; descriptor: BridgeDescriptor }[] = [];
  for (const f of files) {
    const full = path.join(dir, f);
    let target: string | null = null;
    try {
      const pointer = JSON.parse(fs.readFileSync(full, "utf8")) as { descriptor?: unknown };
      if (typeof pointer.descriptor === "string") target = pointer.descriptor;
    } catch { /* skip */ }
    if (!target) continue;
    const read = readDescriptor(target);
    if (read.ok) out.push({ path: full, descriptor: read.descriptor });
  }
  return out;
}

export function removeDescriptorSocket(socketPath: string): void {
  try { fs.unlinkSync(socketPath); } catch { /* already gone */ }
}

/**
 * Does something already answer on this socket? A stale socket file refuses a connection
 * immediately (ENOENT/ECONNREFUSED); a live server accepts and says nothing, which is also an answer.
 */
export function probeSocket(socketPath: string, timeoutMs = 200): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(v);
    };
    const timer = setTimeout(() => done(true), timeoutMs);
    timer.unref?.();
    let sock: net.Socket;
    try {
      sock = net.createConnection({ path: socketPath });
    } catch {
      done(false);
      return;
    }
    sock.on("connect", () => done(true));
    sock.on("error", () => done(false));
  });
}

/** True when the file exists and no live process answers it: safe to unlink and rebind. */
export async function socketIsStale(socketPath: string): Promise<boolean> {
  try { fs.statSync(socketPath); } catch { return true; }
  return !(await probeSocket(socketPath));
}
