import {
  assertF14Response,
  createF14CompatProfile,
  createF14DecideRequest,
  f14DecisionFromCanonical,
} from "./s2-f14-compat-browser.mjs";
import { createS2AmountOnlyDecisionState } from "./s2-amount-only-decision-state.mjs";
import { applyTransition } from "./transition.mjs";
import { fullStateKey } from "./state-keys.mjs";
import { deepEqual } from "./deep-equal.mjs";
import { cc2MoveToCanonicalPlacement } from "./cc2-s2-adapter.mjs";
import { QUALIFIED_STATIC_CC2_RESOLVER_POLICY } from "./s2-amount-only-public-resolver.mjs";
import { listS2AmountOnlyPublicReachablePlacements, selectS2AmountOnlyPublicCandidate } from "./s2-amount-only-public-candidates.mjs";
import { guiStateToCanonical } from "./gui-state.mjs";
import { EVALUATION_SCORE_SEMANTICS, evaluatorModelIdentity, extractEvaluationFeatures, scoreEvaluationFeatures } from "./evaluation.mjs";
import { canonicalize } from "./cs1-core.mjs";

export function createPublicCompatProfile() {
  return Object.freeze({ ...createF14CompatProfile({ seed: "5994928009864282113" }),
    profileId: "f14-amount-only-compat-b/1" });
}

export function createPublicCompatRequest(state, { requestId, generation = 1, profile = createPublicCompatProfile() } = {}) {
  const request = createF14DecideRequest(f14DecisionFromCanonical(state), profile, { requestId, generation });
  request.selector.incoming = structuredClone(createS2AmountOnlyDecisionState(state).incoming);
  return request;
}

function sameRotationEvidence(left, right) {
  if (left.lastInputWasRotation !== right.lastInputWasRotation || left.kickIndex !== right.kickIndex
      || left.kickId !== right.kickId) return false;
  if (left.kickOffset === null || right.kickOffset === null) return left.kickOffset === right.kickOffset;
  return left.kickOffset[0] === right.kickOffset[0] && left.kickOffset[1] === right.kickOffset[1];
}

export function applyPublicCompatDecision(state, request, response) {
  if (!deepEqual(request, createPublicCompatRequest(state, { ...request, profile: request.execution }))) throw new Error("public compat source state mismatch");
  assertF14Response(request, response);
  if (response.status !== "move") throw new Error(`public compat ${response.status}: ${response.reason}`);
  const pose = placement => [placement.piece, placement.rotation, placement.x, placement.y, placement.usedHold];
  const requested = cc2MoveToCanonicalPlacement({ queue: [state.pieces.current] }, response.selectedMove);
  const placement = response.selectedPlacement;
  if (canonicalize(response.selectedMove) !== response.selectedIdentity || !deepEqual(pose(requested), pose(placement))) {
    throw new Error("public compat selected move/placement mismatch");
  }
  const evidence = placement.rotationEvidence;
  if (evidence.lastInputWasRotation
    ? !listS2AmountOnlyPublicReachablePlacements(request.selector).some(candidate =>
      deepEqual(pose(candidate), pose(placement)) && sameRotationEvidence(candidate.rotationEvidence, evidence))
    : !sameRotationEvidence(evidence, requested.rotationEvidence)) {
    throw new Error("public compat rotation witness mismatch");
  }
  const applicationState = state.pieces.holdAvailable === undefined
    ? { ...state, pieces: { ...state.pieces, holdAvailable: request.selector.pieces.holdAvailable } }
    : state;
  const transition = applyTransition(applicationState, { kind: "placement", placement: response.selectedPlacement }, state.rulesetId);
  if (transition.legality?.legal !== true || transition.nextState === null) throw new Error("public compat illegal selected placement");
  return { placement: response.selectedPlacement, transition, positionFingerprint: fullStateKey(state), nativeDecision: response };
}

export function assertPublicCompatParameters(parameters) {
  if (parameters.selectionEnabled !== true || parameters.selectionLimit !== 512
      || parameters.thinkTimeEnabled !== false || parameters.queueDepth !== 14) {
    throw new Error("F14 public profile B requires 512 selections, queue depth 14 and THINK TIME off");
  }
}

export function resolvePublicCompatDecision({ state, gui, request, response }) {
  if (fullStateKey(guiStateToCanonical(gui)) !== fullStateKey(state)) throw new Error("public compat GUI state mismatch");
  const applied = applyPublicCompatDecision(state, request, response);
  const features = extractEvaluationFeatures(applied.transition);
  const comparison = { source: "f14-amount-only-compat-b/1", status: "degraded",
    reasons: ["movement-model-unavailable"], positionFingerprint: applied.positionFingerprint,
    rulesetId: state.rulesetId, witness: { kind: "native-selected-placement", placement: applied.placement },
    evaluator: evaluatorModelIdentity(), scoreSemantics: EVALUATION_SCORE_SEMANTICS,
    features, score: scoreEvaluationFeatures(features) };
  return { ...applied, score: comparison.score, comparison,
    verification: { status: "degraded", reasons: comparison.reasons, transition: applied.transition, comparison } };
}

export function selectPublicCompatReference(gui, moves) {
  const state = guiStateToCanonical(gui);
  const selected = selectS2AmountOnlyPublicCandidate(createS2AmountOnlyDecisionState(state), moves,
    { ...QUALIFIED_STATIC_CC2_RESOLVER_POLICY, allowCompleteReturnedPrefix: true });
  const transition = applyTransition(state, { kind: "placement", placement: selected.placement }, state.rulesetId);
  if (transition.legality?.legal !== true || transition.nextState === null) throw new Error("public reference illegal selected placement");
  return { ...selected, transition };
}
