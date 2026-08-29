import { canonicalize } from "./cs1-core.mjs";
import { buildCompleteCc2FinalPlacementCandidates } from "./cc2-s2-final-placement-candidates.mjs";
import { createTuningModel } from "./cc2-s2-tuning.mjs";
import { scoreEvaluationFeatures } from "./evaluation.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import {
  S2_REN_QUAD_TSD_SPIKE_EVALUATOR_ID,
  evaluateS2RenQuadTsdSpike,
} from "./s2-ren-quad-tsd-spike-evaluator.mjs";

export const S2_REN_QUAD_TSD_SPIKE_SELECTOR_POLICY =
  "aligned-s2-score-plus-exact-ren-quad-tsd-spike-gain-minus-cc2-rank/1";
export const S2_REN_QUAD_TSD_SPIKE_RETURNED_PREFIX_POLICY =
  "aligned-s2-score-plus-exact-ren-quad-tsd-spike-gain-returned-prefix-minus-cc2-rank/1";

/** Select only from the complete CC2 prefix; missing canonical evidence rejects the selection. */
export function selectS2RenQuadTsdSpikePlacement(guiState, moves, {
  candidateLimit = 16,
  rankPenalty = 25,
  adjustmentScale = 28,
  weightProfileId = "sparse-s2",
  weights = {},
  allowCompleteReturnedPrefix = false,
  engineId = S2_REN_QUAD_TSD_SPIKE_EVALUATOR_ID,
  comparisonSource = S2_REN_QUAD_TSD_SPIKE_SELECTOR_POLICY,
  verificationMemo = null,
} = {}) {
  if (!Array.isArray(moves) || moves.length === 0 ||
    (!allowCompleteReturnedPrefix && moves.length < candidateLimit)) {
    throw new Error("REN Quad/TSD spike selector requires a complete CC2 candidate prefix");
  }
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64) {
    throw new Error("REN Quad/TSD spike candidateLimit must be an integer from 1 to 64");
  }
  if (!Number.isFinite(rankPenalty) || rankPenalty < 0 || rankPenalty > 100 ||
    !Number.isFinite(adjustmentScale) || adjustmentScale < 0 || adjustmentScale > 100) {
    throw new Error("REN Quad/TSD spike selector has an invalid score parameter");
  }
  if (typeof allowCompleteReturnedPrefix !== "boolean") {
    throw new Error("REN Quad/TSD spike allowCompleteReturnedPrefix must be boolean");
  }
  const base = buildCompleteCc2FinalPlacementCandidates(guiState, moves, {
    candidateLimit,
    allowCompleteReturnedPrefix,
    engineId,
    comparisonSource,
    verificationMemo,
    selectorLabel: "REN Quad/TSD spike",
  });
  const model = createTuningModel(weightProfileId, weights);
  const candidates = base.candidates.map(({ cc2Rank, identity, move, verification, placement }) => {
    const record = materializeS2NodeRecord(base.state, { kind: "placement", placement }, {
      witnessIdentity: canonicalize(verification.comparison.witness),
      controllerIdentity: "cc2-final-placement-s2-spin-witness/1",
      budgetIdentity: `cc2-returned-prefix-${base.candidates.length}-ceiling-${candidateLimit}-rank-penalty-${rankPenalty}`,
    });
    const spike = evaluateS2RenQuadTsdSpike(base.state, record);
    const s2Score = scoreEvaluationFeatures(verification.comparison.features, model);
    return { cc2Rank, identity, move, verification, spike, s2Score,
      selectionScore: s2Score + adjustmentScale * spike.units - cc2Rank * rankPenalty };
  });
  candidates.sort((left, right) => right.selectionScore - left.selectionScore ||
    left.cc2Rank - right.cc2Rank || left.identity.localeCompare(right.identity, "en"));
  const best = candidates[0];
  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison,
      engineId,
      source: comparisonSource,
      moveSelectionPolicy: allowCompleteReturnedPrefix
        ? S2_REN_QUAD_TSD_SPIKE_RETURNED_PREFIX_POLICY
        : S2_REN_QUAD_TSD_SPIKE_SELECTOR_POLICY,
      candidateLimit,
      generatedCandidates: candidates.length,
      returnedCandidateCount: base.returnedCandidateCount,
      completeReturnedPrefix: allowCompleteReturnedPrefix,
      rejectedCandidates: 0,
      selectedCc2Rank: best.cc2Rank,
      rankPenalty,
      score: best.s2Score,
      selectionScore: best.selectionScore,
      renQuadTsdSpike: best.spike,
      adjustmentScale,
    },
    candidates: candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      identity: candidate.identity,
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      spike: candidate.spike,
    })),
    rejectedCandidates: [],
  };
}
