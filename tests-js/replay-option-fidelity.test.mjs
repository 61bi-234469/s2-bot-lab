import assert from "node:assert/strict";
import test from "node:test";

import { buildEngineConfig } from "../src-js/replay/engine-config.mjs";
import { TtrmError } from "../src-js/replay/ttrm-parser.mjs";
import { DEFAULT_TTRM_OPTIONS, resolveTtrmOptions } from "../src-js/replay/ttrm-options.mjs";

function replayOptions(options = {}) {
  return { options, events: [] };
}

test("replay engine config carries B2B charge threshold and lock time", () => {
  const config = buildEngineConfig({
    ...DEFAULT_TTRM_OPTIONS,
    b2bcharging: true,
    b2bcharge_at: 7,
    b2bcharge_base: 5,
    locktime: 42,
  }, []);

  assert.deepEqual(config.b2b.charging, { at: 7, base: 5 });
  assert.equal(config.misc.movement.lockTime, 42);
});

test("replay option validation leaves ordinary metadata and supported values alone", () => {
  const { options } = resolveTtrmOptions(replayOptions({
    username: "player",
    minoskin: { t: "custom" },
    custom_metadata: true,
    b2bcharge_at: 7,
    locktime: 42,
  }));

  assert.equal(options.username, "player");
  assert.deepEqual(options.minoskin, { t: "custom" });
  assert.equal(options.custom_metadata, true);
  assert.equal(options.b2bcharge_at, 7);
  assert.equal(options.locktime, 42);
});

test("replay option validation refuses unsupported non-default semantic values", () => {
  const unsupported = [
    ["allclears", false],
    ["allclear_b2b_sends", false],
    ["allclear_b2b_dupes", true],
    ["allclear_charges", true],
    ["b2bextras", true],
    ["are", 1],
    ["lineclear_are", 1],
  ];

  for (const [key, value] of unsupported) {
    assert.throws(
      () => resolveTtrmOptions(replayOptions({ [key]: value })),
      (error) => error instanceof TtrmError && error.stage === "validate" && error.message.includes(key),
      key,
    );
  }
});

test("an end-only garbage multiplier is the ramped end state; the round starts at its base", () => {
  // TETR.IO grows the multiplier by garbageincrease / 60 per frame after
  // garbagemargin; a 14,819-frame round ends at 1 + 0.008 / 60 * 4,019.
  const ended = (frame, garbagemultiplier, options = {}) => resolveTtrmOptions({ options, frames: frame,
    events: [{ frame, type: "end", data: { options: { garbagemultiplier } } }] }).options.garbagemultiplier;
  assert.equal(ended(14819, 1.5358666666666076), 1);
  assert.equal(ended(9000, 1), 1, "a round inside the margin ends at its base");
  assert.equal(ended(14819, 2.5358666666666076), 2, "a non-default base is recovered too");
  assert.equal(ended(14819, 1.5358666666666076, { garbagemultiplier: 1.25 }), 1.25, "a recorded replay option still wins");
});
