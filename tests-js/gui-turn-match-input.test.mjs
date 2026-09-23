import test from 'node:test';
import assert from 'node:assert/strict';
import { Tetromino } from '@haelp/teto/engine';
import { createGuiInputMatchHandlers } from '../src-js/gui-input-match.mjs';
import { createInputExecutionRound } from '../src-js/input-execution-round.mjs';
import { resolveInputJob } from '../src-js/input-public-job.mjs';
import { canonicalPlacementToGuiMove } from '../cc2-gui/analysis-proposal.mjs';
import { inputExecutionNaturalGravity, inputExecutionOptions } from '../src-js/replay/engine-config.mjs';
import { TURN_MATCH_ID } from '../src-js/gui-turn-match.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const config = { left: 'human', right: 'cc2-s2-f14', seed: 42, maxTurns: null };
const tap = (frame, key) => ['keydown', 'keyup'].map(type => ({ frame, type, data: { key, subframe: 0 } }));

/* The same straight-drop target the input GUI suite uses: the bot's placement
   is not what these tests are about, only when it is allowed to take it. */
function spawnMove(state) {
  const symbol = state.queue[0];
  const piece = new Tetromino({ symbol: symbol.toLowerCase(), initialRotation: 0, boardHeight: 20, boardWidth: 10 });
  piece.x = 3;
  piece.y = 10;
  piece.y -= Math.min(...piece.absoluteBlocks.map(([, y]) => y));
  while (piece.absoluteBlocks.some(([x, y]) => state.board[y]?.[x] != null)) piece.y++;
  return canonicalPlacementToGuiMove({ piece: symbol, rotation: 'spawn', x: 3,
    y: piece.y - (symbol === 'I' ? 3 : symbol === 'O' ? 1 : 2), usedHold: false,
    rotationEvidence: { lastInputWasRotation: false, kickIndex: null, kickId: null, kickOffset: null } });
}

function planningHandlers(onPropose = () => {}) {
  return createGuiInputMatchHandlers({ now: () => 0, runtime: {
    propose: async (request) => {
      onPropose(request);
      return { moves: [spawnMove(request.state)] };
    },
    resolveInput: async payload => resolveInputJob(payload),
    closeSessions: async () => {},
  } });
}

async function startTurnRound(handlers, order, extra = {}) {
  const start = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: {
    ...config, turnMatch: { enabled: true, order }, ...extra,
  } });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.deepEqual(start.body.turnMatch, { id: TURN_MATCH_ID, enabled: true, order, replayDisabled: true });
  assert.equal(start.body.pacing.authority, 'turn-input');
  assert.deepEqual(start.body.pacing.declaredPpsByBotId, { left: null, right: null });
  return start.body;
}

/* One step per frame, flushing the worker microtasks the scheduler depends on,
   so a bot released mid-run can plan and lock inside the same run. */
async function run(handlers, sessionId, from, to, inputsByFrame = {}) {
  let view = null;
  for (let frame = from; frame <= to; frame += 1) {
    const result = await handlers.handle({ method: 'POST', path: '/api/input-match/step', body: {
      sessionId, frame, inputs: inputsByFrame[frame - 1] ?? [],
    } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    view = result.body;
    await flush();
  }
  return view;
}

const turns = view => Object.fromEntries(view.bots.map(bot => [bot.id, bot.stats.turns]));

test('an input round can switch natural gravity off and then only a hard drop locks', () => {
  const observed = inputExecutionOptions({ seed: 1 });
  const still = inputExecutionOptions({ seed: 1, naturalGravity: false });
  assert.equal(inputExecutionNaturalGravity(observed), true);
  assert.equal(inputExecutionNaturalGravity(still), false);
  assert.equal(still.g, 0);
  assert.equal(still.gincrease, 0);
  // Every other rule keeps its observed value, so a gravity-off round differs
  // from the canonical profile in exactly the two gravity keys.
  for (const key of Object.keys(observed)) {
    if (['g', 'gincrease'].includes(key)) continue;
    assert.deepEqual(still[key], observed[key], key);
  }
  assert.throws(() => inputExecutionOptions({ seed: 1, naturalGravity: 'off' }), /natural gravity must be boolean/);

  // The referee round itself: a piece soft dropped to the floor stays there.
  const round = createInputExecutionRound({ seed: 1506, naturalGravity: false });
  assert.equal(round.naturalGravity, false);
  for (let frame = 0; frame < 400; frame += 1) {
    round.tick(frame === 10 ? { left: [{ frame, type: 'keydown', data: { key: 'softDrop', subframe: 0 } }] }
      : frame === 11 ? { left: [{ frame, type: 'keyup', data: { key: 'softDrop', subframe: 0 } }] } : {});
  }
  assert.equal(round.refereeView().players[0].stats.pieces, 0, 'no natural lock without gravity');
  const gravity = createInputExecutionRound({ seed: 1506 });
  for (let frame = 0; frame < 400; frame += 1) {
    gravity.tick(frame === 10 ? { left: [{ frame, type: 'keydown', data: { key: 'softDrop', subframe: 0 } }] }
      : frame === 11 ? { left: [{ frame, type: 'keyup', data: { key: 'softDrop', subframe: 0 } }] } : {});
  }
  assert.ok(gravity.refereeView().players[0].stats.pieces > 0, 'the observed round still locks naturally');
});

for (const order of ['simultaneous', 'bot-first', 'human-first']) {
  test(`turn match with PPS and THINK TIME enabled remains playable: ${order}`, async () => {
    const budgets = [];
    const handlers = planningHandlers(request => budgets.push(request.thinkMs));
    const start = await startTurnRound(handlers, order, {
      rightParameters: { ppsEnabled: true, pps: 20, thinkTimeEnabled: true, thinkMs: 250 },
    });
    const played = await run(handlers, start.sessionId, 1, 160, { 80: tap(80, 'hardDrop') });
    assert.equal(turns(played).left, 1, 'the player can lock');
    assert.ok(turns(played).right >= 1, 'the opponent can answer');
    assert.ok(budgets.length > 0, 'the real proposal boundary was reached');
    assert.ok(budgets.every(value => value === 250), 'turn matches retain the configured think time without a PPS deadline');
  });
}

test('bot first: the opponent opens the round and then waits for the player', async () => {
  const handlers = planningHandlers();
  const start = await startTurnRound(handlers, 'bot-first');
  assert.deepEqual(start.dueBotIds, ['right']);

  const opened = await run(handlers, start.sessionId, 1, 40);
  assert.deepEqual(turns(opened), { left: 0, right: 1 }, 'the bot takes the first turn alone');
  assert.deepEqual(opened.dueBotIds, ['left']);

  // The bot does not take a second turn however long the round runs on.
  const waiting = await run(handlers, start.sessionId, 41, 240);
  assert.deepEqual(turns(waiting), { left: 0, right: 1 }, 'the bot waits for its turn to come back');

  const played = await run(handlers, start.sessionId, 241, 320, { 241: tap(241, 'hardDrop') });
  assert.equal(turns(played).left, 1);
  assert.equal(turns(played).right, 2, 'the player lock releases the opponent');
});

test('1P first: the player opens the round and the opponent may not pass them', async () => {
  const handlers = planningHandlers();
  const start = await startTurnRound(handlers, 'human-first');
  assert.deepEqual(start.dueBotIds, ['left']);

  const waiting = await run(handlers, start.sessionId, 1, 200);
  assert.deepEqual(turns(waiting), { left: 0, right: 0 }, 'nothing moves until the player does');

  const played = await run(handlers, start.sessionId, 201, 280, { 201: tap(201, 'hardDrop') });
  assert.equal(turns(played).left, 1);
  assert.equal(turns(played).right, 1, 'the opponent answers that turn and stops');

  const held = await run(handlers, start.sessionId, 281, 420);
  assert.deepEqual(turns(held), { left: 1, right: 1 });
});

test('a bot with no placement left hard-drops in place and tops out without gravity', async () => {
  // A searched empty CC2 answer: in a gravity round the piece would then fall
  // and lock where it stands, which is the lock a turn match must stand in for.
  const handlers = createGuiInputMatchHandlers({ now: () => 0, runtime: {
    propose: async () => {
      throw Object.assign(new Error('CC2 returned no suggested move'), { suggestionReceived: true,
        moveInfo: { selections: 1, nodes: 0, candidate_values: [], extra: '' } });
    },
    resolveInput: async payload => resolveInputJob(payload),
    closeSessions: async () => {},
  } });
  const start = await startTurnRound(handlers, 'bot-first');
  let view = await run(handlers, start.sessionId, 1, 20);
  assert.deepEqual(turns(view), { left: 0, right: 1 }, 'the bot locks its piece without a plan');
  assert.equal(view.bots.find(bot => bot.id === 'right').inputExecution.noInputResponses, 1);
  // Both sides drop every piece at spawn; the bot opens each turn, so its stack
  // reaches the ceiling first and the round must end instead of waiting on it.
  let frame = 21;
  for (let turn = 0; turn < 40 && !view.outcome.complete; turn += 1) {
    view = await run(handlers, start.sessionId, frame, frame + 20, { [frame]: tap(frame, 'hardDrop') });
    frame += 21;
  }
  assert.equal(view.outcome.complete, true, 'the round ends');
  assert.equal(view.outcome.winnerBotId, 'left');
});

test('an out-of-turn hard drop is withheld rather than queued up', async () => {
  const handlers = planningHandlers();
  const start = await startTurnRound(handlers, 'bot-first');
  // Frame 1 belongs to the bot, so the press is dropped entirely; the piece is
  // still the player's own when their turn arrives.
  const early = await run(handlers, start.sessionId, 1, 60, { 1: tap(1, 'hardDrop') });
  assert.equal(turns(early).left, 0, 'the press outside the turn never locks');
  assert.equal(turns(early).right, 1);

  const played = await run(handlers, start.sessionId, 61, 140, { 61: tap(61, 'hardDrop') });
  assert.equal(turns(played).left, 1, 'the next in-turn press still works');
});

test('simultaneous: neither side may get more than one piece ahead', async () => {
  const handlers = planningHandlers();
  const start = await startTurnRound(handlers, 'simultaneous');
  assert.deepEqual([...start.dueBotIds].sort(), ['left', 'right']);

  // The bot takes its half at once; the player has not taken theirs, so the
  // bot stops there however long the round runs.
  const half = await run(handlers, start.sessionId, 1, 300);
  assert.deepEqual(turns(half), { left: 0, right: 1 });

  const first = await run(handlers, start.sessionId, 301, 380, { 301: tap(301, 'hardDrop') });
  assert.equal(turns(first).left, 1);
  assert.equal(turns(first).right, 2, 'the completed turn releases the next one');

  const second = await run(handlers, start.sessionId, 381, 460, { 381: tap(381, 'hardDrop') });
  assert.equal(turns(second).left, 2);
  assert.ok(turns(second).right <= turns(second).left + 1);
});

test('a turn match round is playable but never saved as .ttrm', async () => {
  const handlers = planningHandlers();
  const start = await startTurnRound(handlers, 'bot-first');
  await run(handlers, start.sessionId, 1, 30);
  const refused = await handlers.handle({ method: 'GET', path: '/api/input-match/ttrm' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /only a completed valid input round/);

  const withStall = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: {
    ...config, turnMatch: { enabled: true, order: 'bot-first' },
    stallLock: { enabled: true, pps: 2, penalty: 'penalty-line' },
  } });
  assert.equal(withStall.status, 409);
  assert.match(withStall.body.error, /no pace for STALL PENALTY/);
});

test('a bot-versus-bot input round keeps its own pace and natural gravity', async () => {
  const handlers = planningHandlers();
  const start = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: {
    ...config, left: 'cc2-s2-f14', turnMatch: { enabled: true, order: 'bot-first' },
  } });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.equal(start.body.turnMatch.enabled, false, 'no 1P side is nobody to take a turn against');
  assert.equal(start.body.pacing.authority, 'realtime-input');
  assert.deepEqual([...start.body.dueBotIds].sort(), ['left', 'right']);
});
