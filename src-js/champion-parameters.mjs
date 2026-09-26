import { F14_COMPAT_QUEUE_LIMIT } from "./s2-f14-compat-browser.mjs";
import { canonicalize } from "./cs1-core.mjs";
import { sha256Hex } from "./sha256.mjs";
import { applyPublicCompatDecision, createPublicCompatProfile, createPublicCompatRequest } from "./public-compat-request.mjs";
import { ROOT_LEAF_CONVERSION_GATED_PROFILE } from "./s2-f14-compat-browser.mjs";
import { guiStateToCanonical } from "./gui-state.mjs";
import { fullStateKey } from "./state-keys.mjs";
import { applyTransition } from "./transition.mjs";
import { createF14LeafConversionGatedProfile } from "./s2-f14-compat-browser.mjs";
import { CHAMPION_PROFILE_ARGS, PREVIOUS_CHAMPION_PROFILE_ARGS, SPSA_V1_CHAMPION_PROFILE_ARGS } from "./champion-identity.mjs";
import { EVALUATION_SCORE_SEMANTICS, evaluatorModelIdentity, extractEvaluationFeatures, scoreEvaluationFeatures } from "./evaluation.mjs";

export { CHAMPION_NATIVE_BINARY_SHA256, CHAMPION_PROFILE_ARGS, createChampionBaseProfile } from "./champion-identity.mjs";

// The F14 core admits 1..1,000,000 selections. Its public profile searches a
// queue of up to 28 pieces like the other CC2 bots (the default request keeps
// the 14-piece truncation); the search needs at least one NEXT piece.
export const CHAMPION_SELECTION_MAXIMUM = 1_000_000;
export const CHAMPION_QUEUE_MINIMUM = 2;
export const CHAMPION_QUEUE_MAXIMUM = 28;

/** GUI bots that decide through the F14 core, and the profile each runs at its
 * default budget. The former champions stay for comparison: profile-B
 * (2026-09-16..25), the gated profile at kappa 0.25 (2026-09-25..26) and the
 * SPSA v1 tuned profile (2026-09-26). */
const F14_CORE_BASE_PROFILES = Object.freeze({
  "cc2-s2-champion-profile-b": () => createPublicCompatProfile(),
  "cc2-s2-champion-previous": () => createF14LeafConversionGatedProfile(PREVIOUS_CHAMPION_PROFILE_ARGS),
  "cc2-s2-champion-spsa-v1": () => createF14LeafConversionGatedProfile(SPSA_V1_CHAMPION_PROFILE_ARGS),
  "cc2-s2-champion": () => createF14LeafConversionGatedProfile(CHAMPION_PROFILE_ARGS),
});
export const F14_CORE_BOT_TYPES = Object.freeze(Object.keys(F14_CORE_BASE_PROFILES));
export const PROFILE_B_PROFILE_ID = "f14-amount-only-compat-b/1";

export function isF14CoreType(type) {
  return Object.hasOwn(F14_CORE_BASE_PROFILES, type);
}

/** How an analysis response names the core route that decided. */
export function f14CoreVersionName(execution) {
  return execution?.profileId === PROFILE_B_PROFILE_ID ? "F14 core profile-B" : "F14 gated leaf-conversion";
}

/** The profile an F14-core GUI bot runs at its default budget. */
export function f14CoreBaseProfile(type = "cc2-s2-champion") {
  if (!isF14CoreType(type)) throw new Error(`unsupported F14 core bot ${type}`);
  return F14_CORE_BASE_PROFILES[type]();
}

/** The local host's evidence engine id for an F14-core bot. The role name moves
 * when the champion changes and the gated profiles share one profileId, so the
 * id also carries a digest of the whole base profile. */
export function f14CoreEngineId(role, type) {
  const profile = f14CoreBaseProfile(type);
  return `${role}/${profile.profileId}+${sha256Hex(canonicalize(profile)).slice(0, 12)}`;
}

/**
 * The champion's gated leaf-conversion F14 execution for GUI parameters. Its defaults
 * (512 selections, THINK TIME off, queue 14) are exactly the champion.
 * THINK TIME becomes a host-clocked time budget with SELECTION as its cap;
 * only the WASM core runs it. `type` picks another gated-core bot's profile.
 */
export function createChampionProfile(parameters, type = "cc2-s2-champion") {
  assertChampionParameters(parameters);
  const base = f14CoreBaseProfile(type);
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

export function createChampionRequest(state, parameters, { requestId, generation = 1, type = "cc2-s2-champion" } = {}) {
  return extendChampionQueue(createPublicCompatRequest(championVisibleState(state, parameters.queueDepth),
    { requestId, generation, profile: createChampionProfile(parameters, type) }), parameters.queueDepth);
}

/**
 * Verify the core's decision against the position it was shown, then apply it
 * to the full position. Same result shape as resolvePublicCompatDecision.
 */
export function resolveChampionDecision({ state, gui, request, response, parameters, type = "cc2-s2-champion" }) {
  if (fullStateKey(guiStateToCanonical(gui)) !== fullStateKey(state)) throw new Error("champion GUI state mismatch");
  const expected = createChampionRequest(state, parameters, { requestId: request.requestId, generation: request.generation, type });
  if (canonicalize(request) !== canonicalize(expected)) throw new Error("champion request does not match its position and parameters");
  assertF14CoreResponse(request, response);
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
  const comparison = { source: request.execution.profileId, status: "degraded",
    reasons: ["movement-model-unavailable"], positionFingerprint,
    rulesetId: state.rulesetId, witness: { kind: "native-selected-placement", placement },
    evaluator: evaluatorModelIdentity(), scoreSemantics: EVALUATION_SCORE_SEMANTICS,
    features, score: scoreEvaluationFeatures(features) };
  return { placement, transition, positionFingerprint, nativeDecision: response, score: comparison.score, comparison,
    verification: { status: "degraded", reasons: comparison.reasons, transition, comparison } };
}

/** Checks an F14-core decision by the profile it was asked with: the gated
 * profiles keep CC2 rank order with the root rescue veto; profile-B returns
 * the core's own F14 ranking, and its queue-prefix rerank is not offered. */
export function assertF14CoreResponse(request, response, { allowQueuePrefix = false } = {}) {
  if (request.execution?.profileId !== PROFILE_B_PROFILE_ID) {
    assertGatedChampionResponse(request, response, { allowQueuePrefix });
    return;
  }
  if (response?.profileId !== PROFILE_B_PROFILE_ID) throw new Error("profile-B decision must use its own profile");
  if (allowQueuePrefix || Object.hasOwn(response?.search ?? {}, "searchedQueueLength")) {
    throw new Error("profile-B decision unexpectedly reports a prefix search");
  }
  if (response.status !== "move") return;
  // The core lists its ranked candidates in ranked order; `identities` is that
  // order and `returnedIdentities` is CC2 order, which a `cc2Rank` indexes.
  const { identities, returnedIdentities, candidates, selectedCc2Rank, rescueApplied } = response.ranking ?? {};
  if (!Array.isArray(identities) || !Array.isArray(returnedIdentities) || !Array.isArray(candidates)
      || identities.length === 0 || candidates.length !== identities.length
      || typeof rescueApplied !== "boolean" || !Number.isSafeInteger(selectedCc2Rank)) {
    throw new Error("profile-B decision has an incomplete F14 ranking");
  }
  const ranks = new Set();
  candidates.forEach((candidate, index) => {
    if (!Number.isSafeInteger(candidate?.cc2Rank) || candidate.cc2Rank < 0 || candidate.cc2Rank >= returnedIdentities.length
        || ranks.has(candidate.cc2Rank) || typeof candidate.solvent !== "boolean"
        || !Number.isFinite(candidate.solvency) || !Number.isFinite(candidate.selectionScore)
        || identities[index] !== returnedIdentities[candidate.cc2Rank]) {
      throw new Error("profile-B decision has invalid F14 ranking candidates");
    }
    ranks.add(candidate.cc2Rank);
  });
  // Rust choose_rescue on the ranked order: rescue iff the top ranked entry
  // has negative solvency and some entry is solvent; then the first solvent.
  const firstSolvent = candidates.findIndex((candidate) => candidate.solvent);
  const rescued = candidates[0].solvency < 0 && firstSolvent >= 0;
  const selected = rescued ? firstSolvent : 0;
  if (rescueApplied !== rescued || selectedCc2Rank !== candidates[selected].cc2Rank
      || response.selectedIdentity !== identities[selected]) {
    throw new Error("profile-B decision does not select by its ranking and rescue");
  }
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
