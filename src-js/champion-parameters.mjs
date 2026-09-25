import { F14_COMPAT_QUEUE_LIMIT } from "./s2-f14-compat-browser.mjs";
import { canonicalize } from "./cs1-core.mjs";
import { applyPublicCompatDecision, createPublicCompatRequest } from "./public-compat-request.mjs";
import { createF14LeafConversionGatedProfile, ROOT_LEAF_CONVERSION_GATED_PROFILE } from "./s2-f14-compat-browser.mjs";
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
 * The champion's gated leaf-conversion F14 execution for GUI parameters. Its defaults
 * (512 selections, THINK TIME off, queue 14) are exactly the champion.
 * THINK TIME becomes a host-clocked time budget with SELECTION as its cap;
 * only the WASM core runs it.
 */
export function createChampionProfile(parameters) {
  assertChampionParameters(parameters);
  const base = createF14LeafConversionGatedProfile({ scale: "0.25", maxHeight: "8" });
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
  if (fullStateKey(guiStateToCanonical(gui)) !== fullStateKey(state)) throw new Error("champion GUI state mismatch");
  const expected = createChampionRequest(state, parameters, { requestId: request.requestId, generation: request.generation });
  if (canonicalize(request) !== canonicalize(expected)) throw new Error("champion request does not match its position and parameters");
  assertGatedChampionResponse(request, response);
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
  const comparison = { source: ROOT_LEAF_CONVERSION_GATED_PROFILE, status: "degraded",
    reasons: ["movement-model-unavailable"], positionFingerprint,
    rulesetId: state.rulesetId, witness: { kind: "native-selected-placement", placement },
    evaluator: evaluatorModelIdentity(), scoreSemantics: EVALUATION_SCORE_SEMANTICS,
    features, score: scoreEvaluationFeatures(features) };
  return { placement, transition, positionFingerprint, nativeDecision: response, score: comparison.score, comparison,
    verification: { status: "degraded", reasons: comparison.reasons, transition, comparison } };
}

export function assertGatedChampionResponse(request, response, { allowQueuePrefix = false } = {}) {
  if (request.execution?.profileId !== ROOT_LEAF_CONVERSION_GATED_PROFILE ||
      response?.profileId !== ROOT_LEAF_CONVERSION_GATED_PROFILE) {
    throw new Error("champion decision must use the gated leaf-conversion profile");
  }
  if (allowQueuePrefix && response.status === "move") {
    const requestedLength = request.start?.queue?.length;
    const searchedLength = requestedLength - 1;
    if (!Number.isSafeInteger(requestedLength) || requestedLength < 2 ||
        response.search?.queueLength !== searchedLength ||
        response.search?.searchedQueueLength !== searchedLength) {
      throw new Error("champion INPUT prefix rerank has invalid searched queue length");
    }
  } else if (Object.hasOwn(response?.search ?? {}, "searchedQueueLength")) {
    throw new Error("champion decision unexpectedly reports a prefix search");
  }
  const diagnostics = response.diagnostics;
  if (diagnostics?.finalOrderPolicyId !== "cc2-rank-order/1") {
    throw new Error("champion decision must use cc2-rank-order/1 final order");
  }
  if (response.status !== "move") return;

  const ranking = response.ranking;
  if (typeof ranking?.rescueApplied !== "boolean" || !Number.isSafeInteger(ranking.selectedCc2Rank) ||
      !Array.isArray(ranking.candidates)) {
    throw new Error("champion decision has an incomplete cc2-rank-order selection");
  }
  // cc2-rank-order/1: the ranked order is the CC2 order itself.
  const { identities, returnedIdentities } = ranking;
  if (!Array.isArray(identities) || !Array.isArray(returnedIdentities) || identities.length === 0
      || identities.length !== returnedIdentities.length
      || identities.some((identity, rank) => identity !== returnedIdentities[rank])) {
    throw new Error("champion decision ranking is not in CC2 rank order");
  }
  const candidatesByRank = new Map();
  for (const candidate of ranking.candidates) {
    if (!Number.isSafeInteger(candidate?.cc2Rank) || candidate.cc2Rank < 0 || candidate.cc2Rank >= identities.length
        || typeof candidate.solvent !== "boolean" || !Number.isFinite(candidate.solvency)
        || candidatesByRank.has(candidate.cc2Rank)) {
      throw new Error("champion decision has invalid cc2-rank-order candidates");
    }
    candidatesByRank.set(candidate.cc2Rank, candidate);
  }
  if (candidatesByRank.size !== identities.length) throw new Error("champion decision candidates do not cover its ranking");
  if (identities[ranking.selectedCc2Rank] !== response.selectedIdentity) throw new Error("champion decision selected identity mismatch");
  // ADR-065 root veto, exactly as Rust choose_rescue: rescue iff CC2 rank 0 has
  // negative solvency and some candidate is solvent; then the first solvent rank.
  const firstSolvent = identities.findIndex((_, rank) => candidatesByRank.get(rank).solvent);
  const rescued = candidatesByRank.get(0).solvency < 0 && firstSolvent >= 0;
  if (ranking.rescueApplied !== rescued || ranking.selectedCc2Rank !== (rescued ? firstSolvent : 0)) {
    throw new Error(rescued ? "champion rescue must select the first solvent CC2 rank"
      : "champion decision without rescue must select CC2 rank 0");
  }
}
