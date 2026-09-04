import assert from "node:assert/strict";
import test from "node:test";

import {
  createMatchClock,
  delayUntilMatchClock,
  setMatchClockRunning,
} from "../cc2-gui/match-clock.mjs";

test("a human opponent waits until its 1 PPS lock time", () => {
  let clock = createMatchClock(0);
  clock = setMatchClockRunning(clock, true, 0);
  assert.equal(delayUntilMatchClock(clock, 1_000, 250), 750);
  assert.equal(delayUntilMatchClock(clock, 1_000, 1_100), 0);
});
