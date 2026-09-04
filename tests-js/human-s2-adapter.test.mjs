import assert from "node:assert/strict";
import test from "node:test";

import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { guiStateToCanonical } from "../src-js/cc2-s2-adapter.mjs";
import { applyHumanFinalPlacementUnderObservedS2 } from "../src-js/human-s2-adapter.mjs";
import { resolvePlacementRules } from "../src-js/ruleset-profiles.mjs";
import {
  findReachableRotationPlacement,
  generateReachablePlacements,
} from "../src-js/triangle/move-generation.mjs";

const NO_ROTATION = Object.freeze({ lastInputWasRotation: false, kickIndex: null });

// A T-spin slot: the pose is
// only reachable by rotating in, and the kick that reaches it is recorded.
function spinSlotState() {
  const gui = toS2GuiState(createGame(20));
  const rows = [
    "____GG_G__",
    "___G____G_",
    "__GGG__GGG",
    "_GG____G_G",
    "__________",
    "__________",
  ];
  for (let y = 0; y < rows.length; y += 1) {
    gui.board[y] = [...rows[y]].map((cell) => cell === "_" ? null : "G");
  }
  gui.queue = ["T", "I"];
  return guiStateToCanonical(gui);
}

test("a player's plain drop is rerun by the shared S2 Simulator", () => {
  const state = guiStateToCanonical(toS2GuiState(createGame(20)));
  const result = applyHumanFinalPlacementUnderObservedS2(state, {
    piece: "T",
    rotation: "spawn",
    x: 2,
    y: -1,
    usedHold: false,
    rotationEvidence: NO_ROTATION,
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.transition.legality.legal, true);
  assert.equal(result.transition.lockResult.spin, "none");
  assert.equal(result.comparison.source, "human-final-placement");
  assert.equal(result.comparison.witness.kind, "player-final-placement-only");
  assert.deepEqual(result.reasons, ["human-frame-reachability-not-witnessed"]);
  assert.ok(Number.isFinite(result.comparison.score));
});

test("a rotation lock is admitted only with a matching S2 kickset witness", () => {
  const result = applyHumanFinalPlacementUnderObservedS2(spinSlotState(), {
    piece: "T",
    rotation: "spawn",
    x: 5,
    y: 0,
    usedHold: false,
    rotationEvidence: { lastInputWasRotation: true, kickIndex: 1, kickId: "10", kickOffset: [1, -1] },
  });

  assert.equal(result.transition.lockResult.spin, "mini");
  assert.equal(result.comparison.witness.kind, "player-final-placement-with-s2-rotation-witness");
  assert.equal(result.comparison.witness.spinWitness.kind, "s2-kickset-reachability-witness");
  assert.deepEqual(result.comparison.witness.placement.rotationEvidence, {
    lastInputWasRotation: true,
    kickIndex: 1,
    kickId: "10",
    kickOffset: [1, -1],
  });
  assert.ok(!result.reasons.includes("spin-classification-limited-to-none"));
});

test("the same pose without a rotation as the last input stays spinless", () => {
  const result = applyHumanFinalPlacementUnderObservedS2(spinSlotState(), {
    piece: "T",
    rotation: "spawn",
    x: 5,
    y: 0,
    usedHold: false,
    rotationEvidence: NO_ROTATION,
  });

  assert.equal(result.transition.legality.legal, true);
  assert.equal(result.transition.lockResult.spin, "none");
  assert.equal(result.comparison.witness.kind, "player-final-placement-only");
});

test("an unwitnessed fin or TST claim falls back to a plain drop", () => {
  const result = applyHumanFinalPlacementUnderObservedS2(spinSlotState(), {
    piece: "T",
    rotation: "spawn",
    x: 5,
    y: 0,
    usedHold: false,
    // Fin/TST shaped evidence for a pose the kickset only reaches with an
    // ordinary kick. The front end cannot upgrade the spin class by asserting a
    // kick the rule model does not support at this pose.
    rotationEvidence: { lastInputWasRotation: true, kickIndex: 2, kickId: "03", kickOffset: [1, -2] },
  });

  assert.equal(result.transition.lockResult.spin, "none");
  assert.equal(result.comparison.witness.kind, "player-final-placement-only");
  assert.ok(result.reasons.includes("human-rotation-not-independently-witnessed"));
  assert.ok(result.reasons.includes("spin-classification-limited-to-none"));
});

test("targeted rotation witnesses preserve exhaustive S2 evidence", () => {
  const state = spinSlotState();
  const rules = resolvePlacementRules(state.rulesetId);
  const rotationLocks = generateReachablePlacements(state, rules).filter(
    (placement) => placement.rotationEvidence.lastInputWasRotation,
  );
  assert.ok(rotationLocks.length > 0);
  for (const expected of rotationLocks) {
    assert.deepEqual(findReachableRotationPlacement(state, expected, rules), expected);
  }
});

test("targeted rotation witnesses reject forged class and unreachable pose", () => {
  const state = spinSlotState();
  const rules = resolvePlacementRules(state.rulesetId);
  const expected = generateReachablePlacements(state, rules).find(
    (placement) => placement.rotationEvidence.lastInputWasRotation,
  );
  assert.ok(expected);
  assert.equal(findReachableRotationPlacement(state, {
    ...expected,
    rotationEvidence: {
      lastInputWasRotation: true,
      kickIndex: 2,
      kickId: "03",
      kickOffset: [1, -2],
    },
  }, rules), null);
  assert.equal(findReachableRotationPlacement(state, { ...expected, x: 99 }, rules), null);
});

test("an illegal placement is reported instead of being applied", () => {
  const state = guiStateToCanonical(toS2GuiState(createGame(20)));
  const result = applyHumanFinalPlacementUnderObservedS2(state, {
    piece: "T",
    rotation: "spawn",
    x: 3,
    // One row above the floor: the piece could still fall, so this was never a
    // resting position.
    y: 0,
    usedHold: false,
    rotationEvidence: NO_ROTATION,
  });

  assert.equal(result.status, "unsupported");
  assert.equal(result.transition, null);
  assert.deepEqual(result.reasons, ["human-final-placement-illegal-under-s2:rotation-unreachable"]);
});

test("a HOLD lock takes the piece HOLD actually makes available", () => {
  const state = guiStateToCanonical(toS2GuiState(createGame(20)));
  assert.equal(state.pieces.hold, null);
  const held = applyHumanFinalPlacementUnderObservedS2(state, {
    piece: state.pieces.known[0],
    rotation: "spawn",
    x: 3,
    y: -2,
    usedHold: true,
    rotationEvidence: NO_ROTATION,
  });
  assert.equal(held.transition.legality.legal, true);
  assert.equal(held.transition.nextState.pieces.hold, state.pieces.current);

  const wrongPiece = applyHumanFinalPlacementUnderObservedS2(state, {
    piece: state.pieces.known[1],
    rotation: "spawn",
    x: 3,
    y: -1,
    usedHold: true,
    rotationEvidence: NO_ROTATION,
  });
  assert.equal(wrongPiece.status, "unsupported");
});

test("a placement document is accepted only in the shape a placement has", () => {
  const state = guiStateToCanonical(toS2GuiState(createGame(20)));
  const submit = (placement) => () => applyHumanFinalPlacementUnderObservedS2(state, placement);
  const base = { piece: "T", rotation: "spawn", x: 3, y: -1, usedHold: false, rotationEvidence: NO_ROTATION };

  assert.throws(submit({ ...base, spin: "full" }), /unsupported human placement field spin/);
  assert.throws(submit({ ...base, piece: "X" }), /piece is unsupported/);
  assert.throws(submit({ ...base, rotation: "north" }), /rotation is unsupported/);
  assert.throws(submit({ ...base, x: 1.5 }), /coordinates must be safe integers/);
  assert.throws(submit({ ...base, usedHold: "yes" }), /HOLD flag/);
  assert.throws(submit({ ...base, rotationEvidence: null }), /requires rotation evidence/);
  assert.throws(
    submit({ ...base, rotationEvidence: { lastInputWasRotation: true, kickIndex: 0 } }),
    /rotation transition id/,
  );
});
