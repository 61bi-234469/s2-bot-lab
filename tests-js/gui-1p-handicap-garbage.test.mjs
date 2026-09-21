import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  HANDICAP_BOARD_WIDTH,
  HANDICAP_GARBAGE_CELLS,
  HANDICAP_GARBAGE_ID,
  HANDICAP_MAX_COLUMN_HEIGHT,
  applyHandicapToCanonicalBoard,
  applyHandicapToLegacyStart,
  assertHandicapStack,
  handicapColumnHeights,
  handicapGarbageCells,
  handicapRecord,
  normalizeHandicapGarbage,
} from "../src-js/gui-1p-handicap-garbage.mjs";
import { TOGGLE_PREFERENCE_IDS } from "../cc2-gui/preferences.mjs";
import { guiStateToCanonical } from "../src-js/gui-state.mjs";
import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const SEEDS = [0, 1, 2, 1506, 1507, 0x1234, 123_456_789, 0xffff_ffff];
const emptyCanonical = () => guiStateToCanonical(toS2GuiState(createGame(1506)));
const occupied = (board) => [...board.cells].filter((cell) => cell !== "_").length;

test("a generated stack holds exactly the declared cell count", () => {
  for (const seed of SEEDS) {
    const heights = handicapColumnHeights(seed);
    assert.equal(heights.length, HANDICAP_BOARD_WIDTH);
    assert.equal(heights.reduce((sum, height) => sum + height, 0), HANDICAP_GARBAGE_CELLS);
    assert.equal(handicapGarbageCells(heights).length, HANDICAP_GARBAGE_CELLS);
  }
});

test("every column is filled from the floor, so the stack has no cavity", () => {
  for (const seed of SEEDS) {
    const heights = handicapColumnHeights(seed);
    const board = applyHandicapToCanonicalBoard(emptyCanonical().board, handicapGarbageCells(heights));
    for (let x = 0; x < HANDICAP_BOARD_WIDTH; x += 1) {
      const column = Array.from({ length: board.height }, (_, y) => board.cells[y * board.width + x]);
      const filled = column.filter((cell) => cell === "G").length;
      assert.equal(filled, heights[x], `column ${x} height`);
      // Contiguous from the floor: the filled cells are exactly the lowest ones.
      assert.deepEqual(column.slice(0, filled), Array(filled).fill("G"));
      assert.ok(column.slice(filled).every((cell) => cell === "_"), `column ${x} has a covered gap`);
    }
  }
});

/* The invariant the two execution paths depend on: the S2 Simulator clears only
   rows the locked piece touches, the pinned Engine clears every full row. */
test("no row of a generated stack is complete", () => {
  for (const seed of SEEDS) {
    const heights = handicapColumnHeights(seed);
    assert.equal(Math.min(...heights), 0, "one column has to stay empty");
    const board = applyHandicapToCanonicalBoard(emptyCanonical().board, handicapGarbageCells(heights));
    for (let y = 0; y < board.height; y += 1) {
      const row = board.cells.slice(y * board.width, (y + 1) * board.width);
      assert.notEqual([...row].every((cell) => cell !== "_"), true, `row ${y} is complete`);
    }
  }
});

test("no column exceeds the declared height cap", () => {
  for (const seed of SEEDS) {
    assert.ok(Math.max(...handicapColumnHeights(seed)) <= HANDICAP_MAX_COLUMN_HEIGHT);
  }
});

test("the same seed reproduces the same terrain and nearby seeds differ", () => {
  for (const seed of SEEDS) {
    assert.deepEqual([...handicapColumnHeights(seed)], [...handicapColumnHeights(seed)]);
  }
  const layouts = new Set(SEEDS.map((seed) => handicapColumnHeights(seed).join(",")));
  assert.equal(layouts.size, SEEDS.length, "representative seeds produce distinct terrain");
  // FT series games use consecutive seeds; they must not share one terrain.
  const series = Array.from({ length: 16 }, (_, index) => handicapColumnHeights(1506 + index).join(","));
  assert.equal(new Set(series).size, series.length);
});

test("the stack invariants reject a terrain the execution paths would disagree about", () => {
  // Ten columns of at least one cell means a complete bottom row.
  assert.throws(() => assertHandicapStack([3, 3, 3, 3, 3, 3, 3, 3, 3, 1]), /one column empty/);
  assert.throws(() => assertHandicapStack([4, 4, 4, 4, 4, 4, 4, 4, 0, 0]), /exactly 28 cells/);
  assert.throws(() => assertHandicapStack([7, 7, 7, 7, 0, 0, 0, 0, 0, 0]), /from 0 to 6/);
  assert.throws(() => assertHandicapStack([28, 0, 0, 0, 0, 0, 0, 0, 0, 0]), /from 0 to 6/);
  assert.throws(() => assertHandicapStack(Array(9).fill(0)), /10 columns/);
  assert.throws(() => assertHandicapStack("28"), /10 columns/);
});

test("a handicap request is normalized, and only a malformed one fails closed", () => {
  assert.deepEqual(normalizeHandicapGarbage({ enabled: true }, { humanSide: "left" }), { enabled: true });
  assert.deepEqual(normalizeHandicapGarbage({ enabled: false }, { humanSide: "left" }), { enabled: false });
  assert.deepEqual(normalizeHandicapGarbage(undefined, { humanSide: "left" }), { enabled: false });
  assert.deepEqual(normalizeHandicapGarbage(null, { humanSide: "left" }), { enabled: false });
  assert.deepEqual(normalizeHandicapGarbage({}, { humanSide: "left" }), { enabled: false });
  // No 1P side is nothing to handicap: a saved ON setting must not block a start.
  assert.deepEqual(normalizeHandicapGarbage({ enabled: true }, { humanSide: null }), { enabled: false });
  assert.deepEqual(normalizeHandicapGarbage({ enabled: true }, {}), { enabled: false });
  assert.throws(() => normalizeHandicapGarbage({ enabled: "yes" }, { humanSide: "left" }), /must be a boolean/);
  assert.throws(() => normalizeHandicapGarbage([], { humanSide: "left" }), /must be an object/);
  assert.throws(() => normalizeHandicapGarbage(28, { humanSide: "left" }), /must be an object/);
  assert.throws(() => normalizeHandicapGarbage({ enabled: true }, { humanSide: "middle" }), /humanSide/);
});

test("the seed is validated as an unsigned 32-bit match seed", () => {
  for (const seed of [-1, 1.5, 0x1_0000_0000, "1506", null]) {
    assert.throws(() => handicapColumnHeights(seed), /unsigned 32-bit/);
  }
});

test("applying the stack changes nothing but the garbage cells", () => {
  const initial = emptyCanonical();
  const cells = handicapGarbageCells(handicapColumnHeights(1506));
  const board = applyHandicapToCanonicalBoard(initial.board, cells);
  assert.equal(occupied(initial.board), 0, "the start board is empty");
  assert.equal(occupied(board), HANDICAP_GARBAGE_CELLS);
  assert.equal([...board.cells].filter((cell) => cell === "G").length, HANDICAP_GARBAGE_CELLS);
  assert.equal(board.cells.length, initial.board.cells.length);
  assert.deepEqual({ ...board, cells: null }, { ...initial.board, cells: null });
  assert.throws(() => applyHandicapToCanonicalBoard(board, cells), /already occupied/);
  assert.throws(() => applyHandicapToCanonicalBoard(initial.board, [[0, -1]]), /outside the board/);
  assert.throws(() => applyHandicapToCanonicalBoard(initial.board, [[10, 0]]), /outside the board/);
  assert.throws(() => applyHandicapToCanonicalBoard({ width: 9, height: 40, cells: "" }, cells), /canonical/);
});

test("the legacy start helper returns the stacked state with its own round record", () => {
  const initial = emptyCanonical();
  const { state, record } = applyHandicapToLegacyStart(initial, { seed: 1506 });
  assert.equal(occupied(initial.board), 0, "the source state is not mutated");
  assert.equal(occupied(state.board), HANDICAP_GARBAGE_CELLS);
  assert.deepEqual({ ...state, board: null }, { ...structuredClone(initial), board: null });
  assert.equal(record.id, HANDICAP_GARBAGE_ID);
  assert.equal(record.enabled, true);
  assert.equal(record.appliedTo, "left");
  assert.equal(record.seed, 1506);
  assert.equal(record.cells, HANDICAP_GARBAGE_CELLS);
  assert.deepEqual([...record.columnHeights], [...handicapColumnHeights(1506)]);
  assert.deepEqual([...applyHandicapToLegacyStart(initial, { seed: 1506 }).record.columnHeights],
    [...record.columnHeights], "the same seed records the same terrain");
});

test("the round record carries the versioned generator identity", () => {
  assert.equal(HANDICAP_GARBAGE_ID, "s2-gui-1p-handicap-garbage/1");
  const columnHeights = handicapColumnHeights(7);
  assert.equal(handicapRecord({ seed: 7, columnHeights }).id, HANDICAP_GARBAGE_ID);
  assert.equal(handicapRecord({ seed: 7, columnHeights, appliedTo: "right" }).appliedTo, "right");
  assert.throws(() => handicapRecord({ seed: 7, columnHeights, appliedTo: "both" }), /appliedTo/);
  assert.throws(() => handicapRecord({ seed: 7, columnHeights: [3, 3, 3, 3, 3, 3, 3, 3, 3, 1] }),
    /one column empty/);
});

test("the match deck exposes the handicap control and persists it", () => {
  const markup = read("../cc2-gui/index.html");
  for (const id of ["match-handicap-settings", "match-handicap-garbage", "match-handicap-note"]) {
    assert.match(markup, new RegExp(`id="${id}"`), id);
  }
  assert.match(markup, /HANDICAP \/ ハンデ/);
  const humanSettings = markup.slice(markup.indexOf('id="human-settings-fields"'), markup.indexOf('id="bot-settings-validation"'));
  assert.match(humanSettings, /MATCH RULES \/ 対局ルール/);
  assert.ok(humanSettings.indexOf('id="match-handicap-settings"') > 0);
  assert.doesNotMatch(markup.slice(markup.indexOf('id="match-settings"'), markup.indexOf('class="match-outcome"')),
    /id="match-handicap-settings"/);
  assert.doesNotMatch(markup, /match-handicap-scope-note/);
  assert.ok(TOGGLE_PREFERENCE_IDS.includes("match-handicap-garbage"));
});
