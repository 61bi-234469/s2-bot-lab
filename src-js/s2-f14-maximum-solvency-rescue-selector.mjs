import {
  S2_F12_POST_TANK_SOLVENCY_RESCUE_SELECTOR_POLICY,
  evaluateS2F12PostTankSolvencyRescueCandidates,
  formatS2F12PostTankSolvencyRescueSelection,
} from "./s2-f12-post-tank-solvency-rescue-selector.mjs";
import { S2_POST_TANK_SOLVENCY_POLICY } from "./s2-post-tank-solvency-evaluator.mjs";

export const S2_F14_MAXIMUM_SOLVENCY_RESCUE_SELECTOR_POLICY =
  "f14-control-with-maximum-post-tank-solvency-rescue-only/1";

function assertCandidateEvidence(candidate) {
  if (typeof candidate?.solvency?.solvent !== "boolean" ||
      !Number.isFinite(candidate.solvency.solvency) ||
      typeof candidate.solvency.toppedOut !== "boolean") {
    throw new Error("F16 rescue requires exact F14 post-tank solvency for every candidate");
  }
}

export function chooseS2F14MaximumSolvencyRescue(candidates, f14Choice) {
  if (!Array.isArray(candidates) || candidates.length === 0 || f14Choice?.selected === undefined) {
    throw new Error("F16 rescue requires F14-ranked candidates and an F14 control decision");
  }
  candidates.forEach(assertCandidateEvidence);
  if (!candidates.includes(f14Choice.selected)) {
    throw new Error("F16 rescue F14 control must be one of the exact ranked candidates");
  }
  const triggered = f14Choice.rescued === true;
  const solventCandidates = triggered
    ? candidates.filter((candidate) => candidate.solvency.solvent)
    : [];
  let selected = f14Choice.selected;
  for (const candidate of solventCandidates) {
    if (candidate.solvency.solvency > selected.solvency.solvency) selected = candidate;
  }
  return Object.freeze({
    control: f14Choice.selected,
    selected,
    triggered,
    rescued: selected !== f14Choice.selected,
    solventCandidates,
  });
}

export function selectS2F14MaximumSolvencyRescuePlacement(guiState, moves, options = {}) {
  const evaluation = evaluateS2F12PostTankSolvencyRescueCandidates(guiState, moves, options);
  const f14 = formatS2F12PostTankSolvencyRescueSelection(evaluation);
  const choice = chooseS2F14MaximumSolvencyRescue(evaluation.candidates, evaluation.choice);
  // Preserve the exact F14 bytes whenever its rescue did not occur or its
  // selected candidate already has the greatest exact solvency.
  if (!choice.rescued) return f14;
  const best = choice.selected;
  const controlSolvency = choice.control.solvency.solvency;
  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison,
      engineId: "s2-f14-maximum-solvency-rescue-selector/1",
      source: S2_F14_MAXIMUM_SOLVENCY_RESCUE_SELECTOR_POLICY,
      moveSelectionPolicy: S2_F14_MAXIMUM_SOLVENCY_RESCUE_SELECTOR_POLICY,
      baseMoveSelectionPolicy: S2_F12_POST_TANK_SOLVENCY_RESCUE_SELECTOR_POLICY,
      evaluatorPolicy: S2_POST_TANK_SOLVENCY_POLICY,
      candidateLimit: evaluation.candidateLimit,
      generatedCandidates: evaluation.candidates.length,
      returnedCandidateCount: evaluation.base.returnedCandidateCount,
      completeReturnedPrefix: evaluation.allowCompleteReturnedPrefix,
      selectedCc2Rank: best.cc2Rank,
      rankPenalty: evaluation.rankPenalty,
      adjustmentScale: evaluation.adjustmentScale,
      score: best.s2Score,
      selectionScore: best.selectionScore,
      conversion: best.conversion,
      postTankSolvency: best.solvency,
      rescue: {
        applied: true,
        controlCc2Rank: choice.control.cc2Rank,
        controlSolvency,
        selectedSolvency: best.solvency.solvency,
        solventCandidates: choice.solventCandidates.length,
      },
    },
    candidates: evaluation.candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      identity: candidate.identity,
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      conversion: candidate.conversion,
      solvency: candidate.solvency,
      maximumSolvency: {
        ...candidate.solvency,
        units: candidate.solvency.solvent
          ? candidate.solvency.solvency - controlSolvency
          : 0,
      },
    })),
  };
}
