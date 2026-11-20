// LOW PPS BOOST: the setting and where it applies.
import assert from "node:assert/strict";
import test from "node:test";
import { botParameterCapability, defaultBotParameters, fairComparisonBotParameters, normalizeBotParameters } from "../src-js/bot-parameters.mjs";
import { PRODUCT_LOW_PPS_BOOST, lowPpsBoostedParameters } from "../src-js/gui-input-match.mjs";

const champion = (input = {}) => normalizeBotParameters("cc2-s2-champion", { lowPpsBoostEnabled: true, ppsEnabled: true, pps: 3, ...input });

test("LOW PPS BOOST is a default-off setting of the current champion alone", () => {
  assert.equal(Object.hasOwn(defaultBotParameters("cc2-s2-champion"), "lowPpsBoostEnabled"), false);
  assert.equal(Object.hasOwn(normalizeBotParameters("cc2-s2-champion", { lowPpsBoostEnabled: false }), "lowPpsBoostEnabled"), false);
  assert.equal(normalizeBotParameters("cc2-s2-champion", { lowPpsBoostEnabled: true }).lowPpsBoostEnabled, true);
  assert.equal(Object.hasOwn(fairComparisonBotParameters("cc2-s2-champion", { lowPpsBoostEnabled: true }), "lowPpsBoostEnabled"), false);
  assert.ok(botParameterCapability("cc2-s2-champion").parameters.some((p) => p.key === "lowPpsBoostEnabled"));
  for (const other of ["cc2-raw", "cc2-chouhy"]) {
    assert.throws(() => normalizeBotParameters(other, { lowPpsBoostEnabled: true }), /unsupported .* parameter lowPpsBoostEnabled/);
  }
});

test("LOW PPS BOOST raises SELECTION LIMIT to 4,096 at PPS LIMIT 3 or below and nowhere else", () => {
  assert.deepEqual(PRODUCT_LOW_PPS_BOOST, { maxPps: 3, selections: 4096 });
  const off = normalizeBotParameters("cc2-s2-champion", { ppsEnabled: true, pps: 1 });
  assert.equal(lowPpsBoostedParameters(off), off);
  const played = (input, options) => lowPpsBoostedParameters(champion(input), options);
  for (const pps of [0.5, 1, 2, 3]) {
    const p = played({ pps });
    assert.equal(p.selectionLimit, 4096);
    assert.equal(Object.hasOwn(p, "lowPpsBoostEnabled"), false);
    // Apart from the budget, the side plays the parameters of a side without the setting.
    assert.deepEqual({ ...p, selectionLimit: 2048 }, normalizeBotParameters("cc2-s2-champion", { ppsEnabled: true, pps }));
  }
  const unchanged = [
    [{ pps: 3.1 }], [{ pps: 20 }], [{ ppsEnabled: false }], [{ selectionLimit: 4096 }], [{ selectionLimit: 8192 }],
    [{ selectionEnabled: false, thinkTimeEnabled: true }], [{ multithreadEnabled: true }], [{ freshIncomingEnabled: true }],
    [{ rgEnabled: true }], [{}, { turnMatch: true }],
  ];
  for (const [input, options] of unchanged) {
    const p = played(input, options), expected = { ...champion(input) };
    delete expected.lowPpsBoostEnabled;
    assert.deepEqual(p, expected, JSON.stringify(input));
  }
  assert.equal(played({ selectionLimit: 512 }).selectionLimit, 4096);
});
