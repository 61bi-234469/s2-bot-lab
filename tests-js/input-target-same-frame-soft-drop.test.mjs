// A compact soft drop finished inside one frame: a reused route whose lock would leave key input of its frame to the
// next piece is refused, and the planned route locks once.
import assert from 'node:assert/strict';
import test from 'node:test';
import { Tetromino } from '@haelp/teto/engine';
import { createInputExecutionRound, assertInputPlanLock } from '../src-js/input-execution-round.mjs';
import { planInputTarget } from '../src-js/triangle/input-target-planner.mjs';
import { canonicalPlacementToGuiMove } from '../cc2-gui/analysis-proposal.mjs';

test('a route whose lock leaves key input of its frame to the next piece is refused, and the planned route locks once', () => {
  // Untouched, seed 42's first piece (O) rests on the floor and its lock delay runs out during frame 1032.
  const round = createInputExecutionRound({ seed: 42 });
  while (round.frame < 1032) round.tick({});
  const { decision, movement } = round.publicState('left');
  assert.equal(decision.pieces.current, 'O');
  assert.equal(movement.falling.locking, 30);
  const x = movement.falling.location[0];
  const piece = new Tetromino({ symbol: 'o', initialRotation: 0, boardHeight: 20, boardWidth: 10 });
  piece.x = x;
  piece.y = 10;
  piece.y -= Math.min(...piece.absoluteBlocks.map(([, y]) => y));
  const placement = { piece: 'O', rotation: 'spawn', x, y: piece.y - 1, usedHold: false,
    rotationEvidence: { lastInputWasRotation: false, kickIndex: null, kickId: null, kickOffset: null } };
  const request = { id: 's2-amount-only-decision-request/1', sessionKey: 'fixture',
    type: 'cc2-s2-f14', engine: { botType: 'cc2-s2-f14', engineId: 'fixture' },
    decision, moves: [canonicalPlacementToGuiMove(placement)] };
  const candidate = { placement, projection: { spin: 'none' } };
  // A same-frame soft drop: advancing to the release subframe runs the lock delay out first, so in the
  // round the hard drop after it would land the next piece.
  const at = (key, type, subframe) => ({ frame: 1032, type, data: { key, subframe } });
  const reusePlan = { status: 'planned', startedAtFrame: 1032, lockedAtFrame: 1032, events: [
    at('softDrop', 'keydown', 0), at('softDrop', 'keyup', 0.25), at('hardDrop', 'keydown', 0.25), at('hardDrop', 'keyup', 0.25)] };
  const plan = planInputTarget(request, movement, candidate, { compactInputs: true, reusePlan });
  assert.equal(plan.status, 'planned', JSON.stringify(plan));
  assert.notEqual(plan.reused, true);
  while (round.frame <= plan.lockedAtFrame) round.tick({ left: plan.events.filter(event => event.frame === round.frame) });
  assert.equal(round.publicState('left').decision.lockTime.piecesPlaced, 1);
  assertInputPlanLock(plan.lock, round.refereeLastLock('left'));
});
