import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { FOUNDATION_PLACEMENT_RULES, evaluatePlacement } from "../src-js/triangle/placement-adapter.mjs";

// Complete `S-FIXTURE/1` execution and hashing is covered once for the whole
// corpus in transition.test.mjs. This file covers adapter behaviour the corpus
// does not reach: rejected placements, spin classification, and hold.
const fixture = JSON.parse(
  readFileSync("fixtures/golden/placement-no-clear-tank.json", "utf8"),
);
const spinFixture = JSON.parse(
  readFileSync("fixtures/golden/spin-placement.json", "utf8"),
);
const allSpinFixture = JSON.parse(
  readFileSync("fixtures/golden/all-spin-placement.json", "utf8"),
);

test("placement legality uses closed reasons and nulls all later stages", () => {
  const collision = structuredClone(fixture.input.state);
  collision.board.cells = `____G${"_".repeat(55)}`;
  assert.deepEqual(
    evaluatePlacement(collision, fixture.input.action.placement),
    {
      legality: { legal: false, reason: "collision" },
      lockResult: null,
      chain: null,
      attackStages: null,
      cancelResult: null,
      tankResult: null,
      nextState: null,
    },
  );

  const unavailable = structuredClone(fixture.input.action.placement);
  unavailable.piece = "T";
  assert.equal(
    evaluatePlacement(fixture.input.state, unavailable).legality.reason,
    "piece-unavailable",
  );
});

test("placement derives cleared rows and a perfect clear from canonical cells", () => {
  const state = structuredClone(fixture.input.state);
  state.board.cells = `GGGGGG____${"_".repeat(50)}`;
  state.pieces.current = "I";
  state.garbage.packets = [];
  const placement = {
    piece: "I",
    rotation: "spawn",
    x: 6,
    y: -2,
    usedHold: false,
    rotationEvidence: { lastInputWasRotation: false, kickIndex: null },
  };

  const result = evaluatePlacement(state, placement);
  assert.deepEqual(result.lockResult, {
    clearedRows: [0],
    lines: 1,
    spin: "none",
    perfectClear: true,
  });
  assert.equal(result.chain.comboAfter, 1);
  assert.equal(result.nextState.board.cells, "_".repeat(60));
  assert.deepEqual(result.tankResult.inserted, []);
});

for (const fixtureCase of spinFixture.cases) {
  test(`spin placement golden: ${fixtureCase.id}`, () => {
    const state = structuredClone(fixture.input.state);
    state.board.cells = fixtureCase.boardRows.join("");
    state.pieces.current = "T";
    state.garbage.packets = [];
    const placement = {
      piece: "T",
      rotation: fixtureCase.rotation,
      x: 3,
      y: 0,
      usedHold: false,
      rotationEvidence: {
        lastInputWasRotation: true,
        kickIndex: fixtureCase.kickIndex,
        kickId: fixtureCase.kickId,
        kickOffset: fixtureCase.kickOffset,
      },
    };

    if (fixtureCase.expectedError) {
      assert.throws(
        () => evaluatePlacement(state, placement),
        new RegExp(fixtureCase.expectedError),
      );
      return;
    }

    const result = evaluatePlacement(state, placement);
    assert.equal(result.lockResult.spin, fixtureCase.expectedSpin);
    if (fixtureCase.expectedStages) {
      assert.deepEqual(result.lockResult.clearedRows, fixtureCase.expectedStages.clearedRows);
      assert.equal(result.lockResult.lines, fixtureCase.expectedStages.lines);
      assert.equal(result.attackStages.raw, fixtureCase.expectedStages.raw);
      assert.equal(
        result.attackStages.afterRounding,
        fixtureCase.expectedStages.afterRounding,
      );
      assert.equal(result.attackStages.specialBonus, fixtureCase.expectedStages.specialBonus);
      assert.equal(result.chain.comboAfter, fixtureCase.expectedStages.comboAfter);
      assert.equal(result.chain.b2bAfter, fixtureCase.expectedStages.b2bAfter);
    }
  });
}

test("malformed rotation evidence fails closed", () => {
  const placement = structuredClone(fixture.input.action.placement);
  placement.rotationEvidence = { lastInputWasRotation: true, kickIndex: null };
  assert.throws(
    () => evaluatePlacement(fixture.input.state, placement),
    /rotation evidence requires/,
  );
});

for (const fixtureCase of allSpinFixture.cases) {
  test(`all-spin placement golden: ${fixtureCase.id}`, () => {
    const state = structuredClone(fixture.input.state);
    state.board.cells = allSpinFixture.immobileBoardRows.join("");
    state.garbage.packets = [];
    const placement = {
      ...fixture.input.action.placement,
      y: 1,
      rotationEvidence: {
        lastInputWasRotation: true,
        kickIndex: 0,
        kickId: "00",
        kickOffset: [0, 0],
      },
    };
    const rules = {
      ...FOUNDATION_PLACEMENT_RULES,
      spinBonuses: fixtureCase.spinBonuses,
    };

    if (fixtureCase.expectedError) {
      assert.throws(
        () => evaluatePlacement(state, placement, rules),
        new RegExp(fixtureCase.expectedError),
      );
      return;
    }
    assert.equal(
      evaluatePlacement(state, placement, rules).lockResult.spin,
      fixtureCase.expectedSpin,
    );
  });
}

test("all-spin requires four-direction immobility, not only contact with the floor", () => {
  const state = structuredClone(fixture.input.state);
  state.garbage.packets = [];
  const placement = {
    ...fixture.input.action.placement,
    rotationEvidence: {
      lastInputWasRotation: true,
      kickIndex: 0,
      kickId: "00",
      kickOffset: [0, 0],
    },
  };
  const rules = { ...FOUNDATION_PLACEMENT_RULES, spinBonuses: "all" };

  assert.equal(evaluatePlacement(state, placement, rules).lockResult.spin, "none");
});

for (const fixtureCase of allSpinFixture.tPrecedenceCases) {
  test(`T/all-spin precedence golden: ${fixtureCase.id}`, () => {
    const state = structuredClone(fixture.input.state);
    state.board.cells = allSpinFixture.tImmobileWithoutCornersBoardRows.join("");
    state.pieces.current = "T";
    state.garbage.packets = [];
    const placement = {
      piece: "T",
      rotation: "spawn",
      x: 3,
      y: 0,
      usedHold: false,
      rotationEvidence: {
        lastInputWasRotation: true,
        kickIndex: 0,
        kickId: "00",
        kickOffset: [0, 0],
      },
    };
    const rules = {
      ...FOUNDATION_PLACEMENT_RULES,
      spinBonuses: fixtureCase.spinBonuses,
    };

    assert.equal(
      evaluatePlacement(state, placement, rules).lockResult.spin,
      fixtureCase.expectedSpin,
    );
  });
}

test("hold placement advances current, hold, and known queue without conflating keys", () => {
  const state = structuredClone(fixture.input.state);
  state.pieces.hold = "T";
  const placement = {
    ...fixture.input.action.placement,
    piece: "T",
    x: 3,
    y: -1,
    usedHold: true,
  };

  const result = evaluatePlacement(state, placement);
  assert.equal(result.legality.legal, true);
  assert.equal(result.nextState.pieces.current, "I");
  assert.equal(result.nextState.pieces.hold, "O");
  assert.deepEqual(result.nextState.pieces.known, ["T"]);
});
