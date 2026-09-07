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

/**
 * A replay is simulated frame by frame.  One million frames is about 4.6
 * hours at 60 Hz, which leaves room for long verified rounds while keeping a
 * tiny file from requesting an unbounded tick loop.
 */
export const MAX_TTRM_FRAMES_PER_PLAYER = 1_000_000;

/** A player event array is also replayed and copied before simulation. */
export const MAX_TTRM_EVENTS_PER_PLAYER = 50_000;

/** Bound the work for multi-round/multi-player imports as well as each player. */
export const MAX_TTRM_TOTAL_FRAMES = 2_000_000;
export const MAX_TTRM_TOTAL_EVENTS = 100_000;

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
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateEvents(events, round, playerId, replayFrames) {
  let previousFrame = 0;
  let previousInputSubframe = 0;
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    if (!isObject(event) || typeof event.type !== "string" || !isFiniteNonNegativeInt(event.frame)) {
      throw new TtrmError(
        "structure",
        `round ${round}: player ${playerId} has an invalid event at index ${index}`,
      );
    }
    if (event.frame !== previousFrame) previousInputSubframe = 0;
    if (event.type === "keydown" || event.type === "keyup") {
      if (!isObject(event.data) || typeof event.data.key !== "string" ||
          !Number.isFinite(event.data.subframe) || event.data.subframe < 0 || event.data.subframe >= 1) {
        throw new TtrmError("structure", `round ${round}: player ${playerId} has invalid input data at index ${index}`);
      }
      if (event.data.subframe < previousInputSubframe) {
        throw new TtrmError("structure", `round ${round}: player ${playerId} input subframes are out of order`);
      }
      previousInputSubframe = event.data.subframe;
    }
    if (event.frame > MAX_TTRM_FRAMES_PER_PLAYER) {
      throw new TtrmError(
        "size",
        `round ${round}: player ${playerId} event frame exceeds the ${MAX_TTRM_FRAMES_PER_PLAYER}-frame limit`,
      );
    }
    if (event.frame > replayFrames) {
      throw new TtrmError(
        "structure",
        `round ${round}: player ${playerId} event at index ${index} is after replay.frames`,
      );
    }
    // Do not sort here: same-frame event order is part of the input log and is
    // consumed by the engine in exactly the order supplied by the export.
    if (index > 0 && event.frame < previousFrame) {
      throw new TtrmError(
        "structure",
        `round ${round}: player ${playerId} events are out of frame order at index ${index}`,
      );
    }
    previousFrame = event.frame;
  }
}

export function validateTtrmPlayerRound(player, round = "direct", slot = 0) {
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
  if (replay.frames > MAX_TTRM_FRAMES_PER_PLAYER) {
    throw new TtrmError(
      "size",
      `round ${round}: player ${player.id} exceeds the ${MAX_TTRM_FRAMES_PER_PLAYER}-frame limit`,
    );
  }
  if (replay.events.length > MAX_TTRM_EVENTS_PER_PLAYER) {
    throw new TtrmError(
      "size",
      `round ${round}: player ${player.id} exceeds the ${MAX_TTRM_EVENTS_PER_PLAYER}-event limit`,
    );
  }
  validateEvents(replay.events, round, player.id, replay.frames);
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
  let totalFrames = 0;
  let totalEvents = 0;
  rounds.forEach((round, roundIndex) => {
    if (!Array.isArray(round) || round.length === 0) {
      throw new TtrmError("structure", `round ${roundIndex} has no players`);
    }
    round.forEach((player, slot) => {
      const validated = validateTtrmPlayerRound(player, roundIndex, slot);
      totalFrames += validated.replay.frames;
      if (totalFrames > MAX_TTRM_TOTAL_FRAMES) {
        throw new TtrmError(
          "size",
          `replay exceeds the ${MAX_TTRM_TOTAL_FRAMES}-frame cumulative limit`,
        );
      }
      totalEvents += validated.replay.events.length;
      if (totalEvents > MAX_TTRM_TOTAL_EVENTS) {
        throw new TtrmError(
          "size",
          `replay exceeds the ${MAX_TTRM_TOTAL_EVENTS}-event cumulative limit`,
        );
      }
    });
  });

  return file;
}
