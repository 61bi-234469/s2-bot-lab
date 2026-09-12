import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTROL_PREFERENCE_IDS,
  GUI_MODES,
  PREFERENCE_SIDES,
  TOGGLE_PREFERENCE_IDS,
  emptyPreferences,
  sanitizePreferences,
} from "../cc2-gui/preferences.mjs";
import { defaultBotParameters, normalizeBotParameters } from "../src-js/bot-parameters.mjs";

test("stored preferences round-trip through sanitization", () => {
  const stored = {
    mode: "match",
    controls: { "analysis-bot": "cc2-chouhy", "think-ms": "900", "left-bot": "s2-simple", "match-seed": "42" },
    toggles: { "match-fair-comparison": true, "match-think-time-pace": false, "match-pre-lock-preview": true, "match-ttrm-compatible": true, "match-unlimited-turns": false, "match-random-seed": true },
    botParameters: { left: { "cc2-raw": { pps: 2.5, thinkMs: 800, queueDepth: 7 } } },
  };
  assert.deepEqual(sanitizePreferences(stored, normalizeBotParameters), {
    mode: "match",
    controls: { "analysis-bot": "cc2-chouhy", "think-ms": "900", "left-bot": "s2-simple", "match-seed": "42" },
    toggles: { "match-fair-comparison": true, "match-pre-lock-preview": true, "match-ttrm-compatible": true, "match-unlimited-turns": false, "match-random-seed": true },
    botParameters: { left: { "cc2-raw": { ...defaultBotParameters("cc2-raw"), pps: 2.5, thinkMs: 800, queueDepth: 7 } }, right: {} },
    humanControls: null,
  });
});

test("an unreadable or foreign document leaves every control on its default", () => {
  for (const input of [null, undefined, 7, "match", [], { controls: [], toggles: null, botParameters: 3 }]) {
    assert.deepEqual(sanitizePreferences(input, normalizeBotParameters), emptyPreferences());
  }
});

test("values this build no longer recognises are dropped rather than applied", () => {
  const preferences = sanitizePreferences({
    mode: "tournament",
    controls: { "think-ms": 900, "match-seed": "", "left-bot": "cc2-raw", "match-tempo": "fast" },
    toggles: { "match-unlimited-turns": "yes" },
    botParameters: {
      left: { "cc2-raw": { pps: 99 }, "cold-clear-3": { pps: 1 } },
      right: { "s2-simple": { allowHold: false } },
      middle: { "cc2-raw": { pps: 1 } },
    },
  }, normalizeBotParameters);
  assert.deepEqual(preferences, {
    mode: null,
    controls: { "left-bot": "cc2-raw" },
    toggles: {},
    botParameters: { left: {}, right: { "s2-simple": { pps: 1, allowHold: false } } },
    humanControls: null,
  });
});

test("a saved frame-based STALL LOCK value is not reinterpreted as PPS", () => {
  const preferences = sanitizePreferences({
    controls: { "match-stall-lock-frames": "60", "match-stall-lock-pps": "2.5" },
  }, normalizeBotParameters);
  assert.deepEqual(preferences.controls, { "match-stall-lock-pps": "2.5" });
});

test("the 1P input settings are sanitized by the module that owns them", () => {
  const seen = [];
  const sanitize = (input) => {
    seen.push(input);
    return { handling: { dasFrames: 10 }, keys: { HardDrop: "Space" } };
  };
  const preferences = sanitizePreferences(
    { humanControls: { handling: { dasFrames: 4 } } },
    normalizeBotParameters,
    sanitize,
  );
  assert.deepEqual(seen, [{ handling: { dasFrames: 4 } }]);
  assert.deepEqual(preferences.humanControls, { handling: { dasFrames: 10 }, keys: { HardDrop: "Space" } });
  // A document with no settings at all still asks for the current defaults.
  assert.deepEqual(sanitizePreferences(null, normalizeBotParameters, sanitize).humanControls.keys, { HardDrop: "Space" });
});

test("a stored parameter set is completed from the current defaults", () => {
  const preferences = sanitizePreferences({
    botParameters: { left: { "cc2-chouhy": { thinkMs: 800 } } },
  }, normalizeBotParameters);
  assert.deepEqual(preferences.botParameters.left["cc2-chouhy"], { ...defaultBotParameters("cc2-chouhy"), thinkMs: 800 });
});

test("the persisted schema covers every mode, both sides and no duplicate control", () => {
  assert.deepEqual(GUI_MODES, ["analysis", "match", "replay"]);
  assert.deepEqual(PREFERENCE_SIDES, ["left", "right"]);
  const ids = [...CONTROL_PREFERENCE_IDS, ...TOGGLE_PREFERENCE_IDS];
  assert.equal(new Set(ids).size, ids.length);
});
