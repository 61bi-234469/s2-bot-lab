import { applyTransition } from "./transition.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";
import { renCounterfactualState } from "./s2-ren-quad-tsd-spike-evaluator.mjs";
import { witnessCanonicalNextTsd } from "./s2-mini-to-tsd-witness-evaluator.mjs";

export const S2_REN_QUALITY_EVALUATOR_ID = "s2-ren-quality-evaluator/1";
export const S2_REN_QUALITY_POLICY =
  "exclusive-spike-setup-high-or-defensive-low-ren-quality/1";

export function evaluateS2RenQuality(state, record) {
  if (state?.chain?.fidelity !== "exact" || !Number.isSafeInteger(state.chain.combo) || state.chain.combo < 0) {
    throw new Error("REN quality evaluator requires an exact source chain state");
  }
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  const actual = applyTransition(structuredClone(state), structuredClone(record.action), state.rulesetId);
  const counterfactual = applyTransition(renCounterfactualState(state), structuredClone(record.action), state.rulesetId);
  if (actual.legality?.legal !== true || actual.nextState === null ||
      counterfactual.legality?.legal !== true || counterfactual.nextState === null) {
    throw new Error("REN quality evaluator requires legal actual and no-REN transitions");
  }
  const comboBefore = state.chain.combo;
  const comboAfter = actual.chain?.comboAfter ?? actual.nextState.chain?.combo;
  const lines = actual.lockResult?.lines;
  const spin = actual.lockResult?.spin;
  const cancelled = actual.cancelResult?.cancelled;
  if (!Number.isSafeInteger(comboAfter) || comboAfter < 0 || !Number.isSafeInteger(lines) || lines < 0 ||
      !["none", "mini", "normal"].includes(spin) || !Number.isFinite(cancelled) || cancelled < 0) {
    throw new Error("REN quality evaluator received malformed canonical stages");
  }
  const actualCombat = realisedCombat(actual);
  const counterfactualCombat = realisedCombat(counterfactual);
  const renCombatGain = actualCombat - counterfactualCombat;
  const continuingRen = comboBefore >= 1 && comboAfter > comboBefore;
  const clearKind = lines === 4 && spin === "none" ? "quad" :
    lines === 2 && spin === "normal" ? "tsd" : "other";
  const spike = continuingRen && clearKind !== "other" && renCombatGain > 0;
  const setupClear = (spin === "mini" && lines >= 1) || (spin === "normal" && lines === 1);
  const setupWitness = !spike && setupClear
    ? witnessCanonicalNextTsd(actual.nextState)
    : Object.freeze({ tAvailable: false, scanned: 0, witnessed: false });
  const classified = classifyS2RenQuality({
    comboBefore, comboAfter, lines, spin, cancelled, renCombatGain,
    setupWitnessed: setupWitness.witnessed,
  });
  return Object.freeze({
    stateKey: replayed.stateKey, nextStateKey: replayed.nextStateKey,
    branch: classified.branch, units: classified.units, qualifies: classified.units !== 0, comboBefore, comboAfter,
    displayedRenAfter: Math.max(0, comboAfter - 1), lines, spin, cancelled,
    clearKind, continuingRen, renCombatGain, actualCombat, counterfactualCombat,
    setupClear, setupWitness, highOrDefensive: classified.highOrDefensive,
    lowValue: classified.lowValue,
    evaluator: Object.freeze({
      id: S2_REN_QUALITY_EVALUATOR_ID, policy: S2_REN_QUALITY_POLICY,
      direction: "higher-is-better",
    }),
  });
}

export function classifyS2RenQuality({
  comboBefore, comboAfter, lines, spin, cancelled, renCombatGain, setupWitnessed = false,
}) {
  if (![comboBefore, comboAfter, lines].every(Number.isSafeInteger) || comboBefore < 0 || comboAfter < 0 || lines < 0 ||
      !["none", "mini", "normal"].includes(spin) || !Number.isFinite(cancelled) || cancelled < 0 ||
      !Number.isFinite(renCombatGain) || typeof setupWitnessed !== "boolean") {
    throw new Error("REN quality classification requires canonical finite stages");
  }
  const continuingRen = comboBefore >= 1 && comboAfter > comboBefore;
  const spike = continuingRen && ((lines === 4 && spin === "none") ||
    (lines === 2 && spin === "normal")) && renCombatGain > 0;
  const setupClear = (spin === "mini" && lines >= 1) || (spin === "normal" && lines === 1);
  const highOrDefensive = continuingRen && (comboAfter >= 6 || cancelled > 0);
  const lowValue = spin === "none" && (lines === 1 || lines === 2) && continuingRen &&
    comboAfter < 6 && cancelled === 0;
  if (spike) return Object.freeze({ branch: "ren-quad-tsd-spike", units: renCombatGain / 4, highOrDefensive, lowValue });
  if (setupClear && setupWitnessed) return Object.freeze({ branch: "tss-mini-to-next-t-tsd", units: 1.25, highOrDefensive, lowValue });
  if (highOrDefensive) return Object.freeze({ branch: "high-or-defensive-ren", units: Math.max(0, renCombatGain) / 4, highOrDefensive, lowValue });
  if (lowValue) return Object.freeze({ branch: "low-value-ren", units: -0.45, highOrDefensive, lowValue });
  return Object.freeze({ branch: "other", units: 0, highOrDefensive, lowValue });
}

function realisedCombat(transition) {
  const outgoing = transition.cancelResult?.outgoingAfterCancel;
  const cancelled = transition.cancelResult?.cancelled;
  if (!Number.isFinite(outgoing) || outgoing < 0 || !Number.isFinite(cancelled) || cancelled < 0) {
    throw new Error("REN quality evaluator received malformed cancellation stages");
  }
  return outgoing + cancelled;
}
