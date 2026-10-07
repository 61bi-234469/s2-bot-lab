import assert from "node:assert/strict";
import test from "node:test";

import {
  BOT_DEFAULTS_REVISION,
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

test("saved champion ENGINE values and its former Analysis preference are silently dropped", () => {
  assert.equal(CONTROL_PREFERENCE_IDS.includes("analysis-engine-profile"), false);
  for (const engineProfile of ["f14-public", "gated-leaf-conversion"]) {
    const preferences = sanitizePreferences({
      controls: { "analysis-engine-profile": engineProfile },
      botParameters: { left: { "cc2-s2-champion": { engineProfile } } },
    }, normalizeBotParameters);
    assert.equal(Object.hasOwn(preferences.controls, "analysis-engine-profile"), false);
    assert.deepEqual(preferences.botParameters.left["cc2-s2-champion"], defaultBotParameters("cc2-s2-champion"));
  }
});

test("a document from an older defaults revision drops the champion's stored SELECTION limit only", () => {
  const champion = defaultBotParameters("cc2-s2-champion");
  assert.equal(champion.selectionLimit, 2048);
  const stored = {
    botParameters: {
      left: { "cc2-s2-champion": { ...champion, selectionLimit: 512, queueDepth: 7 }, "cc2-chouhy": { ...defaultBotParameters("cc2-chouhy"), selectionLimit: 512 } },
      right: { "cc2-s2-champion": { ...champion, selectionLimit: 640 } },
    },
  };
  const migrated = sanitizePreferences(stored, normalizeBotParameters);
  assert.deepEqual(migrated.botParameters.left["cc2-s2-champion"], { ...champion, queueDepth: 7 });
  assert.deepEqual(migrated.botParameters.right["cc2-s2-champion"], champion);
  assert.equal(migrated.botParameters.left["cc2-chouhy"].selectionLimit, 512);
  const current = sanitizePreferences({ ...stored, botDefaultsRevision: BOT_DEFAULTS_REVISION }, normalizeBotParameters);
  assert.equal(current.botParameters.left["cc2-s2-champion"].selectionLimit, 512);
  assert.equal(current.botParameters.right["cc2-s2-champion"].selectionLimit, 640);
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

test("the 1P match-rule controls keep their preference ids", () => {
  const stored = sanitizePreferences({
    controls: { "match-turn-order": "human-first", "match-stall-lock-pps": "2.5", "match-stall-lock-penalty": "forced-lock" },
    toggles: { "match-handicap-garbage": true, "match-stall-lock": true, "match-turn-match": true },
  }, normalizeBotParameters);
  assert.deepEqual(stored.controls, {
    "match-turn-order": "human-first", "match-stall-lock-pps": "2.5", "match-stall-lock-penalty": "forced-lock",
  });
  assert.deepEqual(stored.toggles, { "match-handicap-garbage": true, "match-stall-lock": true, "match-turn-match": true });
  const foreign = sanitizePreferences({ toggles: { "match-handicap-garbage": "28" } }, normalizeBotParameters);
  assert.equal("match-handicap-garbage" in foreign.toggles, false);
});
