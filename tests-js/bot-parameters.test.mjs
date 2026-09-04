import assert from "node:assert/strict";
import test from "node:test";

import {
  botParameterCapability,
  defaultBotParameters,
  normalizeBotParameters,
} from "../src-js/bot-parameters.mjs";

test("the current development champion has configurable CC2 search budgets", () => {
  assert.deepEqual(defaultBotParameters("cc2-s2-champion"), {
    pps: 1, selectionEnabled: true, selectionLimit: 512,
    thinkTimeEnabled: false, thinkMs: 250, queueDepth: 14,
  });
  assert.throws(() => normalizeBotParameters("cc2-s2-champion", { selectionEnabled: false, thinkTimeEnabled: false }), /cannot both be disabled/);
  assert.match(botParameterCapability("cc2-s2-champion").description, /release-qualified/);
});
