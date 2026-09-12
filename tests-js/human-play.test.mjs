import assert from "node:assert/strict";
import test from "node:test";

import {
  VISIBLE_ROWS,
  createPieceRepeat,
  dropped,
  isPlaceable,
  lockSubmission,
  pieceCells,
  projectStallPenaltyRows,
  rotated,
  shifted,
  shiftedToEnd,
  spawnPlacement,
  stallLockPlacement,
  unprojectStallPenaltyPlacement,
} from "../cc2-gui/human-play.mjs";
import { placementGeometry } from "../src-js/triangle/placement-geometry.mjs";
import { RULESET_IDS, resolvePlacementRules } from "../src-js/ruleset-profiles.mjs";

const geometry = placementGeometry(resolvePlacementRules(RULESET_IDS.s2Observed));

function emptyBoard() {
  return Array.from({ length: 40 }, () => Array(10).fill(null));
}

// The T-spin slot the human placement adapter is qualified against.
function spinSlotBoard() {
  const board = emptyBoard();
  const rows = [
    "____GG_G__",
    "___G____G_",
    "__GGG__GGG",
    "_GG____G_G",
  ];
  for (let y = 0; y < rows.length; y += 1) {
    board[y] = [...rows[y]].map((cell) => cell === "_" ? null : "G");
  }
  return board;
}

test("a spawned piece is centred and fully inside the visible field", () => {
  const board = emptyBoard();
  for (const piece of ["I", "O", "T", "L", "J", "S", "Z"]) {
    const placement = spawnPlacement(geometry, board, piece);
    const cells = pieceCells(geometry, placement);
    const columns = cells.map(([x]) => x);
    const rows = cells.map(([, y]) => y);
    assert.equal(Math.max(...rows), VISIBLE_ROWS - 1, `${piece} spawns against the top visible row`);
    assert.ok(Math.min(...columns) >= 3 && Math.max(...columns) <= 6, `${piece} spawns centred`);
    assert.equal(placement.usedHold, false);
    assert.deepEqual(placement.rotationEvidence, { lastInputWasRotation: false, kickIndex: null });
  }
});

test("a piece handed over onto a full stack stays where the queue put it", () => {
  const board = emptyBoard();
  // Filled to the top of the visible field, so nothing can settle into view.
  for (let y = 0; y < VISIBLE_ROWS; y += 1) board[y] = Array(10).fill("G");
  const placement = spawnPlacement(geometry, board, "T");
  assert.ok(pieceCells(geometry, placement).every(([, y]) => y >= VISIBLE_ROWS));

  for (let y = VISIBLE_ROWS; y < 40; y += 1) board[y] = Array(10).fill("G");
  assert.equal(spawnPlacement(geometry, board, "T"), null);
});

test("movement stops at the walls, the floor and the stack", () => {
  const board = emptyBoard();
  const spawned = spawnPlacement(geometry, board, "T");

  assert.equal(shiftedToEnd(geometry, board, spawned, -1).x, 0);
  assert.equal(shiftedToEnd(geometry, board, spawned, 1).x, 7);
  assert.equal(shifted(geometry, board, { ...spawned, x: 0 }, -1, 0), null);

  const landed = dropped(geometry, board, spawned);
  assert.deepEqual(
    pieceCells(geometry, landed).map(([, y]) => y).sort(),
    [0, 0, 0, 1],
  );
  assert.equal(shifted(geometry, board, landed, 0, -1), null);
});

test("a rotation records the kick that reached the pose", () => {
  const board = spinSlotBoard();
  const upright = { piece: "T", rotation: "right", x: 4, y: 1, usedHold: false, rotationEvidence: { lastInputWasRotation: false, kickIndex: null } };
  assert.equal(isPlaceable(geometry, board, upright), true);

  const turned = rotated(geometry, board, upright, -1);
  assert.equal(turned.rotation, "spawn");
  assert.equal(turned.x, 5);
  assert.equal(turned.y, 0);
  // The same witness the S2 kickset reachability model produces for this pose.
  assert.deepEqual(turned.rotationEvidence, {
    lastInputWasRotation: true,
    kickIndex: 1,
    kickId: "10",
    kickOffset: [1, -1],
  });
  assert.deepEqual(lockSubmission(turned), {
    piece: "T",
    rotation: "spawn",
    x: 5,
    y: 0,
    usedHold: false,
    rotationEvidence: { lastInputWasRotation: true, kickIndex: 1, kickId: "10", kickOffset: [1, -1] },
  });
});

test("an unkicked rotation is recorded as the no-kick result", () => {
  const board = emptyBoard();
  const turned = rotated(geometry, board, spawnPlacement(geometry, board, "T"), 1);
  assert.equal(turned.rotation, "right");
  assert.deepEqual(turned.rotationEvidence, {
    lastInputWasRotation: true,
    kickIndex: 0,
    kickId: "00",
    kickOffset: [0, 0],
  });
});

test("a rotation with nowhere to go leaves the piece alone", () => {
  const board = emptyBoard();
  for (let y = 0; y < 4; y += 1) {
    board[y] = [...Array(10)].map((_, x) => (x === 4 ? null : "G"));
  }
  const inWell = { piece: "I", rotation: "left", x: 3, y: 0, usedHold: false, rotationEvidence: { lastInputWasRotation: false, kickIndex: null } };
  assert.equal(isPlaceable(geometry, board, inWell), true);
  assert.equal(rotated(geometry, board, inWell, 1), null);
});

test("moving a piece clears any rotation evidence it was carrying", () => {
  const board = emptyBoard();
  const turned = rotated(geometry, board, spawnPlacement(geometry, board, "T"), 1);
  assert.equal(shifted(geometry, board, turned, -1, 0).rotationEvidence.lastInputWasRotation, false);
  assert.equal(dropped(geometry, board, turned).rotationEvidence.lastInputWasRotation, true);
});

function fakeTimers() {
  let currentMs = 0;
  let nextId = 1;
  const scheduled = new Map();
  return {
    now: () => currentMs,
    setTimer: (callback, delayMs) => {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, { at: currentMs + Math.max(0, delayMs), callback });
      return id;
    },
    clearTimer: (id) => scheduled.delete(id),
    advance(ms) {
      const target = currentMs + ms;
      for (;;) {
        const due = [...scheduled.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (due === undefined) break;
        scheduled.delete(due[0]);
        currentMs = due[1].at;
        due[1].callback();
      }
      currentMs = target;
    },
  };
}

test("auto-shift waits for DAS and then repeats at ARR", () => {
  const timers = fakeTimers();
  const repeat = createPieceRepeat(timers);
  let moves = 0;
  repeat.startShift("MoveLeft", {
    move: () => { moves += 1; },
    moveToEnd: () => { moves += 100; },
    dasFrames: 10,
    arrFrames: 2,
  });

  assert.equal(moves, 1, "the press itself moves once");
  timers.advance(9 * 1000 / 60);
  assert.equal(moves, 1, "nothing repeats before DAS elapses");
  timers.advance(2 * 1000 / 60);
  assert.equal(moves, 2, "auto-shift starts with a move of its own");
  timers.advance(4 * 1000 / 60);
  assert.equal(moves, 4);

  repeat.end("MoveLeft");
  timers.advance(10 * 1000 / 60);
  assert.equal(moves, 4, "releasing the key stops the repeat");
  assert.equal(repeat.isActive("MoveLeft"), false);
});

test("ARR 0 resolves the whole path at once instead of stepping", () => {
  const timers = fakeTimers();
  const repeat = createPieceRepeat(timers);
  let steps = 0;
  let toEnd = 0;
  repeat.startShift("MoveRight", {
    move: () => { steps += 1; },
    moveToEnd: () => { toEnd += 1; },
    dasFrames: 5,
    arrFrames: 0,
  });
  assert.equal(steps, 1, "the press itself still moves one cell");
  assert.equal(toEnd, 0);
  timers.advance(6 * 1000 / 60);
  assert.ok(toEnd >= 1, "auto-shift goes straight to the wall");
  // It keeps re-applying every frame while held. Moving to a wall the piece is
  // already against does nothing, which is what lets a direction stay charged.
  const applied = toEnd;
  timers.advance(3 * 1000 / 60);
  assert.equal(steps, 1, "and never falls back to stepping a cell at a time");
  assert.ok(toEnd > applied);
  repeat.endAll();
});

test("DAS Cut pauses a charged auto-shift and DAS carries across a spawn", () => {
  const timers = fakeTimers();
  const repeat = createPieceRepeat(timers);
  let moves = 0;
  repeat.startShift("MoveLeft", {
    move: () => { moves += 1; },
    moveToEnd: () => {},
    dasFrames: 10,
    arrFrames: 1,
  });
  timers.advance(11 * 1000 / 60);
  const charged = moves;
  assert.ok(charged >= 2);

  repeat.cutDas(8);
  timers.advance(4 * 1000 / 60);
  assert.equal(moves, charged, "auto-shift is held for the DAS cut delay");
  timers.advance(6 * 1000 / 60);
  assert.ok(moves > charged, "and resumes once it has passed");

  const beforeSpawn = moves;
  repeat.activateDasCut(0);
  assert.equal(moves, beforeSpawn + 1, "a held direction keeps its charge into the next piece");
  repeat.endAll();
});

test("soft drop repeats on the SDF cadence and stops on release", () => {
  const timers = fakeTimers();
  const repeat = createPieceRepeat(timers);
  let steps = 0;
  // SDF 5 is 15 cells per second: one step every four frames.
  repeat.startSoftDrop("SoftDrop", () => { steps += 1; }, 5);
  assert.equal(steps, 1);
  timers.advance(8 * 1000 / 60);
  assert.equal(steps, 3);
  repeat.end("SoftDrop");
  timers.advance(8 * 1000 / 60);
  assert.equal(steps, 3);
});

test("the forced-lock penalty drops the piece from its spawn column and spawn rotation", () => {
  const board = emptyBoard();
  for (const piece of ["I", "J", "L", "O", "S", "T", "Z"]) {
    const spawned = spawnPlacement(geometry, board, piece);
    // Whatever the player did to the piece is deliberately not an input to the
    // forced lock: it lands where an untouched piece would have landed.
    const moved = rotated(geometry, board, shiftedToEnd(geometry, board, spawned, 1), 1)
      ?? shiftedToEnd(geometry, board, spawned, 1);
    const forced = stallLockPlacement(geometry, board, moved);
    assert.deepEqual(
      pieceCells(geometry, forced).map((cell) => cell.join(",")).sort(),
      pieceCells(geometry, dropped(geometry, board, spawned)).map((cell) => cell.join(",")).sort(),
    );
    assert.equal(forced.rotation, spawned.rotation);
    assert.equal(forced.x, spawned.x);
    assert.equal(forced.rotationEvidence.lastInputWasRotation, false);
  }
});

test("a forced lock after HOLD keeps the swap evidence of the piece it locks", () => {
  const board = emptyBoard();
  const held = spawnPlacement(geometry, board, "L", true);
  const forced = stallLockPlacement(geometry, board, shiftedToEnd(geometry, board, held, -1));
  assert.equal(forced.piece, "L");
  assert.equal(forced.usedHold, true);
  assert.equal(lockSubmission(forced).usedHold, true);
  assert.equal(forced.x, spawnPlacement(geometry, board, "L").x);
});

test("the forced-lock penalty reports no placement once the piece has no spawn placement left", () => {
  const board = emptyBoard();
  const spawned = spawnPlacement(geometry, board, "T");
  for (let y = VISIBLE_ROWS; y < VISIBLE_ROWS + 4; y += 1) board[y] = Array(10).fill("G");
  assert.equal(stallLockPlacement(geometry, board, spawned), null);
});

test("stall penalty rows form a separate indestructible floor and placements round-trip", () => {
  const board = emptyBoard();
  board[0][4] = "T";
  const projected = projectStallPenaltyRows(board, 2);
  assert.deepEqual(projected[0], Array(10).fill("P"));
  assert.deepEqual(projected[1], Array(10).fill("P"));
  assert.equal(projected[2][4], "T");
  assert.equal(board[0][4], "T", "the referee board is not mutated");
  assert.equal(unprojectStallPenaltyPlacement({ piece: "I", y: 7 }, 2).y, 5);
});
