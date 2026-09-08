export const S2_AMOUNT_ONLY_SEARCH_ADVANCE_ID = "s2-amount-only-search-advance/1";
export const S2_AMOUNT_ONLY_SEARCH_ATTACK_ID = "s2-amount-only-search-attack/1";

// floor(ln(1 + 1.25 * combo_index)) for combo_index 0..=255. Do not recompute.
export const SEARCH_ATTACK_COMBO_LOG1P_FLOOR = Object.freeze([
  0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3, 4, 4, 4, 4, 4,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4, 4,
  4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
  5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5,
]);

const ADVANCE_ALLOWLIST = Object.freeze([
  "id",
  "cancelledRows",
  "tankRows",
  "remainingRows",
  "outgoingBeforeCancel",
  "outgoingAfterCancel",
  "pendingRows",
  "dueThisLockRows",
  "searchAttackOverflow",
]);

const SPINS = new Set(["none", "mini", "normal"]);

export function amountOnlySearchAttack(lockPublic) {
  const lines = requireU32(lockPublic?.lines, "lines");
  const spin = lockPublic?.spin;
  if (!SPINS.has(spin)) {
    throw new Error("amount-only search-attack requires spin none|mini|normal");
  }
  if (typeof lockPublic?.perfectClear !== "boolean") {
    throw new Error("amount-only search-attack requires boolean perfectClear");
  }
  requireU8(lockPublic?.comboAfter, "comboAfter");
  requireU8(lockPublic?.b2bAfter, "b2bAfter");
  requireU8(lockPublic?.b2bBefore, "b2bBefore");
  if (lines === 0) return 0;

  let base = searchAttackBase(lines, spin);
  const b2bIndex = Math.max(lockPublic.b2bAfter - 1, 0);
  if (b2bIndex > 0) base += 1;
  const comboIndex = Math.max(lockPublic.comboAfter - 1, 0);
  let raw = Math.floor((base * (4 + comboIndex)) / 4);
  if (comboIndex > 1) {
    raw = Math.max(raw, SEARCH_ATTACK_COMBO_LOG1P_FLOOR[comboIndex]);
  }
  const pcBonus = lockPublic.perfectClear ? 5 : 0;
  const broke = spin === "none" && lines < 4 && !lockPublic.perfectClear;
  const surge = broke && lockPublic.b2bBefore >= 4 ? lockPublic.b2bBefore - 1 : 0;
  return raw + pcBonus + surge;
}

export function advanceS2AmountOnlySearchState(incoming, lockPublic) {
  const pending = requireU8(incoming?.pendingRows, "pendingRows");
  const due = requireU8(incoming?.dueThisLockRows, "dueThisLockRows");
  if (due > pending) {
    throw new Error("amount-only search-advance requires dueThisLockRows <= pendingRows");
  }
  const lines = requireU32(lockPublic?.lines, "lines");

  if (pending === 0 && due === 0) {
    return freezeAdvance({
      cancelledRows: 0,
      tankRows: 0,
      remainingRows: 0,
      outgoingBeforeCancel: 0,
      outgoingAfterCancel: 0,
      pendingRows: 0,
      dueThisLockRows: 0,
      searchAttackOverflow: false,
    });
  }

  const outgoingBeforeCancel = amountOnlySearchAttack(lockPublic);
  if (outgoingBeforeCancel > 255) {
    return freezeAdvance({
      cancelledRows: 0,
      tankRows: 0,
      remainingRows: 0,
      outgoingBeforeCancel: 0,
      outgoingAfterCancel: 0,
      pendingRows: pending,
      dueThisLockRows: due,
      searchAttackOverflow: true,
    });
  }
  if (lines === 0 && outgoingBeforeCancel !== 0) {
    throw new Error("amount-only search-attack must return 0 when lines==0");
  }

  const cancelledRows = Math.min(outgoingBeforeCancel, pending);
  const outgoingAfterCancel = outgoingBeforeCancel - cancelledRows;
  let tankRows;
  let remainingRows;
  if (lines > 0) {
    tankRows = 0;
    remainingRows = pending - cancelledRows;
  } else {
    tankRows = Math.min(due, pending);
    remainingRows = pending - tankRows;
  }
  return freezeAdvance({
    cancelledRows,
    tankRows,
    remainingRows,
    outgoingBeforeCancel,
    outgoingAfterCancel,
    pendingRows: remainingRows,
    dueThisLockRows: remainingRows,
    searchAttackOverflow: false,
  });
}

function searchAttackBase(lines, spin) {
  if (spin === "none") {
    if (lines === 1) return 0;
    if (lines === 2) return 1;
    if (lines === 3) return 2;
    if (lines === 4) return 4;
    if (lines === 5) return 5;
    return 5 + (lines - 5);
  }
  if (spin === "mini") {
    if (lines === 1) return 0;
    if (lines === 2) return 1;
    if (lines === 3) return 2;
    if (lines === 4) return 10;
    if (lines === 5) return 12;
    return 12 + 2 * (lines - 5);
  }
  if (lines === 1) return 2;
  if (lines === 2) return 4;
  if (lines === 3) return 6;
  if (lines === 4) return 10;
  if (lines === 5) return 12;
  return 12 + 2 * (lines - 5);
}

function freezeAdvance(fields) {
  const result = Object.freeze({ id: S2_AMOUNT_ONLY_SEARCH_ADVANCE_ID, ...fields });
  for (const key of Object.keys(result)) {
    if (!ADVANCE_ALLOWLIST.includes(key)) {
      throw new Error(`amount-only search-advance leaked key ${key}`);
    }
  }
  return result;
}

function requireU32(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error(`amount-only search-advance requires a u32 ${label}`);
  }
  return value;
}

function requireU8(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 255) {
    throw new Error(`amount-only search-advance requires a u8 ${label}`);
  }
  return value;
}
