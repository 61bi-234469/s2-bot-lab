import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceMatchPlaybackDeadline,
  createMatchClock,
  delayUntilMatchClock,
  matchPlaybackDelay,
  readMatchClock,
  setMatchClockRunning,
  synchronizeMatchClock,
} from "../cc2-gui/match-clock.mjs";

test("shared match clock advances in real time", () => {
  let clock = createMatchClock(100);
  clock = setMatchClockRunning(clock, true, 100);
  assert.equal(readMatchClock(clock, 350), 250);

  clock = setMatchClockRunning(clock, false, 350);
  assert.equal(readMatchClock(clock, 900), 250);
});

test("a human opponent waits until its 1 PPS lock time", () => {
  let clock = createMatchClock(0);
  clock = setMatchClockRunning(clock, true, 0);
  assert.equal(delayUntilMatchClock(clock, 1_000, 250), 750);
  assert.equal(delayUntilMatchClock(clock, 1_000, 1_100), 0);
});

test("server synchronization preserves running state and shared elapsed time", () => {
  let clock = createMatchClock(0);
  clock = setMatchClockRunning(clock, true, 0);
  clock = synchronizeMatchClock(clock, 750, 1000);
  assert.equal(readMatchClock(clock, 1200), 950);
});

test("clock projection stops at the next authoritative lock and never needs to rewind", () => {
  let clock = createMatchClock(0);
  clock = setMatchClockRunning(clock, true, 0);
  clock = synchronizeMatchClock(clock, 0, 0, 250);
  assert.equal(readMatchClock(clock, 100), 100);
  assert.equal(readMatchClock(clock, 1_000), 250);

  clock = synchronizeMatchClock(clock, 250, 1_000, 500);
  assert.equal(readMatchClock(clock, 1_000), 250);
  assert.equal(readMatchClock(clock, 1_100), 350);
});

test("clock synchronization rejects a horizon behind authoritative time", () => {
  const clock = createMatchClock(0);
  assert.throws(
    () => synchronizeMatchClock(clock, 500, 0, 499),
    /maximumElapsedMs/,
  );
});

test("high PPS remains monotonic when proposal latency is the bottleneck", () => {
  const framesPerTurn = 15;
  const latencyMs = 300;
  let nowMs = 0;
  let authoritativeMs = 0;
  let renderedMs = 0;
  let clock = setMatchClockRunning(createMatchClock(nowMs), true, nowMs);
  clock = synchronizeMatchClock(clock, authoritativeMs, nowMs, 250);

  for (let step = 0; step < 6; step += 1) {
    nowMs += latencyMs + matchPlaybackDelay({
      framesPerTurn,
      stepElapsedMs: latencyMs,
    });
    const projectedMs = readMatchClock(clock, nowMs);
    assert.ok(projectedMs >= renderedMs);
    assert.ok(projectedMs <= authoritativeMs + 250);
    renderedMs = projectedMs;

    authoritativeMs += 250;
    clock = synchronizeMatchClock(
      clock,
      authoritativeMs,
      nowMs,
      authoritativeMs + 250,
    );
    const synchronizedMs = readMatchClock(clock, nowMs);
    assert.ok(synchronizedMs >= renderedMs);
    renderedMs = synchronizedMs;
  }
});

test("playback delay follows the lock cadence", () => {
  assert.equal(matchPlaybackDelay({ framesPerTurn: 60 }), 1000);
  assert.equal(matchPlaybackDelay({ framesPerTurn: 60, stepElapsedMs: 100 }), 900);
  assert.equal(matchPlaybackDelay({ framesPerTurn: 60, stepElapsedMs: 1_500 }), 0);
});

test("absolute playback deadlines recover transient lateness instead of accumulating drift", () => {
  let deadlineMs = 1_000;
  deadlineMs = advanceMatchPlaybackDeadline({
    deadlineMs,
    previousElapsedMs: 0,
    elapsedMs: 1_000,
  });
  assert.equal(deadlineMs, 2_000);
  assert.equal(Math.max(0, deadlineMs - 1_270), 730);

  deadlineMs = advanceMatchPlaybackDeadline({
    deadlineMs,
    previousElapsedMs: 1_000,
    elapsedMs: 2_000,
  });
  assert.equal(deadlineMs, 3_000);
  assert.equal(Math.max(0, deadlineMs - 1_400), 1_600);
});
