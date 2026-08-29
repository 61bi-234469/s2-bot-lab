export const PIECES = Object.freeze(["I", "O", "T", "L", "J", "S", "Z"]);
export const QUEUE_MODE_LEGACY_LCG = "legacy-lcg";
export const QUEUE_MODE_TRIANGLE_7_BAG = "triangle-7-bag";

const CELLS = Object.freeze({
  I: [[-1, 0], [0, 0], [1, 0], [2, 0]],
  O: [[0, 0], [1, 0], [0, 1], [1, 1]],
  T: [[-1, 0], [0, 0], [1, 0], [0, 1]],
  L: [[-1, 0], [0, 0], [1, 0], [1, 1]],
  J: [[-1, 0], [0, 0], [1, 0], [-1, 1]],
  S: [[-1, 0], [0, 0], [0, 1], [1, 1]],
  Z: [[-1, 1], [0, 1], [0, 0], [1, 0]],
});

export function createGame(seed = 0x5e2, { queueModel = QUEUE_MODE_LEGACY_LCG } = {}) {
  assertUint32(seed, "game seed");
  if (![QUEUE_MODE_LEGACY_LCG, QUEUE_MODE_TRIANGLE_7_BAG].includes(queueModel)) {
    throw new Error(`unsupported queue model ${queueModel}`);
  }
  const queueSource = queueModel === QUEUE_MODE_TRIANGLE_7_BAG
    ? initialTriangleQueue(seed, 12)
    : initialQueue(seed, 12);
  return {
    board: Array.from({ length: 40 }, () => Array(10).fill(null)),
    lastPlaced: [],
    lastPlacedPiece: null,
    lastPlacedFromHold: false,
    queue: queueSource.queue,
    hold: null,
    combo: 0,
    s2: {
      b2b: 0,
      garbage: {
        packets: [],
        generatorState: {
          rngState: 123456789,
          lastTankFrame: 0,
          lastHoleColumn: -1,
          sentForOpener: 0,
          holeChanged: false,
          receivedCountSinceReset: 0,
        },
        capState: { consumedThisTick: 0 },
        fidelity: "exact",
      },
      time: {
        logicalFrame: 0,
        frameSemantics: "engine-frame",
        piecesPlaced: 0,
        fidelity: "exact",
      },
      movement: {
        phase: "spawn-ready",
        lastWasClear: false,
        handling: {
          arr: 0,
          das: 0,
          dcd: 0,
          sdf: 1,
          safelock: false,
          cancel: true,
          may20g: true,
          irs: "off",
          ihs: "off",
        },
        fidelity: "exact",
      },
      clock: {
        kind: "synthetic-fixed-lock-step",
        framesPerLock: 60,
      },
    },
    backToBack: false,
    lastClear: "",
    pieces: 0,
    lines: 0,
    attack: 0,
    garbageCleared: 0,
    bagSeed: queueSource.bagSeed,
    queueModel,
    toppedOut: false,
  };
}

function initialQueue(seed, bagCount) {
  const result = [];
  let value = seed >>> 0;
  for (let index = 0; index < bagCount; index += 1) {
    value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
    result.push(...bag(value));
  }
  return { queue: result, bagSeed: value };
}

export function extendSeededQueue(queue, bagSeed, minimumLength = 14) {
  if (!Array.isArray(queue) || !queue.every((piece) => PIECES.includes(piece))) {
    throw new Error("queue must contain only tetromino names");
  }
  if (!Number.isSafeInteger(bagSeed) || bagSeed < 0 || bagSeed > 0xffff_ffff) {
    throw new Error("bag seed must be an unsigned 32-bit integer");
  }
  if (!Number.isSafeInteger(minimumLength) || minimumLength < 1) {
    throw new Error("minimum queue length must be a positive integer");
  }
  const extended = [...queue];
  let nextSeed = bagSeed;
  while (extended.length < minimumLength) {
    nextSeed = (Math.imul(nextSeed, 1664525) + 1013904223) >>> 0;
    extended.push(...bag(nextSeed));
  }
  return { queue: extended, bagSeed: nextSeed };
}

/**
 * Extends a queue with the exact Park-Miller/Fisher-Yates 7-bag used by
 * Triangle Engine. This is opt-in because the older GUI match format uses its
 * own LCG randomizer and changing it would invalidate existing JSON exports.
 */
export function extendTriangleSeededQueue(queue, bagSeed, minimumLength = 14) {
  assertQueue(queue);
  assertTriangleSeed(bagSeed);
  if (!Number.isSafeInteger(minimumLength) || minimumLength < 1) {
    throw new Error("minimum queue length must be a positive integer");
  }
  const extended = [...queue];
  let nextSeed = bagSeed;
  while (extended.length < minimumLength) {
    const generated = triangleBag(nextSeed);
    nextSeed = generated.seed;
    extended.push(...generated.bag);
  }
  return { queue: extended, bagSeed: nextSeed };
}

function assertUint32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${label} must be an unsigned 32-bit integer`);
  }
}

export function toCc2State(game) {
  return {
    board: game.board.map((row) => row.map((cell) => cell === null ? null : cell)),
    queue: game.queue.slice(0, 14),
    hold: game.hold,
    combo: game.combo,
    back_to_back: game.backToBack,
    randomizer: { type: "seven_bag", bag_state: [] },
  };
}

export function toS2GuiState(game) {
  return {
    ...toCc2State(game),
    // Canonical Simulator and match state retain the complete deterministic
    // prefix. Only the external TBP request is truncated to its display/search
    // window by toCc2State().
    queue: [...game.queue],
    s2: structuredClone(game.s2),
  };
}

export function applyS2Transition(game, move, result) {
  const transition = result?.transition;
  if (!transition?.legality?.legal || transition.nextState === null) {
    throw new Error(`S2 Simulator rejected placement: ${transition?.legality?.reason ?? "unknown"}`);
  }
  const next = transition.nextState;
  const scenarioFrameBefore = game.s2.time.logicalFrame;
  const boardBefore = game.board;
  const currentBefore = game.queue[0] ?? null;
  game.board = Array.from({ length: 40 }, (_, y) =>
    Array.from({ length: 10 }, (_, x) => {
      const cell = next.board.cells[y * 10 + x];
      return cell === "_" ? null : cell;
    }),
  );
  game.queue = [next.pieces.current, ...next.pieces.known].filter((piece) => piece !== null);
  game.hold = next.pieces.hold;
  game.combo = next.chain.combo;
  game.s2.b2b = next.chain.b2b;
  game.s2.garbage = structuredClone(next.garbage);
  game.s2.time = structuredClone(next.time);
  game.s2.movement = {
    phase: "spawn-ready",
    lastWasClear: transition.lockResult.lines > 0,
    handling: structuredClone(game.s2.movement.handling),
    fidelity: "exact",
  };
  if (game.s2.clock.kind === "synthetic-fixed-lock-step") {
    // Candidate evaluation uses its witnessed Engine lock frame.  The next GUI
    // position remains on the separately declared fixed-step scenario clock;
    // otherwise input length would silently change the promised +60f/lock.
    game.s2.time.logicalFrame = scenarioFrameBefore + game.s2.clock.framesPerLock;
  }
  game.backToBack = next.chain.b2b > 0;
  game.pieces = next.time.piecesPlaced;
  game.lines += transition.lockResult.lines;
  game.attack += transition.attackStages.outgoingBeforeCancel;
  game.garbageCleared += transition.lockResult.clearedRows.filter((row) =>
    boardBefore[row].includes("G")
  ).length;
  game.lastClear = clearLabel(
    transition.lockResult.spin,
    transition.lockResult.lines,
    transition.lockResult.perfectClear,
  );
  // Stays on the board until the next placement replaces it, so the viewer can
  // always see which blocks the most recent move contributed.
  game.lastPlaced = lockedPieceCells(boardBefore, transition, move.location.type);
  game.lastPlacedPiece = move.location.type;
  game.lastPlacedFromHold = move.location.type !== currentBefore;
  refillQueue(game);
  game.toppedOut = game.board.slice(20).some((row) => row.some((cell) => cell !== null));
  return transition;
}

/**
 * Locates the cells the just-locked piece left behind, in the coordinates of
 * the board the transition produced.
 *
 * The Simulator reports the clear and tank stages but not the piece's final
 * blocks, so the surviving cells are recovered by diffing the two boards across
 * the row shift those stages describe: a clearing lock drops everything above a
 * cleared row, and a non-clearing lock inserts each tanked garbage row
 * underneath and pushes the stack up.  Both never happen on one lock, because
 * Triangle tanks only on the non-clearing branch.
 *
 * The recovered cells are checked against the placed piece's own symbol and the
 * count the lock can account for.  Anything that does not add up returns no
 * cells, so a highlight is never drawn over blocks that were not this piece.
 */
export function lockedPieceCells(previousBoard, transition, piece) {
  const lock = transition?.lockResult;
  const board = transition?.nextState?.board;
  if (!lock || !board || !PIECES.includes(piece)) return [];
  const { width, height, cells } = board;
  if (typeof cells !== "string" || cells.length !== width * height) return [];
  if (!Array.isArray(previousBoard) || previousBoard.length !== height) return [];

  const cleared = new Set(lock.clearedRows ?? []);
  const inserted = transition.tankResult?.inserted?.length ?? 0;
  if (cleared.size > 0 && inserted > 0) return [];

  const found = [];
  for (let y = 0; y < height; y += 1) {
    if (cleared.has(y)) continue;
    let target = y + inserted;
    for (const row of cleared) if (row < y) target -= 1;
    if (target < 0 || target >= height) continue;
    for (let x = 0; x < width; x += 1) {
      if (previousBoard[y][x] !== null) continue;
      const symbol = cells[target * width + x];
      if (symbol === "_") continue;
      if (symbol !== piece) return [];
      found.push([x, target]);
    }
  }
  // A lock places four cells. Only a cleared row can consume any of them, so a
  // non-clearing lock that does not recover all four was not read correctly.
  if (found.length > 4 || (lock.lines === 0 && found.length !== 4)) return [];
  return found;
}

export function placementCells(move) {
  const location = move.location;
  const turns = ({ north: 0, east: 1, south: 2, west: 3 })[location.orientation];
  if (!(location.type in CELLS) || turns === undefined) throw new Error("unsupported CC2 placement");
  return CELLS[location.type].map(([sourceX, sourceY]) => {
    let x = sourceX;
    let y = sourceY;
    for (let turn = 0; turn < turns; turn += 1) [x, y] = [y, -x];
    return [x + location.x, y + location.y];
  });
}

export function applySuggestion(game, move) {
  if (game.toppedOut) throw new Error("game is topped out");
  const piece = move.location.type;
  consumePiece(game, piece);
  const cells = placementCells(move);
  if (cells.some(([x, y]) => x < 0 || x >= 10 || y < 0 || y >= 40 || game.board[y][x] !== null)) {
    game.toppedOut = true;
    throw new Error("CC2 returned a placement that cannot be applied to the visible state");
  }
  for (const [x, y] of cells) game.board[y][x] = piece;

  const cleared = game.board.filter((row) => row.every((cell) => cell !== null)).length;
  game.board = game.board.filter((row) => row.some((cell) => cell === null));
  while (game.board.length < 40) game.board.push(Array(10).fill(null));
  const perfectClear = game.board.every((row) => row.every((cell) => cell === null));
  game.lastClear = clearLabel(move.spin, cleared, perfectClear);
  game.lines += cleared;
  game.pieces += 1;
  game.lastPlaced = cleared === 0 ? cells : [];
  game.combo = cleared > 0 ? game.combo + 1 : 0;
  const difficult = cleared === 4 || (move.spin !== "none" && cleared > 0);
  if (cleared > 0) game.backToBack = difficult;
  refillQueue(game);
  game.toppedOut = game.board.slice(20).some((row) => row.some((cell) => cell !== null));
  return { cleared, perfectClear, label: game.lastClear, cells };
}

/**
 * Short clear name for the line under the HOLD box, following the replay screen
 * in `fumen-mobile-fork`: a perfect clear is reported as PC alone, a spin that
 * cleared nothing as SPIN, and a T-spin by its line count. A lock that cleared
 * nothing has no name, so the line stays empty instead of reading as an event.
 */
export function clearLabel(spin, lines, perfectClear = false) {
  if (perfectClear && lines > 0) return "PC";
  if (lines === 0) return spin === "none" ? "" : "SPIN";
  const spinName = ["TSS", "TSD", "TST"][lines - 1];
  if (spin !== "none" && spinName !== undefined) {
    return spin === "mini" ? `MINI ${spinName}` : spinName;
  }
  return ["SINGLE", "DOUBLE", "TRIPLE", "QUAD"][lines - 1] ?? `${lines} LINES`;
}

function consumePiece(game, piece) {
  const current = game.queue[0];
  if (piece === current) {
    game.queue.shift();
    return;
  }
  if (game.hold !== null && piece === game.hold) {
    game.hold = current;
    game.queue.shift();
    return;
  }
  if (game.hold === null && piece === game.queue[1]) {
    game.hold = current;
    game.queue.splice(0, 2);
    return;
  }
  throw new Error(`suggested ${piece} is neither current nor HOLD source`);
}

function refillQueue(game) {
  const extended = game.queueModel === QUEUE_MODE_TRIANGLE_7_BAG
    ? extendTriangleSeededQueue(game.queue, game.bagSeed)
    : extendSeededQueue(game.queue, game.bagSeed);
  game.queue = extended.queue;
  game.bagSeed = extended.bagSeed;
}

function bag(seed) {
  const result = [...PIECES];
  let value = seed >>> 0;
  for (let index = result.length - 1; index > 0; index -= 1) {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    const target = (value >>> 0) % (index + 1);
    [result[index], result[target]] = [result[target], result[index]];
  }
  return result;
}

function initialTriangleQueue(seed, bagCount) {
  const result = [];
  let nextSeed = normalizeTriangleSeed(seed);
  for (let index = 0; index < bagCount; index += 1) {
    const generated = triangleBag(nextSeed);
    nextSeed = generated.seed;
    result.push(...generated.bag);
  }
  return { queue: result, bagSeed: nextSeed };
}

function triangleBag(seed) {
  const bag = ["Z", "L", "O", "S", "I", "J", "T"];
  let nextSeed = normalizeTriangleSeed(seed);
  for (let index = bag.length - 1; index > 0; index -= 1) {
    nextSeed = triangleNext(nextSeed);
    const target = Math.floor(((nextSeed - 1) / 2147483646) * (index + 1));
    [bag[index], bag[target]] = [bag[target], bag[index]];
  }
  return { bag, seed: nextSeed };
}

function triangleNext(seed) {
  return (16807 * normalizeTriangleSeed(seed)) % 2147483647;
}

function normalizeTriangleSeed(seed) {
  if (!Number.isSafeInteger(seed)) throw new Error("Triangle seed must be an integer");
  let normalized = seed % 2147483647;
  if (normalized <= 0) normalized += 2147483646;
  return normalized;
}

function assertTriangleSeed(seed) {
  if (!Number.isSafeInteger(seed) || seed < 1 || seed > 2147483646) {
    throw new Error("Triangle bag seed must be an integer from 1 to 2147483646");
  }
}

function assertQueue(queue) {
  if (!Array.isArray(queue) || !queue.every((piece) => PIECES.includes(piece))) {
    throw new Error("queue must contain only tetromino names");
  }
}
