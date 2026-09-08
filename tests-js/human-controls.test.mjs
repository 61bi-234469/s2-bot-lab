import assert from "node:assert/strict";
import test from "node:test";

import {
  HUMAN_ACTIONS,
  SDF_INFINITE,
  actionForCode,
  defaultHumanControls,
  describeHumanControls,
  formatKeyCode,
  humanHandling,
  humanEngineHandling,
  sanitizeHumanControls,
} from "../cc2-gui/human-controls.mjs";

test("the defaults are the reference fork's own handling values", () => {
  const controls = defaultHumanControls();
  assert.deepEqual(controls.handling, {
    dasFrames: 10,
    arrFrames: 1,
    dcdFrames: 0,
    sdf: SDF_INFINITE,
    softDropPriority: false,
    ghost: true,
  });
  assert.deepEqual(controls.keys, {
    MoveLeft: "ArrowLeft",
    MoveRight: "ArrowRight",
    SoftDrop: "ArrowDown",
    HardDrop: "Space",
    RotateLeft: "KeyZ",
    RotateRight: "KeyX",
    Rotate180: "KeyA",
    Hold: "KeyC",
    Reset: "Escape",
  });
});

test("a stored document only contributes values this build accepts", () => {
  const controls = sanitizeHumanControls({
    handling: {
      dasFrames: 4.5,
      arrFrames: -1,
      dcdFrames: 61,
      sdf: 20,
      softDropPriority: "yes",
      ghost: false,
    },
    keys: { MoveLeft: "KeyH", RotateRight: "", Hold: 42, Unknown: "KeyQ" },
  });

  assert.equal(controls.handling.dasFrames, 4.5);
  assert.equal(controls.handling.arrFrames, 1, "out of range falls back to the default");
  assert.equal(controls.handling.dcdFrames, 0);
  assert.equal(controls.handling.sdf, 20);
  assert.equal(controls.handling.softDropPriority, false, "a non-boolean is not coerced");
  assert.equal(controls.handling.ghost, false);
  assert.equal(controls.keys.MoveLeft, "KeyH");
  assert.equal(controls.keys.RotateRight, "KeyX");
  assert.equal(controls.keys.Hold, "KeyC");
  assert.equal("Unknown" in controls.keys, false);
});

test("anything that is not a settings document leaves every default in place", () => {
  for (const input of [null, undefined, 7, "controls", [], { handling: 3, keys: "x" }]) {
    assert.deepEqual(sanitizeHumanControls(input), defaultHumanControls());
  }
});

test("an SDF of infinity is carried as a value JSON can hold", () => {
  assert.equal(humanHandling(defaultHumanControls()).sdf, Infinity);
  assert.equal(humanHandling(sanitizeHumanControls({ handling: { sdf: 5 } })).sdf, 5);
  assert.equal(sanitizeHumanControls({ handling: { sdf: 4 } }).handling.sdf, SDF_INFINITE);
  assert.equal(sanitizeHumanControls({ handling: { sdf: 41 } }).handling.sdf, SDF_INFINITE);
});

test('native human handling maps priority and bounds persisted repeat work', () => {
  const handling = humanEngineHandling({ handling: { sdf: 20, softDropPriority: true, arrFrames: 0.005 } });
  assert.equal(handling.sdf, 20);
  assert.equal(handling.may20g, true);
  assert.equal(handling.arr, 1);
});

test("a key is resolved to the one action it is bound to", () => {
  const controls = defaultHumanControls();
  for (const action of HUMAN_ACTIONS) {
    assert.equal(actionForCode(controls, action.defaultCode), action.key);
  }
  assert.equal(actionForCode(controls, "KeyQ"), null);
});

test("key names are read as printed on the key", () => {
  assert.equal(formatKeyCode("ArrowLeft"), "←");
  assert.equal(formatKeyCode("KeyZ"), "Z");
  assert.equal(formatKeyCode("Digit4"), "4");
  assert.equal(formatKeyCode("Numpad7"), "Num 7");
  assert.equal(formatKeyCode("F5"), "F5");
  assert.equal(formatKeyCode(undefined), "—");
});

test("the deck summary reports the values a match will run under", () => {
  assert.equal(
    describeHumanControls(defaultHumanControls()),
    "DAS 10F · ARR 1F · DCD 0F · SDF ∞ · HARD DROP Space",
  );
});
