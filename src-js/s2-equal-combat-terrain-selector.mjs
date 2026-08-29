import { canonicalize } from "./cs1-core.mjs";
import { buildCompleteCc2FinalPlacementCandidates } from "./cc2-s2-final-placement-candidates.mjs";
import { createTuningModel } from "./cc2-s2-tuning.mjs";
import { scoreEvaluationFeatures } from "./evaluation.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import {
  S2_EQUAL_COMBAT_TERRAIN_EVALUATOR_ID,
  S2_EQUAL_COMBAT_TERRAIN_POLICY,
  applyEqualCombatTerrainTieBreak,
  evaluateS2EqualCombatTerrain,
} from "./s2-equal-combat-terrain-evaluator.mjs";

export const S2_EQUAL_COMBAT_TERRAIN_SELECTOR_POLICY =
  "aligned-s2-score-plus-equal-combat-terrain-minus-cc2-rank/1";

export function selectS2EqualCombatTerrainPlacement(guiState, moves, {
  candidateLimit = 16,
  rankPenalty = 25,
  adjustmentScale = 28,
  weightProfileId = "sparse-s2",
  weights = {},
  allowCompleteReturnedPrefix = false,
  engineId = S2_EQUAL_COMBAT_TERRAIN_EVALUATOR_ID,
  comparisonSource = S2_EQUAL_COMBAT_TERRAIN_SELECTOR_POLICY,
  verificationMemo = null,
} = {}) {
  if (!Array.isArray(moves) || moves.length === 0 ||
    (!allowCompleteReturnedPrefix && moves.length < candidateLimit)) {
    throw new Error("equal-combat terrain selector requires a complete CC2 candidate prefix");
  }
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64 ||
    !Number.isFinite(rankPenalty) || rankPenalty < 0 || rankPenalty > 100 ||
    !Number.isFinite(adjustmentScale) || adjustmentScale < 0 || adjustmentScale > 100) {
    throw new Error("equal-combat terrain selector has an invalid bounded setting");
  }
  const base = buildCompleteCc2FinalPlacementCandidates(guiState, moves, {
    candidateLimit,
    allowCompleteReturnedPrefix,
    engineId,
    comparisonSource,
    verificationMemo,
    selectorLabel: "equal-combat terrain",
  });
  const model = createTuningModel(weightProfileId, weights);
  const candidates = applyEqualCombatTerrainTieBreak(base.candidates.map(
    ({ cc2Rank, identity, move, verification, placement }) => {
      const record = materializeS2NodeRecord(base.state, { kind: "placement", placement }, {
        witnessIdentity: canonicalize(verification.comparison.witness),
        controllerIdentity: "cc2-final-placement-s2-spin-witness/1",
        budgetIdentity: `cc2-returned-prefix-${base.candidates.length}-ceiling-${candidateLimit}-rank-penalty-${rankPenalty}`,
      });
      return {
        cc2Rank, identity, move, verification,
        terrain: evaluateS2EqualCombatTerrain(base.state, record),
        s2Score: scoreEvaluationFeatures(verification.comparison.features, model),
      };
    },
  ));
  for (const candidate of candidates) {
    candidate.selectionScore = candidate.s2Score +
      adjustmentScale * candidate.terrain.units - candidate.cc2Rank * rankPenalty;
  }
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
      moveSelectionPolicy: S2_EQUAL_COMBAT_TERRAIN_SELECTOR_POLICY,
      evaluatorPolicy: S2_EQUAL_COMBAT_TERRAIN_POLICY,
      candidateLimit,
      generatedCandidates: candidates.length,
      rejectedCandidates: base.rejectedCandidates.length,
      returnedCandidateCount: base.returnedCandidateCount,
      completeReturnedPrefix: allowCompleteReturnedPrefix,
      selectedCc2Rank: best.cc2Rank,
      rankPenalty,
      score: best.s2Score,
      selectionScore: best.selectionScore,
      equalCombatTerrain: best.terrain,
      adjustmentScale,
    },
    candidates: candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      identity: candidate.identity,
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      terrain: candidate.terrain,
    })),
    rejectedCandidates: base.rejectedCandidates,
  };
}
