/**
 * The browser's own platform claim: the one input the server cannot check for itself, so it
 * is used in exactly one direction - it can talk the host out of a native chooser, never into
 * one. These probes are what real UAs actually look like, because the mistakes are all in the
 * edges (an iPhone answering "macOS", a Linux Firefox with no userAgentData).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectDevicePlatform, deviceLabel } from "../src/lib/device.ts";

const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const WIN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const LINUX_UA = "Mozilla/5.0 (X11; Linux x86_64; rv:141.0) Gecko/20100101 Firefox/141.0";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";
const ANDROID_UA = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36";

test("a Mac browser says macOS even when only the UA string is available", () => {
  assert.equal(detectDevicePlatform({ userAgent: MAC_UA }), "darwin");
  assert.equal(detectDevicePlatform({ uaDataPlatform: "macOS", userAgent: MAC_UA }), "darwin");
  assert.equal(detectDevicePlatform({ navigatorPlatform: "MacIntel", userAgent: "safari-no-ua" }), "darwin");
});

test("Windows and Linux read off their own hints", () => {
  assert.equal(detectDevicePlatform({ userAgent: WIN_UA }), "win32");
  assert.equal(detectDevicePlatform({ uaDataPlatform: "Windows", userAgent: WIN_UA }), "win32");
  assert.equal(detectDevicePlatform({ userAgent: LINUX_UA, navigatorPlatform: "Linux x86_64" }), "linux");
});

test("a phone is not a desktop, however macOS-ish its UA is", () => {
  assert.equal(detectDevicePlatform({ userAgent: IPHONE_UA }), "other");
  assert.equal(detectDevicePlatform({ userAgent: ANDROID_UA }), "other");
});

test("nothing to go on is \"other\", which is never handed a native chooser", () => {
  assert.equal(detectDevicePlatform({}), "other");
  assert.equal(detectDevicePlatform({ userAgent: null, navigatorPlatform: null, uaDataPlatform: undefined }), "other");
});

test("the copy names the machine the operator is standing at", () => {
  assert.equal(deviceLabel("darwin"), "this Mac");
  assert.equal(deviceLabel("win32"), "this PC");
  assert.equal(deviceLabel("other"), "this machine");
});
