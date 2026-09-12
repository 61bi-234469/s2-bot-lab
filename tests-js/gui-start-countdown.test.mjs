import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// The shipped start path is executed with a controlled clock, timer and fetch,
// so what is under test is the round a person actually gets rather than a copy
// of its schedule.
const source = readFileSync(new URL('../cc2-gui/app.mjs', import.meta.url), 'utf8');
const markup = readFileSync(new URL('../cc2-gui/index.html', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../cc2-gui/styles.css', import.meta.url), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function extract(context, ...names) {
  for (const name of names) {
    const declaration = new RegExp(
      `^(?:const ${name} = .*?;|(?:async )?function ${name}\\(([\\s\\S]*?)^})$`, 'm');
    const match = source.match(declaration);
    assert.ok(match, `${name} not found in app.mjs`);
    vm.runInContext(match[0], context);
  }
}

/* One start harness: a match series whose round the server answers at once, a
   single pending timer, and a match clock whose running state the test reads
   back. Nothing here reimplements the countdown or the order of the start. */
function harness({ humanSide = 'left', inputMode = false } = {}) {
  const view = {
    sessionId: 'session-1',
    humanSide,
    replayMeta: null,
    metricElapsedMs: 0,
    turnNumber: 0,
    nextStepFrames: 60,
    clock: { logicalFrame: 0 },
    bots: [],
    outcome: { complete: false },
  };
  const context = vm.createContext({
    INPUT_MATCH_ENDPOINT: '/api/input-match',
    matchStartInFlight: null,
    matchRoundFinalization: null,
    matchGeneration: 0,
    matchRunning: false,
    matchAutoplay: true,
    matchClock: { running: false },
    matchPlaybackDeadlineMs: 0,
    matchPlaybackElapsedMs: 0,
    matchComputeRatio: 1,
    matchComputeLimited: false,
    lastRenderedMatchClock: '',
    lastRenderedMatchElapsedMs: 0,
    lastStartedMatchSeed: null,
    inputMatchState: null,
    inputEventSequence: 0,
    startCountdown: null,
    countdownHeldActions: new Set(),
    human: null,
    humanControls: {},
    mode: 'match',
    matchSeries: {
      completed: 0,
      currentSeed: null,
      replayMeta: null,
      config: {
        left: humanSide === null ? 'cc2-s2-f14' : 'human',
        right: 'cc2-s2-f14',
        leftParameters: {},
        rightParameters: {},
        fairComparison: false,
        ttrmCompatible: inputMode,
        seed: 7,
        maxTurns: null,
        firstTo: 1,
        stallLock: { enabled: false, pps: null, penalty: null },
      },
    },
    matchSeriesWinner: () => null,
    createMatchClock: () => ({ running: false }),
    readMatchClock: () => 0,
    setMatchClockRunning: (clock, running) => ({ ...clock, running }),
    renderMatch: () => { context.events.push('paint'); },
    startHumanGame: () => { context.human = { side: humanSide, active: {}, pending: false }; },
    armStallLock: () => { context.events.push('stall-lock'); },
    scheduleHumanMatchBotStep: () => { context.events.push('opponent'); },
    requestInputPump: () => { context.events.push('opponent'); },
    stepMatch: () => { context.events.push('opponent'); },
    inputHumanActive: () => inputMode && humanSide === 'left',
    humanHandling: () => ({ dasFrames: 10, arrFrames: 1, softDropPriority: false, sdf: 6 }),
    pieceRepeat: {
      startShift: (action, options) => { context.startedInputs.push(action); options.move(); },
      startSoftDrop: (action, move) => { context.startedInputs.push(action); move(); },
      end: () => {},
    },
    humanMoveBy: (direction) => { context.events.push(`move:${direction}`); },
    humanMoveToEnd: () => {},
    humanSoftDropToFloor: () => {},
    humanSoftDropStep: () => {},
    humanHardDrop: () => { context.startedInputs.push('HardDrop'); },
    humanRotate: (amount) => { context.startedInputs.push(`rotate:${amount}`); },
    humanHold: () => { context.startedInputs.push('Hold'); },
    handleInputAction: (action) => { context.startedInputs.push(`input:${action}`); },
    actionForCode: (_controls, code) => code,
    selectedHumanSide: () => humanSide,
    requestHumanMatchRestart: () => {},
    matchSeriesActive: () => true,
    resetMatch: async (options = {}) => {
      context.events.push(`reset:${options.restartCurrentGame === true}:${options.rerollRandomSeed === true}`);
      context.matchGeneration += 1;
      context.cancelStartCountdown();
      context.resolveInterruptedStart?.();
    },
    startMatch: async (options) => { context.events.push(`fresh:${options.excludedRandomSeed}`); },
    Element: class Element {},
    structuredClone: (value) => JSON.parse(JSON.stringify(value)),
    performance: { now: () => 0 },
    fetch: async () => ({ ok: true, json: async () => view }),
    elements: {
      'match-status': { textContent: '' },
      'match-step': { disabled: true },
      'match-countdown': { textContent: '', hidden: true },
      'bot-settings-dialog': { open: false },
    },
    setTimeout(callback, delayMs) {
      context.timer = { callback, delayMs };
      return 1;
    },
    clearTimeout() { context.timer = null; },
    timer: null,
    events: [],
    startedInputs: [],
  });
  extract(context, 'START_COUNTDOWN_LABELS', 'START_COUNTDOWN_STEP_MS', 'renderStartCountdown',
    'releaseStartCountdown', 'cancelStartCountdown', 'matchCountingDown', 'advanceStartCountdown',
    'runStartCountdown', 'humanCanAct', 'humanInputEnabled', 'isKeyboardEditingTarget',
    'startHumanAction', 'handleHumanKeyDown', 'handleHumanKeyUp', 'applyCountdownInputs',
    'activateHumanMatchReset', 'startSeriesGame');
  return context;
}

/* Spends one countdown step and reports the match time it just held. */
async function step(app) {
  const delayMs = app.timer.delayMs;
  app.timer.callback();
  await flush();
  return delayMs;
}

test('a 1P round is held by a short countdown and nothing advances until GO', async () => {
  const app = harness();
  const started = app.startSeriesGame();
  await flush();

  assert.equal(app.elements['match-countdown'].textContent, '3');
  assert.equal(app.elements['match-countdown'].hidden, false);
  assert.deepEqual(app.events, ['paint'], 'the board is on screen before the countdown runs');

  let heldMs = 0;
  for (const label of ['2', '1']) {
    heldMs += await step(app);
    assert.equal(app.elements['match-countdown'].textContent, label);
    assert.equal(app.matchClock.running, false, 'the match clock is still stopped');
    assert.deepEqual(app.events, ['paint'], 'the opponent has not been scheduled');
  }

  heldMs += await step(app);
  await started;
  assert.equal(app.elements['match-countdown'].textContent, 'GO');
  assert.equal(app.matchClock.running, true);
  assert.deepEqual(app.events, ['paint', 'stall-lock', 'opponent']);
  assert.ok(heldMs >= 600 && heldMs <= 1200, `a brief countdown, held ${heldMs}ms`);

  // GO belongs to the round that is already running, so clearing it holds
  // nothing up.
  await step(app);
  assert.equal(app.elements['match-countdown'].hidden, true);
  assert.equal(app.startCountdown, null);
});

test('a round with nobody on it starts without a countdown', async () => {
  const app = harness({ humanSide: null });
  await app.startSeriesGame();
  assert.equal(app.elements['match-countdown'].hidden, true);
  assert.equal(app.elements['match-countdown'].textContent, '');
  assert.equal(app.matchClock.running, true);
});

test('the player cannot act immediately while the countdown is holding the round', async () => {
  for (const inputMode of [false, true]) {
    const app = harness({ inputMode });
    const started = app.startSeriesGame();
    await flush();
    assert.equal(app.matchCountingDown(), true);
    assert.equal(app.humanInputEnabled(), false, 'configured keys cannot move the piece before GO');
    if (!inputMode) assert.equal(app.humanCanAct(), false);

    for (let taken = 0; taken < 3; taken += 1) await step(app);
    await started;
    assert.equal(app.matchCountingDown(), false);
    assert.equal(app.humanInputEnabled(), true);
    if (!inputMode) assert.equal(app.humanCanAct(), true);
  }
});

test('keys still held at GO become the first legacy or TTRM input', async () => {
  for (const inputMode of [false, true]) {
    const app = harness({ inputMode });
    const started = app.startSeriesGame();
    await flush();
    const event = (code) => ({ code, ctrlKey: false, metaKey: false, altKey: false,
      repeat: false, target: null, preventDefault() {} });

    app.handleHumanKeyDown(event('MoveLeft'));
    app.handleHumanKeyDown(event('RotateRight'));
    app.handleHumanKeyUp({ code: 'MoveLeft' });
    assert.deepEqual([...app.countdownHeldActions], ['RotateRight'], 'keyup cancels pre-input');
    app.handleHumanKeyDown(event('MoveLeft'));

    for (let taken = 0; taken < 3; taken += 1) await step(app);
    await started;
    assert.deepEqual([...app.countdownHeldActions], []);
    assert.deepEqual(app.startedInputs, inputMode
      ? ['input:RotateRight', 'input:MoveLeft']
      : ['rotate:1', 'MoveLeft']);
    if (!inputMode) assert.ok(app.events.includes('move:-1'));
  }
});

test('an abandoned round is released rather than waiting the countdown out', async () => {
  const app = harness();
  const started = app.startSeriesGame();
  await flush();

  // What RESET does: the generation moves on first, so the released start finds
  // that the arena is no longer its own.
  app.matchGeneration += 1;
  app.cancelStartCountdown();
  await started;

  assert.equal(app.startCountdown, null);
  assert.equal(app.timer, null, 'no countdown step is left pending');
  assert.equal(app.elements['match-countdown'].hidden, true);
  assert.equal(app.matchClock.running, false, 'the abandoned round never started its clock');
  assert.deepEqual(app.events, ['paint']);
});

test('the configured Reset key discards the countdown and starts a fresh match', async () => {
  const app = harness();
  const started = app.startSeriesGame();
  await flush();
  app.matchSeries.currentSeed = 7;
  app.elements['match-random-seed'] = { checked: true };
  app.matchStartInFlight = new Promise((resolve) => { app.resolveInterruptedStart = resolve; });

  await app.activateHumanMatchReset();
  await started;

  assert.equal(app.startCountdown, null);
  assert.equal(app.timer, null);
  assert.equal(app.elements['match-status'].textContent, 'RESTARTING');
  assert.ok(app.events.includes('reset:false:false'), 'the pending series is not preserved');
  assert.ok(app.events.includes('fresh:7'), 'a new random series excludes the discarded seed');
});

test('the countdown readout ships hidden, stays flat, and never takes input', () => {
  assert.match(markup, /<div class="match-countdown" id="match-countdown"[^>]* hidden><\/div>/);
  const rule = styles.match(/\.match-countdown \{[^}]*\}/);
  assert.ok(rule, '.match-countdown is not styled');
  assert.match(rule[0], /pointer-events: none;/);
  assert.match(rule[0], /font-size: clamp\(52px, 9vw, 96px\);/);
  // The sheet's own rule: colour and 1px borders only, nothing that glows or
  // animates.
  assert.doesNotMatch(rule[0], /shadow|gradient|blur|animation/);
  assert.doesNotMatch(source, /element\.animate/);
});
