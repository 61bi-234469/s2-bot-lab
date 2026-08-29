/**
 * Triangle board state to the ReplayIR field window.
 *
 * Ported from `fumen-mobile-fork` (`src/lib/ttrm/board_converter.ts`, MIT).
 * `board.state[0]` is the bottom row, which is the orientation ReplayIR keeps,
 * so nothing is flipped here.  Only the raw `.ttrm` JSON boards are top-down.
 */

import { FIELD_HEIGHT, FIELD_WIDTH, PIECE, minoToPiece } from "./pieces.mjs";

/**
 * The engine plays on 40 rows and ReplayIR retains the bottom 23; the number of
 * occupied rows that fell outside that window is reported rather than dropped
 * silently, because a clipped board cannot prove an exact canonical state.
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

  return { field, sourceHeight, clippedRowCount: Math.max(0, sourceHeight - FIELD_HEIGHT) };
}
