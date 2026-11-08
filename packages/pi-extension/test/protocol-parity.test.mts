/**
 * The extension cannot import `@piwebui/shared` (it must load inside pi with Node builtins only),
 * so it carries a small copy of the protocol constants. This test is what stops the two copies from
 * drifting apart silently - the classic way a bridge "works against the repo and fails against the
 * published server".
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRIDGE_INBOUND_BYTES,
  BRIDGE_MAX_CONNS,
  BRIDGE_MAX_FRAME_BYTES,
  BRIDGE_MAX_FRAMES_PER_SEC,
  BRIDGE_MAX_SERVERS,
  BRIDGE_PROTOCOL,
  BRIDGE_REPLAY_BYTES,
  BRIDGE_REPLAY_FRAMES,
  MAX_PREVIEW_MESSAGE_BYTES,
  MAX_TOOL_STATE_BYTES,
} from "@piwebui/shared";
import { BRIDGE_PROTOCOL as EXT_PROTOCOL, LIMITS } from "../extensions/pi-web-bridge.js";

test("protocol version is identical on both ends", () => {
  assert.equal(EXT_PROTOCOL, BRIDGE_PROTOCOL);
});

test("frame and buffer ceilings match the server's", () => {
  assert.equal(LIMITS.inboundBytes, BRIDGE_INBOUND_BYTES);
  assert.equal(LIMITS.maxServers, BRIDGE_MAX_SERVERS);
  assert.equal(LIMITS.replayFrames, BRIDGE_REPLAY_FRAMES);
  assert.equal(LIMITS.replayBytes, BRIDGE_REPLAY_BYTES);
  void BRIDGE_MAX_CONNS;
  void BRIDGE_MAX_FRAME_BYTES;
  void BRIDGE_MAX_FRAMES_PER_SEC;
});

test("the payload budgets the server will merge are the ones the bridge sends", () => {
  assert.equal(LIMITS.previewBytes, MAX_PREVIEW_MESSAGE_BYTES);
  assert.equal(LIMITS.toolStateBytes, MAX_TOOL_STATE_BYTES);
});
