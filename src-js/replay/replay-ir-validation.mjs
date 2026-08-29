export const MATCH_REPLAY_SCHEMA = "s2-analysis-engine/schema/match-replay/1";

const MAX_FRAME = Number.MAX_SAFE_INTEGER;
const FIELD_CELLS = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8]);
const PIECES = new Set([1, 2, 3, 4, 5, 6, 7]);

export class ReplayIrValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReplayIrValidationError";
  }
}

/** Validates the browser-importable ReplayIR envelope without adopting it. */
export function validateReplayIRDocument(document) {
  object(document, "ReplayIR");
  if (document.$schema !== MATCH_REPLAY_SCHEMA) {
    fail(`unsupported replay schema ${String(document.$schema)}`);
  }
  object(document.meta, "ReplayIR.meta");
  if (!Array.isArray(document.meta.users)) fail("ReplayIR.meta.users must be an array");
  if (!Array.isArray(document.rounds) || document.rounds.length === 0) fail("ReplayIR.rounds must not be empty");
  document.rounds.forEach(validateRound);
  return document;
}

function validateRound(round, index) {
  object(round, `round ${index}`);
  if (round.status !== "ok" && round.status !== "failed") fail(`round ${index} has an unsupported status`);
  frame(round.startFrame, `round ${index}.startFrame`);
  frame(round.endFrame, `round ${index}.endFrame`);
  if (round.endFrame < round.startFrame) fail(`round ${index} has a reversed frame range`);
  object(round.result, `round ${index}.result`);
  if (round.result.winnerId !== null && typeof round.result.winnerId !== "string") {
    fail(`round ${index}.result.winnerId must be null or a string`);
  }
  object(round.result.reasons, `round ${index}.result.reasons`);
  if (!Array.isArray(round.players)) fail(`round ${index}.players must be an array`);
  if (round.status === "ok" && round.players.length < 1) fail(`round ${index} has no players`);
  round.players.forEach((player, playerIndex) => validatePlayer(player, index, playerIndex));
}

function validatePlayer(player, roundIndex, playerIndex) {
  const label = `round ${roundIndex}.players[${playerIndex}]`;
  object(player, label);
  if (typeof player.id !== "string" || player.id.length === 0) fail(`${label}.id is required`);
  if (typeof player.username !== "string") fail(`${label}.username is required`);
  object(player.initial, `${label}.initial`);
  object(player.terminal, `${label}.terminal`);
  if (!Array.isArray(player.locks)) fail(`${label}.locks must be an array`);
  if (!Array.isArray(player.garbageEvents)) fail(`${label}.garbageEvents must be an array`);
  if (player.verification?.matched !== false || player.verification.reason !== "synthetic-bot-match") {
    fail(`${label}.verification must declare synthetic-bot-match and matched=false`);
  }
  validatePoint(player.initial, `${label}.initial`);
  let previousFrame = -1;
  player.locks.forEach((lock, index) => {
    const lockLabel = `${label}.locks[${index}]`;
    object(lock, lockLabel);
    frame(lock.frame, `${lockLabel}.frame`);
    if (lock.frame < previousFrame) fail(`${label}.locks are not monotone`);
    previousFrame = lock.frame;
    field(lock.fieldBefore, `${lockLabel}.fieldBefore`);
    field(lock.fieldAfter, `${lockLabel}.fieldAfter`);
    validateQueue(lock, lockLabel);
    if (lock.piece !== undefined && (!Number.isInteger(lock.piece) || !PIECES.has(lock.piece))) {
      fail(`${lockLabel}.piece is invalid`);
    }
    if (lock.cells !== undefined && (!Array.isArray(lock.cells) || lock.cells.length !== 4 ||
        lock.cells.some((cell) => !Array.isArray(cell) || cell.length !== 2 || !cell.every(Number.isSafeInteger)))) {
      fail(`${lockLabel}.cells is invalid`);
    }
  });
  frame(player.terminal.frame, `${label}.terminal.frame`);
  if (player.terminal.frame < previousFrame) fail(`${label}.terminal precedes its last lock`);
  validatePoint(player.terminal, `${label}.terminal`);
  player.garbageEvents.forEach((event, index) => {
    object(event, `${label}.garbageEvents[${index}]`);
    frame(event.frame, `${label}.garbageEvents[${index}].frame`);
    if (!new Set(["receive", "confirm", "cancel", "tank"]).has(event.kind)) {
      fail(`${label}.garbageEvents[${index}].kind is invalid`);
    }
    if (!Number.isSafeInteger(event.iid) && typeof event.iid !== "string") fail(`${label}.garbage event iid is invalid`);
    if (!Number.isSafeInteger(event.amount) || event.amount < 0) fail(`${label}.garbage event amount is invalid`);
  });
}

function validatePoint(point, label) {
  frame(point.frame, `${label}.frame`);
  field(point.field, `${label}.field`);
  validateQueue(point, label);
}

function validateQueue(point, label) {
  if (!Array.isArray(point.next)) fail(`${label}.next must be an array`);
  if (point.current !== null && (!Number.isInteger(point.current) || !PIECES.has(point.current))) fail(`${label}.current is invalid`);
  if (point.hold !== null && (!Number.isInteger(point.hold) || !PIECES.has(point.hold))) fail(`${label}.hold is invalid`);
  if (point.next.some((piece) => !Number.isInteger(piece) || !PIECES.has(piece))) fail(`${label}.next is invalid`);
}

function field(value, label) {
  if (!Array.isArray(value) || value.length !== 230 || value.some((cell) => !Number.isInteger(cell) || !FIELD_CELLS.has(cell))) {
    fail(`${label} must contain 230 ReplayIR cells`);
  }
}

function frame(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_FRAME) fail(`${label} must be a non-negative safe integer`);
}

function object(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function fail(message) {
  throw new ReplayIrValidationError(message);
}
