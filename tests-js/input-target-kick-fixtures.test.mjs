import assert from "node:assert/strict";
import test from "node:test";
import { Engine, Mino, Tetromino } from "@haelp/teto/engine";

import reachableMoves from "../fixtures/golden/reachable-move-generation.json" with { type: "json" };
import spinRoutes from "../fixtures/input-execution/spin-route-regressions.json" with { type: "json" };
import equivalentRoute from "../fixtures/input-execution/equivalent-spin-route.json" with { type: "json" };
import iKickFallback from "../fixtures/input-execution/chouhy-i-kick-order-fallback.json" with { type: "json" };
import { assertInputDecisionRequest } from '../src-js/input-decision-request.mjs';
import { rankS2AmountOnlyPublicCandidates } from '../src-js/s2-amount-only-public-candidates.mjs';
import { QUALIFIED_STATIC_CC2_RESOLVER_POLICY } from '../src-js/s2-amount-only-public-resolver.mjs';
import { canonicalPlacementToGuiMove } from "../cc2-gui/analysis-proposal.mjs";
import { resolveQualifiedInputSubmission } from "../src-js/s2-input-public-resolver.mjs";
import { planInputTarget } from "../src-js/triangle/input-target-planner.mjs";
import {
  INPUT_EXECUTION_PROFILE,
  buildEngineConfig,
  inputExecutionOptions,
} from "../src-js/replay/engine-config.mjs";
import { assertS2AmountOnlyDecisionRequest } from "../src-js/s2-amount-only-decision-request.mjs";
import {
  projectInputPublicMovement,
  validateInputPublicMovement,
} from "../src-js/triangle/input-public-movement.mjs";
import { createInputRotationObserver } from "../src-js/triangle/input-rotation-observer.mjs";

const T_TUCK = reachableMoves.cases.find(
  (fixture) => fixture.id === "reachable-t-spin-mini-not-hard-drop-reachable",
);

for (const fixture of [T_TUCK, ...spinRoutes.cases, equivalentRoute, iKickFallback]) for (const compactInputs of [false, true]) test(`input resolver executes ${fixture.id} with verified spin evidence (compact=${compactInputs})`, () => {
  const { engine, movement, request, targetCells } = buildFixture(fixture);
  const resolved = resolveQualifiedInputSubmission(request, movement, { compactInputs });
  assert.equal(resolved.status, "planned", JSON.stringify(resolved));
  assert.equal(resolved.selection.adoptionRank, fixture.expectedAdoptionRank ?? 0);
  assert.ok(resolved.attempts.reduce((sum, attempt) => sum + attempt.nodes, 0) <= 128);
  const plan = resolved.plan;
  assert.ok(plan.nodes <= (fixture.maxPlannerNodes ?? 32), 'route stays within its original node budget');
  assert.deepEqual(resolved.placement.rotationEvidence, plan.lock.evidence);

  const observer = createInputRotationObserver(engine);
  const originalAdd = engine.board.add;
  let lock = null;
  let lockResult = null;
  const executed = [];
  engine.board.add = function (...args) {
    observer.beforeMerge();
    lock = {
      cells: cellKey(engine.falling.absoluteBlocks),
      piece: engine.falling.symbol.toUpperCase(),
      rotation: engine.falling.rotation,
      x: engine.falling.x,
      y: Math.floor(engine.falling.y) - boxOffset(engine.falling.symbol.toUpperCase()),
      spin: engine.lastSpin ?? "none",
      evidence: observer.evidenceForLock(),
      frame: engine.frame,
    };
    return originalAdd.apply(this, args);
  };
  engine.events.once("falling.lock", (result) => {
    lockResult = structuredClone(result);
  });

  for (let frame = movement.frame; frame <= plan.lockedAtFrame; frame += 1) {
    const events = plan.events.filter((event) => event.frame === frame);
    observer.beforeTick(events);
    executed.push(...events);
    engine.tick(events);
    observer.checkBoundary();
  }

  assert.deepEqual(executed, plan.events);
  // The wire/recording normalizes Engine kick -0 to JSON 0.
  assert.deepEqual(JSON.parse(JSON.stringify(lock)), {
    cells: targetCells,
    piece: fixture.expectedPlacement.piece,
    rotation: ["spawn", "right", "reverse", "left"].indexOf(fixture.expectedPlacement.rotation),
    x: fixture.expectedPlacement.x,
    y: fixture.expectedPlacement.y,
    spin: fixture.expectedSpin,
    evidence: fixture.expectedPlacement.rotationEvidence,
    frame: plan.lockedAtFrame,
  });
  assert.equal(lockResult?.spin, fixture.expectedSpin);
  if (fixture.expectedLines !== undefined) assert.equal(lockResult?.lines, fixture.expectedLines);
});

test('input planner distinguishes node, frame and time exhaustion for a spin route', t => {
  const { request, movement, candidate } = buildFixture(spinRoutes.cases[0]);
  const nodeLimited = planInputTarget(request, movement, candidate, { maxNodes: 1, compactInputs: true });
  assert.equal(nodeLimited.reason, 'node-budget');
  assert.equal(nodeLimited.nodes, 1);
  const frameLimited = planInputTarget(request, movement, candidate,
    { maxNodes: 1024, maxFrames: 1, maxTimeMs: 1000, compactInputs: true });
  assert.equal(frameLimited.reason, 'frame-budget');
  assert.ok(frameLimited.nodes < 1024);
  let clock = 0;
  t.mock.method(performance, 'now', () => ++clock);
  const timeLimited = planInputTarget(request, movement, candidate, { maxTimeMs: 1, compactInputs: true });
  assert.equal(timeLimited.reason, 'time-budget');
  assert.equal(timeLimited.nodes, 0);
});

test('equivalent kick is opt-in, preserves the candidate projection, and never accepts a different spin', () => {
  const { request, movement } = buildFixture(equivalentRoute);
  const ranked = rankS2AmountOnlyPublicCandidates(request.decision, request.moves,
    { ...QUALIFIED_STATIC_CC2_RESOLVER_POLICY, allowCompleteReturnedPrefix: true });
  const candidate = ranked.candidates[0];
  assert.deepEqual(candidate.placement.rotationEvidence.kickOffset, [1, -1]);
  const budget = { maxNodes: 128, maxTimeMs: 1000, compactInputs: true };
  const strict = planInputTarget(request, movement, candidate, budget);
  assert.equal(strict.status, 'not-found');
  assert.equal(strict.reason, 'node-budget');
  const equivalent = planInputTarget(request, movement, candidate, { ...budget, allowEquivalentSpinWitness: true });
  assert.equal(equivalent.status, 'planned');
  assert.equal(equivalent.nodes, 128, 'exact search keeps the original budget and priority');
  assert.equal(equivalent.lock.spin, candidate.projection.spin);
  assert.notDeepEqual(equivalent.lock.evidence, candidate.placement.rotationEvidence);
  const wrongSpin = planInputTarget(request, movement, { ...candidate, projection: { ...candidate.projection, spin: 'normal' } },
    { ...budget, allowEquivalentSpinWitness: true });
  assert.equal(wrongSpin.status, 'not-found');
});

test('input planner propagates unexpected Engine failures instead of treating them as missing routes', t => {
  const { request, movement, candidate } = buildFixture(spinRoutes.cases[0]);
  t.mock.method(Engine.prototype, 'tick', () => { throw new Error('fixture Engine failure'); });
  assert.throws(() => planInputTarget(request, movement, candidate, { compactInputs: true }), /fixture Engine failure/);
});

function buildFixture(fixture) {
  const options = inputExecutionOptions({ seed: 20 });
  const engine = new Engine(buildEngineConfig(options, []));
  engine.initiatePiece(Mino[fixture.pieces.current]);

  const cells = fixture.board + "_".repeat(400 - fixture.board.length);
  const snapshot = engine.snapshot();
  snapshot.board = Array.from({ length: 40 }, (_, y) => Array.from({ length: 10 }, (_, x) => {
    const symbol = cells[y * 10 + x];
    return symbol === "_" ? null : { mino: symbol === "G" ? "gb" : symbol.toLowerCase() };
  }));
  snapshot.hold = fixture.pieces.hold?.toLowerCase() ?? null;
  snapshot.holdLocked = !fixture.pieces.holdAvailable;
  snapshot.queue.value = fixture.pieces.known.map((value) => value.toLowerCase());
  snapshot._queue.value = [...snapshot.queue.value];
  engine.fromSnapshot(snapshot);
  engine.frame = 0;

  const movement = projectInputPublicMovement(engine);
  validateInputPublicMovement(movement);
  const decision = {
    id: "s2-amount-only-decision-state/1",
    rulesetId: INPUT_EXECUTION_PROFILE.rulesetId,
    board: { width: 10, height: 40, visibleHeight: 20, cells },
    pieces: {
      current: fixture.pieces.current,
      hold: fixture.pieces.hold,
      known: [...fixture.pieces.known],
      holdAvailable: fixture.pieces.holdAvailable,
    },
    chain: { combo: 0, b2b: 0 },
    lockTime: { logicalFrame: movement.frame, piecesPlaced: 0, frameSemantics: "engine-frame" },
    incoming: { pendingRows: 0, dueThisLockRows: 0 },
  };
  const request = {
    id: "s2-amount-only-decision-request/1",
    sessionKey: "fixture",
    decision,
    moves: fixture.moves ?? [canonicalPlacementToGuiMove(fixture.expectedPlacement)],
    type: "cc2-s2-f14",
    engine: { botType: "cc2-s2-f14", engineId: "fixture" },
  };
  if (fixture.type) {
    request.id = 'cc2-input-decision-request/1';
    request.type = fixture.type;
    request.engine = { botType: fixture.type, engineId: fixture.type };
    assertInputDecisionRequest(request);
  } else assertS2AmountOnlyDecisionRequest(request);

  const target = fixture.expectedPlacement;
  const piece = new Tetromino({
    symbol: target.piece.toLowerCase(),
    initialRotation: ["spawn", "right", "reverse", "left"].indexOf(target.rotation),
    boardHeight: 20,
    boardWidth: 10,
  });
  piece.x = target.x;
  piece.y = target.y + boxOffset(target.piece);

  return {
    engine,
    movement,
    request,
    candidate: { placement: structuredClone(target), projection: { spin: fixture.expectedSpin } },
    targetCells: cellKey(piece.absoluteBlocks),
  };
}

function boxOffset(piece) {
  return piece === "I" ? 3 : piece === "O" ? 1 : 2;
}

function cellKey(cells) {
  return cells.map(([x, y]) => `${x},${y}`).sort().join(";");
}
