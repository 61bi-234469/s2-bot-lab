import { FRAME_DURATION_MS } from "./human-play.mjs";

/** Idle input pumps track the Engine's 60 Hz frame grid, not a delay stacked
 * after the previous response. */
export const INPUT_PUMP_INTERVAL_MS = FRAME_DURATION_MS;

/** Consecutive zero-delay catch-up pumps before yielding one interval. One
 * step can already advance 120 frames; this only bounds event-loop spinning. */
export const INPUT_PUMP_MAX_CATCH_UP = 3;

/**
 * Next idle pump deadline on the shared match clock.
 *
 * The idle tick is due at `(serverFrame + 1)` intervals. A queued input can be
 * sent once elapsed time reaches `earliestPendingFrame` intervals, which may be
 * sooner. Catch-up yield applies only to empty behind-clock spinning; a
 * sendable pending input is not delayed by that bound.
 */
export function nextIdlePumpDueAt({
  nowMs,
  elapsedMs,
  serverFrame,
  earliestPendingFrame = null,
  intervalMs = INPUT_PUMP_INTERVAL_MS,
  catchUpStreak = 0,
  maxCatchUpStreak = INPUT_PUMP_MAX_CATCH_UP,
} = {}) {
  assertTimestamp(nowMs, "nowMs");
  assertTimestamp(elapsedMs, "elapsedMs");
  if (!Number.isSafeInteger(serverFrame) || serverFrame < 0) {
    throw new Error("serverFrame must be a non-negative integer");
  }
  if (earliestPendingFrame !== null &&
      (!Number.isSafeInteger(earliestPendingFrame) || earliestPendingFrame < 0)) {
    throw new Error("earliestPendingFrame must be a non-negative integer");
  }
  assertPositive(intervalMs, "intervalMs");
  if (!Number.isSafeInteger(catchUpStreak) || catchUpStreak < 0) {
    throw new Error("catchUpStreak must be a non-negative integer");
  }
  if (!Number.isSafeInteger(maxCatchUpStreak) || maxCatchUpStreak < 1) {
    throw new Error("maxCatchUpStreak must be a positive integer");
  }

  const regularDueElapsedMs = (serverFrame + 1) * intervalMs;
  const pendingDueElapsedMs = earliestPendingFrame === null
    ? Number.POSITIVE_INFINITY
    : earliestPendingFrame * intervalMs;
  const dueElapsedMs = Math.min(regularDueElapsedMs, pendingDueElapsedMs);
  const delayMs = Math.max(0, dueElapsedMs - elapsedMs);
  if (delayMs > 0) return { dueAtMs: nowMs + delayMs, catchUpStreak: 0 };
  if (earliestPendingFrame !== null && elapsedMs >= pendingDueElapsedMs) {
    return { dueAtMs: nowMs, catchUpStreak: 0 };
  }
  const streak = catchUpStreak + 1;
  if (streak > maxCatchUpStreak) {
    return { dueAtMs: nowMs + intervalMs, catchUpStreak: 0 };
  }
  return { dueAtMs: nowMs, catchUpStreak: streak };
}

/** Lowest assigned frame among queued key events, or null when none are waiting. */
export function earliestPendingInputFrame(pending) {
  if (!Array.isArray(pending)) return null;
  let earliest = null;
  for (const event of pending) {
    if (!Number.isSafeInteger(event?.frame) || event.frame < 0) continue;
    if (earliest === null || event.frame < earliest) earliest = event.frame;
  }
  return earliest;
}

/**
 * Whether a new due time should replace an existing timer.
 *
 * Equal times keep the current reservation so a due timer is not cancelled and
 * rescheduled. A later request never pushes an earlier reservation back.
 */
export function selectPumpReservation({ nowMs, dueAtMs, existingDueAtMs = null } = {}) {
  assertTimestamp(nowMs, "nowMs");
  assertTimestamp(dueAtMs, "dueAtMs");
  if (existingDueAtMs !== null) assertTimestamp(existingDueAtMs, "existingDueAtMs");
  if (existingDueAtMs !== null && dueAtMs >= existingDueAtMs) {
    return { action: "keep", dueAtMs: existingDueAtMs };
  }
  return { action: existingDueAtMs === null ? "schedule" : "replace", dueAtMs };
}

function assertTimestamp(value, label) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative`);
}

function assertPositive(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive`);
}
