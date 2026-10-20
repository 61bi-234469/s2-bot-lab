import assert from "node:assert/strict";
import test from "node:test";

import { createInputExecutionRound } from "../src-js/input-execution-round.mjs";

const tap = (frame, key, subframe) => [{ frame, type: "keydown", data: { key, subframe } },
  { frame, type: "keyup", data: { key, subframe } }];
// Every frame: free the piece left, hard-drop it, then move the next piece left
// within the same tick.
const play = (round, frames) => {
  for (let frame = 0; frame < frames && round.status === "active"; frame++) {
    round.tick({ left: [...tap(frame, "moveLeft", 0), ...tap(frame, "hardDrop", 0.1), ...tap(frame, "moveLeft", 0.2)] });
  }
};
const column = (height) => Array.from({ length: height }, (_, y) => [5, y]);

test("a spawn blocked after a lock is a top-out even when the same tick moves the piece free", () => {
  // Column 5 reaches the spawn rows: the J after the first lock spawns into it
  // (TETR.IO block out); the move after the hard drop would free it.
  const round = createInputExecutionRound({ seed: 3, initialGarbageById: { left: column(22) },
    timeProgression: false, naturalGravity: false });
  play(round, 3);
  assert.equal(round.status, "complete");
  assert.deepEqual(round.refereeView().terminal, { frame: 1, winnerId: "right", reason: "top-out" });
  assert.equal(round.refereeView().players[0].toppedOut, true);
});

test("spawns that are not blocked keep the round going", () => {
  const round = createInputExecutionRound({ seed: 2, initialGarbageById: { left: column(19) },
    timeProgression: false, naturalGravity: false });
  play(round, 12);
  assert.equal(round.status, "active");
  assert.equal(round.refereeView().players[0].toppedOut, false);
});

test("no input of the block-out tick runs after the blocked spawn, so it cannot lock again", () => {
  const round = createInputExecutionRound({ seed: 3, initialGarbageById: { left: column(22) },
    timeProgression: false, naturalGravity: false });
  // After the J spawns blocked: free it, then move and hard-drop it in the same tick.
  round.tick({ left: [...tap(0, "moveLeft", 0), ...tap(0, "hardDrop", 0.1), ...tap(0, "moveLeft", 0.2),
    ...tap(0, "moveLeft", 0.3), ...tap(0, "hardDrop", 0.4)] });
  assert.equal(round.status, "complete");
  assert.deepEqual(round.refereeView().terminal, { frame: 1, winnerId: "right", reason: "top-out" });
  assert.equal(round.refereeView().players[0].stats.pieces, 1);
});

test("a HOLD whose piece spawns blocked is a block out too", () => {
  const round = createInputExecutionRound({ seed: 3, initialGarbageById: { left: column(22) },
    timeProgression: false, naturalGravity: false });
  // Free the first T, hold it: the J from the queue spawns blocked; the move would free it.
  round.tick({ left: [...tap(0, "moveLeft", 0), ...tap(0, "hold", 0.1), ...tap(0, "moveLeft", 0.2)] });
  assert.equal(round.status, "complete");
  assert.equal(round.refereeView().terminal.reason, "top-out");
  assert.equal(round.refereeView().players[0].hold, "T");
});

test("a natural lock inside a key event that blocks the next spawn stops that key too", () => {
  const round = createInputExecutionRound({ seed: 3, initialGarbageById: { left: column(22) },
    timeProgression: false, naturalGravity: true });
  // Free the T and soft-drop it to the floor; at frame 30 a hard drop arrives
  // mid-frame, after the T's lock delay has run out within that subframe.
  round.tick({ left: [...tap(0, "moveLeft", 0), { frame: 0, type: "keydown", data: { key: "softDrop", subframe: 0 } }] });
  for (let frame = 1; frame < 30; frame++) round.tick({});
  // Still playing: the block out must come from the frame-30 key event.
  assert.equal(round.status, "active");
  round.tick({ left: tap(30, "hardDrop", 0.5) });
  assert.equal(round.status, "complete");
  assert.equal(round.refereeView().terminal.reason, "top-out");
  assert.equal(round.refereeView().players[0].stats.pieces, 1);
});
