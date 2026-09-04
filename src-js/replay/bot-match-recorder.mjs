import { createPlacedTetromino, canonicalBoardToTriangle } from "../triangle/placement-adapter.mjs";
import { resolvePlacementRules } from "../ruleset-profiles.mjs";
import { FIELD_HEIGHT, FIELD_WIDTH, PIECE } from "./pieces.mjs";

export const BOT_MATCH_REPLAY_SCHEMA = "s2-analysis-engine/schema/match-replay/1";
export const BOT_MATCH_REPLAY_ORIGIN = "s2-bot-match/1";

const ROTATION_CODES = Object.freeze({ spawn: 0, right: 1, reverse: 2, left: 3 });
const CELL_CODES = Object.freeze({
  _: PIECE.EMPTY,
  I: PIECE.I,
  L: PIECE.L,
  O: PIECE.O,
  Z: PIECE.Z,
  T: PIECE.T,
  J: PIECE.J,
  S: PIECE.S,
  G: PIECE.GRAY,
});

/**
 * Starts a pure recording around the match's initial canonical states.
 * `meta` is deliberately supplied by the caller so this module has no GUI or
 * session dependency.
 */
export function createMatchRecording({ match, meta } = {}) {
  assertMatch(match);
  const users = new Map((meta?.users ?? []).map((user) => [user.id, user]));
  const rules = resolvePlacementRules(match.rulesetId);
  return {
    match: structuredClone(match),
    meta: structuredClone(meta ?? {}),
    players: match.bots.map((bot) => ({
      id: bot.id,
      username: users.get(bot.id)?.username ?? bot.id,
      resolvedOptions: resolvedOptions(match.rulesetId, rules),
      initial: pointFromState(bot.state, 0),
      locks: [],
      // Private provenance for a later real `.ttrm` export. It is deliberately
      // kept out of the public ReplayIR JSON.
      ttrmLocks: [],
      garbageEvents: initialGarbageEvents(bot.state),
      visual: {
        active: [],
        boards: [boardPoint(bot.state, 0)],
        queues: [queuePoint(bot.state, 0)],
        garbage: [garbagePoint(bot.state, 0)],
      },
    })),
  };
}

/** Records one `advanceBotMatch` operation without mutating the recording or snapshots. */
export function recordMatchLocks(recording, before, after, submissions) {
  assertRecording(recording);
  assertMatch(before);
  assertMatch(after);
  if (!Array.isArray(submissions)) throw new Error("submissions must be an array");

  // Recording growth is append-only. Clone only the containers this call can
  // append to; cloning the complete history on every lock makes a match O(n²).
  const next = {
    ...recording,
    match: structuredClone(after),
    players: recording.players.map((player) => ({
      ...player,
      locks: [...player.locks],
      ttrmLocks: [...player.ttrmLocks],
      garbageEvents: [...player.garbageEvents],
      visual: {
        ...player.visual,
        active: [...player.visual.active],
        boards: [...player.visual.boards],
        queues: [...player.visual.queues],
        garbage: [...player.visual.garbage],
      },
    })),
  };
  const byId = new Map(next.players.map((player) => [player.id, player]));

  for (const submission of submissions) {
    const botId = submission?.botId;
    const player = byId.get(botId);
    const beforeBot = before.bots.find((bot) => bot.id === botId);
    if (player === undefined || beforeBot === undefined) throw new Error(`unknown recorded bot ${botId}`);
    const transition = submission.result?.transition;
    if (transition?.nextState === null || transition?.nextState === undefined) {
      throw new Error(`recorded submission for ${botId} has no next state`);
    }
    const afterBot = after.bots.find((bot) => bot.id === botId);
    if (afterBot === undefined) throw new Error(`missing recorded post-state for ${botId}`);
    const placement = placementOf(submission);
    const lock = lockFromTransition(player.locks.length, after.clock.logicalFrame, beforeBot.state, transition, placement, afterBot.state);
    player.locks.push(lock);
    player.ttrmLocks.push({
      before: structuredClone(beforeBot.state),
      placement,
      frame: after.clock.logicalFrame,
    });
    player.visual.boards.push(boardPoint(transition.nextState, after.clock.logicalFrame));
    player.visual.queues.push(queuePoint(transition.nextState, after.clock.logicalFrame));

    recordResolutionEvents(player, beforeBot.state, transition, after.clock.logicalFrame, player.locks.length - 1);
  }

  // Deliveries happen after all submitted locks. Keep them after the local
  // lock's cancel/tank events at the same frame, matching the controller.
  for (const delivery of after.lastStep?.deliveries ?? []) {
    const player = byId.get(delivery.toBotId);
    if (player === undefined) continue;
    const packet = delivery.packet;
    const frame = packet.arrivalFrame;
    player.garbageEvents.push({
      frame,
      kind: "receive",
      iid: packet.packetId,
      amount: packet.amount,
      gameid: packet.sourceGameId,
      size: packet.holeSize,
    });
    player.garbageEvents.push({
      frame,
      kind: "confirm",
      iid: packet.packetId,
      amount: 0,
      gameid: packet.sourceGameId,
      senderFrame: after.clock.logicalFrame,
    });
  }

  for (const player of next.players) {
    const bot = after.bots.find((candidate) => candidate.id === player.id);
    if (bot === undefined) continue;
    const frame = after.clock.logicalFrame;
    const board = bot.state;
    appendChange(player.visual.boards, boardPoint(board, frame), sameBoardPoint);
    appendChange(player.visual.queues, queuePoint(board, frame), sameQueuePoint);
    appendChange(player.visual.garbage, garbagePoint(board, frame), sameGarbagePoint);
  }
  return next;
}

/** Finishes one immutable round. The same helper is used for in-progress views. */
export function finishMatchRecording(recording, { outcome, match } = {}) {
  assertRecording(recording);
  assertMatch(match ?? recording.match);
  const current = match ?? recording.match;
  const round = roundFromRecording(recording, current, outcome ?? inProgressOutcome());
  return structuredClone(round);
}

export function buildMatchReplay(rounds, meta = {}) {
  if (!Array.isArray(rounds)) throw new Error("match replay rounds must be an array");
  return {
    $schema: BOT_MATCH_REPLAY_SCHEMA,
    meta: {
      origin: BOT_MATCH_REPLAY_ORIGIN,
      users: [],
      gamemode: "s2-bot-match",
      ts: new Date().toISOString(),
      version: 1,
      parseMs: 0,
      ...structuredClone(meta),
    },
    rounds: structuredClone(rounds),
  };
}

function roundFromRecording(recording, match, outcome) {
  const reasons = {};
  const players = recording.players.map((recorded) => {
    const bot = match.bots.find((candidate) => candidate.id === recorded.id);
    const reason = outcome.complete
      ? (outcome.winnerBotId === recorded.id ? "winner" : outcome.reason)
      : "in-progress";
    reasons[recorded.id] = reason;
    return {
      id: recorded.id,
      username: recorded.username,
      initial: structuredClone(recorded.initial),
      locks: structuredClone(recorded.locks),
      garbageEvents: structuredClone(recorded.garbageEvents),
      verification: { matched: false, reason: "synthetic-bot-match" },
      visual: structuredClone(recorded.visual),
      resolvedOptions: structuredClone(recorded.resolvedOptions),
      optionWarnings: [],
      terminal: terminalFromState(bot?.state, match.clock.logicalFrame, reason),
    };
  });
  return {
    index: 0,
    startFrame: 0,
    endFrame: match.clock.logicalFrame,
    status: "ok",
    result: {
      reasons,
      winnerId: outcome.complete ? (outcome.winnerBotId ?? null) : null,
      ...(outcome.proposalResult === undefined
        ? {}
        : { proposalResult: structuredClone(outcome.proposalResult) }),
    },
    players,
  };
}

function lockFromTransition(pieceIndex, frame, before, transition, placement, afterState) {
  const nextState = transition.nextState;
  const lockResult = transition.lockResult;
  const cells = placement === null ? undefined : placedCells(before, placement);
  const clear = {
    lines: lockResult.lines,
    spin: lockResult.spin,
    b2b: (nextState.chain?.b2b ?? 0) - 1,
    ren: (nextState.chain?.combo ?? 0) - 1,
    perfectClear: lockResult.perfectClear,
  };
  return {
    pieceIndex,
    frame,
    ...(placement === null ? {} : {
      piece: pieceCode(placement.piece),
      rotation: ROTATION_CODES[placement.rotation],
      x: placement.x,
      y: placement.y + boxSize(placement.piece) - 1,
    }),
    ...(cells === undefined ? {} : { cells }),
    fieldBefore: fieldFromState(before),
    fieldAfter: fieldFromState(nextState),
    hold: pieceCode(nextState.pieces.hold),
    current: pieceCode(nextState.pieces.current),
    next: nextState.pieces.known.map(pieceCode),
    clear,
    attack: transition.attackStages?.outgoingBeforeCancel ?? 0,
    garbageCleared: garbageCleared(before, lockResult),
    garbageGauge: garbageGauge(afterState),
    sourceHeight: sourceHeight(nextState.board),
    clippedRowCount: clippedRowCount(nextState.board),
  };
}

function recordResolutionEvents(player, before, transition, frame, lockIndex) {
  const beforePackets = before.garbage?.packets ?? [];
  const nextPackets = transition.nextState.garbage?.packets ?? [];
  const tanked = new Map();
  for (const row of transition.tankResult?.inserted ?? []) {
    const key = packetKey(row);
    tanked.set(key, (tanked.get(key) ?? 0) + row.amount);
    player.garbageEvents.push({
      frame,
      kind: "tank",
      iid: row.packetId,
      amount: row.amount,
      column: row.holeColumn,
      size: row.holeSize,
    });
  }

  const afterAmounts = new Map(nextPackets.map((packet) => [packetKey(packet), packet.amount]));
  const cancelEvents = [];
  for (const packet of beforePackets) {
    const reduced = packet.amount - (afterAmounts.get(packetKey(packet)) ?? 0) - (tanked.get(packetKey(packet)) ?? 0);
    if (reduced > 0) {
      cancelEvents.push({
        frame,
        kind: "cancel",
        iid: packet.packetId,
        amount: reduced,
        size: packet.holeSize,
      });
    }
  }
  const expected = transition.cancelResult?.cancelled ?? 0;
  const actual = cancelEvents.reduce((sum, event) => sum + event.amount, 0);
  if (actual !== expected && expected > 0) {
    // Packet-level provenance is not public in F7. Preserve the aggregate
    // gauge identity when a future controller shape cannot be diffed exactly.
    cancelEvents.splice(0, cancelEvents.length, {
      frame,
      kind: "cancel",
      iid: beforePackets[0]?.packetId ?? `cancel-${lockIndex}`,
      amount: expected,
    });
  }
  player.garbageEvents.push(...cancelEvents);
}

function placementOf(submission) {
  const placement = submission?.result?.comparison?.witness?.placement ?? submission?.placement ?? submission?.move;
  if (placement === null || placement === undefined) return null;
  if (!Object.prototype.hasOwnProperty.call(ROTATION_CODES, placement.rotation) || !Number.isSafeInteger(placement.x) ||
      !Number.isSafeInteger(placement.y) || typeof placement.piece !== "string") {
    throw new Error("recorded placement is not canonical");
  }
  return structuredClone(placement);
}

function placedCells(state, placement) {
  try {
    const board = canonicalBoardToTriangle(state.board);
    const piece = createPlacedTetromino(board, placement);
    const cells = piece.absoluteBlocks.map(([x, y]) => [x, y]);
    return cells.length === 4 && cells.every((cell) => cell.every(Number.isSafeInteger)) ? cells : undefined;
  } catch {
    return undefined;
  }
}

function pointFromState(state, frame) {
  return {
    frame,
    field: fieldFromState(state),
    sourceHeight: sourceHeight(state.board),
    clippedRowCount: clippedRowCount(state.board),
    hold: pieceCode(state.pieces.hold),
    current: pieceCode(state.pieces.current),
    next: state.pieces.known.map(pieceCode),
  };
}

function terminalFromState(state, frame, reason) {
  return {
    ...pointFromState(state, frame),
    garbageGauge: garbageGauge(state),
    reason,
    alive: reason !== "top-out",
  };
}

function boardPoint(state, frame) {
  return {
    frame,
    field: fieldFromState(state),
    sourceHeight: sourceHeight(state.board),
    clippedRowCount: clippedRowCount(state.board),
  };
}

function queuePoint(state, frame) {
  return {
    frame,
    hold: pieceCode(state.pieces.hold),
    current: pieceCode(state.pieces.current),
    next: state.pieces.known.map(pieceCode),
  };
}

function garbagePoint(state, frame) {
  return { frame, snapshot: structuredClone(state.garbage) };
}

function initialGarbageEvents(state) {
  const events = [];
  for (const packet of state.garbage?.packets ?? []) {
    events.push({
      frame: 0,
      kind: "receive",
      iid: packet.packetId,
      amount: packet.amount,
      gameid: packet.sourceGameId,
      size: packet.holeSize,
    });
    if (packet.confirmed) {
      events.push({
        frame: 0,
        kind: "confirm",
        iid: packet.packetId,
        amount: 0,
        gameid: packet.sourceGameId,
        senderFrame: 0,
      });
    }
  }
  return events;
}

function fieldFromState(state) {
  const board = state?.board;
  if (board?.width !== FIELD_WIDTH || typeof board.cells !== "string" || board.cells.length !== board.width * board.height) {
    throw new Error("bot match replay requires an exact canonical board");
  }
  const field = [];
  for (let y = 0; y < FIELD_HEIGHT; y += 1) {
    for (let x = 0; x < FIELD_WIDTH; x += 1) {
      const value = board.cells[y * FIELD_WIDTH + x];
      if (CELL_CODES[value] === undefined) throw new Error(`unsupported canonical board cell ${value}`);
      field.push(CELL_CODES[value]);
    }
  }
  return field;
}

function sourceHeight(board) {
  let height = 0;
  for (let y = board.height - 1; y >= 0; y -= 1) {
    const row = board.cells.slice(y * board.width, (y + 1) * board.width);
    if (row.split("").some((cell) => cell !== "_")) {
      height = y + 1;
      break;
    }
  }
  return height;
}

function clippedRowCount(board) {
  return Math.max(0, sourceHeight(board) - FIELD_HEIGHT);
}

function garbageCleared(before, lockResult) {
  return (lockResult.clearedRows ?? []).filter((row) =>
    before.board.cells.slice(row * before.board.width, (row + 1) * before.board.width).includes("G")
  ).length;
}

function garbageGauge(state) {
  return (state.garbage?.packets ?? []).reduce((sum, packet) => sum + packet.amount, 0);
}

function pieceCode(piece) {
  if (piece === null || piece === undefined) return null;
  const code = CELL_CODES[piece];
  if (code === undefined || code === PIECE.EMPTY || code === PIECE.GRAY) {
    throw new Error(`unsupported canonical piece ${piece}`);
  }
  return code;
}

function resolvedOptions(rulesetId, rules) {
  return {
    rulesetId,
    garbagecap: rules.garbageCap?.base ?? 8,
    garbageholesize: rules.garbageHole?.size ?? 1,
    garbagespeed: rules.garbageHole?.speed ?? 0,
  };
}

function packetKey(packet) {
  return `${packet.packetId}:${packet.sourceGameId}`;
}

function boxSize(piece) {
  return piece === "I" ? 4 : piece === "O" ? 2 : 3;
}

function appendChange(points, next, equal) {
  const last = points.at(-1);
  if (last !== undefined && last.frame === next.frame) {
    if (!equal(last, next)) points[points.length - 1] = next;
    return;
  }
  if (last === undefined || !equal(last, next)) points.push(next);
}

function sameBoardPoint(left, right) {
  return left.frame === right.frame && left.sourceHeight === right.sourceHeight &&
    left.clippedRowCount === right.clippedRowCount && left.field.every((cell, index) => cell === right.field[index]);
}

function sameQueuePoint(left, right) {
  return left.frame === right.frame && left.hold === right.hold && left.current === right.current &&
    left.next.length === right.next.length && left.next.every((piece, index) => piece === right.next[index]);
}

function sameGarbagePoint(left, right) {
  return left.frame === right.frame && JSON.stringify(left.snapshot) === JSON.stringify(right.snapshot);
}

function inProgressOutcome() {
  return { complete: false, reason: "in-progress", winnerBotId: null };
}

function assertMatch(match) {
  if (match === null || typeof match !== "object" || !Array.isArray(match.bots) || match.bots.length !== 2) {
    throw new Error("bot match recording requires a two-player match snapshot");
  }
  if (!Number.isSafeInteger(match.clock?.logicalFrame) || match.clock.logicalFrame < 0) {
    throw new Error("bot match recording requires a valid match clock");
  }
}

function assertRecording(recording) {
  if (recording === null || typeof recording !== "object" || !Array.isArray(recording.players)) {
    throw new Error("invalid bot match recording");
  }
}
