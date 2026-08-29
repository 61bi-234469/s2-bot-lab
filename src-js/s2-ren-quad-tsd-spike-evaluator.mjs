import { applyTransition } from "./transition.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";

export const S2_REN_QUAD_TSD_SPIKE_EVALUATOR_ID = "s2-ren-quad-tsd-spike-evaluator/1";
export const S2_REN_QUAD_TSD_SPIKE_POLICY =
  "exact-ren-quad-tsd-realised-combat-minus-no-ren-counterfactual/1";

/**
 * F2R evaluates the canonical realised-combat *increase* a Quad or TSD gets
 * from an active REN, not the clear's total realised combat (the baseline
 * evaluator already scores `outgoingAfterCancel` and `cancelled` directly).
 * It runs the identical placement twice through the S2 Simulator: once from
 * the true source chain state, once from a counterfactual source state whose
 * combo is dropped to the pre-REN value (0). Everything else the Multiplier
 * Combo formula reads — B2B, clear geometry, garbage-clear special bonus,
 * garbage queue, rounding seed — is unchanged between the two runs, so it
 * cancels out of the difference instead of needing a second, hand-written
 * attribution rule.
 */
export function evaluateS2RenQuadTsdSpike(state, record) {
  if (state?.chain?.fidelity !== "exact" || !Number.isSafeInteger(state.chain.combo) || state.chain.combo < 0) {
    throw new Error("REN Quad/TSD spike evaluator requires an exact source chain state");
  }
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  const actualTransition = applyTransition(structuredClone(state), structuredClone(record.action), state.rulesetId);
  if (actualTransition.legality?.legal !== true || actualTransition.nextState === null) {
    throw new Error("REN Quad/TSD spike evaluator replay produced no legal transition");
  }
  const counterfactualTransition = applyTransition(
    renCounterfactualState(state),
    structuredClone(record.action),
    state.rulesetId,
  );
  if (counterfactualTransition.legality?.legal !== true || counterfactualTransition.nextState === null) {
    throw new Error("REN Quad/TSD spike evaluator produced no legal no-REN counterfactual transition");
  }
  return Object.freeze({
    stateKey: replayed.stateKey,
    nextStateKey: replayed.nextStateKey,
    ...extractS2RenQuadTsdSpike(state.chain.combo, actualTransition, counterfactualTransition),
    evaluator: Object.freeze({
      id: S2_REN_QUAD_TSD_SPIKE_EVALUATOR_ID,
      policy: S2_REN_QUAD_TSD_SPIKE_POLICY,
      direction: "higher-is-better",
      source: "replay-verified canonical S2 clear/attack/cancellation, actual vs. no-REN counterfactual combo",
    }),
  });
}

// The only field a no-REN counterfactual changes is the source combo. B2B,
// board, pieces, garbage queue, and time stay exactly as observed so the
// Simulator is the only thing computing the Multiplier Combo difference.
export function renCounterfactualState(state) {
  if (state?.chain?.fidelity !== "exact" || !Number.isSafeInteger(state.chain.combo) || state.chain.combo < 0) {
    throw new Error("REN counterfactual state requires an exact source chain state");
  }
  const counterfactual = structuredClone(state);
  counterfactual.chain.combo = 0;
  return counterfactual;
}

/** Pure projection of two canonical results; it never calculates an attack bonus. */
export function extractS2RenQuadTsdSpike(comboBefore, actualTransition, counterfactualTransition) {
  if (!Number.isSafeInteger(comboBefore) || comboBefore < 0 ||
    actualTransition?.legality?.legal !== true || counterfactualTransition?.legality?.legal !== true) {
    throw new Error("REN Quad/TSD spike extraction requires two legal canonical transitions and a combo");
  }
  const comboAfter = actualTransition.chain?.comboAfter ?? actualTransition.nextState?.chain?.combo;
  const lines = actualTransition.lockResult?.lines;
  const spin = actualTransition.lockResult?.spin;
  const specialBonus = actualTransition.attackStages?.specialBonus;
  const actualRealisedCombat = realisedCombat(actualTransition, "actual");
  const counterfactualRealisedCombat = realisedCombat(counterfactualTransition, "no-REN counterfactual");
  if (!Number.isSafeInteger(comboAfter) || comboAfter < 0 || !Number.isSafeInteger(lines) || lines < 0 ||
    !["none", "mini", "normal"].includes(spin) || !Number.isFinite(specialBonus) || specialBonus < 0) {
    throw new Error("REN Quad/TSD spike extraction received malformed canonical attack stages");
  }

  const clearKind = lines === 4 && spin === "none" ? "quad" :
    lines === 2 && spin === "normal" ? "tsd" : "other";
  const activeRen = comboBefore >= 1 && comboAfter > comboBefore;
  const renSpikeGain = actualRealisedCombat - counterfactualRealisedCombat;
  const qualifies = activeRen && clearKind !== "other" && renSpikeGain > 0;
  const units = qualifies ? renSpikeGain / 4 : 0;
  return Object.freeze({
    clearKind,
    activeRen,
    comboBefore,
    comboAfter,
    actualRealisedCombat,
    counterfactualRealisedCombat,
    renSpikeGain,
    outgoingAfterCancel: actualTransition.cancelResult.outgoingAfterCancel,
    cancelled: actualTransition.cancelResult.cancelled,
    // Attribution only: identical clear geometry makes this bonus identical
    // in the actual and counterfactual runs, so it already cancels out of
    // renSpikeGain and must never be added again as a separate coefficient.
    garbageClearBonus: specialBonus,
    qualifies,
    units,
  });
}

function realisedCombat(transition, label) {
  const outgoingAfterCancel = transition.cancelResult?.outgoingAfterCancel;
  const cancelled = transition.cancelResult?.cancelled;
  if (!Number.isFinite(outgoingAfterCancel) || outgoingAfterCancel < 0 || !Number.isFinite(cancelled) || cancelled < 0) {
    throw new Error(`REN Quad/TSD spike extraction received malformed ${label} cancellation stage`);
  }
  return outgoingAfterCancel + cancelled;
}
