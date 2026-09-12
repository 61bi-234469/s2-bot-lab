import { INPUT_DECISION_REQUEST_ID } from './input-decision-request.mjs';
import { createInputReplaySession } from './replay/ttrm-simulator.mjs';
import { inputExecutionOptions, INPUT_EXECUTION_PROFILE } from './replay/engine-config.mjs';
import { resolveQualifiedInputSubmission } from './s2-input-public-resolver.mjs';
import { PIECE } from './replay/pieces.mjs';

const ROUNDS = new WeakMap();

/** One referee owns both clocks, delivery and the observed terminal receipt. */
export function createInputExecutionRound({ seed, ids = ['left', 'right'], handlingById = {},
  stallPenaltyForgivenessId = null } = {}) {
  if (!Array.isArray(ids) || ids.length !== 2 || new Set(ids).size !== 2 || ids.some(id => typeof id !== 'string' || !id)) {
    throw new Error('input round requires two distinct player ids');
  }
  ids = [...ids];
  if (Object.keys(handlingById).some(id => !ids.includes(id))) throw new Error('unknown handling player');
  if (stallPenaltyForgivenessId !== null && !ids.includes(stallPenaltyForgivenessId)) throw new Error('unknown STALL forgiveness player');
  const sessions = ids.map(id => createInputReplaySession({ id, replay: {
    frames: 0, events: [], options: inputExecutionOptions({ seed, handling: handlingById[id] }), results: { stats: { garbage: { sent: 0 } } },
  } }, { canonicalProfile: INPUT_EXECUTION_PROFILE.id, forgiveStallPenalty: id === stallPenaltyForgivenessId }));
  let status = 'active';
  let terminal = null;
  let frame = 0;
  const pending = [[], []];
  const nextIgeId = [0, 0];
  const nextCid = [1, 1];
  const completeTopOut = (losingIndex = null) => {
    terminal = { frame, winnerId: losingIndex === null
      ? (sessions.filter(session => !session.toppedOut).length === 1
        ? ids[sessions.findIndex(session => !session.toppedOut)] : null)
      : ids[1 - losingIndex], reason: 'top-out' };
    for (const session of sessions) session.finish();
    status = 'complete';
  };
  const round = {
    get status() { return status; },
    get frame() { return frame; },
    refereeView() {
      return { terminal: structuredClone(terminal), players: sessions.map((session, index) =>
        ({ id: ids[index], ...session.refereeView() })) };
    },
    refereeLastLock(id) {
      const index = ids.indexOf(id);
      if (index < 0) throw new Error('unknown input round player');
      return sessions[index].refereeLastLock();
    },
    publicState(id) {
      const index = ids.indexOf(id);
      if (index < 0 || status !== 'active') throw new Error('active input round player required');
      return sessions[index].publicState();
    },
    plan(id, { moves, type = 'cc2-s2-f14', engineId = type }, budget) {
      const { decision, movement } = round.publicState(id);
      const request = { id: engineId === type ? INPUT_DECISION_REQUEST_ID : 's2-amount-only-decision-request/1', sessionKey: 'input-round',
        decision, moves, type, engine: { botType: type, engineId } };
      return resolveQualifiedInputSubmission(request, movement, budget);
    },
    applyStallPenalty(id, penalty) {
      const index = ids.indexOf(id);
      if (index < 0 || status !== 'active') throw new Error('active input round player required');
      if (penalty === 'penalty-line') {
        const result = sessions[index].applyStallPenaltyLine();
        if (result.toppedOut) completeTopOut(index);
        return result;
      }
      if (penalty === 'forced-lock') {
        sessions[index].prepareStallForcedLock();
        return { rows: sessions[index].stallPenaltyRows, toppedOut: false };
      }
      throw new Error('unsupported STALL PENALTY');
    },
    refereeStallPenaltyRows(id) {
      const index = ids.indexOf(id);
      if (index < 0) throw new Error('unknown input round player');
      return sessions[index].stallPenaltyRows;
    },
    tick(inputs = {}) {
      if (status !== 'active') throw new Error('input round is not active');
      try {
        if (Object.keys(inputs).some(id => !ids.includes(id))) throw new Error('unknown input player');
        for (const id of ids) {
          if (inputs[id] !== undefined && (!Array.isArray(inputs[id]) || inputs[id].some(event =>
            event.frame !== frame || !['keydown', 'keyup'].includes(event.type)))) {
            throw new Error('round callers may supply only current-frame key input');
          }
        }
        for (const [index, session] of sessions.entries()) {
          session.tick([
            ...(frame === 0 ? [{ frame, type: 'start' },
              { frame, type: 'ige', data: { type: 'target', data: { targets: [2 - index] } } }] : []),
            ...pending[index].splice(0),
            ...(inputs[ids[index]] ?? []),
          ].map(event => event.type === 'ige' ? { ...event,
            data: { id: nextIgeId[index]++, frame: event.frame, ...event.data },
          } : event));
        }
        frame += 1;
        if (sessions.some(session => session.frame !== frame)) throw new Error('input round clocks diverged');
        // The only external dispatcher: each observed post-cancel chunk is
        // delivered once, on the receiver's next tick, in execution order.
        for (const [index, session] of sessions.entries()) {
          for (const sent of session.takeOutgoing()) {
            if (sent.target !== 2 - index) throw new Error('unexpected input round garbage target');
            const { iid, ackiid } = sent;
            const gameid = index + 1;
            // TETR.IO deduplicates envelope IDs and confirms pending garbage
            // by cid. These transport identities are separate from send/ack iid.
            const data = { type: 'garbage', amt: sent.amount, size: 1,
              iid, gameid, ackiid, cid: nextCid[1 - index]++, frame: sent.frame,
              x: sent.x, y: sent.y };
            pending[1 - index].push(
              { frame, type: 'ige', data: { type: 'interaction', data: { ...data } } },
              { frame, type: 'ige', data: { type: 'interaction_confirm', data: { ...data } } },
            );
          }
        }
        if (sessions.some(session => session.toppedOut)) completeTopOut();
      } catch (error) {
        status = 'invalid';
        throw error;
      }
    },
  };
  ROUNDS.set(round, { sessions, readTerminal: () => terminal, readStatus: () => status });
  return Object.freeze(round);
}

/** An unforgeable completed-round owner, not arbitrary player snapshots. */
export function completedInputRoundRecording(round) {
  const owned = ROUNDS.get(round);
  if (!owned || owned.readStatus() !== 'complete' || !owned.readTerminal()) {
    throw new Error('a completed owned input round is required');
  }
  return { players: owned.sessions.map(session => ({
    observed: session.finish(), events: session.executedEvents(), frame: session.frame,
    toppedOut: session.toppedOut, profile: session.canonicalProfile,
  })), terminal: structuredClone(owned.readTerminal()) };
}

/** Referee check after execution, never a fallback/selection predicate. */
export function assertInputPlanLock(planned, actual) {
  const actualCells = actual?.cells?.map(([x, y]) => `${x},${y}`).sort().join(';');
  if (actualCells !== planned.cells || actual.piece !== PIECE[planned.piece] ||
      actual.rotation !== planned.rotation || actual.clear.spin !== planned.spin ||
      actual.frame !== planned.frame || actual.subframe !== 0 || actual.usedHold !== planned.usedHold ||
      actual.hold !== (planned.holdAfter === null ? null : PIECE[planned.holdAfter]) ||
      JSON.stringify(actual.rotationEvidence) !== JSON.stringify(planned.evidence)) {
    throw new Error(`input execution differs from its planned lock at frame ${actual?.frame ?? 'missing'}`);
  }
}
