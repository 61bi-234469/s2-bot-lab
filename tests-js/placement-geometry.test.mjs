import assert from "node:assert/strict";
import test from "node:test";

import { kickData } from "@haelp/teto/engine";

import {
  GEOMETRY_PIECES,
  placementGeometry,
} from "../src-js/triangle/placement-geometry.mjs";
import {
  ROTATIONS,
  canonicalBoardToTriangle,
  createPlacedTetromino,
} from "../src-js/triangle/placement-adapter.mjs";
import { RULESET_IDS, resolvePlacementRules } from "../src-js/ruleset-profiles.mjs";
import { applyTransition } from "../src-js/transition.mjs";
import { generateReachablePlacements } from "../src-js/triangle/move-generation.mjs";
import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { guiStateToCanonical } from "../src-js/cc2-s2-adapter.mjs";

const rules = resolvePlacementRules(RULESET_IDS.s2Observed);
const geometry = placementGeometry(rules);

test("the published block layout is the placement adapter's own", () => {
  const board = canonicalBoardToTriangle({ width: 10, height: 40, cells: "_".repeat(400) });
  for (const piece of GEOMETRY_PIECES) {
    for (const rotation of Object.keys(ROTATIONS)) {
      assert.deepEqual(
        geometry.blocks[piece][rotation],
        createPlacedTetromino(board, { piece, rotation, x: 0, y: 0 }).absoluteBlocks
          .map(([x, y]) => [x, y]),
        `${piece} ${rotation}`,
      );
    }
  }
});

test("published kick offsets are recorded the way rotation evidence carries them", () => {
  const table = kickData[rules.kickTable];
  for (const piece of GEOMETRY_PIECES) {
    const source = table[`${piece.toLowerCase()}_kicks`] ?? table.kicks;
    assert.deepEqual(Object.keys(geometry.kicks[piece]), Object.keys(source));
    for (const [kickId, offsets] of Object.entries(source)) {
      // The adapter applies a test as `x + dx, y - dy` and records `[dx, -dy]`,
      // so a published offset can be added to the placement as it stands and is
      // simultaneously the evidence the Simulator will validate.
      assert.deepEqual(geometry.kicks[piece][kickId], offsets.map(([dx, dy]) => [dx, -dy]));
    }
  }
});

test("the geometry declares the ruleset's own kick table and 180 rule", () => {
  assert.equal(geometry.kickTable, rules.kickTable);
  assert.equal(geometry.allow180, true);
  assert.deepEqual(geometry.rotations, ["spawn", "right", "reverse", "left"]);
  for (const piece of GEOMETRY_PIECES) {
    assert.ok(geometry.rotations.includes(geometry.spawnRotation[piece]));
  }
});

test("a placement built from the published table is legal for the Simulator", () => {
  const state = guiStateToCanonical(toS2GuiState(createGame()));
  const reachable = generateReachablePlacements(state, rules);
  const flat = reachable.find((placement) =>
    placement.piece === state.pieces.current && placement.rotation === "spawn" && !placement.usedHold);
  assert.ok(flat !== undefined);

  const cells = geometry.blocks[flat.piece][flat.rotation].map(([dx, dy]) => [flat.x + dx, flat.y + dy]);
  const transition = applyTransition(state, { kind: "placement", placement: flat });
  assert.equal(transition.legality.legal, true);
  for (const [x, y] of cells) {
    assert.equal(transition.nextState.board.cells[y * 10 + x], flat.piece);
  }
});

test("a kick table with offsets the model cannot express is refused", () => {
  assert.throws(
    () => placementGeometry({ ...rules, kickTable: "not-a-kick-table" }),
    /unknown kick table/,
  );
});
