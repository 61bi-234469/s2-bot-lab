import test from 'node:test';
import assert from 'node:assert/strict';
import { createGuiInputMatchHandlers } from '../src-js/gui-input-match.mjs';
import { createInputExecutionRound } from '../src-js/input-execution-round.mjs';
import { forecastInputBoundary } from '../src-js/triangle/input-target-planner.mjs';
import { resolveInputJob } from '../src-js/input-public-job.mjs';
import { resolveQualifiedInputSubmission } from '../src-js/s2-input-public-resolver.mjs';
import { canonicalPlacementToGuiMove } from '../cc2-gui/analysis-proposal.mjs';
import { canonicalize } from '../scripts/cs1.mjs';
import { buildExecutedInputTtrm } from '../src-js/replay/bot-match-ttrm-export.mjs';
import { Engine, Tetromino } from '@haelp/teto/engine';
import { guiStateToCc2NativeStart } from '../src-js/cc2-s2-native-start.mjs';
import { decisionStateToSyntheticGui } from '../src-js/s2-amount-only-decision-state.mjs';

const tap = (frame, key) => ['keydown', 'keyup'].map(type => ({ frame, type, data: { key, subframe: 0 } }));
const config = { left: 'human', right: 'cc2-s2-f14', seed: 42, maxTurns: null };
const flush = () => new Promise(resolve => setImmediate(resolve));
const searchedEmpty = () => Object.assign(new Error('CC2 returned no suggested move'), {
  suggestionReceived: true, moveInfo: { selections: 512, nodes: 0, candidate_values: [], extra: 'searched root' },
});

test('only raw/chouhy input connections request a native candidate prefix', async () => {
  for (const type of ['cc2-raw', 'cc2-chouhy', 'cc2-s2-f14', 'cc2-s2-champion']) {
    let state;
    const handlers = createGuiInputMatchHandlers({ runtime: {
      propose: async request => { state = request.state; return new Promise(() => {}); }, closeSessions: async () => {},
    } });
    const start = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: { ...config, right: type } });
    await handlers.handle({ method: 'POST', path: '/api/input-match/step', body: { sessionId: start.body.sessionId, frame: 1 } });
    assert.equal(state.input_candidates, ['cc2-raw', 'cc2-chouhy'].includes(type) ? true : undefined);
  }
});

test('searched empty waits for Engine locks and terminal, exports, then starts another round', async () => {
  let calls = 0;
  const handlers = createGuiInputMatchHandlers({ runtime: {
    propose: async ({ engine }) => {
      calls++;
      const error = searchedEmpty();
      if (engine === 'cc2-chouhy') delete error.moveInfo.candidate_values;
      throw error;
    },
    resolveInput: () => assert.fail('empty response must not fabricate a target'), closeSessions: async () => {},
  } });
  const start = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: { ...config, left: 'cc2-chouhy', firstTo: 3 } });
  let view = start.body;
  for (let frame = 1; frame <= 30001 && !view.outcome.complete; frame += 120) {
    const result = await handlers.handle({ method: 'POST', path: '/api/input-match/step', body: { sessionId: start.body.sessionId, frame } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    view = result.body;
    await flush();
    if (frame === 121) assert.equal(calls, 2, 'same public position reuses no-input result');
  }
  assert.equal(view.outcome.complete, true, 'only natural Engine top-out ends the round');
  assert.ok(view.bots.every(bot => bot.inputExecution.naturalLocks > 0 && bot.inputExecution.plannedLocks === 0));
  assert.ok(calls > 2, 'a natural lock permits a new proposal');
  const saved = await handlers.handle({ method: 'GET', path: '/api/input-match/round' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.status, 'ok');
  assert.ok(saved.body.players.every(player => player.verification.matched));
  const next = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: { ...config, seed: 43, firstTo: 3 } });
  assert.equal(next.status, 200);
  assert.notEqual(next.body.sessionId, start.body.sessionId);
  assert.equal(next.body.outcome.complete, false);
});

test('stale searched empty is discarded after natural lock', async () => {
  let rejectFirst;
  let calls = 0;
  const handlers = createGuiInputMatchHandlers({ runtime: {
    propose: () => { calls++; return new Promise((_, reject) => { if (calls === 1) rejectFirst = reject; }); },
    resolveInput: () => assert.fail('stale empty must not resolve'), closeSessions: async () => {},
  } });
  const start = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: config });
  const step = frame => handlers.handle({ method: 'POST', path: '/api/input-match/step', body: { sessionId: start.body.sessionId, frame } });
  await step(1);
  let result;
  let frame = 1;
  do { frame += 120; result = await step(frame); } while (result.body.bots[1].stats.turns === 0 && frame < 1500);
  assert.ok(result.body.bots[1].stats.turns > 0);
  rejectFirst(searchedEmpty());
  await flush();
  result = await step(frame + 1);
  assert.equal(result.status, 200);
  assert.equal(calls, 2);
  assert.equal(result.body.bots[1].inputExecution.noInputResponses, 0);
});

test('missing, inactive or malformed empty evidence remains a failed unsaveable round', async () => {
  for (const error of [new Error('CC2 returned no suggested move'),
    Object.assign(searchedEmpty(), { moveInfo: { selections: 0, nodes: 0, candidate_values: [], extra: 'no active bot' } }),
    Object.assign(searchedEmpty(), { moveInfo: { selections: 512, nodes: 0, candidate_values: ['bad'], extra: 'searched' } })]) {
    const handlers = createGuiInputMatchHandlers({ runtime: {
      propose: async () => { throw error; }, closeSessions: async () => {},
    } });
    const start = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: config });
    const step = frame => handlers.handle({ method: 'POST', path: '/api/input-match/step', body: { sessionId: start.body.sessionId, frame } });
    await step(1); await flush();
    assert.equal((await step(2)).status, 409);
    assert.equal((await handlers.handle({ method: 'GET', path: '/api/input-match/ttrm' })).status, 409);
  }
});
const move = canonicalPlacementToGuiMove({ piece: 'Z', rotation: 'spawn', x: 3, y: 0, usedHold: false,
  rotationEvidence: { lastInputWasRotation: false, kickIndex: null, kickId: null, kickOffset: null } });

test('human Engine handling keeps finite soft drop, DAS and subframes through production export', async () => {
  const handlers = createGuiInputMatchHandlers({ runtime: {
    propose: () => new Promise(() => {}), closeSessions: async () => {}, resolveInput: resolveInputJob,
  } });
  const { body: started } = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: {
    ...config, humanControls: { handling: { sdf: 5, dasFrames: 10, arrFrames: 1, dcdFrames: 2 } },
  } });
  const step = (frame, inputs = []) => handlers.handle({ method: 'POST', path: '/api/input-match/step', body: {
    sessionId: started.sessionId, frame, inputs,
  } });
  const key = (frame, key, type, subframe = 0.5) => ({ frame, type, data: { key, subframe } });
  const first = await step(1, [key(0, 'softDrop', 'keydown'), key(0, 'moveLeft', 'keydown')]);
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const player = first.body.bots[0];
  assert.ok(Math.min(...player.activeCells.map(([, y]) => y)) > 15, 'finite SDF must not slam to floor');
  const initialX = Math.min(...player.activeCells.map(([x]) => x));
  const waiting = await step(5);
  assert.equal(Math.min(...waiting.body.bots[0].activeCells.map(([x]) => x)), initialX, 'wait for DAS');
  const repeated = await step(14);
  assert.ok(Math.min(...repeated.body.bots[0].activeCells.map(([x]) => x)) < initialX, 'held key repeats in Engine');
  const stopped = await step(15, [key(14, 'moveLeft', 'keyup'), key(14, 'softDrop', 'keyup')]);
  assert.equal(stopped.status, 200);
  let view = stopped.body;
  while (!view.outcome.complete && view.clock.logicalFrame < 60) {
    const frame = view.clock.logicalFrame;
    const result = await step(frame + 1, [key(frame, 'hardDrop', 'keydown', 0.25), key(frame, 'hardDrop', 'keyup', 0.75)]);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    view = result.body;
  }
  assert.equal(view.outcome.complete, true);
  const saved = await handlers.handle({ method: 'GET', path: '/api/input-match/round' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const players = JSON.parse(saved.body.executedTtrm.text).replay.rounds[0];
  assert.equal(players[0].replay.options.handling.sdf, 5);
  assert.equal(players[0].replay.options.handling.das, 10);
  assert.equal(players[0].replay.options.handling.dcd, 2);
  assert.equal(players[0].replay.options.handling.may20g, false);
  assert.equal(players[1].replay.options.handling.das, 0, 'bot keeps fixed handling');
  assert.ok(saved.body.players[0].locks.some(lock => lock.subframe === 0.25));
});

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

test('input GUI honors PPS limits, unlimited pace and slow forecast windows', async () => {
  for (const [pps, ppsEnabled, expected] of [[1, true, 60], [4, true, 15], [20, true, 3], [1, false, 3], [.1, true, 600]]) {
    const handlers = createGuiInputMatchHandlers({ now: () => 0, runtime: {
      propose: async ({ state }) => ({ moves: [spawnMove(state)] }),
      resolveInput: async payload => resolveInputJob(payload), closeSessions: async () => {},
    } });
    const start = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: {
      ...config, rightParameters: { pps, ppsEnabled },
    } });
    assert.equal(start.body.pacing.declaredPpsByBotId.right, ppsEnabled ? pps : null);
    const locks = [];
    for (let frame = 1; frame <= expected * 2 + 12 && locks.length < 2; frame++) {
      const result = await handlers.handle({ method: 'POST', path: '/api/input-match/step', body: {
        sessionId: start.body.sessionId, frame,
      } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      if (result.body.bots[1].stats.turns > locks.length) locks.push(result.body.bots[1].lastLock.frame);
      await flush();
    }
    assert.equal(locks.length, 2, JSON.stringify({ pps, ppsEnabled, locks }));
    assert.equal(locks[0], expected);
    const interval = locks[1] - locks[0];
    assert.ok(interval >= (ppsEnabled ? Math.ceil(60 / pps) : 1));
    assert.ok(interval <= expected + 2, JSON.stringify({ pps, interval }));
    await handlers.handle({ method: 'POST', path: '/api/input-match/close', body: { sessionId: start.body.sessionId } });
  }
});

test('input GUI preserves native B2B payload, bounds THINK TIME and accumulates fractional PPS', async () => {
  let proposal;
  const handlers = createGuiInputMatchHandlers({ now: () => 0, runtime: {
    propose: async payload => { proposal = payload; return { moves: [spawnMove(payload.state)] }; },
    resolveInput: async payload => {
      assert.deepEqual(proposal.state, guiStateToCc2NativeStart(decisionStateToSyntheticGui(payload.request.decision), { queueLimit: 15 }));
      assert.equal(proposal.thinkMs, 99);
      return resolveInputJob(payload);
    }, closeSessions: async () => {},
  } });
  const rejected = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: { ...config, rightParameters: { queueDepth: 28 } } });
  assert.match(rejected.body.error, /QUEUE DEPTH up to 15/);
  const { body: started } = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: {
    ...config, rightParameters: { pps: 7, queueDepth: 15, thinkTimeEnabled: true, thinkMs: 1000 },
  } });
  const locks = [];
  for (let frame = 1; frame <= 61; frame++) {
    const result = await handlers.handle({ method: 'POST', path: '/api/input-match/step', body: { sessionId: started.sessionId, frame } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (result.body.bots[1].stats.turns > locks.length) locks.push(result.body.bots[1].lastLock.frame);
    await flush();
  }
  assert.deepEqual(locks, [9,18,26,35,43,52,60]);
  await handlers.handle({ method: 'POST', path: '/api/input-match/close', body: { sessionId: started.sessionId } });
});

test('live handler adopts a forecast plan only at its exact boundary; late result does not teleport a lock', async () => {
  for (const delayed of [false, true]) {
    let finish;
    let proposalCount = 0;
    const handlers = createGuiInputMatchHandlers({ now: () => 0, runtime: {
      propose: async ({ state }) => { proposalCount++; return { suggestion: { moves: [spawnMove(state)] } }; },
      resolveInput: async payload => {
        const result = resolveInputJob(payload);
        assert.equal(result.status, 'planned', JSON.stringify(result));
        if (delayed) await new Promise(resolve => { finish = resolve; });
        return result;
      }, closeSessions: async () => {},
    } });
    const start = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: config });
    const step = frame => handlers.handle({ method: 'POST', path: '/api/input-match/step', body: { sessionId: start.body.sessionId, frame } });
    await step(1);
    await flush();
    if (delayed) { await step(80); finish(); await flush(); }
    const result = await step(90);
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.bots[1].stats.turns, delayed ? 0 : 1);
    assert.equal(result.body.bots[1].inputExecution.plannedLocks, delayed ? 0 : 1);
    assert.equal(result.body.bots[1].inputExecution.naturalLocks, 0);
    if (delayed) {
      assert.equal(proposalCount, 1);
      assert.equal(result.body.bots[1].inputExecution.lateResponses, 1);
      assert.equal(result.body.bots[1].inputExecution.replans, 1);
      assert.equal(result.body.bots[1].inputExecution.resolutionOutcomes.preferred, 1);
    }
    await handlers.handle({ method: 'POST', path: '/api/input-match/close', body: { sessionId: start.body.sessionId } });
  }
});

test('GUI input diagnostics retain only the last consumed fallback summary', async () => {
  const fallback = {
    preferredCandidate: {
      cc2Rank: 0,
      piece: 'T',
      rotation: 'reverse',
      spin: 'normal',
      lines: 2,
      rotationWitness: { class: 'kicked', kickId: '12', kickOffset: [1, -1] },
    },
    reason: 'search-exhausted',
  };
  const handlers = createGuiInputMatchHandlers({ runtime: {
    propose: async ({ state }) => ({ moves: [spawnMove(state)] }),
    resolveInput: async payload => {
      const result = resolveInputJob(payload);
      assert.equal(result.status, 'planned', JSON.stringify(result));
      return {
        ...result,
        selection: { ...result.selection, adoptionRank: 1, fallback },
      };
    },
    closeSessions: async () => {},
  } });
  const { body: started } = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: config });
  assert.equal(started.bots[1].inputExecution.lastFallback, null);
  await handlers.handle({ method: 'POST', path: '/api/input-match/step', body: {
    sessionId: started.sessionId, frame: 1,
  } });
  await flush();
  const result = await handlers.handle({ method: 'POST', path: '/api/input-match/step', body: {
    sessionId: started.sessionId, frame: 90,
  } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.bots[1].inputExecution.fallbackLocks, 1);
  assert.equal(result.body.bots[1].inputExecution.resolutionOutcomes.fallback, 1);
  assert.deepEqual(result.body.bots[1].inputExecution.fallbackReasons, { 'search-exhausted': 1 });
  assert.deepEqual(result.body.bots[1].inputExecution.lastFallback, { ...fallback,
    pieceIndex: 0, frame: result.body.bots[1].lastLock.frame });
  await handlers.handle({ method: 'POST', path: '/api/input-match/close', body: { sessionId: started.sessionId } });
});

for (const firstNotFound of [false, true])
test(`incoming maturity discards a stale ${firstNotFound ? 'not-found' : 'plan'} and replans with cached native proposals`, async t => {
  const tick = Engine.prototype.tick;
  let receiver;
  t.mock.method(Engine.prototype, 'tick', function(events) {
    if (events.some(event => event.type === 'ige' && event.data.type === 'target' && event.data.data.targets[0] === 1)) receiver = this;
    const extra = [];
    if (this === receiver && this.frame === 0) extra.push({ frame: 0, type: 'ige', data: {
      type: 'interaction', data: { type: 'garbage', amt: 4, size: 1, iid: 1, gameid: 1, ackiid: 0 },
    } }, { frame: 0, type: 'ige', data: {
      type: 'interaction', data: { type: 'garbage', amt: 2, size: 1, iid: 2, gameid: 1, ackiid: 0 },
    } });
    if (this === receiver && this.frame === 1) extra.push({ frame: 1, type: 'ige', data: {
      type: 'interaction_confirm', data: { type: 'garbage', iid: 1, gameid: 1, frame: 0 },
    } });
    return tick.call(this, [...events, ...extra]);
  });
  const proposals = [];
  const resolutions = [];
  const handlers = createGuiInputMatchHandlers({ now: () => 0, runtime: {
    propose: async payload => { proposals.push(payload); return { moves: [spawnMove(payload.state)] }; },
    resolveInput: async payload => {
      resolutions.push({ payload: structuredClone(payload), proposalCount: proposals.length });
      const result = resolveInputJob(payload);
      return firstNotFound && resolutions.length === 1 ? { status: 'not-found', boundary: result.boundary, attempts: [] } : result;
    }, closeSessions: async () => {},
  } });
  const { body: started } = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: {
    ...config, rightParameters: { pps: 1, thinkTimeEnabled: true, thinkMs: 250 },
  } });
  let result;
  for (let frame = 1; frame <= 70; frame++) {
    result = await handlers.handle({ method: 'POST', path: '/api/input-match/step', body: { sessionId: started.sessionId, frame } });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    if (frame === 1) {
      assert.deepEqual(result.body.bots[1].garbage, { pending: 6, packets: [{ amount: 4, ready: false }, { amount: 2, ready: false }] });
    }
    await flush();
    if (result.body.bots[1].stats.turns > 0) break;
  }
  assert.ok(resolutions.length >= 2);
  assert.equal(resolutions[0].payload.request.decision.incoming.dueThisLockRows, 0);
  assert.equal(resolutions[1].payload.request.decision.incoming.dueThisLockRows, 4);
  assert.equal(resolutions[1].proposalCount, 1);
  assert.equal(proposals[0].thinkMs, 250);
  assert.deepEqual(resolutions[0].payload.request.moves, resolutions[1].payload.request.moves);
  const stats = result.body.bots[1].inputExecution;
  assert.equal(stats.publicStateMismatches, 1);
  assert.equal(stats.replans, 1);
  assert.equal(stats.plannedLocks, 1);
  assert.equal(stats.naturalLocks, 0);
  assert.equal(stats.resolutionOutcomes.preferred, firstNotFound ? 1 : 2);
  assert.equal(stats.resolutionOutcomes.notFound, firstNotFound ? 1 : 0);
  assert.equal(stats.pacedLocks, 1);
  assert.equal(stats.deadlineExceededLocks, 1);
  // The next piece has a different native input and must obtain fresh proposals.
  assert.equal(proposals.length, 2);
  await handlers.handle({ method: 'POST', path: '/api/input-match/close', body: { sessionId: started.sessionId } });
});

test('a current not-found stops at its checked boundary with side and reason, and cannot export', async () => {
  const closed = [];
  const handlers = createGuiInputMatchHandlers({ now: () => 0, runtime: {
    propose: async ({ state }) => ({ moves: [spawnMove(state)] }),
    resolveInput: async ({ request, movement, startFrame }) => {
      const future = forecastInputBoundary(request, movement, startFrame);
      const result = resolveQualifiedInputSubmission(future.request, future.movement, { maxNodes: 1, maxTimeMs: 1000 });
      assert.equal(result.status, 'not-found');
      return { ...result, boundary: { decision: future.request.decision, movement: future.movement } };
    },
    closeSessions: async args => closed.push(args),
  } });
  const { body: started } = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: {
    ...config, rightParameters: { pps: 1 },
  } });
  const step = frame => handlers.handle({ method: 'POST', path: '/api/input-match/step', body: { sessionId: started.sessionId, frame } });
  await step(1);
  await flush();
  assert.equal((await step(60)).status, 200, 'negative forecast must wait for its target frame');
  const failed = await step(61);
  assert.equal(failed.status, 409);
  assert.match(failed.body.error, /RIGHT cc2-s2-f14.*frame 60.*node-budget/);
  assert.equal(closed.length, 2, 'start cleanup plus failed session cleanup');
  assert.deepEqual(await step(61), failed, 'failure remains terminal');
  assert.equal((await handlers.handle({ method: 'GET', path: '/api/input-match/ttrm' })).status, 409);
});

test('simultaneous observed top-out exports a draw without inventing a winner', () => {
  const round = createInputExecutionRound({ seed: 42 });
  while (round.status === 'active' && round.frame < 40) round.tick({ left: tap(round.frame, 'hardDrop'), right: tap(round.frame, 'hardDrop') });
  const output = JSON.parse(buildExecutedInputTtrm(round).text);
  assert.ok(output.replay.rounds[0].every(player => player.alive === false && player.replay.results.gameoverreason === 'topout'));
  assert.ok(output.replay.leaderboard.every(player => player.wins === 0));
});

test('future public boundary predicts live idle movement exactly and stops before natural merge', () => {
  const round = createInputExecutionRound({ seed: 42 });
  const { decision, movement } = round.publicState('left');
  const request = { id: 's2-amount-only-decision-request/1', type: 'cc2-s2-f14', sessionKey: 'test',
    engine: { botType: 'cc2-s2-f14', engineId: 'test' }, decision, moves: [move] };
  const future = forecastInputBoundary(request, movement, 60);
  assert.throws(() => forecastInputBoundary(request, { ...movement, frame: 1e15 }, 1e15), /forecast frame/);
  while (round.frame < 60) round.tick();
  assert.equal(canonicalize({ decision: future.request.decision, movement: future.movement }), canonicalize(round.publicState('left')));
  round.tick({ left: [tap(60, 'softDrop')[0]] });
  const grounded = round.publicState('left');
  assert.throws(() => forecastInputBoundary({ ...request, decision: grounded.decision }, grounded.movement, 120), /natural lock/);
});

test('pending CC2 does not block human input or ticks; reset rejects an old session mutation', async () => {
  let release;
  const closed = [];
  const handlers = createGuiInputMatchHandlers({ runtime: {
    propose: () => new Promise(resolve => { release = resolve; }), resolveInput: resolveInputJob,
    closeSessions: async args => closed.push(args),
  } });
  const start = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: config });
  assert.equal(start.status, 200);
  const sessionId = start.body.sessionId;
  const step = async (frame, inputs = []) => handlers.handle({ method: 'POST', path: '/api/input-match/step', body: { sessionId, frame, inputs } });
  assert.equal((await step(1)).status, 200);
  const locked = await step(2, tap(1, 'hardDrop'));
  assert.equal(locked.body.bots[0].stats.turns, 1);
  assert.equal((await step(60)).body.clock.logicalFrame, 60);
  let idle;
  for (let frame = 180; frame <= 1500; frame += 120) {
    idle = await step(frame);
    assert.equal(idle.status, 200);
    if (idle.body.bots[1].stats.turns > 0) break;
  }
  assert.ok(idle.body.bots[1].inputExecution.naturalLocks > 0);
  assert.equal(idle.body.bots[1].inputExecution.plannedLocks, 0);
  assert.equal((await handlers.handle({ method: 'GET', path: '/api/input-match/ttrm' })).status, 409);
  const next = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: config });
  release({ suggestion: { moves: [move] } });
  await flush();
  assert.equal((await step(61)).status, 409);
  assert.notEqual(next.body.sessionId, sessionId);
  assert.ok(closed.some(call => call.sessionKeys.includes(`${sessionId}/right`)));
});

test('actual consumed P1 inputs export through GUI writer and replay import, incomplete and stale input fail', async () => {
  const handlers = createGuiInputMatchHandlers({ runtime: {
    propose: () => new Promise(() => {}), closeSessions: async () => {}, resolveInput: resolveInputJob,
  } });
  const { body: started } = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body: config });
  let view = started;
  for (let frame = 0; frame < 40 && !view.outcome.complete; frame++) {
    const response = await handlers.handle({ method: 'POST', path: '/api/input-match/step', body: {
      sessionId: started.sessionId, frame: frame + 1, inputs: tap(frame, 'hardDrop'),
    } });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    view = response.body;
  }
  assert.equal(view.outcome.complete, true);
  const saved = await handlers.handle({ method: 'GET', path: '/api/input-match/round' });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.equal(saved.body.status, 'ok');
  assert.ok(saved.body.executedTtrm.text.includes('keydown'));
  assert.equal(saved.body.players[0].verification.matched, true);
  assert.equal(saved.body.players[0].locks.length, view.bots[0].stats.turns);
});
