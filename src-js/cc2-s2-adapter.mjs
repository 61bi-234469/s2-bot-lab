import {
  RULESET_IDS,
  S2_OBSERVED_MANIFEST,
  resolvePlacementRules,
} from "./ruleset-profiles.mjs";
import { applyTransition } from "./transition.mjs";
import {
  EVALUATION_SCORE_SEMANTICS,
  evaluatorModelIdentity,
  extractEvaluationFeatures,
  scoreEvaluationFeatures,
} from "./evaluation.mjs";
import { fullStateKey } from "./state-keys.mjs";
import {
  HEADLESS_ARENA_RUNTIME_CAPABILITY,
  evaluateHeadlessArenaRulesetAdmission,
} from "./ruleset-admission.mjs";
import {
  engineFrameContinuationIdentity,
  engineFrameContinuationForPlacement,
  generateEngineFrameBranches,
  generateEngineFrameBranchesAtLockFrame,
  generateEngineFrameContinuationPlacements,
  prepareEngineFrameContinuationState,
} from "./triangle/engine-frame-move-generation.mjs";
import { generateReachablePlacements } from "./triangle/move-generation.mjs";
import { createPlacedTetromino } from "./triangle/placement-adapter.mjs";

const ROTATION = Object.freeze({
  north: "spawn",
  east: "right",
  south: "reverse",
  west: "left",
});
const RUNTIME_CONTINUATION_BY_RESULT = new WeakMap();
const CC2_ARENA_WITNESS_SELECTION_POLICY =
  "shortest-duration-then-controller-canonical-order/1";

const CC2_FINAL_PLACEMENT_SPIN_POLICY = Object.freeze({
  id: "cc2-final-placement-spin-policy/2",
  inputEvidence: "final-pose-plus-canonical-s2-state",
  admittedLabels: Object.freeze(["none", "mini", "normal"]),
  cc2Claim: "informational-only",
  positiveClassification: "requires-independent-s2-kickset-reachability-witness",
});

const CC2_S2_SPIN_WITNESS_INDEX_ID = "s2-positive-spin-witness-index/1";
const CC2_S2_ENGINE_FRAME_WITNESS_INDEX_ID = "s2-engine-frame-witness-index/1";
export const S2_REACHABLE_PLACEMENT_FRONTIER_ID = "s2-reachable-placement-frontier/1";

// CC2 remains a standard-Tetris proposer. Its spin label is not authoritative:
// the accepted final pose is independently matched to a reachable S2 rotation
// and kick witness. This deliberately allows an S2 All Spin even when CC2 calls
// the move non-spin. Frame-exact reachability remains outside this lightweight
// match path; without a positive S2 witness the pose is evaluated as non-spin.
export function applyCc2FinalPlacementUnderObservedS2(guiState, move, engine = {}) {
  const engineId = engine.engineId ?? "raw-cc2";
  const comparisonSource = engine.comparisonSource ?? "raw-cc2-final-placement";
  const state = guiStateToCanonical(guiState);
  const finalPlacement = cc2MoveToCanonicalPlacement(guiState, move);
  const spin = move?.spin;
  if (!["none", "mini", "full"].includes(spin)) {
    throw new Error(`unsupported CC2 spin label ${spin}`);
  }
  const positionFingerprint = fullStateKey(state);
  const index = resolveSpinWitnessIndex(state, positionFingerprint, engine.spinWitnessIndex);
  const witnessed = witnessPositiveSpinFromIndex(index, finalPlacement);
  const placement = witnessed?.placement ?? finalPlacement;
  const transition = applyTransition(state, { kind: "placement", placement });
  if (!transition.legality.legal) {
    return {
      status: "unsupported",
      reasons: [`cc2-final-placement-illegal-under-s2:${transition.legality.reason}`],
      spinPolicy: CC2_FINAL_PLACEMENT_SPIN_POLICY,
      manifest: manifestSummary(),
      transition: null,
    };
  }
  const features = extractEvaluationFeatures(transition);
  const degraded = [
    "rule-option-guard-only",
    witnessed === null
      ? "final-placement-reachability-not-evaluated"
      : "frame-reachability-not-evaluated",
  ];
  const claimedSpin = ({ none: "none", mini: "mini", full: "normal" })[spin];
  if (claimedSpin !== transition.lockResult.spin) {
    degraded.push("cc2-spin-label-overridden-by-s2");
  }
  if (spin !== "none" && witnessed === null) {
    degraded.push("cc2-positive-spin-claim-ignored");
  }
  if (state.informationLoss.some((entry) => entry.field.startsWith("time."))) {
    degraded.push("time-state-unavailable");
  }
  return {
    status: "degraded",
    reasons: degraded,
    spinPolicy: CC2_FINAL_PLACEMENT_SPIN_POLICY,
    manifest: manifestSummary(),
    transition,
    comparison: {
      source: comparisonSource,
      engineId,
      status: "degraded",
      reasons: degraded,
      positionFingerprint,
      rulesetId: state.rulesetId,
      witness: {
        kind: witnessed === null
          ? "final-placement-only"
          : "final-placement-with-s2-spin-witness",
        placement,
        reachability: witnessed === null ? "not-evaluated" : "s2-kickset-witnessed",
        spinPolicyId: CC2_FINAL_PLACEMENT_SPIN_POLICY.id,
        spinWitness: witnessed?.witness ?? null,
      },
      evaluator: evaluatorModelIdentity(),
      scoreSemantics: EVALUATION_SCORE_SEMANTICS,
      features,
      score: scoreEvaluationFeatures(features),
    },
  };
}

/**
 * Scans the position's reachable placements once and keeps the strongest
 * positive-spin witness per final pose. The reachable set depends on the
 * position alone, so every CC2 root candidate offered for the same position
 * reads this index instead of repeating the scan. Pass the result as
 * `engine.spinWitnessIndex` when verifying a candidate list.
 */
export function createCc2SpinWitnessIndex(guiState) {
  const state = guiStateToCanonical(guiState);
  return buildSpinWitnessIndex(state, fullStateKey(state));
}

/**
 * Enumerates the canonical S2 placement frontier for one position. This is a
 * placement-level witness, not a claim about frame-exact input reachability.
 * The explicit cap is a correctness budget: exceeding it returns an
 * incomplete result instead of silently shrinking the frontier.
 */
export function createS2ReachablePlacementFrontier(guiState, options = {}) {
  const state = guiStateToCanonical(guiState);
  const rules = resolvePlacementRules(state.rulesetId);
  const maxEntries = options.maxEntries ?? 256;
  if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
    throw new Error("reachable placement frontier maxEntries must be a positive integer");
  }
  const byPose = new Map();
  for (const placement of generateReachablePlacements(state, rules)) {
    if (!placement?.rotationEvidence ||
        typeof placement.rotationEvidence.lastInputWasRotation !== "boolean") {
      return Object.freeze({
        id: S2_REACHABLE_PLACEMENT_FRONTIER_ID,
        positionFingerprint: fullStateKey(state),
        complete: false,
        reason: "missing-rotation-evidence",
        placements: Object.freeze([]),
      });
    }
    const transition = applyTransition(state, { kind: "placement", placement });
    if (!transition.legality.legal || transition.nextState === null) continue;
    const pose = finalPoseKey(placement);
    if (!byPose.has(pose)) byPose.set(pose, structuredClone(placement));
    if (byPose.size > maxEntries) {
      return Object.freeze({
        id: S2_REACHABLE_PLACEMENT_FRONTIER_ID,
        positionFingerprint: fullStateKey(state),
        complete: false,
        reason: "frontier-entry-cap-exhausted",
        placements: Object.freeze([]),
      });
    }
  }
  return Object.freeze({
    id: S2_REACHABLE_PLACEMENT_FRONTIER_ID,
    positionFingerprint: fullStateKey(state),
    complete: true,
    reason: null,
    placements: Object.freeze([...byPose.values()]),
  });
}

/**
 * Enumerates the exact frame-controller branches once for every CC2 root in a
 * position. Entries retain the controller's canonical first witness, matching
 * the selection performed by the per-move arena adapter.
 */
export function createCc2EngineFrameWitnessIndex(guiState, moves = null, options = {}) {
  const state = guiStateToCanonical(guiState);
  const rules = resolvePlacementRules(RULESET_IDS.s2Observed);
  if (moves !== null && !Array.isArray(moves)) {
    throw new Error("engine-frame witness index moves must be null or an array");
  }
  const requestedKeys = moves === null ? null : new Set(moves.map((move) =>
    engineFramePlacementKey(state, cc2MoveToCanonicalPlacement(guiState, move))
  ));
  const byFinalCells = new Map();
  for (const entry of generateEngineFrameBranches(state, rules, {
    ...options,
    ...(requestedKeys === null ? {} : {
      filter: ({ placement }) => requestedKeys.has(engineFramePlacementKey(state, placement)),
    }),
  })) {
    const key = engineFramePlacementKey(state, entry.placement);
    if (!byFinalCells.has(key)) byFinalCells.set(key, entry);
  }
  return Object.freeze({
    id: CC2_S2_ENGINE_FRAME_WITNESS_INDEX_ID,
    positionFingerprint: fullStateKey(state),
    byFinalCells,
  });
}

function buildSpinWitnessIndex(state, positionFingerprint) {
  const rules = resolvePlacementRules(state.rulesetId);
  const byFinalPose = new Map();
  for (const candidate of generateReachablePlacements(state, rules)) {
    if (!candidate.rotationEvidence.lastInputWasRotation) continue;
    const transition = applyTransition(state, { kind: "placement", placement: candidate });
    if (!transition.legality.legal || transition.lockResult.spin === "none") continue;
    const pose = finalPoseKey(candidate);
    const best = byFinalPose.get(pose);
    // Ties keep the first witness in canonical generation order, which is what
    // a stable sort by spin rank over the same scan selected.
    if (best !== undefined && spinRank(best.spin) >= spinRank(transition.lockResult.spin)) continue;
    byFinalPose.set(pose, { placement: candidate, spin: transition.lockResult.spin });
  }
  return Object.freeze({
    id: CC2_S2_SPIN_WITNESS_INDEX_ID,
    positionFingerprint,
    byFinalPose,
  });
}

function resolveSpinWitnessIndex(state, positionFingerprint, provided) {
  if (provided === undefined || provided === null) {
    return buildSpinWitnessIndex(state, positionFingerprint);
  }
  if (provided.id !== CC2_S2_SPIN_WITNESS_INDEX_ID) {
    throw new Error("spinWitnessIndex must come from createCc2SpinWitnessIndex");
  }
  // A witness index is only valid for the position it was scanned from. Reusing
  // one across positions would silently attach another position's spin witness.
  if (provided.positionFingerprint !== positionFingerprint) {
    throw new Error("spinWitnessIndex was built for a different position");
  }
  return provided;
}

function witnessPositiveSpinFromIndex(index, finalPlacement) {
  const best = index.byFinalPose.get(finalPoseKey(finalPlacement));
  if (best === undefined) return null;
  // The index outlives this call, so hand back copies rather than the entries
  // every other candidate in the same position also reads.
  return {
    placement: structuredClone(best.placement),
    witness: {
      kind: "s2-kickset-reachability-witness",
      classifiedSpin: best.spin,
      rotationEvidence: structuredClone(best.placement.rotationEvidence),
    },
  };
}

function finalPoseKey(placement) {
  return `${placement.piece}:${placement.rotation}:${placement.x}:${placement.y}:${placement.usedHold ? 1 : 0}`;
}

function spinRank(spin) {
  return ({ none: 0, mini: 1, normal: 2 })[spin] ?? -1;
}

/**
 * Arena path: prove the CC2 final cells/HOLD through the pinned frame
 * controller, while treating CC2's spin label as informational only.
 */
export function applyCc2ReachableFinalPlacementUnderObservedS2(guiState, move, engine = {}) {
  if (!["none", "mini", "full"].includes(move?.spin)) {
    throw new Error(`unsupported CC2 spin label ${move?.spin}`);
  }
  return applyCc2EngineFramePlacement(guiState, move, engine);
}

/** Returns the opaque Triangle continuation associated with an arena result. */
export function cc2EngineFrameContinuationForResult(result) {
  const continuation = RUNTIME_CONTINUATION_BY_RESULT.get(result);
  return continuation === undefined ? null : structuredClone(continuation);
}

function applyCc2EngineFramePlacement(guiState, move, engine) {
  const engineId = engine.engineId ?? "raw-cc2";
  const comparisonSource = engine.comparisonSource ?? "raw-cc2";
  const state = guiStateToCanonical(guiState);
  const requested = cc2MoveToCanonicalPlacement(guiState, move);
  const targetCells = placementCellIdentity(state.board, requested);
  const rules = resolvePlacementRules(RULESET_IDS.s2Observed);

  const matchesRequestedCells = ({ placement }) =>
      placement.piece === requested.piece &&
      placement.rotation === requested.rotation &&
      placement.usedHold === requested.usedHold &&
      placementCellIdentity(state.board, placement) === targetCells;
  const indexedEntry = engine.targetLockFrame === undefined &&
      (engine.continuation === undefined || engine.continuation === null) &&
      engine.engineFrameWitnessIndex !== undefined
    ? resolveEngineFrameWitnessIndex(state, engine.engineFrameWitnessIndex)
      .byFinalCells.get(engineFramePlacementKey(state, requested))
    : undefined;
  const candidates = engine.targetLockFrame !== undefined
    ? generateEngineFrameBranchesAtLockFrame(
      state,
      rules,
      engine.continuation ?? null,
      engine.targetLockFrame,
      { filter: matchesRequestedCells, stopAfterFirstMatchingDuration: true },
    )
    : indexedEntry !== undefined
      ? [indexedEntry]
      : (engine.continuation === undefined || engine.continuation === null
        ? generateEngineFrameBranches(state, rules)
        : generateEngineFrameContinuationPlacements(state, rules, engine.continuation)
          .map((placement) => ({
            placement,
            continuation: engineFrameContinuationForPlacement(placement),
          })))
      .filter(matchesRequestedCells);
  let transition = null;
  let witness = null;
  let continuation = null;
  for (const candidateEntry of candidates) {
    const placement = candidateEntry.placement;
    const stateAtLock = structuredClone(state);
    stateAtLock.time.logicalFrame = placement.movementEvidence.lockedAtFrame;
    const candidate = applyTransition(stateAtLock, { kind: "placement", placement });
    if (candidate.legality.legal) {
      transition = candidate;
      witness = placement;
      continuation = candidateEntry.continuation;
      break;
    }
  }
  if (transition === null) {
    return {
      status: "unsupported",
      reasons: ["cc2-placement-has-no-matching-s2-reachability-witness"],
      manifest: manifestSummary(),
      transition: null,
    };
  }
  const features = extractEvaluationFeatures(transition);
  const arenaAdmission = Number.isSafeInteger(engine.targetLockFrame)
    ? evaluateHeadlessArenaRulesetAdmission(S2_OBSERVED_MANIFEST, HEADLESS_ARENA_RUNTIME_CAPABILITY)
    : null;
  const degraded = arenaAdmission?.admitted === true ? [] : ["rule-option-guard-only"];
  const claimedSpin = ({ none: "none", mini: "mini", full: "normal" })[move.spin];
  if (claimedSpin !== transition.lockResult.spin) degraded.push("cc2-spin-label-overridden-by-s2");
  if (state.informationLoss.some((entry) => entry.field.startsWith("time."))) {
    degraded.push("time-state-unavailable");
  }
  const continuationRecord = continuation === null ? null : (() => {
    const projected = prepareEngineFrameContinuationState(transition, continuation);
    return {
      identity: engineFrameContinuationIdentity(continuation),
      projectedStateFingerprint: fullStateKey(projected),
      frame: projected.time.logicalFrame,
      phase: projected.movement.phase,
    };
  })();
  const result = {
    status: "degraded",
    reasons: degraded,
    manifest: manifestSummary(),
    transition,
    comparison: {
      source: comparisonSource,
      engineId,
      status: "degraded",
      reasons: degraded,
      positionFingerprint: fullStateKey(state),
      rulesetId: state.rulesetId,
      witness,
      witnessSelectionPolicy: Number.isSafeInteger(engine.targetLockFrame)
        ? CC2_ARENA_WITNESS_SELECTION_POLICY
        : null,
      continuation: continuationRecord,
      evaluator: evaluatorModelIdentity(),
      scoreSemantics: EVALUATION_SCORE_SEMANTICS,
      features,
      score: scoreEvaluationFeatures(features),
    },
  };
  if (continuation !== null) RUNTIME_CONTINUATION_BY_RESULT.set(result, continuation);
  return result;
}

function resolveEngineFrameWitnessIndex(state, provided) {
  if (provided?.id !== CC2_S2_ENGINE_FRAME_WITNESS_INDEX_ID) {
    throw new Error("engineFrameWitnessIndex must come from createCc2EngineFrameWitnessIndex");
  }
  if (provided.positionFingerprint !== fullStateKey(state)) {
    throw new Error("engineFrameWitnessIndex was built for a different position");
  }
  return provided;
}

function engineFramePlacementKey(state, placement) {
  return `${placement.piece}:${placement.rotation}:${placement.usedHold ? 1 : 0}:${placementCellIdentity(state.board, placement)}`;
}

function placementCellIdentity(board, placement) {
  return createPlacedTetromino(board, placement).absoluteBlocks
    .map(([x, y]) => `${x}:${y}`)
    .sort()
    .join("|");
}

export function guiStateToCanonical(guiState) {
  assertGuiState(guiState);
  return {
    $schema: "s2-analysis-engine/schema/canonical-state/1",
    schemaVersion: 1,
    rulesetId: RULESET_IDS.s2Observed,
    board: {
      width: 10,
      height: 40,
      visibleHeight: 20,
      bufferHeight: 20,
      cells: guiState.board.flatMap((row) => row.map((cell) => cell ?? "_")).join(""),
      fidelity: "exact",
    },
    pieces: {
      current: guiState.queue[0],
      hold: guiState.hold,
      holdAvailable: true,
      known: guiState.queue.slice(1),
      queueModel: { type: "7-bag", bagRemaining: [], seed: null, tail: "deterministic" },
      fidelity: "exact",
    },
    chain: {
      combo: guiState.combo,
      b2b: guiState.s2.b2b,
      fidelity: "exact",
    },
    garbage: structuredClone(guiState.s2.garbage),
    time: structuredClone(guiState.s2.time),
    movement: structuredClone(guiState.s2.movement),
    informationLoss: guiState.s2.clock?.kind === "synthetic-fixed-lock-step"
      ? []
      : [{
          field: "time.logicalFrame",
          reason: "no engine-frame clock provider is attached",
          effect: "degraded",
        }],
    provenance: {
      sourcePath: "raw-cc2-gui",
      producedBy: "cc2-s2-adapter",
      clock: structuredClone(guiState.s2.clock ?? null),
    },
  };
}

export function cc2MoveToCanonicalPlacement(guiState, move) {
  const { type: piece, orientation, x, y } = move?.location ?? {};
  const rotation = ROTATION[orientation];
  if (rotation === undefined) throw new Error(`unsupported CC2 orientation ${orientation}`);
  const [canonicalX, canonicalY] = canonicalOrigin(piece, orientation, x, y);
  return {
    piece,
    rotation,
    x: canonicalX,
    y: canonicalY,
    usedHold: piece !== guiState.queue[0],
    rotationEvidence: {
      lastInputWasRotation: false,
      kickIndex: null,
      kickId: null,
      kickOffset: null,
    },
  };
}

function canonicalOrigin(piece, orientation, x, y) {
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new Error("CC2 placement coordinates must be integers");
  }
  if (piece === "I") {
    return ({
      north: [x - 1, y - 2],
      east: [x - 2, y - 2],
      south: [x - 2, y - 1],
      west: [x - 1, y - 1],
    })[orientation];
  }
  if (piece === "O") {
    return ({
      north: [x, y],
      east: [x, y - 1],
      south: [x - 1, y - 1],
      west: [x - 1, y],
    })[orientation];
  }
  if (["T", "L", "J", "S", "Z"].includes(piece)) return [x - 1, y - 1];
  throw new Error(`unsupported CC2 piece ${piece}`);
}

function manifestSummary() {
  return {
    id: S2_OBSERVED_MANIFEST.id,
    displayId: S2_OBSERVED_MANIFEST.displayId,
    canonicalIdentity: S2_OBSERVED_MANIFEST.canonicalIdentity,
    qualification: S2_OBSERVED_MANIFEST.qualification.status,
  };
}

function assertGuiState(state) {
  if (!Array.isArray(state?.board) || state.board.length !== 40) {
    throw new Error("GUI state requires 40 board rows");
  }
  if (!state.board.every((row) => Array.isArray(row) && row.length === 10)) {
    throw new Error("GUI state requires 10 board columns");
  }
  if (!Array.isArray(state.queue) || state.queue.length < 2) {
    throw new Error("GUI state requires current and next pieces");
  }
  if (!Number.isSafeInteger(state.combo) || state.combo < 0) {
    throw new Error("GUI combo must be a non-negative integer");
  }
  if (!Number.isSafeInteger(state.s2?.b2b) || state.s2.b2b < 0) {
    throw new Error("GUI S2 B2B must be a non-negative integer");
  }
  if (
    state.s2.clock?.kind === "synthetic-fixed-lock-step" &&
    (!Number.isSafeInteger(state.s2.clock.framesPerLock) || state.s2.clock.framesPerLock < 1)
  ) {
    throw new Error("synthetic clock framesPerLock must be a positive integer");
  }
}
