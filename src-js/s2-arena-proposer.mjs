import { canonicalize } from "./cs1-core.mjs";

import {
  EVALUATION_SCORE_SEMANTICS,
  evaluatorModelIdentity,
  extractEvaluationFeatures,
  scoreEvaluationFeatures,
} from "./evaluation.mjs";
import {
  HEADLESS_ARENA_RUNTIME_CAPABILITY,
  evaluateHeadlessArenaRulesetAdmission,
} from "./ruleset-admission.mjs";
import { S2_OBSERVED_MANIFEST, resolvePlacementRules } from "./ruleset-profiles.mjs";
import { fullStateKey } from "./state-keys.mjs";
import { applyTransition } from "./transition.mjs";
import { createArenaProposalCache } from "./arena-proposal-cache.mjs";
import {
  engineFrameContinuationIdentity,
  generateEngineFrameBranchesAtLockFrame,
  prepareEngineFrameContinuationState,
} from "./triangle/engine-frame-move-generation.mjs";

export const S2_ARENA_DEPTH1_ID = "s2-native-exact-lock-depth1/1";
export const S2_ARENA_MOVE_SELECTION_POLICY = "highest-evaluation-then-canonical-placement/1";
export const S2_ARENA_WITNESS_SELECTION_POLICY =
  "shortest-duration-then-controller-canonical-order/1";

const CONTINUATION_BY_RESULT = new WeakMap();
const PROPOSAL_CACHE = createArenaProposalCache({ limit: 256 });

export function proposeS2ArenaDepthOne(state, {
  continuation = null,
  targetLockFrame,
  engineId = S2_ARENA_DEPTH1_ID,
  knownQueue = state?.pieces?.known?.length,
  memoize = true,
  yieldControl = null,
} = {}) {
  if (!Number.isSafeInteger(knownQueue) || knownQueue < 1 || knownQueue > state?.pieces?.known?.length) {
    throw new Error("knownQueue must be an integer within the canonical known queue");
  }
  if (yieldControl !== null && typeof yieldControl !== "function") {
    throw new Error("yieldControl must be null or a function");
  }
  const continuationIdentity = continuation === null
    ? "spawn"
    : engineFrameContinuationIdentity(continuation);
  const cacheKey = JSON.stringify([
    fullStateKey(state), continuationIdentity, targetLockFrame, engineId, knownQueue,
  ]);
  if (memoize) {
    const cached = PROPOSAL_CACHE.get(cacheKey);
    if (cached !== undefined) return cloneCachedProposal(cached);
  }
  const admission = evaluateHeadlessArenaRulesetAdmission(
    S2_OBSERVED_MANIFEST,
    HEADLESS_ARENA_RUNTIME_CAPABILITY,
  );
  if (!admission.admitted) {
    return { status: "unsupported", reasons: admission.degraded, transition: null };
  }
  const rules = resolvePlacementRules(state.rulesetId);
  const candidates = [];
  for (const branch of generateEngineFrameBranchesAtLockFrame(
    state,
    rules,
    continuation,
    targetLockFrame,
    { knownQueue, yieldControl },
  )) {
    const stateAtLock = structuredClone(state);
    stateAtLock.time.logicalFrame = branch.placement.movementEvidence.lockedAtFrame;
    const transition = applyTransition(stateAtLock, { kind: "placement", placement: branch.placement });
    if (!transition.legality.legal) continue;
    const features = extractEvaluationFeatures(transition);
    candidates.push({
      branch,
      transition,
      features,
      score: scoreEvaluationFeatures(features),
    });
  }
  candidates.sort((left, right) =>
    right.score - left.score ||
    canonicalize(left.branch.placement).localeCompare(canonicalize(right.branch.placement), "en")
  );
  const best = candidates[0] ?? null;
  if (best === null) {
    return {
      status: "unsupported",
      reasons: ["s2-depth1-has-no-due-frame-placement"],
      transition: null,
    };
  }
  const projected = prepareEngineFrameContinuationState(best.transition, best.branch.continuation);
  const result = {
    status: "final",
    reasons: [],
    transition: best.transition,
    comparison: {
      source: S2_ARENA_DEPTH1_ID,
      engineId,
      status: "final",
      reasons: [],
      positionFingerprint: fullStateKey(state),
      rulesetId: state.rulesetId,
      witness: best.branch.placement,
      witnessSelectionPolicy: S2_ARENA_WITNESS_SELECTION_POLICY,
      moveSelectionPolicy: S2_ARENA_MOVE_SELECTION_POLICY,
      continuation: {
        identity: engineFrameContinuationIdentity(best.branch.continuation),
        projectedStateFingerprint: fullStateKey(projected),
        frame: projected.time.logicalFrame,
        phase: projected.movement.phase,
      },
      evaluator: evaluatorModelIdentity(),
      scoreSemantics: EVALUATION_SCORE_SEMANTICS,
      features: best.features,
      score: best.score,
      generatedMoves: candidates.length,
    },
  };
  CONTINUATION_BY_RESULT.set(result, structuredClone(best.branch.continuation));
  if (memoize) rememberProposal(cacheKey, result, best.branch.continuation);
  return result;
}

export function s2ArenaContinuationForResult(result) {
  const continuation = CONTINUATION_BY_RESULT.get(result);
  return continuation === undefined ? null : structuredClone(continuation);
}

export function clearS2ArenaProposalCache() {
  PROPOSAL_CACHE.clear();
}

function rememberProposal(key, result, continuation) {
  PROPOSAL_CACHE.set(key, {
    result: structuredClone(result),
    continuation: structuredClone(continuation),
  });
}

function cloneCachedProposal(cached) {
  const result = structuredClone(cached.result);
  CONTINUATION_BY_RESULT.set(result, structuredClone(cached.continuation));
  return result;
}
