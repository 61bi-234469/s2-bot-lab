import { canonicalize } from "./cs1-core.mjs";
import {
  S2_CONVERSION_QUALIFIED_REN_FINISHER_SELECTOR_POLICY,
  rankS2ConversionQualifiedRenFinisherCandidates,
} from "./s2-conversion-qualified-ren-finisher-selector.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import {
  S2_POST_TANK_SOLVENCY_EVALUATOR_ID,
  S2_POST_TANK_SOLVENCY_POLICY,
  evaluateS2PostTankSolvency,
} from "./s2-post-tank-solvency-evaluator.mjs";

export const S2_F12_POST_TANK_SOLVENCY_RESCUE_SELECTOR_POLICY =
  "f12-control-with-post-tank-solvency-rescue-only/1";

export function chooseS2F12PostTankSolvencyRescue(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    throw new Error("F14 rescue requires F12-ranked candidates");
  }
  if (candidates.some((candidate) => typeof candidate.solvency?.solvent !== "boolean" ||
    !Number.isFinite(candidate.solvency?.solvency))) {
    throw new Error("F14 rescue requires exact post-tank solvency for every candidate");
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

export function evaluateS2F12PostTankSolvencyRescueCandidates(guiState, moves, options = {}) {
  const {
    candidateLimit = 16,
    rankPenalty = 25,
    adjustmentScale = 28,
    allowCompleteReturnedPrefix = false,
    engineId = S2_POST_TANK_SOLVENCY_EVALUATOR_ID,
    comparisonSource = S2_F12_POST_TANK_SOLVENCY_RESCUE_SELECTOR_POLICY,
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
    return { ...candidate, solvency: evaluateS2PostTankSolvency(base.state, record) };
  });
  const choice = chooseS2F12PostTankSolvencyRescue(candidates);
  return Object.freeze({
    base,
    candidates,
    choice,
    candidateLimit,
    rankPenalty,
    adjustmentScale,
    allowCompleteReturnedPrefix,
    engineId,
    comparisonSource,
  });
}

export function formatS2F12PostTankSolvencyRescueSelection(evaluation) {
  const {
    base, candidates, choice, candidateLimit, rankPenalty, adjustmentScale,
    allowCompleteReturnedPrefix, engineId, comparisonSource,
  } = evaluation;
  const best = choice.selected;
  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison,
      engineId,
      source: comparisonSource,
      moveSelectionPolicy: S2_F12_POST_TANK_SOLVENCY_RESCUE_SELECTOR_POLICY,
      baseMoveSelectionPolicy: S2_CONVERSION_QUALIFIED_REN_FINISHER_SELECTOR_POLICY,
      evaluatorPolicy: S2_POST_TANK_SOLVENCY_POLICY,
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
      postTankSolvency: best.solvency,
      rescue: {
        applied: choice.rescued,
        controlCc2Rank: choice.control.cc2Rank,
        controlSolvency: choice.control.solvency.solvency,
        solventCandidates: choice.solventCandidates.length,
        insolventCandidates: candidates.filter((candidate) => candidate.solvency.solvency < 0).length,
      },
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

export function selectS2F12PostTankSolvencyRescuePlacement(guiState, moves, options = {}) {
  return formatS2F12PostTankSolvencyRescueSelection(
    evaluateS2F12PostTankSolvencyRescueCandidates(guiState, moves, options),
  );
}
