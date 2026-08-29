import { Engine, Mino, performKick } from "@haelp/teto/engine";

import { createHash } from "node:crypto";
import S2_OBSERVED_MANIFEST from "../../rulesets/tetrio-s2-v19-beta-1-5-0-observed.json" with { type: "json" };
import {
  canonicalGarbageToTriangleSnapshot,
  triangleSnapshotToCanonical,
} from "./garbage-adapter.mjs";
import { canonicalBoardToTriangle, createPlacedTetromino } from "./placement-adapter.mjs";

export const ENGINE_FRAME_CONTROLLER = "engine-frame-single-held-controller/4";
export const ENGINE_FRAME_MAX_INPUT_FRAMES = 7;
export const ENGINE_FRAME_SCHEDULE_VALIDATOR = "engine-frame-schedule-validator/1";
export const DEFAULT_ENGINE_FRAME_BUDGET = Object.freeze({
  maxNodes: 50_000,
  maxSnapshotBytes: 256 * 1024 * 1024,
});
export const ENGINE_FRAME_BUDGET_ID = "engine-frame-exploration-budget/2-movement-snapshot-bytes";
export const ENGINE_FRAME_SCHEDULER_YIELD_NODES = 256;
const INPUTS = Object.freeze(["moveLeft", "moveRight", "rotateCW", "rotateCCW", "rotate180", "noop"]);
const HELD_EDGES = Object.freeze([
  "moveLeftDown", "moveLeftUp", "moveRightDown", "moveRightUp",
  "softDropDown", "softDropUp",
]);
const ROTATION_NAMES = Object.freeze(["spawn", "right", "reverse", "left"]);
const PIECE_TO_MINO = Object.freeze({ I: Mino.I, J: Mino.J, L: Mino.L, O: Mino.O, S: Mino.S, T: Mino.T, Z: Mino.Z });
const BOX_SIZE = Object.freeze({ I: 4, O: 2, J: 3, L: 3, S: 3, T: 3, Z: 3 });
const CONTINUATION_BY_PLACEMENT = new WeakMap();
const DIRTY_MOVEMENT_ENGINES = new WeakSet();

// Exact only for the declared controller: an optional HOLD tap followed by at
// most maxInputFrames frames containing either one tap or no input, and a hard
// drop. Up to maxHeldEdges keydown/keyup edges may hold horizontal movement or
// soft drop across frames, so resolved DAS/ARR/SDF are executed by Triangle.
// It remains a strict subset (no IRS/IHS, subframe input, or multiple events in
// one frame).
export function generateEngineFrameTapPlacements(state, movementRules, options = {}) {
  return generateEngineFramePlacements(state, movementRules, options, null);
}

/** Checks the pinned Triangle Engine's spawn/block-out result for a canonical state. */
export function inspectEngineFrameSpawn(state, movementRules) {
  assertSupportedState(state, movementRules, {
    maxInputFrames: 0,
    maxIdleFrames: 0,
    maxHeldEdges: 0,
    maxNodes: 1,
    maxSnapshotBytes: 1,
  });
  return Object.freeze(createSourceEngine(state, false) === null
    ? { status: "top-out", reason: "spawn-blockout" }
    : { status: "ready", reason: null });
}

/** Captures the just-spawned active piece without consuming an input frame. */
export function createEngineFrameSpawnContinuation(state, movementRules) {
  assertSupportedState(state, movementRules, {
    maxInputFrames: 0,
    maxIdleFrames: 0,
    maxHeldEdges: 0,
    maxNodes: 1,
    maxSnapshotBytes: 1,
  });
  const source = createSourceEngine(state, false);
  if (source === null) return null;
  return {
    controller: ENGINE_FRAME_CONTROLLER,
    snapshot: source.engine.snapshot(),
    exactKnownQueuePrefix: state.pieces.known.length,
  };
}

export function generateEngineFrameBranches(state, movementRules, options = {}) {
  const placements = generateEngineFramePlacements(
    state,
    movementRules,
    { ...options, captureContinuations: true },
    null,
  );
  return placements.map((placement) => {
    const continuation = engineFrameContinuationForPlacement(placement);
    return Object.freeze({
      placement,
      continuation,
      continuationIdentity: continuation === null
        ? null
        : engineFrameContinuationIdentity(continuation),
    });
  });
}

/**
 * Enumerates every distinct witnessed branch that locks at an exact frame.
 * Durations are searched shortest-first; gravity and held-input state are
 * advanced by the pinned Engine before candidates are generated. Equal cells
 * are retained when spin evidence or the post-lock continuation differs.
 */
export function generateEngineFrameBranchesAtLockFrame(
  state,
  movementRules,
  sourceContinuation,
  targetLockFrame,
  {
    filter = () => true,
    stopAfterFirstMatchingDuration = false,
    knownQueue = state.pieces.known.length,
    yieldControl = null,
  } = {},
) {
  if (yieldControl !== null && typeof yieldControl !== "function") {
    throw new Error("yieldControl must be null or a function");
  }
  assertSupportedState(state, movementRules, {
    maxInputFrames: ENGINE_FRAME_MAX_INPUT_FRAMES,
    maxIdleFrames: 1,
    maxHeldEdges: 8,
    ...DEFAULT_ENGINE_FRAME_BUDGET,
  }, sourceContinuation === null ? "spawn-ready" : "active-piece");
  if (!Number.isSafeInteger(targetLockFrame) || targetLockFrame < state.time.logicalFrame) {
    throw new Error("targetLockFrame must be an engine frame at or after the canonical state");
  }
  const source = sourceContinuation ?? createEngineFrameSpawnContinuation(state, movementRules);
  if (source === null) return [];
  const branches = [];
  const seenBranches = new Set();
  // HOLD consumes one frame outside maxInputFrames.
  for (let duration = 0; duration <= ENGINE_FRAME_MAX_INPUT_FRAMES + 1; duration += 1) {
    const countBeforeDuration = branches.length;
    const startFrame = targetLockFrame - duration;
    if (startFrame < state.time.logicalFrame) continue;
    const atStart = structuredClone(state);
    atStart.time.logicalFrame = startFrame;
    const advanced = advanceEngineFrameContinuationToState(atStart, source);
    if (advanced.status !== "ready") continue;
    for (const placement of generateEngineFrameContinuationPlacements(
      advanced.state,
      movementRules,
      advanced.continuation,
      { maxInputFrames: Math.min(ENGINE_FRAME_MAX_INPUT_FRAMES, duration), knownQueue, yieldControl },
    )) {
      if (placement.movementEvidence.lockedAtFrame !== targetLockFrame) continue;
      const continuation = engineFrameContinuationForPlacement(placement);
      if (continuation === null) continue;
      const entry = { placement, continuation };
      if (!filter(entry)) continue;
      const identity = `${JSON.stringify(placement)}:${engineFrameContinuationIdentity(continuation)}`;
      if (seenBranches.has(identity)) continue;
      seenBranches.add(identity);
      branches.push(entry);
    }
    if (stopAfterFirstMatchingDuration && branches.length > countBeforeDuration) break;
  }
  return branches;
}

export function generateEngineFrameContinuationPlacements(state, movementRules, continuation, options = {}) {
  if (continuation?.controller !== ENGINE_FRAME_CONTROLLER || !continuation.snapshot) {
    throw new Error("engine-frame continuation uses an unknown controller or has no snapshot");
  }
  return generateEngineFramePlacements(
    state,
    movementRules,
    { captureContinuations: true, ...options },
    continuation.snapshot,
  );
}

/**
 * Checks whether a captured post-lock continuation can spawn its canonical
 * active piece. A spawn block-out is a terminal search outcome, whereas a
 * different active piece is a broken continuation and must remain fatal.
 */
export function inspectEngineFrameContinuationSpawn(state, continuation) {
  if (continuation?.controller !== ENGINE_FRAME_CONTROLLER || !continuation.snapshot) {
    throw new Error("engine-frame continuation uses an unknown controller or has no snapshot");
  }
  const engine = restoreContinuationSourceEngine(state, continuation.snapshot, state.pieces.known.length);
  return Object.freeze(engine.toppedOut
    ? { status: "top-out", reason: "spawn-blockout" }
    : { status: "ready", reason: null });
}

export function engineFrameContinuationForPlacement(placement) {
  const continuation = CONTINUATION_BY_PLACEMENT.get(placement);
  return continuation === undefined ? null : structuredClone(continuation);
}

export function engineFrameContinuationIdentity(continuation) {
  if (continuation?.controller !== ENGINE_FRAME_CONTROLLER || !continuation.snapshot) {
    throw new Error("engine-frame continuation identity requires a matching snapshot");
  }
  return `sha256:${createHash("sha256").update(JSON.stringify(continuation.snapshot)).digest("hex")}`;
}

export function prepareEngineFrameContinuationState(transition, continuation) {
  if (transition?.legality?.legal !== true || continuation?.controller !== ENGINE_FRAME_CONTROLLER) {
    throw new Error("engine-frame continuation requires a legal transition and matching controller");
  }
  const snapshot = continuation.snapshot;
  const next = structuredClone(transition.nextState);
  if (continuation.exactKnownQueuePrefix !== next.pieces.known.length) {
    throw new Error("engine-frame continuation known queue prefix does not match canonical state");
  }
  const snapshotCells = triangleBoardSnapshotCells(snapshot.board);
  const snapshotHold = snapshot.hold === null ? null : snapshot.hold.toUpperCase();
  const snapshotQueue = snapshot.queue?.value?.map((piece) => piece.toUpperCase()) ?? [];
  const snapshotCurrent = snapshot.falling?.symbol?.toUpperCase() ?? null;
  const snapshotGarbage = triangleSnapshotToCanonical(snapshot.garbage, next.garbage);
  const projected = {
    board: snapshotCells,
    current: snapshotCurrent,
    hold: snapshotHold,
    known: snapshotQueue.slice(0, next.pieces.known.length),
    holdAvailable: snapshot.holdLocked === false,
    combo: Math.max(0, (snapshot.stats?.combo ?? -1) + 1),
    b2b: Math.max(0, (snapshot.stats?.b2b ?? -1) + 1),
    piecesPlaced: snapshot.stats?.pieces,
    garbage: snapshotGarbage,
    lastWasClear: snapshot.lastWasClear,
  };
  const expected = {
    board: next.board.cells,
    current: next.pieces.current,
    hold: next.pieces.hold,
    known: next.pieces.known,
    holdAvailable: next.pieces.holdAvailable,
    combo: next.chain.combo,
    b2b: next.chain.b2b,
    piecesPlaced: next.time.piecesPlaced,
    garbage: next.garbage,
    lastWasClear: transition.lockResult.lines > 0,
  };
  if (JSON.stringify(projected) !== JSON.stringify(expected)) {
    const mismatches = Object.keys(expected).filter((key) =>
      JSON.stringify(projected[key]) !== JSON.stringify(expected[key])
    );
    const boardDifference = mismatches.includes("board")
      ? projected.board.split("").findIndex((cell, index) => cell !== expected.board[index])
      : -1;
    throw new Error(`engine-frame post-lock snapshot does not match canonical transition projection: ${mismatches.join(",")}${boardDifference >= 0 ? `@board[${boardDifference}]=${projected.board[boardDifference]}/${expected.board[boardDifference]}` : ""}`);
  }
  next.time.logicalFrame = snapshot.frame;
  next.movement.phase = "active-piece";
  next.movement.lastWasClear = projected.lastWasClear;
  return next;
}

/**
 * Advances a captured active-piece continuation with no new inputs to the
 * canonical match frame, then synchronizes externally delivered garbage.
 */
export function advanceEngineFrameContinuationToState(state, continuation) {
  if (continuation?.controller !== ENGINE_FRAME_CONTROLLER || !continuation.snapshot) {
    throw new Error("engine-frame continuation advance requires a matching snapshot");
  }
  if (!Number.isSafeInteger(state?.time?.logicalFrame) || state.time.logicalFrame < continuation.snapshot.frame) {
    throw new Error("engine-frame continuation target frame precedes its snapshot");
  }
  const engine = restoreEngine(state, continuation.snapshot);
  let locked = false;
  engine.events.once("falling.lock.pre", () => { locked = true; });
  while (engine.frame < state.time.logicalFrame && !locked && !engine.toppedOut) engine.tick([]);
  if (locked) return { status: "unsupported", reason: "inter-lock-cadence-violated", state: null, continuation: null };
  if (engine.toppedOut) return { status: "top-out", reason: "spawn-blockout", state: null, continuation: null };
  engine.garbageQueue.fromSnapshot(canonicalGarbageToTriangleSnapshot(state.garbage));
  const advancedSnapshot = engine.snapshot();
  // The canonical seeded queue is authoritative. It may have been extended by
  // the arena while this opaque continuation was parked between lock events.
  advancedSnapshot.queue.value = state.pieces.known.map((piece) => PIECE_TO_MINO[piece]);
  const advanced = {
    controller: ENGINE_FRAME_CONTROLLER,
    snapshot: advancedSnapshot,
    exactKnownQueuePrefix: state.pieces.known.length,
  };
  const projected = prepareEngineFrameContinuationState({
    legality: { legal: true },
    nextState: state,
    lockResult: { lines: state.movement.lastWasClear ? 1 : 0 },
  }, advanced);
  return { status: "ready", reason: null, state: projected, continuation: advanced };
}

function generateEngineFramePlacements(state, movementRules, options, continuationSnapshot) {
  const maxInputFrames = options.maxInputFrames ?? ENGINE_FRAME_MAX_INPUT_FRAMES;
  const maxIdleFrames = options.maxIdleFrames ?? 1;
  const maxHeldEdges = options.maxHeldEdges ?? 2;
  const maxNodes = options.maxNodes ?? DEFAULT_ENGINE_FRAME_BUDGET.maxNodes;
  const maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_ENGINE_FRAME_BUDGET.maxSnapshotBytes;
  const captureContinuations = options.captureContinuations ?? false;
  const knownQueue = options.knownQueue ?? state.pieces.known.length;
  const testOnlyFreshEngineRestore = options.testOnlyFreshEngineRestore ?? false;
  const testOnlyEngineHardDrop = options.testOnlyEngineHardDrop ?? false;
  const yieldControl = options.yieldControl ?? null;
  const metrics = options.metrics ?? null;
  const filter = options.filter ?? (() => true);
  if (typeof captureContinuations !== "boolean") {
    throw new Error("captureContinuations must be boolean");
  }
  if (typeof testOnlyFreshEngineRestore !== "boolean") {
    throw new Error("testOnlyFreshEngineRestore must be boolean");
  }
  if (typeof testOnlyEngineHardDrop !== "boolean") {
    throw new Error("testOnlyEngineHardDrop must be boolean");
  }
  if (yieldControl !== null && typeof yieldControl !== "function") {
    throw new Error("yieldControl must be null or a function");
  }
  if (metrics !== null && (typeof metrics !== "object" || Array.isArray(metrics))) {
    throw new Error("metrics must be an object or null");
  }
  if (typeof filter !== "function") {
    throw new Error("filter must be a function");
  }
  if (!Number.isSafeInteger(knownQueue) || knownQueue < 0 || knownQueue > state.pieces.known.length) {
    throw new Error("knownQueue must be an integer within the canonical known queue");
  }
  assertSupportedState(state, movementRules, { maxInputFrames, maxIdleFrames, maxHeldEdges, maxNodes, maxSnapshotBytes }, continuationSnapshot === null ? "spawn-ready" : "active-piece");

  const placements = [];
  const placementIds = new Set();
  let nodes = 0;
  let snapshotBytes = 0;
  const heldAlphabet = heldEdgesForHandling(state.movement.handling);
  for (const usedHold of state.pieces.holdAvailable ? [false, true] : [false]) {
    const initial = continuationSnapshot === null
      ? createSourceEngine(state, usedHold, knownQueue)
      : createContinuationSourceEngine(state, continuationSnapshot, usedHold, knownQueue);
    if (initial === null) continue;
    const immutableSnapshot = initial.engine.snapshot();
    const restoreTarget = testOnlyFreshEngineRestore
      ? null
      : restoreEngine(state, immutableSnapshot);
    const movementFalling = restoreTarget?.falling ?? null;
    const initialSnapshot = testOnlyFreshEngineRestore
      ? immutableSnapshot
      : engineMovementSnapshot(initial.engine);
    const restoreNode = (snapshot) => testOnlyFreshEngineRestore
      ? restoreEngine(state, snapshot)
      : restoreEngineMovement(restoreTarget, snapshot, immutableSnapshot, movementFalling);
    accountSnapshot(initialSnapshot);
    const queue = [{ snapshot: initialSnapshot, witness: initial.witness, evidence: noRotation(), idleFrames: 0, heldEdges: 0 }];
    const visited = new Set([nodeIdentity(initial.engine, initial.evidence)]);

    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      if (yieldControl !== null && cursor % ENGINE_FRAME_SCHEDULER_YIELD_NODES === 0) yieldControl();
      const node = queue[cursor];
      const engine = restoreNode(node.snapshot);
      const hardDrop = captureContinuations || testOnlyEngineHardDrop
        ? step(engine, "hardDrop", node.evidence)
        : projectHardDrop(engine, node.evidence);
      if (hardDrop.lock !== null) {
        const placement = placementFromLock(state, hardDrop.lock, usedHold, [...node.witness, "hardDrop"], hardDrop.evidence);
        if (filter({ placement })) {
          const identity = placementIdentity(state, placement, captureContinuations ? engine : null);
          if (!placementIds.has(identity)) {
            placementIds.add(identity);
            rememberContinuation(placement, engine);
            placements.push(placement);
          }
        }
      }

      if (node.witness.length - Number(usedHold) >= maxInputFrames) continue;
      const availableInputs = node.heldEdges < maxHeldEdges ? [...INPUTS, ...heldAlphabet] : INPUTS;
      for (const input of availableInputs) {
        if (input === "noop" && node.idleFrames >= maxIdleFrames) continue;
        if (!edgeApplicableSnapshot(node.snapshot, input)) continue;
        const branch = restoreNode(node.snapshot);
        const next = step(branch, input, node.evidence);
        if (next.lock !== null) {
          const placement = placementFromLock(
            state,
            next.lock,
            usedHold,
            [...node.witness, input],
            next.evidence,
          );
          if (filter({ placement })) {
            const identity = placementIdentity(state, placement, captureContinuations ? branch : null);
            if (!placementIds.has(identity)) {
              placementIds.add(identity);
              rememberContinuation(placement, branch);
              placements.push(placement);
            }
          }
          continue;
        }
        const identity = nodeIdentity(branch, next.evidence);
        if (visited.has(identity)) continue;
        visited.add(identity);
        const snapshot = testOnlyFreshEngineRestore
          ? branch.snapshot()
          : engineMovementSnapshot(branch);
        accountSnapshot(snapshot);
        queue.push({
          snapshot,
          witness: [...node.witness, input],
          evidence: next.evidence,
          idleFrames: node.idleFrames + Number(input === "noop"),
          heldEdges: node.heldEdges + Number(HELD_EDGES.includes(input)),
        });
      }
    }
  }
  placements.sort(comparePlacements);
  if (metrics !== null) {
    metrics.nodes = nodes;
    metrics.snapshotBytes = snapshotBytes;
    metrics.placements = placements.length;
  }
  return placements;

  function accountSnapshot(snapshot) {
    nodes += 1;
    // UTF-16 code units * 2 is a deterministic upper bound for the in-memory
    // JSON representation used by this controller's accounting contract.
    snapshotBytes += deterministicSnapshotBytes(snapshot);
    if (nodes > maxNodes) {
      const error = new Error("unsupported-budget: engine-frame controller node budget exhausted");
      error.code = "unsupported-budget";
      throw error;
    }
    if (snapshotBytes > maxSnapshotBytes) {
      const error = new Error("unsupported-budget: engine-frame controller snapshot budget exhausted");
      error.code = "unsupported-budget";
      throw error;
    }
  }

  function rememberContinuation(placement, engine) {
    if (!captureContinuations) return;
    const consumed = placement.usedHold && state.pieces.hold === null ? 2 : 1;
    if (state.pieces.known.length < consumed) return;
    const snapshot = engine.snapshot();
    snapshot.queue.value = state.pieces.known
      .slice(consumed)
      .map((piece) => PIECE_TO_MINO[piece]);
    snapshotBytes += deterministicSnapshotBytes(snapshot);
    if (snapshotBytes > maxSnapshotBytes) {
      const error = new Error("unsupported-budget: engine-frame continuation snapshot budget exhausted");
      error.code = "unsupported-budget";
      throw error;
    }
    CONTINUATION_BY_PLACEMENT.set(placement, {
      controller: ENGINE_FRAME_CONTROLLER,
      snapshot,
      exactKnownQueuePrefix: Math.max(0, state.pieces.known.length - consumed),
    });
  }
}

// A hard drop is terminal for this exploration node. When no post-lock
// continuation is requested, derive its exact final pose without asking the
// Engine to mutate board, queue, and statistics and then restoring all of
// them. Tetromino.softDrop uses the same board legality predicate and landing
// row as Engine.hardDrop; an actual downward move clears spin evidence under
// every non-"stupid" spin policy, matching Engine's internal fall loop.
function projectHardDrop(engine, previousEvidence) {
  const moved = engine.falling.softDrop(engine.board.state);
  const spin = moved && engine.gameOptions.spinBonuses !== "stupid"
    ? null
    : engine.lastSpin;
  return {
    lock: {
      falling: engine.falling.snapshot(),
      cells: engine.falling.absoluteBlocks.map(([x, y]) => [x, y]),
      frame: engine.frame,
      subframe: 0,
      spin,
    },
    evidence: spin === null ? noRotation() : previousEvidence,
  };
}

/**
 * Execute an explicit relative-frame input schedule through the pinned Triangle
 * Engine. Unlike the finite generator this accepts arbitrary subframes and
 * multiple ordered events per frame, but it validates only the supplied
 * witness and does not claim to search that larger input space.
 */
export function validateEngineFrameSchedule(state, movementRules, schedule, options = {}) {
  const maxFrames = options.maxFrames ?? 120;
  const maxEvents = options.maxEvents ?? 256;
  assertSupportedState(state, movementRules, {
    maxInputFrames: 0,
    maxIdleFrames: 0,
    maxHeldEdges: 0,
    maxNodes: 1,
    maxSnapshotBytes: 1,
  });
  const normalized = normalizeSchedule(schedule, maxFrames, maxEvents);
  const requestsHold = normalized.events.some((event) => event.type === "keydown" && event.key === "hold");
  if (requestsHold && state.pieces.holdAvailable && state.pieces.hold === null && state.pieces.known.length === 0) {
    return { status: "unsupported", reason: "hold-queue-unknown", placement: null };
  }
  const engine = createEngine(state);
  engine.lastWasClear = state.movement.lastWasClear;
  engine.held = state.pieces.hold === null ? null : PIECE_TO_MINO[state.pieces.hold];
  engine.holdLocked = !state.pieces.holdAvailable;
  for (let index = 0; index < state.pieces.known.length; index += 1) {
    engine.queue[index] = PIECE_TO_MINO[state.pieces.known[index]];
  }
  engine.initiatePiece(PIECE_TO_MINO[state.pieces.current]);
  if (engine.toppedOut) return { status: "unsupported", reason: "spawn-blockout", placement: null };

  const tracker = { usedHold: false, hardDropActive: false, holdSpawnBlockout: false };
  instrumentScheduleActions(engine, tracker);
  let lock = null;
  let lockOffset = null;
  let startedAtFrame = engine.frame;
  let activeOffset = 0;
  let activeEvents = [];
  engine.events.once("falling.lock.pre", () => {
    const sameEngineFrame = engine.frame === startedAtFrame;
    lock = {
      falling: engine.falling.snapshot(),
      cells: engine.falling.absoluteBlocks.map(([x, y]) => [x, y]),
      frame: engine.frame,
      subframe: sameEngineFrame ? engine.subframe : 0,
      spin: engine.lastSpin,
      source: tracker.hardDropActive ? "hard-drop" : "natural",
    };
    lockOffset = activeOffset;
  });
  for (let offset = 0; offset <= normalized.endFrameOffset; offset += 1) {
    startedAtFrame = engine.frame;
    activeOffset = offset;
    activeEvents = normalized.eventsByFrame.get(offset) ?? [];
    engine.tick(activeEvents.map((event) => ({
      frame: engine.frame,
      type: event.type,
      data: { key: event.key, subframe: event.subframe },
    })));
    if (lock !== null) break;
  }

  if (lock === null) {
    return {
      status: "unlocked",
      reason: "schedule-ended-before-lock",
      placement: null,
      finalFrame: engine.frame,
    };
  }
  if (tracker.holdSpawnBlockout) {
    return {
      status: "unsupported",
      reason: "hold-spawn-blockout",
      placement: null,
      finalFrame: engine.frame,
    };
  }
  if (normalized.events.some((event) => event.frameOffset > lockOffset)) {
    throw new Error("engine-frame schedule contains events after the piece locked");
  }
  if (
    lock.source === "natural"
    && lock.frame === startedAtFrame
    && activeEvents.some((event) => event.subframe >= lock.subframe)
  ) {
    throw new Error("engine-frame schedule contains an event after a natural subframe lock");
  }
  if (normalized.events.some((event) =>
    event.type === "keydown" && event.key.startsWith("rotate")
  )) {
    return {
      status: "unsupported",
      reason: "rotation-kick-witness-unavailable",
      placement: null,
      finalFrame: engine.frame,
    };
  }
  if (lock.spin !== null) {
    return {
      status: "unsupported",
      reason: "positive-spin-kick-witness-unavailable",
      placement: null,
      finalFrame: engine.frame,
    };
  }
  const labels = normalized.events.map((event) =>
    `${event.frameOffset}:${event.subframe}:${event.type}:${event.key}`
  );
  const placement = placementFromLock(
    state,
    lock,
    tracker.usedHold,
    labels,
    noRotation(),
  );
  placement.movementEvidence.controller = ENGINE_FRAME_SCHEDULE_VALIDATOR;
  placement.movementEvidence.schedule = structuredClone(schedule);
  return { status: "locked", reason: null, placement, finalFrame: engine.frame };
}

function normalizeSchedule(schedule, maxFrames, maxEvents) {
  if (!Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 10_000) {
    throw new Error("schedule maxFrames must be an integer from 1 to 10000");
  }
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 0 || maxEvents > 10_000) {
    throw new Error("schedule maxEvents must be an integer from 0 to 10000");
  }
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule) || !Array.isArray(schedule.events)) {
    throw new Error("engine-frame schedule must contain an events array");
  }
  if (!Number.isSafeInteger(schedule.endFrameOffset) || schedule.endFrameOffset < 0 || schedule.endFrameOffset >= maxFrames) {
    throw new Error("schedule endFrameOffset is outside the frame budget");
  }
  if (schedule.events.length > maxEvents) throw new Error("schedule event budget exhausted");
  const allowedKeys = new Set([
    "moveLeft", "moveRight", "softDrop", "rotateCW", "rotateCCW",
    "rotate180", "hardDrop", "hold",
  ]);
  const events = schedule.events.map((event, index) => {
    if (!event || typeof event !== "object" || Array.isArray(event)) throw new Error(`schedule event ${index} must be an object`);
    if (!Number.isSafeInteger(event.frameOffset) || event.frameOffset < 0 || event.frameOffset > schedule.endFrameOffset) throw new Error(`schedule event ${index} has an invalid frameOffset`);
    if (event.type !== "keydown" && event.type !== "keyup") throw new Error(`schedule event ${index} has an invalid type`);
    if (!allowedKeys.has(event.key)) throw new Error(`schedule event ${index} has an invalid key`);
    // Use the unique half-open frame representation. (N, 1) is the same
    // instant as (N + 1, 0), but would otherwise advance the canonical
    // integer lock clock differently.
    if (!Number.isFinite(event.subframe) || event.subframe < 0 || event.subframe >= 1) throw new Error(`schedule event ${index} has an invalid subframe`);
    return { frameOffset: event.frameOffset, type: event.type, key: event.key, subframe: event.subframe, order: index };
  });
  for (let index = 1; index < events.length; index += 1) {
    if (events[index].frameOffset < events[index - 1].frameOffset) {
      throw new Error("schedule events must be ordered by frameOffset");
    }
    if (
      events[index].frameOffset === events[index - 1].frameOffset
      && events[index].subframe < events[index - 1].subframe
    ) {
      throw new Error("schedule events within a frame must be ordered by subframe");
    }
  }
  const hardDropIndex = events.findIndex((event) => event.type === "keydown" && event.key === "hardDrop");
  if (hardDropIndex !== -1 && hardDropIndex !== events.length - 1) {
    throw new Error("hardDrop keydown must be the final schedule event");
  }
  const eventsByFrame = new Map();
  for (const event of events) {
    if (!eventsByFrame.has(event.frameOffset)) eventsByFrame.set(event.frameOffset, []);
    eventsByFrame.get(event.frameOffset).push(event);
  }
  return { endFrameOffset: schedule.endFrameOffset, events, eventsByFrame };
}

function instrumentScheduleActions(engine, tracker) {
  const originalHold = engine.hold;
  engine.hold = (...args) => {
    const result = originalHold(...args);
    if (result) {
      tracker.usedHold = true;
      if (engine.toppedOut) tracker.holdSpawnBlockout = true;
    }
    return result;
  };
  const originalHardDrop = engine.hardDrop;
  engine.hardDrop = (...args) => {
    tracker.hardDropActive = true;
    try {
      return originalHardDrop(...args);
    } finally {
      tracker.hardDropActive = false;
    }
  };
}

function heldEdgesForHandling(handling) {
  const edges = [];
  // At zero DAS/ARR, tap repetition already reaches the same horizontal states
  // with a shorter witness, so held horizontal branches add no placement.
  if (handling.das !== 0 || handling.arr !== 0) {
    edges.push("moveLeftDown", "moveLeftUp", "moveRightDown", "moveRightUp");
  }
  // SDF=1 is identical to ordinary gravity and likewise adds no state.
  if (handling.sdf !== 1) edges.push("softDropDown", "softDropUp");
  return edges;
}

function createSourceEngine(state, usedHold, knownQueue = state.pieces.known.length) {
  const engine = createEngine(state, knownQueue);
  engine.lastWasClear = state.movement.lastWasClear;
  engine.held = state.pieces.hold === null ? null : PIECE_TO_MINO[state.pieces.hold];
  const explorationQueueLength = Math.min(state.pieces.known.length, knownQueue + 1);
  for (let index = 0; index < explorationQueueLength; index += 1) {
    engine.queue[index] = PIECE_TO_MINO[state.pieces.known[index]];
  }
  engine.initiatePiece(PIECE_TO_MINO[state.pieces.current]);
  if (engine.toppedOut) return null;
  if (!usedHold) return { engine, witness: [], evidence: noRotation() };

  const source = state.pieces.hold ?? state.pieces.known[0] ?? null;
  if (source === null) return null;
  const holdStep = step(engine, "hold", noRotation());
  if (holdStep.lock !== null || engine.falling.symbol !== PIECE_TO_MINO[source] || engine.toppedOut) return null;
  return { engine, witness: ["hold"], evidence: noRotation() };
}

function createContinuationSourceEngine(state, snapshot, usedHold, knownQueue = state.pieces.known.length) {
  const engine = restoreContinuationSourceEngine(state, snapshot, knownQueue);
  if (engine.toppedOut) return null;
  if (!usedHold) return { engine, witness: [], evidence: noRotation() };

  const source = state.pieces.hold ?? state.pieces.known[0] ?? null;
  if (source === null) return null;
  const holdStep = step(engine, "hold", noRotation());
  if (holdStep.lock !== null || engine.falling.symbol !== PIECE_TO_MINO[source] || engine.toppedOut) return null;
  return { engine, witness: ["hold"], evidence: noRotation() };
}

function restoreContinuationSourceEngine(state, snapshot, knownQueue) {
  if (!Number.isSafeInteger(snapshot.frame) || snapshot.frame !== state.time.logicalFrame) {
    throw new Error("engine-frame continuation clock does not match canonical time");
  }
  const snapshotCells = triangleBoardSnapshotCells(snapshot.board);
  if (snapshotCells !== state.board.cells) {
    throw new Error("engine-frame continuation board does not match canonical state");
  }
  const snapshotHold = snapshot.hold === null ? null : snapshot.hold.toUpperCase();
  const snapshotQueue = snapshot.queue?.value?.map((piece) => piece.toUpperCase()) ?? [];
  if (snapshotHold !== state.pieces.hold ||
      state.pieces.known.some((piece, index) => snapshotQueue[index] !== piece) ||
      snapshot.stats?.pieces !== state.time.piecesPlaced ||
      Math.max(0, (snapshot.stats?.combo ?? -1) + 1) !== state.chain.combo ||
      Math.max(0, (snapshot.stats?.b2b ?? -1) + 1) !== state.chain.b2b ||
      snapshot.lastWasClear !== state.movement.lastWasClear) {
    throw new Error("engine-frame continuation state does not match canonical transition state");
  }
  const explorationSnapshot = structuredClone(snapshot);
  explorationSnapshot.queue.value = explorationSnapshot.queue.value.slice(
    0,
    Math.min(explorationSnapshot.queue.value.length, knownQueue + 1),
  );
  const engine = restoreEngine(state, explorationSnapshot);
  const expected = PIECE_TO_MINO[state.pieces.current];
  if (engine.falling?.symbol !== expected) {
    throw new Error("engine-frame continuation active piece does not match canonical current piece");
  }
  return engine;
}

function triangleBoardSnapshotCells(board) {
  return board?.flatMap((row) =>
    row.map((cell) => {
      if (cell === null) return "_";
      const symbol = cell.mino.toUpperCase();
      return "IJLOSTZ".includes(symbol) && symbol.length === 1 ? symbol : "G";
    })
  ).join("");
}

function createEngine(state, knownQueue = state.pieces.known.length) {
  const options = S2_OBSERVED_MANIFEST.normalizedOptions;
  const engine = new Engine(engineOptions(options, state.movement.handling, knownQueue));
  const sourceBoard = canonicalBoardToTriangle(state.board);
  engine.board.state = structuredClone(sourceBoard.state);
  engine.garbageQueue.fromSnapshot(canonicalGarbageToTriangleSnapshot(state.garbage));
  engine.frame = state.time.logicalFrame;
  restoreDynamicTrackers(engine, state.time.logicalFrame);
  engine.stats.combo = state.chain.combo === 0 ? -1 : state.chain.combo - 1;
  engine.stats.b2b = state.chain.b2b === 0 ? -1 : state.chain.b2b - 1;
  engine.stats.pieces = state.time.piecesPlaced;
  return engine;
}

function createRestoreTarget(state) {
  return new Engine(engineOptions(
    S2_OBSERVED_MANIFEST.normalizedOptions,
    state.movement.handling,
  ));
}

function restoreEngine(state, snapshot, restoreTarget = null) {
  const engine = restoreTarget ?? createRestoreTarget(state);
  if (restoreTarget !== null) engine.events.removeAllListeners();
  // Triangle reconstructs all three dynamic trackers by replaying every global
  // frame in fromSnapshot. Preserve its iterative-double values, but avoid
  // O(globalFrame * searchNodes) work by restoring non-time state at frame 0
  // and applying the memoized tracker values for the real frame.
  const zeroFrameSnapshot = { ...snapshot, frame: 0 };
  engine.fromSnapshot(zeroFrameSnapshot);
  engine.frame = snapshot.frame;
  engine.subframe = snapshot.subframe;
  restoreDynamicTrackers(engine, snapshot.frame);
  return engine;
}

export function engineMovementSnapshot(engine) {
  return {
    falling: engine.falling.snapshot(),
    frame: engine.frame,
    subframe: engine.subframe,
    lastSpin: cloneLastSpin(engine.lastSpin),
    glock: engine.glock,
    state: engine.state,
    held: engine.held,
    holdLocked: engine.holdLocked,
    input: cloneEngineInput(engine.input),
    resCache: cloneResCache(engine.resCache),
  };
}

export function restoreEngineMovement(engine, snapshot, immutableSnapshot, fallingTarget = engine.falling) {
  engine.events.removeAllListeners();
  if (DIRTY_MOVEMENT_ENGINES.delete(engine)) restoreImmutableAfterLock(engine, immutableSnapshot);
  engine.falling = fallingTarget;
  restoreFallingSnapshot(engine.falling, snapshot.falling);
  engine.frame = snapshot.frame;
  engine.subframe = snapshot.subframe;
  engine.lastSpin = cloneLastSpin(snapshot.lastSpin);
  engine.glock = snapshot.glock;
  engine.state = snapshot.state;
  engine.held = snapshot.held;
  engine.holdLocked = snapshot.holdLocked;
  engine.input = cloneEngineInput(snapshot.input);
  engine.resCache = cloneResCache(snapshot.resCache);
  restoreDynamicTrackers(engine, snapshot.frame);
  return engine;
}

function restoreFallingSnapshot(target, source) {
  target.aox = source.aox;
  target.aoy = source.aoy;
  target.fallingRotations = source.fallingRotations;
  target.highestY = source.highestY;
  target.ihs = source.ihs;
  target.irs = source.irs;
  target.keys = source.keys;
  target.rotation = source.rotation;
  target.location = [...source.location];
  target.locking = source.locking;
  target.lockResets = source.lockResets;
  target.rotResets = source.rotResets;
  target.safeLock = source.safeLock;
  target.totalRotations = source.totalRotations;
}

function cloneLastSpin(value) {
  if (value === null || typeof value !== "object") return value;
  return {
    ...value,
    ...(Array.isArray(value.kick) ? { kick: [...value.kick] } : {}),
  };
}

function cloneEngineInput(input) {
  return {
    lShift: { ...input.lShift },
    rShift: { ...input.rShift },
    lastShift: input.lastShift,
    firstInputTime: input.firstInputTime,
    time: { ...input.time },
    lastPieceTime: input.lastPieceTime,
    keys: { ...input.keys },
  };
}

function cloneResCache(cache) {
  return {
    pieces: cache.pieces,
    garbage: {
      sent: [...cache.garbage.sent],
      received: cache.garbage.received.map((entry) => structuredClone(entry)),
    },
    keys: [...cache.keys],
    lastLock: cache.lastLock,
  };
}

function restoreImmutableAfterLock(engine, snapshot) {
  // Lock/spawn advances the private Triangle queue, which is intentionally not
  // exposed. Use the authoritative full restore only after such a branch; all
  // non-locking edges stay on the lightweight path.
  const zeroFrameSnapshot = { ...snapshot, frame: 0 };
  engine.fromSnapshot(zeroFrameSnapshot);
  engine.frame = snapshot.frame;
  engine.subframe = snapshot.subframe;
  restoreDynamicTrackers(engine, snapshot.frame);
}

function deterministicSnapshotBytes(value) {
  if (value === null || value === undefined) return 8;
  if (typeof value === "boolean" || typeof value === "number") return 8;
  if (typeof value === "string") return 8 + value.length * 2;
  if (Array.isArray(value)) {
    return 16 + value.reduce((total, entry) => total + deterministicSnapshotBytes(entry), 0);
  }
  if (typeof value === "object") {
    return 24 + Object.entries(value).reduce(
      (total, [key, entry]) => total + key.length * 2 + deterministicSnapshotBytes(entry),
      0,
    );
  }
  throw new Error("unsupported snapshot accounting value");
}

function engineOptions(o, handling, knownQueue = 31) {
  return {
    board: { width: o.boardwidth, height: o.boardheight, buffer: o.boardbuffer },
    kickTable: o.kickset,
    options: {
      spinBonuses: o.spinbonuses,
      comboTable: o.combotable,
      garbageTargetBonus: o.garbagetargetbonus,
      clutch: o.clutch,
      garbageBlocking: o.garbageblocking,
      stock: o.stock,
    },
    gravity: { value: o.g, increase: o.gincrease, marginTime: o.gmargin },
    queue: { seed: 0, type: o.bagtype, minLength: Math.max(1, knownQueue) },
    garbage: {
      cap: { value: o.garbagecap, increase: o.garbagecapincrease, marginTime: o.garbagecapmargin, absolute: o.garbageabsolutecap, max: o.garbagecapmax },
      multiplier: { value: o.garbagemultiplier, increase: o.garbageincrease, marginTime: o.garbagemargin },
      messiness: { change: o.messiness_change, within: o.messiness_inner, nosame: o.messiness_nosame, timeout: o.messiness_timeout, center: o.messiness_center },
      garbage: { speed: o.garbagespeed, holeSize: o.garbageholesize },
      bombs: o.usebombs,
      seed: 0,
      boardWidth: o.boardwidth,
      rounding: o.roundmode,
      openerPhase: o.openerphase,
      specialBonus: o.garbagespecialbonus,
    },
    handling: structuredClone(handling),
    pc: o.allclears ? { garbage: o.allclear_garbage, b2b: o.allclear_b2b } : false,
    b2b: { chaining: o.b2bchaining, charging: o.b2bcharging ? { at: o.b2bcharge_at, base: o.b2bcharge_base } : false },
    misc: {
      movement: { infinite: o.infinite_movement, lockResets: o.lockresets, lockTime: o.locktime, may20G: o.gravitymay20g },
      allowed: { spin180: o.allow180, hardDrop: o.allow_harddrop, hold: true, undo: false, retry: false },
      infiniteHold: o.infinite_hold,
      stride: false,
      date: new Date("2026-08-13T00:00:00Z"),
    },
  };
}

function step(engine, input, previousEvidence) {
  let lock = null;
  const startedAtFrame = engine.frame;
  engine.events.once("falling.lock.pre", () => {
    const eventLock = engine.frame === startedAtFrame;
    lock = {
      falling: engine.falling.snapshot(),
      cells: engine.falling.absoluteBlocks.map(([x, y]) => [x, y]),
      frame: engine.frame,
      subframe: eventLock ? engine.subframe : 0,
      spin: engine.lastSpin,
    };
  });
  const predicted = input.startsWith("rotate") ? predictedRotation(engine, input) : null;
  const edge = heldEdge(input);
  const frames = input === "noop"
    ? []
    : edge !== null
      ? [keyEvent(engine.frame, edge.type, edge.key)]
    : input === "hardDrop"
    ? [keyEvent(engine.frame, "keydown", input)]
    : input === "hold"
      ? [keyEvent(engine.frame, "keydown", input), keyEvent(engine.frame, "keyup", input)]
      : [keyEvent(engine.frame, "keydown", input), keyEvent(engine.frame, "keyup", input)];
  engine.tick(frames);
  let evidence = previousEvidence;
  if (predicted !== null) evidence = predicted;
  if (engine.lastSpin === null && lock === null) evidence = noRotation();
  if (lock !== null) DIRTY_MOVEMENT_ENGINES.add(engine);
  return { lock, evidence };
}

function heldEdge(input) {
  if (!HELD_EDGES.includes(input)) return null;
  const type = input.endsWith("Down") ? "keydown" : "keyup";
  return { type, key: input.slice(0, type === "keydown" ? -4 : -2) };
}

function edgeApplicable(engine, input) {
  const edge = heldEdge(input);
  if (edge === null) return true;
  const held = edge.key === "moveLeft"
    ? engine.input.lShift.held
    : edge.key === "moveRight"
      ? engine.input.rShift.held
      : engine.input.keys.softDrop;
  return edge.type === "keydown" ? !held : held;
}

function edgeApplicableSnapshot(snapshot, input) {
  const edge = heldEdge(input);
  if (edge === null) return true;
  const held = edge.key === "moveLeft"
    ? snapshot.input.lShift.held
    : edge.key === "moveRight"
      ? snapshot.input.rShift.held
      : snapshot.input.keys.softDrop;
  return edge.type === "keydown" ? !held : held;
}

function predictedRotation(engine, input) {
  const amount = input === "rotateCW" ? 1 : input === "rotateCCW" ? -1 : 2;
  const from = engine.falling.rotation;
  const to = ((from + amount) % 4 + 4) % 4;
  const kick = performKick(
    engine.kickTable,
    engine.falling.symbol,
    engine.falling.location,
    [engine.falling.aox, engine.falling.aoy],
    !engine.misc.movement.infinite && engine.falling.totalRotations > engine.misc.movement.lockResets + 15,
    engine.falling.states[to],
    from,
    to,
    engine.board.state,
  );
  if (kick === true) {
    return {
      lastInputWasRotation: true,
      kickIndex: 0,
      kickId: "00",
      kickOffset: [0, 0],
    };
  }
  if (typeof kick !== "object" || kick === null) return null;
  return {
    lastInputWasRotation: true,
    kickIndex: kick.index,
    kickId: kick.id,
    kickOffset: [kick.kick[0], kick.kick[1]],
  };
}

function placementFromLock(state, lock, usedHold, witness, evidence) {
  const piece = Object.keys(PIECE_TO_MINO).find((key) => PIECE_TO_MINO[key] === lock.falling.symbol);
  const rotation = ROTATION_NAMES[lock.falling.rotation];
  const placement = {
    piece,
    rotation,
    x: lock.falling.location[0],
    y: Math.floor(lock.falling.location[1]) - BOX_SIZE[piece] + 1,
    usedHold,
    rotationEvidence: lock.spin === null ? noRotation() : evidence,
    movementEvidence: {
      controller: ENGINE_FRAME_CONTROLLER,
      startedAtFrame: state.time.logicalFrame,
      lockedAtFrame: lock.frame,
      lockedAt: { frame: lock.frame, subframe: lock.subframe },
      inputs: witness,
    },
  };
  // The canonical placement adapter and Triangle use different rotation-centre
  // origins. Keep the Engine's actual cells as non-wire provenance so callers
  // which emit a real input log can identify an exact placement without
  // mistaking the two coordinate labels for a disagreement.
  Object.defineProperty(placement, "engineCells", {
    value: lock.cells,
    enumerable: false,
  });
  return placement;
}

function placementIdentity(state, placement, continuationEngine = null) {
  const board = canonicalBoardToTriangle(state.board);
  const cells = createPlacedTetromino(board, placement).absoluteBlocks
    .map(([x, y]) => `${x},${y}`).sort().join("|");
  const evidence = placement.rotationEvidence;
  const identity = [
    placement.usedHold ? 1 : 0,
    cells,
    placement.rotation,
    evidence.lastInputWasRotation ? 1 : 0,
    evidence.kickIndex ?? "",
    evidence.kickId ?? "",
    evidence.kickOffset?.join(",") ?? "",
  ];
  if (continuationEngine !== null) identity.push(nodeIdentity(continuationEngine, noRotation()));
  return identity.join(":");
}

function nodeIdentity(engine, evidence) {
  const f = engine.falling.snapshot();
  return JSON.stringify([
    engine.frame, f.location, f.rotation, f.locking, f.lockResets, f.rotResets,
    f.highestY, f.totalRotations, f.safeLock, f.irs, f.ihs, f.aox, f.aoy,
    engine.lastSpin, engine.glock, engine.held, engine.holdLocked,
    engine.input?.keys, engine.input?.lShift, engine.input?.rShift,
    engine.input?.lastShift, engine.input?.firstInputTime, engine.state,
    evidence.lastInputWasRotation, evidence.kickId, evidence.kickOffset,
  ]);
}

const DYNAMIC_TRACKER_CACHE = createDynamicTrackerCache();

function createDynamicTrackerCache() {
  const o = S2_OBSERVED_MANIFEST.normalizedOptions;
  return {
    gravity: { values: [o.g], increase: o.gincrease, margin: o.gmargin },
    garbageMultiplier: { values: [o.garbagemultiplier], increase: o.garbageincrease, margin: o.garbagemargin },
    garbageCap: { values: [o.garbagecap], increase: o.garbagecapincrease, margin: o.garbagecapmargin },
  };
}

function restoreDynamicTrackers(engine, frame) {
  restoreDynamicTracker(engine.dynamic.gravity, DYNAMIC_TRACKER_CACHE.gravity, frame);
  restoreDynamicTracker(engine.dynamic.garbageMultiplier, DYNAMIC_TRACKER_CACHE.garbageMultiplier, frame);
  restoreDynamicTracker(engine.dynamic.garbageCap, DYNAMIC_TRACKER_CACHE.garbageCap, frame);
}

function restoreDynamicTracker(target, cache, frame) {
  while (cache.values.length <= frame) {
    const nextFrame = cache.values.length;
    const previous = cache.values[nextFrame - 1];
    cache.values.push(nextFrame > cache.margin ? previous + cache.increase / 60 : previous);
  }
  target.set(cache.values[frame]);
  target.frame = frame;
}

function noRotation() {
  return { lastInputWasRotation: false, kickIndex: null, kickId: null, kickOffset: null };
}

function keyEvent(frame, type, key) {
  return { frame, type, data: { key, subframe: 0 } };
}

function comparePlacements(a, b) {
  return Number(a.usedHold) - Number(b.usedHold) ||
    a.piece.localeCompare(b.piece, "en") ||
    ROTATION_NAMES.indexOf(a.rotation) - ROTATION_NAMES.indexOf(b.rotation) ||
    a.x - b.x || a.y - b.y ||
    JSON.stringify(a.movementEvidence.inputs).localeCompare(JSON.stringify(b.movementEvidence.inputs), "en");
}

function assertSupportedState(state, rules, limits, expectedPhase = "spawn-ready") {
  if (state.board?.fidelity !== "exact" || state.pieces?.fidelity !== "exact" || state.time?.fidelity !== "exact") throw new Error("engine-frame controller requires exact board, pieces, and time");
  if (state.board.width !== 10 || state.board.height !== 40 || state.board.visibleHeight !== 20 || state.board.bufferHeight !== 20) throw new Error("engine-frame controller requires exact 10x20+20 S2 board geometry");
  if (state.movement?.phase !== expectedPhase || state.movement?.fidelity !== "exact" || typeof state.movement.lastWasClear !== "boolean") throw new Error(`engine-frame controller requires exact ${expectedPhase} movement state`);
  assertSupportedHandling(state.movement.handling);
  if (state.time.frameSemantics !== "engine-frame") throw new Error("engine-frame controller requires engine-frame time");
  // `consumedThisTick` records rows tanked by the preceding canonical lock.
  // Triangle's continuation snapshot already owns the next active piece and
  // garbage queue; the record is not an input to that next-piece controller.
  // Rejecting it would make every exact continuation after a garbage tank
  // unreachable even though the Engine can continue from the same snapshot.
  if (!Number.isSafeInteger(state.garbage?.capState?.consumedThisTick) ||
      state.garbage.capState.consumedThisTick < 0) {
    throw new Error("engine-frame controller requires a valid garbage cap record");
  }
  if (rules.kickTable !== "SRS+" || rules.allow180 !== true || rules.movementAssumption !== "engine-frame-with-hidden-spawn-buffer") throw new Error("engine-frame controller rules are not supported");
  if (!Number.isSafeInteger(limits.maxInputFrames) || limits.maxInputFrames < 0 || limits.maxInputFrames > 32) throw new Error("maxInputFrames must be an integer from 0 to 32");
  if (!Number.isSafeInteger(limits.maxIdleFrames) || limits.maxIdleFrames < 0 || limits.maxIdleFrames > 8) throw new Error("maxIdleFrames must be an integer from 0 to 8");
  if (!Number.isSafeInteger(limits.maxHeldEdges) || limits.maxHeldEdges < 0 || limits.maxHeldEdges > 8) throw new Error("maxHeldEdges must be an integer from 0 to 8");
  if (!Number.isSafeInteger(limits.maxNodes) || limits.maxNodes < 1 || limits.maxNodes > 1_000_000) throw new Error("maxNodes must be an integer from 1 to 1000000");
  if (!Number.isSafeInteger(limits.maxSnapshotBytes) || limits.maxSnapshotBytes < 1 || limits.maxSnapshotBytes > 1_073_741_824) throw new Error("maxSnapshotBytes must be an integer from 1 to 1073741824");
  if (state.pieces.current === null) throw new Error("engine-frame controller requires a current piece");
}

function assertSupportedHandling(handling) {
  const keys = ["arr", "das", "dcd", "sdf", "safelock", "cancel", "may20g", "irs", "ihs"];
  if (
    handling === null || typeof handling !== "object" || Array.isArray(handling) ||
    Object.keys(handling).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(handling, key))
  ) {
    throw new Error("engine-frame controller requires exact resolved player handling");
  }
  for (const key of ["arr", "das", "dcd", "sdf"]) {
    if (!Number.isFinite(handling[key]) || handling[key] < 0 || handling[key] > Number.MAX_SAFE_INTEGER) {
      throw new Error("engine-frame controller requires exact resolved player handling");
    }
  }
  for (const key of ["safelock", "cancel", "may20g"]) {
    if (typeof handling[key] !== "boolean") {
      throw new Error("engine-frame controller requires exact resolved player handling");
    }
  }
  if (handling.irs !== "off" || handling.ihs !== "off") {
    throw new Error("engine-frame controller requires IRS and IHS off");
  }
}

