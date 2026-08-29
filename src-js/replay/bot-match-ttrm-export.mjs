import S2_OBSERVED_MANIFEST from "../../rulesets/tetrio-s2-v19-beta-1-5-0-observed.json" with { type: "json" };

import { resolvePlacementRules } from "../ruleset-profiles.mjs";
import { generateEngineFrameBranchesAtLockFrame } from "../triangle/engine-frame-move-generation.mjs";
import { parseTtrm, TtrmError } from "./ttrm-parser.mjs";
import { simulatePlayerRound } from "./ttrm-simulator.mjs";

export class BotMatchTtrmError extends Error {
  constructor(stage, message, lockIndex = null) {
    super(message);
    this.name = "BotMatchTtrmError";
    this.stage = stage;
    this.lockIndex = lockIndex;
  }
}

/**
 * Builds a real input-log shaped `.ttrm` and verifies it through the same
 * parser and Triangle simulator used by the replay import endpoint.
 */
export function buildBotMatchTtrm(recording, { outcome = null } = {}) {
  assertRecording(recording);
  if (recording.meta?.match?.ttrmCompatible !== true) {
    throw new BotMatchTtrmError(
      "compatibility",
      "this match was not started on the TTRM queue model; start a new match with QUEUE MODEL set to TTRM QUEUE",
    );
  }

  const match = recording.match;
  const rules = resolvePlacementRules(match.rulesetId);
  const seed = matchSeed(match, recording.meta?.match?.seed);
  const players = recording.players.map((recorded) => {
    try {
      return buildPlayer(recorded, match, rules, outcome, seed);
    } catch (error) {
      if (error instanceof BotMatchTtrmError) throw error;
      throw new BotMatchTtrmError(
        "witness",
        `${recorded.username}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  const file = {
    version: 1,
    gamemode: "league",
    ts: recording.meta?.ts ?? new Date().toISOString(),
    users: players.map((player) => ({ id: player.id, username: player.username })),
    replay: { rounds: [players] },
  };
  const text = JSON.stringify(file, null, 2);
  verifyExport(text, recording);
  return text;
}

function buildPlayer(recorded, match, rules, outcome, seed) {
  const provenance = recorded.ttrmLocks;
  if (!Array.isArray(provenance) || provenance.length !== recorded.locks.length) {
    throw new BotMatchTtrmError(
      "provenance",
      `${recorded.username}: lock input provenance is unavailable; only newly started TTRM-compatible matches can be exported`,
    );
  }

  const inputEvents = [{ frame: 0, type: "start" }];
  let continuation = null;
  for (let index = 0; index < provenance.length; index += 1) {
    const entry = provenance[index];
    const expected = recorded.locks[index];
    const witness = findWitness(entry, expected, rules, recorded.username, index, continuation);
    inputEvents.push(...witnessEvents(witness.placement));
    continuation = witness.continuation;
  }

  const frames = Math.max(1, match.clock.logicalFrame + 1);
  // End is placed on the final input frame. The simulator consumes the event
  // in that tick and advances the engine to the declared exclusive frame.
  inputEvents.push({ frame: Math.max(0, frames - 1), type: "end" });
  inputEvents.push(...garbageInputEvents(recorded.garbageEvents));
  const events = sortEvents(inputEvents);
  const bot = match.bots.find((candidate) => candidate.id === recorded.id);
  if (bot === undefined) throw new BotMatchTtrmError("structure", `${recorded.username}: bot state is missing`);

  const options = ttrmOptions({
    seed,
    gameId: bot.gameId,
    username: recorded.username,
    handling: provenance[0]?.before?.movement?.handling,
  });
  const reason = outcome?.complete
    ? (outcome.winnerBotId === recorded.id ? "winner" : outcome.reason)
    : "winner";
  const lines = recorded.locks.reduce((sum, lock) => sum + lock.clear.lines, 0);
  const sent = bot.stats?.garbageSent ?? 0;
  return {
    id: recorded.id,
    username: recorded.username,
    alive: reason !== "top-out",
    replay: {
      frames,
      events,
      options,
      results: {
        stats: {
          piecesplaced: recorded.locks.length,
          lines,
          garbage: { sent, received: 0, attack: sent, cleared: 0 },
        },
        gameoverreason: reason,
      },
    },
  };
}

function findWitness(entry, expected, rules, username, lockIndex, sourceContinuation) {
  if (entry?.before === undefined || entry.placement === null || entry.placement === undefined) {
    throw new BotMatchTtrmError(
      "witness",
      `${username}: lock ${lockIndex} has no canonical placement witness`,
      lockIndex,
    );
  }
  if (!Number.isSafeInteger(entry.frame) || entry.frame < entry.before.time.logicalFrame) {
    throw new BotMatchTtrmError("witness", `${username}: lock ${lockIndex} has an invalid lock frame`, lockIndex);
  }
  // The continuation is the real Engine state after the preceding lock. Its
  // active piece is already spawned, whereas canonical S2 snapshots describe
  // that same moment as spawn-ready.
  const state = sourceContinuation === null
    ? entry.before
    : {
      ...entry.before,
      movement: { ...entry.before.movement, phase: "active-piece" },
    };
  const branches = generateEngineFrameBranchesAtLockFrame(
    state,
    rules,
    sourceContinuation,
    entry.frame,
    {
      filter: (branch) => samePlacementOutcome(branch, entry.placement, expected),
      stopAfterFirstMatchingDuration: true,
    },
  );
  const branch = branches.find((candidate) => samePlacementOutcome(candidate, entry.placement, expected));
  if (branch === undefined) {
    throw new BotMatchTtrmError(
      "witness",
      `${username}: lock ${lockIndex} has no engine-frame witness for ${entry.placement.piece}/${entry.placement.rotation} at ${entry.frame}`,
      lockIndex,
    );
  }
  if (branch.placement.movementEvidence.lockedAtFrame !== expected.frame) {
    throw new BotMatchTtrmError(
      "witness",
      `${username}: lock ${lockIndex} witness frame differs from the recorded frame`,
      lockIndex,
    );
  }
  return branch;
}

function witnessEvents(placement) {
  const evidence = placement.movementEvidence;
  const inputs = evidence?.inputs;
  if (!Number.isSafeInteger(evidence?.startedAtFrame) || !Array.isArray(inputs) || inputs.length === 0) {
    throw new BotMatchTtrmError("witness", "engine-frame witness has no input sequence");
  }
  const events = [];
  inputs.forEach((input, index) => {
    const frame = evidence.startedAtFrame + index;
    if (input === "noop") return;
    const edge = heldEdge(input);
    if (edge !== null) {
      events.push({ frame, type: edge.type, data: { key: edge.key, subframe: 0 } });
      return;
    }
    if (!["moveLeft", "moveRight", "rotateCW", "rotateCCW", "rotate180", "hardDrop", "hold"].includes(input)) {
      throw new BotMatchTtrmError("witness", `unsupported engine-frame input ${input}`);
    }
    events.push({ frame, type: "keydown", data: { key: input, subframe: 0 } });
    if (input !== "hardDrop") events.push({ frame, type: "keyup", data: { key: input, subframe: 0 } });
  });
  return events;
}

function heldEdge(input) {
  const edges = [
    ["moveLeftDown", "keydown", "moveLeft"],
    ["moveLeftUp", "keyup", "moveLeft"],
    ["moveRightDown", "keydown", "moveRight"],
    ["moveRightUp", "keyup", "moveRight"],
    ["softDropDown", "keydown", "softDrop"],
    ["softDropUp", "keyup", "softDrop"],
  ];
  const found = edges.find(([name]) => name === input);
  return found === undefined ? null : { type: found[1], key: found[2] };
}

function garbageInputEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.flatMap((event) => {
    if (event.kind === "receive") {
      return [{
        frame: event.frame,
        type: "ige",
        data: {
          type: "interaction",
          data: {
            type: "garbage",
            iid: event.iid,
            gameid: event.gameid,
            amt: event.amount,
            size: event.size ?? 1,
          },
        },
      }];
    }
    if (event.kind === "confirm") {
      return [{
        frame: event.frame,
        type: "ige",
        data: {
          type: "interaction_confirm",
          data: {
            type: "garbage",
            iid: event.iid,
            gameid: event.gameid,
            frame: event.senderFrame ?? event.frame,
          },
        },
      }];
    }
    return [];
  });
}

function sortEvents(events) {
  return events
    .map((event, order) => ({ event, order }))
    .sort((left, right) => left.event.frame - right.event.frame || eventPriority(left.event) - eventPriority(right.event) || left.order - right.order)
    .map(({ event }) => event);
}

function eventPriority(event) {
  if (event.type === "start") return 0;
  if (event.type === "keydown" || event.type === "keyup") return 1;
  if (event.type === "ige") return 2;
  return 3;
}

function ttrmOptions({ seed, gameId, username, handling }) {
  const options = structuredClone(S2_OBSERVED_MANIFEST.normalizedOptions);
  options.seed = seed;
  options.gameid = gameId;
  options.username = username;
  options.allowharddrop = options.allow_harddrop;
  options.gravitymay20g = options.gravitymay20g;
  options.handling = {
    arr: handling?.arr ?? 0,
    das: handling?.das ?? 0,
    dcd: handling?.dcd ?? 0,
    sdf: handling?.sdf ?? 1,
    safelock: handling?.safelock ?? false,
    cancel: handling?.cancel ?? true,
    may20g: handling?.may20g ?? true,
    irs: handling?.irs ?? "off",
    ihs: handling?.ihs ?? "off",
  };
  return options;
}

function verifyExport(text, recording) {
  let file;
  try {
    file = parseTtrm(text);
  } catch (error) {
    if (error instanceof TtrmError) {
      throw new BotMatchTtrmError("parse", error.message);
    }
    throw error;
  }
  for (let playerIndex = 0; playerIndex < file.replay.rounds[0].length; playerIndex += 1) {
    const playerRound = file.replay.rounds[0][playerIndex];
    const simulated = simulatePlayerRound(playerRound);
    const recorded = recording.players[playerIndex];
    if (!simulated.verification.matched) {
      throw new BotMatchTtrmError(
        "verify",
        `${recorded.username}: stats did not reproduce (${simulated.verification.piecesplaced.actual}/${simulated.verification.piecesplaced.expected} pieces, ${simulated.verification.lines.actual}/${simulated.verification.lines.expected} lines, ${simulated.verification.sent.actual}/${simulated.verification.sent.expected} sent)`,
      );
    }
    if (simulated.locks.length !== recorded.locks.length) {
      throw new BotMatchTtrmError("verify", `${recorded.username}: lock count differs after simulation`);
    }
    simulated.locks.forEach((actual, lockIndex) => compareLock(actual, recorded.locks[lockIndex], recorded.username, lockIndex));
  }
}

function compareLock(actual, expected, username, lockIndex) {
  // x/y are rotation-centre labels, not an interchange coordinate system:
  // Triangle and the canonical S2 adapter legitimately assign different
  // origins to an identical set of locked cells. The cells and both boards are
  // the exact replay contract.
  const fields = ["frame", "piece", "rotation", "fieldBefore", "fieldAfter", "cells"];
  for (const field of fields) {
    if (JSON.stringify(actual[field]) !== JSON.stringify(expected[field])) {
      throw new BotMatchTtrmError(
        "verify",
        `${username}: lock ${lockIndex} ${field} differs after simulation${arrayDifference(actual[field], expected[field])}`,
        lockIndex,
      );
    }
  }
}

function arrayDifference(actual, expected) {
  if (!Array.isArray(actual) || !Array.isArray(expected)) return "";
  const index = actual.findIndex((value, offset) => JSON.stringify(value) !== JSON.stringify(expected[offset]));
  return index < 0 ? ` (length ${actual.length}/${expected.length})` : ` @${index}=${JSON.stringify(actual[index])}/${JSON.stringify(expected[index])}`;
}

function samePlacementOutcome(branch, expectedPlacement, expectedLock) {
  const placement = branch?.placement;
  return placement?.piece === expectedPlacement?.piece &&
    placement?.rotation === expectedPlacement?.rotation &&
    placement?.usedHold === expectedPlacement?.usedHold &&
    sameField(snapshotField(branch.continuation), expectedLock.fieldAfter);
}

function snapshotField(continuation) {
  const rows = continuation?.snapshot?.board;
  if (!Array.isArray(rows)) return null;
  const codes = { i: 1, l: 2, o: 3, z: 4, t: 5, j: 6, s: 7 };
  return rows.flat().slice(0, 230).map((cell) => {
    if (cell === null || cell === undefined) return 0;
    const mino = typeof cell.mino === "string" ? cell.mino.toLowerCase() : "";
    return codes[mino] ?? 8;
  });
}

function sameField(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((cell, index) => cell === right[index]);
}

function matchSeed(match, recordingSeed) {
  const seed = match?.seed ?? recordingSeed;
  if (Number.isSafeInteger(seed)) return seed;
  throw new BotMatchTtrmError("structure", "TTRM seed is missing");
}

function assertRecording(recording) {
  if (recording === null || typeof recording !== "object" || !Array.isArray(recording.players) || recording.players.length !== 2) {
    throw new BotMatchTtrmError("structure", "invalid bot match recording");
  }
  if (recording.match === null || typeof recording.match !== "object") {
    throw new BotMatchTtrmError("structure", "recording has no match snapshot");
  }
}
