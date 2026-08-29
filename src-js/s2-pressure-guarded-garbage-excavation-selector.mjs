import { canonicalize } from "./cs1-core.mjs";
import { buildCompleteCc2FinalPlacementCandidates } from "./cc2-s2-final-placement-candidates.mjs";
import { compareTuningCandidates, createTuningModel } from "./cc2-s2-tuning.mjs";
import { scoreEvaluationFeatures } from "./evaluation.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import {
  S2_GARBAGE_EXCAVATION_CAP,
  S2_GARBAGE_EXCAVATION_WEIGHTS,
  applyGarbageExcavationGuards,
  evaluateS2GarbageExcavation,
} from "./s2-garbage-excavation-evaluator.mjs";
import {
  S2_OPPONENT_EFFECTIVE_PRESSURE_CAP,
  S2_OPPONENT_EFFECTIVE_PRESSURE_WEIGHTS,
  advanceOpponentCounterfactual,
  evaluateS2OpponentEffectivePressure,
  submissionFingerprint,
} from "./s2-opponent-effective-pressure-evaluator.mjs";
import {
  S2_PRESSURE_GUARDED_GARBAGE_EXCAVATION_EVALUATOR_ID,
  S2_PRESSURE_GUARDED_GARBAGE_EXCAVATION_POLICY,
  combineS2PressureGuardedGarbageExcavation,
} from "./s2-pressure-guarded-garbage-excavation-evaluator.mjs";

export const S2_PRESSURE_GUARDED_GARBAGE_EXCAVATION_SELECTOR_POLICY =
  "aligned-s2-plus-f8-excavation-with-negative-f9-veto-minus-cc2-rank/1";

export function selectS2PressureGuardedGarbageExcavationPlacement(guiState, moves, {
  match, botId, opponentBotId, opponentSubmission,
  candidateLimit = 16, rankPenalty = 25, adjustmentScale = 28,
  weightProfileId = "sparse-s2", weights = {},
  excavationWeights = S2_GARBAGE_EXCAVATION_WEIGHTS,
  excavationCap = S2_GARBAGE_EXCAVATION_CAP,
  pressureWeights = S2_OPPONENT_EFFECTIVE_PRESSURE_WEIGHTS,
  pressureCap = S2_OPPONENT_EFFECTIVE_PRESSURE_CAP,
  allowCompleteReturnedPrefix = false,
  engineId = S2_PRESSURE_GUARDED_GARBAGE_EXCAVATION_EVALUATOR_ID,
  comparisonSource = S2_PRESSURE_GUARDED_GARBAGE_EXCAVATION_SELECTOR_POLICY,
  verificationMemo = null,
} = {}) {
  if (!Array.isArray(moves) || moves.length === 0 ||
      (!allowCompleteReturnedPrefix && moves.length < candidateLimit)) {
    throw new Error("pressure-guarded excavation requires a complete CC2 candidate prefix");
  }
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64 ||
      !Number.isFinite(rankPenalty) || rankPenalty < 0 || rankPenalty > 100 ||
      !Number.isFinite(adjustmentScale) || adjustmentScale < 0 || adjustmentScale > 100) {
    throw new Error("pressure-guarded excavation has an invalid bounded setting");
  }
  if (match === undefined || typeof botId !== "string" || typeof opponentBotId !== "string" ||
      opponentSubmission === undefined || opponentSubmission === null) {
    throw new Error("pressure-guarded excavation requires a match and frozen opponent submission");
  }
  const base = buildCompleteCc2FinalPlacementCandidates(guiState, moves, {
    candidateLimit, allowCompleteReturnedPrefix, engineId, comparisonSource, verificationMemo,
    selectorLabel: "pressure-guarded garbage excavation",
  });
  const model = createTuningModel(weightProfileId, weights);
  const candidates = base.candidates.map(({ cc2Rank, identity, move, verification, placement }) => {
    const record = materializeS2NodeRecord(base.state, { kind: "placement", placement }, {
      witnessIdentity: canonicalize(verification.comparison.witness),
      controllerIdentity: "cc2-final-placement-s2-spin-witness/1",
      budgetIdentity: `cc2-returned-prefix-${base.candidates.length}-ceiling-${candidateLimit}-rank-penalty-${rankPenalty}`,
    });
    return {
      cc2Rank, identity, move, verification,
      excavation: evaluateS2GarbageExcavation(base.state, record, {
        weights: excavationWeights, cap: excavationCap,
      }),
      s2Score: scoreEvaluationFeatures(verification.comparison.features, model),
      pressure: null, combined: null, selectionScore: null,
    };
  });
  const control = [...candidates].sort((left, right) => compareTuningCandidates(
    { ...left, selectionScore: left.s2Score - left.cc2Rank * rankPenalty },
    { ...right, selectionScore: right.s2Score - right.cc2Rank * rankPenalty },
  ))[0];
  applyGarbageExcavationGuards(candidates, control.excavation);
  const controlOutcome = advanceOpponentCounterfactual(match, {
    botId, opponentBotId, submission: control.verification, opponentSubmission,
  });
  for (const candidate of candidates) {
    candidate.pressure = evaluateS2OpponentEffectivePressure(match, {
      botId, opponentBotId, submission: candidate.verification, opponentSubmission,
      controlOutcome, weights: pressureWeights, cap: pressureCap,
    });
    candidate.combined = combineS2PressureGuardedGarbageExcavation(candidate.excavation, candidate.pressure);
    candidate.selectionScore = candidate.s2Score + adjustmentScale * candidate.combined.units -
      candidate.cc2Rank * rankPenalty;
  }
  candidates.sort((left, right) => right.selectionScore - left.selectionScore ||
    left.cc2Rank - right.cc2Rank || left.identity.localeCompare(right.identity, "en"));
  const best = candidates[0];
  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison,
      engineId, source: comparisonSource,
      moveSelectionPolicy: S2_PRESSURE_GUARDED_GARBAGE_EXCAVATION_SELECTOR_POLICY,
      evaluatorPolicy: S2_PRESSURE_GUARDED_GARBAGE_EXCAVATION_POLICY,
      candidateLimit, generatedCandidates: candidates.length,
      returnedCandidateCount: base.returnedCandidateCount,
      completeReturnedPrefix: allowCompleteReturnedPrefix,
      selectedCc2Rank: best.cc2Rank, rankPenalty, adjustmentScale,
      score: best.s2Score, selectionScore: best.selectionScore,
      pressureGuardedExcavation: best.combined,
      controlCc2Rank: control.cc2Rank,
      opponentSubmissionFingerprint: submissionFingerprint(opponentSubmission),
      opponentControlOutcome: controlOutcome.opponent,
    },
    candidates: candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank, identity: candidate.identity,
      s2Score: candidate.s2Score, selectionScore: candidate.selectionScore,
      pressureGuardedExcavation: candidate.combined,
    })),
  };
}
