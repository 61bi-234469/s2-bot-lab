import test from "node:test";
import assert from "node:assert/strict";
import {
  INPUT_PUMP_INTERVAL_MS,
  INPUT_PUMP_MAX_CATCH_UP,
  earliestPendingInputFrame,
  nextIdlePumpDueAt,
  selectPumpReservation,
} from "../cc2-gui/input-pump-schedule.mjs";

test("idle pump waits until the next match-clock frame", () => {
  const idle = nextIdlePumpDueAt({ nowMs: 100, elapsedMs: 0, serverFrame: 0 });
  assert.equal(idle.catchUpStreak, 0);
  assert.equal(idle.dueAtMs, 100 + INPUT_PUMP_INTERVAL_MS);
});

test("idle pump subtracts elapsed time already spent in the current frame", () => {
  const idle = nextIdlePumpDueAt({
    nowMs: 0,
    elapsedMs: INPUT_PUMP_INTERVAL_MS * 1.2,
    serverFrame: 1,
  });
  assert.equal(idle.catchUpStreak, 0);
  assert.ok(Math.abs(idle.dueAtMs - INPUT_PUMP_INTERVAL_MS * 0.8) < 1e-9);
});

test("a behind clock fires immediately and counts catch-up", () => {
  const idle = nextIdlePumpDueAt({
    nowMs: 50,
    elapsedMs: INPUT_PUMP_INTERVAL_MS * 10,
    serverFrame: 0,
    catchUpStreak: 0,
  });
  assert.equal(idle.dueAtMs, 50);
  assert.equal(idle.catchUpStreak, 1);
});

test("catch-up yields one interval after the consecutive bound", () => {
  const idle = nextIdlePumpDueAt({
    nowMs: 50,
    elapsedMs: INPUT_PUMP_INTERVAL_MS * 400,
    serverFrame: 0,
    catchUpStreak: INPUT_PUMP_MAX_CATCH_UP,
  });
  assert.equal(idle.dueAtMs, 50 + INPUT_PUMP_INTERVAL_MS);
  assert.equal(idle.catchUpStreak, 0);
});

test("a pending input can make the idle pump due before the next server frame", () => {
  const idle = nextIdlePumpDueAt({
    nowMs: 13,
    elapsedMs: 13,
    serverFrame: 1,
    earliestPendingFrame: 1,
  });
  assert.equal(idle.catchUpStreak, 0);
  assert.ok(Math.abs(idle.dueAtMs - (13 + (INPUT_PUMP_INTERVAL_MS - 13))) < 1e-9);
  assert.ok(Math.abs(idle.dueAtMs - INPUT_PUMP_INTERVAL_MS) < 1e-9);
});

test("a later pending input does not delay the ordinary next-frame deadline", () => {
  const idle = nextIdlePumpDueAt({
    nowMs: 0,
    elapsedMs: 0,
    serverFrame: 1,
    earliestPendingFrame: 5,
  });
  assert.equal(idle.dueAtMs, 2 * INPUT_PUMP_INTERVAL_MS);
});

test("a sendable pending input is not delayed by catch-up yield", () => {
  const idle = nextIdlePumpDueAt({
    nowMs: 50,
    elapsedMs: INPUT_PUMP_INTERVAL_MS * 10,
    serverFrame: 1,
    earliestPendingFrame: 1,
    catchUpStreak: INPUT_PUMP_MAX_CATCH_UP,
  });
  assert.equal(idle.dueAtMs, 50);
  assert.equal(idle.catchUpStreak, 0);
});

test("earliestPendingInputFrame ignores unusable entries", () => {
  assert.equal(earliestPendingInputFrame(null), null);
  assert.equal(earliestPendingInputFrame([]), null);
  assert.equal(earliestPendingInputFrame([{ frame: 4 }, { frame: 1 }, { frame: -1 }]), 1);
});

test("selectPumpReservation keeps a sooner or equal existing due time", () => {
  assert.deepEqual(
    selectPumpReservation({ nowMs: 0, dueAtMs: 16, existingDueAtMs: null }),
    { action: "schedule", dueAtMs: 16 },
  );
  assert.deepEqual(
    selectPumpReservation({ nowMs: 1, dueAtMs: 1, existingDueAtMs: 16 }),
    { action: "replace", dueAtMs: 1 },
  );
  assert.deepEqual(
    selectPumpReservation({ nowMs: 0, dueAtMs: 16, existingDueAtMs: 0 }),
    { action: "keep", dueAtMs: 0 },
  );
  assert.deepEqual(
    selectPumpReservation({ nowMs: 5, dueAtMs: 5, existingDueAtMs: 5 }),
    { action: "keep", dueAtMs: 5 },
  );
});
