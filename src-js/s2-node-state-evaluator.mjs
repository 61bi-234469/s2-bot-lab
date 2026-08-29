import {
  DEPTH1_BASELINE_MODEL,
  EVALUATION_SCORE_SEMANTICS,
  FEATURE_SCHEMA_SHA256,
  evaluatorModelIdentity,
  scoreEvaluationFeatures,
} from "./evaluation.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";

export const S2_NODE_STATE_EVALUATOR_ID = "s2-node-state-evaluator/1";
export const S2_NODE_STATE_EVALUATOR_POLICY =
  "replay-verified-s2-node-record-linear-score-rank-prior-state-key/1";

/**
 * Score exactly one replay-verified SNEB record.  The record, rather than a
 * CC2 diagnostic or a partial board, is the only evaluator input.
 */
export function evaluateS2NodeStateRecord(state, record, {
  model = DEPTH1_BASELINE_MODEL,
} = {}) {
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  if (record.featureSchemaSha256 !== FEATURE_SCHEMA_SHA256) {
    throw new Error("node-state evaluator feature schema hash mismatch");
  }
  if (model.featureSchemaSha256 !== FEATURE_SCHEMA_SHA256) {
    throw new Error("node-state evaluator model schema hash mismatch");
  }
  return Object.freeze({
    stateKey: replayed.stateKey,
    nextStateKey: replayed.nextStateKey,
    score: scoreEvaluationFeatures(replayed.features, model),
    evaluator: Object.freeze({
      id: S2_NODE_STATE_EVALUATOR_ID,
      policy: S2_NODE_STATE_EVALUATOR_POLICY,
      model: evaluatorModelIdentity(model),
      featureSchemaSha256: FEATURE_SCHEMA_SHA256,
      scoreSemantics: EVALUATION_SCORE_SEMANTICS,
    }),
  });
}

/**
 * Rank a complete CC2 prefix after every member is replay-verified.  A
 * canonical next-state key only settles an equal score/rank-prior tie; it
 * never changes a feature weight, proposal set, or search budget.
 */
export function selectS2NodeStateEvaluator(state, candidates, {
  rankPenalty = 25,
  model = DEPTH1_BASELINE_MODEL,
} = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("node-state evaluator requires a non-empty complete candidate prefix");
  }
  if (!Number.isFinite(rankPenalty) || rankPenalty < 0 || rankPenalty > 100) {
    throw new Error("node-state evaluator rankPenalty must be a number from 0 to 100");
  }
  const identities = new Set();
  const nextStateKeys = new Set();
  const evaluated = candidates.map((candidate) => {
    if (!Number.isSafeInteger(candidate?.cc2Rank) || candidate.cc2Rank < 0) {
      throw new Error("node-state evaluator candidate has an invalid CC2 rank");
    }
    if (typeof candidate.identity !== "string" || candidate.identity.length === 0) {
      throw new Error("node-state evaluator candidate has a missing identity");
    }
    if (identities.has(candidate.identity)) throw new Error("node-state evaluator candidate identity is duplicated");
    identities.add(candidate.identity);
    const evaluation = evaluateS2NodeStateRecord(state, candidate.record, { model });
    if (nextStateKeys.has(evaluation.nextStateKey)) {
      throw new Error("node-state evaluator next-state key is duplicated");
    }
    nextStateKeys.add(evaluation.nextStateKey);
    return Object.freeze({
      ...candidate,
      stateKey: evaluation.stateKey,
      nextStateKey: evaluation.nextStateKey,
      score: evaluation.score,
      selectionScore: evaluation.score - candidate.cc2Rank * rankPenalty,
    });
  });
  evaluated.sort(compareS2NodeStateEvaluatorCandidates);
  return Object.freeze({
    evaluator: Object.freeze({
      id: S2_NODE_STATE_EVALUATOR_ID,
      policy: S2_NODE_STATE_EVALUATOR_POLICY,
      model: evaluatorModelIdentity(model),
      featureSchemaSha256: FEATURE_SCHEMA_SHA256,
      scoreSemantics: EVALUATION_SCORE_SEMANTICS,
      rankPenalty,
    }),
    selected: evaluated[0],
    candidates: Object.freeze(evaluated),
  });
}

export function compareS2NodeStateEvaluatorCandidates(left, right) {
  return right.selectionScore - left.selectionScore ||
    left.nextStateKey.localeCompare(right.nextStateKey, "en") ||
    left.identity.localeCompare(right.identity, "en") ||
    left.cc2Rank - right.cc2Rank;
}
