import { canonicalize } from "./cs1-core.mjs";
import {
  evaluateS2F12PostTankSolvencyRescueCandidates,
  formatS2F12PostTankSolvencyRescueSelection,
} from "./s2-f12-post-tank-solvency-rescue-selector.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import { evaluateS2SurgeReleaseSpike } from "./s2-surge-release-spike-evaluator.mjs";

export const S2_F21_B2B_SURGE_OFFENSIVE_TIER_SELECTOR_POLICY =
  "f21-b2b-surge-offensive-tier-only/1";

function assertEvidence(candidate) {
  const solvency = candidate?.solvency;
  const surge = candidate?.surgeRelease;
  if (candidate?.identity === undefined || typeof solvency?.toppedOut !== "boolean" ||
      typeof solvency?.stateKey !== "string" || solvency.stateKey.length === 0 ||
      typeof solvency?.nextStateKey !== "string" || solvency.nextStateKey.length === 0 ||
      !Number.isSafeInteger(surge?.b2bAfter) || surge.b2bAfter < 0 ||
      !Number.isSafeInteger(surge?.surgeSent) || surge.surgeSent < 0 ||
      surge.stateKey !== solvency.stateKey || surge.nextStateKey !== solvency.nextStateKey) {
    throw new Error("F21 selector requires exact canonical top-out, B2B, and Surge evidence");
  }
}

export function classifyS2F21B2bSurgeOffensiveTier(candidate) {
  assertEvidence(candidate);
  if (candidate.surgeRelease.b2bAfter > 0) return 3;
  if (candidate.surgeRelease.surgeSent >= 20) return 2;
  if (candidate.surgeRelease.surgeSent >= 10) return 1;
  return 0;
}

function offensivePriority(candidate) {
  const tier = classifyS2F21B2bSurgeOffensiveTier(candidate);
  return Object.freeze({
    units: tier,
    tier,
    b2bRetained: candidate.surgeRelease.b2bAfter > 0,
    surgeBand: tier === 2 ? "high-20-plus" : tier === 1 ? "medium-10-plus" : "none",
  });
}

export function chooseS2F21B2bSurgeOffensiveTier(candidates, f14Choice) {
  if (!Array.isArray(candidates) || candidates.length === 0 || f14Choice?.selected === undefined) {
    throw new Error("F21 selector requires F14-ranked candidates and an F14 control decision");
  }
  candidates.forEach(assertEvidence);
  const identities = candidates.map((candidate) => canonicalize(candidate.identity));
  if (new Set(identities).size !== identities.length) {
    throw new Error("F21 selector requires unique candidate identities");
  }
  const controlIndex = candidates.indexOf(f14Choice.selected);
  if (controlIndex < 0) throw new Error("F21 control must be one of the exact ranked candidates");
  const control = candidates[controlIndex];
  const controlTier = classifyS2F21B2bSurgeOffensiveTier(control);
  const alternatives = candidates.filter((candidate, index) =>
    index !== controlIndex && candidate.solvency.toppedOut === false);
  const highestTier = alternatives.reduce(
    (highest, candidate) => Math.max(highest, classifyS2F21B2bSurgeOffensiveTier(candidate)),
    controlTier,
  );
  const prioritized = highestTier > controlTier
    ? alternatives.filter((candidate) => classifyS2F21B2bSurgeOffensiveTier(candidate) === highestTier)
    : [];
  return Object.freeze({
    control,
    selected: prioritized[0] ?? control,
    controlTier,
    selectedTier: prioritized.length > 0 ? highestTier : controlTier,
    prioritized: prioritized.length > 0,
    alternatives: prioritized,
  });
}

export function selectS2F21B2bSurgeOffensiveTierPlacement(guiState, moves, options = {}) {
  const evaluation = evaluateS2F12PostTankSolvencyRescueCandidates(guiState, moves, options);
  const f14 = formatS2F12PostTankSolvencyRescueSelection(evaluation);
  const candidates = evaluation.candidates.map((candidate) => {
    const record = materializeS2NodeRecord(evaluation.base.state, { kind: "placement", placement: candidate.placement }, {
      witnessIdentity: canonicalize(candidate.verification.comparison.witness),
      controllerIdentity: "cc2-final-placement-s2-spin-witness/1",
      budgetIdentity: `cc2-returned-prefix-${evaluation.candidates.length}-ceiling-${evaluation.candidateLimit}-rank-penalty-${evaluation.rankPenalty}`,
    });
    const surgeRelease = evaluateS2SurgeReleaseSpike(evaluation.base.state, record);
    const enriched = { ...candidate, surgeRelease };
    return { ...enriched, offensivePriority: offensivePriority(enriched) };
  });
  const f14Choice = {
    ...evaluation.choice,
    selected: candidates[evaluation.candidates.indexOf(evaluation.choice.selected)],
  };
  const choice = chooseS2F21B2bSurgeOffensiveTier(candidates, f14Choice);
  if (!choice.prioritized) return f14;
  const selected = choice.selected;
  return {
    ...selected.verification,
    move: structuredClone(selected.move),
    comparison: {
      ...selected.verification.comparison,
      engineId: "s2-f21-b2b-surge-offensive-tier-selector/1",
      source: S2_F21_B2B_SURGE_OFFENSIVE_TIER_SELECTOR_POLICY,
      moveSelectionPolicy: S2_F21_B2B_SURGE_OFFENSIVE_TIER_SELECTOR_POLICY,
      baseMoveSelectionPolicy: "f12-control-with-post-tank-solvency-rescue-only/1",
      selectedCc2Rank: selected.cc2Rank,
      surgeRelease: selected.surgeRelease,
      offensivePriority: selected.offensivePriority,
      priority: {
        applied: true,
        controlCc2Rank: choice.control.cc2Rank,
        controlTier: choice.controlTier,
        selectedTier: choice.selectedTier,
        qualifyingAlternatives: choice.alternatives.length,
      },
    },
    candidates: candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      identity: candidate.identity,
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      conversion: candidate.conversion,
      solvency: candidate.solvency,
      surgeRelease: candidate.surgeRelease,
      offensivePriority: candidate.offensivePriority,
    })),
  };
}

