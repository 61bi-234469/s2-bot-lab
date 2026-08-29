import {
  DEPTH1_BASELINE_MODEL,
  extractEvaluationFeatures,
  scoreEvaluationFeatures,
} from "./evaluation.mjs";
import { resolvePlacementRules } from "./ruleset-profiles.mjs";
import { fullStateKey } from "./state-keys.mjs";
import { applyTransition } from "./transition.mjs";
import { generateReachablePlacements } from "./triangle/move-generation.mjs";
import { generateEngineFrameTapPlacements } from "./triangle/engine-frame-move-generation.mjs";
import { S2_OBSERVED_MANIFEST } from "./ruleset-profiles.mjs";

export const SEARCH_BASELINE_ID = "s2-reachable-depth1/1";
export const ITERATIVE_SEARCH_BASELINE_ID = "s2-reachable-iterative/1";
export const SUPPORTED_MOVEMENT_ASSUMPTION = "unrestricted-within-kickset";
export const S2_ENGINE_FRAME_MOVEMENT_ASSUMPTION = "engine-frame-with-hidden-spawn-buffer";

export function analyzeDepthOne(state, options = {}) {
  return analyzeIterativeDeepening(state, { ...options, maxDepth: 1 });
}

// Iterations are committed only after every root move has been searched at the
// requested depth. If a deeper iteration runs out of budget, callers receive
// the last complete shallower ranking rather than a mixture of search depths.
export function analyzeIterativeDeepening(state, options = {}) {
  const topN = options.topN ?? 5;
  const maxDepth = options.maxDepth ?? 2;
  const nodeBudget = options.nodeBudget ?? Number.MAX_SAFE_INTEGER;
  const timeBudgetMs = options.timeBudgetMs ?? Number.POSITIVE_INFINITY;
  const now = options.now ?? Date.now;
  const shouldStop = options.shouldStop ?? (() => false);
  const onNode = options.onNode ?? null;
  const deterministicSeed = options.deterministicSeed ?? 0;
  const transpositionTable = options.transpositionTable ?? "off";
  const memoryBudgetBytes = options.memoryBudgetBytes ?? Number.MAX_SAFE_INTEGER;
  const unknownQueue = options.unknownQueue ?? "reject";
  assertOptions({
    topN,
    maxDepth,
    nodeBudget,
    timeBudgetMs,
    now,
    shouldStop,
    onNode,
    deterministicSeed,
    transpositionTable,
    memoryBudgetBytes,
    unknownQueue,
  });

  const movementRules = resolvePlacementRules(state.rulesetId);
  const engineFrameDepthOne = movementRules.movementAssumption === S2_ENGINE_FRAME_MOVEMENT_ASSUMPTION &&
    state.rulesetId === S2_OBSERVED_MANIFEST.id && maxDepth === 1;
  if (movementRules.movementAssumption !== SUPPORTED_MOVEMENT_ASSUMPTION && !engineFrameDepthOne) {
    return unsupportedMovementResult({
      maxDepth,
      deterministicSeed,
      transpositionTable,
      memoryBudgetBytes,
      unknownQueue,
      movementAssumption: movementRules.movementAssumption,
    });
  }
  let rootPlacements;
  try {
    rootPlacements = engineFrameDepthOne
      ? generateEngineFrameTapPlacements(state, movementRules)
      : generateReachablePlacements(state, movementRules);
  } catch (error) {
    if (engineFrameDepthOne) {
      return unsupportedMovementResult({
        maxDepth,
        deterministicSeed,
        transpositionTable,
        memoryBudgetBytes,
        unknownQueue,
        movementAssumption: movementRules.movementAssumption,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  }
  const context = {
    nodeBudget,
    timeBudgetMs,
    now,
    shouldStop,
    onNode,
    startedAt: now(),
    nodes: 0,
    stopReason: null,
    movementRules,
    transpositionTable,
    transpositions: new Map(),
    stateKeys: new WeakMap(),
    transpositionHits: 0,
    transpositionMisses: 0,
    memoryBudgetBytes,
    memoryBytes: memoryBudgetBytes === Number.MAX_SAFE_INTEGER
      ? null
      : deterministicBytes(rootPlacements),
    unknownQueue,
  };
  let candidates = [];
  let completedDepth = 0;
  let attemptedDepth = 0;

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    attemptedDepth = depth;
    const iteration = searchRoot(state, rootPlacements, depth, context);
    if (iteration.complete) {
      candidates = iteration.candidates;
      completedDepth = depth;
      continue;
    }
    // A partially traversed first ply still contains atomic, fully evaluated
    // candidates. At deeper plies it must not replace the complete shallower
    // result because its root scores would have unequal horizons.
    if (completedDepth === 0) candidates = iteration.candidates;
    break;
  }

  candidates.sort(compareCandidates);
  const retained = candidates.slice(0, topN);
  return {
    search: maxDepth === 1 ? SEARCH_BASELINE_ID : ITERATIVE_SEARCH_BASELINE_ID,
    evaluator: evaluatorMetadata(),
    status:
      context.stopReason === null
        ? "final"
        : context.stopReason === "cancelled"
          ? "cancelled"
          : context.stopReason === "unknown-queue"
          ? unknownQueue === "speculate" ? "speculative" : "unsupported"
            : "partial",
    stopReason: context.stopReason,
    deterministicSeed,
    nodes: context.nodes,
    generatedMoves: rootPlacements.length,
    transpositionTable,
    transpositionHits: context.transpositionHits,
    transpositionMisses: context.transpositionMisses,
    transpositionEntries: context.transpositions.size,
    memoryBudgetBytes:
      memoryBudgetBytes === Number.MAX_SAFE_INTEGER ? null : memoryBudgetBytes,
    memoryBytes: context.memoryBytes,
    unknownQueue,
    attemptedDepth,
    completedDepth,
    candidates: retained,
    best: retained[0] ?? null,
  };
}

function unsupportedMovementResult({
  maxDepth,
  deterministicSeed,
  transpositionTable,
  memoryBudgetBytes,
  unknownQueue,
  movementAssumption,
  detail = null,
}) {
  return {
    search: maxDepth === 1 ? SEARCH_BASELINE_ID : ITERATIVE_SEARCH_BASELINE_ID,
    evaluator: evaluatorMetadata(),
    status: "unsupported",
    stopReason: "movement-model",
    degraded: ["movement-model-unavailable"],
    movementAssumption,
    detail,
    deterministicSeed,
    nodes: 0,
    generatedMoves: 0,
    transpositionTable,
    transpositionHits: 0,
    transpositionMisses: 0,
    transpositionEntries: 0,
    memoryBudgetBytes:
      memoryBudgetBytes === Number.MAX_SAFE_INTEGER ? null : memoryBudgetBytes,
    memoryBytes: memoryBudgetBytes === Number.MAX_SAFE_INTEGER ? null : 0,
    unknownQueue,
    attemptedDepth: 0,
    completedDepth: 0,
    candidates: [],
    best: null,
  };
}

function searchRoot(state, placements, depth, context) {
  const candidates = [];
  for (const placement of placements) {
    const candidate = searchPlacement(state, placement, depth, context);
    if (!candidate.complete) return { complete: false, candidates };
    if (candidate.value !== null) candidates.push(candidate.value);
  }
  return { complete: true, candidates };
}

function searchPlacement(state, placement, depth, context) {
  if (!canContinue(context)) return { complete: false, value: null };

  const cacheKey = transpositionKey(state, placement, depth, context);
  if (cacheKey !== null) {
    const cached = context.transpositions.get(cacheKey);
    if (cached !== undefined) {
      context.transpositionHits += 1;
      return cached;
    }
    context.transpositionMisses += 1;
  }

  if (context.nodes >= context.nodeBudget) {
    context.stopReason = "node-budget";
    return { complete: false, value: null };
  }

  const action = { kind: "placement", placement };
  const transitionState = stateAtPlacementClock(state, placement);
  const transition = applyTransition(transitionState, action, state.rulesetId);
  context.nodes += 1;
  if (context.onNode !== null) context.onNode(context.nodes);
  if (context.memoryBytes !== null) {
    // Budget a deterministic, portable proxy rather than a host heap reading:
    // the UTF-8 JSON bytes of each search-owned payload materialized so far.
    // The monotonic count is enforced at atomic Simulator boundaries.
    context.memoryBytes += deterministicBytes(transition);
    if (context.memoryBytes > context.memoryBudgetBytes) {
      context.stopReason = "memory-budget";
      return { complete: false, value: null };
    }
  }
  if (!transition.legality.legal) {
    return commitTransposition(cacheKey, { complete: true, value: null }, context);
  }

  if (depth === 1) {
    return commitTransposition(
      cacheKey,
      { complete: true, value: leafCandidate(action, transition) },
      context,
    );
  }
  if (!hasMoveSource(transition.nextState)) {
    if (transition.nextState.pieces.queueModel.tail === "unknown") {
      // `speculate` deliberately does not invent a bag generator this baseline
      // cannot reproduce. The caller gets the last complete known-prefix
      // iteration with an explicit speculative status; `reject` reports the
      // same horizon boundary as unsupported.
      context.stopReason = "unknown-queue";
      return { complete: false, value: null };
    }
    return commitTransposition(
      cacheKey,
      { complete: true, value: leafCandidate(action, transition) },
      context,
    );
  }

  const children = generateReachablePlacements(transition.nextState, context.movementRules);
  let bestChild = null;
  for (const childPlacement of children) {
    const child = searchPlacement(transition.nextState, childPlacement, depth - 1, context);
    if (!child.complete) return { complete: false, value: null };
    if (child.value !== null && (bestChild === null || compareCandidates(child.value, bestChild) < 0)) {
      bestChild = child.value;
    }
  }

  // A state may have a piece but no reachable hard-drop placement. Treat the
  // root transition as the deepest confirmed leaf instead of inventing a loss
  // rule the Simulator does not define.
  if (bestChild === null) {
    return commitTransposition(
      cacheKey,
      { complete: true, value: leafCandidate(action, transition) },
      context,
    );
  }
  return commitTransposition(cacheKey, {
    complete: true,
    value: {
      action,
      score: bestChild.score,
      features: bestChild.features,
      transition,
      principalVariation: [action, ...bestChild.principalVariation],
      reachedDepth: 1 + bestChild.reachedDepth,
    },
  }, context);
}

function stateAtPlacementClock(state, placement) {
  const lockedAtFrame = placement.movementEvidence?.lockedAtFrame;
  if (lockedAtFrame === undefined) return state;
  if (!Number.isSafeInteger(lockedAtFrame) || lockedAtFrame < state.time.logicalFrame) {
    throw new Error("placement movement evidence has an invalid lock frame");
  }
  const atLock = structuredClone(state);
  atLock.time.logicalFrame = lockedAtFrame;
  return atLock;
}

function transpositionKey(state, placement, depth, context) {
  if (context.transpositionTable === "off") return null;
  let stateKey = context.stateKeys.get(state);
  if (stateKey === undefined) {
    stateKey = fullStateKey(state);
    context.stateKeys.set(state, stateKey);
  }
  // Rotation evidence is observable in the returned action/PV. Placements
  // that reach the same cells through different final inputs therefore cannot
  // share a cached result even when their structural tie-break key matches.
  return `${stateKey}|depth:${depth}|placement:${JSON.stringify(placement)}`;
}

function commitTransposition(cacheKey, result, context) {
  if (cacheKey !== null) context.transpositions.set(cacheKey, result);
  return result;
}

function leafCandidate(action, transition) {
  const features = extractEvaluationFeatures(transition);
  return {
    action,
    score: scoreEvaluationFeatures(features),
    features,
    transition,
    principalVariation: [action],
    reachedDepth: 1,
  };
}

function canContinue(context) {
  if (context.stopReason !== null) return false;
  if (context.memoryBytes !== null && context.memoryBytes > context.memoryBudgetBytes) {
    context.stopReason = "memory-budget";
    return false;
  }
  if (context.shouldStop()) {
    context.stopReason = "cancelled";
    return false;
  }
  // Let the first transition complete so a positive time budget can produce a
  // confirmed result even when the host clock is coarse.
  if (context.nodes > 0 && context.now() - context.startedAt >= context.timeBudgetMs) {
    context.stopReason = "time-budget";
    return false;
  }
  return true;
}

function deterministicBytes(value) {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function hasMoveSource(state) {
  if (state.pieces.current !== null) return true;
  if (!state.pieces.holdAvailable) return false;
  return state.pieces.hold !== null || (state.pieces.known[0] ?? null) !== null;
}

function compareCandidates(left, right) {
  return right.score - left.score || principalVariationKey(left).localeCompare(
    principalVariationKey(right),
    "en",
  );
}

function principalVariationKey(candidate) {
  return candidate.principalVariation.map((action) => placementKey(action.placement)).join("/");
}

function placementKey(placement) {
  return [
    placement.usedHold ? "1" : "0",
    placement.piece,
    placement.rotation,
    String(placement.x).padStart(3, "0"),
    String(placement.y).padStart(3, "0"),
  ].join(":");
}

function evaluatorMetadata() {
  return {
    id: DEPTH1_BASELINE_MODEL.id,
    version: DEPTH1_BASELINE_MODEL.version,
    modelSha256: DEPTH1_BASELINE_MODEL.modelSha256,
    featureSchema: DEPTH1_BASELINE_MODEL.featureSchema,
    featureSchemaSha256: DEPTH1_BASELINE_MODEL.featureSchemaSha256,
    weightsVersion: DEPTH1_BASELINE_MODEL.weightsVersion,
    weightsSha256: DEPTH1_BASELINE_MODEL.weightsSha256,
    trainingCorpus: DEPTH1_BASELINE_MODEL.trainingCorpus,
    comparability: DEPTH1_BASELINE_MODEL.comparability,
  };
}

function assertOptions({
  topN,
  maxDepth,
  nodeBudget,
  timeBudgetMs,
  now,
  shouldStop,
  onNode,
  deterministicSeed,
  transpositionTable,
  memoryBudgetBytes,
  unknownQueue,
}) {
  if (!Number.isSafeInteger(topN) || topN < 1) throw new Error("topN must be a positive integer");
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 1) {
    throw new Error("maxDepth must be a positive safe integer");
  }
  if (!Number.isSafeInteger(nodeBudget) || nodeBudget < 1) {
    throw new Error("nodeBudget must be a positive safe integer");
  }
  if (!(timeBudgetMs > 0)) throw new Error("timeBudgetMs must be positive");
  if (typeof now !== "function" || typeof shouldStop !== "function") {
    throw new Error("now and shouldStop must be functions");
  }
  if (onNode !== null && typeof onNode !== "function") {
    throw new Error("onNode must be null or a function");
  }
  if (!Number.isSafeInteger(deterministicSeed) || deterministicSeed < 0) {
    throw new Error("deterministicSeed must be a non-negative safe integer");
  }
  if (!(["off", "full-state"].includes(transpositionTable))) {
    throw new Error('transpositionTable must be "off" or "full-state"');
  }
  if (!Number.isSafeInteger(memoryBudgetBytes) || memoryBudgetBytes < 1) {
    throw new Error("memoryBudgetBytes must be a positive safe integer");
  }
  if (!(["reject", "speculate"].includes(unknownQueue))) {
    throw new Error('unknownQueue must be "reject" or "speculate"');
  }
}
