const VISIBLE_ROWS = 20;
const BOARD_HEIGHT = 40;

/**
 * Whether adding the local stall penalty floor makes the canonical settled board
 * cross the ordinary visible-field top-out boundary.
 */
export function stallPenaltyProjectionTopsOut(board, penaltyRows) {
  if (!Array.isArray(board) || board.length !== BOARD_HEIGHT) {
    throw new Error("stall penalty top-out requires a 40-row board");
  }
  if (!Number.isSafeInteger(penaltyRows) || penaltyRows < 1 || penaltyRows >= BOARD_HEIGHT) {
    throw new Error("stall penalty row count must be an integer from 1 to 39");
  }
  if (penaltyRows >= VISIBLE_ROWS) return true;
  return board.slice(VISIBLE_ROWS - penaltyRows)
    .some((row) => row.some((cell) => cell !== null));
}
