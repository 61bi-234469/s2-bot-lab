import { canonicalize } from "./cs1-core.mjs";

export const SAME_POSITION_COMPARISON_CONTRACT = "s2-same-position-comparison/1";

export function compareSamePositionCandidates(baseline, challengerResponse) {
  assertBaseline(baseline);
  assertChallenger(challengerResponse);
  const challenger = challengerResponse.result.moves[0];
  assertEqual("position fingerprint", baseline.positionFingerprint, challengerResponse.positionFingerprint);
  assertEqual("ruleset", baseline.rulesetId, challengerResponse.rulesetId);
  assertEqual("evaluator", canonicalize(baseline.evaluator), canonicalize(challengerResponse.evaluator));
  assertEqual(
    "score semantics",
    canonicalize(baseline.scoreSemantics),
    canonicalize(challengerResponse.scoreSemantics),
  );
  if (baseline.scoreSemantics.comparability !== "within-position") {
    throw new Error("comparison refused: score semantics are not within-position");
  }
  return Object.freeze({
    contractId: SAME_POSITION_COMPARISON_CONTRACT,
    status: baseline.status === "exact" && challengerResponse.resultKind === "exact-input"
      ? "exact"
      : "degraded",
    positionFingerprint: baseline.positionFingerprint,
    rulesetId: baseline.rulesetId,
    evaluator: structuredClone(baseline.evaluator),
    scoreSemantics: structuredClone(baseline.scoreSemantics),
    baseline: Object.freeze({
      engineId: baseline.engineId ?? "raw-cc2",
      placement: structuredClone(baseline.witness),
      score: baseline.score,
    }),
    challenger: Object.freeze({
      engineId: challengerResponse.engineId,
      engineVersion: challengerResponse.engineVersion,
      placement: structuredClone(challenger.placement),
      score: challenger.score,
    }),
    scoreGap: challenger.score - baseline.score,
    degraded: Object.freeze([
      ...new Set([...(baseline.reasons ?? []), ...(challengerResponse.degraded ?? [])]),
    ]),
  });
}

export function compareSimpleSamePositionCandidates(baseline, simpleAnalysis) {
  assertBaseline(baseline);
  if (!simpleAnalysis?.bot || !Array.isArray(simpleAnalysis.moves) || simpleAnalysis.moves.length === 0) {
    throw new Error("comparison refused: simple challenger has no authoritative best move");
  }
  const challenger = simpleAnalysis.moves[0];
  assertEqual("position fingerprint", baseline.positionFingerprint, simpleAnalysis.positionFingerprint);
  assertEqual("ruleset", baseline.rulesetId, simpleAnalysis.rulesetId);
  assertEqual("evaluator", canonicalize(baseline.evaluator), canonicalize(simpleAnalysis.evaluator));
  assertEqual(
    "score semantics",
    canonicalize(baseline.scoreSemantics),
    canonicalize(simpleAnalysis.scoreSemantics),
  );
  if (baseline.scoreSemantics.comparability !== "within-position") {
    throw new Error("comparison refused: score semantics are not within-position");
  }
  return Object.freeze({
    contractId: SAME_POSITION_COMPARISON_CONTRACT,
    status: "degraded",
    positionFingerprint: baseline.positionFingerprint,
    rulesetId: baseline.rulesetId,
    evaluator: structuredClone(baseline.evaluator),
    scoreSemantics: structuredClone(baseline.scoreSemantics),
    baseline: Object.freeze({ engineId: baseline.engineId ?? "raw-cc2", placement: structuredClone(baseline.witness), score: baseline.score }),
    challenger: Object.freeze({
      engineId: simpleAnalysis.bot.id,
      engineVersion: "1",
      placement: structuredClone(challenger.placement),
      score: challenger.score,
    }),
    scoreGap: challenger.score - baseline.score,
    degraded: Object.freeze([
      ...new Set([...(baseline.reasons ?? []), "movement-model-unavailable"]),
    ]),
  });
}

export function compareSimpleBotCandidates(left, right, identity) {
  for (const [label, value] of [["left", left], ["right", right]]) {
    if (!value?.bot || !Array.isArray(value.moves) || value.moves.length === 0) {
      throw new Error(`comparison refused: ${label} bot has no authoritative best move`);
    }
  }
  if (typeof identity?.positionFingerprint !== "string" || typeof identity?.rulesetId !== "string") {
    throw new Error("comparison refused: same-position identity is missing");
  }
  assertEqual("evaluator", canonicalize(left.evaluator), canonicalize(right.evaluator));
  assertEqual("score semantics", canonicalize(left.scoreSemantics), canonicalize(right.scoreSemantics));
  return Object.freeze({
    contractId: SAME_POSITION_COMPARISON_CONTRACT,
    status: "degraded",
    ...structuredClone(identity),
    evaluator: structuredClone(left.evaluator),
    scoreSemantics: structuredClone(left.scoreSemantics),
    left: Object.freeze({ engineId: left.bot.id, placement: structuredClone(left.moves[0].placement), score: left.moves[0].score }),
    right: Object.freeze({ engineId: right.bot.id, placement: structuredClone(right.moves[0].placement), score: right.moves[0].score }),
    scoreGap: right.moves[0].score - left.moves[0].score,
    degraded: Object.freeze(["movement-model-unavailable"]),
  });
}

function assertBaseline(value) {
  if (!value || typeof value !== "object") throw new Error("comparison refused: baseline result is missing");
  for (const key of ["positionFingerprint", "rulesetId"]) {
    if (typeof value[key] !== "string" || value[key] === "") {
      throw new Error(`comparison refused: baseline ${key} is missing`);
    }
  }
  if (!value.evaluator || !value.scoreSemantics || !value.witness || !Number.isFinite(value.score)) {
    throw new Error("comparison refused: baseline authoritative evaluation is incomplete");
  }
}

function assertChallenger(value) {
  if (value?.status !== "final" || value.result?.operation !== "analyzeTopN") {
    throw new Error("comparison refused: challenger analysis is not final Top N");
  }
  if (!Array.isArray(value.result.moves) || value.result.moves.length === 0 ||
      !Number.isFinite(value.result.moves[0]?.score) || !value.result.moves[0]?.placement) {
    throw new Error("comparison refused: challenger has no authoritative best move");
  }
  if (!value.evaluator || !value.scoreSemantics) {
    throw new Error("comparison refused: challenger evaluation identity is incomplete");
  }
}

function assertEqual(label, left, right) {
  if (left !== right) throw new Error(`comparison refused: ${label} mismatch`);
}
