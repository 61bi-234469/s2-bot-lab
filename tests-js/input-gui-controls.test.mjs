import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createInputExecutionRound } from '../src-js/input-execution-round.mjs';
import { buildExecutedInputTtrm } from '../src-js/replay/bot-match-ttrm-export.mjs';
import { parseTtrm } from '../src-js/replay/ttrm-parser.mjs';
import { buildReplayIR } from '../src-js/replay/ttrm-simulator.mjs';
import {
  INPUT_PUMP_INTERVAL_MS,
  earliestPendingInputFrame,
  nextIdlePumpDueAt,
  selectPumpReservation,
} from '../cc2-gui/input-pump-schedule.mjs';

// Execute the production event/pump functions with a controlled browser clock
// and deferred fetch. No second implementation of their scheduling policy.
const source = readFileSync(new URL('../cc2-gui/app.mjs', import.meta.url), 'utf8');
test('enabling TTRM INPUT caps all admitted bot queues on both sides', () => {
  const types = ['cc2-raw', 'cc2-chouhy', 'cc2-s2-f14', 'cc2-s2-champion'];
  const app = vm.createContext({
    BOT_SIDES: ['left', 'right'], INPUT_BOT_PROFILES: Object.fromEntries(types.map(type => [type, {}])),
    botParameters: Object.fromEntries(['left', 'right'].map(side => [side,
      Object.fromEntries(types.map((type, index) => [type, { queueDepth: index % 2 ? 15 : 28, marker: side }]))])),
    inputModeSelected: () => app.enabled,
  });
  vm.runInContext(source.match(/function clampInputQueueDepths\([\s\S]*?^}/m)[0], app);
  app.enabled = false;
  assert.equal(app.clampInputQueueDepths(), false);
  assert.equal(app.botParameters.left['cc2-raw'].queueDepth, 28);
  app.enabled = true;
  assert.equal(app.clampInputQueueDepths(), true);
  for (const side of app.BOT_SIDES) for (const type of types) {
    assert.equal(app.botParameters[side][type].queueDepth, 15);
    assert.equal(app.botParameters[side][type].marker, side);
  }
  assert.equal(app.clampInputQueueDepths(), false);
});
test('TTRM INPUT greys the bot names it cannot run without hiding an unavailable build', () => {
  const admitted = ['cc2-raw', 'cc2-chouhy', 'cc2-s2-f14', 'cc2-s2-champion'];
  const names = [...admitted, 'cc2-s2-gen017', 's2-simple', 'cc2-s2-missing', 'human'];
  const makeSelect = (values) => ({ options: values.map((value) => ({
    value, disabled: false, title: '', dataset: value === 'cc2-s2-missing'
      ? { unavailable: 'true', reason: 'native build is not installed' } : {},
  })) });
  const elements = {
    'left-bot': makeSelect(names),
    'right-bot': makeSelect(names.filter((value) => value !== 'human')),
  };
  const app = vm.createContext({
    BOT_SIDES: ['left', 'right'], elements, matchRunning: false,
    INPUT_SUPPORTED_TYPES: new Set(['human', ...admitted]),
    inputModeSelected: () => app.enabled, inputModeActive: () => false,
  });
  for (const name of ['inputBotAdmitted', 'syncInputBotOptions']) {
    vm.runInContext(source.match(new RegExp(`^function ${name}\\([\\s\\S]*?^}`, 'm'))[0], app);
  }
  const state = (selectId) => Object.fromEntries(
    elements[selectId].options.map((option) => [option.value, option.disabled]));

  app.enabled = true;
  app.syncInputBotOptions();
  assert.deepEqual(state('left-bot'), { 'cc2-raw': false, 'cc2-chouhy': false, 'cc2-s2-f14': false,
    'cc2-s2-champion': false, 'cc2-s2-gen017': true, 's2-simple': true, 'cc2-s2-missing': true, human: false });
  // The person can only hold the left side, so You is not admitted on the right.
  assert.equal(state('right-bot').human, undefined);
  assert.match(elements['left-bot'].options.find((option) => option.value === 's2-simple').title,
    /TTRM INPUT/);
  assert.equal(elements['left-bot'].options.find((option) => option.value === 'cc2-s2-missing').title,
    'native build is not installed');

  app.enabled = false;
  app.syncInputBotOptions();
  assert.deepEqual(state('left-bot'), { 'cc2-raw': false, 'cc2-chouhy': false, 'cc2-s2-f14': false,
    'cc2-s2-champion': false, 'cc2-s2-gen017': false, 's2-simple': false, 'cc2-s2-missing': true, human: false });
  assert.equal(elements['left-bot'].options.find((option) => option.value === 's2-simple').title, '');
});
test('FT3 automatically schedules game two after saving an Engine-completed input round', async () => {
  let scheduled;
  let starts = 0;
  const app = vm.createContext({ matchRunning: true, matchRoundFinalization: null,
    matchGeneration: 1, matchClock: {}, performance: { now: () => 0 }, matchAutoplay: true,
    matchSeries: { rounds: [], completed: 0, totalTurns: 0, leftWins: 0, rightWins: 0, draws: 0 },
    setMatchClockRunning: () => ({}), cancelHumanMatchBotStep() {}, inputModeActive: () => true,
    cancelInputPump() {}, clearInputEvents() {}, stopHumanPlay() {},
    elements: { 'match-status': {} }, finalizeCurrentRound: async () => ({ status: 'ok' }),
    renderMatchSummary() {}, renderMatchRunButton() {}, renderMatchSaveButton() {},
    matchSeriesWinner: () => null, setMatchSettingsDisabled() {},
    setTimeout: callback => { scheduled = callback; },
    beginSeriesGame: async () => { starts++; }, handleMatchError: error => { throw error; },
  });
  vm.runInContext(source.match(/async function finishSeriesGame\([\s\S]*?^}/m)[0], app);
  await app.finishSeriesGame({ turnNumber: 34, outcome: { complete: true, winnerBotId: 'left', reason: 'topout' } });
  await app.matchRoundFinalization;
  assert.equal(app.matchSeries.completed, 1);
  assert.equal(app.matchSeries.leftWins, 1);
  assert.equal(app.matchRoundFinalization, null);
  scheduled();
  assert.equal(starts, 1);
});
test('arena reset restores the pre-match field including spawn rows', () => {
  const fields = {};
  const elements = new Proxy({}, { get: (_, id) => fields[id] ??= {
    classList: { toggle() {} }, replaceChildren() { this.rows = 0; },
  } });
  const app = vm.createContext({ BOT_SIDES: ['left', 'right'], elements,
    inputModeSelected: () => true, renderClearInfo() {}, renderGarbageGauge() {},
    renderMatchField(field, board, placed, overlay, { rows }) { field.rows = rows; },
  });
  for (const name of ['clearMatchArena', 'renderEmptyMatchFields']) {
    vm.runInContext(source.match(new RegExp(`function ${name}\\([\\s\\S]*?^}`, 'm'))[0], app);
  }
  app.clearMatchArena();
  assert.equal(elements['match-left-field'].rows, 23);
  assert.equal(elements['match-right-field'].rows, 23);
  app.inputModeSelected = () => false;
  app.clearMatchArena();
  assert.equal(elements['match-left-field'].rows, 20);
});
function harness() {
  const context = vm.createContext({
    inputMatchState: { sessionId: 'test', generation: 1, pending: [], heldKeys: new Set(),
      releaseOnResume: false, inFlight: false, inFlightTarget: null, pumpTimer: null,
      pumpDueAt: null, pumpCatchUpStreak: 0, pumpRequested: false },
    inputEventSequence: 0, matchGeneration: 1, matchAutoplay: true, matchRunning: true,
    INPUT_ACTION_KEYS: {
      MoveLeft: 'moveLeft', SoftDrop: 'softDrop', RotateRight: 'rotateCW',
      Hold: 'hold', HardDrop: 'hardDrop',
    },
    INPUT_PUMP_INTERVAL_MS, selectPumpReservation, nextIdlePumpDueAt, earliestPendingInputFrame,
    humanControls: {}, actionForCode: (_controls, code) => code,
    lastMatchView: { clock: { logicalFrame: 0 } }, matchClock: {}, wallMs: 0,
    performance: { now: () => 0 }, readMatchClock: () => context.wallMs,
    synchronizeMatchClock: (_clock, elapsedMs) => ({ elapsedMs }),
    setMatchClockRunning: (clock, running) => ({ ...clock, running }),
    inputModeActive: () => true, inputHumanActive: () => true, mode: 'match', human: null,
    elements: { 'match-step': {}, 'bot-settings-dialog': { open: false } },
    setTimeout: () => 1, clearTimeout: () => {}, INPUT_MATCH_ENDPOINT: '/api/input-match',
    renderMatch: body => { context.lastMatchView = body; }, finishSeriesGame: () => {},
    handleMatchError: error => { throw error; },
    structuredClone,
  });
  const names = ['humanInputEnabled', 'handleHumanKeyUp', 'clearInputEvents', 'currentInputEventFrame', 'enqueueInputEvent', 'handleInputAction',
    'inputTargetFrame', 'inputEventsBefore', 'requestInputPump', 'scheduleIdleInputPump', 'stepInputMatch',
    'recordAcceptedInputEvents', 'queueInputReleases', 'aggregateInputTtrm'];
  for (const name of names) {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
  return context;
}

test('human keys retain held state and fractional input times without frontend repeats', () => {
  const app = harness();
  app.wallMs = 25;
  app.handleInputAction('SoftDrop');
  app.wallMs = 29;
  app.handleInputAction('MoveLeft');
  app.wallMs = 31;
  app.handleInputAction('SoftDrop', 'keyup');
  const events = app.inputMatchState.pending;
  assert.deepEqual(Array.from(events, event => event.type), ['keydown', 'keydown', 'keyup']);
  assert.deepEqual(Array.from(events, event => event.frame), [1, 1, 1]);
  assert.equal(events[0].data.subframe, 0.5);
  assert.ok(events[1].data.subframe > events[0].data.subframe);
  assert.ok(events[2].data.subframe > events[1].data.subframe);
  app.inputMatchState.inFlightTarget = 3;
  app.handleInputAction('MoveLeft', 'keyup');
  assert.equal(events.at(-1).frame, 3);
  assert.equal(events.at(-1).data.subframe, 0);
});

test('releasing a held key in the settings dialog still reaches the Engine', () => {
  const app = harness();
  app.elements['bot-settings-dialog'].open = true;
  assert.equal(app.humanInputEnabled(), false);
  app.handleHumanKeyUp({ code: 'MoveLeft' });
  assert.equal(app.inputMatchState.pending[0].type, 'keyup');
  assert.equal(app.inputMatchState.pending[0].data.key, 'moveLeft');
});

test('autoplay waits for wall time and does not consume a future soft-drop release', () => {
  const app = harness();
  assert.equal(app.inputTargetFrame(false), null);
  app.wallMs = 1000;
  app.lastMatchView.clock.logicalFrame = 60;
  app.inputMatchState.pending.push({ frame: 61 });
  assert.equal(app.inputTargetFrame(false), null);
  app.inputMatchState.pending.unshift({ frame: 60 });
  assert.equal(app.inputTargetFrame(false), 61);
  assert.equal(app.inputTargetFrame(true), 61);
});

function installTimers(app) {
  const timeouts = [];
  app.setTimeout = (fn, ms) => {
    const id = timeouts.length + 1;
    timeouts.push({ id, fn, ms });
    return id;
  };
  app.clearTimeout = (id) => {
    const index = timeouts.findIndex((entry) => entry.id === id);
    if (index >= 0) timeouts.splice(index, 1);
  };
  return timeouts;
}

test('requestInputPump(0) replaces an existing later reservation', () => {
  const app = harness();
  const timeouts = installTimers(app);
  app.requestInputPump(16);
  assert.deepEqual(timeouts.map((entry) => entry.ms), [16]);
  app.requestInputPump(0);
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].ms, 0);
  assert.equal(app.inputMatchState.pumpDueAt, 0);
});

test('a later pump request does not push an earlier reservation back', () => {
  const app = harness();
  const timeouts = installTimers(app);
  app.requestInputPump(0);
  app.requestInputPump(16);
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].ms, 0);
  assert.equal(app.inputMatchState.pumpDueAt, 0);
});

test('in-flight keys wait for the current step instead of overlapping pumps', () => {
  const app = harness();
  const timeouts = installTimers(app);
  app.inputMatchState.inFlight = true;
  app.requestInputPump(0);
  assert.equal(timeouts.length, 0);
  assert.equal(app.inputMatchState.pumpRequested, true);
});

test('idle step completion waits for the next match-clock frame', async () => {
  const app = harness();
  const timeouts = installTimers(app);
  app.wallMs = 20;
  app.fetch = async () => ({ ok: true, json: async () => ({ clock: { logicalFrame: 1 }, outcome: { complete: false } }) });
  await app.stepInputMatch();
  const expected = nextIdlePumpDueAt({ nowMs: 0, elapsedMs: 20, serverFrame: 1 }).dueAtMs;
  assert.equal(timeouts.length, 1);
  assert.ok(Math.abs(timeouts[0].ms - expected) < 1e-9);
  assert.notEqual(timeouts[0].ms, 16);
});

test('a key during an in-flight step schedules an immediate follow-up pump', async () => {
  const app = harness();
  const timeouts = installTimers(app);
  app.wallMs = 20;
  let release;
  app.fetch = () => new Promise((resolve) => { release = resolve; });
  const pending = app.stepInputMatch();
  app.handleInputAction('MoveLeft');
  assert.equal(app.inputMatchState.pumpRequested, true);
  assert.equal(timeouts.length, 0);
  release({ ok: true, json: async () => ({ clock: { logicalFrame: 1 }, outcome: { complete: false } }) });
  await pending;
  assert.equal(timeouts.length, 1);
  assert.equal(timeouts[0].ms, 0);
});

test('idle pumps keep match-clock spacing when each step costs 8ms', async () => {
  const app = harness();
  let now = 0;
  const timeouts = [];
  app.performance = { now: () => now };
  app.readMatchClock = () => now;
  app.setTimeout = (fn, ms) => {
    const id = timeouts.length + 1;
    timeouts.push({ id, fn, due: now + Math.max(0, ms), ms });
    return id;
  };
  app.clearTimeout = (id) => {
    const index = timeouts.findIndex((entry) => entry.id === id);
    if (index >= 0) timeouts.splice(index, 1);
  };
  app.fetch = async (_url, init) => {
    now += 8;
    const body = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        clock: { logicalFrame: body.frame },
        outcome: { complete: false },
      }),
    };
  };

  const starts = [];
  app.scheduleIdleInputPump();
  for (let step = 0; step < 5; step += 1) {
    assert.equal(timeouts.length, 1);
    const next = timeouts.pop();
    now = Math.max(now, next.due);
    starts.push(now);
    app.inputMatchState.pumpTimer = null;
    app.inputMatchState.pumpDueAt = null;
    await app.stepInputMatch();
  }
  const gaps = starts.slice(1).map((value, index) => value - starts[index]);
  for (const gap of gaps) {
    assert.ok(Math.abs(gap - INPUT_PUMP_INTERVAL_MS) < 1e-6, String(gap));
  }
  assert.ok(gaps.every((gap) => gap < 16 + 8));
});

function attachVirtualClock(app, { workMs = 8 } = {}) {
  const clock = { now: 0 };
  const timeouts = [];
  const waits = [];
  const sent = [];
  let nextId = 0;
  app.performance = { now: () => clock.now };
  app.readMatchClock = () => clock.now;
  app.setTimeout = (fn, ms) => {
    const id = ++nextId;
    timeouts.push({ id, fn, due: clock.now + Math.max(0, ms) });
    return id;
  };
  app.clearTimeout = (id) => {
    const index = timeouts.findIndex((entry) => entry.id === id);
    if (index >= 0) timeouts.splice(index, 1);
  };
  app.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const serverFrame = app.lastMatchView.clock.logicalFrame;
    for (const event of body.inputs ?? []) {
      assert.ok(event.frame >= serverFrame, 'stale input');
      assert.ok(event.frame < body.frame, 'input past target');
    }
    sent.push({
      at: clock.now,
      frame: body.frame,
      keys: (body.inputs ?? []).map((event) => `${event.type}:${event.data.key}`),
    });
    const doneAt = clock.now + workMs;
    await waitUntil(doneAt);
    return {
      ok: true,
      json: async () => ({ clock: { logicalFrame: body.frame }, outcome: { complete: false } }),
    };
  };

  function waitUntil(due) {
    if (due <= clock.now) return Promise.resolve();
    return new Promise((resolve) => { waits.push({ due, resolve }); });
  }

  async function flush() {
    await Promise.resolve();
    await Promise.resolve();
  }

  async function advanceTo(target) {
    for (;;) {
      const dueTimers = timeouts.filter((entry) => entry.due <= target);
      const dueWaits = waits.filter((entry) => entry.due <= target);
      if (dueTimers.length === 0 && dueWaits.length === 0) {
        clock.now = target;
        return;
      }
      const nextDue = Math.min(
        ...dueTimers.map((entry) => entry.due),
        ...dueWaits.map((entry) => entry.due),
      );
      clock.now = nextDue;
      for (const wait of waits.filter((entry) => entry.due === nextDue)) {
        waits.splice(waits.indexOf(wait), 1);
        wait.resolve();
      }
      await flush();
      for (const timer of timeouts.filter((entry) => entry.due === nextDue)) {
        timeouts.splice(timeouts.indexOf(timer), 1);
        timer.fn();
      }
      await flush();
    }
  }

  return { sent, advanceTo };
}

async function assertQueuedInputSendsOnFirstProcessableFrame(action, expectedKey) {
  const app = harness();
  const { sent, advanceTo } = attachVirtualClock(app);
  app.scheduleIdleInputPump();
  await advanceTo(5);
  app.handleInputAction('MoveLeft');
  await advanceTo(8);
  app.handleInputAction(action, action === 'MoveLeft' ? 'keyup' : 'keydown');
  await advanceTo(50);
  const follow = sent.find((request) => request.keys.includes(expectedKey));
  assert.ok(follow, `missing ${expectedKey} in ${JSON.stringify(sent)}`);
  assert.ok(Math.abs(follow.at - INPUT_PUMP_INTERVAL_MS) < 1e-6, String(follow.at));
  assert.equal(follow.frame, 2);
}

test('a rotation queued during in-flight is sent on its first processable frame', async () => {
  await assertQueuedInputSendsOnFirstProcessableFrame('RotateRight', 'keydown:rotateCW');
});

test('a keyup queued during in-flight is sent on its first processable frame', async () => {
  await assertQueuedInputSendsOnFirstProcessableFrame('MoveLeft', 'keyup:moveLeft');
});

test('HOLD and hard drop queued during in-flight are sent on their first processable frame', async () => {
  await assertQueuedInputSendsOnFirstProcessableFrame('Hold', 'keydown:hold');
  await assertQueuedInputSendsOnFirstProcessableFrame('HardDrop', 'keydown:hardDrop');
});

test('in-flight capture uses the reserved target and zero subframe when it is ahead of the wall frame', () => {
  const app = harness();
  app.wallMs = 100.2 * 1000 / 60;
  app.inputMatchState.inFlightTarget = 101;
  app.handleInputAction('MoveLeft');
  const event = app.inputMatchState.pending[0];
  assert.equal(event.frame, 101);
  assert.equal(event.data.subframe, 0);
});

test('key capture while a step is in flight reserves its exclusive frame boundary', async () => {
  const app = harness();
  let release;
  app.wallMs = 20;
  app.fetch = () => new Promise(resolve => { release = resolve; });
  const pending = app.stepInputMatch();
  assert.equal(app.inputMatchState.inFlightTarget, 1);
  const capture = app.currentInputEventFrame();
  app.enqueueInputEvent(capture, 'keydown', 'hardDrop');
  release({ ok: true, json: async () => ({ clock: { logicalFrame: 1 }, outcome: { complete: false } }) });
  await pending;
  assert.equal(app.inputMatchState.pending[0].frame, 1);
  assert.ok(app.inputMatchState.pending[0].frame >= app.lastMatchView.clock.logicalFrame);
});

test('pause during unacknowledged soft drop releases it after acknowledgement and rejects paused keys', () => {
  const app = harness();
  app.inputMatchState.inFlight = true;
  app.clearInputEvents({ releaseHeld: true });
  app.matchAutoplay = false;
  assert.equal(app.humanInputEnabled(), false);
  app.recordAcceptedInputEvents(app.inputMatchState, [{ type: 'keydown', data: { key: 'softDrop' } }], { clock: { logicalFrame: 10 } });
  const release = app.inputMatchState.pending[0];
  assert.equal(release.type, 'keyup');
  assert.equal(release.data.key, 'softDrop');
  assert.equal(release.frame, 10);
});

test('RESUME while manual STEP is pending keeps the clock running after response', async () => {
  const app = harness();
  app.matchAutoplay = false;
  let release;
  app.fetch = () => new Promise(resolve => { release = resolve; });
  const pending = app.stepInputMatch({ manual: true });
  app.matchAutoplay = true;
  release({ ok: true, json: async () => ({ metricElapsedMs: 1000 / 60, clock: { logicalFrame: 1 }, outcome: {} }) });
  await pending;
  assert.equal(app.matchClock.running, true);
});

function paintHarness() {
  const painted = [];
  const raf = [];
  const context = vm.createContext({
    lastMatchView: null, matchPaintView: null, matchPaintRequested: false,
    matchGeneration: 1, matchComputeLimited: false, matchRoundStatus: "",
    human: null, matchClock: {},
    inputModeActive: () => true,
    performance: { now: () => 0 },
    synchronizeMatchClock: (_clock, elapsedMs) => ({ elapsedMs }),
    document: { hidden: false },
    requestAnimationFrame: (fn) => { raf.push(fn); return raf.length; },
    paintMatchView: (view) => { painted.push(view); },
  });
  for (const name of ['acceptMatchView', 'cancelMatchPaint', 'flushMatchPaint', 'requestMatchPaint', 'renderMatch']) {
    const match = source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?^}`, 'm'));
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
  context.painted = painted;
  context.raf = raf;
  return context;
}

test('renderMatch accepts the confirmed view before the paint callback', () => {
  const app = paintHarness();
  const first = { turnNumber: 1, clock: { logicalFrame: 4 }, metricElapsedMs: 80 };
  const second = { turnNumber: 1, clock: { logicalFrame: 5 }, metricElapsedMs: 100 };
  app.renderMatch(first);
  assert.equal(app.lastMatchView, first);
  assert.equal(app.painted.length, 0);
  assert.equal(app.raf.length, 1);
  app.renderMatch(second);
  assert.equal(app.lastMatchView, second);
  assert.equal(app.painted.length, 0);
  assert.equal(app.raf.length, 1);
  app.raf[0]();
  assert.deepEqual(app.painted, [second]);
});

test('a hidden document paints immediately and RESET drops a pending paint', () => {
  const app = paintHarness();
  app.document.hidden = true;
  const view = { turnNumber: 2, clock: { logicalFrame: 8 } };
  app.renderMatch(view);
  assert.equal(app.lastMatchView, view);
  assert.deepEqual(app.painted, [view]);
  app.document.hidden = false;
  app.painted.length = 0;
  app.renderMatch({ turnNumber: 2, clock: { logicalFrame: 9 } });
  app.cancelMatchPaint();
  app.matchGeneration += 1;
  if (app.raf[0]) app.raf[0]();
  assert.equal(app.painted.length, 0);
});

test('GUI FT export retains both completed input rounds and replays their original events', () => {
  const app = harness();
  const records = [42, 43].map(seed => {
    const round = createInputExecutionRound({ seed });
    while (round.status === 'active' && round.frame < 40) round.tick({ left: ['keydown', 'keyup'].map(type => ({
      frame: round.frame, type, data: { key: 'hardDrop', subframe: 0 },
    })) });
    return buildExecutedInputTtrm(round);
  });
  const file = JSON.parse(JSON.stringify(app.aggregateInputTtrm(records)));
  assert.equal(file.replay.rounds.length, 2);
  assert.deepEqual(file.replay.leaderboard.map(player => player.wins), [0, 2]);
  for (const player of file.replay.leaderboard) {
    const played = file.replay.rounds.flatMap(round => round.filter(p => p.id === player.id));
    const lifetime = played.reduce((sum, p) => sum + p.lifetime, 0);
    for (const key of ['apm', 'pps', 'vsscore']) assert.equal(player.stats[key],
      played.reduce((sum, p) => sum + p.stats[key] * p.lifetime, 0) / lifetime);
  }
  for (const [index, record] of records.entries()) assert.deepEqual(file.replay.rounds[index], JSON.parse(record.text).replay.rounds[0]);
  assert.equal(file.meta.releaseEvidence, false);
  assert.ok(buildReplayIR(parseTtrm(JSON.stringify(file))).rounds.every(round => round.status === 'ok'));
});
