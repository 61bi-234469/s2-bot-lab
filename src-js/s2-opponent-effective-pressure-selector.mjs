// F9 opponent-effective-pressure selector (ADR-029).
//
// The signature is deliberately different from every other family selector in
// this repository: it takes a match snapshot, my bot id, and the opponent's
// frozen submission alongside the returned prefix. A selector that could be
// called with a bare state would be a selector that could silently skip the
// counterfactual, so the extra context is required rather than optional.
//
// One full match advance runs per candidate, plus one for the control
// selection, and nothing is cached. That cost is the family.

import { canonicalize } from "./cs1-core.mjs";
import { buildCompleteCc2FinalPlacementCandidates } from "./cc2-s2-final-placement-candidates.mjs";
import { compareTuningCandidates, createTuningModel } from "./cc2-s2-tuning.mjs";
import { scoreEvaluationFeatures } from "./evaluation.mjs";
import {
  S2_OPPONENT_EFFECTIVE_PRESSURE_CAP,
  S2_OPPONENT_EFFECTIVE_PRESSURE_EVALUATOR_ID,
  S2_OPPONENT_EFFECTIVE_PRESSURE_POLICY,
  S2_OPPONENT_EFFECTIVE_PRESSURE_WEIGHTS,
  advanceOpponentCounterfactual,
  evaluateS2OpponentEffectivePressure,
  submissionFingerprint,
} from "./s2-opponent-effective-pressure-evaluator.mjs";

export const S2_OPPONENT_EFFECTIVE_PRESSURE_SELECTOR_POLICY =
  "aligned-s2-score-plus-guarded-opponent-effective-pressure-minus-cc2-rank/1";

export function selectS2OpponentEffectivePressurePlacement(guiState, moves, {
  match,
  botId,
  opponentBotId,
  opponentSubmission,
  candidateLimit = 16,
  rankPenalty = 25,
  adjustmentScale = 28,
  weightProfileId = "sparse-s2",
  weights = {},
  pressureWeights = S2_OPPONENT_EFFECTIVE_PRESSURE_WEIGHTS,
  pressureCap = S2_OPPONENT_EFFECTIVE_PRESSURE_CAP,
  allowCompleteReturnedPrefix = false,
  engineId = S2_OPPONENT_EFFECTIVE_PRESSURE_EVALUATOR_ID,
  comparisonSource = S2_OPPONENT_EFFECTIVE_PRESSURE_SELECTOR_POLICY,
  verificationMemo = null,
} = {}) {
  if (!Array.isArray(moves) || moves.length === 0 ||
    (!allowCompleteReturnedPrefix && moves.length < candidateLimit)) {
    throw new Error("opponent pressure selector requires a complete CC2 candidate prefix");
  }
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64 ||
    !Number.isFinite(rankPenalty) || rankPenalty < 0 || rankPenalty > 100 ||
    !Number.isFinite(adjustmentScale) || adjustmentScale < 0 || adjustmentScale > 100) {
    throw new Error("opponent pressure selector has an invalid bounded setting");
  }
  if (match === undefined || typeof botId !== "string" || typeof opponentBotId !== "string" ||
    opponentSubmission === undefined || opponentSubmission === null) {
    throw new Error("opponent pressure selector requires a match, both bot ids, and a frozen opponent submission");
  }

  const base = buildCompleteCc2FinalPlacementCandidates(guiState, moves, {
    candidateLimit,
    allowCompleteReturnedPrefix,
    engineId,
    comparisonSource,
    verificationMemo,
    selectorLabel: "Opponent effective pressure",
  });
  const model = createTuningModel(weightProfileId, weights);
  const scored = base.candidates.map(({ cc2Rank, identity, move, verification }) => {
    const s2Score = scoreEvaluationFeatures(verification.comparison.features, model);
    return {
      cc2Rank,
      identity,
      move,
      verification,
      s2Score,
      toppedOut: verification.comparison.features.toppedOut === 1,
      controlScore: s2Score - cc2Rank * rankPenalty,
      selectionScore: null,
      pressure: null,
    };
  });

  // The control advance is the baseline every candidate delta is measured
  // against, so it is computed first and from the same snapshot.
  const control = [...scored]
    .sort((left, right) => compareTuningCandidates(
      { ...left, selectionScore: left.controlScore },
      { ...right, selectionScore: right.controlScore },
    ))[0];
  const controlOutcome = advanceOpponentCounterfactual(match, {
    botId,
    opponentBotId,
    submission: control.verification,
    opponentSubmission,
  });

  for (const candidate of scored) {
    candidate.pressure = evaluateS2OpponentEffectivePressure(match, {
      botId,
      opponentBotId,
      submission: candidate.verification,
      opponentSubmission,
      controlOutcome,
      weights: pressureWeights,
      cap: pressureCap,
    });
    candidate.selectionScore = candidate.s2Score +
      adjustmentScale * candidate.pressure.units -
      candidate.cc2Rank * rankPenalty;
  }

  scored.sort((left, right) => right.selectionScore - left.selectionScore ||
    left.cc2Rank - right.cc2Rank || left.identity.localeCompare(right.identity, "en"));
  const best = scored[0];

  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison,
      engineId,
      source: comparisonSource,
      moveSelectionPolicy: S2_OPPONENT_EFFECTIVE_PRESSURE_SELECTOR_POLICY,
      evaluatorPolicy: S2_OPPONENT_EFFECTIVE_PRESSURE_POLICY,
      candidateLimit,
      generatedCandidates: scored.length,
      returnedCandidateCount: base.returnedCandidateCount,
      completeReturnedPrefix: allowCompleteReturnedPrefix,
      selectedCc2Rank: best.cc2Rank,
      rankPenalty,
      adjustmentScale,
      pressureWeights,
      pressureCap,
      score: best.s2Score,
      selectionScore: best.selectionScore,
      opponentEffectivePressure: best.pressure,
      controlCc2Rank: control.cc2Rank,
      // Recorded per round so the declared proposal order is auditable rather
      // than assumed (ADR-029).
      opponentSubmissionFingerprint: submissionFingerprint(opponentSubmission),
      opponentControlOutcome: controlOutcome.opponent,
      guardedCandidates: scored.filter((candidate) => candidate.pressure.guarded).length,
    },
    candidates: scored.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      identity: candidate.identity,
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      pressure: candidate.pressure,
    })),
  };
}
