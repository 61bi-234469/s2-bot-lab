import { applyTransition } from "./transition.mjs";
import { generateReachablePlacements } from "./triangle/move-generation.mjs";
import { resolvePlacementRules } from "./ruleset-profiles.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";

export const S2_MINI_TO_TSD_WITNESS_EVALUATOR_ID = "s2-mini-to-tsd-witness-evaluator/1";
export const S2_MINI_TO_TSD_WITNESS_POLICY = "bounded-canonical-next-t-tsd-witness/1";
export const S2_MINI_TO_TSD_WITNESS_PLACEMENT_CAP = 64;

export function isCanonicalTsd(lockResult) {
  return lockResult?.spin === "normal" && lockResult?.lines === 2;
}

export function tAvailableOnNextState(nextState) {
  const current = nextState?.pieces?.current;
  const hold = nextState?.pieces?.hold;
  const holdAvailable = nextState?.pieces?.holdAvailable === true;
  return current === "T" || (holdAvailable && hold === "T");
}

export function witnessCanonicalNextTsd(nextState, {
  placementCap = S2_MINI_TO_TSD_WITNESS_PLACEMENT_CAP,
} = {}) {
  if (!Number.isSafeInteger(placementCap) || placementCap < 1 || placementCap > 256) {
    throw new Error("next-T TSD witness placement cap must be an integer from 1 to 256");
  }
  if (nextState?.board?.fidelity !== "exact" || nextState?.pieces?.fidelity !== "exact") {
    throw new Error("next-T TSD witness requires exact next board and pieces");
  }
  if (!tAvailableOnNextState(nextState)) {
    return Object.freeze({ tAvailable: false, scanned: 0, witnessed: false });
  }
  const rules = resolvePlacementRules(nextState.rulesetId);
  const tPlacements = generateReachablePlacements(nextState, rules)
    .filter((placement) => placement.piece === "T")
    .slice(0, placementCap);
  let scanned = 0;
  for (const placement of tPlacements) {
    scanned += 1;
    const transition = applyTransition(
      structuredClone(nextState),
      { kind: "placement", placement },
      nextState.rulesetId,
    );
    if (transition.legality?.legal !== true) continue;
    if (isCanonicalTsd(transition.lockResult)) {
      return Object.freeze({ tAvailable: true, scanned, witnessed: true });
    }
  }
  return Object.freeze({ tAvailable: true, scanned, witnessed: false });
}

export function evaluateS2MiniToTsdWitness(state, record) {
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  const transition = applyTransition(structuredClone(state), structuredClone(record.action), state.rulesetId);
  if (transition.legality?.legal !== true || transition.nextState === null) {
    throw new Error("Mini-to-TSD evaluator replay produced no legal transition");
  }
  const lines = transition.lockResult?.lines;
  const spin = transition.lockResult?.spin;
  if (!Number.isSafeInteger(lines) || lines < 0 || !["none", "mini", "normal"].includes(spin)) {
    throw new Error("Mini-to-TSD evaluator received a malformed lock result");
  }
  const currentMini = spin === "mini" && lines >= 1;
  const witness = currentMini
    ? witnessCanonicalNextTsd(transition.nextState)
    : Object.freeze({ tAvailable: false, scanned: 0, witnessed: false });
  const units = currentMini && witness.witnessed ? 1.25 : 0;
  return Object.freeze({
    stateKey: replayed.stateKey,
    nextStateKey: replayed.nextStateKey,
    currentMini,
    lines,
    spin,
    ...witness,
    qualifies: units !== 0,
    units,
    evaluator: Object.freeze({
      id: S2_MINI_TO_TSD_WITNESS_EVALUATOR_ID,
      policy: S2_MINI_TO_TSD_WITNESS_POLICY,
      direction: "higher-is-better",
    }),
  });
}
