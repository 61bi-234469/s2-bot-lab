import assert from "node:assert/strict";
import test from "node:test";

import {
  DEPTH_ONE_MOVEMENT_CAPABILITY,
  HEADLESS_ARENA_RUNTIME_CAPABILITY,
  evaluateRulesetAdmission,
  evaluateHeadlessArenaRulesetAdmission,
  RULESET_ADMISSION_CLASSES,
} from "../src-js/ruleset-admission.mjs";
import S2_OBSERVED_MANIFEST from "../rulesets/tetrio-s2-v19-beta-1-5-0-observed.json" with { type: "json" };

function manifest() {
  return structuredClone(S2_OBSERVED_MANIFEST);
}

test("the executable semantic catalog is disjoint and covers all 162 options", () => {
  const classes = RULESET_ADMISSION_CLASSES;
  const keys = [
    ...classes.interpreted,
    ...Object.keys(classes.hardcodedCompatible),
    ...classes.valueInactiveOrOperationIrrelevant,
    ...classes.guardOnly.movement,
    ...classes.guardOnly.transition,
  ];
  assert.deepEqual(classes.counts, {
    interpreted: 28,
    hardcodedCompatible: 3,
    valueInactiveOrOperationIrrelevant: 119,
    guardOnly: 12,
  });
  assert.equal(keys.length, 162);
  assert.equal(new Set(keys).size, 162);
  assert.deepEqual(
    [...keys].sort(),
    Object.keys(S2_OBSERVED_MANIFEST.normalizedOptions).sort(),
  );
});

test("analysis operations distinguish movement and transition guards", () => {
  for (const operation of [
    "analyzeBest",
    "analyzeTopN",
    "analyzeSequence",
    "evaluatePlayedMove",
  ]) {
    const result = evaluateRulesetAdmission(manifest(), operation);
    assert.equal(result.valid, true);
    assert.equal(result.admitted, false);
    assert.equal(result.status, "unsupported");
    assert.deepEqual(result.degraded, [
      "movement-model-unavailable",
      "rule-option-guard-only",
    ]);
    assert.deepEqual(result.unsupportedOptions.movement, [
      "g", "gincrease", "gmargin", "gravitymay20g", "infinite_movement", "lockresets", "locktime",
    ]);
    assert.deepEqual(result.unsupportedOptions.transition, [
      "boardbuffer", "boardheight", "boardwidth", "clutch", "topoutisclear",
    ]);
    assert.deepEqual(result.issues, []);
  }
});

test("evaluatePosition excludes movement-only guards but keeps transition guards", () => {
  const result = evaluateRulesetAdmission(manifest(), "evaluatePosition");
  assert.equal(result.valid, true);
  assert.equal(result.admitted, false);
  assert.deepEqual(result.degraded, ["rule-option-guard-only"]);
  assert.deepEqual(result.unsupportedOptions.movement, []);
  assert.deepEqual(result.unsupportedOptions.transition, [
    "boardbuffer", "boardheight", "boardwidth", "clutch", "topoutisclear",
  ]);
});

test("the explicit depth-one controller capability admits only single-position ranking movement", () => {
  const capability = {
    movementModel: DEPTH_ONE_MOVEMENT_CAPABILITY,
    maxDepth: 1,
  };
  for (const operation of ["analyzeBest", "analyzeTopN", "evaluatePlayedMove"]) {
    const result = evaluateRulesetAdmission(manifest(), operation, capability);
    assert.equal(result.valid, true);
    assert.deepEqual(result.unsupportedOptions.movement, [], operation);
    assert.deepEqual(result.degraded, ["rule-option-guard-only"], operation);
  }

  const sequence = evaluateRulesetAdmission(manifest(), "analyzeSequence", capability);
  assert.deepEqual(sequence.degraded, [
    "movement-model-unavailable",
    "rule-option-guard-only",
  ]);
  assert.deepEqual(sequence.unsupportedOptions.movement, [
    "g", "gincrease", "gmargin", "gravitymay20g", "infinite_movement", "lockresets", "locktime",
  ]);
});

test("the exact-lock headless arena narrowly binds every guard-only option", () => {
  const admitted = evaluateHeadlessArenaRulesetAdmission(manifest(), HEADLESS_ARENA_RUNTIME_CAPABILITY);
  assert.equal(admitted.valid, true);
  assert.equal(admitted.admitted, true);
  assert.deepEqual(admitted.degraded, []);
  assert.deepEqual(
    Object.values(admitted.guardBindings).flat().sort(),
    [...RULESET_ADMISSION_CLASSES.guardOnly.movement,
      ...RULESET_ADMISSION_CLASSES.guardOnly.transition].sort(),
  );

  for (const capability of [null, { ...HEADLESS_ARENA_RUNTIME_CAPABILITY }]) {
    const rejected = evaluateHeadlessArenaRulesetAdmission(manifest(), capability);
    assert.equal(rejected.admitted, false);
    assert.deepEqual(rejected.degraded, ["rule-option-guard-only"]);
  }

  const changed = manifest();
  changed.normalizedOptions.clutch = false;
  assert.equal(evaluateHeadlessArenaRulesetAdmission(changed, HEADLESS_ARENA_RUNTIME_CAPABILITY).admitted, false);

  for (const [option, value] of [["topoutisclear", true], ["nolockout", false]]) {
    const mutated = manifest();
    mutated.normalizedOptions[option] = value;
    assert.equal(
      evaluateHeadlessArenaRulesetAdmission(mutated, HEADLESS_ARENA_RUNTIME_CAPABILITY).admitted,
      false,
    );
  }
});

test("missing, unknown, and depth-greater-than-one capabilities retain movement guards", () => {
  const cases = [
    null,
    { movementModel: "unknown-controller", maxDepth: 1 },
    { movementModel: DEPTH_ONE_MOVEMENT_CAPABILITY, maxDepth: 2 },
  ];
  for (const capability of cases) {
    const result = evaluateRulesetAdmission(manifest(), "analyzeBest", capability);
    assert.deepEqual(result.degraded, [
      "movement-model-unavailable",
      "rule-option-guard-only",
    ]);
    assert.equal(result.unsupportedOptions.movement.length, 7);
  }
});

test("unknown, missing, and wrong-typed normalized options fail closed", () => {
  const unknown = manifest();
  unknown.normalizedOptions.future_rule = true;
  assert.deepEqual(
    evaluateRulesetAdmission(unknown, "analyzeBest").issues.map(({ code }) => code),
    ["ruleset-identity-mismatch", "unknown-option"],
  );

  const missing = manifest();
  delete missing.normalizedOptions.boardwidth;
  assert.deepEqual(
    evaluateRulesetAdmission(missing, "analyzeBest").issues.map(({ code }) => code),
    ["ruleset-identity-mismatch", "missing-option"],
  );

  const wrongType = manifest();
  wrongType.normalizedOptions.boardwidth = "10";
  const result = evaluateRulesetAdmission(wrongType, "analyzeBest");
  assert.equal(result.valid, false);
  assert.equal(result.admitted, false);
  assert.deepEqual(result.degraded, ["rule-option-guard-only"]);
  assert.deepEqual(result.issues.map(({ code }) => code), [
    "ruleset-identity-mismatch",
    "option-type-mismatch",
  ]);
});

test("unexpected hardcoded, inactive, guard, and interpreted values fail by class", () => {
  const cases = [
    ["allclears", false, "hardcoded-value-mismatch"],
    ["zenith", true, "inactive-predicate-false"],
    ["locktime", 31, "unaccepted-guard-value"],
    ["allclear_garbage", 6, "interpreted-value-mismatch"],
  ];
  for (const [key, value, code] of cases) {
    const candidate = manifest();
    candidate.normalizedOptions[key] = value;
    const result = evaluateRulesetAdmission(candidate, "analyzeBest");
    assert.equal(result.valid, false, key);
    assert.deepEqual(result.issues.map(({ code: actual }) => actual), [
      "ruleset-identity-mismatch",
      code,
    ], key);
  }
});

test("the manifest cannot weaken the executable semantic catalog", () => {
  const count = manifest();
  count.optionRegistry.semanticAdmission.counts.guardOnly = 0;
  assert.equal(
    evaluateRulesetAdmission(count, "analyzeBest").issues[0].code,
    "semantic-count-mismatch",
  );

  const hardcoded = manifest();
  hardcoded.optionRegistry.semanticAdmission.hardcodedCompatible.allclears = false;
  assert.equal(
    evaluateRulesetAdmission(hardcoded, "analyzeBest").issues[0].code,
    "hardcoded-declaration-mismatch",
  );

  const guards = manifest();
  guards.optionRegistry.semanticAdmission.guardOnly = ["clutch"];
  assert.equal(
    evaluateRulesetAdmission(guards, "analyzeBest").issues[0].code,
    "guard-declaration-mismatch",
  );
});

test("the admitted target identity is fixed independently of the manifest declaration", () => {
  const candidate = manifest();
  candidate.normalizedOptionsHash = `sha256:${"0".repeat(64)}`;
  assert.equal(
    evaluateRulesetAdmission(candidate, "analyzeBest").issues[0].code,
    "ruleset-identity-mismatch",
  );
});

test("an unknown operation and malformed manifests fail closed without throwing", () => {
  const unknown = evaluateRulesetAdmission(manifest(), "futureOperation");
  assert.equal(unknown.valid, false);
  assert.deepEqual(unknown.degraded, ["rule-option-guard-only"]);
  assert.equal(unknown.issues[0].code, "unknown-operation");

  const malformed = evaluateRulesetAdmission(null, "analyzeBest");
  assert.equal(malformed.valid, false);
  assert.deepEqual(malformed.degraded, ["rule-option-guard-only"]);
  assert.equal(malformed.issues[0].code, "invalid-manifest");
});
