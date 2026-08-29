import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  RULESET_IDS,
  S2_OBSERVED_MANIFEST,
  knownRulesetIds,
  resolvePlacementRules,
  rulesetOverrides,
} from "../src-js/ruleset-profiles.mjs";
import { createHash } from "node:crypto";
import { canonicalize } from "../scripts/cs1.mjs";
import {
  FOUNDATION_PLACEMENT_RULES,
  evaluatePlacement,
} from "../src-js/triangle/placement-adapter.mjs";

const surgeFixture = JSON.parse(
  readFileSync("fixtures/golden/placement-b2b-charging-surge.json", "utf8"),
);
const comboFixture = JSON.parse(
  readFileSync("fixtures/golden/placement-combo-multiplier-rounding.json", "utf8"),
);
const tankCapFixture = JSON.parse(
  readFileSync("fixtures/golden/placement-tank-cap-boundary.json", "utf8"),
);

test("an unknown ruleset id fails closed instead of falling back to a default profile", () => {
  assert.throws(
    () => resolvePlacementRules("tetrio-s2-v19-unknown-beta-1-5-0"),
    /unknown ruleset id/,
  );
  assert.deepEqual(knownRulesetIds(), Object.values(RULESET_IDS));
});

test("every profile differs from the foundation profile only where it declares an override", () => {
  const foundation = resolvePlacementRules(RULESET_IDS.foundation);
  assert.deepEqual(foundation, FOUNDATION_PLACEMENT_RULES);
  assert.deepEqual(rulesetOverrides(RULESET_IDS.foundation), {});

  for (const rulesetId of knownRulesetIds()) {
    const rules = resolvePlacementRules(rulesetId);
    const overrides = rulesetOverrides(rulesetId);

    assert.deepEqual(Object.keys(rules).sort(), Object.keys(foundation).sort(), rulesetId);
    for (const [key, value] of Object.entries(rules)) {
      if (key in overrides) {
        assert.deepEqual(value, overrides[key], `${rulesetId}: ${key}`);
        assert.notDeepEqual(value, foundation[key], `${rulesetId}: ${key} is not an override`);
      } else {
        assert.deepEqual(value, foundation[key], `${rulesetId}: ${key} drifted`);
      }
    }
  }
});

test("the declared overrides are the mechanisms the fixtures name", () => {
  assert.equal(resolvePlacementRules(RULESET_IDS.foundation).b2bCharging, false);
  assert.deepEqual(rulesetOverrides(RULESET_IDS.b2bCharging), {
    b2bCharging: { at: 4, base: 3 },
  });
  assert.deepEqual(rulesetOverrides(RULESET_IDS.comboMultiplier), {
    comboTable: "multiplier",
  });
  assert.deepEqual(rulesetOverrides(RULESET_IDS.tankCap2), {
    garbageCap: { base: 2, increase: 0, marginFrames: 0 },
  });
  assert.deepEqual(rulesetOverrides(RULESET_IDS.dynamicMultiplier), {
    garbageMultiplier: { base: 1, increase: 0.008, marginFrames: 10800 },
  });
  assert.deepEqual(rulesetOverrides(RULESET_IDS.roundingRng), {
    comboTable: "multiplier",
    rounding: "rng",
  });
  assert.deepEqual(rulesetOverrides(RULESET_IDS.messiness), {
    garbageMessiness: { change: 1, within: 0, nosame: true, timeout: 0, center: false },
  });
  assert.deepEqual(rulesetOverrides(RULESET_IDS.wideGarbageHole), {
    garbageHole: { size: 2, speed: 0 },
  });
  assert.deepEqual(rulesetOverrides(RULESET_IDS.openerPhase), { openerPhase: 12 });
  assert.deepEqual(rulesetOverrides(RULESET_IDS.engineFrameReachability), {
    movementAssumption: "engine-frame-with-hidden-spawn-buffer",
  });
});

test("the observed S2 profile has a full canonical identity and provisional semantics", () => {
  const digest = createHash("sha256")
    .update(canonicalize(S2_OBSERVED_MANIFEST.normalizedOptions))
    .digest("hex");
  assert.equal(S2_OBSERVED_MANIFEST.normalizedOptionsHash, `sha256:${digest}`);
  assert.equal(S2_OBSERVED_MANIFEST.canonicalIdentity, true);
  assert.match(S2_OBSERVED_MANIFEST.id, /^tetrio-s2-v19-[0-9a-f]{64}-beta-1-5-0$/);
  assert.deepEqual(S2_OBSERVED_MANIFEST.unresolvedRuleAffectingOptions, []);
  assert.equal(Object.keys(S2_OBSERVED_MANIFEST.normalizedOptions).length, 162);
  assert.deepEqual(
    {
      b2bextras: S2_OBSERVED_MANIFEST.normalizedOptions.b2bextras,
      allclear_charges: S2_OBSERVED_MANIFEST.normalizedOptions.allclear_charges,
      allclear_b2b_sends: S2_OBSERVED_MANIFEST.normalizedOptions.allclear_b2b_sends,
      allclear_b2b_dupes: S2_OBSERVED_MANIFEST.normalizedOptions.allclear_b2b_dupes,
    },
    {
      b2bextras: false,
      allclear_charges: false,
      allclear_b2b_sends: true,
      allclear_b2b_dupes: false,
    },
  );
  const registryKeys = [
    ...Object.keys(S2_OBSERVED_MANIFEST.normalizedOptions),
    ...Object.values(S2_OBSERVED_MANIFEST.optionRegistry.nonRuleAffecting).flat(),
  ].sort();
  assert.equal(registryKeys.length, 173);
  assert.equal(
    `sha256:${createHash("sha256").update(`${registryKeys.join("\n")}\n`).digest("hex")}`,
    S2_OBSERVED_MANIFEST.optionRegistry.keyNameSha256,
  );

  const rules = resolvePlacementRules(RULESET_IDS.s2Observed);
  assert.equal(rules.perfectClearGarbage, 5);
  assert.equal(rules.spinBonuses, "all-mini+");
  assert.equal(rules.comboTable, "multiplier");
  assert.equal(rules.b2bChaining, false);
  assert.deepEqual(rules.b2bCharging, { at: 4, base: 3 });
  assert.equal(rules.openerPhase, 14);
  assert.deepEqual(rules.garbageCap, { base: 8, increase: 0, marginFrames: 0 });
  assert.deepEqual(rules.garbageMultiplier, { base: 1, increase: 0.008, marginFrames: 10800 });
  assert.deepEqual(rules.garbageMessiness, {
    change: 1,
    within: 0,
    nosame: false,
    timeout: 0,
    center: false,
  });
  assert.deepEqual(rules.garbageHole, { size: 1, speed: 20 });
  assert.equal(rules.kickTable, "SRS+");
  assert.equal(rules.movementAssumption, "engine-frame-with-hidden-spawn-buffer");
  assert.deepEqual(S2_OBSERVED_MANIFEST.optionRegistry.semanticAdmission, {
    counts: {
      interpreted: 28,
      hardcodedCompatible: 3,
      valueInactiveOrOperationIrrelevant: 119,
      guardOnly: 12,
    },
    hardcodedCompatible: {
      allclears: true,
      allclear_b2b_sends: true,
      garbageblocking: "combo blocking",
    },
    guardOnly: [
      "boardbuffer", "boardheight", "boardwidth", "clutch", "g", "gincrease", "gmargin",
      "gravitymay20g", "infinite_movement", "lockresets", "locktime", "topoutisclear",
    ],
  });

  const options = S2_OBSERVED_MANIFEST.normalizedOptions;
  assert.deepEqual(
    {
      perfectClearGarbage: rules.perfectClearGarbage,
      perfectClearB2bBonus: rules.perfectClearB2bBonus,
      spinBonuses: rules.spinBonuses,
      comboTable: rules.comboTable,
      b2bChaining: rules.b2bChaining,
      b2bCharging: rules.b2bCharging,
      openerPhase: rules.openerPhase,
      garbageCap: rules.garbageCap,
      garbageMultiplier: rules.garbageMultiplier,
      garbageMessiness: rules.garbageMessiness,
      garbageHole: rules.garbageHole,
      kickTable: rules.kickTable,
      rounding: rules.rounding,
      specialBonus: rules.specialBonus,
      garbageTargetBonus: rules.garbageTargetBonus,
      garbageBombs: rules.garbageBombs,
      allow180: rules.allow180,
      movementAssumption: rules.movementAssumption,
    },
    {
      perfectClearGarbage: options.allclear_garbage,
      perfectClearB2bBonus: options.allclear_b2b,
      spinBonuses: options.spinbonuses,
      comboTable: options.combotable,
      b2bChaining: options.b2bchaining,
      b2bCharging: { at: options.b2bcharge_at, base: options.b2bcharge_base },
      openerPhase: options.openerphase,
      garbageCap: {
        base: options.garbagecap,
        increase: options.garbagecapincrease,
        marginFrames: options.garbagecapmargin,
      },
      garbageMultiplier: {
        base: options.garbagemultiplier,
        increase: options.garbageincrease,
        marginFrames: options.garbagemargin,
      },
      garbageMessiness: {
        change: options.messiness_change,
        within: options.messiness_inner,
        nosame: options.messiness_nosame,
        timeout: options.messiness_timeout,
        center: options.messiness_center,
      },
      garbageHole: { size: options.garbageholesize, speed: options.garbagespeed },
      kickTable: options.kickset,
      rounding: options.roundmode,
      specialBonus: options.garbagespecialbonus,
      garbageTargetBonus: options.garbagetargetbonus,
      garbageBombs: options.usebombs,
      allow180: options.allow180,
      movementAssumption: "engine-frame-with-hidden-spawn-buffer",
    },
  );
});

test("the same transition emits no Surge under the profile that disables charging", () => {
  const underCharging = evaluatePlacement(
    surgeFixture.input.state,
    surgeFixture.input.action.placement,
    resolvePlacementRules(surgeFixture.rulesetId),
  );
  const underFoundation = evaluatePlacement(
    surgeFixture.input.state,
    surgeFixture.input.action.placement,
    resolvePlacementRules(RULESET_IDS.foundation),
  );

  // Both profiles break the same B2B chain; only the charging profile converts
  // the broken chain into outgoing garbage. Resolving rules from the fixture id
  // is therefore observable, not cosmetic.
  assert.deepEqual(underCharging.chain, underFoundation.chain);
  assert.deepEqual(underCharging.attackStages.surgeChunks, [2, 2, 1]);
  assert.deepEqual(underFoundation.attackStages.surgeChunks, []);
  assert.equal(underFoundation.attackStages.outgoingBeforeCancel, 0);
  assert.equal(underFoundation.cancelResult.cancelled, 0);
  assert.deepEqual(
    underFoundation.cancelResult.remainingIncoming.map((packet) => packet.amount),
    [1, 3],
  );
});

test("the combo multiplier is what makes the rounding mode observable", () => {
  const underMultiplier = evaluatePlacement(
    comboFixture.input.state,
    comboFixture.input.action.placement,
    resolvePlacementRules(comboFixture.rulesetId),
  );
  const underFoundation = evaluatePlacement(
    comboFixture.input.state,
    comboFixture.input.action.placement,
    resolvePlacementRules(RULESET_IDS.foundation),
  );

  // The Foundation combo table contributes nothing, so raw attack stays an
  // integer and rounding is a no-op. Only the multiplier table produces a
  // fractional value for `rounding: "down"` to act on.
  assert.equal(underMultiplier.attackStages.raw, 1.75);
  assert.equal(underMultiplier.attackStages.afterRounding, 1);
  assert.equal(underFoundation.attackStages.raw, 1);
  assert.equal(underFoundation.attackStages.afterRounding, 1);
  assert.deepEqual(underMultiplier.chain, underFoundation.chain);
});

test("the tank cap bounds how much a single placement can take", () => {
  const underCap = evaluatePlacement(
    tankCapFixture.input.state,
    tankCapFixture.input.action.placement,
    resolvePlacementRules(tankCapFixture.rulesetId),
  );
  const underFoundation = evaluatePlacement(
    tankCapFixture.input.state,
    tankCapFixture.input.action.placement,
    resolvePlacementRules(RULESET_IDS.foundation),
  );

  // Same incoming queue, same placement: the cap decides how many rows the
  // board takes now and how many stay owed.
  assert.equal(underCap.tankResult.inserted.length, 2);
  assert.deepEqual(
    underCap.tankResult.deferred.map((packet) => packet.amount),
    [2],
  );
  assert.equal(underCap.nextState.garbage.capState.consumedThisTick, 2);

  assert.equal(underFoundation.tankResult.inserted.length, 4);
  assert.deepEqual(underFoundation.tankResult.deferred, []);
  assert.equal(underFoundation.nextState.garbage.capState.consumedThisTick, 4);
});
