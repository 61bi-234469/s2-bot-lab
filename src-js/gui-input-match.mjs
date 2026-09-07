import { createInputExecutionRound, assertInputPlanLock } from './input-execution-round.mjs';
import { decisionStateToSyntheticGui } from './s2-amount-only-decision-state.mjs';
import { isInputBotType } from './input-bot-contract.mjs';
import { INPUT_DECISION_REQUEST_ID } from './input-decision-request.mjs';
import { normalizeBotParameters } from './bot-parameters.mjs';
import { guiStateToCc2NativeStart } from './cc2-s2-native-start.mjs';
import { realtimeCc2ThinkMs } from './bot-match-options.mjs';
import { calculatePlayerMetrics } from '../cc2-gui/player-metrics.mjs';
import { buildExecutedInputTtrm } from './replay/bot-match-ttrm-export.mjs';
import { parseTtrm } from './replay/ttrm-parser.mjs';
import { buildReplayIR } from './replay/ttrm-simulator.mjs';
import { canonicalize } from '../scripts/cs1.mjs';
import { humanEngineHandling } from '../cc2-gui/human-controls.mjs';

const IDS = ['left', 'right'];
const KEYS = new Set(['moveLeft', 'moveRight', 'softDrop', 'hardDrop', 'rotateCW', 'rotateCCW', 'rotate180', 'hold']);
const equal = (a, b) => canonicalize(a) === canonicalize(b);
const paceFrame = value => Math.ceil(value - 1e-9);
const pieceIdentity = state => ({ board: state.decision.board, pieces: state.decision.pieces,
  chain: state.decision.chain, piecesPlaced: state.decision.lockTime.piecesPlaced });
const nativeInputState = (decision, parameters, type) => ({
  ...guiStateToCc2NativeStart(decisionStateToSyntheticGui(decision), { queueLimit: parameters.queueDepth }),
  ...(['cc2-raw', 'cc2-chouhy'].includes(type) ? { input_candidates: true } : {}),
});

/** Shared local/Pages input owner. Only tick mutates a round; asynchronous jobs
 * receive public copies and can publish plans for a future, checked boundary. */
export function createGuiInputMatchHandlers({ runtime, now = () => performance.now() }) {
  let current = null;
  let generation = 0;
  const ok = body => ({ status: 200, body });
  return {
    async handle({ method, path, body = {} }) {
      try {
        const queryAt = path.indexOf('?');
        const requestedSession = queryAt < 0 ? null : new URLSearchParams(path.slice(queryAt + 1)).get('sessionId');
        if (queryAt >= 0) path = path.slice(0, queryAt);
        if (method === 'POST' && path === '/api/input-match/start') {
          const types = { left: body.left, right: body.right };
          if (body.fairComparison === true) throw new Error('.ttrm input mode uses a realtime clock; disable FAIR COMPARISON');
          if (types.right === 'human' || IDS.some(id => types[id] !== 'human' && !isInputBotType(types[id]))) {
            throw new Error('.ttrm input mode requires a registered input bot (You is allowed on the left)');
          }
          if (!runtime) throw new Error('input CC2 runtime unavailable');
          const parameters = Object.fromEntries(IDS.map(id => [id, normalizeBotParameters(types[id], body[`${id}Parameters`])]));
          if (IDS.some(id => types[id] !== 'human' && parameters[id].queueDepth > 15)) throw new Error('TTRM INPUT supports QUEUE DEPTH up to 15 (current + 14 NEXT)');
          if (body.maxTurns != null && (!Number.isSafeInteger(body.maxTurns) || body.maxTurns < 1 || body.maxTurns > 10000)) throw new Error('invalid MAX TURNS');
          if (current) current.closed = true;
          const sessionId = `input-${++generation}`;
          const previous = current;
          current = null;
          await runtime.closeSessions({ sessionKeys: previous?.keys ?? [] });
          if (sessionId !== `input-${generation}`) throw new Error('match-replaced');
          current = { sessionId, keys: IDS.map(id => `${sessionId}/${id}`), types, parameters,
            round: createInputExecutionRound({ seed: body.seed,
              handlingById: types.left === 'human' ? { left: humanEngineHandling(body.humanControls) } : {} }), closed: false, failure: null,
            jobs: {}, ready: {}, plans: {}, proposals: {}, lastLock: {}, misses: {}, leadFrames: {}, paceDeadline: {}, saved: null, maxTurns: body.maxTurns ?? null,
            selections: {}, diagnostics: Object.fromEntries(IDS.map(id => [id,
              { plannedLocks: 0, fallbackLocks: 0, naturalLocks: 0, lastFallback: null,
                publicStateMismatches: 0, lateResponses: 0, replans: 0, noInputResponses: 0,
                resolutionOutcomes: { preferred: 0, fallback: 0, notFound: 0, stale: 0 },
                fallbackReasons: {}, pacedLocks: 0, deadlineExceededLocks: 0 }])),
            config: { seed: body.seed, firstTo: body.firstTo ?? 1, fairComparison: false, maxTurns: body.maxTurns ?? null } };
          return ok(view(current));
        }
        const session = current;
        if (!session) throw new Error('match-not-started');
        if (requestedSession !== null && requestedSession !== session.sessionId) throw new Error('match-replaced');
        if (method === 'POST' && body.sessionId !== session.sessionId) throw new Error('match-replaced');
        if (method === 'POST' && path === '/api/input-match/close') {
          session.closed = true;
          current = null;
          generation++;
          await runtime.closeSessions({ sessionKeys: session.keys });
          return ok({ closed: true });
        }
        if (method === 'POST' && path === '/api/input-match/step') {
          if (session.failure) throw new Error(session.failure);
          if (session.round.status !== 'active') return ok(view(session));
          const target = body.frame;
          if (!Number.isSafeInteger(target) || target < session.round.frame || target > session.round.frame + 120 || target > 1000000) {
            throw new Error('input tick frame must advance by at most 120 frames');
          }
          const events = body.inputs ?? [];
          if (!Array.isArray(events) || events.length > 512 || (events.length && session.types.left !== 'human') ||
            events.some((event, index) => !Number.isSafeInteger(event.frame) || event.frame < session.round.frame || event.frame >= target ||
              (index > 0 && event.frame < events[index - 1].frame) || !['keydown', 'keyup'].includes(event.type) ||
              !KEYS.has(event.data?.key) || !Number.isFinite(event.data.subframe) || event.data.subframe < 0 || event.data.subframe >= 1 ||
              (index > 0 && event.frame === events[index - 1].frame && event.data.subframe < events[index - 1].data.subframe))) throw new Error('invalid or stale human input');
          let cursor = 0;
          while (session.round.frame < target && session.round.status === 'active') {
            const frame = session.round.frame;
            const inputs = {};
            for (const id of IDS) {
              if (session.types[id] === 'human') continue;
              adopt(session, id);
              const plan = session.plans[id];
              if (plan) inputs[id] = plan.events.filter(event => event.frame === frame);
            }
            if (session.types.left === 'human') {
              inputs.left = [];
              while (cursor < events.length && events[cursor].frame === frame) inputs.left.push(events[cursor++]);
            }
            try {
              session.round.tick(inputs);
              for (const id of IDS) {
                const lock = session.round.refereeLastLock(id);
                if (!lock || lock.pieceIndex === session.lastLock[id]) continue;
                session.lastLock[id] = lock.pieceIndex;
                const plan = session.plans[id];
                if (plan) assertInputPlanLock(plan.lock, lock);
                if (session.types[id] !== 'human') {
                  const parameters = session.parameters[id];
                  const interval = parameters.ppsEnabled === false ? 0 : 60 / parameters.pps;
                  const due = session.paceDeadline[id] ?? interval;
                  session.paceDeadline[id] = (lock.frame > paceFrame(due) ? lock.frame : due) + interval;
                  const stats = session.diagnostics[id];
                  if (parameters.ppsEnabled !== false) {
                    stats.pacedLocks++;
                    if (lock.frame > paceFrame(due)) stats.deadlineExceededLocks++;
                  }
                  if (plan) {
                    stats.plannedLocks++;
                    const selection = session.selections[id];
                    if (selection?.adoptionRank > 0) {
                      stats.fallbackLocks++;
                      if (selection.fallback) stats.lastFallback = { ...structuredClone(selection.fallback),
                        pieceIndex: lock.pieceIndex, frame: lock.frame };
                    }
                  } else stats.naturalLocks++;
                }
                delete session.plans[id];
                delete session.selections[id];
                delete session.ready[id];
                delete session.proposals[id];
              }
              if (session.maxTurns !== null && Object.values(session.lastLock).some(index => index + 1 >= session.maxTurns) && session.round.status === 'active') {
                throw new Error('MAX TURNS reached before top-out; unfinished rounds cannot be exported as .ttrm');
              }
            } catch (error) { session.failure = error.message; void runtime.closeSessions({ sessionKeys: session.keys }); throw error; }
          }
          for (const id of IDS) schedule(session, id);
          if (session.round.status === 'complete') void runtime.closeSessions({ sessionKeys: session.keys });
          return ok(view(session));
        }
        if (method === 'GET' && ['/api/input-match/round', '/api/input-match/ttrm'].includes(path)) {
          if (session.failure || session.round.status !== 'complete') throw new Error('only a completed valid input round can be saved');
          if (!session.saved) {
            const output = buildExecutedInputTtrm(session.round);
            const ir = buildReplayIR(parseTtrm(output.text));
            if (ir.rounds.some(round => round.status !== 'ok')) throw new Error('saved input replay failed import');
            session.saved = { round: { ...ir.rounds[0], executedTtrm: output }, output };
          }
          return ok(path.endsWith('/round') ? session.saved.round : session.saved.output);
        }
        return { status: 404, body: { error: 'not-found' } };
      } catch (error) { return { status: 409, body: { error: error.message } }; }
    },
  };

  function live(session) { return current === session && !session.closed && !session.failure && session.round.status === 'active'; }
  function adopt(session, id) {
    const ready = session.ready[id];
    if (!ready) return;
    const frame = session.round.frame;
    if (frame < ready.startFrame) return;
    delete session.ready[id];
    const late = frame !== ready.startFrame;
    if (late || !equal(session.round.publicState(id), ready.boundary)) {
      session.diagnostics[id][late ? 'lateResponses' : 'publicStateMismatches']++;
      session.misses[id] = (session.misses[id] ?? 0) + 1;
      return;
    }
    // Negative forecasts are just as state-dependent as executable plans.
    // Only stop after the referee reaches the exact public boundary evaluated.
    if (ready.status === 'not-found') {
      const reasons = [...new Set((ready.attempts ?? []).map(attempt => attempt.reason ?? attempt.status))].join(', ') || 'no admitted target';
      session.failure = `CC2 input path not found; match stopped · ${id.toUpperCase()} ${session.types[id]} · frame ${frame} · ${reasons}`;
      void runtime.closeSessions({ sessionKeys: session.keys });
      throw new Error(session.failure);
    }
    session.plans[id] = ready.plan;
    session.selections[id] = ready.selection;
    session.misses[id] = 0;
  }
  function schedule(session, id) {
    if (!live(session) || session.types[id] === 'human' || session.jobs[id] || session.plans[id] || session.ready[id]) return;
    if ((session.misses[id] ?? 0) > 30) {
      session.failure = 'input planning repeatedly missed its live boundary';
      void runtime.closeSessions({ sessionKeys: session.keys });
      return;
    }
    const initial = session.round.publicState(id);
    const type = session.types[id];
    const parameters = session.parameters[id];
    const interval = parameters.ppsEnabled === false ? 0 : 60 / parameters.pps;
    const dueFrame = paceFrame(session.paceDeadline[id] ?? interval);
    // Forecast is bounded to 120 frames. Slow PPS limits wait without spending
    // worker time repeatedly forecasting the same distant deadline.
    if (dueFrame > session.round.frame + 120) return;
    const sessionKey = session.keys[IDS.indexOf(id)];
    const state = nativeInputState(initial.decision, parameters, type);
    const identity = pieceIdentity(initial);
    const work = (async () => {
      // Reuse only the current piece's proposals for exactly the same native
      // input. Incoming amounts are deliberately absent from that input; the
      // public selector and movement planner below always receive fresh state.
      let proposed = session.proposals[id];
      if (proposed && equal(proposed.identity, identity) && equal(proposed.state, state)) {
        if (proposed.status === 'no-input') return;
        session.diagnostics[id].replans++;
      } else {
        delete session.proposals[id];
        const savedState = structuredClone(state);
        let response;
        try { response = await runtime.propose({ sessionKey, engine: type, state,
          selectionLimit: parameters.selectionEnabled ? parameters.selectionLimit : null,
          thinkMs: !parameters.thinkTimeEnabled ? null : parameters.ppsEnabled === false ? parameters.thinkMs :
            realtimeCc2ThinkMs({ thinkMs: parameters.thinkMs, stepFrames: interval }) });
        } catch (error) {
          const info = error.moveInfo;
          // A searched empty response is no controller input, never a verdict
          // about S2 legality or the winner. Missing/inactive evidence still fails.
          if (error.message !== 'CC2 returned no suggested move' || error.suggestionReceived !== true ||
              !Number.isSafeInteger(info?.selections) || info.selections <= 0 ||
              !Number.isSafeInteger(info.nodes) || info.nodes < 0 ||
              ((info.candidate_values !== undefined || !['cc2-raw', 'cc2-chouhy'].includes(type)) &&
                (!Array.isArray(info.candidate_values) || info.candidate_values.length !== 0)) ||
              typeof info.extra !== 'string' || info.extra.includes('no active bot')) throw error;
          proposed = { identity, state: savedState, status: 'no-input', evidence: structuredClone(info) };
        }
        if (response) proposed = { identity, state: savedState, moves: structuredClone(response.suggestion?.moves ?? response.moves) };
      }
      if (!live(session)) return;
      const latest = session.round.publicState(id);
      if (!equal(identity, pieceIdentity(latest)) || !equal(proposed.state,
        nativeInputState(latest.decision, parameters, type))) return;
      session.proposals[id] = proposed;
      if (proposed.status === 'no-input') {
        session.diagnostics[id].noInputResponses++;
        return;
      }
      const request = { id: INPUT_DECISION_REQUEST_ID, sessionKey, type,
        engine: { botType: type, engineId: type }, decision: latest.decision,
        moves: structuredClone(proposed.moves) };
      const startFrame = Math.max(session.round.frame + (session.leadFrames[id] ?? 2), dueFrame);
      const resolveStarted = now();
      const resolved = await runtime.resolveInput({ request, movement: latest.movement, startFrame });
      if (!live(session)) return;
      const diagnostics = session.diagnostics[id];
      // Count completed resolution decisions, including plans discarded later.
      // Consumed locks use separate counters; one piece may be replanned.
      const outcome = resolved.status === 'planned' ? (resolved.selection.adoptionRank > 0 ? 'fallback' : 'preferred') :
        resolved.status === 'stale' ? 'stale' : 'notFound';
      diagnostics.resolutionOutcomes[outcome]++;
      if (outcome === 'fallback') {
        const reason = resolved.selection.fallback?.reason ?? 'unspecified';
        diagnostics.fallbackReasons[reason] = (diagnostics.fallbackReasons[reason] ?? 0) + 1;
      }
      session.leadFrames[id] = Math.min(120, Math.max(2, Math.ceil((now() - resolveStarted) * 60 / 1000) + 1));
      if (resolved.status === 'stale' || session.round.frame > startFrame) {
        if (session.round.frame > startFrame) session.diagnostics[id].lateResponses++;
        session.misses[id] = (session.misses[id] ?? 0) + 1;
        return;
      }
      if (!['planned', 'not-found'].includes(resolved.status) || !resolved.boundary ||
          (resolved.status === 'planned' && resolved.plan?.startedAtFrame !== startFrame)) {
        throw new Error('invalid input resolution boundary');
      }
      session.ready[id] = { ...resolved, startFrame };
    })().catch(error => { if (live(session)) {
      session.failure = error.message;
      void runtime.closeSessions({ sessionKeys: session.keys });
    } }).finally(() => {
      if (session.jobs[id] === work) delete session.jobs[id];
    });
    session.jobs[id] = work;
  }
  function view(session) {
    const receipt = session.round.refereeView();
    const frame = session.round.frame;
    const bots = receipt.players.map(player => {
      const stats = { turns: player.stats.pieces, attack: player.stats.garbage.attack,
        garbageCancelled: player.cancelledRows, garbageSent: player.stats.garbage.sent, garbageReceived: player.received,
        garbageCleared: player.stats.garbage.cleared };
      return { ...player, type: session.types[player.id], preLockPreview: null,
        inputExecution: structuredClone(session.diagnostics[player.id]),
        stats, score: null, combo: Math.max(0, player.stats.combo + 1), b2b: Math.max(0, player.stats.b2b + 1),
        lastClear: player.lastLock?.clear ?? null, piecesPlaced: stats.turns,
        garbage: { pending: player.pendingRows, packets: player.pendingChunks },
        metrics: calculatePlayerMetrics({ pieces: stats.turns, attack: stats.attack, garbageCleared: stats.garbageCleared, elapsedFrames: frame }) };
    });
    return { executionProfile: 's2-input-execution/1', sessionId: session.sessionId,
      status: session.round.status, humanSide: session.types.left === 'human' ? 'left' : null,
      turnNumber: Math.max(...bots.map(bot => bot.stats.turns)), bots, config: session.config,
      clock: { logicalFrame: frame }, metricElapsedMs: frame * 1000 / 60, nextStepFrames: 1,
      outcome: { complete: receipt.terminal !== null, winnerBotId: receipt.terminal?.winnerId ?? null, reason: receipt.terminal?.reason ?? null },
      replayMeta: { origin: 's2-bot-lab-generated', users: IDS.map(id => ({ id, username: session.types[id] })) },
      pacing: { authority: 'realtime-input', declaredPpsByBotId: Object.fromEntries(IDS.map(id =>
        [id, session.types[id] === 'human' || session.parameters[id].ppsEnabled === false ? null : session.parameters[id].pps])) } };
  }
}
