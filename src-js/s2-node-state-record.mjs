import { canonicalize } from "./cs1-core.mjs";
import { extractEvaluationFeatures, FEATURE_SCHEMA_SHA256 } from "./evaluation.mjs";
import { fullStateKey } from "./state-keys.mjs";
import { applyTransition } from "./transition.mjs";

export const S2_NODE_STATE_RECORD_SCHEMA = "s2-analysis-engine/s2-node-state-record/1";

export function materializeS2NodeRecord(state, action, options = {}) {
  const transition = applyTransition(structuredClone(state), structuredClone(action), state.rulesetId);
  if (transition.legality?.legal !== true || transition.nextState === null) {
    throw new Error("cannot materialize an illegal S2 node transition");
  }
  const features = extractEvaluationFeatures(transition);
  return {
    $schema: S2_NODE_STATE_RECORD_SCHEMA,
    schemaVersion: 1,
    releaseEvidence: false,
    stateKey: fullStateKey(state),
    nextStateKey: fullStateKey(transition.nextState),
    action: structuredClone(action),
    witnessIdentity: options.witnessIdentity ?? null,
    controllerIdentity: options.controllerIdentity ?? null,
    budgetIdentity: options.budgetIdentity ?? null,
    featureSchemaSha256: FEATURE_SCHEMA_SHA256,
    features,
  };
}

export function replayAndVerifyS2NodeRecord(state, record) {
  if (record?.$schema !== S2_NODE_STATE_RECORD_SCHEMA || record.schemaVersion !== 1) {
    throw new Error("unsupported S2 node-state record schema");
  }
  if (record.releaseEvidence !== false) throw new Error("node-state records cannot be release evidence");
  if (record.stateKey !== fullStateKey(state)) throw new Error("node-state record source key mismatch");
  const replayed = materializeS2NodeRecord(state, record.action, {
    witnessIdentity: record.witnessIdentity,
    controllerIdentity: record.controllerIdentity,
    budgetIdentity: record.budgetIdentity,
  });
  if (replayed.nextStateKey !== record.nextStateKey) throw new Error("node-state next key mismatch");
  if (canonicalize(replayed.features) !== canonicalize(record.features)) {
    throw new Error("node-state feature vector mismatch");
  }
  return replayed;
}
