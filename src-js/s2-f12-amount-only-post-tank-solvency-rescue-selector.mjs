import { applyTransition } from "./transition.mjs";
import { fullStateKey } from "./state-keys.mjs";
import {
  S2_AMOUNT_ONLY_CONVERSION_POLICY,
  S2_AMOUNT_ONLY_CONVERSION_RANKER_ID,
  rankS2AmountOnlyConversionCandidates,
} from "./s2-amount-only-conversion-ranker.mjs";
import { S2_AMOUNT_ONLY_SOLVENCY_POLICY } from "./s2-amount-only-post-tank-solvency.mjs";

export const S2_F12_POST_TANK_SOLVENCY_RESCUE_SELECTOR_POLICY_V2 =
  "f12-control-with-amount-only-post-tank-solvency-rescue/1";

export function chooseS2F12AmountOnlyPostTankSolvencyRescue(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("amount-only F14 rescue requires F12-ranked candidates");
  }
  if (candidates.some((candidate) => typeof candidate.solvency?.solvent !== "boolean" ||
    !Number.isFinite(candidate.solvency?.solvency))) {
    throw new Error("amount-only F14 rescue requires amount-only solvency for every candidate");
  }
  const control = candidates[0];
  const solventCandidates = candidates.filter((candidate) => candidate.solvency.solvent);
  const rescued = control.solvency.solvency < 0 && solventCandidates.length > 0;
  return Object.freeze({
    control,
    selected: rescued ? solventCandidates[0] : control,
    solventCandidates,
    rescued,
  });
}

export function evaluateS2F12AmountOnlyPostTankSolvencyRescueCandidates(guiState, moves, options = {}) {
  const {
    candidateLimit = 16,
    rankPenalty = 25,
    adjustmentScale = 28,
    allowCompleteReturnedPrefix = false,
    engineId = S2_AMOUNT_ONLY_CONVERSION_RANKER_ID,
    comparisonSource = S2_F12_POST_TANK_SOLVENCY_RESCUE_SELECTOR_POLICY_V2,
  } = options;
  const ranked = rankS2AmountOnlyConversionCandidates(guiState, moves, {
    ...options,
    candidateLimit,
    rankPenalty,
    adjustmentScale,
    allowCompleteReturnedPrefix,
    engineId,
    comparisonSource,
  });
  const choice = chooseS2F12AmountOnlyPostTankSolvencyRescue(ranked.candidates);
  return Object.freeze({
    ...ranked,
    choice,
    candidateLimit,
    rankPenalty,
    adjustmentScale,
    allowCompleteReturnedPrefix,
    engineId,
    comparisonSource,
  });
}

export function formatS2F12AmountOnlyPostTankSolvencyRescueSelection(evaluation) {
  const {
    base, candidates, choice, candidateLimit, rankPenalty, adjustmentScale,
    allowCompleteReturnedPrefix, engineId, comparisonSource,
  } = evaluation;
  const best = choice.selected;
  const selectedTransition = applyTransition(
    structuredClone(base.state),
    { kind: "placement", placement: best.placement },
    base.state.rulesetId,
  );
  if (selectedTransition.legality?.legal !== true || selectedTransition.nextState == null) {
    throw new Error("amount-only F14 selected placement is not a legal canonical transition");
  }
  const witness = best.verification.comparison.witness;
  return {
    status: "ok",
    reasons: [],
    spinPolicy: best.verification.spinPolicy,
    manifest: best.verification.manifest,
    move: structuredClone(best.move),
    transition: selectedTransition,
    comparison: {
      engineId,
      source: comparisonSource,
      moveSelectionPolicy: S2_F12_POST_TANK_SOLVENCY_RESCUE_SELECTOR_POLICY_V2,
      baseMoveSelectionPolicy: S2_AMOUNT_ONLY_CONVERSION_POLICY,
      evaluatorPolicy: S2_AMOUNT_ONLY_SOLVENCY_POLICY,
      candidateLimit,
      generatedCandidates: candidates.length,
      returnedCandidateCount: base.returnedCandidateCount,
      completeReturnedPrefix: allowCompleteReturnedPrefix,
      selectedCc2Rank: best.cc2Rank,
      rankPenalty,
      adjustmentScale,
      score: best.s2Score,
      selectionScore: best.selectionScore,
      features: best.features,
      conversion: best.conversion,
      postTankSolvency: best.solvency,
      rescue: {
        applied: choice.rescued,
        controlCc2Rank: choice.control.cc2Rank,
        controlSolvency: choice.control.solvency.solvency,
        solventCandidates: choice.solventCandidates.length,
        insolventCandidates: candidates.filter((candidate) => candidate.solvency.solvency < 0).length,
      },
      witness: {
        placement: structuredClone(witness.placement),
        kind: witness.kind,
        reachability: witness.reachability,
        spinPolicyId: witness.spinPolicyId,
      },
      rulesetId: base.state.rulesetId,
      status: "ok",
      reasons: [],
    },
    candidates: candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      identity: candidate.identity,
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      conversion: candidate.conversion,
      solvency: candidate.solvency,
    })),
  };
}

export function selectS2F12AmountOnlyPostTankSolvencyRescuePlacement(guiState, moves, options = {}) {
  return formatS2F12AmountOnlyPostTankSolvencyRescueSelection(
    evaluateS2F12AmountOnlyPostTankSolvencyRescueCandidates(guiState, moves, options),
  );
}

export function attachS2SubmissionFingerprint(botId, botState, result) {
  return {
    botId,
    result,
    positionFingerprint: fullStateKey(botState),
  };
}
