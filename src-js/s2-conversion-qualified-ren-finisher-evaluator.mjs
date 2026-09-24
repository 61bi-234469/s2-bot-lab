import { applyTransition } from "./transition.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";
import { renCounterfactualState } from "./s2-ren-quad-tsd-spike-evaluator.mjs";
import { witnessCanonicalNextTsd } from "./s2-mini-to-tsd-witness-evaluator.mjs";
import { evaluateS2SurgeReleaseSpike } from "./s2-surge-release-spike-evaluator.mjs";
import {
  F12_MIN_B2B_BEFORE,
  F12_MIN_RELEASE_VALUE,
  F12_MIN_SURGE_SENT,
  classifyS2ConversionQualifiedRenFinisher,
} from "./s2-conversion-qualified-ren-finisher-classification.mjs";

export const S2_CONVERSION_QUALIFIED_REN_FINISHER_EVALUATOR_ID =
  "s2-conversion-qualified-ren-finisher-evaluator/1";
export const S2_CONVERSION_QUALIFIED_REN_FINISHER_POLICY =
  "exclusive-b2b-bridge-or-high-surge-finisher-ren-selector/1";

// A four-B2B break is deliberately diagnostic-only.  A finisher must both
// break a materially charged chain and realise at least five lines of the
// canonical Surge increment; neither quantity is calculated here by hand.
export { F12_MIN_B2B_BEFORE, F12_MIN_SURGE_SENT, F12_MIN_RELEASE_VALUE, classifyS2ConversionQualifiedRenFinisher };

export function evaluateS2ConversionQualifiedRenFinisher(state, record) {
  if (state?.chain?.fidelity !== "exact" || !Number.isSafeInteger(state.chain.combo) || state.chain.combo < 0 ||
      !Number.isSafeInteger(state.chain.b2b) || state.chain.b2b < 0) {
    throw new Error("F12 evaluator requires an exact source combo and B2B chain state");
  }
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  const actual = applyTransition(structuredClone(state), structuredClone(record.action), state.rulesetId);
  const noRen = applyTransition(renCounterfactualState(state), structuredClone(record.action), state.rulesetId);
  if (actual.legality?.legal !== true || actual.nextState === null ||
      noRen.legality?.legal !== true || noRen.nextState === null) {
    throw new Error("F12 evaluator requires legal actual and no-REN transitions");
  }
  const comboAfter = actual.chain?.comboAfter ?? actual.nextState.chain?.combo;
  const b2bAfter = actual.chain?.b2bAfter ?? actual.nextState.chain?.b2b;
  const lines = actual.lockResult?.lines;
  const spin = actual.lockResult?.spin;
  const cancelled = actual.cancelResult?.cancelled;
  if (!Number.isSafeInteger(comboAfter) || comboAfter < 0 || !Number.isSafeInteger(b2bAfter) || b2bAfter < 0 ||
      !Number.isSafeInteger(lines) || lines < 0 || !["none", "mini", "normal"].includes(spin) ||
      !Number.isFinite(cancelled) || cancelled < 0) {
    throw new Error("F12 evaluator received malformed canonical stages");
  }
  const continuingRen = state.chain.combo >= 1 && comboAfter > state.chain.combo;
  const difficultClear = (lines === 4 && spin === "none") || (lines === 2 && spin === "normal");
  const setupClear = (spin === "mini" && lines >= 1) || (spin === "normal" && lines === 1);
  const setupWitness = setupClear ? witnessCanonicalNextTsd(actual.nextState) : noWitness();
  const renCombatGain = realisedCombat(actual) - realisedCombat(noRen);
  const surgeRelease = evaluateS2SurgeReleaseSpike(state, record);
  const classified = classifyS2ConversionQualifiedRenFinisher({
    comboBefore: state.chain.combo, comboAfter, b2bBefore: state.chain.b2b, b2bAfter,
    lines, spin, cancelled, renCombatGain, setupWitnessed: setupWitness.witnessed,
    surgeSent: surgeRelease.surgeSent, releaseValue: surgeRelease.releaseValue,
  });
  return Object.freeze({
    stateKey: replayed.stateKey, nextStateKey: replayed.nextStateKey,
    ...classified, comboBefore: state.chain.combo, comboAfter, b2bBefore: state.chain.b2b, b2bAfter,
    lines, spin, cancelled, continuingRen, difficultClear, setupClear, setupWitness,
    renCombatGain, surgeRelease,
    evaluator: Object.freeze({
      id: S2_CONVERSION_QUALIFIED_REN_FINISHER_EVALUATOR_ID,
      policy: S2_CONVERSION_QUALIFIED_REN_FINISHER_POLICY,
      direction: "higher-is-better",
    }),
  });
}

function noWitness() {
  return Object.freeze({ tAvailable: false, scanned: 0, witnessed: false });
}

function realisedCombat(transition) {
  const outgoing = transition.cancelResult?.outgoingAfterCancel;
  const cancelled = transition.cancelResult?.cancelled;
  if (!Number.isFinite(outgoing) || outgoing < 0 || !Number.isFinite(cancelled) || cancelled < 0) {
    throw new Error("F12 evaluator received malformed cancellation stages");
  }
  return outgoing + cancelled;
}
