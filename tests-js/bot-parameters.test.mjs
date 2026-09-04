import assert from "node:assert/strict";
import test from "node:test";

import {
  botParameterCapability,
  defaultBotParameters,
  fairComparisonBotParameters,
  normalizeBotParameters,
} from "../src-js/bot-parameters.mjs";

test("the current development champion has configurable CC2 search budgets", () => {
  assert.deepEqual(defaultBotParameters("cc2-s2-champion"), {
    ppsEnabled: true, pps: 1, selectionEnabled: true, selectionLimit: 512,
    thinkTimeEnabled: false, thinkMs: 250, queueDepth: 14,
  });
  assert.throws(() => normalizeBotParameters("cc2-s2-champion", { selectionEnabled: false, thinkTimeEnabled: false }), /cannot both be disabled/);
  assert.match(botParameterCapability("cc2-s2-champion").description, /release-qualified/);
});

test("CC2 PPS pacing can be disabled independently of either search limit", () => {
  assert.equal(normalizeBotParameters("cc2-raw", {
    ppsEnabled: false, selectionEnabled: true, thinkTimeEnabled: false,
  }).ppsEnabled, false);
  assert.equal(normalizeBotParameters("cc2-raw", {
    ppsEnabled: false, selectionEnabled: false, thinkTimeEnabled: true,
  }).ppsEnabled, false);
});

test("FAIR applies a temporary deterministic CC2 preset", () => {
  assert.deepEqual(fairComparisonBotParameters("cc2-raw", {
    ppsEnabled: true,
    pps: 7,
    selectionEnabled: false,
    selectionLimit: 999,
    thinkTimeEnabled: false,
    thinkMs: 900,
  }), {
    ppsEnabled: false,
    pps: 7,
    selectionEnabled: true,
    selectionLimit: 512,
    thinkTimeEnabled: false,
    thinkMs: 900,
    queueDepth: 14,
  });
});
