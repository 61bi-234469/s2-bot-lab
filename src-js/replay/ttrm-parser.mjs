/**
 * `.ttrm` structural parser.
 *
 * Ported from `fumen-mobile-fork` (`src/lib/ttrm/parser.ts`, MIT).  Only the
 * multiplayer replay format this repository has verified evidence for is
 * accepted; anything else is refused with its stage instead of being simulated
 * on a guess.
 */

/** Real league exports are around 1MB; this leaves generous headroom. */
export const MAX_TTRM_TEXT_LENGTH = 8 * 1024 * 1024;

export class TtrmError extends Error {
  constructor(stage, message) {
    super(message);
    this.name = "TtrmError";
    this.stage = stage;
  }
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Some exports wrap the whole file as { replay: <ttrm> }. Peel until the level
// whose `replay.rounds` is the actual rounds array is reached.
function unwrapReplay(root) {
  let current = root;
  for (let depth = 0; depth < 8; depth += 1) {
    if (isObject(current) && isObject(current.replay) && Array.isArray(current.replay.rounds)) {
      return current;
    }
    if (isObject(current) && isObject(current.replay)) {
      current = current.replay;
      continue;
    }
    break;
  }
  throw new TtrmError("structure", "replay.rounds not found in file");
}

// A broken frame/frames value would leave the simulator's tick loop without a
// termination condition, so both are checked before any engine runs.
function isFiniteNonNegativeInt(value) {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function validateEvents(events, round, playerId) {
  events.forEach((event, index) => {
    if (!isObject(event) || typeof event.type !== "string" || !isFiniteNonNegativeInt(event.frame)) {
      throw new TtrmError(
        "structure",
        `round ${round}: player ${playerId} has an invalid event at index ${index}`,
      );
    }
  });
}

function validatePlayer(player, round, slot) {
  if (!isObject(player) || typeof player.id !== "string") {
    throw new TtrmError("structure", `round ${round}: player ${slot} has no id`);
  }
  const replay = player.replay;
  if (!isObject(replay) || !Array.isArray(replay.events) ||
      typeof replay.frames !== "number" || !isObject(replay.options)) {
    throw new TtrmError("structure", `round ${round}: player ${player.id} is missing replay data`);
  }
  if (!isFiniteNonNegativeInt(replay.frames)) {
    throw new TtrmError("structure", `round ${round}: player ${player.id} has an invalid frames value`);
  }
  validateEvents(replay.events, round, player.id);
  if (!isObject(replay.results) || !isObject(replay.results.stats)) {
    throw new TtrmError("structure", `round ${round}: player ${player.id} is missing results.stats`);
  }
  return player;
}

export function parseTtrm(text) {
  if (text.length > MAX_TTRM_TEXT_LENGTH) {
    throw new TtrmError("size", `file is too large (${Math.ceil(text.length / (1024 * 1024))}MB > 8MB)`);
  }

  let root;
  try {
    root = JSON.parse(text);
  } catch (error) {
    throw new TtrmError("json", `not a valid JSON file: ${error instanceof Error ? error.message : String(error)}`);
  }

  const file = unwrapReplay(root);
  if (file.version !== 1) {
    throw new TtrmError("version", `unsupported replay version: ${String(file.version)}`);
  }

  const rounds = file.replay.rounds;
  if (rounds.length === 0) {
    throw new TtrmError("structure", "replay has no rounds");
  }
  rounds.forEach((round, roundIndex) => {
    if (!Array.isArray(round) || round.length === 0) {
      throw new TtrmError("structure", `round ${roundIndex} has no players`);
    }
    round.forEach((player, slot) => validatePlayer(player, roundIndex, slot));
  });

  return file;
}
