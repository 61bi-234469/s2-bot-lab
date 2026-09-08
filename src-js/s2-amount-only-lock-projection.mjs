import { resolvePlacementRules } from "./ruleset-profiles.mjs";
import { evaluatePlacementWithLockBoard } from "./triangle/placement-adapter.mjs";
import { advanceS2AmountOnlySearchState } from "./s2-amount-only-search-advance.mjs";

export const S2_AMOUNT_ONLY_LOCK_PROJECTION_ID = "s2-amount-only-lock-projection/1";

const ALLOWLIST = Object.freeze([
  "id",
  "legal",
  "lines",
  "spin",
  "comboAfter",
  "b2bAfter",
  "cancelledRows",
  "tankRows",
  "remainingRows",
  "outgoingBeforeCancel",
  "outgoingAfterCancel",
  "surgeSent",
  "visibleHeight",
  "occupiedHeightAfterLock",
  "visibleMarginAfterLock",
  "amountToppedOut",
  "lockBoard",
  "piecesAfterLock",
]);

export function projectS2AmountOnlyLock(state, action, incoming = { pendingRows: 0, dueThisLockRows: 0 }) {
  if (action?.kind !== "placement" || action.placement == null) {
    throw new Error("amount-only lock projection requires a placement action");
  }
  const rules = resolvePlacementRules(state.rulesetId);
  const evaluated = evaluatePlacementWithLockBoard(state, action.placement, rules);
  if (evaluated.legality?.legal !== true || evaluated.nextState == null) {
    throw new Error(
      `amount-only lock projection requires a legal placement: ${evaluated.legality?.reason ?? "unknown"}`,
    );
  }
  const lockBoard = freezeLockBoard(state.board, evaluated.lockBoardCells);
  const publicAdvance = advanceS2AmountOnlySearchState(incoming, {
    lines: requireNonNegativeInteger(evaluated.lockResult?.lines, "lines"),
    spin: evaluated.lockResult?.spin,
    perfectClear: evaluated.lockResult?.perfectClear === true,
    comboAfter: requireNonNegativeInteger(evaluated.chain?.comboAfter, "comboAfter"),
    b2bAfter: requireNonNegativeInteger(evaluated.chain?.b2bAfter, "b2bAfter"),
    b2bBefore: requireNonNegativeInteger(state.chain?.b2b, "b2bBefore"),
  });
  const cancelledRows = publicAdvance.cancelledRows;
  const tankRows = publicAdvance.tankRows;
  const remainingRows = publicAdvance.remainingRows;
  const outgoingBeforeCancel = publicAdvance.outgoingBeforeCancel;
  const outgoingAfterCancel = publicAdvance.outgoingAfterCancel;
  const surgeSent = sumNumbers(evaluated.attackStages?.surgeChunks);
  const comboAfter = requireNonNegativeInteger(evaluated.chain?.comboAfter, "comboAfter");
  const b2bAfter = requireNonNegativeInteger(evaluated.chain?.b2bAfter, "b2bAfter");
  const lines = requireNonNegativeInteger(evaluated.lockResult?.lines, "lines");
  const spin = evaluated.lockResult?.spin;
  if (!["none", "mini", "normal"].includes(spin)) {
    throw new Error("amount-only lock projection requires a canonical spin label");
  }
  const occupiedHeightAfterLock = occupiedHeight(lockBoard);
  const visibleHeight = lockBoard.visibleHeight;
  const visibleMarginAfterLock = visibleHeight - occupiedHeightAfterLock;
  const amountToppedOut = occupiedHeightAfterLock + tankRows > visibleHeight;
  const pieces = evaluated.nextState.pieces;
  if (pieces?.fidelity !== "exact") {
    throw new Error("amount-only lock projection requires exact piecesAfterLock");
  }
  const projection = Object.freeze({
    id: S2_AMOUNT_ONLY_LOCK_PROJECTION_ID,
    legal: true,
    lines,
    spin,
    comboAfter,
    b2bAfter,
    cancelledRows,
    tankRows,
    remainingRows,
    outgoingBeforeCancel,
    outgoingAfterCancel,
    surgeSent,
    visibleHeight,
    occupiedHeightAfterLock,
    visibleMarginAfterLock,
    amountToppedOut,
    lockBoard,
    piecesAfterLock: Object.freeze({
      fidelity: "exact",
      current: pieces.current,
      hold: pieces.hold,
      known: Object.freeze([...(pieces.known ?? [])]),
      holdAvailable: pieces.holdAvailable === true,
    }),
  });
  assertAllowlist(projection);
  return projection;
}

export function occupiedHeight(board) {
  let maxHeight = 0;
  for (let y = board.height - 1; y >= 0 && maxHeight === 0; y -= 1) {
    for (let x = 0; x < board.width; x += 1) {
      if (board.cells[y * board.width + x] !== "_") {
        maxHeight = y + 1;
        break;
      }
    }
  }
  return maxHeight;
}

function freezeLockBoard(sourceBoard, cells) {
  const width = sourceBoard.width;
  const height = sourceBoard.height;
  const visibleHeight = sourceBoard.visibleHeight ?? height;
  const bufferHeight = sourceBoard.bufferHeight ?? Math.max(0, height - visibleHeight);
  if (sourceBoard.fidelity !== "exact") {
    throw new Error("amount-only lockBoard requires an exact source board");
  }
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error("amount-only lockBoard requires canonical geometry");
  }
  if (typeof cells !== "string" || cells.length !== width * height || !/^[IJLOSTZG_]+$/.test(cells)) {
    throw new Error("amount-only lockBoard requires canonical cells");
  }
  if (!Number.isSafeInteger(visibleHeight) || visibleHeight < 1 || visibleHeight > height) {
    throw new Error("amount-only lockBoard requires a canonical visibleHeight");
  }
  return Object.freeze({
    fidelity: "exact",
    width,
    height,
    visibleHeight,
    bufferHeight,
    cells,
  });
}

function sumNumbers(values) {
  if (values == null) return 0;
  if (!Array.isArray(values)) {
    throw new Error("amount-only lock projection requires surgeChunks to be an array");
  }
  return values.reduce((total, value) => total + requireNonNegativeInteger(value, "surgeSent"), 0);
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`amount-only lock projection requires a non-negative ${label}`);
  }
  return value;
}

function assertAllowlist(projection) {
  for (const key of Object.keys(projection)) {
    if (!ALLOWLIST.includes(key)) {
      throw new Error(`amount-only lock projection leaked key ${key}`);
    }
  }
}
