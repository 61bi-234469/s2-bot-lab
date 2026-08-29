import assert from "node:assert/strict";
import test from "node:test";

import { FIELD_CELLS, PIECE } from "../src-js/replay/pieces.mjs";
import {
  garbageViewAt,
  gaugeAtFrame,
  getGarbageTimeline,
  killerGarbageOf,
  pendingParcelsAt,
  riseForecastAt,
  tankedAtFrame,
} from "../src-js/replay/replay-garbage.mjs";
import {
  activeAtFrame,
  boardAtFrame,
  formatFrameTime,
  indexAtFrame,
  lastPointIndex,
  pointAt,
  preLockPointAt,
  queueAtFrame,
  statsAt,
  stopFrameAt,
  visualAtFrame,
} from "../src-js/replay/replay-timeline.mjs";

const EMPTY = Object.freeze(Array(FIELD_CELLS).fill(PIECE.EMPTY));

function field(cells) {
  const copy = EMPTY.slice();
  for (const [x, y, piece] of cells) copy[y * 10 + x] = piece;
  return copy;
}

function lock(pieceIndex, frame, overrides = {}) {
  const cells = overrides.cells ?? [[0, pieceIndex], [1, pieceIndex], [2, pieceIndex], [3, pieceIndex]];
  return {
    pieceIndex,
    frame,
    piece: PIECE.I,
    rotation: 0,
    x: 1,
    y: pieceIndex,
    cells,
    fieldBefore: EMPTY.slice(),
    fieldAfter: field(cells.map(([x, y]) => [x, y, PIECE.I])),
    hold: PIECE.T,
    current: PIECE.O,
    next: [PIECE.S, PIECE.Z],
    clear: { lines: 0, spin: "none", b2b: -1, ren: -1, perfectClear: false },
    attack: 0,
    garbageCleared: 0,
    garbageGauge: 0,
    sourceHeight: pieceIndex + 1,
    clippedRowCount: 0,
    ...overrides,
  };
}

// A hand-built IR with no visual timeline: the settled point space is the
// fallback every reader falls back to.
function player(overrides = {}) {
  return {
    id: "alpha",
    username: "alpha",
    resolvedOptions: { garbagecap: 8 },
    optionWarnings: [],
    initial: { frame: 0, field: EMPTY.slice(), hold: null, current: PIECE.I, next: [PIECE.T, PIECE.O] },
    // The last two share a frame: one raw frame can hold two placements.
    locks: [lock(0, 60), lock(1, 120), lock(2, 120)],
    garbageEvents: [],
    terminal: {
      frame: 300,
      field: field([[0, 0, PIECE.GRAY]]),
      sourceHeight: 1,
      clippedRowCount: 0,
      garbageGauge: 0,
      hold: PIECE.T,
      current: PIECE.L,
      next: [PIECE.J],
      reason: "winner",
      alive: true,
    },
    verification: { matched: true },
    ...overrides,
  };
}

test("the point space runs from the round start through every lock to the terminal", () => {
  const round = player();
  assert.equal(lastPointIndex(round), 4);
  assert.equal(pointAt(round, 0).kind, "initial");
  assert.equal(pointAt(round, 1).kind, "lock");
  assert.equal(pointAt(round, 1).frame, 60);
  assert.equal(pointAt(round, 4).kind, "terminal");
  // Out-of-range indices clamp rather than throwing: the cursor is user input.
  assert.equal(pointAt(round, -3).index, 0);
  assert.equal(pointAt(round, 99).index, 4);
});

test("a frame resolves to the last point settled at or before it", () => {
  const round = player();
  assert.equal(indexAtFrame(round, 0), 0);
  assert.equal(indexAtFrame(round, 59), 0);
  assert.equal(indexAtFrame(round, 60), 1);
  assert.equal(indexAtFrame(round, 119), 1);
  // Two locks share frame 120, and the later one is the state to show.
  assert.equal(indexAtFrame(round, 120), 3);
  assert.equal(indexAtFrame(round, 300), lastPointIndex(round));
  assert.equal(indexAtFrame(round, 9999), lastPointIndex(round));
});

test("without a visual timeline the settled points are what a cursor reads", () => {
  const round = player();
  assert.deepEqual(boardAtFrame(round, 70).field, round.locks[0].fieldAfter);
  assert.equal(queueAtFrame(round, 70).hold, PIECE.T);
  assert.equal(activeAtFrame(round, 70), undefined, "a settled lock has no falling piece");
  const visual = visualAtFrame(round, 400);
  assert.equal(visual.frame, 300, "the cursor cannot leave the replay");
  assert.equal(visual.current, PIECE.L);
});

test("the visual timeline wins over the settled points and keeps its own boundaries", () => {
  const boards = [
    { frame: 0, field: EMPTY.slice(), sourceHeight: 0, clippedRowCount: 0 },
    { frame: 30, field: field([[5, 5, PIECE.Z]]), sourceHeight: 6, clippedRowCount: 0 },
  ];
  const active = [
    { frame: 10, piece: PIECE.T, rotation: 0, x: 4, y: 18, cells: [[3, 18], [4, 18], [5, 18], [4, 19]] },
  ];
  const round = player({ visual: { boards, active, queues: [], garbage: [] } });
  assert.equal(boardAtFrame(round, 29).field[55], PIECE.EMPTY);
  assert.equal(boardAtFrame(round, 30).field[55], PIECE.Z);
  assert.equal(activeAtFrame(round, 9), undefined);
  assert.equal(activeAtFrame(round, 20).piece, PIECE.T);
  // Nothing spawned after the lock on frame 60, so the piece just placed must
  // not be redrawn as if it were still falling.
  assert.equal(activeAtFrame(round, 61), undefined);
});

test("turn stepping stops just before the placement settles", () => {
  const round = player();
  const preLock = preLockPointAt(round, 1);
  assert.equal(preLock.frame, 59);
  assert.equal(preLock.confirmedIndex, 0, "the stepped placement is not counted yet");
  assert.equal(preLock.visual.current, PIECE.I, "the piece being placed is current again");
  assert.deepEqual(preLock.visual.next, [PIECE.O, PIECE.S, PIECE.Z], "its successor returns to NEXT");
  assert.equal(stopFrameAt(round, 1), 59);

  // The second of two locks sharing a frame has no distinct pre-lock state, so
  // stepping falls back to the settled frame.
  assert.equal(preLockPointAt(round, 3), undefined);
  assert.equal(stopFrameAt(round, 3), 120);
  assert.equal(preLockPointAt(round, 0), undefined);
});

test("a turn whose cells are already on the retained board cannot be reconstructed", () => {
  const occupied = field([[0, 0, PIECE.I], [1, 0, PIECE.I], [2, 0, PIECE.I], [3, 0, PIECE.I]]);
  const round = player({
    visual: {
      boards: [{ frame: 0, field: occupied, sourceHeight: 1, clippedRowCount: 0 }],
      active: [],
      queues: [],
      garbage: [],
    },
  });
  assert.equal(preLockPointAt(round, 1), undefined);
});

test("stats accumulate to the cursor and report the chain the engine recorded", () => {
  const round = player({
    locks: [
      lock(0, 60, { attack: 0, garbageCleared: 0, clear: { lines: 1, spin: "none", b2b: -1, ren: 0, perfectClear: false } }),
      lock(1, 120, { attack: 4, garbageCleared: 2, clear: { lines: 4, spin: "none", b2b: 0, ren: 1, perfectClear: false } }),
    ],
  });
  const opening = statsAt(round, 0);
  assert.deepEqual([opening.placed, opening.attack, opening.pps], [0, 0, 0]);

  const second = statsAt(round, 2);
  assert.equal(second.placed, 2);
  assert.equal(second.attack, 4);
  assert.equal(second.garbageCleared, 2);
  assert.equal(second.seconds, 2);
  assert.equal(second.pps, 1);
  assert.equal(second.apm, 120);
  assert.equal(second.b2b, 0);
  assert.equal(second.ren, 1);
  assert.equal(second.lastClear.lines, 4);

  const terminal = statsAt(round, lastPointIndex(round));
  assert.equal(terminal.placed, 2, "the terminal counts every lock");
  assert.equal(terminal.totalLocks, 2);
});

test("the gauge, the tanked total and the pending parcels come from the event series alone", () => {
  const round = player({
    garbageEvents: [
      { frame: 40, kind: "confirm", iid: 1, amount: 0, gameid: 9, senderFrame: 33 },
      { frame: 40, kind: "receive", iid: 1, amount: 4 },
      { frame: 70, kind: "receive", iid: 2, amount: 2 },
      { frame: 90, kind: "cancel", iid: 1, amount: 1, size: 1 },
      { frame: 130, kind: "tank", iid: 1, amount: 3, column: 6, size: 1 },
    ],
  });
  const timeline = getGarbageTimeline(round);
  assert.equal(gaugeAtFrame(timeline, 39), 0);
  assert.equal(gaugeAtFrame(timeline, 40), 4);
  assert.equal(gaugeAtFrame(timeline, 70), 6);
  assert.equal(gaugeAtFrame(timeline, 90), 5);
  assert.equal(gaugeAtFrame(timeline, 130), 2);
  assert.equal(tankedAtFrame(timeline, 129), 0);
  assert.equal(tankedAtFrame(timeline, 130), 3);
  assert.deepEqual(pendingParcelsAt(timeline, 100), [
    { iid: 1, receivedFrame: 40, remaining: 3 },
    { iid: 2, receivedFrame: 70, remaining: 2 },
  ]);
  // A confirm carries the sender's own clock, which is on the shared axis.
  assert.equal(timeline.parcels[0].senderFrame, 33);
  assert.equal(timeline.maxGauge, 6);

  const view = garbageViewAt(round, 100);
  assert.equal(view.gauge, 5);
  assert.equal(view.cap, 8);
  assert.deepEqual(view.recent, { frame: 90, kind: "cancel", iid: 1, amount: 1, size: 1 });
  assert.deepEqual(riseForecastAt(timeline, 100, 5), [{ frame: 130, column: 6, size: 1, rows: 3 }]);
  // With nothing pending there is nothing to warn about, hindsight or not.
  assert.deepEqual(garbageViewAt(round, 10).rises, []);
});

test("only garbage that landed after the last placement is named as the cause of death", () => {
  const events = [
    { frame: 100, kind: "receive", iid: 1, amount: 4 },
    { frame: 200, kind: "tank", iid: 1, amount: 4, column: 3, size: 1 },
  ];
  assert.deepEqual(killerGarbageOf(player({ garbageEvents: events, terminal: { ...player().terminal, reason: "garbagesmash", alive: false } })), {
    frame: 200,
    amount: 4,
    column: 3,
    senderFrame: undefined,
    gameid: undefined,
  });
  // A winner was not killed, and neither was a player who topped out placing.
  assert.equal(killerGarbageOf(player({ garbageEvents: events })), undefined);
  const toppedOut = player({
    garbageEvents: events,
    locks: [lock(0, 260)],
    terminal: { ...player().terminal, reason: "topout", alive: false },
  });
  assert.equal(killerGarbageOf(toppedOut), undefined);
});

test("frame times are shown to a tenth of a second", () => {
  assert.equal(formatFrameTime(0), "0:00.0");
  assert.equal(formatFrameTime(90), "0:01.5");
  assert.equal(formatFrameTime(3600), "1:00.0");
  assert.equal(formatFrameTime(-5), "0:00.0");
});
