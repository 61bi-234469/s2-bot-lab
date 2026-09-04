const FRAMES_PER_SECOND = 60;

export function realtimeDeadlineDelayMs({ scheduledFrame, requestWallFrame, elapsedMs }) {
  assertFrame(scheduledFrame, "scheduledFrame");
  assertFrame(requestWallFrame, "requestWallFrame");
  assertElapsed(elapsedMs);
  const deadlineMs = Math.max(0, (scheduledFrame - requestWallFrame) * 1000 / FRAMES_PER_SECOND);
  return Math.max(0, deadlineMs - elapsedMs);
}

export function realtimeScheduledLockFrame({ scheduledFrame, requestWallFrame, elapsedMs, currentLogicalFrame }) {
  assertFrame(scheduledFrame, "scheduledFrame");
  assertFrame(requestWallFrame, "requestWallFrame");
  assertFrame(currentLogicalFrame, "currentLogicalFrame");
  assertElapsed(elapsedMs);
  return Math.max(
    scheduledFrame,
    requestWallFrame + Math.ceil(elapsedMs * FRAMES_PER_SECOND / 1000),
    currentLogicalFrame + 1,
  );
}

function assertFrame(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}

function assertElapsed(value) {
  if (!Number.isFinite(value) || value < 0) throw new Error("elapsedMs must be non-negative");
}
