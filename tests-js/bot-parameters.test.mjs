import assert from "node:assert/strict";
import test from "node:test";

import {
  botParameterCapability,
  defaultBotParameters,
} from "../src-js/bot-parameters.mjs";

test("the current development champion has the standard CC2 parameters", () => {
  assert.deepEqual(defaultBotParameters("cc2-s2-champion"), {
    pps: 1,
    thinkMs: 250,
    queueDepth: 14,
  });
  assert.match(botParameterCapability("cc2-s2-champion").description, /release-qualified/);
});
