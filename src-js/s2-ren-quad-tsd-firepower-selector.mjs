import { canonicalize } from "./cs1-core.mjs";
import { buildCompleteCc2FinalPlacementCandidates } from "./cc2-s2-final-placement-candidates.mjs";
import { createTuningModel } from "./cc2-s2-tuning.mjs";
import { scoreEvaluationFeatures } from "./evaluation.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import {
  S2_REN_QUAD_TSD_FIREPOWER_EVALUATOR_ID,
  S2_REN_QUAD_TSD_FIREPOWER_POLICY,
  evaluateS2RenQuadTsdFirepower,
} from "./s2-ren-quad-tsd-firepower-evaluator.mjs";

export const S2_REN_QUAD_TSD_FIREPOWER_SELECTOR_POLICY =
  "aligned-s2-score-plus-exact-ren-quad-tsd-realised-combat-minus-cc2-rank/1";

export function selectS2RenQuadTsdFirepowerPlacement(guiState, moves, {
  candidateLimit = 16,
  rankPenalty = 25,
  adjustmentScale = 28,
  weightProfileId = "sparse-s2",
  weights = {},
  engineId = S2_REN_QUAD_TSD_FIREPOWER_EVALUATOR_ID,
  comparisonSource = S2_REN_QUAD_TSD_FIREPOWER_SELECTOR_POLICY,
} = {}) {
  if (!Array.isArray(moves) || moves.length < candidateLimit) {
    throw new Error("REN Quad/TSD selector requires a complete CC2 candidate prefix");
  }
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64 ||
    !Number.isFinite(rankPenalty) || rankPenalty < 0 || rankPenalty > 100 ||
    !Number.isFinite(adjustmentScale) || adjustmentScale < 0 || adjustmentScale > 100) {
    throw new Error("REN Quad/TSD selector has an invalid bounded setting");
  }
  const base = buildCompleteCc2FinalPlacementCandidates(guiState, moves, {
    candidateLimit,
    engineId,
    comparisonSource,
    selectorLabel: "REN Quad/TSD",
  });
  const model = createTuningModel(weightProfileId, weights);
  const candidates = base.candidates.map(({ cc2Rank, identity, move, verification, placement }) => {
    const record = materializeS2NodeRecord(base.state, { kind: "placement", placement }, {
      witnessIdentity: canonicalize(verification.comparison.witness), controllerIdentity: "cc2-final-placement-s2-spin-witness/1",
      budgetIdentity: `cc2-prefix-${candidateLimit}-rank-penalty-${rankPenalty}`,
    });
    const firepower = evaluateS2RenQuadTsdFirepower(base.state, record);
    const s2Score = scoreEvaluationFeatures(verification.comparison.features, model);
    return { cc2Rank, identity, move, verification, firepower, s2Score,
      selectionScore: s2Score + adjustmentScale * firepower.units - cc2Rank * rankPenalty };
  });
  candidates.sort((left, right) => right.selectionScore - left.selectionScore || left.cc2Rank - right.cc2Rank || left.identity.localeCompare(right.identity, "en"));
  const best = candidates[0];
  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: { ...best.verification.comparison, engineId, source: comparisonSource, moveSelectionPolicy: S2_REN_QUAD_TSD_FIREPOWER_SELECTOR_POLICY,
      candidateLimit, generatedCandidates: candidates.length, rejectedCandidates: base.rejectedCandidates.length, selectedCc2Rank: best.cc2Rank, rankPenalty,
      score: best.s2Score, selectionScore: best.selectionScore, renQuadTsdFirepower: best.firepower, adjustmentScale },
    candidates: candidates.map((candidate) => ({ cc2Rank: candidate.cc2Rank, identity: candidate.identity, s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore, firepower: candidate.firepower })),
    rejectedCandidates: base.rejectedCandidates,
  };
}
