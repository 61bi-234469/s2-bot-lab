/**
 * Triangle board state to the ReplayIR field window.
 *
 * Ported from `fumen-mobile-fork` (`src/lib/ttrm/board_converter.ts`, MIT).
 * `board.state[0]` is the bottom row, which is the orientation ReplayIR keeps,
 * so nothing is flipped here.  Only the raw `.ttrm` JSON boards are top-down.
 */

import { FIELD_HEIGHT, FIELD_WIDTH, PIECE, minoToPiece } from "./pieces.mjs";

/**
 * The viewer uses the bottom 23 rows. fullField separately retains every
 * internal row for lock/terminal evidence; clippedRowCount describes only the
 * display window, never a claim that the internal board is empty above it.
 */
export function convertEngineBoard(state) {
  let sourceHeight = 0;
  for (let y = state.length - 1; y >= 0; y -= 1) {
    const row = state[y];
    if (row && row.some((cell) => cell !== null && cell !== undefined)) {
      sourceHeight = y + 1;
      break;
    }
  }

  const field = [];
  for (let y = 0; y < FIELD_HEIGHT; y += 1) {
    const row = state[y];
    for (let x = 0; x < FIELD_WIDTH; x += 1) {
      const cell = row ? row[x] : null;
      field.push(cell !== null && cell !== undefined ? minoToPiece(cell.mino) : PIECE.EMPTY);
    }
  }

  const fullField = state.flatMap((row) => Array.from({ length: FIELD_WIDTH }, (_, x) =>
    row?.[x] != null ? minoToPiece(row[x].mino) : PIECE.EMPTY));
  return { field, fullField, sourceHeight, clippedRowCount: Math.max(0, sourceHeight - FIELD_HEIGHT) };
}
