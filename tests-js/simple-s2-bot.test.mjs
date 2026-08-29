import test from "node:test";
import assert from "node:assert/strict";

import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { guiStateToCanonical } from "../src-js/cc2-s2-adapter.mjs";
import {
  SIMPLE_S2_BOT_ID,
  SIMPLE_S2_MOVEMENT_MODEL,
  analyzeSimpleS2FinalPlacements,
  enumerateFinalPlacements,
} from "../src-js/simple-s2-bot.mjs";
import { applyTransition } from "../src-js/transition.mjs";

function initialState() {
  return guiStateToCanonical(toS2GuiState(createGame()));
}

test("the simple S2 bot ranks final placements through the shared Simulator", () => {
  const state = initialState();
  const result = analyzeSimpleS2FinalPlacements(state, { topN: 7 });

  assert.equal(result.bot.id, SIMPLE_S2_BOT_ID);
  assert.equal(result.bot.movementModel, SIMPLE_S2_MOVEMENT_MODEL);
  assert.equal(result.bot.depth, 1);
  assert.equal(result.moves.length, 7);
  assert.ok(result.generatedMoves >= result.moves.length);
  assert.equal(result.evaluator.id, "s2-depth1-linear-baseline");
  for (let index = 0; index < result.moves.length; index += 1) {
    const candidate = result.moves[index];
    assert.deepEqual(
      candidate.transition,
      applyTransition(state, { kind: "placement", placement: candidate.placement }),
    );
    assert.equal(candidate.transition.lockResult.spin, "none");
    assert.deepEqual(candidate.placement.rotationEvidence, {
      lastInputWasRotation: false,
      kickIndex: null,
      kickId: null,
      kickOffset: null,
    });
    assert.equal("movementEvidence" in candidate.placement, false);
    if (index > 0) assert.ok(result.moves[index - 1].score >= candidate.score);
  }
});

test("final-placement enumeration is deterministic and HOLD-aware", () => {
  const state = initialState();
  const first = enumerateFinalPlacements(state);
  const second = enumerateFinalPlacements(state);

  assert.deepEqual(second, first);
  assert.ok(first.some((placement) => placement.piece === state.pieces.current && !placement.usedHold));
  assert.ok(first.some((placement) => placement.piece === state.pieces.known[0] && placement.usedHold));
  assert.equal(new Set(first.map((placement) => JSON.stringify(placement))).size, first.length);
  assert.equal(first.every((placement) => {
    const transition = applyTransition(state, { kind: "placement", placement });
    return transition.legality.legal && transition.lockResult.spin === "none";
  }), true);
});

test("final-placement enumeration can disable HOLD per bot", () => {
  const state = initialState();
  const placements = enumerateFinalPlacements(state, { allowHold: false });
  assert.ok(placements.length > 0);
  assert.equal(placements.every((placement) => placement.usedHold === false), true);
});

test("final-placement enumeration includes legal resting cavities without claiming reachability", () => {
  const state = initialState();
  const rows = Array.from({ length: 40 }, () => Array(10).fill("_"));
  rows[0] = ["G", "G", "_", "_", "_", "_", "_", "_", "G", "G"];
  rows[1] = ["G", "G", "_", "_", "_", "_", "_", "_", "G", "G"];
  rows[2] = ["G", "G", "G", "G", "G", "G", "G", "G", "G", "G"];
  state.board.cells = rows.flat().join("");

  const placements = enumerateFinalPlacements(state);
  assert.ok(placements.some((placement) => {
    const transition = applyTransition(state, { kind: "placement", placement });
    return transition.legality.legal && placement.y <= 1;
  }));
  assert.equal(placements.every((placement) => !("movementEvidence" in placement)), true);
});

test("the simple bot rejects invalid ranking limits", () => {
  assert.throws(
    () => analyzeSimpleS2FinalPlacements(initialState(), { topN: 0 }),
    /topN/,
  );
  const wrongRuleset = initialState();
  wrongRuleset.rulesetId = "foundation-v1";
  assert.throws(
    () => analyzeSimpleS2FinalPlacements(wrongRuleset),
    /observed S2 ruleset/,
  );
});
