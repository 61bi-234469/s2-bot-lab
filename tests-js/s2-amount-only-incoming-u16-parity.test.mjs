import assert from "node:assert/strict";
import test from "node:test";

import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { guiStateToCanonical } from "../src-js/gui-state.mjs";
import { projectS2AmountOnlyIncomingSnapshot } from "../src-js/s2-amount-only-incoming-snapshot.mjs";
import { advanceS2AmountOnlySearchState } from "../src-js/s2-amount-only-search-advance.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";
import { applyTransition } from "../src-js/transition.mjs";

// The canonical S2 Simulator has no cap on pending garbage. The bot's
// amount-only rows are u16 (2026-10-20; they were u8, and more than 255
// pending rows stopped an INPUT match). After the opener phase (S2:
// openerPhase 14 pieces, which adds cancel bonuses) the model must match the
// Simulator exactly past 255 rows: the snapshot's pending total, the attack,
// the cancel, what remains, what is sent, and what tanks.
function stateWith({ b2b, filledRows, packets, piecesPlaced = 300, logicalFrame = 0 }) {
  let state = guiStateToCanonical(toS2GuiState(createGame(1)));
  const cells = state.board.cells.split("");
  for (let y = 0; y < filledRows; y += 1) {
    for (let x = 1; x < state.board.width; x += 1) cells[y * state.board.width + x] = "G";
  }
  state = { ...state, board: { ...state.board, cells: cells.join("") },
    pieces: { ...state.pieces, current: "I", hold: null, holdAvailable: true }, chain: { ...state.chain, b2b },
    time: { ...state.time, piecesPlaced } };
  for (const [index, amount] of packets.entries()) {
    state = applyTransition(state, { kind: "garbage-receive", packet: { packetId: index + 1, sourceGameId: "opponent",
      amount, holeSize: 1, arrivalFrame: 0, confirmed: true, order: index } }, state.rulesetId).nextState;
  }
  return { ...state, time: { ...state.time, logicalFrame } };
}

function lockWith(state, lines) {
  const move = analyzeSimpleS2FinalPlacements(state, { topN: 64 }).moves
    .find((candidate) => candidate.transition.lockResult.lines === lines);
  assert.ok(move, `a ${lines}-line lock`);
  const transition = applyTransition(state, { kind: "placement", placement: move.placement }, state.rulesetId);
  const lock = { lines, spin: transition.lockResult.spin, perfectClear: transition.lockResult.perfectClear,
    comboAfter: transition.chain.comboAfter, b2bAfter: transition.chain.b2bAfter, b2bBefore: transition.chain.b2bBefore };
  return { transition, lock };
}

const total = (packets) => packets.reduce((sum, packet) => sum + packet.amount, 0);

test("299 pending rows: the snapshot reports the Simulator's exact total", () => {
  const state = stateWith({ b2b: 0, filledRows: 0, packets: [200, 99] });
  assert.equal(projectS2AmountOnlyIncomingSnapshot(state).pendingRows, total(state.garbage.packets));
  assert.equal(projectS2AmountOnlyIncomingSnapshot(state).pendingRows, 299);
});

test("past the opener, breaking clears cancel, keep and send exactly what the Simulator does", () => {
  for (const [b2b, packets] of [[6, [10]], [20, [30]], [100, [150]], [256, [100]], [256, [200, 99]], [300, [200, 99]]]) {
    const state = stateWith({ b2b, filledRows: 1, packets });
    const snapshot = projectS2AmountOnlyIncomingSnapshot(state);
    const { transition, lock } = lockWith(state, 1);
    const model = advanceS2AmountOnlySearchState(snapshot, lock);
    const label = `B2B ${b2b}, ${total(packets)} pending`;
    assert.equal(model.searchAttackOverflow, false, label);
    assert.equal(model.outgoingBeforeCancel, transition.attackStages.outgoingBeforeCancel, label);
    assert.equal(model.cancelledRows, transition.cancelResult.cancelled, label);
    assert.equal(model.outgoingAfterCancel, transition.cancelResult.outgoingAfterCancel, label);
    assert.equal(model.remainingRows, total(transition.cancelResult.remainingIncoming), label);
  }
  // 299 pending against a 255-row break leaves 44 and sends nothing.
  const state = stateWith({ b2b: 256, filledRows: 1, packets: [200, 99] });
  const model = advanceS2AmountOnlySearchState(projectS2AmountOnlyIncomingSnapshot(state), lockWith(state, 1).lock);
  assert.deepEqual([model.cancelledRows, model.remainingRows, model.outgoingAfterCancel], [255, 44, 0]);
});

test("a no-clear lock under 299 due pending rows tanks the Simulator's 8 rows and keeps 291 pending", () => {
  const state = stateWith({ b2b: 0, filledRows: 0, packets: [200, 99], logicalFrame: 40 });
  const snapshot = projectS2AmountOnlyIncomingSnapshot(state);
  assert.equal(snapshot.dueThisLockRows, 8);
  const { transition, lock } = lockWith(state, 0);
  const model = advanceS2AmountOnlySearchState(snapshot, lock);
  const inserted = transition.tankResult.inserted.reduce((sum, row) => sum + row.amount, 0);
  assert.equal(model.tankRows, inserted);
  assert.deepEqual([model.tankRows, model.remainingRows], [8, 291]);
});
