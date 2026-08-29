/**
 * ReplayIR cell vocabulary.
 *
 * Ported from `fumen-mobile-fork` (`src/lib/enums.ts`, MIT).  The numeric codes
 * are part of the ReplayIR wire format: `src-js/replay-lock-conformance.mjs`
 * already maps them to canonical `S-STATE/1` cells, so they must not be
 * renumbered.
 */

export const PIECE = Object.freeze({
  EMPTY: 0,
  I: 1,
  L: 2,
  O: 3,
  Z: 4,
  T: 5,
  J: 6,
  S: 7,
  GRAY: 8,
});

/** The ReplayIR board window: the engine plays 40 rows, ReplayIR retains 23. */
export const FIELD_WIDTH = 10;
export const FIELD_HEIGHT = 23;
export const FIELD_CELLS = FIELD_WIDTH * FIELD_HEIGHT;

const MINO_CODES = Object.freeze({
  i: PIECE.I,
  j: PIECE.J,
  l: PIECE.L,
  o: PIECE.O,
  s: PIECE.S,
  t: PIECE.T,
  z: PIECE.Z,
});

const PIECE_NAMES = Object.freeze({
  [PIECE.I]: "I",
  [PIECE.L]: "L",
  [PIECE.O]: "O",
  [PIECE.Z]: "Z",
  [PIECE.T]: "T",
  [PIECE.J]: "J",
  [PIECE.S]: "S",
  [PIECE.GRAY]: "G",
});

/** Engine mino symbol to ReplayIR code. `gb`, `bomb` and anything unknown is gray. */
export function minoToPiece(mino) {
  return MINO_CODES[mino] ?? PIECE.GRAY;
}

/** True for the seven tetrominoes, false for empty and garbage. */
export function isMinoPiece(piece) {
  return piece >= PIECE.I && piece <= PIECE.S;
}

/** ReplayIR code to the single-letter symbol the GUI paints cells with. */
export function pieceName(piece) {
  return PIECE_NAMES[piece] ?? null;
}
