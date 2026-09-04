import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import {
  advanceBotMatch,
  botMatchNextStep,
  botMatchToGuiState,
  createBotMatch,
  extendBotMatchQueue,
  externalLockFrameWindow,
  isExternallyPaced,
  synchronizeBotMatchMovementState,
  synchronizeBotMatchMovementStates,
} from "../src-js/bot-match-controller.mjs";
import { calculatePlayerMetrics } from "../cc2-gui/player-metrics.mjs";
import { fullStateKey } from "../src-js/state-keys.mjs";

const fixture = JSON.parse(readFileSync("fixtures/golden/placement-perfect-clear.json", "utf8"));

function state({ frame = 100, marker = null } = {}) {
  const result = structuredClone(fixture.input.state);
  result.time.logicalFrame = frame;
  result.garbage.packets = [];
  result.provenance = { marker };
  return result;
}

function guiState(options) {
  const result = state(options);
  result.board.height = 40;
  result.board.visibleHeight = 20;
  result.board.bufferHeight = 20;
  result.board.cells = result.board.cells.padEnd(400, "_");
  return result;
}

function submission(botId, before, {
  outgoing = 0,
  cancelled = 0,
  attack = outgoing,
  lines = 0,
  clearedRows = [],
  boardMarker = null,
} = {}) {
  const nextState = structuredClone(before);
  nextState.time.piecesPlaced += 1;
  if (boardMarker !== null) nextState.board.cells = boardMarker + nextState.board.cells.slice(1);
  return {
    botId,
    result: {
      comparison: { positionFingerprint: fullStateKey(before) },
      transition: {
        legality: { legal: true, reason: null },
        lockResult: { lines, spin: "none", perfectClear: false, clearedRows },
        chain: {},
        attackStages: { outgoingBeforeCancel: attack },
        cancelResult: { cancelled, outgoingAfterCancel: outgoing },
        tankResult: { inserted: [], deferred: [], toppedOut: false },
        nextState,
      },
    },
  };
}

test("alternating mode advances a shared synthetic clock and delivers outgoing garbage", () => {
  const left = state({ marker: "left" });
  const right = state({ marker: "right" });
  const original = createBotMatch({
    bots: [{ id: "left", gameId: 41, state: left }, { id: "right", gameId: 42, state: right }],
    mode: "alternating",
    framesPerTurn: 60,
  });

  const next = advanceBotMatch(original, [submission("left", left, { outgoing: 3, lines: 4 })]);

  assert.equal(next.activeBotId, "right");
  assert.equal(next.turnNumber, 1);
  assert.equal(next.clock.logicalFrame, 160);
  assert.deepEqual(next.bots.map((bot) => bot.state.time.logicalFrame), [160, 160]);
  assert.equal(next.bots[0].stats.turns, 1);
  assert.deepEqual(next.bots[1].state.garbage.packets.map((packet) => ({
    sourceGameId: packet.sourceGameId,
    amount: packet.amount,
    arrivalFrame: packet.arrivalFrame,
    confirmed: packet.confirmed,
  })), [{ sourceGameId: 41, amount: 3, arrivalFrame: 160, confirmed: true }]);
  assert.equal(original.clock.logicalFrame, 100);
  assert.deepEqual(original.bots[1].state.garbage.packets, []);
});

test("simultaneous mode evaluates both pre-round states before cross-delivery", () => {
  const left = state({ marker: "left" });
  const right = state({ marker: "right" });
  const match = createBotMatch({
    bots: [{ id: "left", state: left }, { id: "right", state: right }],
    mode: "simultaneous",
    garbageDelayFrames: 20,
  });

  const next = advanceBotMatch(match, [
    submission("right", right, { outgoing: 4, boardMarker: "Z" }),
    submission("left", left, { outgoing: 2, boardMarker: "I" }),
  ]);

  assert.equal(next.activeBotId, null);
  assert.equal(next.bots[0].state.board.cells[0], "I");
  assert.equal(next.bots[1].state.board.cells[0], "Z");
  assert.deepEqual(next.lastStep.submittedBotIds, ["left", "right"]);
  assert.deepEqual(next.lastStep.deliveries.map((delivery) => [
    delivery.fromBotId,
    delivery.toBotId,
    delivery.packet.amount,
    delivery.packet.arrivalFrame,
  ]), [
    ["left", "right", 2, 180],
    ["right", "left", 4, 180],
  ]);
  assert.deepEqual(next.bots.map((bot) => bot.stats), [
    { turns: 1, attack: 2, garbageCancelled: 0, garbageCleared: 0, garbageSent: 2, garbageReceived: 4 },
    { turns: 1, attack: 4, garbageCancelled: 0, garbageCleared: 0, garbageSent: 4, garbageReceived: 2 },
  ]);
});

test("synthetic match frames, rather than search latency, define bot PPS", () => {
  const left = state({ frame: 0, marker: "left" });
  const right = state({ frame: 0, marker: "right" });
  const match = createBotMatch({
    bots: [
      { id: "left", state: left },
      { id: "right", state: right },
    ],
    framesPerTurn: 60,
  });
  const advanced = advanceBotMatch(match, [
    submission("left", left),
    submission("right", right),
  ]);

  for (const bot of advanced.bots) {
    const metrics = calculatePlayerMetrics({
      pieces: bot.stats.turns,
      attack: bot.stats.attack,
      garbageCleared: bot.stats.garbageCleared,
      elapsedFrames: advanced.clock.logicalFrame,
    });
    assert.equal(metrics.pps, 1);
  }
});

test("paced mode schedules each bot independently at its configured PPS", () => {
  const left = state({ frame: 0, marker: "left" });
  const right = state({ frame: 0, marker: "right" });
  let match = createBotMatch({
    bots: [{ id: "left", state: left }, { id: "right", state: right }],
    mode: "paced",
    ppsByBotId: { left: 2, right: 1 },
  });

  assert.deepEqual(botMatchNextStep(match), { logicalFrame: 30, frames: 30, botIds: ["left"] });
  match = advanceBotMatch(match, [submission("left", left)]);
  assert.deepEqual(botMatchNextStep(match), { logicalFrame: 60, frames: 30, botIds: ["left", "right"] });
  match = advanceBotMatch(match, [
    submission("left", match.bots[0].state),
    submission("right", match.bots[1].state),
  ]);

  assert.deepEqual(match.bots.map((bot) => bot.stats.turns), [2, 1]);
  assert.equal(match.clock.logicalFrame, 60);
  assert.deepEqual(match.bots.map((bot) => calculatePlayerMetrics({
    pieces: bot.stats.turns,
    attack: 0,
    garbageCleared: 0,
    elapsedFrames: match.clock.logicalFrame,
  }).pps), [2, 1]);
});

test("fractional PPS projects each rounded cadence as an integer lock step", () => {
  const left = guiState({ frame: 0, marker: "left" });
  const right = guiState({ frame: 0, marker: "right" });
  let match = createBotMatch({
    bots: [{ id: "left", state: left }, { id: "right", state: right }],
    mode: "paced",
    ppsByBotId: { left: 1.3, right: 1.3 },
  });

  for (const expected of [46, 46, 46, 47]) {
    assert.equal(botMatchToGuiState(match, "left").s2.clock.framesPerLock, expected);
    const due = botMatchNextStep(match);
    assert.equal(due.frames, expected);
    match = advanceBotMatch(match, match.bots.map((bot) => submission(bot.id, bot.state)));
  }
  assert.equal(match.clock.logicalFrame, 185);
});

test("paced projection measures from the shared clock after the other bot locks", () => {
  const left = guiState({ frame: 0, marker: "left" });
  const right = guiState({ frame: 0, marker: "right" });
  let match = createBotMatch({
    bots: [{ id: "left", state: left }, { id: "right", state: right }],
    mode: "paced",
    ppsByBotId: { left: 2, right: 1 },
  });

  match = advanceBotMatch(match, [submission("left", left)]);
  assert.equal(match.clock.logicalFrame, 30);
  assert.equal(botMatchToGuiState(match, "right").s2.clock.framesPerLock, 30);
});

test("an externally paced player locks on the frames the caller supplies", () => {
  const left = state({ frame: 0, marker: "left" });
  const right = state({ frame: 0, marker: "right" });
  let match = createBotMatch({
    bots: [{ id: "left", state: left }, { id: "right", state: right }],
    mode: "paced",
    ppsByBotId: { left: null, right: 1 },
  });

  assert.equal(isExternallyPaced(match, "left"), true);
  assert.equal(isExternallyPaced(match, "right"), false);
  assert.equal(match.pace.nextLockFrames.left, null);
  // The scheduled opponent is the only bot the synthetic schedule can make due.
  assert.deepEqual(botMatchNextStep(match), { logicalFrame: 60, frames: 60, botIds: ["right"] });
  assert.deepEqual(externalLockFrameWindow(match, "left"), { earliest: 1, latest: 59 });

  match = advanceBotMatch(match, [submission("left", match.bots[0].state, { outgoing: 2 })], {
    externalLockFrame: 24,
  });
  assert.equal(match.clock.logicalFrame, 24);
  assert.equal(match.pace.nextLockFrames.left, null, "no next lock is claimed for a player");
  assert.equal(match.pace.nextLockFrames.right, 60, "and the opponent keeps its own schedule");
  assert.equal(match.bots[1].stats.garbageReceived, 2);
  assert.deepEqual(externalLockFrameWindow(match, "left"), { earliest: 25, latest: 59 });
});

test("a real-time player lock atomically rebases every overdue scheduled bot", () => {
  const left = state({ frame: 0, marker: "left" });
  const right = state({ frame: 0, marker: "right" });
  let match = createBotMatch({
    bots: [{ id: "left", state: left }, { id: "right", state: right }],
    mode: "paced",
    ppsByBotId: { left: null, right: 1 },
  });

  match = advanceBotMatch(match, [submission("left", left)], {
    externalLockFrame: 1001,
    allowScheduledOverrun: true,
  });

  assert.equal(match.clock.logicalFrame, 1001);
  assert.equal(match.pace.nextLockFrames.right, 1002);
  assert.deepEqual(botMatchNextStep(match), { logicalFrame: 1002, frames: 1, botIds: ["right"] });
  assert.deepEqual(externalLockFrameWindow(match, "left", { allowScheduledOverrun: true }), {
    earliest: 1002,
    latest: Number.MAX_SAFE_INTEGER,
  });

  match = advanceBotMatch(match, [submission("right", match.bots[1].state)]);
  assert.equal(match.clock.logicalFrame, 1002);
  assert.equal(match.pace.nextLockFrames.right, 1062);
});

test("a late scheduled lock starts its next cadence from the actual lock frame", () => {
  const left = state({ frame: 0, marker: "left" });
  const right = state({ frame: 0, marker: "right" });
  let match = createBotMatch({
    bots: [{ id: "left", state: left }, { id: "right", state: right }],
    mode: "paced",
    ppsByBotId: { left: null, right: 4 },
  });

  match = advanceBotMatch(match, [submission("right", right)], { scheduledLockFrame: 41 });
  assert.equal(match.clock.logicalFrame, 41);
  assert.equal(match.pace.nextLockFrames.right, 56);
  assert.equal(match.pace.cadenceByBotId.right.originFrame, 41);
  assert.equal(match.pace.cadenceByBotId.right.placementNumber, 1);
});

test("a player lock can neither pass a scheduled lock nor stall the clock", () => {
  const left = state({ frame: 0, marker: "left" });
  const right = state({ frame: 0, marker: "right" });
  const match = createBotMatch({
    bots: [{ id: "left", state: left }, { id: "right", state: right }],
    mode: "paced",
    ppsByBotId: { left: null, right: 1 },
  });
  const lock = () => submission("left", match.bots[0].state);

  assert.throws(
    () => advanceBotMatch(match, [lock()], { externalLockFrame: 60 }),
    /externalLockFrame must be from 1 to 59/,
  );
  assert.throws(
    () => advanceBotMatch(match, [lock()], { externalLockFrame: 0 }),
    /externalLockFrame must be from 1 to 59/,
  );
  assert.throws(
    () => advanceBotMatch(match, [submission("right", match.bots[1].state)], { externalLockFrame: 30 }),
    /bot right is not externally paced/,
  );
  assert.throws(
    () => advanceBotMatch(match, [lock(), submission("right", match.bots[1].state)], { externalLockFrame: 30 }),
    /an external lock advances exactly one player/,
  );
});

test("a match cannot consist of two players nobody schedules", () => {
  const left = state({ frame: 0, marker: "left" });
  const right = state({ frame: 0, marker: "right" });
  assert.throws(() => createBotMatch({
    bots: [{ id: "left", state: left }, { id: "right", state: right }],
    mode: "paced",
    ppsByBotId: { left: null, right: null },
  }), /at least one scheduled bot/);
});

test("an externally paced player reports the match's own turn length", () => {
  const left = state({ frame: 0, marker: "left" });
  const right = state({ frame: 0, marker: "right" });
  for (const canonical of [left, right]) {
    canonical.board.height = 40;
    canonical.board.visibleHeight = 20;
    canonical.board.bufferHeight = 20;
    canonical.board.cells = canonical.board.cells.padEnd(400, "_");
  }
  const match = createBotMatch({
    bots: [{ id: "left", state: left }, { id: "right", state: right }],
    mode: "paced",
    ppsByBotId: { left: null, right: 2 },
  });
  assert.equal(botMatchToGuiState(match, "left").s2.clock.framesPerLock, 60);
  assert.equal(botMatchToGuiState(match, "right").s2.clock.framesPerLock, 30);
});

test("match stats retain generated attack and infer cleared garbage rows", () => {
  const left = state();
  const right = state();
  left.board.cells = `G${"I".repeat(9)}${left.board.cells.slice(10)}`;
  const match = createBotMatch({ bots: [{ id: "left", state: left }, { id: "right", state: right }] });

  const next = advanceBotMatch(match, [
    submission("left", left, { outgoing: 1, cancelled: 3, attack: 4, lines: 1, clearedRows: [0] }),
    submission("right", right),
  ]);

  assert.deepEqual(next.bots[0].stats, {
    turns: 1,
    attack: 4,
    garbageCancelled: 3,
    garbageCleared: 1,
    garbageSent: 1,
    garbageReceived: 0,
  });
});

test("a stale or missing simultaneous submission fails atomically", () => {
  const left = state({ marker: "left" });
  const right = state({ marker: "right" });
  const match = createBotMatch({ bots: [{ id: "left", state: left }, { id: "right", state: right }] });
  const stale = submission("right", right);
  const different = state({ marker: "different" });
  different.board.cells = `Z${different.board.cells.slice(1)}`;
  stale.result.comparison.positionFingerprint = fullStateKey(different);

  assert.throws(
    () => advanceBotMatch(match, [submission("left", left), stale]),
    /stale transition for bot right/,
  );
  assert.throws(
    () => advanceBotMatch(match, [submission("left", left)]),
    /requires submissions from left, right/,
  );
  assert.equal(match.turnNumber, 0);
  assert.deepEqual(match.bots.map((bot) => bot.stats.turns), [0, 0]);
});

test("packet allocation skips an existing identity for the same source game", () => {
  const left = state();
  const right = state();
  right.garbage.packets.push({
    packetId: 1,
    sourceGameId: 11,
    amount: 1,
    holeSize: 1,
    arrivalFrame: 90,
    confirmed: true,
    order: 0,
  });
  const match = createBotMatch({
    bots: [{ id: "left", gameId: 11, state: left }, { id: "right", gameId: 12, state: right }],
    mode: "alternating",
    nextPacketId: 1,
  });

  const next = advanceBotMatch(match, [submission("left", left, { outgoing: 2 })]);
  assert.deepEqual(next.bots[1].state.garbage.packets.map((packet) => packet.packetId), [1, 2]);
  assert.equal(next.garbage.nextPacketId, 3);
});

test("creation refuses clocks and rulesets that cannot share a match timeline", () => {
  const left = state({ frame: 100 });
  const wrongFrame = state({ frame: 101 });
  assert.throws(
    () => createBotMatch({ bots: [{ id: "left", state: left }, { id: "right", state: wrongFrame }] }),
    /same logical frame/,
  );

  const wrongRules = state({ frame: 100 });
  wrongRules.rulesetId = "different-ruleset";
  assert.throws(
    () => createBotMatch({ bots: [{ id: "left", state: left }, { id: "right", state: wrongRules }] }),
    /same ruleset/,
  );
  assert.throws(
    () => createBotMatch({
      bots: [{ id: "left", state: left }, { id: "right", state: state({ frame: 100 }) }],
      mode: "paced",
      ppsByBotId: { left: 0, right: 1 },
    }),
    /pps for bot left/,
  );
});

test("GUI projection and prefix-only queue extension preserve controller ownership", () => {
  const left = state();
  const right = state();
  for (const canonical of [left, right]) {
    canonical.board.height = 40;
    canonical.board.visibleHeight = 20;
    canonical.board.bufferHeight = 20;
    canonical.board.cells = canonical.board.cells.padEnd(400, "_");
  }
  const match = createBotMatch({ bots: [{ id: "left", state: left }, { id: "right", state: right }] });
  const gui = botMatchToGuiState(match, "left");
  assert.equal(gui.board.length, 40);
  assert.equal(gui.board[0].length, 10);
  assert.deepEqual(gui.queue, [left.pieces.current, ...left.pieces.known]);
  assert.equal(gui.s2.clock.framesPerLock, 60);

  const extendedQueue = [...gui.queue, "S", "Z"];
  const extended = extendBotMatchQueue(match, "left", extendedQueue);
  assert.deepEqual(
    [extended.bots[0].state.pieces.current, ...extended.bots[0].state.pieces.known],
    extendedQueue,
  );
  assert.notEqual(fullStateKey(extended.bots[0].state), fullStateKey(match.bots[0].state));
  assert.throws(
    () => extendBotMatchQueue(match, "left", ["Z", ...gui.queue.slice(1)]),
    /does not preserve.*known prefix/,
  );
});

test("movement synchronization accepts only the same canonical position at the match clock", () => {
  const left = state();
  const right = state();
  const match = createBotMatch({ bots: [{ id: "left", state: left }, { id: "right", state: right }] });
  const active = structuredClone(match.bots[0].state);
  active.movement = { phase: "spawn-ready", lastWasClear: false };
  active.movement.phase = "active-piece";
  const synchronized = synchronizeBotMatchMovementState(match, "left", {
    expectedStateFingerprint: fullStateKey(match.bots[0].state),
    state: active,
  });
  assert.equal(synchronized.bots[0].state.movement.phase, "active-piece");
  assert.equal(match.bots[0].state.movement, undefined);

  const changedBoard = structuredClone(active);
  changedBoard.board.cells = `Z${changedBoard.board.cells.slice(1)}`;
  assert.throws(
    () => synchronizeBotMatchMovementState(match, "left", {
      expectedStateFingerprint: fullStateKey(match.bots[0].state),
      state: changedBoard,
    }),
    /changed canonical position/,
  );
  assert.throws(
    () => synchronizeBotMatchMovementState(match, "left", {
      expectedStateFingerprint: fullStateKey(active),
      state: active,
    }),
    /stale movement synchronization/,
  );
});

test("multiple movement states synchronize atomically", () => {
  const left = state();
  const right = state();
  const match = createBotMatch({ bots: [{ id: "left", state: left }, { id: "right", state: right }] });
  const activeLeft = structuredClone(left);
  const invalidRight = structuredClone(right);
  activeLeft.movement = { phase: "active-piece", lastWasClear: false };
  invalidRight.movement = { phase: "active-piece", lastWasClear: false };
  invalidRight.pieces.current = "Z";

  assert.throws(
    () => synchronizeBotMatchMovementStates(match, [
      { botId: "left", expectedStateFingerprint: fullStateKey(left), state: activeLeft },
      { botId: "right", expectedStateFingerprint: fullStateKey(right), state: invalidRight },
    ]),
    /changed canonical position for bot right/,
  );
  assert.deepEqual(match.bots.map((bot) => bot.state.movement), [undefined, undefined]);
});
