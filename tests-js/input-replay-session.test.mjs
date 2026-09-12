import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputReplaySession, simulatePlayerRound } from '../src-js/replay/ttrm-simulator.mjs';
import { inputExecutionOptions, INPUT_EXECUTION_PROFILE } from '../src-js/replay/engine-config.mjs';
import { evaluatePlacement } from '../src-js/triangle/placement-adapter.mjs';
import attackFixture from '../fixtures/input-execution/two-attacks.json' with { type: 'json' };

const key = (frame, name, type = 'keydown') => ({ frame, type, data: { key: name, subframe: 0 } });
const receive = (frame, amount = 4, iid = 1) => ({ frame, type: 'ige', data: { type: 'interaction', data: { type: 'garbage', amt: amount, size: 1, iid, gameid: 2, ackiid: 0 } } });
const confirm = (frame, iid = 1) => ({ frame, type: 'ige', data: { type: 'interaction_confirm', data: { type: 'garbage', iid, gameid: 2, frame: Math.max(0, frame - 2) } } });
function source() { return { id: 'fixture', replay: { frames: 0, events: [], options: inputExecutionOptions({ seed: 42 }), results: { stats: { garbage: { sent: 0 } } } } }; }
const session = () => createInputReplaySession(source(), { canonicalProfile: INPUT_EXECUTION_PROFILE.id });

test('display chunks survive partial double cancellation and stay separate from bot input', () => {
  const run = session();
  for (let frame = 0; frame <= 28; frame++) {
    const name = attackFixture.inputs[frame];
    const events = [key(frame, name), key(frame, name, 'keyup')];
    if (frame === 28) events.unshift(receive(frame, 4, 1), receive(frame, 2, 2), confirm(frame, 1), confirm(frame, 2));
    run.tick(events);
  }
  const view = run.refereeView();
  assert.equal(view.stats.garbage.attack - view.stats.garbage.sent, 1);
  assert.equal(view.cancelledRows, 2, 'opener cancels two incoming rows with one attack');
  assert.deepEqual(view.pendingChunks, [{ amount: 2, ready: false }, { amount: 2, ready: false }]);
  assert.equal(view.pendingRows, 4);
  const before = run.publicState();
  assert.equal(before.decision.incoming.pendingRows, 4);
  view.pendingChunks[0].amount = 99;
  assert.deepEqual(run.publicState(), before);
  assert.deepEqual(run.refereeView().pendingChunks, [{ amount: 2, ready: false }, { amount: 2, ready: false }]);
  while (run.frame < 49) run.tick([]);
  assert.deepEqual(run.refereeView().pendingChunks, [{ amount: 2, ready: true }, { amount: 2, ready: true }]);
  run.tick([key(49, 'hardDrop')]);
  assert.deepEqual(run.refereeView().pendingChunks, []);
  assert.equal(run.refereeView().pendingRows, 0);
  const tanks = run.finish().garbageEvents.filter(event => event.kind === 'tank');
  assert.deepEqual(tanks.map(event => [event.iid, event.amount]), [[1, 2], [2, 2]]);
});

test('shared production runtime distinguishes natural-lock eligibility from hard drop at the same lock frame', () => {
  for (const lockSource of ['natural', 'hard-drop']) {
    const run = session();
    while (run.lockCount === 0 && run.frame < 35) {
      const frame = run.frame;
      const events = frame === 0 ? [receive(frame)] : frame === 11 ? [confirm(frame)] : [];
      if (frame === 0 && lockSource === 'natural') events.push(key(frame, 'softDrop'));
      if (frame === 31 && lockSource === 'hard-drop') events.push(key(frame, 'hardDrop'));
      run.tick(events);
    }
    const result = run.finish();
    assert.equal(result.locks[0].frame, 31);
    assert.equal(result.terminal.frame, lockSource === 'natural' ? 31 : 32);
    assert.equal(result.garbageEvents.filter(event => event.kind === 'tank').reduce((sum, event) => sum + event.amount, 0), lockSource === 'natural' ? 0 : 4);
    assert.deepEqual(result.canonicalLockVerification, { comparedLocks: 1, scope: 'lock-and-garbage-queue', matched: true });
    assert.throws(() => run.tick([]), /not active/);
  }
  assert.throws(() => evaluatePlacement(null, null, undefined, null, { lockSource: 'unknown' }), /lock source/);
});

test('consumed input is append-only and replays identically across HOLD and multiple same-frame locks', () => {
  const run = session();
  const inputs = [key(0, 'hold'), key(0, 'hold', 'keyup'), key(0, 'hardDrop'), key(0, 'hardDrop', 'keyup'), key(0, 'hold'), key(0, 'hold', 'keyup'), key(0, 'hardDrop')];
  run.tick(inputs);
  const record = run.executedEvents();
  assert.deepEqual(record, inputs);
  record[0].data.key = 'moveRight';
  const observed = run.finish();
  assert.equal(observed.canonicalLockVerification.comparedLocks, 2);
  observed.locks.length = 0;
  assert.equal(run.finish().locks.length, 2, 'final snapshot has no mutable aliases');
  const replay = source();
  replay.replay.events = run.executedEvents();
  replay.replay.frames = run.frame;
  replay.replay.results.stats = run.finish().recordedStats;
  const repeated = simulatePlayerRound(replay, { canonicalProfile: INPUT_EXECUTION_PROFILE.id });
  assert.deepEqual(repeated.locks, run.finish().locks);
  assert.equal(repeated.verification.matched, true);
});

test('out-of-frame input invalidates the canonical session without logging unconsumed input', () => {
  const run = session();
  assert.throws(() => run.tick([key(1, 'rotateCW')]), /after replay.frames/);
  assert.equal(run.status, 'invalid');
  assert.deepEqual(run.executedEvents(), []);
  assert.throws(() => run.finish(), /cannot be finalized/);
  assert.throws(() => run.tick([]), /not active/);
});

test('received statistic counts remaining rows once at confirmation, not unconfirmed arrival', () => {
  const run = session();
  run.tick([receive(0, 4), receive(0, 2, 2)]);
  run.tick([confirm(1)]);
  run.tick([confirm(2)]);
  const result = run.finish();
  assert.equal(result.observedStats.garbage.receive, 6);
  assert.equal(result.recordedStats.garbage.received, 4);
  assert.equal(result.garbageEvents.find(event => event.kind === 'confirm').senderFrame, 0);
});

test('qualified isolated 90 and 180 rotation ticks execute and self-replay through canonical locks', () => {
  for (const name of ['rotateCW', 'rotateCCW', 'rotate180']) {
    const run = session();
    run.tick([key(0, name), key(0, name, 'keyup')]);
    run.tick([key(1, 'hardDrop')]);
    const result = run.finish();
    assert.equal(result.canonicalLockVerification.comparedLocks, 1);
    assert.equal(result.locks[0].rotation, { rotateCW: 1, rotateCCW: 3, rotate180: 2 }[name]);
    const replay = source();
    replay.replay.events = run.executedEvents();
    replay.replay.frames = run.frame;
    replay.replay.results.stats = result.recordedStats;
    assert.deepEqual(simulatePlayerRound(replay, { canonicalProfile: INPUT_EXECUTION_PROFILE.id }).locks, result.locks);
  }
});

test('floor I 180 kick retains its actual nonzero kick offset through the canonical lock', () => {
  const replay = source();
  replay.replay.options = inputExecutionOptions({ seed: 11 });
  const run = createInputReplaySession(replay, { canonicalProfile: INPUT_EXECUTION_PROFILE.id });
  run.tick([key(0, 'softDrop')]);
  run.tick([key(1, 'softDrop', 'keyup')]);
  run.tick([key(2, 'rotate180'), key(2, 'rotate180', 'keyup')]);
  run.tick([key(3, 'hardDrop')]);
  const result = run.finish();
  assert.equal(result.locks[0].piece, 1);
  assert.deepEqual(result.locks[0].rotationEvidence, {
    lastInputWasRotation: true, kickIndex: 0, kickId: '02', kickOffset: [0, 1],
  });
  assert.equal(result.canonicalLockVerification.comparedLocks, 1);
});

test('stall penalty floor is collision-only and leaves line, attack, B2B and REN calculation unchanged', () => {
  const execute = (withPenalty) => {
    const run = session();
    if (withPenalty) assert.deepEqual(run.applyStallPenaltyLine(), { rows: 1, toppedOut: false });
    for (let frame = 0; frame <= 28; frame++) {
      const name = attackFixture.inputs[frame];
      run.tick([key(frame, name), key(frame, name, 'keyup')]);
    }
    return run;
  };
  const control = execute(false);
  const penalized = execute(true);
  const selectClear = lock => lock.clear;
  assert.deepEqual(penalized.finish().locks.map(selectClear), control.finish().locks.map(selectClear));
  assert.deepEqual(penalized.refereeView().stats.garbage, control.refereeView().stats.garbage);
  assert.equal(penalized.refereeView().board[0].join(''), 'PPPPPPPPPP');
  assert.equal(penalized.finish().canonicalLockVerification, null,
    'an externally modified round is deliberately outside .ttrm conformance');
});

test('stall penalty floor can be removed without moving the logical stack relative to it', () => {
  const run = session();
  const initial = run.refereeView().activeCells;
  run.applyStallPenaltyLine();
  assert.deepEqual(run.refereeView().activeCells, initial.map(([x, y]) => [x, y + 1]));
  assert.deepEqual(run.removeStallPenaltyLine(), { rows: 0 });
  assert.deepEqual(run.refereeView().activeCells, initial);
  assert.ok(run.refereeView().board[0].every(cell => cell === null));
});

test('STALL disables garbage conformance hooks after external rows change generator progress', () => {
  const run = session();
  run.applyStallPenaltyLine();
  run.tick([receive(0, 4)]);
  run.tick([confirm(1)]);
  while (run.frame < 49) run.tick([]);
  run.tick([key(49, 'hardDrop')]);
  assert.equal(run.refereeView().pendingRows, 0, 'the first packet tanks and advances garbage RNG');
  assert.doesNotThrow(() => run.tick([receive(50, 2, 2)]));
  assert.equal(run.refereeView().pendingRows, 2);
});

test('a STALL rise above row 20 keeps a legal active piece playable until real spawn blockout', () => {
  const replay = source();
  replay.replay.options = inputExecutionOptions({ seed: 11 }); // I first
  const run = createInputReplaySession(replay, { canonicalProfile: INPUT_EXECUTION_PROFILE.id });
  run.tick([]);
  for (let row = 0; row < 17; row++) run.applyStallPenaltyLine();
  const tap = name => {
    const frame = run.frame;
    run.tick([key(frame, name), key(frame, name, 'keyup')]);
  };
  tap('rotateCW');
  for (let move = 0; move < 4; move++) tap('moveRight');
  tap('hardDrop');
  assert.equal(run.toppedOut, false);
  assert.ok(run.refereeView().board.slice(20).some(row => row.includes('I')));
  const before = run.refereeView().activeCells;
  assert.deepEqual(run.applyStallPenaltyLine(), { rows: 18, toppedOut: false });
  assert.deepEqual(run.refereeView().activeCells, before.map(([x, y]) => [x, y + 1]));
  tap('moveLeft');
  assert.equal(run.toppedOut, false, 'the player can continue moving above the skyline');
  for (let lock = 0; lock < 12 && !run.toppedOut; lock++) tap('hardDrop');
  assert.equal(run.toppedOut, true, 'Engine still ends the round when the next spawn is blocked');
});

test('a STALL floor alone does not top out at the skyline but cannot exhaust the full buffer', () => {
  const run = session();
  run.tick([]);
  for (let rows = 1; rows < 40; rows++) {
    assert.deepEqual(run.applyStallPenaltyLine(), { rows, toppedOut: false });
  }
  assert.deepEqual(run.applyStallPenaltyLine(), { rows: 40, toppedOut: true });
});
