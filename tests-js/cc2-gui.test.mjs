import assert from "node:assert/strict";
import test from "node:test";

import {
  applyS2Transition,
  applySuggestion,
  clearLabel,
  createGame,
  extendSeededQueue,
  lockedPieceCells,
  placementCells,
  toCc2State,
  toS2GuiState,
} from "../cc2-gui/game.mjs";
import {
  applyCc2FinalPlacementUnderObservedS2,
  guiStateToCanonical,
} from "../src-js/cc2-s2-adapter.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";
import { applyTransition } from "../src-js/transition.mjs";

function move(type, orientation, x, y, spin = "none") {
  return { location: { type, orientation, x, y }, spin };
}

function emptyBoard() {
  return Array.from({ length: 40 }, () => Array(10).fill(null));
}

function canonicalCells(filled) {
  const cells = Array(400).fill("_");
  for (const [x, y, symbol] of filled) cells[y * 10 + x] = symbol;
  return cells.join("");
}

function lockTransition(filled, { lines = 0, clearedRows = [], inserted = 0 } = {}) {
  return {
    lockResult: { lines, clearedRows, spin: "none", perfectClear: false },
    tankResult: { inserted: Array.from({ length: inserted }, () => ({ amount: 1 })) },
    nextState: { board: { width: 10, height: 40, cells: canonicalCells(filled) } },
  };
}

test("CC2 coordinates map to the same cells as its upstream data model", () => {
  assert.deepEqual(placementCells(move("I", "north", 4, 0)), [[3, 0], [4, 0], [5, 0], [6, 0]]);
  assert.deepEqual(placementCells(move("T", "east", 4, 2)), [[4, 3], [4, 2], [4, 1], [5, 2]]);
});

test("an empty HOLD suggestion consumes current and next exactly once", () => {
  const game = createGame();
  game.queue = ["T", "I", "O", ...game.queue.slice(3)];
  assert.deepEqual(game.queue.slice(0, 3), ["T", "I", "O"]);
  applySuggestion(game, move("I", "north", 4, 0));
  assert.equal(game.hold, "T");
  assert.equal(game.queue[0], "O");
  assert.equal(game.pieces, 1);
});

test("a suggestion from occupied HOLD swaps without consuming an extra next piece", () => {
  const game = createGame();
  game.queue = ["T", "I", "O", ...game.queue.slice(3)];
  game.hold = "I";
  applySuggestion(game, move("I", "north", 4, 0));
  assert.equal(game.hold, "T");
  assert.equal(game.queue[0], "I");
});

test("line clears are applied bottom-up and classified for the viewer", () => {
  const game = createGame();
  game.queue[0] = "I";
  game.board[0] = ["G", "G", "G", null, null, null, null, "G", "G", "G"];
  const result = applySuggestion(game, move("I", "north", 4, 0));
  assert.equal(result.cleared, 1);
  assert.equal(result.perfectClear, true);
  assert.equal(result.label, "PC");
  assert.ok(game.board.every((row) => row.every((cell) => cell === null)));
});

test("spin and line count produce the replay screen's short clear names", () => {
  assert.equal(clearLabel("none", 4), "QUAD");
  assert.equal(clearLabel("none", 1), "SINGLE");
  assert.equal(clearLabel("full", 2), "TSD");
  assert.equal(clearLabel("normal", 3), "TST");
  assert.equal(clearLabel("mini", 1), "MINI TSS");
  assert.equal(clearLabel("full", 0), "SPIN");
  assert.equal(clearLabel("none", 2, true), "PC");
  // A lock that cleared nothing is not an event, so it has no name at all.
  assert.equal(clearLabel("none", 0), "");
});

test("the GUI sends a complete 40 by 10 TBP state", () => {
  const state = toCc2State(createGame());
  assert.equal(state.board.length, 40);
  assert.ok(state.board.every((row) => row.length === 10));
  assert.equal(state.queue[0], "T");
  assert.deepEqual(state.randomizer, { type: "seven_bag", bag_state: [] });
});

test("the S2 projection retains the deterministic queue beyond the TBP window", () => {
  const game = createGame();
  assert.equal(toCc2State(game).queue.length, 14);
  assert.ok(toS2GuiState(game).queue.length > 14);
  assert.deepEqual(toS2GuiState(game).queue.slice(0, 14), toCc2State(game).queue);
});

test("a non-clearing lock recovers all four cells of the placed piece", () => {
  const transition = lockTransition([[3, 0, "I"], [4, 0, "I"], [5, 0, "I"], [6, 0, "I"]]);
  assert.deepEqual(
    lockedPieceCells(emptyBoard(), transition, "I"),
    [[3, 0], [4, 0], [5, 0], [6, 0]],
  );
});

test("a clearing lock reports only the surviving cells, dropped past the cleared row", () => {
  const before = emptyBoard();
  for (let x = 0; x < 9; x += 1) before[0][x] = "G";
  const transition = lockTransition([[9, 0, "I"], [9, 1, "I"], [9, 2, "I"]], {
    lines: 1,
    clearedRows: [0],
  });
  assert.deepEqual(lockedPieceCells(before, transition, "I"), [[9, 0], [9, 1], [9, 2]]);
});

test("tanked garbage pushes the placed piece up by one row per inserted row", () => {
  const filled = [[4, 2, "I"], [4, 3, "I"], [4, 4, "I"], [4, 5, "I"]];
  for (let y = 0; y < 2; y += 1) {
    for (let x = 0; x < 10; x += 1) if (x !== 4) filled.push([x, y, "G"]);
  }
  const transition = lockTransition(filled, { inserted: 2 });
  assert.deepEqual(
    lockedPieceCells(emptyBoard(), transition, "I"),
    [[4, 2], [4, 3], [4, 4], [4, 5]],
  );
});

test("cells that do not add up to the placed piece are reported as none", () => {
  const wrongSymbol = lockTransition([[3, 0, "T"], [4, 0, "T"], [5, 0, "T"], [4, 1, "T"]]);
  assert.deepEqual(lockedPieceCells(emptyBoard(), wrongSymbol, "I"), []);

  const tooFew = lockTransition([[3, 0, "I"], [4, 0, "I"], [5, 0, "I"]]);
  assert.deepEqual(lockedPieceCells(emptyBoard(), tooFew, "I"), []);

  // The Simulator tanks only on the non-clearing branch, so a result claiming
  // both is not one this recovery can read.
  const both = lockTransition([[3, 0, "I"]], { lines: 1, clearedRows: [0], inserted: 1 });
  assert.deepEqual(lockedPieceCells(emptyBoard(), both, "I"), []);
});

test("the recovered cells agree with the Simulator across a real line clear", () => {
  const game = createGame();
  // This scenario intentionally places the I behind CURRENT via an empty HOLD.
  game.queue = ["T", "I", ...game.queue.slice(2)];
  for (let x = 0; x < 9; x += 1) game.board[0][x] = "G";
  const placement = move("I", "east", 9, 2);
  const result = applyCc2FinalPlacementUnderObservedS2(toS2GuiState(game), placement);
  assert.equal(result.transition?.legality?.legal, true, result.reasons?.join(", "));
  assert.equal(result.transition.lockResult.lines, 1);

  applyS2Transition(game, placement, result);
  assert.deepEqual(game.lastPlaced, [[9, 0], [9, 1], [9, 2]]);
  assert.ok(game.lastPlaced.every(([x, y]) => game.board[y][x] === "I"));
  assert.equal(game.lastPlacedPiece, "I");
  assert.equal(game.garbageCleared, 1);
  assert.equal(game.attack, result.transition.attackStages.outgoingBeforeCancel);
  // CC2 proposed the piece behind CURRENT, so the highlighted mino came via HOLD.
  assert.equal(game.lastPlacedFromHold, true);
});

test("the recovered cells follow the piece up when the Simulator tanks garbage", () => {
  let state = guiStateToCanonical(toS2GuiState(createGame()));
  state = applyTransition(state, {
    kind: "garbage-receive",
    packet: {
      packetId: 1,
      sourceGameId: 2,
      amount: 4,
      holeSize: 1,
      arrivalFrame: 0,
      confirmed: true,
      order: 0,
    },
  }, state.rulesetId).nextState;
  // This ruleset makes a packet tankable only 20 frames after it arrives, so
  // the lock has to land on a later frame than the arrival.
  state.time.logicalFrame = 60;

  const before = Array.from({ length: 40 }, (_, y) =>
    Array.from({ length: 10 }, (_, x) => {
      const cell = state.board.cells[y * 10 + x];
      return cell === "_" ? null : cell;
    }));
  const best = analyzeSimpleS2FinalPlacements(state, { topN: 1 }).moves[0];
  const inserted = best.transition.tankResult.inserted.length;
  assert.equal(inserted, 4, "the lock should have tanked the received rows");
  assert.equal(best.transition.lockResult.lines, 0);

  const cells = lockedPieceCells(before, best.transition, best.placement.piece);
  assert.equal(cells.length, 4);
  const after = best.transition.nextState.board.cells;
  for (const [x, y] of cells) assert.equal(after[y * 10 + x], best.placement.piece);
  // Every cell rose by exactly the number of inserted rows.
  assert.ok(cells.every(([, y]) => y >= inserted));
});

test("deterministic queue refill continues after the pre-generated bags", () => {
  const game = createGame();
  const remaining = game.queue.slice(-3);
  const extended = extendSeededQueue(remaining, game.bagSeed, 14);
  const repeatedFirstBag = extendSeededQueue([], 0x5e2, 7).queue;
  assert.ok(extended.queue.length >= 14);
  assert.deepEqual(extended.queue.slice(0, 3), remaining);
  assert.notDeepEqual(extended.queue.slice(3, 10), repeatedFirstBag);
});

test("a game seed deterministically changes the queue from its first bag", () => {
  assert.deepEqual(createGame(123).queue, createGame(123).queue);
  assert.notDeepEqual(createGame(123).queue.slice(0, 7), createGame(124).queue.slice(0, 7));
  assert.throws(() => createGame(-1));
});
