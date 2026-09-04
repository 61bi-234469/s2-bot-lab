import { kickData, legal } from "@haelp/teto/engine";

import {
  ROTATIONS,
  canonicalBoardToTriangle,
  createPlacedTetromino,
} from "./placement-adapter.mjs";

// Placements reachable by rotating at the top of the field, moving sideways,
// and hard dropping. This is deliberately not the full legal-move set: tucks,
// slides under overhangs, and any placement whose final input is a rotation
// (every spin) are unreachable this way and are not generated. The name says
// so because a caller that mistakes an incomplete move set for a complete one
// would silently rank against moves that were never offered.
//
// The generator under-generates rather than over-generates. A column whose top
// is already blocked yields nothing instead of a guess about how the piece got
// underneath.
const HARD_DROP_EVIDENCE = Object.freeze({ lastInputWasRotation: false, kickIndex: null });
const ROTATION_NAMES = Object.freeze(["spawn", "right", "reverse", "left"]);

export function generateHardDropPlacements(state) {
  assertExactMoveState(state);
  const board = canonicalBoardToTriangle(state.board);

  const sources = [{ usedHold: false, piece: state.pieces.current }];
  if (state.pieces.holdAvailable) {
    // An empty hold slot swaps in the queue head, so the piece that becomes
    // current is the head, not the (absent) held piece.
    const held = state.pieces.hold ?? state.pieces.known[0] ?? null;
    sources.push({ usedHold: true, piece: held });
  }

  const placements = [];
  const seen = new Set();
  for (const { usedHold, piece } of sources) {
    if (piece === null) continue;
    for (const rotation of Object.keys(ROTATIONS)) {
      for (let x = -3; x < state.board.width + 3; x += 1) {
        const placement = { piece, rotation, x, y: 0, usedHold, rotationEvidence: HARD_DROP_EVIDENCE };
        const landed = hardDrop(board, placement);
        if (landed === null) continue;

        // Rotations of the same piece can occupy identical cells (every O
        // rotation, and half of I/S/Z). They produce the same next state, so
        // only the first rotation in canonical order is kept. Triangle lists
        // the same cells in a different order per rotation, so the identity has
        // to be order-independent.
        const identity = `${usedHold}:${cellIdentity(landed.blocks)}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        placements.push({ ...placement, y: landed.y });
      }
    }
  }
  return placements;
}

// Reachability under the manifest's `unrestricted-within-kickset` assumption.
// The graph uses discrete left/right/down inputs plus CW/CCW/180 rotations and
// the selected Triangle kick table. Timing, gravity, DAS and lock reset limits
// are intentionally outside this placement-level model.
export function generateReachablePlacements(
  state,
  movementRules = { kickTable: "SRS", allow180: true },
) {
  const { board, kickTable, sources } = reachableInputs(state, movementRules);

  const placements = [];
  const placementIds = new Set();
  for (const source of sources) {
    if (source.piece === null) continue;
    for (const placement of reachableForSource(board, state.board, source, kickTable, movementRules)) {
      const identity = placementIdentity(board, placement);
      if (placementIds.has(identity)) continue;
      placementIds.add(identity);
      placements.push(placement);
    }
  }
  placements.sort(comparePlacements);
  return placements;
}

// Find only the independently-generated S2 kick witness for one player lock.
// This deliberately walks the same graph, in the same order, as the exhaustive
// generator above. It stops once the target lock state is reached instead of
// allocating, deduplicating, and sorting every other reachable placement.
export function findReachableRotationPlacement(
  state,
  target,
  movementRules = { kickTable: "SRS", allow180: true },
) {
  const { board, kickTable, sources } = reachableInputs(state, movementRules);
  if (target?.rotationEvidence?.lastInputWasRotation !== true) return null;
  const targetFinOrTst = isFinOrTstEvidence(target.rotationEvidence);
  const source = sources.find((entry) =>
    entry.piece === target.piece && entry.usedHold === target.usedHold
  );
  if (source === undefined || source.piece === null) return null;

  for (const placement of reachableForSource(board, state.board, source, kickTable, movementRules)) {
    if (
      sameFinalPlacement(placement, target) &&
      placement.rotationEvidence.lastInputWasRotation &&
      isFinOrTstEvidence(placement.rotationEvidence) === targetFinOrTst
    ) {
      return placement;
    }
  }
  return null;
}

function* reachableForSource(board, canonicalBoard, source, kickTable, movementRules) {
  const spawnIndex = kickTable.spawn_rotation?.[source.piece.toLowerCase()] ?? 0;
  const spawnRotations = [
    ROTATION_NAMES[spawnIndex],
    ...ROTATION_NAMES.filter((_, index) => index !== spawnIndex),
  ];
  const queue = [];
  const visited = new Set();

  // Canonical boards omit the engine's hidden spawn buffer. Seeding every
  // legal top entry models unrestricted movement above the represented field
  // without claiming frame-accurate blockout behaviour.
  for (const rotation of spawnRotations) {
    for (let x = -4; x < canonicalBoard.width + 4; x += 1) {
      const seed = {
        piece: source.piece,
        rotation,
        x,
        y: 0,
        usedHold: source.usedHold,
        // IRS or rotation above the represented board is followed by descent,
        // so it cannot be evidence for a spin at the eventual lock position.
        rotationEvidence: HARD_DROP_EVIDENCE,
      };
      const topY = highestInBoundsY(board, seed);
      if (topY === null || !isLegalAt(board, seed, topY)) continue;
      enqueue(queue, visited, { ...seed, y: topY });
    }
  }

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    if (!isLegalAt(board, current, current.y - 1)) yield current;

    for (const dx of [-1, 1]) {
      const moved = {
        ...current,
        x: current.x + dx,
        rotationEvidence: HARD_DROP_EVIDENCE,
      };
      if (isLegalAt(board, moved, moved.y)) enqueue(queue, visited, moved);
    }
    const down = { ...current, y: current.y - 1, rotationEvidence: HARD_DROP_EVIDENCE };
    if (isLegalAt(board, down, down.y)) enqueue(queue, visited, down);

    const amounts = movementRules.allow180 === false ? [1, -1] : [1, -1, 2];
    for (const amount of amounts) {
      const rotated = rotateWithKicks(board, current, amount, kickTable);
      if (rotated !== null) enqueue(queue, visited, rotated);
    }
  }
}

function reachableInputs(state, movementRules) {
  assertExactMoveState(state);
  const board = canonicalBoardToTriangle(state.board);
  const kickTable = kickData[movementRules.kickTable];
  if (kickTable === undefined) throw new Error(`unknown kick table ${movementRules.kickTable}`);
  if (Object.keys(kickTable.additional_offsets ?? {}).length !== 0) {
    throw new Error(`kick table ${movementRules.kickTable} has unsupported additional offsets`);
  }

  const sources = [{ usedHold: false, piece: state.pieces.current }];
  if (state.pieces.holdAvailable) {
    sources.push({ usedHold: true, piece: state.pieces.hold ?? state.pieces.known[0] ?? null });
  }
  return { board, kickTable, sources };
}

function rotateWithKicks(board, current, amount, kickTable) {
  const from = ROTATIONS[current.rotation];
  const to = ((from + amount) % 4 + 4) % 4;
  const rotation = ROTATION_NAMES[to];
  const direct = {
    ...current,
    rotation,
    rotationEvidence: {
      lastInputWasRotation: true,
      kickIndex: 0,
      kickId: "00",
      kickOffset: [0, 0],
    },
  };
  if (isLegalAt(board, direct, direct.y)) return direct;

  const kickId = `${from}${to}`;
  const customKey = `${current.piece.toLowerCase()}_kicks`;
  const tests = (kickTable[customKey] ?? kickTable.kicks)?.[kickId];
  if (!Array.isArray(tests)) return null;
  for (let index = 0; index < tests.length; index += 1) {
    const [dx, dy] = tests[index];
    const kicked = {
      ...current,
      rotation,
      x: current.x + dx,
      y: current.y - dy,
      rotationEvidence: {
        lastInputWasRotation: true,
        kickIndex: index,
        kickId,
        kickOffset: [dx, -dy],
      },
    };
    if (isLegalAt(board, kicked, kicked.y)) return kicked;
  }
  return null;
}

function enqueue(queue, visited, placement) {
  const identity = stateIdentity(placement);
  if (visited.has(identity)) return;
  visited.add(identity);
  queue.push(placement);
}

function stateIdentity(placement) {
  const evidence = placement.rotationEvidence;
  return [
    placement.x,
    placement.y,
    placement.rotation,
    evidence.lastInputWasRotation ? 1 : 0,
    isFinOrTstEvidence(evidence) ? 1 : 0,
  ].join(":");
}

function placementIdentity(board, placement) {
  const evidence = placement.rotationEvidence;
  return [
    placement.usedHold ? 1 : 0,
    cellIdentity(blocksAt(board, placement, placement.y)),
    placement.rotation,
    evidence.lastInputWasRotation ? 1 : 0,
    isFinOrTstEvidence(evidence) ? 1 : 0,
  ].join(":");
}

function isFinOrTstEvidence(evidence) {
  if (!evidence.lastInputWasRotation || !Array.isArray(evidence.kickOffset)) return false;
  const [x, y] = evidence.kickOffset;
  return (
    ((evidence.kickId === "23" || evidence.kickId === "03") && x === 1 && y === -2) ||
    ((evidence.kickId === "21" || evidence.kickId === "01") && x === -1 && y === -2)
  );
}

function sameFinalPlacement(left, right) {
  return left.piece === right.piece &&
    left.rotation === right.rotation &&
    left.x === right.x &&
    left.y === right.y &&
    left.usedHold === right.usedHold;
}

function comparePlacements(left, right) {
  return (
    Number(left.usedHold) - Number(right.usedHold) ||
    left.piece.localeCompare(right.piece, "en") ||
    ROTATIONS[left.rotation] - ROTATIONS[right.rotation] ||
    left.x - right.x ||
    left.y - right.y ||
    stateIdentity(left).localeCompare(stateIdentity(right), "en")
  );
}

function cellIdentity(blocks) {
  return blocks
    .map(([x, y]) => `${x},${y}`)
    .sort()
    .join("|");
}

function hardDrop(board, placement) {
  const topY = highestInBoundsY(board, placement);
  if (topY === null) return null;

  let y = topY;
  // The piece has to exist at the top before it can fall from there.
  if (!isLegalAt(board, placement, y)) return null;
  while (isLegalAt(board, placement, y - 1)) y -= 1;

  return { y, blocks: blocksAt(board, placement, y) };
}

function highestInBoundsY(board, placement) {
  const spans = blocksAt(board, placement, 0);
  const highestOffset = Math.max(...spans.map(([, y]) => y));
  const lowestOffset = Math.min(...spans.map(([, y]) => y));
  const topY = board.fullHeight - 1 - highestOffset;
  return topY + lowestOffset < 0 ? null : topY;
}

function isLegalAt(board, placement, y) {
  const blocks = blocksAt(board, placement, y);
  if (blocks.some(([bx, by]) => bx < 0 || by < 0 || bx >= board.width || by >= board.fullHeight)) {
    return false;
  }
  return legal(blocks, board.state);
}

function blocksAt(board, placement, y) {
  return createPlacedTetromino(board, { ...placement, y }).absoluteBlocks;
}

function assertExactMoveState(state) {
  if (state.board?.fidelity !== "exact" || state.pieces?.fidelity !== "exact") {
    throw new Error("move generation requires exact board and piece state");
  }
  const holdSource = state.pieces.holdAvailable
    ? (state.pieces.hold ?? state.pieces.known[0] ?? null)
    : null;
  if (state.pieces.current === null && holdSource === null) {
    throw new Error("move generation requires a current piece or a resolvable hold source");
  }
}
