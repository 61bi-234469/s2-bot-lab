import test from "node:test";
import assert from "node:assert/strict";

import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import {
  canonicalPlacementToGuiMove,
  simpleAnalysisToVerification,
} from "../cc2-gui/analysis-proposal.mjs";
import {
  cc2MoveToCanonicalPlacement,
  guiStateToCanonical,
} from "../src-js/cc2-s2-adapter.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";

test("canonical placements round-trip through the GUI-only TBP projection", () => {
  const rotations = ["spawn", "right", "reverse", "left"];
  for (const piece of ["I", "O", "T", "L", "J", "S", "Z"]) {
    const gui = toS2GuiState(createGame());
    gui.queue = [piece, ...gui.queue.slice(1)];
    for (const rotation of rotations) {
      const placement = {
        piece,
        rotation,
        x: 3,
        y: 5,
        usedHold: false,
        rotationEvidence: {
          lastInputWasRotation: false,
          kickIndex: null,
          kickId: null,
          kickOffset: null,
        },
      };
      const move = canonicalPlacementToGuiMove(placement, "normal");
      assert.equal(move.spin, "full");
      assert.deepEqual(cc2MoveToCanonicalPlacement(gui, move), placement);
    }
  }
});

test("simple S2 analysis becomes an applicable verified primary proposal", () => {
  const gui = toS2GuiState(createGame());
  const analysis = analyzeSimpleS2FinalPlacements(guiStateToCanonical(gui), { topN: 1 });
  const verified = simpleAnalysisToVerification(analysis);

  assert.equal(verified.transition, analysis.moves[0].transition);
  assert.equal(verified.comparison.positionFingerprint, analysis.positionFingerprint);
  assert.equal(verified.comparison.score, analysis.moves[0].score);
  assert.deepEqual(verified.comparison.witness.placement, analysis.moves[0].placement);
});
