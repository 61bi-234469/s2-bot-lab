/**
 * ReplayIR -> S-STATE/1 clock adapter.
 *
 * Raw .ttrm event frames are input scheduling frames.  A placement's actual
 * lock frame is only known after the recorded events have been replayed by the
 * TETR.IO-compatible engine, so lock clocks deliberately consume verified
 * PlayerRoundIR.locks entries instead of trying to infer locks from hard-drop
 * key events.
 */

export const REPLAY_CLOCK_ADAPTER = "replay-clock/1";

export class ReplayClockError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ReplayClockError";
    this.code = code;
  }
}

/**
 * Returns canonical time at an arbitrary replay cursor.
 *
 * A cursor exactly on a lock frame observes every lock recorded on that frame,
 * matching ReplayIR timeline semantics.  Use clockForReplayLock when evaluating
 * one particular lock, especially when several locks share a frame.
 */
export function clockAtReplayCursor(player, cursorFrame, options = {}) {
  const replay = validateVerifiedPlayerRound(player);
  assertFrame(cursorFrame, "cursor frame");
  if (cursorFrame > replay.terminalFrame) {
    throw new ReplayClockError(
      "frame-after-terminal",
      `cursor frame ${cursorFrame} is after terminal frame ${replay.terminalFrame}`,
    );
  }

  const piecesPlaced = upperBound(replay.lockFrames, cursorFrame);
  return result(
    cursorFrame,
    piecesPlaced,
    {
      boundary: "cursor",
      frameSource: "replay-cursor-frame",
      terminalFrame: replay.terminalFrame,
      sourceSha256: sourceSha256(options),
    },
  );
}

/**
 * Returns the canonical clock used to evaluate a specific observed placement.
 *
 * `piecesPlaced` is the count before this lock, while `logicalFrame` is the
 * Engine frame captured by `falling.lock`.  This is intentionally distinct
 * from the visual pre-lock cursor (`lock.frame - 1`): dynamic multiplier/cap
 * rules are read on the Engine lock frame.
 */
export function clockForReplayLock(player, lockIndex, options = {}) {
  const replay = validateVerifiedPlayerRound(player);
  const index = assertLockIndex(lockIndex, replay.lockFrames.length);
  return result(
    replay.lockFrames[index],
    index,
    {
      boundary: "lock-evaluation",
      frameSource: "PlayerRoundIR.locks[].frame",
      lockIndex: index,
      terminalFrame: replay.terminalFrame,
      sourceSha256: sourceSha256(options),
    },
  );
}

/** Returns canonical time immediately after a specific ReplayIR lock. */
export function clockAfterReplayLock(player, lockIndex, options = {}) {
  const replay = validateVerifiedPlayerRound(player);
  const index = assertLockIndex(lockIndex, replay.lockFrames.length);
  return result(
    replay.lockFrames[index],
    index + 1,
    {
      boundary: "post-lock",
      frameSource: "PlayerRoundIR.locks[].frame",
      lockIndex: index,
      terminalFrame: replay.terminalFrame,
      sourceSha256: sourceSha256(options),
    },
  );
}

/** Returns the exact terminal replay clock. */
export function clockAtReplayTerminal(player, options = {}) {
  const replay = validateVerifiedPlayerRound(player);
  return result(
    replay.terminalFrame,
    replay.lockFrames.length,
    {
      boundary: "terminal",
      frameSource: "PlayerRoundIR.terminal.frame",
      terminalFrame: replay.terminalFrame,
      sourceSha256: sourceSha256(options),
    },
  );
}

function validateVerifiedPlayerRound(player) {
  if (player === null || typeof player !== "object" || Array.isArray(player)) {
    throw new ReplayClockError("invalid-replay-ir", "PlayerRoundIR must be an object");
  }
  if (player.verification?.matched !== true) {
    throw new ReplayClockError(
      "unverified-replay-ir",
      "exact replay clocks require ReplayIR verification.matched === true",
    );
  }
  if (!Array.isArray(player.locks)) {
    throw new ReplayClockError("invalid-replay-ir", "PlayerRoundIR.locks must be an array");
  }
  const terminalFrame = player.terminal?.frame;
  assertFrame(terminalFrame, "terminal frame");

  const lockFrames = player.locks.map((lock, index) => {
    const frame = lock?.frame;
    assertFrame(frame, `lock ${index} frame`);
    if (index > 0 && frame < player.locks[index - 1].frame) {
      throw new ReplayClockError(
        "non-monotonic-lock-frames",
        `lock ${index} frame ${frame} precedes lock ${index - 1} frame ${player.locks[index - 1].frame}`,
      );
    }
    return frame;
  });
  const lastFrame = lockFrames.at(-1);
  if (lastFrame !== undefined && terminalFrame < lastFrame) {
    throw new ReplayClockError(
      "terminal-before-lock",
      `terminal frame ${terminalFrame} precedes last lock frame ${lastFrame}`,
    );
  }

  const piecesVerification = player.verification?.piecesplaced;
  if (
    piecesVerification !== undefined &&
    (piecesVerification.actual !== lockFrames.length || piecesVerification.expected !== lockFrames.length)
  ) {
    throw new ReplayClockError(
      "inconsistent-replay-verification",
      "ReplayIR piecesplaced verification is inconsistent with locks.length",
    );
  }
  return { lockFrames, terminalFrame };
}

function result(logicalFrame, piecesPlaced, evidence) {
  return {
    time: {
      logicalFrame,
      frameSemantics: "engine-frame",
      piecesPlaced,
      fidelity: "exact",
    },
    evidence: {
      kind: "replay-engine-frame",
      adapter: REPLAY_CLOCK_ADAPTER,
      replayVerification: "matched",
      ...evidence,
    },
  };
}

function assertFrame(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ReplayClockError("invalid-frame", `${label} must be a non-negative safe integer`);
  }
}

function assertLockIndex(value, length) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= length) {
    throw new ReplayClockError(
      "invalid-lock-index",
      `lock index must be an integer in [0, ${Math.max(0, length - 1)}]`,
    );
  }
  return value;
}

function sourceSha256(options) {
  const value = options?.sourceSha256 ?? null;
  if (value !== null && !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new ReplayClockError(
      "invalid-source-hash",
      "sourceSha256 must be null or a lowercase sha256:<64 hex> identifier",
    );
  }
  return value;
}

function upperBound(sorted, target) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (sorted[middle] <= target) low = middle + 1;
    else high = middle;
  }
  return low;
}
