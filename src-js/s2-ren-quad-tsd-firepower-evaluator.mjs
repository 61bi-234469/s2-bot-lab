import { applyTransition } from "./transition.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";

export const S2_REN_QUAD_TSD_FIREPOWER_EVALUATOR_ID =
  "s2-ren-quad-tsd-firepower-evaluator/1";
export const S2_REN_QUAD_TSD_FIREPOWER_POLICY =
  "exact-ren-quad-tsd-realised-combat-garbage-bonus-attribution/1";

export function evaluateS2RenQuadTsdFirepower(state, record) {
  if (state?.chain?.fidelity !== "exact" || !Number.isSafeInteger(state.chain.combo) || state.chain.combo < 0) {
    throw new Error("REN Quad/TSD evaluator requires an exact source chain state");
  }
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  const transition = applyTransition(structuredClone(state), structuredClone(record.action), state.rulesetId);
  if (transition.legality?.legal !== true || transition.nextState === null) {
    throw new Error("REN Quad/TSD evaluator replay produced no legal transition");
  }
  return Object.freeze({
    stateKey: replayed.stateKey,
    nextStateKey: replayed.nextStateKey,
    ...extractS2RenQuadTsdFirepower(state.chain.combo, transition),
    evaluator: Object.freeze({
      id: S2_REN_QUAD_TSD_FIREPOWER_EVALUATOR_ID,
      policy: S2_REN_QUAD_TSD_FIREPOWER_POLICY,
      direction: "higher-is-better",
      source: "replay-verified canonical S2 clear, attack, and cancellation stages",
    }),
  });
}

/** Pure projection of canonical results; it never calculates an attack bonus. */
export function extractS2RenQuadTsdFirepower(comboBefore, transition) {
  if (!Number.isSafeInteger(comboBefore) || comboBefore < 0 || transition?.legality?.legal !== true) {
    throw new Error("REN Quad/TSD extraction requires a legal canonical transition and combo");
  }
  const comboAfter = transition.chain?.comboAfter ?? transition.nextState?.chain?.combo;
  const lines = transition.lockResult?.lines;
  const spin = transition.lockResult?.spin;
  const outgoingAfterCancel = transition.cancelResult?.outgoingAfterCancel;
  const cancelled = transition.cancelResult?.cancelled;
  const specialBonus = transition.attackStages?.specialBonus;
  if (!Number.isSafeInteger(comboAfter) || comboAfter < 0 || !Number.isSafeInteger(lines) || lines < 0 ||
    !["none", "mini", "normal"].includes(spin) || !Number.isFinite(outgoingAfterCancel) || outgoingAfterCancel < 0 ||
    !Number.isFinite(cancelled) || cancelled < 0 || !Number.isFinite(specialBonus) || specialBonus < 0) {
    throw new Error("REN Quad/TSD extraction received malformed canonical attack stages");
  }
  const clearKind = lines === 4 && spin === "none" ? "quad" :
    lines === 2 && spin === "normal" ? "tsd" : "other";
  const activeRen = comboBefore >= 1 && comboAfter > comboBefore;
  const realisedCombat = outgoingAfterCancel + cancelled;
  const baseUnits = clearKind === "quad" ? 0.75 : clearKind === "tsd" ? 1.0 : 0;
  // specialBonus is intentionally attribution only.  It already participated
  // in the canonical outgoing value and would be double-counted as a weight.
  const units = activeRen ? baseUnits * Math.min(1, realisedCombat / 4) : 0;
  return Object.freeze({
    clearKind,
    activeRen,
    comboBefore,
    comboAfter,
    realisedCombat,
    outgoingAfterCancel,
    cancelled,
    garbageClearBonus: specialBonus,
    units,
  });
}
