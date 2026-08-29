import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  currentPieceStructuralKey,
  fullStateKey,
  holdAwareMoveGenerationKey,
} from "../src-js/state-keys.mjs";
import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { guiStateToCanonical } from "../src-js/cc2-s2-adapter.mjs";

const keyFixture = JSON.parse(readFileSync("fixtures/cross-runtime/state-keys.json", "utf8"));
const transitionFixture = JSON.parse(readFileSync(keyFixture.sourceFixture, "utf8"));
const state = transitionFixture.input.state;

test("state key fixture is stable in Node", () => {
  assert.equal(fullStateKey(state), keyFixture.expected.fullState);
  assert.equal(currentPieceStructuralKey(state), keyFixture.expected.currentPiece);
  assert.equal(holdAwareMoveGenerationKey(state), keyFixture.expected.holdAware);
});

test("full-state key ignores provenance but preserves information loss", () => {
  const provenance = structuredClone(state);
  provenance.provenance.producedBy = "another-adapter";
  assert.equal(fullStateKey(provenance), fullStateKey(state));

  const informationLoss = structuredClone(state);
  informationLoss.informationLoss.push({
    field: "pieces.queueModel.tail",
    reason: "not-observed",
    effect: "degraded",
  });
  assert.notEqual(fullStateKey(informationLoss), fullStateKey(state));
});

test("current-piece key and HOLD-aware key have intentionally different sharing boundaries", () => {
  const changed = structuredClone(state);
  changed.pieces.hold = "T";
  changed.pieces.holdAvailable = false;
  changed.pieces.known[0] = "Z";

  assert.equal(currentPieceStructuralKey(changed), currentPieceStructuralKey(state));
  assert.notEqual(holdAwareMoveGenerationKey(changed), holdAwareMoveGenerationKey(state));
});

test("HOLD-aware key distinguishes each legality input", () => {
  for (const mutate of [
    (value) => { value.pieces.hold = "T"; },
    (value) => { value.pieces.holdAvailable = false; },
    (value) => { value.pieces.known[0] = "Z"; },
  ]) {
    const changed = structuredClone(state);
    mutate(changed);
    assert.notEqual(holdAwareMoveGenerationKey(changed), holdAwareMoveGenerationKey(state));
  }
});

test("empty HOLD with an unknown queue head fails closed", () => {
  const unknown = structuredClone(state);
  unknown.pieces.known = [];
  assert.throws(() => holdAwareMoveGenerationKey(unknown), /known queue head/);
});

test("the full state key binds resolved player handling", () => {
  const canonical = guiStateToCanonical(toS2GuiState(createGame()));
  const changed = structuredClone(canonical);
  changed.movement.handling.das = 1;
  assert.notEqual(fullStateKey(changed), fullStateKey(canonical));
});
