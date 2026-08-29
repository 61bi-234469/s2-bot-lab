/**
 * `.ttrm` input log to ReplayIR, replayed through the pinned Triangle Engine.
 *
 * Ported from `fumen-mobile-fork` (`src/lib/ttrm/simulator.ts`, MIT) onto this
 * repository's own `@haelp/teto` 4.2.7 dependency.  The produced
 * `PlayerRoundIR` is the same shape `src-js/replay-lock-conformance.mjs`
 * consumes, so a replay imported by the GUI and a replay verified against the
 * canonical Simulator are the same object.
 *
 * Raw `.ttrm` event frames are input scheduling frames: a placement's real lock
 * frame only exists once the engine has replayed the log, which is why locks
 * are captured from engine events rather than inferred from hard-drop keys.
 */

import { Engine } from "@haelp/teto/engine";

import { convertEngineBoard } from "./board-converter.mjs";
import { buildEngineConfig } from "./engine-config.mjs";
import { PIECE, isMinoPiece, minoToPiece } from "./pieces.mjs";
import { TtrmError } from "./ttrm-parser.mjs";
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
    sameNumbers(a.field, b.field);
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
    field: convertEngineBoard(engine.board.state).field,
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
export function simulatePlayerRound(playerRound) {
  const { options, warnings } = resolveTtrmOptions(playerRound.replay);

  if ((options.boardwidth ?? 10) !== 10) {
    throw new TtrmError("validate", `unsupported board width: ${options.boardwidth}`);
  }

  const engine = new Engine(buildEngineConfig(options, collectOpponents(playerRound)));

  // The starting position is overwritten by the first tick, so it is read here.
  const initial = readInitialPoint(engine);

  const locks = [];
  const garbageEvents = [];
  const visual = { active: [], boards: [], queues: [], garbage: [] };
  const confirmSenderFrames = rawConfirmSenderFrames(playerRound);
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

  // Triangle emits `falling.lock.pre` after it has merged the active piece into
  // the board. Capture the board immediately before each Engine tick instead;
  // that is the actual pre-lock field, including any garbage already tanked by
  // an earlier frame.
  let boardBeforeTick = readBoardFrame(engine, engine.frame);
  let preLock = null;

  engine.events.on("falling.lock.pre", () => {
    preLock = {
      fieldBefore: boardBeforeTick,
      piece: minoToPiece(engine.falling.symbol),
      rotation: engine.falling.rotation,
      x: engine.falling.x,
      y: engine.falling.y,
      // The engine board keeps state[0] as the bottom row, the same orientation
      // ReplayIR uses, so these absolute cells carry over unchanged. They, and
      // not piece/rotation/x/y, are what identifies the placement: the engine
      // and fumen disagree on the rotation-centre origin.
      cells: engine.falling.absoluteBlocks.map(([x, y]) => [x, y]),
    };
  });

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
      // Despite the name this is not the pre-placement board: at
      // `falling.lock.pre` the engine has already merged the piece, and it
      // measured identical to `fieldAfter` on every lock. The board before the
      // placement is `boardAtFrame(player, frame - 1)` on the visual timeline.
      fieldBefore: preLock ? preLock.fieldBefore.field : after.field,
      fieldAfter: after.field,
      piece: preLock ? preLock.piece : minoToPiece(res.mino),
      rotation: preLock ? preLock.rotation : 0,
      x: preLock ? preLock.x : 0,
      y: preLock ? preLock.y : 0,
      cells: preLock ? preLock.cells : undefined,
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
  });

  // The gauge identity (receive - cancel - tank == garbageQueue.size) holds for
  // the post-passthrough amount, not for `originalAmount`.
  engine.events.on("garbage.receive", (event) => {
    garbageEvents.push({ frame: engine.frame, kind: "receive", iid: event.iid, amount: event.amount ?? 0 });
    recordGarbage(engine.frame);
  });
  engine.events.on("garbage.confirm", (event) => {
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
    garbageEvents.push({
      frame: engine.frame,
      kind: "cancel",
      iid: event.iid,
      amount: event.amount ?? 0,
      size: event.size,
    });
    recordGarbage(engine.frame);
  });

  const tickEngine = (frames) => {
    boardBeforeTick = readBoardFrame(engine, engine.frame);
    engine.tick(frames);
  };

  // `end` events are skipped and the engine keeps ticking to `replay.frames`.
  const events = playerRound.replay.events.slice();
  while (events.length > 0) {
    while (engine.frame < events[0].frame) {
      tickEngine([]);
      recordActive(engine.frame);
    }
    while (events.length && events[0].frame < engine.frame) events.shift();
    const toTick = [];
    while (events.length && events[0].frame === engine.frame) {
      const event = events.shift();
      if (event.type === "end") continue;
      toTick.push(event);
    }
    tickEngine(toTick);
    recordActive(engine.frame);
  }
  while (engine.frame < playerRound.replay.frames) {
    tickEngine([]);
    recordActive(engine.frame);
  }

  const terminalBoard = convertEngineBoard(engine.board.state);
  const terminalQueue = readQueueFrame(engine, engine.frame);
  recordBoard(engine.frame, terminalBoard);
  recordQueue(engine.frame, terminalQueue);
  recordGarbage(engine.frame);
  const stats = playerRound.replay.results.stats;
  const actualSent = engine.stats.garbage.sent ?? 0;
  const verification = {
    piecesplaced: { expected: stats.piecesplaced, actual: locks.length },
    lines: { expected: stats.lines, actual: totalLines },
    sent: { expected: stats.garbage.sent, actual: actualSent },
    matched: stats.piecesplaced === locks.length &&
      stats.lines === totalLines &&
      stats.garbage.sent === actualSent,
  };

  return {
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
      users: (file.users ?? []).map((user) => ({ id: user.id, username: user.username })),
      gamemode: file.gamemode ?? "",
      ts: file.ts ?? "",
      version: file.version ?? 1,
      parseMs: Math.round(nowMs() - startedAt),
    },
  };
}
