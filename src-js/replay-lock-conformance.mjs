import S2_OBSERVED_MANIFEST from "../rulesets/tetrio-s2-v19-beta-1-5-0-observed.json" with { type: "json" };

import { clockForReplayLock } from "./replay-clock.mjs";
import { createPlacedTetromino } from "./triangle/placement-adapter.mjs";
import { triangleSnapshotToCanonical } from "./triangle/garbage-adapter.mjs";

export const REPLAY_LOCK_CONFORMANCE_CONTRACT = Object.freeze({
  id: "s2-replay-lock-conformance/1",
  comparableFields: Object.freeze([
    "legality.legal",
    "lock.lines",
    "lock.spin",
    "lock.perfectClear",
    "lock.garbageCleared",
    "chain.comboAfter",
    "chain.b2bAfter",
    "attack.outgoingBeforeCancel",
    "board.cellsAfter",
    "pieces.currentAfter",
    "pieces.holdAfter",
    "pieces.knownPrefixAfter",
    "garbage.packetsAfter",
    "garbage.generatorStateAfter",
  ]),
  unsupportedFields: Object.freeze([
    Object.freeze({ field: "lock.clearedRows", reason: "replay-ir-has-line-count-only" }),
    Object.freeze({ field: "attack.raw", reason: "replay-ir-has-aggregate-attack-only" }),
    Object.freeze({ field: "attack.afterMultiplier", reason: "replay-ir-has-aggregate-attack-only" }),
    Object.freeze({ field: "attack.afterRounding", reason: "replay-ir-has-aggregate-attack-only" }),
    Object.freeze({ field: "attack.specialBonus", reason: "replay-ir-has-aggregate-attack-only" }),
    Object.freeze({ field: "attack.perfectClearBonus", reason: "replay-ir-has-aggregate-attack-only" }),
    Object.freeze({ field: "attack.surgeChunks", reason: "replay-ir-has-aggregate-attack-only" }),
    Object.freeze({ field: "cancel.perPacket", reason: "replay-ir-does-not-link-cancels-to-lock" }),
    Object.freeze({ field: "cancel.sentAfterCancel", reason: "replay-ir-has-no-per-lock-sent-value" }),
    Object.freeze({ field: "tank.rows", reason: "replay-ir-does-not-link-tanks-to-lock" }),
    Object.freeze({ field: "tank.toppedOut", reason: "replay-ir-has-no-per-lock-topout-result" }),
    Object.freeze({ field: "pieces.generatedTailAfter", reason: "canonical-state-has-no-portable-bag-prng-state" }),
  ]),
});

const PIECES = Object.freeze({ 0: null, 1: "I", 2: "L", 3: "O", 4: "Z", 5: "T", 6: "J", 7: "S" });
const CELLS = Object.freeze({ 0: "_", 1: "I", 2: "L", 3: "O", 4: "Z", 5: "T", 6: "J", 7: "S", 8: "G" });
const ROTATIONS = Object.freeze(["spawn", "right", "reverse", "left"]);

export class ReplayLockConformanceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReplayLockConformanceError";
    this.code = code;
  }
}

/**
 * Builds one exact, one-lock canonical input from a verified ReplayIR player.
 * Unsupported evidence returns a closed refusal instead of a guessed state.
 */
export function buildReplayLockCase(player, lockIndex, options = {}) {
  try {
    return buildCase(player, lockIndex, options);
  } catch (error) {
    if (!(error instanceof ReplayLockConformanceError)) throw error;
    return {
      contractId: REPLAY_LOCK_CONFORMANCE_CONTRACT.id,
      status: "unsupported",
      reason: error.code,
      message: error.message,
      lockIndex,
      state: null,
      action: null,
      observed: null,
      unsupportedFields: structuredClone(REPLAY_LOCK_CONFORMANCE_CONTRACT.unsupportedFields),
    };
  }
}

/** Compares only the fields admitted by s2-replay-lock-conformance/1. */
export function compareReplayLockTransition(replayCase, transition) {
  if (replayCase?.contractId !== REPLAY_LOCK_CONFORMANCE_CONTRACT.id) {
    throw new ReplayLockConformanceError("wrong-contract", "replay case uses a different contract");
  }
  if (replayCase.status !== "ready") {
    return {
      contractId: REPLAY_LOCK_CONFORMANCE_CONTRACT.id,
      status: "unsupported",
      reason: replayCase.reason,
      comparisons: [],
      mismatches: [],
      unsupportedFields: structuredClone(REPLAY_LOCK_CONFORMANCE_CONTRACT.unsupportedFields),
    };
  }
  if (transition === null || typeof transition !== "object") {
    throw new ReplayLockConformanceError("invalid-transition", "transition result must be an object");
  }

  const actual = transitionProjection(replayCase, transition);
  const comparisons = REPLAY_LOCK_CONFORMANCE_CONTRACT.comparableFields.map((field) => {
    const observed = valueAt(replayCase.observed, field);
    const candidate = valueAt(actual, field);
    return { field, status: sameValue(observed, candidate) ? "pass" : "fail", observed, actual: candidate };
  });
  const mismatches = comparisons.filter((entry) => entry.status === "fail").map((entry) => entry.field);
  return {
    contractId: REPLAY_LOCK_CONFORMANCE_CONTRACT.id,
    status: mismatches.length === 0 ? "pass" : "fail",
    reason: null,
    comparisons,
    mismatches,
    unsupportedFields: structuredClone(REPLAY_LOCK_CONFORMANCE_CONTRACT.unsupportedFields),
  };
}

function buildCase(player, lockIndex, options) {
  if (player?.verification?.matched !== true) {
    refuse("replay-ir-unverified", "Replay lock conformance requires a verified PlayerRoundIR");
  }
  const clock = clockForReplayLock(player, lockIndex, { sourceSha256: options.sourceSha256 });
  if (!options.rulesetId || options.rulesetId !== S2_OBSERVED_MANIFEST.id) {
    refuse("ruleset-not-target", "Replay lock conformance requires the canonical observed S2 ruleset id");
  }
  assertTargetOptions(player.resolvedOptions);
  const lock = player.locks[lockIndex];
  if (!lock || lock.pieceIndex !== lockIndex) {
    refuse("invalid-lock-index", "ReplayIR lock index and pieceIndex must agree");
  }
  const rotationEvidence = replayRotationEvidence(lock, options.rotationEvidence);
  const engineEvidence = validatedEngineLockEvidence(options.engineLockEvidence, lock);
  if (lock.frame < 1) refuse("pre-lock-frame-unavailable", "a lock on frame zero has no prior visual frame");
  if (player.locks[lockIndex - 1]?.frame === lock.frame) {
    refuse("same-frame-lock-boundary", "ReplayIR has no distinct visual pre-state between same-frame locks");
  }
  const sameFrameExternalGarbage = player.garbageEvents?.some((event) =>
    event.frame === lock.frame && (event.kind === "receive" || event.kind === "confirm")
  ) ?? false;
  if (engineEvidence === null && sameFrameExternalGarbage) {
    refuse(
      "same-frame-external-garbage",
      "ReplayIR change points do not retain a queue snapshot between same-frame external garbage and lock",
    );
  }

  const preBoard = changePointAt(player.visual?.boards, lock.frame - 1);
  const preGarbage = changePointAt(player.visual?.garbage, lock.frame - 1);
  const postGarbage = changePointAt(player.visual?.garbage, lock.frame);
  if (!preBoard || !preGarbage || !postGarbage) {
    refuse("visual-snapshot-unavailable", "ReplayIR visual board and garbage snapshots are required");
  }
  const clippedBoard = preBoard.clippedRowCount !== 0 || lock.clippedRowCount !== 0 || lock.sourceHeight > 23;
  if (engineEvidence === null && clippedBoard) {
    refuse("visible-board-clipped", "the 23-row ReplayIR board does not prove an exact 40-row canonical board");
  }
  if (engineEvidence !== null) {
    assertRuntimeEvidenceMatchesReplay(engineEvidence, preBoard, postGarbage, lock);
  }

  const queueBefore = lockIndex === 0 ? player.initial : player.locks[lockIndex - 1];
  const queue = mapQueueBefore(queueBefore);
  const piece = mapPiece(lock.piece, "lock piece");
  const usedHold = inferHold(queue, piece);
  const placement = {
    piece,
    rotation: mapRotation(lock.rotation),
    x: lock.x,
    y: lock.y - boxSize(piece) + 1,
    usedHold,
    rotationEvidence,
  };
  const board = preBoard.clippedRowCount === 0
    ? canonicalBoard(preBoard.field)
    : canonicalTriangleBoard(engineEvidence.preLock.snapshot.board);
  assertPoseMatchesCells(board, placement, lock.cells);
  const previousClear = player.locks[lockIndex - 1]?.clear;
  const garbage = canonicalGarbage(sameFrameExternalGarbage
    ? engineEvidence.preLock.snapshot.garbage
    : preGarbage.snapshot);
  const handling = canonicalResolvedHandling(player.resolvedOptions.handling);

  const state = {
    $schema: "s2-analysis-engine/schema/canonical-state/1",
    schemaVersion: 1,
    rulesetId: options.rulesetId,
    board,
    pieces: {
      current: queue.current,
      hold: queue.hold,
      holdAvailable: true,
      known: queue.next,
      queueModel: { type: "7-bag", bagRemaining: [], seed: null, tail: "unknown" },
      fidelity: "exact",
    },
    chain: {
      combo: chainValue(previousClear?.ren),
      b2b: chainValue(previousClear?.b2b),
      fidelity: "exact",
    },
    garbage,
    time: clock.time,
    movement: {
      phase: "active-piece",
      lastWasClear: (previousClear?.lines ?? 0) > 0,
      handling,
      fidelity: "exact",
    },
    informationLoss: [{
      field: "pieces.queueModel.tail",
      reason: "ReplayIR exposes a finite exact queue prefix but not portable bag PRNG state",
      effect: "degraded",
    }],
    provenance: {
      sourcePath: "replay-ir",
      producedBy: REPLAY_LOCK_CONFORMANCE_CONTRACT.id,
      clock: {
        kind: "replay-engine-frame",
        adapter: clock.evidence.adapter,
        sourceSha256: clock.evidence.sourceSha256,
        lockIndex,
        lockFrame: lock.frame,
      },
    },
  };

  return {
    contractId: REPLAY_LOCK_CONFORMANCE_CONTRACT.id,
    status: "ready",
    reason: null,
    lockIndex,
    state,
    action: { kind: "placement", placement },
    observed: observedProjection(
      lock,
      sameFrameExternalGarbage ? engineEvidence.postLockSnapshot.garbage : postGarbage.snapshot,
      queue.next.length - (usedHold && queue.hold === null ? 2 : 1),
      clippedBoard ? canonicalTriangleBoard(engineEvidence.postLockSnapshot.board) : null,
    ),
    unsupportedFields: structuredClone(REPLAY_LOCK_CONFORMANCE_CONTRACT.unsupportedFields),
  };
}

function replayRotationEvidence(lock, providedEvidence) {
  if (lock.clear?.spin === "none") {
    return { lastInputWasRotation: false, kickIndex: null, kickId: null, kickOffset: null };
  }
  const evidence = providedEvidence;
  if (!evidence || evidence.source !== "triangle-instrumented/1") {
    refuse(
      "positive-spin-evidence-unavailable",
      "positive Replay spins require a successful-rotation witness captured inside the pinned Triangle Engine",
    );
  }
  const rotations = [0, 1, 2, 3];
  if (!rotations.includes(evidence.from) || !rotations.includes(evidence.to) || evidence.to !== lock.rotation) {
    refuse("invalid-positive-spin-evidence", "rotation witness does not end at the locked rotation");
  }
  const amount = { cw: 1, ccw: -1, "180": 2 }[evidence.direction];
  if (amount === undefined || ((evidence.from + amount) % 4 + 4) % 4 !== evidence.to) {
    refuse("invalid-positive-spin-evidence", "rotation witness direction disagrees with from/to states");
  }
  if (!Number.isSafeInteger(evidence.kickIndex) || evidence.kickIndex < 0) {
    refuse("invalid-positive-spin-evidence", "rotation witness has an invalid kick index");
  }
  if (!/^[0-3][0-3]$/.test(evidence.kickId ?? "")) {
    refuse("invalid-positive-spin-evidence", "rotation witness has an invalid kick id");
  }
  if (evidence.kickId !== "00" && evidence.kickId !== `${evidence.from}${evidence.to}`) {
    refuse("invalid-positive-spin-evidence", "rotation witness kick id disagrees with from/to states");
  }
  if (!Array.isArray(evidence.kickOffset) || evidence.kickOffset.length !== 2 ||
      !evidence.kickOffset.every(Number.isSafeInteger)) {
    refuse("invalid-positive-spin-evidence", "rotation witness has an invalid kick offset");
  }
  if (!Number.isSafeInteger(evidence.frame) || evidence.frame < 0 ||
      !Number.isFinite(evidence.subframe) || evidence.subframe < 0 || evidence.subframe >= 1 ||
      evidence.frame > lock.frame) {
    refuse("invalid-positive-spin-evidence", "rotation witness has an invalid Engine timestamp");
  }
  return {
    lastInputWasRotation: true,
    kickIndex: evidence.kickIndex,
    kickId: evidence.kickId,
    kickOffset: [...evidence.kickOffset],
  };
}

function validatedEngineLockEvidence(evidence, lock) {
  if (evidence === undefined || evidence === null) return null;
  const pre = evidence.preLock;
  const post = evidence.postLockSnapshot;
  if (!pre?.snapshot || !post || pre.at?.frame !== lock.frame || evidence.at?.frame !== lock.frame) {
    refuse("invalid-engine-lock-evidence", "Engine lock snapshots do not align with the Replay lock frame");
  }
  const falling = pre.snapshot.falling;
  const expectedPiece = mapPiece(lock.piece, "lock piece").toLowerCase();
  if (!falling || falling.symbol !== expectedPiece || falling.rotation !== lock.rotation ||
      falling.location?.[0] !== lock.x || Math.floor(falling.location?.[1]) !== lock.y) {
    refuse("invalid-engine-lock-evidence", "Engine pre-lock pose does not align with PlayerRoundIR");
  }
  canonicalTriangleBoard(pre.snapshot.board);
  canonicalTriangleBoard(post.board);
  canonicalGarbage(pre.snapshot.garbage);
  canonicalGarbage(post.garbage);
  return evidence;
}

function assertRuntimeEvidenceMatchesReplay(evidence, preBoard, postGarbage, lock) {
  const runtimePre = canonicalTriangleBoard(evidence.preLock.snapshot.board);
  const replayPre = canonicalBoard(preBoard.field);
  const runtimePost = canonicalTriangleBoard(evidence.postLockSnapshot.board);
  const replayPost = canonicalBoard(lock.fieldAfter);
  if (runtimePre.cells.slice(0, 230) !== replayPre.cells.slice(0, 230) ||
      runtimePost.cells.slice(0, 230) !== replayPost.cells.slice(0, 230)) {
    refuse("invalid-engine-lock-evidence", "Engine lock board does not match the retained ReplayIR window");
  }
  if (JSON.stringify(canonicalGarbage(evidence.postLockSnapshot.garbage)) !==
      JSON.stringify(canonicalGarbage(postGarbage.snapshot))) {
    refuse("invalid-engine-lock-evidence", "Engine post-lock garbage does not match ReplayIR");
  }
}

function observedProjection(lock, postGarbageSnapshot, continuedQueueLength, exactBoardAfter = null) {
  const postGarbage = canonicalGarbage(postGarbageSnapshot);
  return {
    legality: { legal: true },
    lock: {
      lines: lock.clear.lines,
      spin: lock.clear.spin,
      perfectClear: lock.clear.perfectClear,
      garbageCleared: lock.garbageCleared,
    },
    chain: {
      comboAfter: chainValue(lock.clear.ren),
      b2bAfter: chainValue(lock.clear.b2b),
    },
    attack: { outgoingBeforeCancel: lock.attack },
    board: { cellsAfter: (exactBoardAfter ?? canonicalBoard(lock.fieldAfter)).cells },
    pieces: {
      currentAfter: mapPiece(lock.current, "post-lock current", true),
      holdAfter: mapPiece(lock.hold, "post-lock hold", true),
      knownPrefixAfter: lock.next
        .slice(0, Math.max(0, continuedQueueLength))
        .map((value) => mapPiece(value, "post-lock next")),
    },
    garbage: {
      packetsAfter: postGarbage.packets,
      generatorStateAfter: postGarbage.generatorState,
    },
  };
}

function transitionProjection(replayCase, transition) {
  return {
    legality: { legal: transition.legality?.legal },
    lock: {
      lines: transition.lockResult?.lines,
      spin: transition.lockResult?.spin,
      perfectClear: transition.lockResult?.perfectClear,
      garbageCleared: transition.lockResult === null
        ? undefined
        : inferGarbageCleared(replayCase, transition),
    },
    chain: {
      comboAfter: transition.nextState?.chain?.combo,
      b2bAfter: transition.nextState?.chain?.b2b,
    },
    attack: { outgoingBeforeCancel: transition.attackStages?.outgoingBeforeCancel },
    board: { cellsAfter: transition.nextState?.board?.cells },
    pieces: {
      currentAfter: transition.nextState?.pieces?.current,
      holdAfter: transition.nextState?.pieces?.hold,
      knownPrefixAfter: transition.nextState?.pieces?.known,
    },
    garbage: {
      packetsAfter: transition.nextState?.garbage?.packets,
      generatorStateAfter: transition.nextState?.garbage?.generatorState,
    },
  };
}

// The public transition envelope intentionally omits garbageCleared. It is
// exactly recoverable as the number of cleared rows containing canonical G
// cells in the pre-placement board, so the conformance projection derives it.
function inferGarbageCleared(replayCase, transition) {
  const board = replayCase.state.board;
  return transition.lockResult?.clearedRows?.filter((row) =>
    board.cells.slice(row * board.width, (row + 1) * board.width).includes("G")
  ).length;
}

function canonicalGarbage(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !Array.isArray(snapshot.queue)) {
    refuse("invalid-garbage-snapshot", "ReplayIR garbage snapshot is malformed");
  }
  const nonNegativeIntegers = [
    snapshot.seed,
    snapshot.lastTankTime,
    snapshot.sent,
    snapshot.lastReceivedCount,
  ];
  if (!nonNegativeIntegers.every((value) => Number.isSafeInteger(value) && value >= 0) ||
      !(snapshot.lastColumn === null ||
        (Number.isSafeInteger(snapshot.lastColumn) && snapshot.lastColumn >= 0 && snapshot.lastColumn < 10)) ||
      typeof snapshot.hasChangedColumn !== "boolean") {
    refuse("invalid-garbage-snapshot", "ReplayIR garbage generator snapshot is malformed");
  }
  for (const packet of snapshot.queue) {
    if (!packet || typeof packet !== "object" ||
        ![packet.cid, packet.gameid, packet.amount, packet.size, packet.frame]
          .every((value) => Number.isSafeInteger(value) && value >= 0) ||
        packet.amount <= 0 || packet.size <= 0 || typeof packet.confirmed !== "boolean") {
      refuse("invalid-garbage-snapshot", "ReplayIR garbage packet snapshot is malformed");
    }
  }
  const canonical = triangleSnapshotToCanonical(snapshot, {
    capState: { consumedThisTick: 0 },
    fidelity: "exact",
  });
  assertCanonicalGarbage(canonical);
  return canonical;
}

function assertCanonicalGarbage(garbage) {
  const ints = [
    garbage.generatorState.rngState,
    garbage.generatorState.lastTankFrame,
    garbage.generatorState.sentForOpener,
    garbage.generatorState.receivedCountSinceReset,
  ];
  if (!ints.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    refuse("unrepresentable-garbage-snapshot", "Replay garbage generator state is outside S-STATE/1");
  }
  for (const packet of garbage.packets) {
    if (![packet.packetId, packet.sourceGameId, packet.amount, packet.holeSize, packet.arrivalFrame, packet.order]
      .every((value) => Number.isSafeInteger(value) && value >= 0)) {
      refuse("unrepresentable-garbage-snapshot", "Replay garbage packet is outside S-STATE/1");
    }
  }
}

function canonicalBoard(field) {
  if (!Array.isArray(field) || field.length !== 230) {
    refuse("invalid-replay-board", "ReplayIR board must contain exactly 10 x 23 cells");
  }
  const visible = field.map((value) => {
    const cell = CELLS[value];
    if (cell === undefined) refuse("invalid-replay-board", `unsupported ReplayIR cell ${value}`);
    return cell;
  }).join("");
  return { width: 10, height: 40, cells: visible + "_".repeat(170), fidelity: "exact" };
}

function canonicalTriangleBoard(rows) {
  if (!Array.isArray(rows) || rows.length !== 40 || rows.some((row) => !Array.isArray(row) || row.length !== 10)) {
    refuse("invalid-engine-lock-evidence", "Triangle lock board must contain exactly 10 x 40 cells");
  }
  const cells = rows.flatMap((row) => row.map((cell) => {
    if (cell === null) return "_";
    if (typeof cell !== "object" ||
        !["i", "j", "l", "o", "s", "t", "z", "gb", "bomb"].includes(cell.mino) ||
        !Number.isSafeInteger(cell.connections) || cell.connections < 0 || cell.connections > 31) {
      refuse("invalid-engine-lock-evidence", "Triangle lock board contains a malformed tile");
    }
    const symbol = String(cell.mino).toUpperCase();
    return symbol.length === 1 && "IJLOSTZ".includes(symbol) ? symbol : "G";
  })).join("");
  return { width: 10, height: 40, cells, fidelity: "exact" };
}

function mapQueueBefore(point) {
  if (!point) refuse("queue-snapshot-unavailable", "ReplayIR pre-lock queue point is missing");
  return {
    current: mapPiece(point.current, "pre-lock current", true),
    hold: mapPiece(point.hold, "pre-lock hold", true),
    next: point.next.map((value) => mapPiece(value, "pre-lock next")),
  };
}

function inferHold(queue, placed) {
  if (queue.current === placed) return false;
  const heldPlacement = queue.hold ?? queue.next[0] ?? null;
  if (heldPlacement === placed) return true;
  refuse("piece-sequence-unavailable", "placed piece is not reachable from ReplayIR current/HOLD queue");
}

function mapPiece(value, label, nullable = false) {
  if (value === null && nullable) return null;
  const piece = PIECES[value];
  if (piece === undefined || piece === null) refuse("invalid-replay-piece", `${label} is not a tetromino`);
  return piece;
}

function mapRotation(value) {
  const rotation = ROTATIONS[value];
  if (rotation === undefined) refuse("invalid-replay-rotation", `unsupported ReplayIR rotation ${value}`);
  return rotation;
}

function boxSize(piece) {
  return piece === "I" ? 4 : piece === "O" ? 2 : 3;
}

function assertPoseMatchesCells(board, placement, cells) {
  if (!Array.isArray(cells) || cells.length !== 4 || cells.some((cell) =>
    !Array.isArray(cell) || cell.length !== 2 || !cell.every(Number.isSafeInteger)
  )) {
    refuse("placed-cells-unavailable", "ReplayIR lock needs four exact placed cells");
  }
  if (cells.some(([, y]) => y < 0 || y >= 23)) {
    refuse("placed-cells-clipped", "placed cells leave ReplayIR's exact 23-row board window");
  }
  const reconstructed = createPlacedTetromino(board, placement).absoluteBlocks;
  if (!sameValue(sortCells(reconstructed), sortCells(cells))) {
    refuse("pose-coordinate-mismatch", "ReplayIR pose coordinates do not reconstruct its placed cells");
  }
}

function sortCells(cells) {
  return cells.map(([x, y]) => [x, y]).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
}

function chainValue(raw) {
  return raw === undefined ? 0 : Math.max(0, raw + 1);
}

function changePointAt(points, frame) {
  if (!Array.isArray(points)) return undefined;
  let selected;
  for (const point of points) {
    if (!Number.isSafeInteger(point?.frame) || point.frame > frame) break;
    selected = point;
  }
  return selected;
}

function assertTargetOptions(options) {
  if (!options || typeof options !== "object") {
    refuse("resolved-options-unavailable", "ReplayIR resolved options are required");
  }
  const expectedOptions = S2_OBSERVED_MANIFEST.normalizedOptions;
  for (const [key, expected] of Object.entries(expectedOptions)) {
    if (!Object.hasOwn(options, key) || !sameValue(options[key], expected)) {
      refuse("ruleset-options-mismatch", `ReplayIR option ${key} does not match the target ruleset`);
    }
  }
}

function canonicalResolvedHandling(handling) {
  const numeric = ["arr", "das", "dcd", "sdf"];
  const boolean = ["safelock", "cancel", "may20g"];
  if (!handling || typeof handling !== "object" || Array.isArray(handling)) {
    refuse("resolved-handling-unavailable", "Replay resolved options must retain player handling");
  }
  for (const key of numeric) {
    if (!Number.isFinite(handling[key]) || handling[key] < 0 || handling[key] > Number.MAX_SAFE_INTEGER) {
      refuse("resolved-handling-unavailable", `Replay handling ${key} is outside S-STATE/1`);
    }
  }
  for (const key of boolean) {
    if (typeof handling[key] !== "boolean") {
      refuse("resolved-handling-unavailable", `Replay handling ${key} is not boolean`);
    }
  }
  if (!["off", "hold", "tap"].includes(handling.irs) || !["off", "hold", "tap"].includes(handling.ihs)) {
    refuse("resolved-handling-unavailable", "Replay IRS/IHS handling is outside S-STATE/1");
  }
  return Object.fromEntries([...numeric, ...boolean, "irs", "ihs"].map((key) => [key, handling[key]]));
}

function valueAt(object, path) {
  return path.split(".").reduce((value, key) => value?.[key], object);
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function refuse(code, message) {
  throw new ReplayLockConformanceError(code, message);
}
