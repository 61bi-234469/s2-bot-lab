import assert from "node:assert/strict";
import test from "node:test";

import { realtimeDeadlineDelayMs, realtimeScheduledLockFrame } from "../src-js/realtime-match-pacing.mjs";

test("real-time bot pacing waits for an early deadline and records a late completion", () => {
  assert.equal(realtimeDeadlineDelayMs({ scheduledFrame: 60, requestWallFrame: 0, elapsedMs: 250 }), 750);
  assert.equal(realtimeDeadlineDelayMs({ scheduledFrame: 60, requestWallFrame: 0, elapsedMs: 1200 }), 0);
  assert.equal(realtimeScheduledLockFrame({
    scheduledFrame: 60,
    requestWallFrame: 0,
    elapsedMs: 1200,
    currentLogicalFrame: 0,
  }), 72);
});

test("real-time bot pacing never returns behind an intervening human lock", () => {
  assert.equal(realtimeScheduledLockFrame({
    scheduledFrame: 1002,
    requestWallFrame: 0,
    elapsedMs: 500,
    currentLogicalFrame: 1001,
  }), 1002);
});
