import { applyTransition } from "./transition.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";

export const S2_SURGE_RETENTION_EVALUATOR_ID = "s2-surge-retention-evaluator/1";

export function evaluateS2SurgeRetention(state, record) {
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  const transition = applyTransition(structuredClone(state), structuredClone(record.action), state.rulesetId);
  if (transition.legality?.legal !== true || transition.nextState === null) throw new Error("Surge evaluator replay produced no legal transition");
  const b2bBefore = state.chain?.b2b;
  const b2bAfter = transition.chain?.b2bAfter;
  const surgeSent = (transition.attackStages?.surgeChunks ?? []).reduce((sum, value) => sum + value, 0);
  const cancelled = transition.cancelResult?.cancelled;
  const outgoingAfterCancel = transition.cancelResult?.outgoingAfterCancel;
  if (![b2bBefore, b2bAfter, surgeSent, cancelled, outgoingAfterCancel].every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("Surge evaluator received malformed canonical stages");
  }
  const retained = b2bAfter > b2bBefore && surgeSent === 0;
  const defensiveRelease = surgeSent > 0 && cancelled > 0;
  return Object.freeze({ stateKey: replayed.stateKey, nextStateKey: replayed.nextStateKey, b2bBefore, b2bAfter, surgeSent, cancelled, outgoingAfterCancel,
    units: (retained ? 0.6 : 0) + (defensiveRelease ? 1.1 : 0), retained, defensiveRelease,
    evaluator: Object.freeze({ id: S2_SURGE_RETENTION_EVALUATOR_ID, policy: "exact-b2b-retention-and-defensive-surge/1", direction: "higher-is-better" }) });
}
