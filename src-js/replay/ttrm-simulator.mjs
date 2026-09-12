/**
 * `.ttrm` input log to ReplayIR, replayed through the pinned Triangle Engine.
 *
 * Ported from `fumen-mobile-fork` (`src/lib/ttrm/simulator.ts`, MIT) onto this
 * repository's own `@haelp/teto` 4.2.7 dependency.  The produced
 * `PlayerRoundIR` is the same shape `src-js/replay-lock-conformance.mjs`
 * consumes. GUI import checks three recorded aggregates; comparison against the
 * canonical Simulator is a separate, stronger validation of this object.
 *
 * Raw `.ttrm` event frames are input scheduling frames: a placement's real lock
 * frame only exists once the engine has replayed the log, which is why locks
 * are captured from engine events rather than inferred from hard-drop keys.
 */

import { Engine } from "@haelp/teto/engine";

import { convertEngineBoard } from "./board-converter.mjs";
import { buildEngineConfig, inputExecutionOptions, INPUT_EXECUTION_PROFILE } from "./engine-config.mjs";
import { createInputLockConformance } from "../triangle/input-lock-conformance.mjs";
import { projectInputPublicMovement } from "../triangle/input-public-movement.mjs";
import { triangleSnapshotToCanonical } from "../triangle/garbage-adapter.mjs";
import { createS2AmountOnlyDecisionState } from "../s2-amount-only-decision-state.mjs";
import { PIECE, isMinoPiece, minoToPiece } from "./pieces.mjs";
import { TtrmError, validateTtrmPlayerRound, MAX_TTRM_EVENTS_PER_PLAYER } from "./ttrm-parser.mjs";
import { resolveTtrmOptions } from "./ttrm-options.mjs";

export function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

// Everything the engine currently holds, not the displayed count: the preview
// the viewer shows is cut on screen so no queue evidence is thrown away here.
function readQueue(engine) {
  return Array.prototype.slice.call(engine.queue).map(minoToPiece).filter(isMinoPiece);
}

// The engine spawns the next piece inside its own lock handling, so at
// `falling.lock` the current `falling` is already the piece placed next.
function readFalling(engine) {
  const symbol = engine.falling?.symbol;
  if (symbol === undefined) return null;
  const piece = minoToPiece(symbol);
  return isMinoPiece(piece) ? piece : null;
}

function readActiveFrame(engine, frame) {
  if (engine.falling === undefined) return undefined;
  const piece = minoToPiece(engine.falling.symbol);
  if (!isMinoPiece(piece)) return undefined;
  return {
    frame,
    piece,
    rotation: engine.falling.rotation,
    x: engine.falling.x,
    y: engine.falling.y,
    cells: engine.falling.absoluteBlocks.map(([x, y]) => [x, y]),
  };
}

function readQueueFrame(engine, frame) {
  return {
    frame,
    hold: engine.held !== null && engine.held !== undefined ? minoToPiece(engine.held) : null,
    current: readFalling(engine),
    next: readQueue(engine),
  };
}

function readBoardFrame(engine, frame) {
  return { frame, ...convertEngineBoard(engine.board.state) };
}

function readGarbageFrame(engine, frame) {
  return { frame, snapshot: engine.garbageQueue.snapshot() };
}

function sameNumbers(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameCells(a, b) {
  return a.length === b.length && a.every((cell, index) => cell[0] === b[index][0] && cell[1] === b[index][1]);
}

function sameActive(a, b) {
  return a.piece === b.piece && a.rotation === b.rotation && a.x === b.x && a.y === b.y &&
    sameCells(a.cells, b.cells);
}

function sameBoard(a, b) {
  return a.sourceHeight === b.sourceHeight && a.clippedRowCount === b.clippedRowCount &&
    sameNumbers(a.field, b.field) && sameNumbers(a.fullField, b.fullField);
}

function sameQueue(a, b) {
  return a.hold === b.hold && a.current === b.current && sameNumbers(a.next, b.next);
}

function sameGarbage(a, b) {
  return JSON.stringify(a.snapshot) === JSON.stringify(b.snapshot);
}

// A frame that changes several times (hold then hard drop, for instance) is
// displayed as its final state only, so the last entry of that frame is
// replaced instead of appended, keeping the series strictly ascending.
function recordChange(points, next, equal) {
  const last = points[points.length - 1];
  if (last !== undefined && last.frame === next.frame) {
    if (!equal(last, next)) points[points.length - 1] = next;
    return;
  }
  if (last === undefined || !equal(last, next)) points.push(next);
}

// Depending on the replay version the garbage payload is either the confirm
// envelope itself or one level below it. Only that payload frame is the sender
// clock; the event frame and the IGE envelope frame belong to the receiver.
function rawConfirmSenderFrames(playerRound) {
  const frames = new Map();
  for (const event of playerRound.replay.events) {
    const ige = event.type === "ige" ? event.data : undefined;
    const envelope = ige !== undefined && ige.type === "interaction_confirm" ? ige.data : undefined;
    const payload = envelope !== undefined && typeof envelope.data === "object" ? envelope.data : undefined;
    const iid = envelope?.iid ?? payload?.iid;
    const gameid = envelope?.gameid ?? payload?.gameid;
    const senderFrame = payload?.frame ?? envelope?.frame;
    const type = payload?.type ?? envelope?.type;
    if (envelope === undefined || type !== "garbage" ||
        typeof iid !== "number" || typeof gameid !== "number" ||
        typeof senderFrame !== "number" || !Number.isFinite(senderFrame)) {
      continue;
    }
    const key = `${gameid}:${iid}`;
    const values = frames.get(key) ?? [];
    values.push(senderFrame);
    frames.set(key, values);
  }
  return frames;
}

// The round's starting position (zero placements). `Engine#falling` and
// `Engine#queue` are not optional by type, but the engine is ticked once and
// read again in case the construction left them uninitialised.
function readInitialPoint(engine) {
  const read = () => ({
    frame: 0,
    ...convertEngineBoard(engine.board.state),
    hold: engine.held !== null && engine.held !== undefined ? minoToPiece(engine.held) : null,
    current: readFalling(engine),
    next: readQueue(engine),
  });

  const initial = read();
  if (initial.current !== null && initial.next.length > 0) return initial;
  engine.tick([]);
  return read();
}

function collectOpponents(playerRound) {
  const opponents = [];
  for (const event of playerRound.replay.events) {
    const data = event.data && event.data.data;
    if (data && data.gameid !== null && data.gameid !== undefined && !opponents.includes(data.gameid)) {
      opponents.push(data.gameid);
    }
    if (data && data.targets) {
      for (const target of data.targets) {
        if (!opponents.includes(target)) opponents.push(target);
      }
    }
  }
  return opponents;
}

/**
 * Simulates one player round: ticks the engine over the input log, captures a
 * lock point per placement, then keeps ticking to `replay.frames` so that the
 * terminal state includes post-lock garbage.  The losing side's killing garbage
 * lands after its final lock and no lock point captures it.
 */
export function simulatePlayerRound(playerRound, options = {}) {
  const runtime = createInputReplaySession(playerRound, options);
  // `end` events are skipped and the engine keeps ticking to `replay.frames`.
  const events = playerRound.replay.events;
  let eventIndex = 0;
  while (eventIndex < events.length) {
    while (runtime.frame < events[eventIndex].frame) {
      runtime.tick([]);
    }
    while (eventIndex < events.length && events[eventIndex].frame < runtime.frame) eventIndex += 1;
    const toTick = [];
    while (eventIndex < events.length && events[eventIndex].frame === runtime.frame) {
      const event = events[eventIndex++];
      if (event.type === "end") continue;
      toTick.push(event);
    }
    runtime.tick(toTick);
  }
  while (runtime.frame < playerRound.replay.frames) {
    runtime.tick([]);
  }

  return runtime.finish();
}

/** Referee-owned input runtime. The replay importer is also a production caller.
 * Session snapshots and observations are not policy input.
 */
export function createInputReplaySession(playerRound, { maxTimeMs = 10_000, signal = null, now = nowMs, canonicalProfile = null,
  forgiveStallPenalty = false } = {}) {
  validateTtrmPlayerRound(playerRound);
  if (!Number.isFinite(maxTimeMs) || maxTimeMs <= 0 || maxTimeMs > 10_000) {
    throw new TtrmError("budget", "replay time budget must be positive and at most 10000ms");
  }
  if (typeof now !== "function") throw new TtrmError("budget", "input session clock must be a function");
  const constructionStart = now();
  let processingMs = 0;
  playerRound = structuredClone(playerRound);
  const checkBudget = () => {
    if (signal?.aborted) throw new TtrmError("cancel", "replay cancelled");
    if (processingMs > maxTimeMs) throw new TtrmError("budget", "replay exceeded its processing time budget");
  };
  checkBudget();
  const { options, warnings } = resolveTtrmOptions(playerRound.replay);

  if ((options.boardwidth ?? 10) !== 10 || (options.boardheight ?? 20) !== 20) {
    throw new TtrmError("validate", "replay requires a 10 by 20 board with the fixed 20-row buffer");
  }

  const config = buildEngineConfig(options, collectOpponents(playerRound));
  // Bound work *inside* a tick too: tiny positive ARR makes the pinned Engine
  // iterate floor(elapsed / ARR) shifts before a deadline can be checked.
  for (const key of ["arr", "das", "dcd", "sdf"]) {
    const value = config.handling[key];
    if (!Number.isFinite(value) || value < 0 || value > 60 ||
        (key === "arr" && value > 0 && value < 0.01)) {
      throw new TtrmError("validate", `unsupported handling ${key}`);
    }
  }
  if (canonicalProfile !== null) {
    const expected = inputExecutionOptions({ seed: options.seed, profileId: canonicalProfile, handling: options.handling });
    for (const key of Object.keys(expected)) {
      if (JSON.stringify(options[key]) !== JSON.stringify(expected[key])) {
        throw new TtrmError("profile", `canonical input profile option mismatch: ${key}`);
      }
    }
  }
  const engine = new Engine(config);
  if (canonicalProfile === INPUT_EXECUTION_PROFILE.id) {
    // Queue#shift replenishes before consuming; keep one extra item buffered
    // so the public queue still exposes the profile's full NEXT window after a shift.
    engine.queue.minLength = INPUT_EXECUTION_PROFILE.publicNext + 1;
  }
  const conformance = canonicalProfile === null ? null : createInputLockConformance(engine, INPUT_EXECUTION_PROFILE.rulesetId);
  let externallyMutated = false;

  // The starting position is overwritten by the first tick, so it is read here.
  const initial = readInitialPoint(engine);

  const locks = [];
  let heldSinceLock = false;
  const hold = engine.hold.bind(engine);
  engine.hold = (...args) => {
    const result = hold(...args);
    if (result) heldSinceLock = true;
    return result;
  };
  const outgoing = [];
  const send = engine.igeHandler.send.bind(engine.igeHandler);
  engine.igeHandler.send = (packet) => {
    send(packet);
    if (packet.amount === 0) return;
    const snapshot = engine.igeHandler.snapshot();
    outgoing.push({ frame: engine.frame, amount: packet.amount,
      target: packet.playerID, iid: snapshot.iid,
      ackiid: snapshot.players[packet.playerID].incoming,
      // A visual beam anchor only: convert the observed lock's block centroid
      // from bottom-up Engine rows to TETR.IO's top-down board coordinates.
      x: preLock.cells.reduce((sum, [x]) => sum + x, 0) / preLock.cells.length,
      y: engine.board.state.length - 1 - preLock.cells.reduce((sum, [, y]) => sum + y, 0) / preLock.cells.length,
    });
  };
  const garbageEvents = [];
  const visual = { active: [], boards: [], queues: [], garbage: [] };
  const confirmSenderFrames = new Map();
  const countedConfirms = new Set();
  let receivedAtConfirm = 0;
  let cancelledRows = 0;
  let totalLines = 0;
  let prevAttack = 0;
  let prevGarbageCleared = 0;

  const recordActive = (frame) => {
    const active = readActiveFrame(engine, frame);
    if (active !== undefined) recordChange(visual.active, active, sameActive);
  };
  const recordBoard = (frame, board) => {
    recordChange(visual.boards, board !== undefined ? { frame, ...board } : readBoardFrame(engine, frame), sameBoard);
  };
  const recordQueue = (frame, queue) => {
    recordChange(visual.queues, queue ?? readQueueFrame(engine, frame), sameQueue);
  };
  const recordGarbage = (frame) => {
    recordChange(visual.garbage, readGarbageFrame(engine, frame), sameGarbage);
  };

  recordActive(0);
  recordBoard(0);
  recordQueue(0, { frame: 0, hold: initial.hold, current: initial.current, next: initial.next });
  recordGarbage(0);

  // Pinned Engine 4.2.7 calls Board.add exactly once per lock, before
  // line clearing and garbage. Its lock.pre event occurs after those changes.
  // Observe this instance's merge boundary so even two locks in one tick have
  // distinct true pre-states. Never modify the shared Board prototype.
  let preLock = null;
  let lastPlacedBlocks = new Set();
  const add = engine.board.add;
  engine.board.add = function (...args) {
    const rotationEvidence = !externallyMutated ? conformance?.beforeMerge() ?? null : null;
    lastPlacedBlocks = new Set(args.map(([block]) => block));
    preLock = {
      rotationEvidence,
      usedHold: heldSinceLock,
      fieldBefore: readBoardFrame(engine, engine.frame),
      subframe: engine.subframe,
      piece: minoToPiece(engine.falling.symbol),
      rotation: engine.falling.rotation,
      x: engine.falling.x,
      y: engine.falling.y,
      cells: engine.falling.absoluteBlocks.map(([x, y]) => [x, y]),
    };
    return add.apply(this, args);
  };

  // HOLD and the post-lock spawn take effect on this raw frame rather than at
  // the end of the tick. Several spawns inside one frame collapse to the last.
  engine.events.on("falling.new", () => {
    recordActive(engine.frame);
    recordQueue(engine.frame);
  });
  engine.events.on("queue.add", () => {
    recordQueue(engine.frame);
  });

  engine.events.on("falling.lock", (res) => {
    if (!externallyMutated) conformance?.afterLock(res);
    if (preLock === null) throw new TtrmError("observe", "lock arrived without a pre-merge observation");
    const after = convertEngineBoard(engine.board.state);
    totalLines += res.lines || 0;
    const attack = Math.max(0, (res.stats.garbage.attack ?? 0) - prevAttack);
    prevAttack = res.stats.garbage.attack ?? prevAttack;
    const garbageCleared = Math.max(0, (res.stats.garbage.cleared ?? 0) - prevGarbageCleared);
    prevGarbageCleared = res.stats.garbage.cleared ?? prevGarbageCleared;
    const queue = readQueueFrame(engine, engine.frame);
    locks.push({
      attack,
      garbageCleared,
      pieceIndex: locks.length,
      frame: engine.frame,
      ordinal: locks.length > 0 && locks.at(-1).frame === engine.frame ? locks.at(-1).ordinal + 1 : 0,
      subframe: preLock?.subframe ?? 0,
      fieldBefore: preLock.fieldBefore.field,
      fullFieldBefore: preLock.fieldBefore.fullField,
      fullFieldAfter: after.fullField,
      fieldAfter: after.field,
      piece: preLock ? preLock.piece : minoToPiece(res.mino),
      rotation: preLock ? preLock.rotation : 0,
      x: preLock ? preLock.x : 0,
      y: preLock ? preLock.y : 0,
      cells: preLock ? preLock.cells : undefined,
      ...(preLock.rotationEvidence === null ? {} : { rotationEvidence: preLock.rotationEvidence, usedHold: preLock.usedHold }),
      hold: queue.hold,
      current: queue.current,
      next: queue.next,
      clear: {
        lines: res.lines || 0,
        spin: res.spin || "none",
        b2b: res.stats.b2b ?? 0,
        ren: res.stats.combo ?? 0,
        perfectClear: (res.lines || 0) > 0 && after.field.every((cell) => cell === PIECE.EMPTY),
      },
      garbageGauge: engine.garbageQueue.size ?? 0,
      sourceHeight: after.sourceHeight,
      clippedRowCount: after.clippedRowCount,
    });
    recordBoard(engine.frame, after);
    recordActive(engine.frame);
    recordQueue(engine.frame, queue);
    recordGarbage(engine.frame);
    preLock = null;
    heldSinceLock = false;
  });

  // The gauge identity (receive - cancel - tank == garbageQueue.size) holds for
  // the post-passthrough amount, not for `originalAmount`.
  engine.events.on("garbage.receive", (event) => {
    garbageEvents.push({ frame: engine.frame, kind: "receive", iid: event.iid, amount: event.amount ?? 0 });
    recordGarbage(engine.frame);
  });
  engine.events.on("garbage.confirm", (event) => {
    const identity = `${event.gameid}:${event.iid}`;
    if (!countedConfirms.has(identity)) {
      receivedAtConfirm += engine.garbageQueue.snapshot().queue
        .filter(packet => packet.gameid === event.gameid && packet.cid === event.iid)
        .reduce((sum, packet) => sum + packet.amount, 0);
      countedConfirms.add(identity);
    }
    const senderFrames = confirmSenderFrames.get(`${event.gameid}:${event.iid}`);
    const senderFrame = senderFrames !== undefined && senderFrames.length > 0 ? senderFrames.shift() : undefined;
    garbageEvents.push({
      frame: engine.frame,
      kind: "confirm",
      iid: event.iid,
      amount: 0,
      gameid: event.gameid,
      senderFrame: senderFrame ?? event.frame,
    });
    recordGarbage(engine.frame);
  });
  engine.events.on("garbage.tank", (event) => {
    garbageEvents.push({
      frame: engine.frame,
      kind: "tank",
      iid: event.iid,
      amount: event.amount ?? 0,
      column: event.column,
      size: event.size,
    });
    recordBoard(engine.frame);
    recordGarbage(engine.frame);
  });
  engine.events.on("garbage.cancel", (event) => {
    cancelledRows += event.amount ?? 0;
    garbageEvents.push({
      frame: engine.frame,
      kind: "cancel",
      iid: event.iid,
      amount: event.amount ?? 0,
      size: event.size,
    });
    recordGarbage(engine.frame);
  });

  processingMs += now() - constructionStart;
  checkBudget();
  let status = "active";
  let finished = null;
  let failure = null;
  const executedEvents = [];
  let stallPenaltyRows = 0;
  const board = engine.board;
  const originalClearBombsAndLines = board.clearBombsAndLines.bind(board);
  const originalInsertGarbage = board.insertGarbage.bind(board);
  const emptyRow = () => Array(board.width).fill(null);
  const penaltyRow = () => Array.from({ length: board.width }, () =>
    ({ mino: "bomb", connections: 0, stallPenalty: true }));
  const disableConformance = () => {
    externallyMutated = true;
    conformance?.disable();
  };
  const withPenaltyFloorDetached = (work) => {
    if (stallPenaltyRows === 0) return work();
    const floor = board.state.splice(0, stallPenaltyRows);
    board.state.push(...Array.from({ length: stallPenaltyRows }, emptyRow));
    try { return work(); }
    finally {
      board.state.splice(board.state.length - stallPenaltyRows, stallPenaltyRows);
      board.state.unshift(...floor);
    }
  };
  // The local floor is collision geometry, not a Simulator line. Keep it out
  // of line clears, garbage insertion and perfect-clear attack calculation.
  board.clearBombsAndLines = (placedBlocks) => withPenaltyFloorDetached(() =>
    originalClearBombsAndLines(placedBlocks.map(([x, y]) => [x, y - stallPenaltyRows])));
  board.insertGarbage = (packet) => withPenaltyFloorDetached(() => originalInsertGarbage(packet));
  Object.defineProperty(board, "perfectClear", { configurable: true, get() {
    return board.state.slice(stallPenaltyRows).every(row => row.every(cell => cell === null));
  } });
  const removeStallPenaltyLine = () => {
    if (status !== "active" || stallPenaltyRows === 0) return { rows: stallPenaltyRows };
    if (!board.state[0].every(cell => cell?.stallPenalty === true)) {
      throw new TtrmError("execute", "STALL PENALTY floor identity was lost");
    }
    board.state.shift();
    board.state.push(emptyRow());
    stallPenaltyRows -= 1;
    return { rows: stallPenaltyRows };
  };
  if (forgiveStallPenalty) {
    let ordinaryLocks = 0;
    // Pinned Engine emits lock.pre after clear/attack/garbage resolution but
    // before nextPiece performs blockout and Clutch. Forgive on that board,
    // without moving the next spawn or reviving an already terminal Engine.
    engine.events.on("falling.lock.pre", () => {
      ordinaryLocks = (ordinaryLocks + 1) % 5;
      if (ordinaryLocks === 0) removeStallPenaltyLine();
    });
  }
  return {
    get frame() { return engine.frame; },
    get canonicalProfile() { return canonicalProfile; },
    get status() { return status; },
    get failure() { return failure; },
    get lockCount() { return locks.length; },
    get processingMs() { return processingMs; },
    get toppedOut() { return engine.toppedOut; },
    get stallPenaltyRows() { return stallPenaltyRows; },
    refereeLastLock() { return structuredClone(locks.at(-1) ?? null); },
    refereeView() {
      return { board: engine.board.state.map(row => row.map(cell => cell === null ? null :
        cell.stallPenalty === true ? 'P' : cell.mino.length === 1 ? cell.mino.toUpperCase() : 'G')),
        lastPlaced: engine.board.state.flatMap((row, y) => row.flatMap((cell, x) => lastPlacedBlocks.has(cell) ? [[x, y]] : [])),
        current: engine.falling.symbol.toUpperCase(), hold: engine.held?.toUpperCase() ?? null,
        next: Array.from(engine.queue).slice(0, 14).map(value => value.toUpperCase()),
        activeCells: engine.falling.absoluteBlocks.map(cell => [...cell]),
        holdAvailable: !engine.holdLocked, toppedOut: engine.toppedOut,
        stats: structuredClone(engine.stats), lastLock: structuredClone(locks.at(-1) ?? null),
        // Display-only amounts/readiness. No packet identity, hole or RNG is exposed.
        // Readiness means arrival for a hard drop now; cap/FIFO/clear blocking
        // still determine how many rows actually rise. Natural locks use frame - 1.
        pendingRows: engine.garbageQueue.size,
        pendingChunks: engine.garbageQueue.queue.map(packet => ({ amount: packet.amount,
          ready: packet.frame + engine.garbageQueue.options.garbage.speed <= engine.frame })),
        cancelledRows,
        received: receivedAtConfirm };
    },
    publicState() {
      if (canonicalProfile === null || status !== 'active') throw new TtrmError('profile', 'active input profile required');
      const state = {
        rulesetId: INPUT_EXECUTION_PROFILE.rulesetId,
        board: { width: 10, height: 40, visibleHeight: 20, fidelity: 'exact',
          cells: engine.board.state.flatMap(row => row.map(cell => cell === null ? '_' :
            cell.mino.length === 1 ? cell.mino.toUpperCase() : 'G')).join('') },
        pieces: { current: engine.falling.symbol.toUpperCase(), hold: engine.held?.toUpperCase() ?? null,
          holdAvailable: !engine.holdLocked, known: Array.from(engine.queue).slice(0, INPUT_EXECUTION_PROFILE.publicNext).map(value => value.toUpperCase()), fidelity: 'exact' },
        chain: { combo: Math.max(0, engine.stats.combo + 1), b2b: Math.max(0, engine.stats.b2b + 1), fidelity: 'exact' },
        time: { logicalFrame: engine.frame, piecesPlaced: engine.stats.pieces, frameSemantics: 'engine-frame', fidelity: 'exact' },
        garbage: triangleSnapshotToCanonical(engine.garbageQueue.snapshot(), { capState: { consumedThisTick: 0 }, fidelity: 'exact' }),
      };
      return { decision: createS2AmountOnlyDecisionState(state), movement: projectInputPublicMovement(engine) };
    },
    executedEvents() { return structuredClone(executedEvents); },
    takeOutgoing() { return outgoing.splice(0); },
    applyStallPenaltyLine() {
      if (status !== "active") throw new TtrmError("execute", "input session is not active");
      disableConformance();
      const overflow = board.state.at(-1).some(cell => cell !== null);
      board.state.pop();
      board.state.unshift(penaltyRow());
      stallPenaltyRows += 1;
      engine.falling.location[1] += 1;
      engine.falling.highestY += 1;
      recordBoard(engine.frame);
      recordActive(engine.frame);
      // No Lockout: occupied hidden rows do not end a TETR.IO input round.
      // The current piece rises with the stack and remains playable. Ordinary
      // next-piece blockout (including Clutch) stays owned by Engine; only
      // exhausting the full board buffer is terminal at this external rise.
      return { rows: stallPenaltyRows, toppedOut: overflow || stallPenaltyRows >= board.state.length };
    },
    removeStallPenaltyLine() {
      if (status !== "active" || stallPenaltyRows === 0) return { rows: stallPenaltyRows };
      removeStallPenaltyLine();
      engine.falling.location[1] -= 1;
      engine.falling.highestY -= 1;
      recordBoard(engine.frame);
      recordActive(engine.frame);
      return { rows: stallPenaltyRows };
    },
    prepareStallForcedLock() {
      if (status !== "active") throw new TtrmError("execute", "input session is not active");
      disableConformance();
      const piece = engine.falling.symbol;
      engine.falling.rotation = engine.kickTable.spawn_rotation[piece] ?? 0;
      engine.falling.location[0] = piece === "o" ? 4 : 3;
      engine.falling.location[1] = board.height + 2.04 + stallPenaltyRows;
      engine.falling.highestY = board.height + 2 + stallPenaltyRows;
      recordActive(engine.frame);
    },
    tick(events) {
      if (status !== "active") throw new TtrmError("execute", "input session is not active");
      const startedAt = now();
      try {
        checkBudget();
        validateTtrmPlayerRound({ id: playerRound.id, replay: {
          frames: engine.frame, events, options: {}, results: { stats: {} },
        } });
        if (events.some(event => event.frame !== engine.frame)) {
          throw new TtrmError("execute", "input event does not belong to the current frame");
        }
        if (executedEvents.length + events.length > MAX_TTRM_EVENTS_PER_PLAYER) {
          throw new TtrmError("size", "input session event budget exceeded");
        }
        const consumed = structuredClone(events);
        for (const [key, frames] of rawConfirmSenderFrames({ replay: { events: consumed } })) {
          const pendingFrames = confirmSenderFrames.get(key) ?? [];
          pendingFrames.push(...frames);
          confirmSenderFrames.set(key, pendingFrames);
        }
        if (!externallyMutated) conformance?.beforeTick(consumed);
        engine.tick(consumed);
        if (!externallyMutated) conformance?.checkBoundary();
        executedEvents.push(...consumed);
        recordActive(engine.frame);
        processingMs += now() - startedAt;
        checkBudget();
      } catch (error) {
        status = "invalid";
        failure = error instanceof Error ? error.message : String(error);
        throw error;
      }
    },
    finish() {
      if (status === "invalid") throw new TtrmError("execute", "invalid input session cannot be finalized");
      if (finished !== null) return structuredClone(finished);
      checkBudget();
      if (!externallyMutated) conformance?.checkBoundary();
      const terminalBoard = convertEngineBoard(engine.board.state);
      const terminalQueue = readQueueFrame(engine, engine.frame);
      recordBoard(engine.frame, terminalBoard);
      recordQueue(engine.frame, terminalQueue);
      recordGarbage(engine.frame);
      const stats = playerRound.replay.results.stats;
      const actualSent = engine.stats.garbage.sent ?? 0;
      const verification = {
        scope: "pieces-lines-sent",
        piecesplaced: { expected: stats.piecesplaced, actual: locks.length },
        lines: { expected: stats.lines, actual: totalLines },
        sent: { expected: stats.garbage.sent, actual: actualSent },
        matched: stats.piecesplaced === locks.length &&
          stats.lines === totalLines &&
          stats.garbage.sent === actualSent,
      };

      finished = {
        observedStats: structuredClone(engine.stats),
        recordedStats: { piecesplaced: locks.length, lines: totalLines, garbage: {
          attack: engine.stats.garbage.attack, sent: engine.stats.garbage.sent,
          received: receivedAtConfirm, cleared: engine.stats.garbage.cleared,
        } },
        canonicalLockVerification: conformance === null || externallyMutated ? null :
          { comparedLocks: conformance.comparedLocks, scope: "lock-and-garbage-queue", matched: true },
        initial,
        locks,
        garbageEvents,
        verification,
        visual,
        id: playerRound.id,
        username: playerRound.username,
        resolvedOptions: options,
        optionWarnings: warnings,
        terminal: {
          frame: engine.frame,
          field: terminalBoard.field,
          fullField: terminalBoard.fullField,
          sourceHeight: terminalBoard.sourceHeight,
          clippedRowCount: terminalBoard.clippedRowCount,
          garbageGauge: engine.garbageQueue.size ?? 0,
          hold: terminalQueue.hold,
          current: terminalQueue.current,
          next: terminalQueue.next,
          reason: playerRound.replay.results.gameoverreason,
          alive: playerRound.alive,
    },
  };
  status = "finished";
  return structuredClone(finished);
    },
  };
}


function buildRound(round, index) {
  const reasons = {};
  for (const player of round) reasons[player.id] = player.replay.results.gameoverreason;
  const winner = round.find((player) => player.replay.results.gameoverreason === "winner");

  const base = {
    index,
    startFrame: 0,
    endFrame: Math.max(...round.map((player) => player.replay.frames)),
    result: { reasons, winnerId: winner ? winner.id : null },
  };

  try {
    const players = round.map(simulatePlayerRound);
    const mismatched = players.find((player) => !player.verification.matched);
    if (mismatched !== undefined) {
      const v = mismatched.verification;
      return {
        ...base,
        players,
        status: "failed",
        failure: {
          stage: "verify",
          message: `${mismatched.username}: pieces ${v.piecesplaced.actual}/${v.piecesplaced.expected},` +
            ` lines ${v.lines.actual}/${v.lines.expected}, sent ${v.sent.actual}/${v.sent.expected}`,
        },
      };
    }
    // Import success means Engine replay and the three aggregate checks passed;
    // it does not assert canonical lock, garbage, or full terminal-state equality.
    return { ...base, players, status: "ok" };
  } catch (error) {
    return {
      ...base,
      players: [],
      status: "failed",
      failure: {
        stage: error instanceof TtrmError ? error.stage : "simulate",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

/** Builds the whole ReplayIR. `startedAt` lets the caller include JSON parsing. */
export function buildReplayIR(file, startedAt = nowMs()) {
  const rounds = file.replay.rounds.map(buildRound);
  return {
    rounds,
    meta: {
      // Preserve the known self-declared display marker, not arbitrary metadata
      // or a claim that the file's origin has been authenticated.
      ...(file.meta?.origin === "s2-bot-lab-generated" ? { origin: file.meta.origin } : {}),
      users: (file.users ?? []).map((user) => ({ id: user.id, username: user.username })),
      gamemode: file.gamemode ?? "",
      ts: file.ts ?? "",
      version: file.version ?? 1,
      parseMs: Math.round(nowMs() - startedAt),
    },
  };
}
