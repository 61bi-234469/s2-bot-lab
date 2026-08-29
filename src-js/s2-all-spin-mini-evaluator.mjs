import { applyTransition } from "./transition.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";

export const S2_ALL_SPIN_MINI_EVALUATOR_ID = "s2-all-spin-mini-evaluator/1";
export const S2_ALL_SPIN_MINI_POLICY = "exact-all-spin-mini-single-plus-it-mini-penalty/1";

export function extractS2AllSpinMini(piece, lockResult) {
  if (!["I", "J", "L", "O", "S", "T", "Z"].includes(piece)) {
    throw new Error("All-Spin mini extraction requires a canonical piece");
  }
  const lines = lockResult?.lines;
  const spin = lockResult?.spin;
  if (!Number.isSafeInteger(lines) || lines < 0 || lines > 4 || !["none", "mini", "normal"].includes(spin)) {
    throw new Error("All-Spin mini extraction received a malformed lock result");
  }
  const miniSingle = spin === "mini" && lines === 1;
  const itMini = spin === "mini" && (piece === "I" || piece === "T");
  const units = (miniSingle ? 1 : 0) + (itMini ? -0.75 : 0);
  return Object.freeze({
    piece,
    lines,
    spin,
    miniSingle,
    itMini,
    qualifies: units !== 0,
    units,
  });
}

export function evaluateS2AllSpinMini(state, record) {
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  const transition = applyTransition(structuredClone(state), structuredClone(record.action), state.rulesetId);
  if (transition.legality?.legal !== true || transition.nextState === null) {
    throw new Error("All-Spin mini evaluator replay produced no legal transition");
  }
  const piece = record.action?.placement?.piece;
  return Object.freeze({
    stateKey: replayed.stateKey,
    nextStateKey: replayed.nextStateKey,
    ...extractS2AllSpinMini(piece, transition.lockResult),
    evaluator: Object.freeze({
      id: S2_ALL_SPIN_MINI_EVALUATOR_ID,
      policy: S2_ALL_SPIN_MINI_POLICY,
      direction: "higher-is-better",
    }),
  });
}
