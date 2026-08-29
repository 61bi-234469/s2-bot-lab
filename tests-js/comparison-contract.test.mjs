import assert from "node:assert/strict";
import test from "node:test";

import { EVALUATION_SCORE_SEMANTICS, evaluatorModelIdentity } from "../src-js/evaluation.mjs";
import {
  SAME_POSITION_COMPARISON_CONTRACT,
  compareSimpleSamePositionCandidates,
  compareSimpleBotCandidates,
  compareSamePositionCandidates,
} from "../src-js/comparison-contract.mjs";

const FINGERPRINT = `s2-full-state/1:sha256:${"a".repeat(64)}`;

test("same-position comparison binds state, rules, evaluator, and score semantics", () => {
  const result = compareSamePositionCandidates(baseline(), challenger());
  assert.equal(result.contractId, SAME_POSITION_COMPARISON_CONTRACT);
  assert.equal(result.status, "degraded");
  assert.equal(result.scoreGap, 3.5);
  assert.equal(result.baseline.engineId, "raw-cc2");
  assert.equal(result.challenger.engineId, "s2-simulator-search");
  assert.deepEqual(result.degraded, ["rule-option-guard-only"]);
});

test("comparison fails closed on every identity boundary", () => {
  const cases = [
    ["position fingerprint", (value) => { value.positionFingerprint = `${FINGERPRINT}x`; }],
    ["ruleset", (value) => { value.rulesetId = "other-ruleset"; }],
    ["evaluator", (value) => { value.evaluator.weightsSha256 = `sha256:${"0".repeat(64)}`; }],
    ["score semantics", (value) => { value.scoreSemantics.origin = "zero-is-neutral"; }],
  ];
  for (const [reason, mutate] of cases) {
    const value = challenger();
    mutate(value);
    assert.throws(() => compareSamePositionCandidates(baseline(), value), new RegExp(reason));
  }
});

test("partial, empty, and cross-position scores are never compared", () => {
  const partial = challenger();
  partial.status = "partial";
  assert.throws(() => compareSamePositionCandidates(baseline(), partial), /not final/);

  const empty = challenger();
  empty.result.moves = [];
  assert.throws(() => compareSamePositionCandidates(baseline(), empty), /no authoritative best move/);

  const across = baseline();
  across.scoreSemantics = { ...across.scoreSemantics, comparability: "across-positions" };
  const matching = challenger();
  matching.scoreSemantics = structuredClone(across.scoreSemantics);
  assert.throws(() => compareSamePositionCandidates(across, matching), /not within-position/);
});

test("simple placement bot shares evaluation semantics without claiming reachability", () => {
  const simple = {
    bot: { id: "s2-final-placement-depth1-baseline/1" },
    positionFingerprint: FINGERPRINT,
    rulesetId: "s2-rules",
    evaluator: evaluatorModelIdentity(),
    scoreSemantics: structuredClone(EVALUATION_SCORE_SEMANTICS),
    moves: [{ placement: placement("O", 4), score: 4 }],
  };
  const result = compareSimpleSamePositionCandidates(baseline(), simple);
  assert.equal(result.scoreGap, 2.5);
  assert.equal(result.challenger.engineId, simple.bot.id);
  assert.ok(result.degraded.includes("movement-model-unavailable"));
});

test("the selected CC2 fork remains visible in comparison identity", () => {
  const fork = baseline();
  fork.engineId = "chouhy-cold-clear-2/b20a92b";
  fork.source = "chouhy-cc2-final-placement";
  const result = compareSimpleSamePositionCandidates(fork, {
    bot: { id: "s2-final-placement-depth1-baseline/1" },
    positionFingerprint: FINGERPRINT,
    rulesetId: "s2-rules",
    evaluator: evaluatorModelIdentity(),
    scoreSemantics: structuredClone(EVALUATION_SCORE_SEMANTICS),
    moves: [{ placement: placement("O", 4), score: 4 }],
  });
  assert.equal(result.baseline.engineId, "chouhy-cold-clear-2/b20a92b");
});

test("two simple bots are compared only under an explicit same-position identity", () => {
  const analysis = {
    bot: { id: "s2-final-placement-depth1-baseline/1" },
    evaluator: evaluatorModelIdentity(),
    scoreSemantics: structuredClone(EVALUATION_SCORE_SEMANTICS),
    moves: [{ placement: placement("O", 4), score: 4 }],
  };
  const right = structuredClone(analysis);
  right.bot.id = "another-placement-bot";
  right.moves[0].score = 3;
  const result = compareSimpleBotCandidates(analysis, right, {
    positionFingerprint: FINGERPRINT,
    rulesetId: "s2-rules",
  });
  assert.equal(result.scoreGap, -1);
  assert.equal(result.left.engineId, analysis.bot.id);
  assert.equal(result.right.engineId, right.bot.id);
  assert.deepEqual(result.degraded, ["movement-model-unavailable"]);
});

function baseline() {
  return {
    source: "raw-cc2",
    status: "degraded",
    reasons: ["rule-option-guard-only"],
    positionFingerprint: FINGERPRINT,
    rulesetId: "s2-rules",
    witness: placement("I", 0),
    evaluator: evaluatorModelIdentity(),
    scoreSemantics: structuredClone(EVALUATION_SCORE_SEMANTICS),
    score: 1.5,
  };
}

function challenger() {
  return {
    status: "final",
    resultKind: "degraded-input",
    degraded: ["rule-option-guard-only"],
    positionFingerprint: FINGERPRINT,
    rulesetId: "s2-rules",
    engineId: "s2-simulator-search",
    engineVersion: "0.1.0",
    evaluator: evaluatorModelIdentity(),
    scoreSemantics: structuredClone(EVALUATION_SCORE_SEMANTICS),
    result: { operation: "analyzeTopN", moves: [{ placement: placement("T", 2), score: 5 }] },
  };
}

function placement(piece, x) {
  return { piece, rotation: "spawn", x, y: 0, usedHold: false };
}
