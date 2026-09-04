export const DEFAULT_BOT_MATCH_OPTIONS = Object.freeze({
  leftThinkMs: 250,
  rightThinkMs: 250,
  fairComparison: false,
  seed: 0x5e2,
  maxTurns: 500,
});

export function normalizeBotMatchOptions(input = {}) {
  const fairComparison = booleanValue(input.fairComparison ?? DEFAULT_BOT_MATCH_OPTIONS.fairComparison, "fairComparison");
  return Object.freeze({
    leftThinkMs: integerInRange(input.leftThinkMs ?? DEFAULT_BOT_MATCH_OPTIONS.leftThinkMs, 10, 10_000, "leftThinkMs"),
    rightThinkMs: integerInRange(input.rightThinkMs ?? DEFAULT_BOT_MATCH_OPTIONS.rightThinkMs, 10, 10_000, "rightThinkMs"),
    fairComparison,
    seed: integerInRange(input.seed ?? DEFAULT_BOT_MATCH_OPTIONS.seed, 0, 0xffff_ffff, "seed"),
    maxTurns: input.maxTurns === null
      ? null
      : integerInRange(input.maxTurns ?? DEFAULT_BOT_MATCH_OPTIONS.maxTurns, 1, 10_000, "maxTurns"),
  });
}

/** Converts a CC2 time budget into its matching lock rate, capped by the
 * supported bot-match PPS range. */
export function ppsForThinkTime(thinkMs) {
  const budget = integerInRange(thinkMs, 10, 10_000, "thinkMs");
  return Math.max(0.1, Math.min(20, 1000 / budget));
}

/** Resolves the synthetic match cadence used when a CC2 bot has no explicit
 * PPS limiter. A selection-limited search has no duration known in advance, so
 * the earliest supported cadence adds no visible wait after its reply; actual
 * placement still cannot happen before the search completes. A time-only
 * search maps its configured duration to the equivalent cadence. */
export function ppsForCc2Parameters(parameters) {
  if (parameters?.ppsEnabled !== false) return parameters.pps;
  if (parameters.selectionEnabled) return 20;
  return ppsForThinkTime(parameters.thinkMs);
}

/**
 * Keeps GUI playback close to real time. CC2 suggestion
 * processes have startup and protocol overhead in addition to their configured
 * search time, so reserve part of each synthetic lock cadence for that work.
 * Headless comparison arenas intentionally do not use this playback cap.
 */
export function realtimeCc2ThinkMs({
  thinkMs,
  stepFrames,
  serialProposalCount = 1,
  framesPerSecond = 60,
}) {
  const configured = integerInRange(thinkMs, 10, 60_000, "thinkMs");
  const frames = numberInRange(stepFrames, Number.EPSILON, Number.MAX_VALUE, "stepFrames");
  const proposalCount = integerInRange(serialProposalCount, 1, 100, "serialProposalCount");
  const fps = numberInRange(framesPerSecond, Number.EPSILON, Number.MAX_VALUE, "framesPerSecond");
  const realCadenceMs = frames * 1000 / fps;
  const cadenceBudgetMs = Math.floor(realCadenceMs * 0.7 / proposalCount);
  return Math.max(10, Math.min(configured, cadenceBudgetMs));
}

function booleanValue(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function numberInRange(value, minimum, maximum, label) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a number from ${minimum} to ${maximum}`);
  }
  return value;
}

export function matchOutcome(bots, turnNumber, maxTurns) {
  const toppedOut = bots.filter((bot) => bot.toppedOut);
  if (toppedOut.length > 0) {
    const survivors = bots.filter((bot) => !bot.toppedOut);
    return Object.freeze({
      complete: true,
      reason: "top-out",
      winnerBotId: survivors.length === 1 ? survivors[0].id : null,
    });
  }
  if (maxTurns !== null && turnNumber >= maxTurns) {
    return Object.freeze({ complete: true, reason: "max-turns", winnerBotId: null });
  }
  return Object.freeze({ complete: false, reason: null, winnerBotId: null });
}

function integerInRange(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}
