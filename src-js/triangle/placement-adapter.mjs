import { Board, Mino, Tetromino, kickData, legal } from "@haelp/teto/engine";

import { resolveDynamicValue } from "../dynamic-values.mjs";
import { record } from "../trace.mjs";
import { tankGarbage, triangleGarbageOptions } from "./garbage-adapter.mjs";
import { evaluateLockStages } from "./lock-stages.mjs";

export const FOUNDATION_PLACEMENT_RULES = Object.freeze({
  perfectClearB2bBonus: 1,
  perfectClearGarbage: 10,
  spinBonuses: "T-spins",
  comboTable: "none",
  garbageTargetBonus: "none",
  b2bChaining: true,
  b2bCharging: false,
  rounding: "down",
  specialBonus: true,
  openerPhase: 0,
  enemies: 1,
  // Time-dependent values are declared as `IncreaseTracker` specs rather than
  // as numbers, so a ruleset that ramps them over a round is a rule value and
  // not a separate code path. `increase: 0` is the static case (SIM-003).
  garbageMultiplier: Object.freeze({ base: 1, increase: 0, marginFrames: 0 }),
  garbageCap: Object.freeze({ base: 100, increase: 0, marginFrames: 0 }),
  // Where a tanked row leaves its hole, how wide that hole is, and how long a
  // packet has to sit before it can be tanked. All three are rule values that
  // change the resulting board, so they are resolved from the ruleset.
  garbageMessiness: Object.freeze({
    change: 0,
    within: 0,
    nosame: false,
    timeout: 0,
    center: false,
  }),
  garbageHole: Object.freeze({ size: 1, speed: 0 }),
  garbageBombs: false,
  kickTable: "SRS",
  allow180: true,
  // The search generator is qualified only for this placement-level model.
  // Frame timing, blockout, and hidden spawn-buffer rules require a different
  // movement assumption and must be rejected before move generation.
  movementAssumption: "unrestricted-within-kickset",
});

export const ROTATIONS = Object.freeze({ spawn: 0, right: 1, reverse: 2, left: 3 });
const CELL_TO_MINO = Object.freeze({
  I: Mino.I,
  J: Mino.J,
  L: Mino.L,
  O: Mino.O,
  S: Mino.S,
  T: Mino.T,
  Z: Mino.Z,
  G: Mino.GARBAGE,
});
const MINO_TO_CELL = Object.freeze(
  Object.fromEntries(Object.entries(CELL_TO_MINO).map(([cell, mino]) => [mino, cell])),
);

export function evaluatePlacement(
  state,
  placement,
  rules = FOUNDATION_PLACEMENT_RULES,
  trace = null,
) {
  const invalid = validatePlacementInput(state, placement, rules);
  if (invalid) {
    record(trace, "legality", { legal: false, reason: invalid });
    return illegalResult(invalid);
  }

  // The queue options are derived from the resolved ruleset and the board, so
  // a placement cannot run under hole geometry the fixture never declared.
  const garbageOptions = triangleGarbageOptions(rules, {
    seed: state.garbage.generatorState.rngState,
    boardWidth: state.board.width,
  });
  record(trace, "garbage-options", {
    messiness: garbageOptions.messiness,
    hole: garbageOptions.garbage,
    rounding: garbageOptions.rounding,
    boardWidth: garbageOptions.boardWidth,
    seed: garbageOptions.seed,
  });

  const board = canonicalBoardToTriangle(state.board);
  const piece = createPlacedTetromino(state.board, placement);
  const blocks = piece.absoluteBlocks;
  if (!legal(blocks, board.state)) {
    const reason = classifyIllegal(blocks, board);
    record(trace, "legality", { legal: false, reason });
    return illegalResult(reason);
  }
  if (legal(blocks.map(([x, y]) => [x, y - 1]), board.state)) {
    record(trace, "legality", { legal: false, reason: "rotation-unreachable" });
    return illegalResult("rotation-unreachable");
  }
  record(trace, "legality", { legal: true, reason: null, blocks });

  const spin = detectSpin(piece, board, placement, rules);
  const clearedRows = fullRowsAfterPlacement(board, blocks);
  board.add(...blocks.map(([x, y]) => [{ mino: piece.symbol, connections: 0 }, x, y]));
  const cleared = board.clearLines();
  const perfectClear = board.perfectClear;
  const clear = {
    lines: cleared.lines,
    spin,
    piece: placement.piece,
    perfectClear,
    garbageCleared: cleared.garbageCleared,
  };
  // Triangle reads both trackers at lock time, so the multiplier that scales
  // this attack and the cap that bounds this tank are the values as of the
  // frame the placement locks on.
  const multiplier = resolveDynamicValue(rules.garbageMultiplier, state.time);
  record(trace, "dynamic-values", {
    frame: state.time.logicalFrame,
    frameSemantics: state.time.frameSemantics,
    garbageMultiplier: { spec: rules.garbageMultiplier, value: multiplier },
    garbageCap: {
      spec: rules.garbageCap,
      value: resolveDynamicValue(rules.garbageCap, state.time),
    },
  });
  record(trace, "clear", clear);
  const stages = evaluateLockStages({
    chain: { combo: state.chain.combo, b2b: state.chain.b2b },
    clear,
    enemies: rules.enemies,
    multiplier,
    piecesPlaced: state.time.piecesPlaced,
    rules,
    garbage: state.garbage,
    garbageOptions,
  });
  record(trace, "attack", {
    chain: stages.chain,
    attackStages: stages.attackStages,
    surgeAmount: stages.surgeAmount,
    outgoingAfterCancel: stages.outgoingChunks,
  });

  let nextGarbage = stages.nextGarbage;
  let tankResult = { inserted: [], deferred: structuredClone(nextGarbage.packets), toppedOut: false };
  if (cleared.lines === 0) {
    const tank = tankGarbage(
      nextGarbage,
      {
        frame: state.time.logicalFrame,
        cap: resolveDynamicValue(rules.garbageCap, state.time),
        hard: true,
      },
      garbageOptions,
    );
    nextGarbage = tank.nextGarbage;
    tankResult = tank.tankResult;
    record(trace, "tank", {
      frame: state.time.logicalFrame,
      inserted: tankResult.inserted,
      deferred: tankResult.deferred,
    });
    for (let index = 0; index < tankResult.inserted.length; index += 1) {
      const row = tankResult.inserted[index];
      board.insertGarbage({
        amount: row.amount,
        size: row.holeSize,
        column: row.holeColumn,
        bombs: garbageOptions.bombs,
        isBeginning:
          index === 0 || tankResult.inserted[index - 1].packetId !== row.packetId,
        isEnd:
          index === tankResult.inserted.length - 1 ||
          tankResult.inserted[index + 1].packetId !== row.packetId,
      });
    }
  }

  const nextState = structuredClone(state);
  nextState.board.cells = triangleBoardToCanonicalCells(board);
  const pieceTransition = advancePieces(state.pieces, placement.usedHold);
  nextState.pieces.current = pieceTransition.current;
  nextState.pieces.hold = pieceTransition.hold;
  nextState.pieces.known = pieceTransition.known;
  nextState.pieces.holdAvailable = true;
  nextState.chain = {
    combo: stages.chain.comboAfter,
    b2b: stages.chain.b2bAfter,
    fidelity: state.chain.fidelity,
  };
  nextState.garbage = nextGarbage;
  nextState.time.piecesPlaced += 1;
  if (state.time.frameSemantics === "virtual-tank-only" && cleared.lines === 0) {
    nextState.time.logicalFrame += 1;
  }

  return {
    legality: { legal: true, reason: null },
    lockResult: {
      clearedRows,
      lines: cleared.lines,
      spin,
      perfectClear,
    },
    chain: stages.chain,
    attackStages: stages.attackStages,
    cancelResult: stages.cancelResult,
    tankResult,
    nextState,
  };
}

function validatePlacementInput(state, placement, rules) {
  if (state.board?.fidelity !== "exact" || state.pieces?.fidelity !== "exact") {
    throw new Error("placement evaluation requires exact board and piece state");
  }
  if (state.chain?.fidelity !== "exact" || state.garbage?.fidelity !== "exact") {
    throw new Error("placement evaluation requires exact chain and garbage state");
  }
  if (placement.usedHold && !state.pieces.holdAvailable) return "hold-unavailable";
  const availablePiece = placement.usedHold
    ? (state.pieces.hold ?? state.pieces.known[0] ?? null)
    : state.pieces.current;
  if (placement.piece !== availablePiece) return "piece-unavailable";
  if (!(placement.rotation in ROTATIONS)) return "rotation-unreachable";
  if (!Number.isSafeInteger(placement.x) || !Number.isSafeInteger(placement.y)) {
    return "out-of-bounds";
  }
  if (placement.rotationEvidence?.lastInputWasRotation) {
    if (
      !Number.isSafeInteger(placement.rotationEvidence.kickIndex) ||
      placement.rotationEvidence.kickIndex < 0
    ) {
      throw new Error("rotation evidence requires a non-negative kick index");
    }
    if (!/^[0-3][0-3]$/.test(placement.rotationEvidence.kickId ?? "")) {
      throw new Error("rotation evidence requires a rotation transition id");
    }
    if (
      !Array.isArray(placement.rotationEvidence.kickOffset) ||
      placement.rotationEvidence.kickOffset.length !== 2 ||
      !placement.rotationEvidence.kickOffset.every(Number.isSafeInteger)
    ) {
      throw new Error("rotation evidence requires an integer kick offset");
    }
    assertKickEvidence(placement.piece, placement.rotationEvidence, rules.kickTable);
  } else if (placement.rotationEvidence?.kickIndex !== null) {
    throw new Error("non-rotation placement cannot have a kick index");
  }
  return null;
}

export function canonicalBoardToTriangle(canonical) {
  if (!Number.isSafeInteger(canonical.width) || canonical.width <= 0) {
    throw new Error("board width must be a positive safe integer");
  }
  if (!Number.isSafeInteger(canonical.height) || canonical.height <= 0) {
    throw new Error("board height must be a positive safe integer");
  }
  if (typeof canonical.cells !== "string" || canonical.cells.length !== canonical.width * canonical.height) {
    throw new Error("board cells must contain width * height cells");
  }

  const board = new Board({ width: canonical.width, height: canonical.height, buffer: 0 });
  for (let index = 0; index < canonical.cells.length; index += 1) {
    const cell = canonical.cells[index];
    if (cell === "_") continue;
    const mino = CELL_TO_MINO[cell];
    if (!mino) throw new Error(`unsupported canonical board cell ${cell}`);
    board.add([{ mino, connections: 0 }, index % canonical.width, Math.floor(index / canonical.width)]);
  }
  return board;
}

function triangleBoardToCanonicalCells(board) {
  return board.state
    .flatMap((row) => row.map((tile) => (tile === null ? "_" : MINO_TO_CELL[tile.mino])))
    .join("");
}

export function createPlacedTetromino(board, placement) {
  const symbol = CELL_TO_MINO[placement.piece];
  if (!symbol || symbol === Mino.GARBAGE) throw new Error(`unsupported piece ${placement.piece}`);
  const piece = new Tetromino({
    symbol,
    initialRotation: ROTATIONS[placement.rotation],
    boardHeight: board.height,
    boardWidth: board.width,
  });
  const boxSize = placement.piece === "I" ? 4 : placement.piece === "O" ? 2 : 3;
  piece.x = placement.x;
  piece.y = placement.y + boxSize - 1;
  return piece;
}

function detectSpin(piece, board, placement, rules) {
  if (!placement.rotationEvidence.lastInputWasRotation || rules.spinBonuses === "none") {
    return "none";
  }
  const tSpin = piece.symbol === Mino.T ? detectTCornerSpin(board, placement) : false;
  const allSpin = isAllSpinPosition(piece, board);
  switch (rules.spinBonuses) {
    case "stupid":
      return isStupidSpinPosition(piece, board) ? "normal" : "none";
    case "T-spins":
      return tSpin || "none";
    case "T-spins+":
      return maxSpin(tSpin || "none", allSpin && piece.symbol === Mino.T ? "mini" : "none");
    case "all":
      return tSpin || (allSpin ? "normal" : "none");
    case "all-mini":
      return tSpin || (allSpin ? "mini" : "none");
    case "all+":
      return maxSpin(
        tSpin || "none",
        allSpin ? (piece.symbol === Mino.T ? "mini" : "normal") : "none",
      );
    case "all-mini+":
      return maxSpin(tSpin || "none", allSpin ? "mini" : "none");
    case "mini-only":
      return tSpin === "normal"
        ? "mini"
        : maxSpin(tSpin || "none", allSpin ? "mini" : "none");
    default:
      throw new Error(`unsupported spin bonus mode ${rules.spinBonuses}`);
  }
}

function detectTCornerSpin(board, placement) {
  const pivotX = placement.x + 1;
  const pivotY = placement.y + 1;
  const corners = {
    topLeft: board.occupied(pivotX - 1, pivotY + 1),
    topRight: board.occupied(pivotX + 1, pivotY + 1),
    bottomLeft: board.occupied(pivotX - 1, pivotY - 1),
    bottomRight: board.occupied(pivotX + 1, pivotY - 1),
  };
  if (Object.values(corners).filter(Boolean).length < 3) return "none";

  const frontByRotation = {
    spawn: [corners.topLeft, corners.topRight],
    right: [corners.topRight, corners.bottomRight],
    reverse: [corners.bottomLeft, corners.bottomRight],
    left: [corners.topLeft, corners.bottomLeft],
  };
  const frontCorners = frontByRotation[placement.rotation].filter(Boolean).length;
  return frontCorners === 2 || isFinOrTstKick(placement.rotationEvidence) ? "normal" : "mini";
}

function isAllSpinPosition(piece, board) {
  return [
    [-1, 0],
    [1, 0],
    [0, 1],
    [0, -1],
  ].every(([dx, dy]) =>
    !legal(
      piece.absoluteBlocks.map(([x, y]) => [x + dx, y + dy]),
      board.state,
    ),
  );
}

function isStupidSpinPosition(piece, board) {
  return !legal(
    piece.absoluteBlocks.map(([x, y]) => [x, y - 1]),
    board.state,
  );
}

function maxSpin(...spins) {
  const score = { none: 0, mini: 1, normal: 2 };
  return spins.reduce((best, spin) => (score[spin] >= score[best] ? spin : best));
}

function isFinOrTstKick(evidence) {
  const [x, y] = evidence.kickOffset;
  return (
    ((evidence.kickId === "23" || evidence.kickId === "03") && x === 1 && y === -2) ||
    ((evidence.kickId === "21" || evidence.kickId === "01") && x === -1 && y === -2)
  );
}

function assertKickEvidence(piece, evidence, kickTableName) {
  const [x, y] = evidence.kickOffset;
  if (evidence.kickId === "00") {
    if (evidence.kickIndex !== 0 || x !== 0 || y !== 0) {
      throw new Error("rotation evidence does not match the no-kick result");
    }
    return;
  }

  const table = kickData[kickTableName];
  if (!table) throw new Error(`unsupported kick table ${kickTableName}`);
  const customKey = `${piece.toLowerCase()}_kicks`;
  const tests = (table[customKey] ?? table.kicks)[evidence.kickId];
  const test = tests?.[evidence.kickIndex];
  if (!test || test[0] !== x || -test[1] !== y) {
    throw new Error("rotation evidence does not match the configured kick table");
  }
}

function classifyIllegal(blocks, board) {
  return blocks.some(([x, y]) => x < 0 || y < 0 || x >= board.width || y >= board.fullHeight)
    ? "out-of-bounds"
    : "collision";
}

function fullRowsAfterPlacement(board, blocks) {
  const occupied = new Set(blocks.map(([x, y]) => `${x}:${y}`));
  const rows = [...new Set(blocks.map(([, y]) => y))].sort((left, right) => left - right);
  return rows.filter((y) => {
    if (y < 0 || y >= board.fullHeight) return false;
    return board.state[y].every((tile, x) => tile !== null || occupied.has(`${x}:${y}`));
  });
}

function advancePieces(pieces, usedHold) {
  if (!usedHold) {
    return {
      current: pieces.known[0] ?? null,
      hold: pieces.hold,
      known: pieces.known.slice(1),
    };
  }
  if (pieces.hold !== null) {
    return {
      current: pieces.known[0] ?? null,
      hold: pieces.current,
      known: pieces.known.slice(1),
    };
  }
  return {
    current: pieces.known[1] ?? null,
    hold: pieces.current,
    known: pieces.known.slice(2),
  };
}

function illegalResult(reason) {
  return {
    legality: { legal: false, reason },
    lockResult: null,
    chain: null,
    attackStages: null,
    cancelResult: null,
    tankResult: null,
    nextState: null,
  };
}
