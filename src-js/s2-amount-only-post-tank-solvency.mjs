export const S2_AMOUNT_ONLY_SOLVENCY_POLICY =
  "amount-only-lock-margin-minus-tank-and-remaining/1";

export function assessS2AmountOnlySolvency(projection) {
  if (projection?.lockBoard?.visibleHeight !== 20) {
    throw new Error("amount-only solvency requires lockBoard.visibleHeight === 20");
  }
  const solvency = projection.visibleMarginAfterLock
    - projection.tankRows
    - projection.remainingRows;
  if (!Number.isFinite(solvency)) {
    throw new Error("amount-only solvency requires finite row counts");
  }
  const solvent = projection.amountToppedOut !== true && solvency >= 0;
  return Object.freeze({
    visibleMarginAfterLock: projection.visibleMarginAfterLock,
    tankRows: projection.tankRows,
    remainingRows: projection.remainingRows,
    solvency,
    toppedOut: projection.amountToppedOut === true,
    solvent,
    qualifies: solvency < 0,
    units: solvency < 0 ? -1 : 0,
  });
}
