import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { projectStallPenaltyRows } from '../cc2-gui/human-play.mjs';
import { stallPenaltyProjectionTopsOut } from '../src-js/stall-penalty-topout.mjs';

// The production stall penalty functions are executed with a controlled match
// clock and timer, so the rule under test is the shipped one rather than a copy
// of it.
const source = readFileSync(new URL('../cc2-gui/app.mjs', import.meta.url), 'utf8');
const markup = readFileSync(new URL('../cc2-gui/index.html', import.meta.url), 'utf8');
const FRAME_DURATION_MS = 1000 / 60;
const POLL_MS = 100;

function extract(context, ...names) {
  for (const name of names) {
    const match = source.match(new RegExp(`^(?:async )?function ${name}\\(([\\s\\S]*?)^}`, 'm'));
    assert.ok(match, `${name} not found in app.mjs`);
    vm.runInContext(match[0], context);
  }
}

/* One stall-penalty harness: a match clock whose reading and running state the
   test owns, a single pending timer, and a human turn on a board where every
   spawn succeeds. It defaults to the shipped penalty, so a test that depends on
   the forced lock has to name it. Nothing here reimplements the deadline
   policy. */
function harness({ pps = 2, enabled = true, penalty = 'penalty-line', inputMode = false } = {}) {
  const context = vm.createContext({
    FRAME_DURATION_MS,
    STALL_LOCK_POLL_MS: POLL_MS,
    stallLockTimer: null,
    matchRunning: true,
    matchAutoplay: true,
    // The start countdown holds a turn the same way a pause does, so its own
    // state is real here rather than stubbed out.
    startCountdown: null,
    matchSeries: { config: { stallLock: { enabled, pps, penalty } } },
    matchClock: { running: true },
    inputMatchState: inputMode ? {} : null,
    inputHumanActive: () => inputMode,
    placementGeometry: {},
    humanControls: {},
    humanHandling: () => ({ dcdFrames: 0 }),
    pieceRepeat: { activateDasCut() {}, cutDas() {}, endAll() { context.endAllCalls += 1; } },
    requestHumanRender() {},
    spawnPlacement: (_geometry, _board, piece, usedHold = false) => ({ piece, usedHold, spawned: true }),
    stallLockPlacement: (_geometry, _board, placement) => ({ ...placement, forced: true }),
    projectStallPenaltyRows,
    stallPenaltyProjectionTopsOut,
    isPlaceable: () => true,
    handleMatchError(error) { context.errors.push(error.message); },
    performance: { now: () => 0 },
    // The clock is the only time source the deadline may read.
    readMatchClock: () => context.clockMs,
    submitHumanLock(placement) { context.submitted.push(placement); },
    submitHumanPenaltyTopOut() { context.penaltyTopOuts += 1; },
    setTimeout(callback, delayMs) {
      context.timer = { callback, delayMs };
      return 1;
    },
    clearTimeout() { context.timer = null; },
    clockMs: 0,
    timer: null,
    submitted: [],
    penaltyTopOuts: 0,
    errors: [],
    endAllCalls: 0,
    human: {
      side: 'left',
      board: [],
      queue: ['T', 'I', 'O'],
      hold: null,
      active: null,
      holdUsed: false,
      pending: false,
      turnStartedAtMs: 0,
      refereeBoard: Array.from({ length: 40 }, () => Array(10).fill(null)),
      stallPenaltyRows: 0,
      nonPenaltyLocks: 0,
    },
  });
  extract(context, 'matchCountingDown', 'humanCanAct', 'stallLockFrames', 'stallLockDueAtMs',
    'cancelStallLock', 'armStallLock', 'applyStallLock', 'spawnHumanPiece', 'humanHold',
    'adoptHumanView');
  return context;
}

test('a turn starts the stall penalty budget and HOLD does not extend it', () => {
  const app = harness({ pps: 1 });
  app.clockMs = 1_000;
  app.spawnHumanPiece();
  assert.equal(app.human.turnStartedAtMs, 1_000);
  assert.equal(app.stallLockDueAtMs(60), 1_000 + 60 * FRAME_DURATION_MS);

  // Half the budget later, HOLD replaces the piece. The deadline is unchanged:
  // the budget belongs to the turn, not to the piece on screen.
  app.clockMs = 1_000 + 30 * FRAME_DURATION_MS;
  app.humanHold();
  assert.equal(app.human.holdUsed, true);
  assert.equal(app.human.active.piece, 'I');
  assert.equal(app.human.turnStartedAtMs, 1_000);
  assert.equal(app.stallLockDueAtMs(60), 1_000 + 60 * FRAME_DURATION_MS);
});

test('the displayed defaults are the penalty line and 2 PPS', () => {
  assert.match(markup, /id="match-stall-lock-pps"[^>]*value="2"/);
  assert.doesNotMatch(markup, /match-stall-lock-frames/);
  assert.match(markup, /両方の実行方式の1P/);
  assert.doesNotMatch(markup, /TTRM INPUT では使いません/);
  /* Two penalties share the group, so the select lands on whichever option is
     listed first. The shipped default is the penalty line, which keeps the
     piece with the player instead of taking the turn away. */
  const select = markup.slice(markup.indexOf('<select id="match-stall-lock-penalty"'));
  const body = select.slice(0, select.indexOf('</select>'));
  assert.deepEqual([...body.matchAll(/<option value="([a-z-]+)"/g)].map((match) => match[1]),
    ['penalty-line', 'forced-lock']);
  assert.doesNotMatch(body, /\sselected/, 'the first option is the default');
  const app = harness();
  app.spawnHumanPiece();
  assert.equal(app.stallLockFrames(), 30);
  assert.equal(app.timer.delayMs, 30 * FRAME_DURATION_MS);
});

test('the stall penalty deadline is spent on the match clock, not on wall time', () => {
  const app = harness({ pps: 1, penalty: 'forced-lock' });
  app.spawnHumanPiece();
  assert.equal(app.timer.delayMs, 60 * FRAME_DURATION_MS);

  // Woken with the clock only part way through the budget: re-arm, never lock.
  app.clockMs = 30 * FRAME_DURATION_MS;
  app.timer.callback();
  assert.deepEqual(app.submitted, []);
  assert.equal(app.timer.delayMs, 30 * FRAME_DURATION_MS);

  app.clockMs = 60 * FRAME_DURATION_MS;
  app.timer.callback();
  assert.equal(app.submitted.length, 1);
  assert.deepEqual(app.submitted[0], { piece: 'T', usedHold: false, spawned: true, forced: true });
  assert.equal(app.endAllCalls, 0, 'held inputs survive into the next spawned piece');
});

test('the line penalty rises without locking and rearms from the penalty time', () => {
  const app = harness({ penalty: 'penalty-line' });
  app.spawnHumanPiece();
  app.human.active.y = 20;
  app.clockMs = 30 * FRAME_DURATION_MS;
  app.timer.callback();
  assert.equal(app.human.stallPenaltyRows, 1);
  assert.deepEqual(app.human.board[0], Array(10).fill('P'));
  assert.equal(app.human.active.y, 21);
  assert.deepEqual(app.submitted, []);
  assert.equal(app.human.turnStartedAtMs, 30 * FRAME_DURATION_MS);
  assert.equal(app.timer.delayMs, 30 * FRAME_DURATION_MS);
});

test('a line penalty crossing the ceiling reports a match top-out', () => {
  const app = harness({ penalty: 'penalty-line' });
  app.human.refereeBoard[19][4] = 'T';
  app.spawnHumanPiece();
  app.clockMs = 30 * FRAME_DURATION_MS;
  app.timer.callback();
  assert.equal(app.human.stallPenaltyRows, 1);
  assert.equal(app.human.pending, true);
  assert.equal(app.penaltyTopOuts, 1);
  assert.equal(app.stallLockTimer, null);
  assert.deepEqual(app.errors, []);
});

test('five ordinary locks remove one penalty row without changing referee state', () => {
  const app = harness({ penalty: 'penalty-line' });
  app.human.stallPenaltyRows = 2;
  app.human.nonPenaltyLocks = 4;
  const refereeBoard = Array.from({ length: 40 }, () => Array(10).fill(null));
  refereeBoard[0][0] = 'J';
  app.adoptHumanView({
    bots: [{ id: 'left', board: refereeBoard, current: 'I', next: ['O'], hold: null }],
    outcome: { complete: true },
  });
  assert.equal(app.human.nonPenaltyLocks, 0);
  assert.equal(app.human.stallPenaltyRows, 1);
  assert.deepEqual(app.human.board[0], Array(10).fill('P'));
  assert.equal(app.human.board[1][0], 'J');
  assert.equal(app.submitted.length, 0);
});

test('a penalty top-out keeps the projected penalty rows on the terminal field', () => {
  const refereeBoard = Array.from({ length: 40 }, () => Array(10).fill(null));
  refereeBoard[19][4] = 'T';
  const projectedBoard = projectStallPenaltyRows(refereeBoard, 1);
  const rendered = [];
  const context = vm.createContext({
    human: { side: 'left', board: projectedBoard, stallPenaltyRows: 1 },
    cancelStallLock() {},
    pieceRepeat: { endAll() {} },
    elements: {
      'match-left-field': {},
      'match-left-hold': {},
      'match-left-next': {},
    },
    renderMatchField(_element, board, lastPlaced) { rendered.push({ board, lastPlaced }); },
    renderMini() {},
    renderNextList() {},
  });
  extract(context, 'stopHumanPlay');
  context.stopHumanPlay({ bots: [{
    id: 'left', board: refereeBoard, lastPlaced: [[4, 19]], hold: null, next: [],
  }] }, { preserveHumanBoard: true });

  assert.equal(context.human, null);
  assert.deepEqual(rendered[0].board[0], Array(10).fill('P'));
  assert.deepEqual(rendered[0].board[20][4], 'T');
  assert.equal(rendered[0].lastPlaced.length, 0);
  assert.ok(source.includes(
    'const preservePenaltyBoard = view.outcome.reason === "top-out" &&',
  ));
  assert.match(source, /if \(preservePenaltyBoard\) flushMatchPaint\(\);\s+stopHumanPlay\(view, \{ preserveHumanBoard: preservePenaltyBoard \}\);/);
});

test('a stopped match clock polls instead of spending the stall penalty budget', () => {
  const app = harness({ frames: 60 });
  app.matchClock.running = false;
  app.spawnHumanPiece();
  assert.equal(app.timer.delayMs, POLL_MS);
  app.timer.callback();
  assert.deepEqual(app.submitted, []);
  assert.equal(app.timer.delayMs, POLL_MS);
});

test('the stall penalty arms nothing while it is off or the player cannot act', () => {
  const off = harness({ enabled: false });
  off.spawnHumanPiece();
  assert.equal(off.timer, null);
  assert.equal(off.stallLockFrames(), null);

  const pending = harness();
  pending.spawnHumanPiece();
  pending.human.pending = true;
  pending.clockMs = 60 * FRAME_DURATION_MS;
  pending.timer.callback();
  assert.deepEqual(pending.submitted, []);
  assert.equal(pending.stallLockTimer, null);
});

test('input STALL uses the Engine frame authority instead of a browser timer', () => {
  const app = harness({ inputMode: true });
  app.armStallLock();
  assert.equal(app.timer, null);
  assert.equal(app.stallLockTimer, null);
});
