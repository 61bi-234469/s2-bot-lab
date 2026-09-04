export function createMatchClock(nowMs = 0) {
  assertTimestamp(nowMs, "nowMs");
  return { elapsedMs: 0, anchoredAtMs: nowMs, running: false, maximumElapsedMs: null };
}

export function readMatchClock(clock, nowMs) {
  assertClock(clock);
  assertTimestamp(nowMs, "nowMs");
  const wallElapsedMs = clock.running ? Math.max(0, nowMs - clock.anchoredAtMs) : 0;
  const projected = clock.elapsedMs + wallElapsedMs;
  return clock.maximumElapsedMs === null
    ? projected
    : Math.min(projected, clock.maximumElapsedMs);
}

// A 1P opponent is scheduled against this same real-time clock. Its lock is
// due at the requested elapsed match time; there is no playback-rate layer.
export function delayUntilMatchClock(clock, targetElapsedMs, nowMs) {
  assertTimestamp(targetElapsedMs, "targetElapsedMs");
  return Math.max(0, targetElapsedMs - readMatchClock(clock, nowMs));
}

export function setMatchClockRunning(clock, running, nowMs) {
  if (typeof running !== "boolean") throw new Error("running must be boolean");
  const elapsedMs = readMatchClock(clock, nowMs);
  return { ...clock, elapsedMs, anchoredAtMs: nowMs, running };
}

export function synchronizeMatchClock(clock, elapsedMs, nowMs, maximumElapsedMs = null) {
  assertClock(clock);
  assertTimestamp(elapsedMs, "elapsedMs");
  assertTimestamp(nowMs, "nowMs");
  assertMaximumElapsed(maximumElapsedMs, elapsedMs);
  return { ...clock, elapsedMs, anchoredAtMs: nowMs, maximumElapsedMs };
}

export function matchPlaybackDelay({
  framesPerTurn,
  stepElapsedMs = 0,
  framesPerSecond = 60,
}) {
  if (!Number.isFinite(framesPerTurn) || framesPerTurn <= 0) {
    throw new Error("framesPerTurn must be positive");
  }
  assertTimestamp(stepElapsedMs, "stepElapsedMs");
  if (!Number.isFinite(framesPerSecond) || framesPerSecond <= 0) {
    throw new Error("framesPerSecond must be positive");
  }
  const turnDurationMs = framesPerTurn * 1000 / framesPerSecond;
  return Math.max(0, turnDurationMs - stepElapsedMs);
}

export function advanceMatchPlaybackDeadline({
  deadlineMs,
  previousElapsedMs,
  elapsedMs,
}) {
  assertTimestamp(deadlineMs, "deadlineMs");
  assertTimestamp(previousElapsedMs, "previousElapsedMs");
  assertTimestamp(elapsedMs, "elapsedMs");
  if (elapsedMs < previousElapsedMs) throw new Error("elapsedMs must not move backward");
  return deadlineMs + elapsedMs - previousElapsedMs;
}

function assertClock(clock) {
  if (clock === null || typeof clock !== "object") throw new Error("clock must be an object");
  assertTimestamp(clock.elapsedMs, "clock.elapsedMs");
  assertTimestamp(clock.anchoredAtMs, "clock.anchoredAtMs");
  assertMaximumElapsed(clock.maximumElapsedMs, clock.elapsedMs);
  if (typeof clock.running !== "boolean") throw new Error("clock.running must be boolean");
}

function assertMaximumElapsed(value, elapsedMs) {
  if (value !== null && (!Number.isFinite(value) || value < elapsedMs)) {
    throw new Error("clock.maximumElapsedMs must be null or at least elapsedMs");
  }
}

function assertTimestamp(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
}
