import { canonicalize } from "./cs1-core.mjs";
import { buildCompleteCc2FinalPlacementCandidates } from "./cc2-s2-final-placement-candidates.mjs";
import { createTuningModel } from "./cc2-s2-tuning-model.mjs";
import { scoreEvaluationFeatures } from "./evaluation.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import {
  S2_CONVERSION_QUALIFIED_REN_FINISHER_EVALUATOR_ID,
  S2_CONVERSION_QUALIFIED_REN_FINISHER_POLICY,
  evaluateS2ConversionQualifiedRenFinisher,
} from "./s2-conversion-qualified-ren-finisher-evaluator.mjs";

export const S2_CONVERSION_QUALIFIED_REN_FINISHER_SELECTOR_POLICY =
  "aligned-s2-plus-conversion-qualified-ren-finisher-minus-cc2-rank/1";

export function rankS2ConversionQualifiedRenFinisherCandidates(guiState, moves, {
  candidateLimit = 16, rankPenalty = 25, adjustmentScale = 28,
  weightProfileId = "sparse-s2", weights = {}, allowCompleteReturnedPrefix = false,
  engineId = S2_CONVERSION_QUALIFIED_REN_FINISHER_EVALUATOR_ID,
  comparisonSource = S2_CONVERSION_QUALIFIED_REN_FINISHER_SELECTOR_POLICY,
  verificationMemo = null,
} = {}) {
  if (!Array.isArray(moves) || moves.length === 0 || (!allowCompleteReturnedPrefix && moves.length < candidateLimit)) {
    throw new Error("F12 selector requires a complete CC2 candidate prefix");
  }
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64 ||
      !Number.isFinite(rankPenalty) || rankPenalty < 0 || rankPenalty > 100 ||
      !Number.isFinite(adjustmentScale) || adjustmentScale < 0 || adjustmentScale > 100) {
    throw new Error("F12 selector has an invalid bounded setting");
  }
  const base = buildCompleteCc2FinalPlacementCandidates(guiState, moves, {
    candidateLimit, allowCompleteReturnedPrefix, engineId, comparisonSource, verificationMemo,
    selectorLabel: "conversion-qualified REN finisher",
  });
  const model = createTuningModel(weightProfileId, weights);
  const candidates = base.candidates.map(({ cc2Rank, identity, move, verification, placement }) => {
    const record = materializeS2NodeRecord(base.state, { kind: "placement", placement }, {
      witnessIdentity: canonicalize(verification.comparison.witness),
      controllerIdentity: "cc2-final-placement-s2-spin-witness/1",
      budgetIdentity: `cc2-returned-prefix-${base.candidates.length}-ceiling-${candidateLimit}-rank-penalty-${rankPenalty}`,
    });
    const conversion = evaluateS2ConversionQualifiedRenFinisher(base.state, record);
    const s2Score = scoreEvaluationFeatures(verification.comparison.features, model);
    return { cc2Rank, identity, move, verification, placement, conversion, s2Score,
      selectionScore: s2Score + adjustmentScale * conversion.units - cc2Rank * rankPenalty };
  });
  candidates.sort((left, right) => right.selectionScore - left.selectionScore || left.cc2Rank - right.cc2Rank ||
    left.identity.localeCompare(right.identity, "en"));
  return { base, candidates };
}

export function selectS2ConversionQualifiedRenFinisherPlacement(guiState, moves, options = {}) {
  const {
    candidateLimit = 16, rankPenalty = 25, adjustmentScale = 28,
    allowCompleteReturnedPrefix = false,
    engineId = S2_CONVERSION_QUALIFIED_REN_FINISHER_EVALUATOR_ID,
    comparisonSource = S2_CONVERSION_QUALIFIED_REN_FINISHER_SELECTOR_POLICY,
  } = options;
  const { base, candidates } = rankS2ConversionQualifiedRenFinisherCandidates(guiState, moves, options);
  const best = candidates[0];
  return {
    ...best.verification, move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison, engineId, source: comparisonSource,
      moveSelectionPolicy: S2_CONVERSION_QUALIFIED_REN_FINISHER_SELECTOR_POLICY,
      evaluatorPolicy: S2_CONVERSION_QUALIFIED_REN_FINISHER_POLICY,
      candidateLimit, generatedCandidates: candidates.length, returnedCandidateCount: base.returnedCandidateCount,
      completeReturnedPrefix: allowCompleteReturnedPrefix, selectedCc2Rank: best.cc2Rank, rankPenalty, adjustmentScale,
      score: best.s2Score, selectionScore: best.selectionScore, conversion: best.conversion,
    },
    candidates: candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank, identity: candidate.identity, s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore, conversion: candidate.conversion,
    })),
  };
}
