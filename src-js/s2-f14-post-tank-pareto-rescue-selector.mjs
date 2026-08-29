import { canonicalize } from "./cs1-core.mjs";
import {
  evaluateS2F12PostTankSolvencyRescueCandidates,
  formatS2F12PostTankSolvencyRescueSelection,
} from "./s2-f12-post-tank-solvency-rescue-selector.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import { evaluateS2SurgeReleaseSpike } from "./s2-surge-release-spike-evaluator.mjs";

export const S2_F14_POST_TANK_PARETO_RESCUE_SELECTOR_POLICY =
  "f14-control-with-post-tank-pareto-rescue-only/1";

function assertCandidateEvidence(candidate) {
  const solvency = candidate?.solvency;
  const realised = candidate?.realisedCombat;
  if (typeof solvency?.solvent !== "boolean" || !Number.isFinite(solvency?.solvency) ||
      typeof solvency?.toppedOut !== "boolean" ||
      typeof solvency?.stateKey !== "string" || solvency.stateKey.length === 0 ||
      typeof solvency?.nextStateKey !== "string" || solvency.nextStateKey.length === 0) {
    throw new Error("F18 rescue requires exact F14 post-tank solvency for every candidate");
  }
  if (!Number.isFinite(realised?.cancelled) || realised.cancelled < 0 ||
      !Number.isFinite(realised?.outgoingAfterCancel) || realised.outgoingAfterCancel < 0 ||
      !Number.isFinite(realised.cancelled + realised.outgoingAfterCancel) ||
      realised.stateKey !== solvency.stateKey || realised.nextStateKey !== solvency.nextStateKey) {
    throw new Error("F18 rescue requires exact canonical realised-combat evidence for every candidate");
  }
}

function identityKey(candidate) {
  if (candidate?.identity === undefined) throw new Error("F18 rescue requires unique candidate identities");
  return canonicalize(candidate.identity);
}

function combatUnits(candidate) {
  return candidate.realisedCombat.cancelled + candidate.realisedCombat.outgoingAfterCancel;
}

/**
 * The candidates remain in immutable F14 base order. F18 is a dominance
 * replacement, not an aggregate score or a new ranking policy.
 */
export function chooseS2F14PostTankParetoRescue(candidates, f14Choice) {
  if (!Array.isArray(candidates) || candidates.length === 0 || f14Choice?.selected === undefined) {
    throw new Error("F18 rescue requires F14-ranked candidates and an F14 control decision");
  }
  candidates.forEach(assertCandidateEvidence);
  const identities = candidates.map(identityKey);
  if (new Set(identities).size !== identities.length) throw new Error("F18 rescue requires unique candidate identities");
  const controlIndex = candidates.indexOf(f14Choice.selected);
  if (controlIndex === -1) throw new Error("F18 rescue F14 control must be one of the exact ranked candidates");
  const control = candidates[controlIndex];
  const controlCombat = combatUnits(control);
  const dominators = candidates.filter((candidate, index) => index !== controlIndex &&
    candidate.solvency.toppedOut === false &&
    combatUnits(candidate) >= controlCombat &&
    candidate.solvency.solvency > control.solvency.solvency);
  return Object.freeze({
    control,
    selected: dominators[0] ?? control,
    rescued: dominators.length > 0,
    dominators,
  });
}

export function selectS2F14PostTankParetoRescuePlacement(guiState, moves, options = {}) {
  const evaluation = evaluateS2F12PostTankSolvencyRescueCandidates(guiState, moves, options);
  const f14 = formatS2F12PostTankSolvencyRescueSelection(evaluation);
  const candidates = evaluation.candidates.map((candidate) => {
    const record = materializeS2NodeRecord(evaluation.base.state, { kind: "placement", placement: candidate.placement }, {
      witnessIdentity: canonicalize(candidate.verification.comparison.witness),
      controllerIdentity: "cc2-final-placement-s2-spin-witness/1",
      budgetIdentity: `cc2-returned-prefix-${evaluation.candidates.length}-ceiling-${evaluation.candidateLimit}-rank-penalty-${evaluation.rankPenalty}`,
    });
    const realisedCombat = evaluateS2SurgeReleaseSpike(evaluation.base.state, record);
    return { ...candidate, realisedCombat };
  });
  const f14Choice = { ...evaluation.choice, selected: candidates[evaluation.candidates.indexOf(evaluation.choice.selected)] };
  const choice = chooseS2F14PostTankParetoRescue(candidates, f14Choice);
  // With no complete proof of dominance, preserve the exact F14 result.
  if (!choice.rescued) return f14;
  const best = choice.selected;
  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison,
      engineId: "s2-f14-post-tank-pareto-rescue-selector/1",
      source: S2_F14_POST_TANK_PARETO_RESCUE_SELECTOR_POLICY,
      moveSelectionPolicy: S2_F14_POST_TANK_PARETO_RESCUE_SELECTOR_POLICY,
      baseMoveSelectionPolicy: "f12-control-with-post-tank-solvency-rescue-only/1",
      selectedCc2Rank: best.cc2Rank,
      postTankSolvency: best.solvency,
      realisedCombat: best.realisedCombat,
      rescue: {
        applied: true,
        controlCc2Rank: choice.control.cc2Rank,
        controlRealisedCombat: combatUnits(choice.control),
        controlSolvency: choice.control.solvency.solvency,
        qualifyingDominators: choice.dominators.length,
      },
    },
    candidates: candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      identity: candidate.identity,
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      conversion: candidate.conversion,
      solvency: candidate.solvency,
      realisedCombat: candidate.realisedCombat,
    })),
  };
}
