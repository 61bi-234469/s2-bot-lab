import { canonicalize } from "./cs1-core.mjs";
import { EVALUATION_SCORE_SEMANTICS, evaluatorModelIdentity } from "./evaluation.mjs";
import { S2_OBSERVED_MANIFEST } from "./ruleset-profiles.mjs";
import { analyzeIterativeDeepening } from "./search.mjs";
import { fullStateKey } from "./state-keys.mjs";
import { applyTransition } from "./transition.mjs";
import {
  DEPTH_ONE_MOVEMENT_CAPABILITY,
  evaluateRulesetAdmission,
} from "./ruleset-admission.mjs";

export const ANALYSIS_API_VERSION = 1;
export const S2_ENGINE_ID = "s2-simulator-search";
export const S2_ENGINE_VERSION = "0.1.0";

export function describeAnalysisEngine(runId = "describe") {
  return {
    apiVersion: ANALYSIS_API_VERSION,
    runId,
    engineId: S2_ENGINE_ID,
    engineVersion: S2_ENGINE_VERSION,
    schemaVersions: { ruleset: 1, state: 1, fixture: 1, api: 1 },
    operations: {
      evaluatePosition: false,
      analyzeBest: true,
      analyzeTopN: { max: 64 },
      analyzeSequence: false,
      evaluatePlayedMove: true,
    },
    capabilities: {
      structuredGarbage: true,
      exactB2B: true,
      b2bCharging: true,
      surge: true,
      cancellation: true,
      chainState: true,
      timeState: "requires-input",
      unknownQueue: "reject",
      movementModel: DEPTH_ONE_MOVEMENT_CAPABILITY,
    },
    evaluator: evaluatorModelIdentity(),
    scoreSemantics: EVALUATION_SCORE_SEMANTICS,
  };
}

export function invokeAnalysis(request, control = {}) {
  try {
    validateRequest(request);
    const fingerprint = fullStateKey(request.state);
    if (request.positionFingerprint !== fingerprint) {
      return errorEnvelope(request, "invalid-state", "position-fingerprint-mismatch");
    }
    if (request.rulesetId !== request.state.rulesetId) {
      return errorEnvelope(request, "invalid-state", "ruleset-state-mismatch");
    }
    if (request.rulesetId !== S2_OBSERVED_MANIFEST.id) {
      return unsupportedEnvelope(request, ["rule-option-guard-only"], "ruleset-mismatch");
    }
    const admission = evaluateRulesetAdmission(
      S2_OBSERVED_MANIFEST,
      request.operation,
      {
        movementModel: DEPTH_ONE_MOVEMENT_CAPABILITY,
        maxDepth: request.params?.maxDepth ?? 1,
      },
    );
    if (!admission.valid) {
      return unsupportedEnvelope(request, ["rule-option-guard-only"], "ruleset-invalid");
    }
    if (request.operation === "evaluatePosition") {
      return unsupportedEnvelope(request, ["user-selected-incompatible-engine"], "capability-missing");
    }
    if (control.isCancelled?.() === true) return cancelledEnvelope(request);

    if (admission.unsupportedOptions.movement.length > 0) {
      return unsupportedEnvelope(request, ["movement-model-unavailable"], "capability-missing");
    }
    const search = runSearch(request, control);
    if (search.status === "cancelled") return cancelledEnvelope(request, search);
    if (search.status === "unsupported") {
      return unsupportedEnvelope(
        request,
        search.degraded ?? ["movement-model-unavailable"],
        "capability-missing",
        search,
      );
    }
    if (search.status === "speculative") {
      return unsupportedEnvelope(request, ["queue-unknown"], "unsupported-state", search);
    }
    return successEnvelope(request, operationResult(request, search), search);
  } catch (error) {
    return errorEnvelope(
      request,
      "invalid-state",
      error instanceof Error ? error.message : String(error),
    );
  }
}

export function isCurrentAnalysisResponse(response, current) {
  return response.runId === current.runId &&
    response.requestId === current.requestId &&
    response.positionFingerprint === current.positionFingerprint;
}

function runSearch(request, control) {
  const params = request.params ?? {};
  const budget = request.budget ?? {};
  const requestedN = request.operation === "analyzeTopN"
    ? params.n
    : request.operation === "evaluatePlayedMove"
      ? (params.topN ?? 64)
      : 1;
  if (!Number.isSafeInteger(requestedN) || requestedN < 1 || requestedN > 64) {
    throw new Error("requested Top N must be an integer from 1 to 64");
  }
  const result = analyzeIterativeDeepening(request.state, {
    // Search must return the complete root set before the API applies its CS/1
    // tie-break. Asking Search for N directly could discard an equal-scoring
    // move using Search's internal structural order before this contract sees it.
    topN: 10_000,
    maxDepth: params.maxDepth ?? 1,
    nodeBudget: budget.nodes ?? Number.MAX_SAFE_INTEGER,
    timeBudgetMs: budget.thinkMs ?? Number.POSITIVE_INFINITY,
    deterministicSeed: request.determinism?.seed ?? 0,
    shouldStop: () => control.isCancelled?.() === true,
    unknownQueue: "reject",
  });
  result.candidates.sort((left, right) =>
    right.score - left.score || canonicalize(left.action).localeCompare(canonicalize(right.action), "en")
  );
  result.best = result.candidates[0] ?? null;
  result.requestedN = requestedN;
  return result;
}

function operationResult(request, search) {
  switch (request.operation) {
    case "analyzeBest":
      return {
        operation: "analyzeBest",
        move: search.best === null ? null : moveResult(search.best, 1),
      };
    case "analyzeTopN":
      {
        const moves = search.candidates.slice(0, request.params.n);
      return {
        operation: "analyzeTopN",
        requestedN: request.params.n,
        truncated: search.generatedMoves > moves.length,
        moves: moves.map((candidate, index) => moveResult(candidate, index + 1)),
      };
      }
    case "evaluatePlayedMove":
      return playedMoveResult(request.params.placement, search);
    default:
      throw new Error(`unsupported operation ${request.operation}`);
  }
}

function playedMoveResult(placement, search) {
  const best = search.best === null ? null : moveResult(search.best, 1);
  const index = search.candidates.findIndex(
    (candidate) => canonicalize(candidate.action.placement) === canonicalize(placement),
  );
  if (index < 0) {
    return {
      operation: "evaluatePlayedMove",
      best,
      played: null,
      loss: null,
      unmatchedReason: "not-in-top-n",
    };
  }
  const played = moveResult(search.candidates[index], index + 1);
  return {
    operation: "evaluatePlayedMove",
    best,
    played,
    loss: best.score - played.score,
    unmatchedReason: null,
  };
}

function analyzeSequence(request, control) {
  const placements = request.params?.placements;
  if (!Array.isArray(placements)) throw new Error("analyzeSequence requires placements");
  let state = request.state;
  const plies = [];
  for (let index = 0; index < placements.length; index += 1) {
    if (control.isCancelled?.() === true) return cancelledEnvelope(request);
    const beforeFingerprint = fullStateKey(state);
    const queueBefore = [state.pieces.current, ...state.pieces.known];
    const transition = applyTransition(state, { kind: "placement", placement: placements[index] });
    if (!transition.legality.legal) {
      plies.push({
        ply: index,
        beforeFingerprint,
        queueBefore,
        move: { placement: placements[index], score: null },
        afterFingerprint: null,
        status: "illegal",
      });
      break;
    }
    state = transition.nextState;
    plies.push({
      ply: index,
      beforeFingerprint,
      queueBefore,
      move: { placement: placements[index], score: null },
      afterFingerprint: fullStateKey(state),
      status: "applied",
    });
  }
  return successEnvelope(request, { operation: "analyzeSequence", plies }, null);
}

function moveResult(candidate, rank) {
  return {
    placement: candidate.action.placement,
    score: candidate.score,
    rank,
    principalVariation: candidate.principalVariation.map((action) => action.placement),
  };
}

function successEnvelope(request, result, search) {
  const degraded = inputDegradation(request.state);
  return baseEnvelope(request, {
    status: search?.status === "partial" ? "partial" : "final",
    errorCode: null,
    resultKind: degraded.length === 0 ? "exact-input" : "degraded-input",
    degraded,
    warnings: [],
    stats: search === null ? null : {
      nodes: search.nodes,
      timeMs: null,
      depth: search.completedDepth,
    },
    scoreSemantics: EVALUATION_SCORE_SEMANTICS,
    result,
  });
}

function cancelledEnvelope(request, search = null) {
  return baseEnvelope(request, {
    status: "cancelled",
    errorCode: null,
    resultKind: resultKind(request.state),
    degraded: inputDegradation(request.state),
    warnings: [],
    stats: search === null ? null : { nodes: search.nodes, timeMs: null, depth: search.completedDepth },
    scoreSemantics: EVALUATION_SCORE_SEMANTICS,
    result: null,
  });
}

function unsupportedEnvelope(request, degraded, errorCode, search = null) {
  return baseEnvelope(request, {
    status: "unsupported",
    errorCode,
    resultKind: "degraded-input",
    degraded: [...new Set(degraded)],
    warnings: [],
    stats: search === null ? null : { nodes: search.nodes, timeMs: null, depth: search.completedDepth },
    scoreSemantics: EVALUATION_SCORE_SEMANTICS,
    result: null,
  });
}

function errorEnvelope(request, errorCode, warning) {
  return baseEnvelope(request, {
    status: "error",
    errorCode,
    resultKind: request?.state ? resultKind(request.state) : "degraded-input",
    degraded: request?.state ? inputDegradation(request.state) : ["user-selected-incompatible-engine"],
    warnings: [warning],
    stats: null,
    scoreSemantics: EVALUATION_SCORE_SEMANTICS,
    result: null,
  });
}

function baseEnvelope(request, fields) {
  return {
    apiVersion: ANALYSIS_API_VERSION,
    schemaVersion: 1,
    runId: request?.runId ?? "invalid",
    requestId: request?.requestId ?? "invalid",
    revision: 0,
    positionFingerprint: request?.positionFingerprint ?? "invalid",
    engineId: S2_ENGINE_ID,
    engineVersion: S2_ENGINE_VERSION,
    rulesetId: request?.rulesetId ?? "invalid",
    evaluator: evaluatorModelIdentity(),
    ...fields,
  };
}

function inputDegradation(state) {
  const degraded = [];
  if (state?.informationLoss?.some((entry) => entry.field.startsWith("time."))) {
    degraded.push("time-state-unavailable");
  }
  if (
    state?.rulesetId === S2_OBSERVED_MANIFEST.id &&
    S2_OBSERVED_MANIFEST.qualification.status !== "qualified"
  ) {
    degraded.push("rule-option-guard-only");
  }
  return degraded;
}

function resultKind(state) {
  return inputDegradation(state).length === 0 ? "exact-input" : "degraded-input";
}

function validateRequest(request) {
  if (request?.apiVersion !== 1) throw new Error("unsupported API version");
  for (const key of ["runId", "requestId", "operation", "rulesetId", "positionFingerprint"]) {
    if (typeof request[key] !== "string" || request[key] === "") throw new Error(`missing ${key}`);
  }
  if (!["evaluatePosition", "analyzeBest", "analyzeTopN", "analyzeSequence", "evaluatePlayedMove"].includes(request.operation)) {
    throw new Error(`unknown operation ${request.operation}`);
  }
  if (request.state === null || typeof request.state !== "object") throw new Error("missing state");
}
