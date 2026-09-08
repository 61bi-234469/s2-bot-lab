import { evaluatePlacement } from './placement-adapter.mjs';
import { triangleSnapshotToCanonical, receiveGarbage, confirmGarbage } from './garbage-adapter.mjs';
import { createInputRotationObserver } from './input-rotation-observer.mjs';
import { resolvePlacementRules } from '../ruleset-profiles.mjs';

const ROTATIONS = ['spawn', 'right', 'reverse', 'left'];
const piece = value => value == null ? null : value.toUpperCase();
const cells = board => board.flatMap(row => row.map(tile => tile === null ? '_' :
  ('ijlostz'.includes(tile.mino) && tile.mino.length === 1 ? tile.mino.toUpperCase() : 'G'))).join('');
const chain = stats => ({ combo: Math.max(0, stats.combo + 1), b2b: Math.max(0, stats.b2b + 1), fidelity: 'exact' });
const garbage = snapshot => triangleSnapshotToCanonical(snapshot, { capState: { consumedThisTick: 0 }, fidelity: 'exact' });

/** Referee-only comparison of one already executed lock. Never a selector. */
export function createInputLockConformance(engine, rulesetId) {
  const rules = resolvePlacementRules(rulesetId);
  let pending = null;
  let hardDrop = false;
  let comparedLocks = 0;
  const rotationObserver = createInputRotationObserver(engine);
  let expectedGarbage = garbage(engine.garbageQueue.snapshot());
  const queueOptions = structuredClone(engine.garbageQueue.options);
  const compareGarbage = () => {
    const actual = garbage(engine.garbageQueue.snapshot());
    for (const key of ['packets', 'generatorState']) {
      if (JSON.stringify(actual[key]) !== JSON.stringify(expectedGarbage[key])) {
        throw new Error(`invalid input garbage queue at frame ${engine.frame}: ${key}`);
      }
    }
  };
  const receive = engine.receiveGarbage.bind(engine);
  engine.receiveGarbage = (...packets) => {
    for (const packet of packets) {
      if (packet.amount > 0) expectedGarbage = receiveGarbage(expectedGarbage, {
        packetId: packet.cid, sourceGameId: packet.gameid, amount: packet.amount,
        holeSize: packet.size, arrivalFrame: packet.frame, confirmed: packet.confirmed,
      }, queueOptions);
    }
    const result = receive(...packets);
    compareGarbage();
    return result;
  };
  const confirm = engine.garbageQueue.confirm.bind(engine.garbageQueue);
  engine.garbageQueue.confirm = (packetId, sourceGameId, arrivalFrame) => {
    const next = confirmGarbage(expectedGarbage, { packetId, sourceGameId, arrivalFrame }, queueOptions);
    const result = confirm(packetId, sourceGameId, arrivalFrame);
    if (result !== (next !== null)) throw new Error('input garbage confirmation result differs');
    if (next !== null) expectedGarbage = next;
    compareGarbage();
    return result;
  };
  const originalHardDrop = engine.hardDrop;
  engine.hardDrop = (...args) => {
    hardDrop = true;
    try { return originalHardDrop(...args); } finally { hardDrop = false; }
  };
  return {
    get comparedLocks() { return comparedLocks; },
    checkBoundary() {
      compareGarbage();
      rotationObserver.checkBoundary();
    },
    beforeTick(events) {
      rotationObserver.beforeTick(events);
    },
    beforeMerge() {
      rotationObserver.beforeMerge();
      compareGarbage();
      if (pending !== null) throw new Error('canonical input observer missed a lock completion');
      const state = {
        $schema: 's2-analysis-engine/schema/canonical-state/1', schemaVersion: 1, rulesetId,
        board: { width: 10, height: 40, cells: cells(engine.board.state), fidelity: 'exact' },
        pieces: { current: piece(engine.falling.symbol), hold: piece(engine.held), holdAvailable: true,
          known: Array.from(engine.queue, piece),
          queueModel: { type: '7-bag', bagRemaining: [], seed: null, tail: 'unknown' }, fidelity: 'exact' },
        chain: chain(engine.stats), garbage: structuredClone(expectedGarbage),
        time: { logicalFrame: engine.frame, frameSemantics: 'engine-frame', piecesPlaced: engine.stats.pieces, fidelity: 'exact' },
        movement: { phase: 'active-piece', lastWasClear: engine.lastWasClear, handling: { ...engine.handling }, fidelity: 'exact' },
        informationLoss: [],
      };
      const symbol = state.pieces.current;
      const rotationEvidence = rotationObserver.evidenceForLock();
      const placement = { piece: symbol, rotation: ROTATIONS[engine.falling.rotation],
        x: engine.falling.x, y: Math.floor(engine.falling.y) - (symbol === 'I' ? 3 : symbol === 'O' ? 1 : 2),
        usedHold: false, rotationEvidence };
      pending = { frame: engine.frame, attack: engine.stats.garbage.attack, sent: engine.stats.garbage.sent,
        transition: evaluatePlacement(state, placement, rules, null, { lockSource: hardDrop ? 'hard-drop' : 'natural' }) };
      if (!pending.transition.legality.legal) throw new Error(`canonical input placement rejected: ${pending.transition.legality.reason}`);
      return structuredClone(rotationEvidence);
    },
    afterLock(result) {
      if (pending === null) throw new Error('canonical input observer has no pre-merge state');
      const { transition, attack, sent, frame } = pending;
      const expected = transition.nextState;
      const comparisons = {
        frame: engine.frame === frame,
        board: cells(engine.board.state) === expected.board.cells,
        lines: result.lines === transition.lockResult.lines,
        spin: result.spin === transition.lockResult.spin,
        chain: JSON.stringify(chain(engine.stats)) === JSON.stringify(expected.chain),
        hold: piece(engine.held) === expected.pieces.hold,
        current: piece(engine.falling.symbol) === expected.pieces.current,
        known: expected.pieces.known.every((value, index) => value === piece(engine.queue[index])),
        attack: engine.stats.garbage.attack - attack === transition.attackStages.outgoingBeforeCancel,
        sent: engine.stats.garbage.sent - sent === transition.cancelResult.outgoingAfterCancel,
        garbagePackets: JSON.stringify(garbage(engine.garbageQueue.snapshot()).packets) === JSON.stringify(expected.garbage.packets),
        garbageGenerator: JSON.stringify(garbage(engine.garbageQueue.snapshot()).generatorState) === JSON.stringify(expected.garbage.generatorState),
      };
      const failures = Object.keys(comparisons).filter(key => !comparisons[key]);
      if (failures.length) {
        const error = new Error(`invalid input execution at frame ${frame}: ${failures.join(', ')}`);
        error.diagnostic = { frame, failures, expectedGarbage: expected.garbage, actualGarbage: garbage(engine.garbageQueue.snapshot()) };
        throw error;
      }
      comparedLocks += 1;
      expectedGarbage = expected.garbage;
      pending = null;
    },
  };
}
