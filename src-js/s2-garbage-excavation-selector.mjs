// F8 realised garbage excavation selector (ADR-028).
//
// The control is recomputed inside the selector over the same strict prefix,
// with the same comparison the aligned Gen017 tuning selector uses, because
// the guards are defined *relative to the control's own transition*: a
// candidate may not buy downstack progress with firepower or with survival.
// Guarding against a fixed threshold instead would make the family a board
// score, which is the thing ADR-028 exists to avoid.

import { canonicalize } from "./cs1-core.mjs";
import { buildCompleteCc2FinalPlacementCandidates } from "./cc2-s2-final-placement-candidates.mjs";
import { compareTuningCandidates, createTuningModel } from "./cc2-s2-tuning.mjs";
import { scoreEvaluationFeatures } from "./evaluation.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import {
  S2_GARBAGE_EXCAVATION_CAP,
  S2_GARBAGE_EXCAVATION_EVALUATOR_ID,
  S2_GARBAGE_EXCAVATION_POLICY,
  S2_GARBAGE_EXCAVATION_WEIGHTS,
  applyGarbageExcavationGuards,
  evaluateS2GarbageExcavation,
} from "./s2-garbage-excavation-evaluator.mjs";

export const S2_GARBAGE_EXCAVATION_SELECTOR_POLICY =
  "aligned-s2-score-plus-guarded-realised-garbage-excavation-minus-cc2-rank/1";

export function selectS2GarbageExcavationPlacement(guiState, moves, {
  candidateLimit = 16,
  rankPenalty = 25,
  adjustmentScale = 28,
  weightProfileId = "sparse-s2",
  weights = {},
  excavationWeights = S2_GARBAGE_EXCAVATION_WEIGHTS,
  excavationCap = S2_GARBAGE_EXCAVATION_CAP,
  allowCompleteReturnedPrefix = false,
  engineId = S2_GARBAGE_EXCAVATION_EVALUATOR_ID,
  comparisonSource = S2_GARBAGE_EXCAVATION_SELECTOR_POLICY,
  verificationMemo = null,
} = {}) {
  if (!Array.isArray(moves) || moves.length === 0 ||
    (!allowCompleteReturnedPrefix && moves.length < candidateLimit)) {
    throw new Error("garbage excavation selector requires a complete CC2 candidate prefix");
  }
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64 ||
    !Number.isFinite(rankPenalty) || rankPenalty < 0 || rankPenalty > 100 ||
    !Number.isFinite(adjustmentScale) || adjustmentScale < 0 || adjustmentScale > 100) {
    throw new Error("garbage excavation selector has an invalid bounded setting");
  }
  const base = buildCompleteCc2FinalPlacementCandidates(guiState, moves, {
    candidateLimit,
    allowCompleteReturnedPrefix,
    engineId,
    comparisonSource,
    verificationMemo,
    selectorLabel: "Garbage excavation",
  });
  const model = createTuningModel(weightProfileId, weights);
  const candidates = base.candidates.map(({ cc2Rank, identity, move, verification, placement }) => {
    const record = materializeS2NodeRecord(base.state, { kind: "placement", placement }, {
      witnessIdentity: canonicalize(verification.comparison.witness),
      controllerIdentity: "cc2-final-placement-s2-spin-witness/1",
      budgetIdentity: `cc2-returned-prefix-${base.candidates.length}-ceiling-${candidateLimit}-rank-penalty-${rankPenalty}`,
    });
    const excavation = evaluateS2GarbageExcavation(base.state, record, {
      weights: excavationWeights,
      cap: excavationCap,
    });
    const s2Score = scoreEvaluationFeatures(verification.comparison.features, model);
    return {
      cc2Rank,
      identity,
      move,
      verification,
      excavation,
      s2Score,
      toppedOut: verification.comparison.features.toppedOut === 1,
      // The control ordering, which is also what the guards are measured
      // against. `selectionScore` below is the F8 ordering.
      controlScore: s2Score - cc2Rank * rankPenalty,
      selectionScore: null,
    };
  });

  const control = [...candidates]
    .sort((left, right) => compareTuningCandidates(
      { ...left, selectionScore: left.controlScore },
      { ...right, selectionScore: right.controlScore },
    ))[0];
  applyGarbageExcavationGuards(candidates, control.excavation);
  for (const candidate of candidates) {
    candidate.selectionScore = candidate.s2Score +
      adjustmentScale * candidate.excavation.units -
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
      engineId,
      source: comparisonSource,
      moveSelectionPolicy: S2_GARBAGE_EXCAVATION_SELECTOR_POLICY,
      evaluatorPolicy: S2_GARBAGE_EXCAVATION_POLICY,
      candidateLimit,
      generatedCandidates: candidates.length,
      returnedCandidateCount: base.returnedCandidateCount,
      completeReturnedPrefix: allowCompleteReturnedPrefix,
      selectedCc2Rank: best.cc2Rank,
      rankPenalty,
      adjustmentScale,
      excavationWeights,
      excavationCap,
      score: best.s2Score,
      selectionScore: best.selectionScore,
      garbageExcavation: best.excavation,
      controlCc2Rank: control.cc2Rank,
      guardedCandidates: candidates.filter((candidate) => candidate.excavation.guarded).length,
    },
    candidates: candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      identity: candidate.identity,
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      excavation: candidate.excavation,
    })),
  };
}
