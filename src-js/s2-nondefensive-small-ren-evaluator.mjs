import { applyTransition } from "./transition.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";

export const S2_NONDEFENSIVE_SMALL_REN_EVALUATOR_ID = "s2-nondefensive-small-ren-evaluator/1";
export const S2_NONDEFENSIVE_SMALL_REN_POLICY = "exact-nondefensive-small-ordinary-ren-penalty/1";

export function extractS2NondefensiveSmallRen(comboBefore, transition) {
  if (!Number.isSafeInteger(comboBefore) || comboBefore < 0) {
    throw new Error("small-REN extraction requires an exact source combo");
  }
  if (transition?.legality?.legal !== true) {
    throw new Error("small-REN extraction requires a legal canonical transition");
  }
  const comboAfter = transition.chain?.comboAfter ?? transition.nextState?.chain?.combo;
  const lines = transition.lockResult?.lines;
  const spin = transition.lockResult?.spin;
  const cancelled = transition.cancelResult?.cancelled;
  if (!Number.isSafeInteger(comboAfter) || comboAfter < 0 ||
    !Number.isSafeInteger(lines) || lines < 0 ||
    !["none", "mini", "normal"].includes(spin) ||
    !Number.isFinite(cancelled) || cancelled < 0) {
    throw new Error("small-REN extraction received malformed canonical stages");
  }
  const ordinarySmall = spin === "none" && (lines === 1 || lines === 2);
  const continuingRen = comboBefore >= 1 && comboAfter > comboBefore;
  const nonDefensive = cancelled === 0;
  const qualifies = ordinarySmall && continuingRen && nonDefensive;
  return Object.freeze({
    comboBefore,
    comboAfter,
    lines,
    spin,
    cancelled,
    ordinarySmall,
    continuingRen,
    nonDefensive,
    qualifies,
    units: qualifies ? -0.9 : 0,
  });
}

export function evaluateS2NondefensiveSmallRen(state, record) {
  if (state?.chain?.fidelity !== "exact" || !Number.isSafeInteger(state.chain.combo) || state.chain.combo < 0) {
    throw new Error("small-REN evaluator requires an exact source chain state");
  }
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  const transition = applyTransition(structuredClone(state), structuredClone(record.action), state.rulesetId);
  if (transition.legality?.legal !== true || transition.nextState === null) {
    throw new Error("small-REN evaluator replay produced no legal transition");
  }
  return Object.freeze({
    stateKey: replayed.stateKey,
    nextStateKey: replayed.nextStateKey,
    ...extractS2NondefensiveSmallRen(state.chain.combo, transition),
    evaluator: Object.freeze({
      id: S2_NONDEFENSIVE_SMALL_REN_EVALUATOR_ID,
      policy: S2_NONDEFENSIVE_SMALL_REN_POLICY,
      direction: "higher-is-better",
    }),
  });
}
