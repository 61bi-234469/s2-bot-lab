import { canonicalize } from "./cs1-core.mjs";
import {
  S2_CONVERSION_QUALIFIED_REN_FINISHER_SELECTOR_POLICY,
  rankS2ConversionQualifiedRenFinisherCandidates,
} from "./s2-conversion-qualified-ren-finisher-selector.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import {
  S2_NEXT_LOCK_SURVIVAL_EVALUATOR_ID,
  S2_NEXT_LOCK_SURVIVAL_POLICY,
  evaluateS2NextLockSurvival,
} from "./s2-next-lock-survival-evaluator.mjs";

export const S2_F12_NEXT_LOCK_SURVIVAL_RESCUE_SELECTOR_POLICY =
  "f12-control-with-next-lock-survival-rescue-only/1";

export function chooseS2F12NextLockSurvivalRescue(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("F13 rescue requires F12-ranked candidates");
  }
  if (candidates.some((candidate) => !candidate.survival?.survives && candidate.survival?.exhaustive !== true)) {
    throw new Error("F13 rescue cannot rank an unproven death");
  }
  const control = candidates[0];
  const survivors = candidates.filter((candidate) => candidate.survival.survives);
  const rescued = !control.survival.survives && survivors.length > 0;
  return Object.freeze({
    control,
    selected: rescued ? survivors[0] : control,
    survivors,
    rescued,
  });
}

export function selectS2F12NextLockSurvivalRescuePlacement(guiState, moves, options = {}) {
  const {
    candidateLimit = 16,
    rankPenalty = 25,
    adjustmentScale = 28,
    allowCompleteReturnedPrefix = false,
    engineId = S2_NEXT_LOCK_SURVIVAL_EVALUATOR_ID,
    comparisonSource = S2_F12_NEXT_LOCK_SURVIVAL_RESCUE_SELECTOR_POLICY,
  } = options;
  const { base, candidates: ranked } = rankS2ConversionQualifiedRenFinisherCandidates(guiState, moves, {
    ...options,
    candidateLimit,
    rankPenalty,
    adjustmentScale,
    allowCompleteReturnedPrefix,
    engineId,
    comparisonSource,
  });
  const candidates = ranked.map((candidate) => {
    const record = materializeS2NodeRecord(base.state, { kind: "placement", placement: candidate.placement }, {
      witnessIdentity: canonicalize(candidate.verification.comparison.witness),
      controllerIdentity: "cc2-final-placement-s2-spin-witness/1",
      budgetIdentity: `cc2-returned-prefix-${ranked.length}-ceiling-${candidateLimit}-rank-penalty-${rankPenalty}`,
    });
    return { ...candidate, survival: evaluateS2NextLockSurvival(base.state, record) };
  });
  const choice = chooseS2F12NextLockSurvivalRescue(candidates);
  const best = choice.selected;
  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison,
      engineId,
      source: comparisonSource,
      moveSelectionPolicy: S2_F12_NEXT_LOCK_SURVIVAL_RESCUE_SELECTOR_POLICY,
      baseMoveSelectionPolicy: S2_CONVERSION_QUALIFIED_REN_FINISHER_SELECTOR_POLICY,
      evaluatorPolicy: S2_NEXT_LOCK_SURVIVAL_POLICY,
      candidateLimit,
      generatedCandidates: candidates.length,
      returnedCandidateCount: base.returnedCandidateCount,
      completeReturnedPrefix: allowCompleteReturnedPrefix,
      selectedCc2Rank: best.cc2Rank,
      rankPenalty,
      adjustmentScale,
      score: best.s2Score,
      selectionScore: best.selectionScore,
      conversion: best.conversion,
      nextLockSurvival: best.survival,
      rescue: {
        applied: choice.rescued,
        controlCc2Rank: choice.control.cc2Rank,
        controlSurvives: choice.control.survival.survives,
        survivingCandidates: choice.survivors.length,
        deadCandidates: candidates.length - choice.survivors.length,
      },
    },
    candidates: candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      identity: candidate.identity,
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      conversion: candidate.conversion,
      survival: candidate.survival,
    })),
  };
}
