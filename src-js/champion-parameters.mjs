import { F14_COMPAT_QUEUE_LIMIT } from "./s2-f14-compat-browser.mjs";
import { canonicalize } from "./cs1-core.mjs";
import { applyPublicCompatDecision, createPublicCompatProfile, createPublicCompatRequest } from "./public-compat-request.mjs";
import { guiStateToCanonical } from "./gui-state.mjs";
import { fullStateKey } from "./state-keys.mjs";
import { applyTransition } from "./transition.mjs";
import { EVALUATION_SCORE_SEMANTICS, evaluatorModelIdentity, extractEvaluationFeatures, scoreEvaluationFeatures } from "./evaluation.mjs";

// The F14 core admits 1..1,000,000 selections. Its public profile searches a
// queue of up to 28 pieces like the other CC2 bots (the default request keeps
// the 14-piece truncation); the search needs at least one NEXT piece.
export const CHAMPION_SELECTION_MAXIMUM = 1_000_000;
export const CHAMPION_QUEUE_MINIMUM = 2;
export const CHAMPION_QUEUE_MAXIMUM = 28;

/**
 * The champion's F14 profile-B execution for GUI parameters. Its defaults
 * (512 selections, THINK TIME off, queue 14) are exactly the champion.
 * THINK TIME becomes a host-clocked time budget with SELECTION as its cap;
 * only the WASM core runs it.
 */
export function createChampionProfile(parameters) {
  assertChampionParameters(parameters);
  const base = createPublicCompatProfile();
  const selections = parameters.selectionEnabled ? parameters.selectionLimit : CHAMPION_SELECTION_MAXIMUM;
  const budget = parameters.thinkTimeEnabled
    ? { mode: "time", selections, maxMillis: parameters.thinkMs }
    : { ...base.budget, selections };
  return Object.freeze({ ...base, budget: Object.freeze(budget) });
}

export function assertChampionParameters(parameters) {
  if (parameters.selectionEnabled !== true && parameters.thinkTimeEnabled !== true) {
    throw new Error("CC2 S2 champion requires SELECTION or THINK TIME");
  }
  if (parameters.selectionEnabled && (!Number.isSafeInteger(parameters.selectionLimit)
      || parameters.selectionLimit < 1 || parameters.selectionLimit > CHAMPION_SELECTION_MAXIMUM)) {
    throw new Error(`CC2 S2 champion SELECTION LIMIT must be 1-${CHAMPION_SELECTION_MAXIMUM}`);
  }
  if (!Number.isSafeInteger(parameters.queueDepth) || parameters.queueDepth < CHAMPION_QUEUE_MINIMUM || parameters.queueDepth > CHAMPION_QUEUE_MAXIMUM) {
    throw new Error(`CC2 S2 champion QUEUE DEPTH must be ${CHAMPION_QUEUE_MINIMUM}-${CHAMPION_QUEUE_MAXIMUM}`);
  }
}

/** The position the champion is shown: NEXT is cut to QUEUE DEPTH (current included). */
export function championVisibleState(state, queueDepth) {
  if (queueDepth >= F14_COMPAT_QUEUE_LIMIT) return state;
  return { ...state, pieces: { ...state.pieces, known: state.pieces.known.slice(0, queueDepth - 1) } };
}

/** Beyond 14 pieces the search queue grows to QUEUE DEPTH; the selector is unchanged. */
export function extendChampionQueue(request, queueDepth) {
  if (queueDepth <= F14_COMPAT_QUEUE_LIMIT) return request;
  const { current, known } = request.selector.pieces;
  return { ...request, start: { ...request.start, queue: [current, ...known].slice(0, queueDepth) } };
}

export function createChampionRequest(state, parameters, { requestId, generation = 1 } = {}) {
  return extendChampionQueue(createPublicCompatRequest(championVisibleState(state, parameters.queueDepth),
    { requestId, generation, profile: createChampionProfile(parameters) }), parameters.queueDepth);
}

/**
 * Verify the core's decision against the position it was shown, then apply it
 * to the full position. Same result shape as resolvePublicCompatDecision.
 */
export function resolveChampionDecision({ state, gui, request, response, parameters }) {
  if (fullStateKey(guiStateToCanonical(gui)) !== fullStateKey(state)) throw new Error("public compat GUI state mismatch");
  const expected = createChampionRequest(state, parameters, { requestId: request.requestId, generation: request.generation });
  if (canonicalize(request) !== canonicalize(expected)) throw new Error("champion request does not match its position and parameters");
  // A longer queue must come back as the queue the core searched (the core
  // echoes it only beyond 14), so a 14-piece decision cannot stand in for it.
  const queueLength = request.start.queue.length;
  if (response?.search?.queueLength !== (queueLength > F14_COMPAT_QUEUE_LIMIT ? queueLength : undefined)) {
    throw new Error("champion decision was not searched on the requested queue");
  }
  // The shared verifier knows the 14-piece request; the queue was checked above.
  const verified = { ...request, start: { ...request.start, queue: request.start.queue.slice(0, F14_COMPAT_QUEUE_LIMIT) } };
  const { placement } = applyPublicCompatDecision(championVisibleState(state, parameters.queueDepth), verified, response);
  const applicationState = state.pieces.holdAvailable === undefined
    ? { ...state, pieces: { ...state.pieces, holdAvailable: request.selector.pieces.holdAvailable } }
    : state;
  const transition = applyTransition(applicationState, { kind: "placement", placement }, state.rulesetId);
  if (transition.legality?.legal !== true || transition.nextState === null) throw new Error("public compat illegal selected placement");
  const positionFingerprint = fullStateKey(state);
  const features = extractEvaluationFeatures(transition);
  const comparison = { source: "f14-amount-only-compat-b/1", status: "degraded",
    reasons: ["movement-model-unavailable"], positionFingerprint,
    rulesetId: state.rulesetId, witness: { kind: "native-selected-placement", placement },
    evaluator: evaluatorModelIdentity(), scoreSemantics: EVALUATION_SCORE_SEMANTICS,
    features, score: scoreEvaluationFeatures(features) };
  return { placement, transition, positionFingerprint, nativeDecision: response, score: comparison.score, comparison,
    verification: { status: "degraded", reasons: comparison.reasons, transition, comparison } };
}
