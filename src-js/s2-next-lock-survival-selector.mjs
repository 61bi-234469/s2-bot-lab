// F7 next-lock survival selector (ADR-027).
//
// Rescue-only and structural. There is no coefficient and no adjustment scale:
// the selector cannot change a selection except by replacing a dead end with a
// survivor, and on a corpus where the control never commits a dead end it is
// behaviourally identical to control by construction.
//
// The control is recomputed inside the selector, over the same strict prefix
// and with the same comparison the aligned Gen017 tuning selector uses
// (`compareTuningCandidates`), so "the control's choice" is a computed fact
// about this position rather than a value passed in and trusted. ADR-027
// records why the trigger is the control selection and not CC2 rank 0.

import { canonicalize } from "./cs1-core.mjs";
import { buildCompleteCc2FinalPlacementCandidates } from "./cc2-s2-final-placement-candidates.mjs";
import { compareTuningCandidates, createTuningModel } from "./cc2-s2-tuning.mjs";
import { scoreEvaluationFeatures } from "./evaluation.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import {
  S2_NEXT_LOCK_SURVIVAL_EVALUATOR_ID,
  S2_NEXT_LOCK_SURVIVAL_POLICY,
  evaluateS2NextLockSurvival,
} from "./s2-next-lock-survival-evaluator.mjs";

export const S2_NEXT_LOCK_SURVIVAL_SELECTOR_POLICY =
  "aligned-s2-control-with-next-lock-survival-rescue-only/1";

export function selectS2NextLockSurvivalPlacement(guiState, moves, {
  candidateLimit = 16,
  rankPenalty = 25,
  weightProfileId = "sparse-s2",
  weights = {},
  allowCompleteReturnedPrefix = false,
  engineId = S2_NEXT_LOCK_SURVIVAL_EVALUATOR_ID,
  comparisonSource = S2_NEXT_LOCK_SURVIVAL_SELECTOR_POLICY,
  verificationMemo = null,
} = {}) {
  if (!Array.isArray(moves) || moves.length === 0 ||
    (!allowCompleteReturnedPrefix && moves.length < candidateLimit)) {
    throw new Error("next-lock survival selector requires a complete CC2 candidate prefix");
  }
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64 ||
    !Number.isFinite(rankPenalty) || rankPenalty < 0 || rankPenalty > 100) {
    throw new Error("next-lock survival selector has an invalid bounded setting");
  }
  const base = buildCompleteCc2FinalPlacementCandidates(guiState, moves, {
    candidateLimit,
    allowCompleteReturnedPrefix,
    engineId,
    comparisonSource,
    verificationMemo,
    selectorLabel: "Next-lock survival",
  });
  const model = createTuningModel(weightProfileId, weights);
  const candidates = base.candidates.map(({ cc2Rank, identity, move, verification, placement }) => {
    const record = materializeS2NodeRecord(base.state, { kind: "placement", placement }, {
      witnessIdentity: canonicalize(verification.comparison.witness),
      controllerIdentity: "cc2-final-placement-s2-spin-witness/1",
      budgetIdentity: `cc2-returned-prefix-${base.candidates.length}-ceiling-${candidateLimit}-rank-penalty-${rankPenalty}`,
    });
    const survival = evaluateS2NextLockSurvival(base.state, record);
    const s2Score = scoreEvaluationFeatures(verification.comparison.features, model);
    return {
      cc2Rank,
      identity,
      move,
      verification,
      survival,
      s2Score,
      toppedOut: verification.comparison.features.toppedOut === 1,
      selectionScore: s2Score - cc2Rank * rankPenalty,
    };
  });
  if (candidates.some((candidate) => !candidate.survival.survives && !candidate.survival.exhaustive)) {
    throw new Error("next-lock survival selector cannot rank an unproven death");
  }

  const byControl = [...candidates].sort(compareTuningCandidates);
  const control = byControl[0];
  // Rescue-only: the control's choice stands unless it is a dead end AND some
  // other candidate is not. When no candidate survives there is nothing to
  // rescue, so the control's choice stands there too.
  const survivors = byControl.filter((candidate) => candidate.survival.survives);
  const rescued = !control.survival.survives && survivors.length > 0;
  const best = rescued ? survivors[0] : control;

  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison,
      engineId,
      source: comparisonSource,
      moveSelectionPolicy: S2_NEXT_LOCK_SURVIVAL_SELECTOR_POLICY,
      evaluatorPolicy: S2_NEXT_LOCK_SURVIVAL_POLICY,
      candidateLimit,
      generatedCandidates: candidates.length,
      returnedCandidateCount: base.returnedCandidateCount,
      completeReturnedPrefix: allowCompleteReturnedPrefix,
      selectedCc2Rank: best.cc2Rank,
      rankPenalty,
      score: best.s2Score,
      selectionScore: best.selectionScore,
      nextLockSurvival: best.survival,
      rescue: {
        applied: rescued,
        controlCc2Rank: control.cc2Rank,
        controlSurvives: control.survival.survives,
        survivingCandidates: survivors.length,
        deadCandidates: candidates.length - survivors.length,
      },
    },
    candidates: candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      identity: candidate.identity,
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      survival: candidate.survival,
    })),
  };
}
