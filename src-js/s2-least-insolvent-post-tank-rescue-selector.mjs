import { canonicalize } from "./cs1-core.mjs";
import {
  S2_F12_POST_TANK_SOLVENCY_RESCUE_SELECTOR_POLICY,
  evaluateS2F12PostTankSolvencyRescueCandidates,
  formatS2F12PostTankSolvencyRescueSelection,
} from "./s2-f12-post-tank-solvency-rescue-selector.mjs";
import { S2_POST_TANK_SOLVENCY_POLICY } from "./s2-post-tank-solvency-evaluator.mjs";

export const S2_F14_LEAST_INSOLVENT_RESCUE_SELECTOR_POLICY =
  "f14-control-with-least-insolvent-post-tank-rescue-only/1";

function assertCandidateEvidence(candidate) {
  const solvency = candidate?.solvency;
  if (typeof solvency?.solvent !== "boolean" || !Number.isFinite(solvency?.solvency) ||
      typeof solvency?.toppedOut !== "boolean" ||
      typeof solvency?.stateKey !== "string" || solvency.stateKey.length === 0 ||
      typeof solvency?.nextStateKey !== "string" || solvency.nextStateKey.length === 0) {
    throw new Error("F17 rescue requires exact F14 post-tank solvency for every candidate");
  }
}

function identityKey(candidate) {
  if (candidate?.identity === undefined) throw new Error("F17 rescue requires unique candidate identities");
  return canonicalize(candidate.identity);
}

export function chooseS2F14LeastInsolventRescue(candidates, f14Choice) {
  if (!Array.isArray(candidates) || candidates.length === 0 || f14Choice?.selected === undefined) {
    throw new Error("F17 rescue requires F14-ranked candidates and an F14 control decision");
  }
  candidates.forEach(assertCandidateEvidence);
  const identities = candidates.map(identityKey);
  if (new Set(identities).size !== identities.length) {
    throw new Error("F17 rescue requires unique candidate identities");
  }
  if (!candidates.includes(f14Choice.selected)) {
    throw new Error("F17 rescue F14 control must be one of the exact ranked candidates");
  }
  const control = f14Choice.selected;
  const triggered = f14Choice.rescued !== true && control.solvency.solvency < 0;
  const eligibleCandidates = triggered
    ? candidates.filter((candidate) => candidate.solvency.toppedOut === false)
    : [];
  let selected = control;
  for (const candidate of eligibleCandidates) {
    if (candidate.solvency.solvency > selected.solvency.solvency) selected = candidate;
  }
  return Object.freeze({
    control,
    selected,
    triggered,
    rescued: selected !== control,
    eligibleCandidates,
  });
}

export function selectS2F14LeastInsolventRescuePlacement(guiState, moves, options = {}) {
  const evaluation = evaluateS2F12PostTankSolvencyRescueCandidates(guiState, moves, options);
  const f14 = formatS2F12PostTankSolvencyRescueSelection(evaluation);
  const choice = chooseS2F14LeastInsolventRescue(evaluation.candidates, evaluation.choice);
  // Preserve the complete F14 result whenever the bounded all-insolvent rescue
  // does not strictly improve exact post-tank solvency.
  if (!choice.rescued) return f14;
  const best = choice.selected;
  const controlSolvency = choice.control.solvency.solvency;
  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison,
      engineId: "s2-f14-least-insolvent-rescue-selector/1",
      source: S2_F14_LEAST_INSOLVENT_RESCUE_SELECTOR_POLICY,
      moveSelectionPolicy: S2_F14_LEAST_INSOLVENT_RESCUE_SELECTOR_POLICY,
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
        allCandidatesInsolvent: evaluation.candidates.every((candidate) => !candidate.solvency.solvent),
        eligibleCandidates: choice.eligibleCandidates.length,
      },
    },
    candidates: evaluation.candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      identity: candidate.identity,
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      conversion: candidate.conversion,
      solvency: candidate.solvency,
      leastInsolvent: {
        ...candidate.solvency,
        units: candidate.solvency.toppedOut === false
          ? candidate.solvency.solvency - controlSolvency
          : 0,
      },
    })),
  };
}
