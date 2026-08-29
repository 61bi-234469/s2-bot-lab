import { canonicalize } from "./cs1-core.mjs";
import {
  evaluateS2F12PostTankSolvencyRescueCandidates,
  formatS2F12PostTankSolvencyRescueSelection,
} from "./s2-f12-post-tank-solvency-rescue-selector.mjs";
import { classifyS2F21B2bSurgeOffensiveTier } from "./s2-f21-b2b-surge-offensive-tier-selector.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import { evaluateS2SurgeReleaseSpike } from "./s2-surge-release-spike-evaluator.mjs";

export const S2_F22_HEIGHT_GUARDED_B2B_SURGE_SELECTOR_POLICY =
  "f22-height-guarded-b2b-surge-rescue-only/1";

function assertEvidence(candidate) {
  const features = candidate?.verification?.comparison?.features;
  const solvency = candidate?.solvency;
  const surge = candidate?.surgeRelease;
  if (candidate?.identity === undefined || typeof solvency?.toppedOut !== "boolean" ||
      !Number.isFinite(solvency?.solvency) || typeof solvency?.stateKey !== "string" ||
      typeof solvency?.nextStateKey !== "string" ||
      !Number.isSafeInteger(surge?.b2bAfter) || surge.b2bAfter < 0 ||
      !Number.isSafeInteger(surge?.surgeSent) || surge.surgeSent < 0 ||
      !Number.isSafeInteger(features?.maxHeight) || features.maxHeight < 0 ||
      !Number.isSafeInteger(features?.aggregateHeight) || features.aggregateHeight < 0 ||
      !Number.isSafeInteger(features?.holes) || features.holes < 0 ||
      surge.stateKey !== solvency.stateKey || surge.nextStateKey !== solvency.nextStateKey) {
    throw new Error("F22 selector requires exact canonical defensive, B2B, and Surge evidence");
  }
}

function defensivePriority(candidate, control, applied) {
  return Object.freeze({
    units: applied ? control.features.maxHeight - candidate.features.maxHeight : 0,
    maxHeight: candidate.features.maxHeight,
    aggregateHeight: candidate.features.aggregateHeight,
    holes: candidate.features.holes,
    solvency: candidate.solvency.solvency,
    applied,
  });
}

export function chooseS2F22HeightGuardedB2bSurge(candidates, f14Choice) {
  if (!Array.isArray(candidates) || candidates.length === 0 || f14Choice?.selected === undefined) {
    throw new Error("F22 selector requires F14-ranked candidates and an F14 control decision");
  }
  candidates.forEach(assertEvidence);
  const identities = candidates.map((candidate) => canonicalize(candidate.identity));
  if (new Set(identities).size !== identities.length) {
    throw new Error("F22 selector requires unique candidate identities");
  }
  const controlIndex = candidates.indexOf(f14Choice.selected);
  if (controlIndex < 0) throw new Error("F22 control must be one of the exact ranked candidates");
  const control = candidates[controlIndex];
  const controlTier = classifyS2F21B2bSurgeOffensiveTier(control);
  const eligible = candidates.filter((candidate, index) => index !== controlIndex &&
    candidate.solvency.toppedOut === false &&
    classifyS2F21B2bSurgeOffensiveTier(candidate) > controlTier &&
    candidate.solvency.solvency >= control.solvency.solvency &&
    candidate.features.maxHeight < control.features.maxHeight &&
    candidate.features.aggregateHeight <= control.features.aggregateHeight &&
    candidate.features.holes <= control.features.holes,
  );
  eligible.sort((left, right) =>
    left.features.maxHeight - right.features.maxHeight ||
    left.features.aggregateHeight - right.features.aggregateHeight ||
    left.features.holes - right.features.holes ||
    classifyS2F21B2bSurgeOffensiveTier(right) - classifyS2F21B2bSurgeOffensiveTier(left) ||
    left.cc2Rank - right.cc2Rank ||
    canonicalize(left.identity).localeCompare(canonicalize(right.identity), "en"),
  );
  const selected = eligible[0] ?? control;
  return Object.freeze({
    control,
    selected,
    controlTier,
    selectedTier: classifyS2F21B2bSurgeOffensiveTier(selected),
    rescued: eligible.length > 0,
    eligible,
  });
}

export function selectS2F22HeightGuardedB2bSurgePlacement(guiState, moves, options = {}) {
  const evaluation = evaluateS2F12PostTankSolvencyRescueCandidates(guiState, moves, options);
  const f14 = formatS2F12PostTankSolvencyRescueSelection(evaluation);
  const candidates = evaluation.candidates.map((candidate) => {
    const record = materializeS2NodeRecord(evaluation.base.state, { kind: "placement", placement: candidate.placement }, {
      witnessIdentity: canonicalize(candidate.verification.comparison.witness),
      controllerIdentity: "cc2-final-placement-s2-spin-witness/1",
      budgetIdentity: `cc2-returned-prefix-${evaluation.candidates.length}-ceiling-${evaluation.candidateLimit}-rank-penalty-${evaluation.rankPenalty}`,
    });
    return {
      ...candidate,
      features: candidate.verification.comparison.features,
      surgeRelease: evaluateS2SurgeReleaseSpike(evaluation.base.state, record),
    };
  });
  const f14Choice = { ...evaluation.choice, selected: candidates[evaluation.candidates.indexOf(evaluation.choice.selected)] };
  const choice = chooseS2F22HeightGuardedB2bSurge(candidates, f14Choice);
  if (!choice.rescued) return f14;
  const selected = choice.selected;
  return {
    ...selected.verification,
    move: structuredClone(selected.move),
    comparison: {
      ...selected.verification.comparison,
      engineId: "s2-f22-height-guarded-b2b-surge-selector/1",
      source: S2_F22_HEIGHT_GUARDED_B2B_SURGE_SELECTOR_POLICY,
      moveSelectionPolicy: S2_F22_HEIGHT_GUARDED_B2B_SURGE_SELECTOR_POLICY,
      baseMoveSelectionPolicy: "f12-control-with-post-tank-solvency-rescue-only/1",
      selectedCc2Rank: selected.cc2Rank,
      surgeRelease: selected.surgeRelease,
      defensivePriority: defensivePriority(selected, choice.control, true),
      heightGuard: {
        applied: true,
        controlCc2Rank: choice.control.cc2Rank,
        controlTier: choice.controlTier,
        selectedTier: choice.selectedTier,
        eligibleAlternatives: choice.eligible.length,
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
      defensivePriority: defensivePriority(candidate, choice.control, choice.rescued && candidate === selected),
    })),
  };
}
