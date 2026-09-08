import { Engine, Tetromino, kickData } from '@haelp/teto/engine';
import { buildEngineConfig, inputExecutionOptions, INPUT_EXECUTION_PROFILE } from '../replay/engine-config.mjs';
import { assertInputDecisionRequest } from '../input-decision-request.mjs';
import { validateInputPublicMovement, projectInputPublicMovement } from './input-public-movement.mjs';
import { createInputRotationObserver } from './input-rotation-observer.mjs';
import { dynamicValue } from '../dynamic-values.mjs';
import { MAX_TTRM_FRAMES_PER_PLAYER } from '../replay/ttrm-parser.mjs';

export const INPUT_TARGET_CONTROLLER = 's2-public-target-input/2';
const ROTATIONS = ['spawn', 'right', 'reverse', 'left'];
const cellKey = cells => cells.map(([x, y]) => `${x},${y}`).sort().join(';');
const key = (frame, name, type = 'keydown') => ({ frame, type, data: { key: name, subframe: 0 } });

/** Bounded target search. Only a validated public request and movement enter.
 * Neutral Engine execution stops at Board.add, before any rule/garbage result.
 */
export function planInputTarget(request, movement, candidate, {
  maxNodes = 128, maxFrames = 60, maxTimeMs = 250, compactInputs = false,
  allowEquivalentSpinWitness = false,
} = {}) {
  assertInputDecisionRequest(request);
  if (typeof allowEquivalentSpinWitness !== 'boolean') throw new Error('invalid equivalent spin witness option');
  validateInputPublicMovement(movement);
  if (!Number.isSafeInteger(movement.frame) || movement.frame > MAX_TTRM_FRAMES_PER_PLAYER - maxFrames) {
    throw new Error('input target frame budget exceeded');
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 1024 ||
      !Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 120 ||
      !Number.isFinite(maxTimeMs) || maxTimeMs <= 0 || maxTimeMs > 1000) throw new Error('invalid input target budget');
  const { decision } = request;
  if (decision.board.width !== 10 || decision.board.height !== 40 || decision.board.visibleHeight !== 20 ||
      typeof decision.board.cells !== 'string' || !/^[IJLOSTZG_]{400}$/.test(decision.board.cells) ||
      !Array.isArray(decision.pieces.known) || decision.pieces.known.length > INPUT_EXECUTION_PROFILE.publicNext ||
      decision.pieces.known.some(value => !/^[IJLOSTZ]$/.test(value)) ||
      decision.pieces.holdAvailable !== !movement.holdLocked) throw new Error('invalid input target public board/pieces');
  if (decision.rulesetId !== INPUT_EXECUTION_PROFILE.rulesetId ||
      decision.lockTime.logicalFrame !== movement.frame ||
      decision.pieces.current?.toLowerCase() !== movement.falling.symbol ||
      decision.pieces.hold?.toLowerCase() !== (movement.hold ?? undefined) ||
      JSON.stringify(movement.handling) !== JSON.stringify(INPUT_EXECUTION_PROFILE.handling)) {
    throw new Error('input target public state/profile mismatch');
  }
  const target = candidate.placement;
  const available = target.usedHold ? decision.pieces.hold ?? decision.pieces.known[0] : decision.pieces.current;
  if (typeof target.usedHold !== 'boolean' || target.piece !== available ||
      (target.usedHold && (!decision.pieces.holdAvailable || movement.holdLocked))) throw new Error('input target HOLD mismatch');
  const rotation = ROTATIONS.indexOf(target.rotation);
  if (rotation < 0 || !/^[IJLOSTZ]$/.test(target.piece) ||
      !Number.isSafeInteger(target.x) || !Number.isSafeInteger(target.y)) throw new Error('invalid input target placement');
  const piece = new Tetromino({ symbol: target.piece.toLowerCase(), initialRotation: rotation, boardHeight: 20, boardWidth: 10 });
  piece.x = target.x;
  piece.y = target.y + (target.piece === 'I' ? 3 : target.piece === 'O' ? 1 : 2);
  const targetCells = cellKey(piece.absoluteBlocks);
  const startedAt = performance.now();
  let nodes = 0;
  let equivalentTrial = null;
  let hitFrameBudget = false;
  const frameStop = {};
  const timeStop = {};
  const notFound = () => equivalentTrial ? result(equivalentTrial) : ({ status: 'not-found', reason:
    performance.now() - startedAt >= maxTimeMs ? 'time-budget' :
      nodes >= maxNodes ? 'node-budget' : hitFrameBudget ? 'frame-budget' : 'search-exhausted',
    nodes, elapsedMs: performance.now() - startedAt });

  const attempt = (actions, compact = compactInputs) => {
    if (nodes >= maxNodes || performance.now() - startedAt >= maxTimeMs) return null;
    nodes++;
    const engine = neutralEngine(decision, movement);
    const observer = createInputRotationObserver(engine);
    let usedHold = false;
    const hold = engine.hold.bind(engine);
    engine.hold = (...args) => {
      const result = hold(...args);
      if (result) usedHold = true;
      return result;
    };
    const events = [];
    let lock = null;
    const stop = {};
    engine.board.add = () => {
      observer.beforeMerge();
      lock = { cells: cellKey(engine.falling.absoluteBlocks), piece: engine.falling.symbol.toUpperCase(),
        rotation: engine.falling.rotation, spin: engine.lastSpin ?? 'none',
        evidence: observer.evidenceForLock(), frame: engine.frame };
      throw stop;
    };
    const tick = input => {
      if (performance.now() - startedAt >= maxTimeMs) throw timeStop;
      if (engine.frame - movement.frame >= maxFrames) { hitFrameBudget = true; throw frameStop; }
      observer.beforeTick(input);
      events.push(...input);
      engine.tick(input);
      observer.checkBoundary();
    };
    try {
      let input = [];
      for (const action of actions) {
        if (action === 'floor') {
          tick([...input, key(engine.frame, 'softDrop')]);
          input = [];
          tick([key(engine.frame, 'softDrop', 'keyup')]);
        } else if (action === 'noop') { tick(input); input = []; }
        else {
          input.push(key(engine.frame, action), key(engine.frame, action, 'keyup'));
          if (!compact) { tick(input); input = []; }
        }
      }
      if (input.length) tick(input);
      return { pose: { x: engine.falling.x, rotation: engine.falling.rotation }, events, lock: null };
    } catch (error) {
      if (error === frameStop || error === timeStop) return null;
      if (error !== stop) throw error;
      const expected = target.rotationEvidence;
      const sameOutcome = usedHold === target.usedHold && lock.cells === targetCells && lock.piece === target.piece && lock.rotation === rotation &&
        lock.spin === candidate.projection.spin;
      const matches = sameOutcome && (!expected.lastInputWasRotation ||
          JSON.stringify(lock.evidence) === JSON.stringify(expected));
      // Keep looking for the exact witness within the original budget. A static
      // witness may require stopping above the floor, while the Engine can reach
      // the same spin with a different kick. Preserve the observed evidence;
      // the resolver must re-project it before accepting this opt-in fallback.
      if (allowEquivalentSpinWitness && sameOutcome && !matches && equivalentTrial === null) {
        equivalentTrial = { lock, events, matches: true };
      }
      return { lock, events, matches };
    }
  };
  const result = trial => ({ status: 'planned', controller: INPUT_TARGET_CONTROLLER,
    startedAtFrame: movement.frame, lockedAtFrame: trial.lock.frame,
    lock: { ...trial.lock, usedHold: target.usedHold,
      holdAfter: target.usedHold ? decision.pieces.current : decision.pieces.hold },
    events: trial.events, nodes, elapsedMs: performance.now() - startedAt });

  // Short direct routes first, before bounded target-directed prefix search.
  const hold = target.usedHold ? ['hold'] : [];
  const initial = attempt(hold);
  if (!initial) return notFound();
  if (initial.lock) return { ...notFound(), reason: 'initial-lock' };
  const turn = (rotation - initial.pose.rotation + 4) % 4;
  const turns = turn === 0 ? [] : [turn === 1 ? 'rotateCW' : turn === 2 ? 'rotate180' : 'rotateCCW'];
  // "00" is a no-kick sentinel, not a 0->0 rotation. Its source orientation
  // is unspecified; try all three possible predecessors without changing the
  // canonical evidence contract. Every trial still checks the exact witness.
  const witness = target.rotationEvidence;
  const predecessors = !witness.lastInputWasRotation || !Array.isArray(witness.kickOffset) ? [] :
    witness.kickId === '00' ? [1, 3, 2].map(delta => (rotation - delta + 4) % 4) :
      /^[0-3][0-3]$/.test(witness.kickId ?? '') && Number(witness.kickId[1]) === rotation &&
        Number(witness.kickId[0]) !== rotation ? [Number(witness.kickId[0])] : [];
  const rotationKey = delta => delta === 1 ? 'rotateCW' : delta === 2 ? 'rotate180' : 'rotateCCW';
  const shifts = distance => Array(Math.min(12, Math.abs(distance))).fill(distance < 0 ? 'moveLeft' : 'moveRight');
  const oriented = new Map([[initial.pose.rotation, { prefix: hold, at: initial }]]);
  const prepare = from => {
    if (!oriented.has(from)) {
      const beforeTurn = (from - initial.pose.rotation + 4) % 4;
      const prefix = [...hold, rotationKey(beforeTurn)];
      oriented.set(from, { prefix, at: attempt(prefix) });
    }
    return oriented.get(from);
  };
  for (const from of predecessors) {
    const { prefix, at } = prepare(from);
    if (at && !at.lock) {
      const predecessorX = target.x - witness.kickOffset[0];
      const finalKey = rotationKey((rotation - from + 4) % 4);
      const trial = attempt([...prefix, ...shifts(predecessorX - at.pose.x), 'floor', finalKey, 'hardDrop']);
      if (trial?.matches) return result(trial);
    }
  }
  // Instant soft drop cannot stop at an arbitrary airborne predecessor. Reach
  // it by real sideways inputs or a setup kick instead of assigning a height
  // or changing handling. The final rotation and lock remain Engine-verified.
  for (const from of predecessors) {
    const { prefix, at } = prepare(from);
    if (!at || at.lock) continue;
    const predecessorX = target.x - witness.kickOffset[0];
    const finalKey = rotationKey((rotation - from + 4) % 4);
    for (const offset of [1, -1, 2, -2]) {
      const trial = attempt([...prefix, ...shifts(predecessorX + offset - at.pose.x),
        'floor', ...shifts(-offset), finalKey, 'hardDrop']);
      if (trial?.matches) return result(trial);
    }
    const table = kickData[inputExecutionOptions({ seed: 0 }).kickset];
    for (const delta of [1, 3, 2]) {
      const setupFrom = (from - delta + 4) % 4;
      const setup = prepare(setupFrom);
      if (!setup.at || setup.at.lock) continue;
      const tests = (table[`${target.piece.toLowerCase()}_kicks`] ?? table.kicks)?.[`${setupFrom}${from}`] ?? [];
      // Invert only possible horizontal kick offsets to propose entry columns.
      // The Engine establishes the actual vertical kick and predecessor pose.
      for (const dx of new Set([0, ...tests.map(([x]) => x)])) {
        const trial = attempt([...setup.prefix, ...shifts(predecessorX - dx - setup.at.pose.x),
          'floor', rotationKey(delta), finalKey, 'hardDrop']);
        if (trial?.matches) return result(trial);
      }
    }
  }
  for (const floor of [false, true]) {
    for (const rotateFirst of [true, false]) {
      const prefix = [...hold, ...(rotateFirst ? turns : [])];
      // These prefixes were already simulated from the same public boundary.
      // Reuse their poses so a direct fallback takes at most three trials.
      const at = rotateFirst ? prepare(rotation).at : initial;
      if (!at || at.lock) continue;
      const distance = target.x - at.pose.x;
      const shift = Array(Math.min(12, Math.abs(distance))).fill(distance < 0 ? 'moveLeft' : 'moveRight');
      const actions = [...prefix, ...shift, ...(floor ? ['floor'] : []), ...(!rotateFirst ? turns : []), 'hardDrop'];
      const trial = attempt(actions);
      if (trial?.matches) return result(trial);
      if (compactInputs) {
        const paced = attempt(actions, false);
        if (paced?.matches) return result(paced);
      }
    }
  }
  // Plain tucks need lateral movement AFTER the drop. Approaching the target
  // column from above only lands on its roof. Try nearby entry columns before
  // spending the remaining budget on the general prefix search.
  if (!witness.lastInputWasRotation) {
    const prefix = [...hold, ...turns];
    const at = attempt(prefix);
    if (at && !at.lock) {
      for (const offset of [1, -1, 2, -2]) {
        const distance = target.x + offset - at.pose.x;
        const shift = Array(Math.min(12, Math.abs(distance))).fill(distance < 0 ? 'moveLeft' : 'moveRight');
        const slide = Array(Math.abs(offset)).fill(offset > 0 ? 'moveLeft' : 'moveRight');
        const trial = attempt([...prefix, ...shift, 'floor', ...slide, 'hardDrop']);
        if (trial?.matches) return result(trial);
      }
    }
  }
  const queue = [hold];
  let cursor = 0;
  while (cursor < queue.length && nodes < maxNodes) {
    if (performance.now() - startedAt >= maxTimeMs) break;
    const path = queue[cursor++];
    const probe = attempt([...path, 'hardDrop']);
    if (probe?.matches) return result(probe);
    if (path.length >= Math.min(16, maxFrames - 1)) continue;
    const at = attempt(path);
    if (!at || at.lock) continue;
    const preferred = target.x < at.pose.x ? 'moveLeft' : 'moveRight';
    for (const action of [preferred, 'rotateCW', 'rotateCCW', 'rotate180', 'floor', preferred === 'moveLeft' ? 'moveRight' : 'moveLeft']) {
      if (queue.length >= maxNodes) break;
      queue.push([...path, action]);
    }
  }
  return notFound();
}

/** Predict only idle movement to a future input boundary. A natural lock stops
 * before merge; no private garbage or future queue result can enter this job. */
export function forecastInputBoundary(request, movement, frame) {
  assertInputDecisionRequest(request);
  validateInputPublicMovement(movement);
  if (!Number.isSafeInteger(movement.frame) || movement.frame < 0 || !Number.isSafeInteger(frame) ||
      frame < movement.frame || frame > movement.frame + 120 || frame > MAX_TTRM_FRAMES_PER_PLAYER ||
      request.decision.lockTime.logicalFrame !== movement.frame) throw new Error('invalid input forecast frame');
  const { board, pieces } = request.decision;
  if (board.width !== 10 || board.height !== 40 || board.visibleHeight !== 20 || !/^[IJLOSTZG_]{400}$/.test(board.cells) ||
      !Array.isArray(pieces.known) || pieces.known.length > 14 || pieces.known.some(value => !/^[IJLOSTZ]$/.test(value)) ||
      pieces.current?.toLowerCase() !== movement.falling.symbol ||
      JSON.stringify(movement.handling) !== JSON.stringify(INPUT_EXECUTION_PROFILE.handling)) throw new Error('invalid input forecast profile');
  const engine = neutralEngine(request.decision, movement);
  engine.board.add = () => { throw new Error('input forecast crosses a natural lock'); };
  while (engine.frame < frame) engine.tick([]);
  const decision = structuredClone(request.decision);
  decision.lockTime.logicalFrame = frame;
  return { request: { ...request, decision }, movement: projectInputPublicMovement(engine) };
}

function neutralEngine(decision, movement) {
  const options = inputExecutionOptions({ seed: 0 });
  const engine = new Engine(buildEngineConfig(options, []));
  // This snapshot originates here with constant seeds and an empty queue of
  // garbage. It is never a referee snapshot or a public cache identity.
  const snapshot = engine.snapshot();
  snapshot.board = Array.from({ length: 40 }, (_, y) => Array.from({ length: 10 }, (_, x) => {
    const symbol = decision.board.cells[y * 10 + x];
    return symbol === '_' ? null : { mino: symbol === 'G' ? 'gb' : symbol.toLowerCase() };
  }));
  snapshot.falling = structuredClone(movement.falling);
  snapshot.input = structuredClone(movement.input);
  for (const field of ['subframe', 'hold', 'holdLocked', 'lastSpin', 'lastWasClear', 'glock', 'state']) snapshot[field] = movement[field];
  snapshot.queue.value = decision.pieces.known.map(value => value.toLowerCase());
  snapshot.stats.combo = decision.chain.combo - 1;
  snapshot.stats.b2b = decision.chain.b2b - 1;
  snapshot.stats.pieces = decision.lockTime.piecesPlaced;
  engine.fromSnapshot(snapshot);
  engine.frame = movement.frame;
  engine.dynamic.gravity.set(dynamicValue({ base: options.g, increase: options.gincrease,
    marginFrames: options.gmargin }, movement.frame));
  engine.dynamic.gravity.frame = movement.frame;
  // Attack/cap cannot affect a merge-boundary-only reachability result.
  return engine;
}
