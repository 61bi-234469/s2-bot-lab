/**
 * The 1P handicap: a fixed amount of garbage already stacked on the human
 * player's board when the round opens, so an opening template cannot be
 * replayed and the terrain has to be maintained from the first piece.
 *
 * This module is the only place that decides the shape of that stack. Both
 * legacy final-placement servers and the TTRM INPUT referee call it, so the
 * two execution paths cannot drift into different terrain rules.
 *
 * Two properties are invariants rather than preferences:
 *
 * - No cavity. Every column is filled from the floor up to its own height, so
 *   the stack is always diggable.
 * - No complete row. The S2 Simulator clears only the rows the locked piece
 *   touches, while the pinned Triangle Engine clears every full row on the
 *   board. A complete row present before the first lock would therefore make
 *   the two paths disagree and fail the INPUT lock conformance comparison.
 *   Given the no-cavity rule, "no complete row" is exactly "at least one
 *   column stays empty", which is what the generator reserves and asserts.
 */

export const HANDICAP_GARBAGE_ID = "s2-gui-1p-handicap-garbage/1";
export const HANDICAP_GARBAGE_CELLS = 28;
export const HANDICAP_MAX_COLUMN_HEIGHT = 6;
export const HANDICAP_BOARD_WIDTH = 10;

const GARBAGE_CELL = "G";
const EMPTY_CELL = "_";
// The match seed is also the piece-queue anchor. Deriving the terrain from a
// fixed mix of it keeps one seed reproducing one round without letting the
// terrain and the queue be drawn from the same stream position.
const SEED_MIX = 0x9e37_79b9;

/**
 * Validates the browser's handicap request. A request with no 1P side has no
 * player to handicap, so it is reported as not applicable instead of failing
 * the round start: a saved ON setting must not block a bot-versus-bot match.
 * A malformed payload still fails closed.
 */
export function normalizeHandicapGarbage(input, { humanSide = null } = {}) {
  if (humanSide !== null && humanSide !== "left" && humanSide !== "right") {
    throw new Error("handicap humanSide must be left, right, or null");
  }
  if (input === null || input === undefined) return Object.freeze({ enabled: false });
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("handicap must be an object");
  }
  const requested = input.enabled ?? false;
  if (typeof requested !== "boolean") throw new Error("handicap enabled must be a boolean");
  return Object.freeze({ enabled: requested && humanSide !== null });
}

/**
 * The deterministic terrain for one round. One reserved column stays empty so
 * no row can be complete; the remaining cells are distributed one at a time,
 * which keeps the profile bumpy without producing a single extreme spike.
 */
export function handicapColumnHeights(seed) {
  assertUint32(seed, "handicap seed");
  const nextUint32 = mulberry32((seed ^ SEED_MIX) >>> 0);
  const well = randomInt(nextUint32, HANDICAP_BOARD_WIDTH);
  const heights = Array(HANDICAP_BOARD_WIDTH).fill(0);
  for (let placed = 0; placed < HANDICAP_GARBAGE_CELLS; placed += 1) {
    const candidates = [];
    for (let column = 0; column < HANDICAP_BOARD_WIDTH; column += 1) {
      if (column !== well && heights[column] < HANDICAP_MAX_COLUMN_HEIGHT) candidates.push(column);
    }
    if (candidates.length === 0) throw new Error("handicap garbage does not fit the reserved columns");
    heights[candidates[randomInt(nextUint32, candidates.length)]] += 1;
  }
  assertHandicapStack(heights);
  return Object.freeze(heights);
}

/** The cells a column-height profile occupies, with `y = 0` as the floor. */
export function handicapGarbageCells(heights) {
  assertHandicapStack(heights);
  const cells = [];
  for (const [x, height] of heights.entries()) {
    for (let y = 0; y < height; y += 1) cells.push(Object.freeze([x, y]));
  }
  return Object.freeze(cells);
}

/** Places the stack on a canonical 10x40 board without disturbing any other cell. */
export function applyHandicapToCanonicalBoard(board, cells) {
  if (board?.width !== HANDICAP_BOARD_WIDTH || !Number.isSafeInteger(board.height) ||
      typeof board.cells !== "string" || board.cells.length !== board.width * board.height) {
    throw new Error("handicap garbage requires an exact canonical 10-wide board");
  }
  if (!Array.isArray(cells)) throw new Error("handicap cells must be an array");
  const next = [...board.cells];
  for (const cell of cells) {
    const [x, y] = cell ?? [];
    if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y) ||
        x < 0 || x >= board.width || y < 0 || y >= board.height) {
      throw new Error("handicap cell is outside the board");
    }
    const index = y * board.width + x;
    if (next[index] !== EMPTY_CELL) throw new Error("handicap cell is already occupied");
    next[index] = GARBAGE_CELL;
  }
  return { ...board, cells: next.join("") };
}

/**
 * The record that travels with one round. It is deliberately per-round: every
 * game of an FT series and every RND restart draws its own seed, so a terrain
 * recorded once for a whole series would describe the wrong board.
 */
export function handicapRecord({ seed, columnHeights, appliedTo = "left" }) {
  assertUint32(seed, "handicap seed");
  assertHandicapStack(columnHeights);
  if (appliedTo !== "left" && appliedTo !== "right") {
    throw new Error("handicap appliedTo must be left or right");
  }
  return Object.freeze({
    id: HANDICAP_GARBAGE_ID,
    enabled: true,
    appliedTo,
    seed,
    cells: HANDICAP_GARBAGE_CELLS,
    columnHeights: Object.freeze([...columnHeights]),
  });
}

/**
 * One call for the legacy start path, so neither server carries its own copy of
 * the generate/expand/apply/record sequence.
 */
export function applyHandicapToLegacyStart(state, { seed, appliedTo = "left" } = {}) {
  const columnHeights = handicapColumnHeights(seed);
  const board = applyHandicapToCanonicalBoard(state?.board, handicapGarbageCells(columnHeights));
  return {
    state: { ...structuredClone(state), board },
    record: handicapRecord({ seed, columnHeights, appliedTo }),
  };
}

/** The stack invariants. Exported so a regression can be stated against them directly. */
export function assertHandicapStack(heights) {
  if (!Array.isArray(heights) || heights.length !== HANDICAP_BOARD_WIDTH) {
    throw new Error(`handicap heights must have ${HANDICAP_BOARD_WIDTH} columns`);
  }
  if (!heights.every((height) => Number.isSafeInteger(height) &&
      height >= 0 && height <= HANDICAP_MAX_COLUMN_HEIGHT)) {
    throw new Error(`handicap column heights must be integers from 0 to ${HANDICAP_MAX_COLUMN_HEIGHT}`);
  }
  const total = heights.reduce((sum, height) => sum + height, 0);
  if (total !== HANDICAP_GARBAGE_CELLS) {
    throw new Error(`handicap stack must hold exactly ${HANDICAP_GARBAGE_CELLS} cells, not ${total}`);
  }
  // A stack whose every column is occupied has a complete bottom row, which the
  // two execution paths would clear differently. See the module comment.
  if (Math.min(...heights) !== 0) {
    throw new Error("handicap stack must leave one column empty so no row is complete");
  }
  return heights;
}

function mulberry32(state) {
  let current = state >>> 0;
  return function nextUint32() {
    current = (current + 0x6d2b_79f5) >>> 0;
    let value = Math.imul(current ^ (current >>> 15), 1 | current);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return (value ^ (value >>> 14)) >>> 0;
  };
}

/** Rejection sampling, so a column is not favoured by the modulo remainder. */
function randomInt(nextUint32, n) {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  let value = nextUint32();
  while (value >= limit) value = nextUint32();
  return value % n;
}

function assertUint32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${label} must be an unsigned 32-bit integer`);
  }
}
