import assert from "node:assert/strict";
import test from "node:test";
import { stallPenaltyProjectionTopsOut } from "../src-js/stall-penalty-topout.mjs";

function emptyBoard() {
  return Array.from({ length: 40 }, () => Array(10).fill(null));
}

test("stall penalty projection tops out when the raised stack crosses row 20", () => {
  const board = emptyBoard();
  board[19][4] = "T";
  assert.equal(stallPenaltyProjectionTopsOut(board, 1), true);
  assert.equal(stallPenaltyProjectionTopsOut(board, 2), true);
});

test("stall penalty projection remains active below the visible ceiling", () => {
  const board = emptyBoard();
  board[18][4] = "T";
  assert.equal(stallPenaltyProjectionTopsOut(board, 1), false);
});

test("twenty penalty rows top out even on an empty canonical board", () => {
  assert.equal(stallPenaltyProjectionTopsOut(emptyBoard(), 20), true);
});
