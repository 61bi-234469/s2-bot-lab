import { canonicalize } from "./cs1-core.mjs";
import { evaluateS2F12PostTankSolvencyRescueCandidates, formatS2F12PostTankSolvencyRescueSelection } from "./s2-f12-post-tank-solvency-rescue-selector.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import { evaluateS2SurgeReleaseSpike } from "./s2-surge-release-spike-evaluator.mjs";

export const S2_F19_CONTROL_SAFETY_DOMINANCE_VETO_SELECTOR_POLICY = "f19-control-safety-dominance-veto-only/1";

const combatUnits = (candidate) => candidate.realisedCombat.cancelled + candidate.realisedCombat.outgoingAfterCancel;

function assertEvidence(candidate) {
  const solvency = candidate?.solvency;
  const combat = candidate?.realisedCombat;
  if (typeof solvency?.solvent !== "boolean" || !Number.isFinite(solvency.solvency) ||
      typeof solvency.toppedOut !== "boolean" || typeof solvency.stateKey !== "string" ||
      typeof solvency.nextStateKey !== "string" || solvency.stateKey.length === 0 ||
      solvency.nextStateKey.length === 0 || !Number.isFinite(combat?.cancelled) ||
      !Number.isFinite(combat?.outgoingAfterCancel) || combat.cancelled < 0 || combat.outgoingAfterCancel < 0 ||
      combat.stateKey !== solvency.stateKey || combat.nextStateKey !== solvency.nextStateKey) {
    throw new Error("F19 veto requires exact post-tank solvency and realised-combat evidence");
  }
}

export function chooseS2F19ControlSafetyDominanceVeto(candidates, f14Choice) {
  if (!Array.isArray(candidates) || candidates.length === 0 || f14Choice?.selected === undefined) {
    throw new Error("F19 veto requires F14-ranked candidates and an F14 control decision");
  }
  candidates.forEach(assertEvidence);
  const identities = candidates.map((candidate) => canonicalize(candidate.identity));
  if (new Set(identities).size !== identities.length) throw new Error("F19 veto requires unique candidate identities");
  const controlIndex = candidates.indexOf(f14Choice.selected);
  if (controlIndex < 0) throw new Error("F19 veto control must be one of the exact ranked candidates");
  const control = candidates[controlIndex];
  const triggered = control.solvency.toppedOut || control.solvency.solvency < 0;
  const vetoes = triggered ? candidates.filter((candidate, index) => index !== controlIndex &&
    candidate.solvency.toppedOut === false && candidate.solvency.solvency >= 0 && combatUnits(candidate) >= combatUnits(control)) : [];
  return Object.freeze({ control, selected: vetoes[0] ?? control, triggered, vetoed: vetoes.length > 0, vetoes });
}

export function selectS2F19ControlSafetyDominanceVetoPlacement(guiState, moves, options = {}) {
  const evaluation = evaluateS2F12PostTankSolvencyRescueCandidates(guiState, moves, options);
  const f14 = formatS2F12PostTankSolvencyRescueSelection(evaluation);
  const candidates = evaluation.candidates.map((candidate) => {
    const record = materializeS2NodeRecord(evaluation.base.state, { kind: "placement", placement: candidate.placement }, {
      witnessIdentity: canonicalize(candidate.verification.comparison.witness),
      controllerIdentity: "cc2-final-placement-s2-spin-witness/1",
      budgetIdentity: `cc2-returned-prefix-${evaluation.candidates.length}-ceiling-${evaluation.candidateLimit}-rank-penalty-${evaluation.rankPenalty}`,
    });
    return { ...candidate, realisedCombat: evaluateS2SurgeReleaseSpike(evaluation.base.state, record) };
  });
  const f14Choice = { ...evaluation.choice, selected: candidates[evaluation.candidates.indexOf(evaluation.choice.selected)] };
  const choice = chooseS2F19ControlSafetyDominanceVeto(candidates, f14Choice);
  if (!choice.vetoed) return f14;
  const selected = choice.selected;
  return { ...selected.verification, move: structuredClone(selected.move), comparison: {
    ...selected.verification.comparison, engineId: "s2-f19-control-safety-dominance-veto-selector/1",
    source: S2_F19_CONTROL_SAFETY_DOMINANCE_VETO_SELECTOR_POLICY,
    moveSelectionPolicy: S2_F19_CONTROL_SAFETY_DOMINANCE_VETO_SELECTOR_POLICY,
    baseMoveSelectionPolicy: "f12-control-with-post-tank-solvency-rescue-only/1", selectedCc2Rank: selected.cc2Rank,
    postTankSolvency: selected.solvency, realisedCombat: selected.realisedCombat,
    rescue: { applied: true, controlCc2Rank: choice.control.cc2Rank, controlSolvency: choice.control.solvency.solvency },
  }, candidates: candidates.map((candidate) => ({ cc2Rank: candidate.cc2Rank, identity: candidate.identity,
    s2Score: candidate.s2Score, selectionScore: candidate.selectionScore, conversion: candidate.conversion,
    solvency: candidate.solvency, realisedCombat: candidate.realisedCombat })) };
}
