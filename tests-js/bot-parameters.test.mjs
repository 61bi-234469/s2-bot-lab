import assert from "node:assert/strict";
import test from "node:test";

import {
  botParameterCapability,
  defaultBotParameters,
  fairComparisonBotParameters,
  normalizeBotParameters,
} from "../src-js/bot-parameters.mjs";

test("bot parameters have independent defaults and normalize supported values", () => {
  const defaults = { ppsEnabled: true, pps: 1, selectionEnabled: true, selectionLimit: 512, thinkTimeEnabled: false, thinkMs: 250, queueDepth: 14 };
  for (const type of ["cc2-raw", "cc2-chouhy", "cc2-s2-f14"]) {
    assert.deepEqual(defaultBotParameters(type), defaults);
  }
  assert.deepEqual(normalizeBotParameters("cc2-raw", { ppsEnabled: false, pps: 2.5, selectionEnabled: false, thinkTimeEnabled: true, thinkMs: 800, queueDepth: 7 }), {
    ppsEnabled: false,
    pps: 2.5,
    selectionEnabled: false,
    selectionLimit: 512,
    thinkTimeEnabled: true,
    thinkMs: 800,
    queueDepth: 7,
  });
  assert.deepEqual(normalizeBotParameters("s2-simple", { allowHold: false }), { pps: 1, allowHold: false });
});

test("the champion exposes no engine selector and keeps its budget defaults", () => {
  const defaults = { ppsEnabled: true, pps: 1, selectionEnabled: true, selectionLimit: 512, thinkTimeEnabled: false, thinkMs: 250, queueDepth: 14 };
  const legacySavedSet = { ppsEnabled: false, pps: 2, selectionEnabled: true, selectionLimit: 640,
    thinkTimeEnabled: false, thinkMs: 250, queueDepth: 12 };

  const roundTrips = [
    ["defaults", defaultBotParameters("cc2-s2-champion"), defaults],
    ["empty input", normalizeBotParameters("cc2-s2-champion", {}), defaults],
    ["legacy saved set", normalizeBotParameters("cc2-s2-champion", legacySavedSet), legacySavedSet],
  ];
  for (const [label, actual, expected] of roundTrips) {
    assert.deepEqual(actual, expected, label);
    assert.equal(JSON.stringify(actual), JSON.stringify(expected), `${label} serialization`);
  }
  assert.equal(botParameterCapability("cc2-s2-champion").parameters.some((parameter) => parameter.key === "engineProfile"), false);
});

test("a human player declares no server-side parameters at all", () => {
  // Handling and key bindings only change how the browser turns key presses
  // into movement, and a player's rate is what they actually play at, so there
  // is nothing here for the match API to validate or to fix in advance.
  assert.deepEqual(defaultBotParameters("human"), {});
  assert.deepEqual(normalizeBotParameters("human", {}), {});
  assert.deepEqual(botParameterCapability("human").parameters, []);
  assert.throws(() => normalizeBotParameters("human", { pps: 2 }), /unsupported human parameter pps/);
});

test("bot parameters reject invalid and unknown input", () => {
  assert.throws(() => normalizeBotParameters("cc2-chouhy", { thinkMs: 9 }), /thinkMs/);
  assert.throws(() => normalizeBotParameters("cc2-chouhy", { selectionLimit: 0 }), /selectionLimit/);
  assert.throws(() => normalizeBotParameters("cc2-chouhy", { selectionEnabled: false, thinkTimeEnabled: false }), /cannot both be disabled/);
  assert.throws(() => normalizeBotParameters("cc2-raw", { queueDepth: 29 }), /queueDepth/);
  // Bots the GUI no longer offers have no parameter definition either.
  for (const type of ["cc2-s2", "cc2-s2-gen017", "cc2-s2-native", "cc2-s2-integrated", "cc2-s2-f14-native-a"]) {
    assert.throws(() => normalizeBotParameters(type, {}), /unsupported bot type/);
  }
  assert.throws(() => normalizeBotParameters("s2-simple", { allowHold: "yes" }), /boolean/);
  assert.throws(() => normalizeBotParameters("cc2-raw", { pps: 20.1 }), /pps/);
  assert.throws(() => normalizeBotParameters("cc2-chouhy", { strength: 10 }), /unsupported/);
});

test("CC2 PPS pacing can be disabled independently of either search limit", () => {
  assert.equal(normalizeBotParameters("cc2-raw", {
    ppsEnabled: false,
    selectionEnabled: true,
    thinkTimeEnabled: false,
  }).ppsEnabled, false);
  assert.equal(normalizeBotParameters("cc2-raw", {
    ppsEnabled: false,
    selectionEnabled: false,
    thinkTimeEnabled: true,
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
  assert.deepEqual(fairComparisonBotParameters("s2-simple", { pps: 2, allowHold: false }), {
    pps: 2,
    allowHold: false,
  });
});

test("capabilities are safe to serialize for the GUI", () => {
  const capability = botParameterCapability("cc2-raw");
  capability.parameters[0].label = "changed";
  assert.equal(botParameterCapability("cc2-raw").parameters[0].label, "PPS");
  assert.match(botParameterCapability("cc2-raw").description, /純テトリス/);
  assert.match(botParameterCapability("cc2-chouhy").description, /chouhy/);
  assert.match(botParameterCapability("cc2-chouhy").description, /S2向け/);
  assert.match(botParameterCapability("cc2-s2-f14").description, /F14/);
  assert.match(botParameterCapability("cc2-s2-champion").description, /champion/);
  assert.match(botParameterCapability("cc2-s2-champion").description, /gated leaf-conversion/);
  assert.match(botParameterCapability("cc2-s2-champion").description, /kappa=0\.1164/);
  assert.match(botParameterCapability("cc2-s2-champion-previous").description, /kappa=0\.25/);
  assert.match(botParameterCapability("cc2-s2-champion").description, /H=8/);
  assert.match(botParameterCapability("cc2-s2-champion").description, /CC2 順（rerank なし）/);
  // The champion is a development build. Its description is the only place the
  // GUI says so, and the public tree asserts the same token.
  assert.match(botParameterCapability("cc2-s2-champion").description, /release-qualified/);
});
