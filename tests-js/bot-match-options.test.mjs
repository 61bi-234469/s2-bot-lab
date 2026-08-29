import assert from "node:assert/strict";
import test from "node:test";

import {
  matchOutcome,
  normalizeBotMatchOptions,
  ppsForThinkTime,
  realtimeCc2ThinkMs,
} from "../src-js/bot-match-options.mjs";

test("bot match options accept independent budgets, seed, and turn cap", () => {
  assert.deepEqual(normalizeBotMatchOptions({
    leftThinkMs: 100,
    rightThinkMs: 750,
    clockRate: 2,
    fairComparison: false,
    thinkTimePace: true,
    seed: 0xffff_ffff,
    maxTurns: 42,
  }), { leftThinkMs: 100, rightThinkMs: 750, fairComparison: false, thinkTimePace: true, seed: 0xffff_ffff, maxTurns: 42 });
});

test("bot match options reject unsafe or out-of-range values", () => {
  for (const candidate of [
    { leftThinkMs: 0 },
    { rightThinkMs: 10_001 },
    { fairComparison: "yes" },
    { fairComparison: true, thinkTimePace: true },
    { seed: -1 },
    { seed: 0x1_0000_0000 },
    { maxTurns: 0 },
  ]) assert.throws(() => normalizeBotMatchOptions(candidate));
});

test("null max turns enables an unlimited match", () => {
  assert.equal(normalizeBotMatchOptions({ maxTurns: null }).maxTurns, null);
  assert.deepEqual(matchOutcome([
    { id: "left", toppedOut: false },
    { id: "right", toppedOut: false },
  ], 1_000_000, null), { complete: false, reason: null, winnerBotId: null });
});

test("top-out takes precedence and max turns produces a draw", () => {
  assert.deepEqual(matchOutcome([
    { id: "left", toppedOut: false },
    { id: "right", toppedOut: true },
  ], 7, 10), { complete: true, reason: "top-out", winnerBotId: "left" });
  assert.deepEqual(matchOutcome([
    { id: "left", toppedOut: false },
    { id: "right", toppedOut: false },
  ], 10, 10), { complete: true, reason: "max-turns", winnerBotId: null });
});

test("GUI CC2 search leaves headroom inside the requested real-time cadence", () => {
  assert.equal(realtimeCc2ThinkMs({ thinkMs: 250, stepFrames: 60 }), 250);
  assert.equal(realtimeCc2ThinkMs({ thinkMs: 900, stepFrames: 60, serialProposalCount: 2 }), 350);
  assert.equal(realtimeCc2ThinkMs({ thinkMs: 250, stepFrames: 15 }), 175);
  assert.equal(realtimeCc2ThinkMs({ thinkMs: 250, stepFrames: 3 }), 35);
});

test("think-time pace derives PPS from the configured search budget", () => {
  assert.equal(ppsForThinkTime(1_000), 1);
  assert.equal(ppsForThinkTime(200), 5);
  assert.equal(ppsForThinkTime(10), 20);
  assert.equal(ppsForThinkTime(10_000), 0.1);
});
