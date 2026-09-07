import { FEATURE_SCHEMA_ID, FEATURE_SCHEMA_VERSION } from "./evaluation.mjs";

export const S2_F12_AMOUNT_ONLY_FEATURE_PROJECTION = "amount-only-lock-board/1";

export function extractAmountOnlyDecisionFeatures(projection) {
  const lockBoardFeatures = lockBoardFeaturesOf(projection.lockBoard);
  return Object.freeze({
    $schema: FEATURE_SCHEMA_ID,
    schemaVersion: FEATURE_SCHEMA_VERSION,
    aggregateHeight: lockBoardFeatures.aggregateHeight,
    maxHeight: lockBoardFeatures.maxHeight,
    holes: lockBoardFeatures.holes,
    bumpiness: lockBoardFeatures.bumpiness,
    toppedOut: projection.amountToppedOut ? 1 : 0,
    remainingIncoming: 0,
    deferredIncoming: projection.remainingRows,
    dueIncoming: 0,
    incomingNextLock: 0,
    confirmedIncoming: 0,
    tankedIncoming: projection.tankRows,
    visibleTopOutMargin: projection.visibleMarginAfterLock - projection.tankRows,
    outgoingBeforeCancel: projection.outgoingBeforeCancel,
    outgoingAfterCancel: projection.outgoingAfterCancel,
    cancelled: projection.cancelledRows,
    combo: projection.comboAfter,
    b2b: projection.b2bAfter,
    chargingLevel: projection.b2bAfter,
    surgeSent: projection.surgeSent,
  });
}

function lockBoardFeaturesOf(board) {
  if (board?.fidelity !== "exact") {
    throw new Error("amount-only decision features require an exact lockBoard");
  }
  if (
    !Number.isSafeInteger(board.width) ||
    !Number.isSafeInteger(board.height) ||
    board.width < 1 ||
    board.height < 1
  ) {
    throw new Error("amount-only decision features require lockBoard geometry");
  }
  if (typeof board.cells !== "string" || !/^[IJLOSTZG_]+$/.test(board.cells)) {
    throw new Error("amount-only decision features require canonical lockBoard cells");
  }
  if (board.cells.length !== board.width * board.height) {
    throw new Error("amount-only lockBoard cell count does not match its geometry");
  }

  const heights = [];
  let holes = 0;
  for (let x = 0; x < board.width; x += 1) {
    let highest = -1;
    for (let y = board.height - 1; y >= 0; y -= 1) {
      if (board.cells[y * board.width + x] !== "_") {
        highest = y;
        break;
      }
    }
    heights.push(highest + 1);
    for (let y = 0; y < highest; y += 1) {
      if (board.cells[y * board.width + x] === "_") holes += 1;
    }
  }

  let bumpiness = 0;
  for (let x = 1; x < heights.length; x += 1) {
    bumpiness += Math.abs(heights[x] - heights[x - 1]);
  }
  return {
    aggregateHeight: heights.reduce((total, value) => total + value, 0),
    maxHeight: Math.max(0, ...heights),
    holes,
    bumpiness,
  };
}
