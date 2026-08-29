import assert from "node:assert/strict";
import test from "node:test";

import { calculatePlayerMetrics, formatGameClock } from "../cc2-gui/player-metrics.mjs";

test("live metrics follow the replay and TetraStats-derived formulas", () => {
  const metrics = calculatePlayerMetrics({
    pieces: 2,
    attack: 6,
    garbageCleared: 2,
    elapsedFrames: 120,
  });

  assert.equal(metrics.seconds, 2);
  assert.equal(metrics.pps, 1);
  assert.equal(metrics.apm, 180);
  assert.equal(metrics.vs, 400);
  assert.equal(metrics.app, 3);
  assert.equal(metrics.dsSecond, 1);
  assert.equal(metrics.dsPiece, 1);
  assert.equal(metrics.vsApm, 400 / 180);
  assert.equal(metrics.garbageEfficiency, 6);
  assert.equal(metrics.appDsPiece, 4);
  assert.equal(metrics.area, 180 + 45 + 400 * 0.444 + 3 * 185 + 175 + 450 + 6 * 315);
  for (const key of ["cheeseIndex", "weightedApp", "estTr", "opener", "plonk", "stride", "infDs"]) {
    assert.equal(Number.isFinite(metrics[key]), true, key);
  }
});

test("zero attack keeps displayable metrics finite and marks ratio-derived metrics unavailable", () => {
  const metrics = calculatePlayerMetrics({
    pieces: 1,
    attack: 0,
    garbageCleared: 0,
    elapsedFrames: 60,
  });
  assert.deepEqual(
    [metrics.apm, metrics.pps, metrics.vs, metrics.app, metrics.dsSecond, metrics.dsPiece, metrics.area],
    [0, 1, 0, 0, 0, 0, 45],
  );
  assert.equal(metrics.vsApm, null);
  assert.equal(metrics.estTr, null);
  assert.equal(metrics.opener, null);
});

test("PPS follows variable active elapsed time instead of assuming one second per piece", () => {
  const metrics = calculatePlayerMetrics({
    pieces: 3,
    attack: 0,
    garbageCleared: 0,
    elapsedFrames: 90,
  });

  assert.equal(metrics.seconds, 1.5);
  assert.equal(metrics.pps, 2);
});

test("game clock formats active seconds with millisecond precision", () => {
  assert.equal(formatGameClock(0), "00:00.000");
  assert.equal(formatGameClock(61.2345), "01:01.235");
  assert.equal(formatGameClock(59.9996), "01:00.000");
  assert.equal(formatGameClock(Number.NaN), "—");
});
