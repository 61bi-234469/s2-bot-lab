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
import { HANDICAP_GARBAGE_ID, handicapColumnHeights, handicapGarbageCells,
  handicapRecord, normalizeHandicapGarbage } from './gui-1p-handicap-garbage.mjs';
import { normalizeTurnMatch } from './gui-turn-match.mjs';
import { championInputMoves, createChampionInputRequest, predictChampionNextRequest } from './input-champion-decision.mjs';
import { assertChampionParameters, championVisibleState, createChampionProfile } from './champion-parameters.mjs';

const IDS = ['left', 'right'];
const KEYS = new Set(['moveLeft', 'moveRight', 'softDrop', 'hardDrop', 'rotateCW', 'rotateCCW', 'rotate180', 'hold']);
const equal = (a, b) => canonicalize(a) === canonicalize(b);
const paceFrame = value => Math.ceil(value - 1e-9);
const pieceIdentity = state => ({ board: state.decision.board, pieces: state.decision.pieces,
  chain: state.decision.chain, piecesPlaced: state.decision.lockTime.piecesPlaced });
// The champion decides through the F14 core, whose amount-only selector reads
// incoming rows; a CC2 proposal never sees them.
const F14_CORE_TYPES = new Set(['cc2-s2-champion']);
const nativeInputState = (decision, parameters, type) => ({
  ...guiStateToCc2NativeStart(decisionStateToSyntheticGui(decision), { queueLimit: parameters.queueDepth }),
  ...(['cc2-raw', 'cc2-chouhy'].includes(type) ? { input_candidates: true } : {}),
  ...(F14_CORE_TYPES.has(type) ? { incoming: structuredClone(decision.incoming) } : {}),
});
const nativeInputStateWithoutIncoming = state => {
  if (!state || typeof state !== 'object') return state;
  const { incoming: _incoming, ...native } = state;
  return native;
};
const RERANK_FALLBACK_REASONS = new Set(['rerank-mismatch', 'rerank-unavailable', 'f14-rerank-unsupported']);
function isRerankFallback(value) {
  if (RERANK_FALLBACK_REASONS.has(value?.reason)) return true;
  const message = typeof value === 'string' ? value : value?.message;
  return typeof message === 'string' && /rerank[- ](?:mismatch|unavailable|unsupported)|rerank.*(?:unavailable|not available|not initialized)/i.test(message);
}
const normalizeStallPenalty = (value, humanSide) => {
  const enabled = value?.enabled === true;
  if (!enabled) return { enabled: false, pps: null, penalty: null };
  if (humanSide !== 'left') throw new Error('STALL PENALTY requires You (1P) on the left');
  if (!Number.isFinite(value.pps) || value.pps < 0.1 || value.pps > 20) throw new Error('invalid STALL PENALTY PPS');
  if (!['penalty-line', 'forced-lock'].includes(value.penalty)) throw new Error('unsupported STALL PENALTY');
  return { enabled: true, pps: value.pps, penalty: value.penalty };
};

/**
 * The lock a turn match still owes each side.
 *
 * The frame clock never stops on this route, so a turn is a lock-ordering rule
 * rather than a stopped clock: one side leads a turn and the other follows it,
 * and neither may take its (n+1)-th piece before the turn rule admits it. The
 * leading side may lock while it is not ahead; the following side only once the
 * leader has taken that turn. A simultaneous turn has two leaders, so neither
 * can get more than one piece ahead of the other.
 *
 * Each side is therefore blocked only by its own lock and released only by the
 * opponent's, which is what keeps an in-flight bot plan from being invalidated
 * by the person locking underneath it.
 */
function turnAllowsLock(session, id) {
  if (!session.turnMatch.enabled) return true;
  const own = lockCount(session, id);
  const opponent = lockCount(session, id === 'left' ? 'right' : 'left');
  const human = session.types.left === 'human' ? 'left' : null;
  const leads = session.turnMatch.order === 'simultaneous' ||
    (session.turnMatch.order === 'human-first' ? id === human : id !== human);
  return leads ? own <= opponent : own < opponent;
}

function lockCount(session, id) {
  const last = session.lastLock[id];
  return last === undefined ? 0 : last + 1;
}

/** Shared local/Pages input owner. Only the synchronous step path mutates a
 * round; asynchronous jobs receive public copies and can publish plans for a
 * future, checked boundary. */
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
          for (const id of IDS) if (F14_CORE_TYPES.has(types[id])) assertChampionParameters(parameters[id]);
          const humanSide = types.left === 'human' ? 'left' : null;
          const stallPenalty = normalizeStallPenalty(body.stallLock, humanSide);
          const handicap = normalizeHandicapGarbage(body.handicap, { humanSide });
          const turnMatch = normalizeTurnMatch(body.turnMatch, { humanSide });
          // A turn match has no pace for a minimum-pace budget to measure, so
          // the pair is refused rather than silently resolved one way.
          if (turnMatch.enabled && stallPenalty.enabled) throw new Error('a turn match has no pace for STALL PENALTY');
          // Off keeps the observed S2 gravity and garbage multiplier at their
          // starting values for the whole round; it changes no other rule and
          // stays inside the exportable profile.
          const timeProgression = body.timeProgression ?? true;
          if (typeof timeProgression !== 'boolean') throw new Error('invalid TIME PROGRESSION setting');
          if (IDS.some(id => types[id] !== 'human' && parameters[id].queueDepth > 15)) throw new Error('TTRM INPUT supports QUEUE DEPTH up to 15 (current + 14 NEXT)');
          if (body.maxTurns != null && (!Number.isSafeInteger(body.maxTurns) || body.maxTurns < 1 || body.maxTurns > 10000)) throw new Error('invalid MAX TURNS');
          if (current) current.closed = true;
          const sessionId = `input-${++generation}`;
          const previous = current;
          current = null;
          await runtime.closeSessions({ sessionKeys: previous?.keys ?? [] });
          if (sessionId !== `input-${generation}`) throw new Error('match-replaced');
          // The 1P handicap places its terrain before the round opens, so the
          // referee owns it and every later lock is compared against a board
          // that already has it. It is per-round: each game of an FT series and
          // each restart arrives here with its own seed.
          const handicapTerrain = handicap.enabled ? handicapColumnHeights(body.seed) : null;
          current = { sessionId, keys: IDS.map(id => `${sessionId}/${id}`), types, parameters, turnMatch,
            // A turn match removes natural gravity: the piece then waits where
            // the player leaves it and only a hard drop locks it, which is the
            // movement contract a turn needs on this 60 Hz route too.
            round: createInputExecutionRound({ seed: body.seed, timeProgression, naturalGravity: !turnMatch.enabled,
              stallPenaltyForgivenessId: stallPenalty.enabled && stallPenalty.penalty === 'penalty-line' ? 'left' : null,
              initialGarbageById: handicapTerrain === null ? {} : { [humanSide]: handicapGarbageCells(handicapTerrain) },
              handlingById: types.left === 'human' ? { left: humanEngineHandling(body.humanControls) } : {} }), closed: false, failure: null,
            jobs: {}, ready: {}, plans: {}, proposals: {}, speculations: {}, f14Requests: 0, pathWaits: {}, lastLock: {}, misses: {}, leadFrames: {}, paceDeadline: {}, saved: null, maxTurns: body.maxTurns ?? null,
            selections: {}, cachedPlans: {}, incomingObserved: {}, incomingWait: {}, stallPenalty: { ...stallPenalty, rows: 0,
              forcedLockPending: false, dueFrame: stallPenalty.enabled ? 60 / stallPenalty.pps : null },
            diagnostics: Object.fromEntries(IDS.map(id => [id,
              { plannedLocks: 0, fallbackLocks: 0, naturalLocks: 0, lastFallback: null,
                publicStateMismatches: 0, lateResponses: 0, replans: 0, noInputResponses: 0, championReranks: 0, championSpeculations: 0, championSpeculationHits: 0,
                pathBudgetWaits: 0, lastPathBudgetWait: null,
                inputPlanReuses: 0, decisionMs: 0, planningMs: 0,
                incomingChanges: 0, incomingWaitSamples: 0, incomingWaitFrames: 0, incomingWaitMaxFrames: 0,
                resolutionOutcomes: { preferred: 0, fallback: 0, notFound: 0, stale: 0 },
                fallbackReasons: {}, pacedLocks: 0, deadlineExceededLocks: 0 }])),
            handicap: handicapTerrain === null
              ? { id: HANDICAP_GARBAGE_ID, enabled: false }
              : handicapRecord({ seed: body.seed, columnHeights: handicapTerrain, appliedTo: humanSide }),
            config: { seed: body.seed, firstTo: body.firstTo ?? 1, fairComparison: false, timeProgression,
              maxTurns: body.maxTurns ?? null, stallLock: stallPenalty,
              turnMatch: { ...turnMatch },
              handicap: { id: HANDICAP_GARBAGE_ID, enabled: handicap.enabled } } };
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
              const incoming = session.round.publicState(id).decision.incoming;
              if (session.incomingObserved[id] && !equal(incoming, session.incomingObserved[id])) {
                session.diagnostics[id].incomingChanges++;
                session.incomingWait[id] ??= frame;
              }
              session.incomingObserved[id] = incoming;
              adopt(session, id);
              const plan = session.plans[id];
              if (plan) inputs[id] = plan.events.filter(event => event.frame === frame);
              else if (turnLockSubstitutesGravity(session, id)) {
                inputs[id] = ['keydown', 'keyup'].map(type => ({ frame, type, data: { key: 'hardDrop', subframe: 0 } }));
              }
              if (session.incomingWait[id] !== undefined && inputs[id]?.some(event => event.type === 'keydown')) {
                const waited = frame - session.incomingWait[id];
                const stats = session.diagnostics[id];
                stats.incomingWaitSamples++;
                stats.incomingWaitFrames += waited;
                stats.incomingWaitMaxFrames = Math.max(stats.incomingWaitMaxFrames, waited);
                delete session.incomingWait[id];
              }
            }
            if (session.types.left === 'human') {
              inputs.left = [];
              while (cursor < events.length && events[cursor].frame === frame) inputs.left.push(events[cursor++]);
              // Out of turn, the hard drop is the one input a turn match has to
              // withhold: with gravity off it is the only thing that can lock a
              // piece. Both halves of the press are dropped so the Engine keeps
              // no half-held key, and the next in-turn press works normally.
              if (!turnAllowsLock(session, 'left')) {
                inputs.left = inputs.left.filter(event => event.data.key !== 'hardDrop');
              }
              if (session.stallPenalty.forcedLockPending) {
                // The referee owns the deadline. A release/press pair makes
                // the forced hard drop independent of the browser's held-key
                // state, while later same-frame user inputs remain available
                // to the newly spawned piece.
                inputs.left.unshift(
                  { frame, type: 'keyup', data: { key: 'hardDrop', subframe: 0 } },
                  { frame, type: 'keydown', data: { key: 'hardDrop', subframe: 0 } },
                );
              }
            }
            try {
              session.round.tick(inputs);
              for (const id of IDS) {
                const lock = session.round.refereeLastLock(id);
                if (!lock || lock.pieceIndex === session.lastLock[id]) continue;
                session.lastLock[id] = lock.pieceIndex;
                const plan = session.plans[id];
                if (plan) assertInputPlanLock(plan.lock, lock);
                if (session.types[id] === 'human' && session.stallPenalty.enabled) {
                  if (session.stallPenalty.forcedLockPending) {
                    session.stallPenalty.forcedLockPending = false;
                  } else if (session.stallPenalty.penalty === 'penalty-line') {
                    session.stallPenalty.rows = session.round.refereeStallPenaltyRows(id);
                  }
                  session.stallPenalty.dueFrame = lock.frame + 60 / session.stallPenalty.pps;
                } else if (session.types[id] !== 'human') {
                  const parameters = session.parameters[id];
                  // A turn match has no pace: the opponent's lock is what
                  // releases the next one, so no PPS deadline is claimed.
                  const interval = session.turnMatch.enabled || parameters.ppsEnabled === false ? 0 : 60 / parameters.pps;
                  const due = session.paceDeadline[id] ?? interval;
                  session.paceDeadline[id] = (lock.frame > paceFrame(due) ? lock.frame : due) + interval;
                  const stats = session.diagnostics[id];
                  if (parameters.ppsEnabled !== false && !session.turnMatch.enabled) {
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
                delete session.cachedPlans[id];
                delete session.incomingWait[id];
              }
              if (session.maxTurns !== null && Object.values(session.lastLock).some(index => index + 1 >= session.maxTurns) && session.round.status === 'active') {
                throw new Error('MAX TURNS reached before top-out; unfinished rounds cannot be exported as .ttrm');
              }
              applyDueStallPenalty(session);
            } catch (error) { session.failure = error.message; void runtime.closeSessions({ sessionKeys: session.keys }); throw error; }
          }
          for (const id of IDS) schedule(session, id);
          if (session.round.status === 'complete') void runtime.closeSessions({ sessionKeys: session.keys });
          return ok(view(session));
        }
        if (method === 'GET' && ['/api/input-match/round', '/api/input-match/ttrm'].includes(path)) {
          if (session.failure || session.round.status !== 'complete') throw new Error('only a completed valid input round can be saved');
          // A round the consumed input log cannot reproduce: an externally
          // applied start position or penalty floor. It stays valid to play and
          // to score, and its receipt says why no `.ttrm` is offered.
          const replayDisabled = session.turnMatch.enabled ? 'turn-match'
            : session.stallPenalty.enabled ? 'stall-penalty'
            : session.handicap.enabled ? 'handicap-garbage' : null;
          if (replayDisabled !== null) {
            if (path.endsWith('/ttrm')) {
              throw new Error(replayDisabled === 'turn-match'
                ? 'turn match rounds cannot be saved as .ttrm'
                : replayDisabled === 'stall-penalty'
                  ? 'STALL PENALTY rounds cannot be saved as .ttrm'
                  : '1P handicap rounds cannot be saved as .ttrm');
            }
            const receipt = session.round.refereeView();
            return ok({ index: 0, startFrame: 0, endFrame: session.round.frame, status: 'ok',
              result: { winnerId: receipt.terminal?.winnerId ?? null,
                reasons: Object.fromEntries(IDS.map(id => [id, receipt.terminal?.winnerId === id
                  ? 'winner' : receipt.terminal?.reason ?? 'unknown'])) },
              players: [], handicap: session.handicap.enabled ? structuredClone(session.handicap) : null,
              replayDisabled });
          }
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
  function applyDueStallPenalty(session) {
    const stall = session.stallPenalty;
    if (!stall.enabled || stall.forcedLockPending || session.round.status !== 'active' ||
        session.round.frame < paceFrame(stall.dueFrame)) return;
    const result = session.round.applyStallPenalty('left', stall.penalty);
    stall.rows = result.rows;
    stall.dueFrame = session.round.frame + 60 / stall.pps;
    if (stall.penalty === 'forced-lock' && session.round.status === 'active') stall.forcedLockPending = true;
  }
  /* Both no-input outcomes below wait for gravity to lock the piece where it
     stands. A turn match switches gravity off, so that lock would never come
     and a bot with no placement left could never top out. On its own turn the
     piece is hard-dropped instead: the same straight-down resting place a
     natural lock reaches, only without the wait, so a piece with nowhere to go
     below the ceiling ends the round exactly as it would with gravity on. */
  function turnLockSubstitutesGravity(session, id) {
    if (!session.turnMatch.enabled || session.round.naturalGravity || !turnAllowsLock(session, id) ||
        session.jobs[id] || session.ready[id]) return false;
    const latest = session.round.publicState(id);
    const identity = pieceIdentity(latest);
    if (session.pathWaits[id] && equal(session.pathWaits[id], identity)) return true;
    const proposed = session.proposals[id];
    return proposed?.status === 'no-input' && equal(proposed.identity, identity) &&
      equal(proposed.state, nativeInputState(latest.decision, session.parameters[id], session.types[id]));
  }
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
    // Adopt a negative result only at the exact public boundary evaluated.
    if (ready.status === 'not-found') {
      const attempts = ready.attempts ?? [];
      if (attempts.length > 0 && attempts.every(attempt => attempt.status === 'not-found' &&
          ['node-budget', 'time-budget', 'frame-budget'].includes(attempt.reason))) {
        session.pathWaits[id] = structuredClone(pieceIdentity(session.round.publicState(id)));
        const stats = session.diagnostics[id];
        stats.pathBudgetWaits++;
        stats.lastPathBudgetWait = { frame, attempts: structuredClone(attempts) };
        session.misses[id] = 0;
        return;
      }
      const reasons = [...new Set((ready.attempts ?? []).map(attempt => attempt.reason ?? attempt.status))].join(', ') || 'no admitted target';
      session.failure = `CC2 input path not found; match stopped · ${id.toUpperCase()} ${session.types[id]} · frame ${frame} · ${reasons}`;
      void runtime.closeSessions({ sessionKeys: session.keys });
      throw new Error(session.failure);
    }
    session.plans[id] = ready.plan;
    session.selections[id] = ready.selection;
    session.misses[id] = 0;
  }
  // Selection budgets only: a THINK TIME search started early would get more
  // time than the budget. Null when the next `start` cannot be known yet.
  function speculationRequest(decision, payload, decided, parameters) {
    if (typeof runtime.speculateF14 !== 'function' || payload.profile.budget.mode !== 'selection') return null;
    try {
      return predictChampionNextRequest(decision, payload.request, decided, { profile: payload.profile, queueDepth: parameters.queueDepth });
    } catch {
      return null;
    }
  }
  // Runs once this piece is planned on the core's selection, so its own rerank
  // basis is no longer needed. Failure only loses the head start.
  function speculate(session, id, sessionKey, type, proposed) {
    const request = proposed.next;
    proposed.next = null;
    const speculation = { start: request.start, execution: request.execution };
    session.speculations[id] = speculation;
    session.diagnostics[id].championSpeculations++;
    runtime.speculateF14({ sessionKey, type, engine: { botType: type, engineId: type }, request, profile: request.execution })
      .then(response => { if (response?.status !== 'move' && session.speculations[id] === speculation) delete session.speculations[id]; },
        () => { if (session.speculations[id] === speculation) delete session.speculations[id]; });
  }
  function schedule(session, id) {
    if (!live(session) || session.types[id] === 'human' || session.jobs[id] || session.plans[id] || session.ready[id]) return;
    // The bot is released by the opponent's lock, never by a timer, so a turn
    // it does not own is not planned for at all.
    if (!turnAllowsLock(session, id)) return;
    if ((session.misses[id] ?? 0) > 30) {
      session.failure = 'input planning repeatedly missed its live boundary';
      void runtime.closeSessions({ sessionKeys: session.keys });
      return;
    }
    const initial = session.round.publicState(id);
    // Gravity and wall-clock progress alone must not retry an exhausted search
    // or a forecast that already proved a natural lock precedes input.
    // A natural lock or changed board/piece/chain admits a fresh attempt.
    if (session.pathWaits[id]) {
      if (equal(session.pathWaits[id], pieceIdentity(initial))) return;
      delete session.pathWaits[id];
    }
    const type = session.types[id];
    const parameters = session.parameters[id];
    const interval = session.turnMatch.enabled || parameters.ppsEnabled === false ? 0 : 60 / parameters.pps;
    const dueFrame = session.turnMatch.enabled
      ? session.round.frame
      : paceFrame(session.paceDeadline[id] ?? interval);
    // Forecast is bounded to 120 frames. Slow PPS limits wait without spending
    // worker time repeatedly forecasting the same distant deadline.
    if (dueFrame > session.round.frame + 120) return;
    const sessionKey = session.keys[IDS.indexOf(id)];
    const state = nativeInputState(initial.decision, parameters, type);
    const identity = pieceIdentity(initial);
    const work = (async () => {
      // Reuse only the current piece's proposals for exactly the same native
      // input. Incoming row counts remain in the key; when only they change,
      // the champion can reuse its completed search and rerank its result.
      let proposed = session.proposals[id];
      const canRerank = F14_CORE_TYPES.has(type) && proposed?.coreDecision === true &&
        equal(proposed.identity, identity) &&
        equal(nativeInputStateWithoutIncoming(proposed.state), nativeInputStateWithoutIncoming(state));
      if (proposed && equal(proposed.identity, identity) && equal(proposed.state, state)) {
        if (proposed.status === 'no-input') return;
        session.diagnostics[id].replans++;
      } else {
        delete session.proposals[id];
        const decisionStarted = now();
        const savedState = structuredClone(state);
        let response;
        if (F14_CORE_TYPES.has(type)) {
          // The same SELECTION / THINK TIME / QUEUE DEPTH the other CC2 bots
          // take here; THINK TIME is fitted to the pace like theirs.
          const profile = createChampionProfile({ ...parameters, thinkMs: !parameters.thinkTimeEnabled ? parameters.thinkMs
            : session.turnMatch.enabled || parameters.ppsEnabled === false ? parameters.thinkMs
              : realtimeCc2ThinkMs({ thinkMs: parameters.thinkMs, stepFrames: interval }) });
          const payload = { sessionKey, type, engine: { botType: type, engineId: type },
            request: createChampionInputRequest(championVisibleState(initial.decision, parameters.queueDepth),
              { requestId: `f14-input-${++session.f14Requests}`, profile, queueDepth: parameters.queueDepth }),
            profile };
          let decided;
          let usedRerank = false;
          // A search already run for this piece while the previous one was
          // being moved serves it when `start` came true; the core checks
          // that and reranks from this request, exactly as a fresh decision.
          const speculated = session.speculations[id];
          const speculationHit = speculated !== undefined && equal(speculated.start, payload.request.start) &&
            equal(speculated.execution, payload.request.execution);
          if ((canRerank || speculationHit) && typeof runtime.rerankF14 === 'function') {
            try {
              const reranked = await runtime.rerankF14(payload);
              if (!isRerankFallback(reranked)) {
                decided = reranked;
                usedRerank = true;
              }
            } catch (error) {
              if (!isRerankFallback(error)) throw error;
            }
          }
          if (usedRerank) session.diagnostics[id][speculationHit ? 'championSpeculationHits' : 'championReranks']++;
          else {
            // A fresh search replaces what the core retains.
            delete session.speculations[id];
            decided = await runtime.decideF14(payload);
          }
          // No legal placement is no controller input, as for CC2. The core
          // reports it as root-no-move before search or empty-candidates after
          // it; the champion screen runner counts both as terminal.
          proposed = decided.status === 'root-no-move' || (decided.status === 'error' && decided.reason === 'empty-candidates')
            ? { identity, state: savedState, status: 'no-input', coreDecision: true,
              evidence: { status: decided.status, reason: decided.reason } }
            : { identity, state: savedState, coreDecision: true, moves: championInputMoves(decided, initial.decision.pieces),
              next: speculationRequest(initial.decision, payload, decided, parameters) };
        } else try { response = await runtime.propose({ sessionKey, engine: type, state,
          selectionLimit: parameters.selectionEnabled ? parameters.selectionLimit : null,
          thinkMs: !parameters.thinkTimeEnabled ? null : session.turnMatch.enabled || parameters.ppsEnabled === false ? parameters.thinkMs :
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
        session.diagnostics[id].decisionMs += Math.max(0, now() - decisionStarted);
      }
      if (!live(session)) return;
      const latest = session.round.publicState(id);
      if (!equal(identity, pieceIdentity(latest))) return;
      const latestState = nativeInputState(latest.decision, parameters, type);
      if (!equal(proposed.state, latestState)) {
        if (F14_CORE_TYPES.has(type) && proposed.coreDecision === true &&
            equal(nativeInputStateWithoutIncoming(proposed.state), nativeInputStateWithoutIncoming(latestState))) {
          // Keep the finished search as a rerank basis. Its incoming rows are
          // stale, so this result must not be sent to the planner.
          session.proposals[id] = proposed;
        }
        return;
      }
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
      const cached = session.cachedPlans[id];
      const resolved = await runtime.resolveInput({ request, movement: latest.movement, startFrame,
        reuse: cached && equal(cached.identity, identity) ? cached.reuse : null,
        timeProgression: session.round.timeProgression, naturalGravity: session.round.naturalGravity });
      if (!live(session)) return;
      const diagnostics = session.diagnostics[id];
      const planningMs = Math.max(0, now() - resolveStarted);
      diagnostics.planningMs += planningMs;
      if (resolved.plan?.reused) diagnostics.inputPlanReuses++;
      if (resolved.status === 'planned' && resolved.selection.adoptionRank === 0 &&
          typeof resolved.targetIdentity === 'string' && equal(identity, pieceIdentity(session.round.publicState(id)))) {
        session.cachedPlans[id] = { identity, reuse: { targetIdentity: resolved.targetIdentity, plan: resolved.plan } };
      }
      // Count completed resolution decisions, including plans discarded later.
      // Consumed locks use separate counters; one piece may be replanned.
      const outcome = resolved.status === 'planned' ? (resolved.selection.adoptionRank > 0 ? 'fallback' : 'preferred') :
        resolved.status === 'stale' ? 'stale' : 'notFound';
      diagnostics.resolutionOutcomes[outcome]++;
      if (outcome === 'fallback') {
        const reason = resolved.selection.fallback?.reason ?? 'unspecified';
        diagnostics.fallbackReasons[reason] = (diagnostics.fallbackReasons[reason] ?? 0) + 1;
      }
      // One frame suffices for a sub-frame job. Keep extra headroom after a
      // miss; exact-boundary adoption still rejects every late result.
      // A busy host may advance several logical frames in one step. Include
      // that observed progress, rather than repeatedly missing with a budget
      // derived only from wall time at an assumed 60 Hz.
      session.leadFrames[id] = Math.min(120, Math.max(1, Math.ceil(planningMs * 60 / 1000),
        session.round.frame - latest.movement.frame) +
        (session.round.frame > startFrame || (session.misses[id] ?? 0) > 0 ? 1 : 0));
      // After the plan, so the search never delays it (Pages resolves in the
      // same worker), and only when the planner took the core's selection.
      if (proposed.next && outcome === 'preferred') speculate(session, id, sessionKey, type, proposed);
      if (resolved.status === 'stale' && resolved.reason === 'natural-lock') {
        // This is expected idle play, not a missed deadline. Bind the wait to
        // the position forecast, never to a new piece reached during the job.
        const forecastIdentity = pieceIdentity(latest);
        if (equal(forecastIdentity, pieceIdentity(session.round.publicState(id)))) {
          session.pathWaits[id] = structuredClone(forecastIdentity);
          session.misses[id] = 0;
        }
        return;
      }
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
      stallPenalty: { rows: session.stallPenalty.rows, enabled: session.stallPenalty.enabled,
        dueFrame: session.stallPenalty.dueFrame,
        replayDisabled: session.stallPenalty.enabled },
      handicap: { ...structuredClone(session.handicap), replayDisabled: session.handicap.enabled },
      turnMatch: { ...session.turnMatch, replayDisabled: session.turnMatch.enabled },
      // Which side may take the next lock. The browser reads it to hold the
      // player's own hard drop while the turn belongs to the opponent.
      dueBotIds: IDS.filter(id => turnAllowsLock(session, id)),
      replayMeta: { origin: 's2-bot-lab-generated', users: IDS.map(id => ({ id, username: session.types[id] })) },
      pacing: { authority: session.turnMatch.enabled ? 'turn-input' : 'realtime-input',
        declaredPpsByBotId: Object.fromEntries(IDS.map(id =>
          [id, session.turnMatch.enabled || session.types[id] === 'human' ||
            session.parameters[id].ppsEnabled === false ? null : session.parameters[id].pps])) } };
  }
}
