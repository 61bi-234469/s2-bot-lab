import { canonicalize } from "./cs1-core.mjs";
import {
  evaluateS2F12PostTankSolvencyRescueCandidates,
  formatS2F12PostTankSolvencyRescueSelection,
} from "./s2-f12-post-tank-solvency-rescue-selector.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import { evaluateS2SurgeReleaseSpike } from "./s2-surge-release-spike-evaluator.mjs";

export const S2_F14_DOMINANCE_SAFE_SURGE_RELEASE_RESCUE_SELECTOR_POLICY =
  "f14-control-with-dominance-safe-nondefensive-surge-release-rescue-only/1";

function assertCandidateEvidence(candidate) {
  const solvency = candidate.solvency;
  const surgeRelease = candidate.surgeRelease;
  if (typeof solvency?.solvent !== "boolean" || !Number.isFinite(solvency?.solvency) ||
      typeof solvency?.toppedOut !== "boolean" ||
      typeof solvency?.stateKey !== "string" || solvency.stateKey.length === 0 ||
      typeof solvency?.nextStateKey !== "string" || solvency.nextStateKey.length === 0) {
    throw new Error("F15 rescue requires exact F14 post-tank solvency for every candidate");
  }
  if (!Number.isSafeInteger(surgeRelease?.surgeSent) || surgeRelease.surgeSent < 0 ||
      !Number.isSafeInteger(surgeRelease?.b2bAfter) || surgeRelease.b2bAfter < 0 ||
      !Number.isFinite(surgeRelease?.cancelled) || surgeRelease.cancelled < 0 ||
      !Number.isFinite(surgeRelease?.outgoingAfterCancel) || surgeRelease.outgoingAfterCancel < 0 ||
      !Number.isFinite(surgeRelease.cancelled + surgeRelease.outgoingAfterCancel) ||
      surgeRelease.stateKey !== solvency.stateKey || surgeRelease.nextStateKey !== solvency.nextStateKey) {
    throw new Error("F15 rescue requires exact canonical Surge and realised-combat evidence for every candidate");
  }
}

function identityKey(candidate) {
  if (candidate?.identity === undefined) throw new Error("F15 rescue requires unique candidate identities");
  return canonicalize(candidate.identity);
}

function realisedCombat(candidate) {
  return candidate.surgeRelease.cancelled + candidate.surgeRelease.outgoingAfterCancel;
}

/**
 * The input remains in immutable F14 base order. This function only chooses a
 * qualifying earlier entry; it never constructs a score or a new ordering.
 */
export function chooseS2F14DominanceSafeSurgeReleaseRescue(candidates, f14Choice) {
  if (!Array.isArray(candidates) || candidates.length === 0 || f14Choice?.selected === undefined) {
    throw new Error("F15 rescue requires F14-ranked candidates and an F14 control decision");
  }
  candidates.forEach(assertCandidateEvidence);
  const identities = candidates.map(identityKey);
  if (new Set(identities).size !== identities.length) throw new Error("F15 rescue requires unique candidate identities");
  const controlIndex = candidates.indexOf(f14Choice.selected);
  if (controlIndex === -1) throw new Error("F15 rescue F14 control must be one of the exact ranked candidates");
  const control = candidates[controlIndex];
  const controlCombat = realisedCombat(control);
  const triggered = control.surgeRelease.surgeSent > 0 && control.surgeRelease.cancelled === 0;
  const dominators = triggered ? candidates.filter((candidate, index) => index !== controlIndex &&
    candidate.surgeRelease.surgeSent === 0 &&
    candidate.surgeRelease.b2bAfter > 0 &&
    realisedCombat(candidate) >= controlCombat &&
    candidate.solvency.solvency >= control.solvency.solvency &&
    candidate.solvency.toppedOut === false) : [];
  return Object.freeze({
    control,
    selected: dominators[0] ?? control,
    triggered,
    rescued: dominators.length > 0,
    dominators,
  });
}

export function selectS2F14DominanceSafeSurgeReleaseRescuePlacement(guiState, moves, options = {}) {
  const evaluation = evaluateS2F12PostTankSolvencyRescueCandidates(guiState, moves, options);
  const f14 = formatS2F12PostTankSolvencyRescueSelection(evaluation);
  const candidates = evaluation.candidates.map((candidate) => {
    const record = materializeS2NodeRecord(evaluation.base.state, { kind: "placement", placement: candidate.placement }, {
      witnessIdentity: canonicalize(candidate.verification.comparison.witness),
      controllerIdentity: "cc2-final-placement-s2-spin-witness/1",
      budgetIdentity: `cc2-returned-prefix-${evaluation.candidates.length}-ceiling-${evaluation.candidateLimit}-rank-penalty-${evaluation.rankPenalty}`,
    });
    return { ...candidate, surgeRelease: evaluateS2SurgeReleaseSpike(evaluation.base.state, record) };
  });
  const f14Choice = { ...evaluation.choice, selected: candidates[evaluation.candidates.indexOf(evaluation.choice.selected)] };
  const choice = chooseS2F14DominanceSafeSurgeReleaseRescue(candidates, f14Choice);
  // This is intentionally a byte-for-byte F14 result whenever F15 has no
  // proof of domination, including when its trigger is absent.
  if (!choice.rescued) return f14;
  const best = choice.selected;
  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison,
      engineId: "s2-f14-dominance-safe-surge-release-rescue-selector/1",
      source: S2_F14_DOMINANCE_SAFE_SURGE_RELEASE_RESCUE_SELECTOR_POLICY,
      moveSelectionPolicy: S2_F14_DOMINANCE_SAFE_SURGE_RELEASE_RESCUE_SELECTOR_POLICY,
      baseMoveSelectionPolicy: "f12-control-with-post-tank-solvency-rescue-only/1",
      selectedCc2Rank: best.cc2Rank,
      postTankSolvency: best.solvency,
      dominanceSafeSurgeRelease: best.surgeRelease,
      rescue: {
        applied: true,
        controlCc2Rank: choice.control.cc2Rank,
        controlRealisedCombat: realisedCombat(choice.control),
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
      dominanceSafeSurgeRelease: candidate.surgeRelease,
    })),
  };
}
