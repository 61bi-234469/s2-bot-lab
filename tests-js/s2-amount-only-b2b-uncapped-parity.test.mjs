import assert from "node:assert/strict";
import test from "node:test";

import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { guiStateToCanonical } from "../src-js/gui-state.mjs";
import { amountOnlySearchAttack, advanceS2AmountOnlySearchState } from "../src-js/s2-amount-only-search-advance.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";
import { applyTransition } from "../src-js/transition.mjs";

// The canonical S2 Simulator has no B2B cap. Past 255 the bot's amount-only
// search attack must accept every lock and agree with the Simulator exactly as
// it does below 255 (2026-10-19: a u8 B2B rejected each B2B-continuing clear
// at B2B 255, so the F14 selector dropped those candidates and an INPUT match
// stopped on the rank-order check).
function canonicalLock(b2b, filledRows, lines) {
  const base = guiStateToCanonical(toS2GuiState(createGame(1)));
  const cells = base.board.cells.split("");
  for (let y = 0; y < filledRows; y += 1) {
    for (let x = 1; x < base.board.width; x += 1) cells[y * base.board.width + x] = "G";
  }
  const state = { ...base, board: { ...base.board, cells: cells.join("") },
    pieces: { ...base.pieces, current: "I", hold: null, holdAvailable: true }, chain: { ...base.chain, b2b } };
  const move = analyzeSimpleS2FinalPlacements(state, { topN: 64 }).moves
    .find((candidate) => candidate.transition.lockResult.lines === lines);
  assert.ok(move, `a ${lines}-line clear at B2B ${b2b}`);
  const transition = applyTransition(state, { kind: "placement", placement: move.placement });
  assert.equal(transition.lockResult.perfectClear, false);
  return {
    canonical: transition.attackStages.outgoingBeforeCancel,
    lock: { lines, spin: transition.lockResult.spin, perfectClear: false, comboAfter: transition.chain.comboAfter,
      b2bAfter: transition.chain.b2bAfter, b2bBefore: transition.chain.b2bBefore },
  };
}

test("B2B past 255: breaking clears match the Simulator's surge exactly", () => {
  for (const b2b of [254, 255, 256, 300]) {
    for (const [filledRows, lines] of [[1, 1], [2, 2]]) {
      const { canonical, lock } = canonicalLock(b2b, filledRows, lines);
      assert.equal(lock.b2bAfter, 0);
      assert.equal(amountOnlySearchAttack(lock), canonical, `${lines} lines at B2B ${b2b}`);
      assert.equal(canonical, b2b - 1 + (lines - 1));
    }
  }
});

test("B2B past 255: continuing clears keep the same relation to the Simulator as below 255", () => {
  const reference = canonicalLock(5, 5, 4);
  const offset = amountOnlySearchAttack(reference.lock) - reference.canonical;
  // The model is one row under the Simulator's Quad at every B2B (existing approximation).
  assert.equal(offset, -1);
  for (const b2b of [254, 255, 256, 300]) {
    const { canonical, lock } = canonicalLock(b2b, 5, 4);
    assert.equal(lock.b2bAfter, b2b + 1);
    assert.equal(canonical, reference.canonical, `Simulator Quad at B2B ${b2b}`);
    assert.equal(amountOnlySearchAttack(lock) - canonical, offset, `model Quad at B2B ${b2b}`);
  }
});

test("B2B past 255: the amount advance accepts the lock with incoming rows", () => {
  assert.equal(amountOnlySearchAttack({ lines: 3, spin: "none", perfectClear: false, comboAfter: 1, b2bAfter: 0, b2bBefore: 0xffffffff }), 0xffffffff);
  const { lock } = canonicalLock(255, 5, 4);
  const advanced = advanceS2AmountOnlySearchState({ pendingRows: 3, dueThisLockRows: 1 }, lock);
  assert.equal(advanced.searchAttackOverflow, false);
  assert.equal(advanced.cancelledRows, 3);
  assert.equal(advanced.pendingRows, 0);
  // A break past 256 sends more than 255 rows; rows are u16 since
  // 2026-10-20, so it cancels instead of taking the overflow arm.
  const big = canonicalLock(300, 1, 1);
  const released = advanceS2AmountOnlySearchState({ pendingRows: 3, dueThisLockRows: 1 }, big.lock);
  assert.deepEqual([released.searchAttackOverflow, released.cancelledRows, released.outgoingAfterCancel], [false, 3, 296]);
});
