import { fullStateKey } from "./state-keys.mjs";
import { applyTransition } from "./transition.mjs";
import { canonicalize } from "./cs1-core.mjs";

export const BOT_MATCH_MODES = Object.freeze(["alternating", "simultaneous", "paced"]);

const MATCH_SCHEMA = "s2-analysis-engine/schema/bot-match/1";

/**
 * Creates an immutable-by-convention match snapshot around two canonical S2
 * states.  The controller deliberately does not run either bot or generate a
 * reachable input sequence: callers submit an already evaluated, legal simple
 * placement transition together with the fingerprint it was evaluated from.
 */
export function createBotMatch({
  bots,
  mode = "simultaneous",
  startingBotId = bots?.[0]?.id,
  framesPerTurn = 60,
  ppsByBotId = null,
  garbageDelayFrames = 0,
  garbageHoleSize = 1,
  nextPacketId = 1,
} = {}) {
  if (!Array.isArray(bots) || bots.length !== 2) {
    throw new Error("a bot match requires exactly two bots");
  }
  if (!BOT_MATCH_MODES.includes(mode)) throw new Error(`unsupported bot match mode ${mode}`);
  assertPositiveSafeInteger(framesPerTurn, "framesPerTurn");
  assertNonNegativeSafeInteger(garbageDelayFrames, "garbageDelayFrames");
  assertPositiveSafeInteger(garbageHoleSize, "garbageHoleSize");
  assertNonNegativeSafeInteger(nextPacketId, "nextPacketId");

  const ids = bots.map((bot) => bot?.id);
  if (!ids.every((id) => typeof id === "string" && id.length > 0) || new Set(ids).size !== 2) {
    throw new Error("bot ids must be two distinct non-empty strings");
  }
  if (!ids.includes(startingBotId)) throw new Error("startingBotId must identify one of the bots");

  const rulesetId = bots[0]?.state?.rulesetId;
  const logicalFrame = bots[0]?.state?.time?.logicalFrame;
  assertNonNegativeSafeInteger(logicalFrame, "bot state logicalFrame");
  const normalizedBots = bots.map((bot, index) => {
    if (bot.state?.rulesetId !== rulesetId) throw new Error("both bots must use the same ruleset");
    if (bot.state?.time?.logicalFrame !== logicalFrame) {
      throw new Error("both bot states must start on the same logical frame");
    }
    const gameId = bot.gameId ?? index + 1;
    assertNonNegativeSafeInteger(gameId, "bot gameId");
    return {
      id: bot.id,
      gameId,
      state: structuredClone(bot.state),
      stats: {
        turns: 0,
        attack: 0,
        garbageCancelled: 0,
        garbageCleared: 0,
        garbageSent: 0,
        garbageReceived: 0,
      },
    };
  });
  if (normalizedBots[0].gameId === normalizedBots[1].gameId) {
    throw new Error("bot gameIds must be distinct");
  }

  const pace = mode === "paced"
    ? createPace(ids, logicalFrame, ppsByBotId)
    : null;

  return {
    $schema: MATCH_SCHEMA,
    schemaVersion: 1,
    rulesetId,
    mode,
    turnNumber: 0,
    activeBotId: mode === "alternating" ? startingBotId : null,
    clock: {
      kind: "synthetic-fixed-turn-step",
      logicalFrame,
      framesPerTurn,
    },
    pace,
    garbage: {
      delayFrames: garbageDelayFrames,
      holeSize: garbageHoleSize,
      nextPacketId,
    },
    bots: normalizedBots,
    lastStep: null,
  };
}

/**
 * Advances one alternating turn, simultaneous round, or paced lock event
 * without mutating the input snapshot. A submission is
 * `{ botId, result }`, where `result` is the lightweight CC2/S2 adapter result
 * (or an equivalent `{ transition, comparison: { positionFingerprint } }`).
 *
 * `externalLockFrame` advances an externally paced player instead of the bots
 * the synthetic schedule has due next. The caller owns that frame, because a
 * human player's lock time is only known once the lock has happened.
 * `allowScheduledOverrun` lets a real-time 1P lock pass an overdue bot while
 * rebasing that bot atomically. `scheduledLockFrame` records the actual frame
 * of a scheduled bot whose calculation missed its synthetic deadline.
 */
export function advanceBotMatch(match, submissions, {
  externalLockFrame = null,
  allowScheduledOverrun = false,
  scheduledLockFrame = null,
} = {}) {
  assertMatchSnapshot(match);
  if (!Array.isArray(submissions)) throw new Error("submissions must be an array");
  if (externalLockFrame !== null && scheduledLockFrame !== null) {
    throw new Error("externalLockFrame and scheduledLockFrame cannot be combined");
  }

  const scheduledStep = externalLockFrame === null ? botMatchNextStep(match) : null;
  const nextStep = externalLockFrame === null
    ? scheduledStepFor(match, scheduledStep, scheduledLockFrame)
    : externalStepFor(match, submissions, externalLockFrame, allowScheduledOverrun);
  const expectedIds = nextStep.botIds;
  if (submissions.length !== expectedIds.length) {
    throw new Error(`${match.mode} mode requires submissions from ${expectedIds.join(", ")}`);
  }

  const prepared = submissions.map((submission) => prepareSubmission(match, submission));
  if (new Set(prepared.map((entry) => entry.botId)).size !== prepared.length) {
    throw new Error("duplicate bot submission");
  }
  if (!sameStringSet(prepared.map((entry) => entry.botId), expectedIds)) {
    throw new Error(`${match.mode} mode requires submissions from ${expectedIds.join(", ")}`);
  }

  const toFrame = nextStep.logicalFrame;
  if (!Number.isSafeInteger(toFrame)) throw new Error("match logical frame overflow");

  const next = structuredClone(match);
  const submittedById = new Map(prepared.map((entry) => [entry.botId, entry]));
  for (const bot of next.bots) {
    const submitted = submittedById.get(bot.id);
    if (submitted) {
      bot.state = structuredClone(submitted.transition.nextState);
      bot.stats.turns += 1;
      bot.stats.attack += submitted.attack;
      bot.stats.garbageCancelled += submitted.cancelled;
      bot.stats.garbageCleared += submitted.garbageCleared;
      resetSyntheticPostLockMovement(bot.state, submitted.transition);
    }
    // This match clock is explicitly synthetic. Advancing an idle player's
    // canonical timestamp synchronizes garbage eligibility without claiming to
    // have simulated gravity, ARE, or controller inputs for that player.
    bot.state.time.logicalFrame = toFrame;
  }

  if (next.mode === "paced") {
    for (const botId of expectedIds) {
      const pps = next.pace.ppsByBotId[botId];
      // An externally paced player has no schedule to move forward: the next
      // lock frame arrives with the next submission.
      if (pps === null) {
        next.pace.nextLockFrames[botId] = null;
      } else {
        advanceScheduledCadence(next.pace, botId, toFrame, match.pace.nextLockFrames[botId]);
      }
    }
    // A real-time external lock may pass one or more scheduled deadlines. Move
    // every missed lock inside this same immutable snapshot update so callers
    // can never observe nextLockFrame <= clock.logicalFrame.
    for (const bot of next.bots) {
      if (submittedById.has(bot.id) || next.pace.ppsByBotId[bot.id] === null) continue;
      if (next.pace.nextLockFrames[bot.id] <= toFrame) {
        rebasePendingCadence(next.pace, bot.id, toFrame + 1);
      }
    }
  }

  const deliveries = [];
  for (const source of next.bots) {
    const submitted = submittedById.get(source.id);
    if (!submitted) continue;
    const amount = submitted.outgoing;
    if (amount === 0) continue;
    const target = next.bots.find((bot) => bot.id !== source.id);
    const packetId = allocatePacketId(next, target.state, source.gameId);
    const packet = {
      packetId,
      sourceGameId: source.gameId,
      amount,
      holeSize: next.garbage.holeSize,
      arrivalFrame: toFrame + next.garbage.delayFrames,
      confirmed: true,
      order: target.state.garbage.packets.length,
    };
    if (!Number.isSafeInteger(packet.arrivalFrame)) throw new Error("garbage arrival frame overflow");
    const received = applyTransition(
      target.state,
      { kind: "garbage-receive", packet },
      next.rulesetId,
    );
    target.state = received.nextState;
    source.stats.garbageSent += amount;
    target.stats.garbageReceived += amount;
    deliveries.push({ fromBotId: source.id, toBotId: target.id, packet });
  }

  next.clock.logicalFrame = toFrame;
  next.turnNumber += 1;
  if (next.mode === "alternating") {
    next.activeBotId = next.bots.find((bot) => bot.id !== match.activeBotId).id;
  }
  next.lastStep = {
    turnNumber: next.turnNumber,
    fromFrame: match.clock.logicalFrame,
    toFrame,
    submittedBotIds: next.bots.filter((bot) => submittedById.has(bot.id)).map((bot) => bot.id),
    deliveries,
  };
  return next;
}

/**
 * Returns the bots due at the next synthetic match time. Externally paced
 * players are never due: they are advanced through `externalLockFrame` instead.
 */
export function botMatchNextStep(match) {
  assertMatchSnapshot(match);
  if (match.mode === "paced") {
    const scheduled = scheduledLockFrames(match);
    if (scheduled.length === 0) throw new Error("no scheduled bot has a next lock frame");
    const logicalFrame = Math.min(...scheduled);
    return Object.freeze({
      logicalFrame,
      frames: logicalFrame - match.clock.logicalFrame,
      botIds: Object.freeze(match.bots
        .filter((bot) => match.pace.nextLockFrames[bot.id] === logicalFrame)
        .map((bot) => bot.id)),
    });
  }
  return Object.freeze({
    logicalFrame: match.clock.logicalFrame + match.clock.framesPerTurn,
    frames: match.clock.framesPerTurn,
    botIds: Object.freeze(match.mode === "alternating"
      ? [match.activeBotId]
      : match.bots.map((bot) => bot.id)),
  });
}

/**
 * Highest frame an externally paced player may lock on right now: one frame
 * before the earliest scheduled bot lock, so the shared clock stays monotone and
 * no scheduled lock is skipped over. `null` means the schedule leaves no room
 * and the due bot has to be advanced first.
 */
export function externalLockFrameWindow(match, botId, { allowScheduledOverrun = false } = {}) {
  assertMatchSnapshot(match);
  assertExternallyPaced(match, botId);
  const scheduled = scheduledLockFrames(match);
  const latest = allowScheduledOverrun || scheduled.length === 0
    ? Number.MAX_SAFE_INTEGER
    : Math.min(...scheduled) - 1;
  const earliest = match.clock.logicalFrame + 1;
  return latest < earliest ? null : Object.freeze({ earliest, latest });
}

/** Returns whether the bot's lock times come from outside the synthetic schedule. */
export function isExternallyPaced(match, botId) {
  return match.mode === "paced" && match.pace?.ppsByBotId?.[botId] === null;
}

function scheduledLockFrames(match) {
  return Object.values(match.pace.nextLockFrames).filter((frame) => frame !== null);
}

function externalStepFor(match, submissions, externalLockFrame, allowScheduledOverrun) {
  if (match.mode !== "paced") throw new Error("external lock frames require a paced match");
  const botIds = submissions.map((submission) => submission?.botId);
  if (botIds.length !== 1) throw new Error("an external lock advances exactly one player");
  assertExternallyPaced(match, botIds[0]);
  const window = externalLockFrameWindow(match, botIds[0], { allowScheduledOverrun });
  if (window === null) throw new Error("a scheduled bot lock has to be advanced first");
  if (!Number.isSafeInteger(externalLockFrame)) throw new Error("externalLockFrame must be a safe integer");
  if (externalLockFrame < window.earliest || externalLockFrame > window.latest) {
    throw new Error(`externalLockFrame must be from ${window.earliest} to ${window.latest}`);
  }
  return Object.freeze({
    logicalFrame: externalLockFrame,
    frames: externalLockFrame - match.clock.logicalFrame,
    botIds: Object.freeze([botIds[0]]),
  });
}

function scheduledStepFor(match, scheduledStep, scheduledLockFrame) {
  if (scheduledLockFrame === null) return scheduledStep;
  if (!Number.isSafeInteger(scheduledLockFrame)) {
    throw new Error("scheduledLockFrame must be a safe integer");
  }
  if (scheduledLockFrame < scheduledStep.logicalFrame) {
    throw new Error(`scheduledLockFrame must be at least ${scheduledStep.logicalFrame}`);
  }
  return Object.freeze({
    ...scheduledStep,
    logicalFrame: scheduledLockFrame,
    frames: scheduledLockFrame - match.clock.logicalFrame,
  });
}

function assertExternallyPaced(match, botId) {
  if (!match.bots.some((bot) => bot.id === botId)) throw new Error(`unknown bot ${botId}`);
  if (!isExternallyPaced(match, botId)) throw new Error(`bot ${botId} is not externally paced`);
}

/** Returns the selected canonical state in the shape consumed by the CC2 GUI adapter. */
export function botMatchToGuiState(match, botId) {
  assertMatchSnapshot(match);
  const bot = match.bots.find((candidate) => candidate.id === botId);
  if (!bot) throw new Error(`unknown bot ${botId}`);
  const state = bot.state;
  const { width, height, cells } = state.board ?? {};
  if (width !== 10 || height !== 40 || typeof cells !== "string" || cells.length !== 400) {
    throw new Error("CC2 GUI projection requires an exact 10x40 canonical board");
  }
  return {
    board: Array.from({ length: height }, (_, y) =>
      Array.from({ length: width }, (_, x) => {
        const cell = cells[y * width + x];
        return cell === "_" ? null : cell;
      })),
    queue: [state.pieces.current, ...state.pieces.known].filter((piece) => piece !== null),
    hold: state.pieces.hold,
    combo: state.chain.combo,
    back_to_back: state.chain.b2b > 0,
    randomizer: { type: "seven_bag", bag_state: [] },
    s2: {
      b2b: state.chain.b2b,
      garbage: structuredClone(state.garbage),
      time: structuredClone(state.time),
      movement: structuredClone(state.movement),
      clock: {
        kind: "synthetic-fixed-lock-step",
        // An externally paced player has no fixed cadence to report, so the
        // match's own turn length stands in rather than a fabricated rate.
        // Scheduled rates can be fractional (for example 1.3 PPS), while the
        // canonical clock is frame-exact. Report the integer distance from the
        // shared match clock to this bot's next scheduled lock rather than the
        // fractional average cadence.
        framesPerLock: match.mode === "paced" && match.pace.ppsByBotId[botId] !== null
          ? match.pace.nextLockFrames[botId] - match.clock.logicalFrame
          : match.clock.framesPerTurn,
      },
    },
  };
}

/**
 * Adds externally generated, known queue pieces without permitting a caller to
 * rewrite the current piece or any already committed prefix.  This is the
 * integration seam for `cc2-gui/game.mjs`, whose seeded bag refill policy is
 * intentionally outside the S2 match controller.
 */
export function extendBotMatchQueue(match, botId, queue) {
  assertMatchSnapshot(match);
  if (!Array.isArray(queue) || queue.length < 1) throw new Error("extended queue must not be empty");
  const next = structuredClone(match);
  const bot = next.bots.find((candidate) => candidate.id === botId);
  if (!bot) throw new Error(`unknown bot ${botId}`);
  const existing = [bot.state.pieces.current, ...bot.state.pieces.known];
  if (queue.length < existing.length || existing.some((piece, index) => queue[index] !== piece)) {
    throw new Error(`extended queue does not preserve bot ${botId}'s known prefix`);
  }
  if (!queue.every((piece) => ["I", "O", "T", "L", "J", "S", "Z"].includes(piece))) {
    throw new Error("extended queue contains an unsupported piece");
  }
  bot.state.pieces.known = queue.slice(1);
  return next;
}

/**
 * Replaces only the controller-owned movement projection after an external
 * frame engine has advanced the same canonical position to the match clock.
 * Board, pieces, chain, garbage, time, ruleset and all other fields must be
 * byte-for-byte identical to the current match state.
 */
export function synchronizeBotMatchMovementState(match, botId, {
  expectedStateFingerprint,
  state,
} = {}) {
  return synchronizeBotMatchMovementStates(match, [{ botId, expectedStateFingerprint, state }]);
}

/** Atomically synchronizes one or more independently validated movement states. */
export function synchronizeBotMatchMovementStates(match, replacements) {
  assertMatchSnapshot(match);
  if (!Array.isArray(replacements) || replacements.length === 0) {
    throw new Error("movement synchronizations must not be empty");
  }
  if (new Set(replacements.map((replacement) => replacement?.botId)).size !== replacements.length) {
    throw new Error("duplicate movement synchronization bot");
  }
  for (const { botId, expectedStateFingerprint, state } of replacements) {
    const current = match.bots.find((candidate) => candidate.id === botId);
    if (!current) throw new Error(`unknown bot ${botId}`);
    if (expectedStateFingerprint !== fullStateKey(current.state)) {
      throw new Error(`stale movement synchronization for bot ${botId}`);
    }
    if (state === null || typeof state !== "object" || Array.isArray(state)) {
      throw new Error("movement synchronization state must be an object");
    }
    const currentWithoutMovement = structuredClone(current.state);
    const replacementWithoutMovement = structuredClone(state);
    delete currentWithoutMovement.movement;
    delete replacementWithoutMovement.movement;
    if (canonicalize(currentWithoutMovement) !== canonicalize(replacementWithoutMovement)) {
      throw new Error(`movement synchronization changed canonical position for bot ${botId}`);
    }
    if (state.movement?.phase !== "active-piece") {
      throw new Error(`movement synchronization for bot ${botId} requires an active-piece state`);
    }
  }
  const next = structuredClone(match);
  for (const { botId, state } of replacements) {
    next.bots.find((candidate) => candidate.id === botId).state = structuredClone(state);
  }
  assertMatchSnapshot(next);
  return next;
}

function prepareSubmission(match, submission) {
  if (submission === null || typeof submission !== "object") {
    throw new Error("each submission must be an object");
  }
  const bot = match.bots.find((candidate) => candidate.id === submission.botId);
  if (!bot) throw new Error(`unknown bot submission ${submission.botId}`);
  const result = submission.result;
  const transition = result?.transition;
  const positionFingerprint = submission.positionFingerprint
    ?? result?.comparison?.positionFingerprint;
  if (positionFingerprint !== fullStateKey(bot.state)) {
    throw new Error(`stale transition for bot ${bot.id}`);
  }
  if (!transition?.legality?.legal || transition.nextState === null) {
    throw new Error(`illegal transition for bot ${bot.id}: ${transition?.legality?.reason ?? "unknown"}`);
  }
  if (transition.lockResult === null || transition.lockResult === undefined) {
    throw new Error(`bot ${bot.id} did not submit a placement transition`);
  }
  if (transition.nextState?.rulesetId !== match.rulesetId) {
    throw new Error(`transition ruleset mismatch for bot ${bot.id}`);
  }
  const outgoing = transition.cancelResult?.outgoingAfterCancel ?? 0;
  const cancelled = transition.cancelResult?.cancelled ?? 0;
  const attack = transition.attackStages?.outgoingBeforeCancel ?? 0;
  const garbageCleared = inferGarbageCleared(bot.state.board, transition.lockResult);
  assertNonNegativeSafeInteger(outgoing, `outgoing garbage for bot ${bot.id}`);
  assertNonNegativeSafeInteger(cancelled, `cancelled garbage for bot ${bot.id}`);
  assertNonNegativeSafeInteger(attack, `generated attack for bot ${bot.id}`);
  assertNonNegativeSafeInteger(garbageCleared, `garbage cleared for bot ${bot.id}`);
  return { botId: bot.id, transition, outgoing, cancelled, attack, garbageCleared };
}

function inferGarbageCleared(board, lockResult) {
  return lockResult.clearedRows.filter((row) =>
    board.cells.slice(row * board.width, (row + 1) * board.width).includes("G")
  ).length;
}

function resetSyntheticPostLockMovement(state, transition) {
  if (state.movement === undefined) return;
  state.movement.phase = "spawn-ready";
  state.movement.lastWasClear = transition.lockResult.lines > 0;
}

function allocatePacketId(match, targetState, sourceGameId) {
  let packetId = match.garbage.nextPacketId;
  while (targetState.garbage.packets.some(
    (packet) => packet.packetId === packetId && packet.sourceGameId === sourceGameId,
  )) {
    packetId += 1;
    if (!Number.isSafeInteger(packetId)) throw new Error("garbage packet id overflow");
  }
  match.garbage.nextPacketId = packetId + 1;
  if (!Number.isSafeInteger(match.garbage.nextPacketId)) throw new Error("garbage packet id overflow");
  return packetId;
}

function assertMatchSnapshot(match) {
  if (match?.$schema !== MATCH_SCHEMA || match.schemaVersion !== 1) {
    throw new Error("invalid bot match snapshot schema");
  }
  if (!BOT_MATCH_MODES.includes(match.mode) || !Array.isArray(match.bots) || match.bots.length !== 2) {
    throw new Error("invalid bot match snapshot");
  }
  if (match.bots.some((bot) => bot.state?.rulesetId !== match.rulesetId)) {
    throw new Error("bot match ruleset invariant violated");
  }
  if (match.bots.some((bot) => bot.state?.time?.logicalFrame !== match.clock?.logicalFrame)) {
    throw new Error("bot match clock invariant violated");
  }
  if (match.mode === "paced") {
    if (match.pace === null || typeof match.pace !== "object") throw new Error("paced match requires pace state");
    assertNonNegativeSafeInteger(match.pace.startedAtFrame, "pace startedAtFrame");
    if (match.pace.startedAtFrame > match.clock.logicalFrame) {
      throw new Error("pace start frame cannot be after the match clock");
    }
    for (const bot of match.bots) {
      const pps = match.pace.ppsByBotId?.[bot.id];
      const nextFrame = match.pace.nextLockFrames?.[bot.id];
      const cadence = match.pace.cadenceByBotId?.[bot.id];
      if (pps === null) {
        if (nextFrame !== null) throw new Error(`bot ${bot.id} is externally paced and cannot be scheduled`);
        if (cadence !== null) throw new Error(`bot ${bot.id} is externally paced and cannot have cadence state`);
        continue;
      }
      assertPps(pps, `pps for bot ${bot.id}`);
      if (cadence === null || typeof cadence !== "object") throw new Error(`missing cadence state for bot ${bot.id}`);
      assertNonNegativeSafeInteger(cadence.originFrame, `cadence origin for bot ${bot.id}`);
      assertNonNegativeSafeInteger(cadence.placementNumber, `cadence placement number for bot ${bot.id}`);
      if (!Number.isSafeInteger(nextFrame) || nextFrame <= match.clock.logicalFrame) {
        throw new Error(`invalid next lock frame for bot ${bot.id}`);
      }
      if (nextFrame !== pacedLockFrame(cadence.originFrame, cadence.placementNumber, pps)) {
        throw new Error(`cadence state does not match next lock frame for bot ${bot.id}`);
      }
    }
    if (match.bots.every((bot) => match.pace.ppsByBotId?.[bot.id] === null)) {
      throw new Error("a paced match requires at least one scheduled bot");
    }
  }
}

function createPace(ids, startedAtFrame, ppsByBotId) {
  if (ppsByBotId === null || typeof ppsByBotId !== "object" || Array.isArray(ppsByBotId)) {
    throw new Error("paced match requires ppsByBotId");
  }
  // `null` declares a player whose lock times come from outside this schedule.
  // It is not a rate of zero: no cadence is claimed for them at all.
  const normalized = Object.fromEntries(ids.map((id) => {
    const pps = ppsByBotId[id];
    if (pps !== null) assertPps(pps, `pps for bot ${id}`);
    return [id, pps];
  }));
  if (ids.every((id) => normalized[id] === null)) {
    throw new Error("a paced match requires at least one scheduled bot");
  }
  return {
    startedAtFrame,
    ppsByBotId: normalized,
    cadenceByBotId: Object.fromEntries(ids.map((id) => [id, normalized[id] === null ? null : {
      originFrame: startedAtFrame,
      placementNumber: 1,
    }])),
    nextLockFrames: Object.fromEntries(ids.map((id) => [
      id,
      normalized[id] === null ? null : pacedLockFrame(startedAtFrame, 1, normalized[id]),
    ])),
  };
}

function advanceScheduledCadence(pace, botId, lockFrame, priorScheduledFrame) {
  const pps = pace.ppsByBotId[botId];
  if (lockFrame > priorScheduledFrame) {
    pace.cadenceByBotId[botId] = { originFrame: lockFrame, placementNumber: 1 };
  } else {
    pace.cadenceByBotId[botId].placementNumber += 1;
  }
  const cadence = pace.cadenceByBotId[botId];
  pace.nextLockFrames[botId] = pacedLockFrame(cadence.originFrame, cadence.placementNumber, pps);
}

function rebasePendingCadence(pace, botId, lockFrame) {
  pace.cadenceByBotId[botId] = { originFrame: lockFrame, placementNumber: 0 };
  pace.nextLockFrames[botId] = lockFrame;
}

function pacedLockFrame(startedAtFrame, placementNumber, pps) {
  const frame = startedAtFrame + Math.round(placementNumber * 60 / pps);
  if (!Number.isSafeInteger(frame)) throw new Error("paced match logical frame overflow");
  return frame;
}

function assertPps(value, label) {
  if (!Number.isFinite(value) || value < 0.1 || value > 20) {
    throw new Error(`${label} must be a number from 0.1 to 20`);
  }
}

function sameStringSet(left, right) {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
}

function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative safe integer`);
}
