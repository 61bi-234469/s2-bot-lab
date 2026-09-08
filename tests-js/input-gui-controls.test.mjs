import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createInputExecutionRound } from '../src-js/input-execution-round.mjs';
import { buildExecutedInputTtrm } from '../src-js/replay/bot-match-ttrm-export.mjs';
import { parseTtrm } from '../src-js/replay/ttrm-parser.mjs';
import { buildReplayIR } from '../src-js/replay/ttrm-simulator.mjs';

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
      releaseOnResume: false, inFlight: false, inFlightTarget: null, pumpTimer: null },
    inputEventSequence: 0, matchGeneration: 1, matchAutoplay: true, matchRunning: true,
    INPUT_ACTION_KEYS: { MoveLeft: 'moveLeft', SoftDrop: 'softDrop' },
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
    'inputTargetFrame', 'inputEventsBefore', 'requestInputPump', 'stepInputMatch', 'recordAcceptedInputEvents', 'queueInputReleases', 'aggregateInputTtrm'];
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
