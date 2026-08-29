// How a failed CC2 suggestion request ends the current game.
//
// Background: an empty suggestion must end only the affected game.
// a CC2 process can answer a suggestion request with an empty `moves` array,
// or fail to answer at all. Both reach the GUI server as errors, and both used
// to escape `/api/match/step` and end the whole series. They end one game
// instead, but not unconditionally: the same empty-suggestion message also
// comes out of an infrastructure fault, and a fault scored as a loss silently
// contaminates a series in the way D-2 contaminated the arena runs.

import {
  NO_SUGGESTED_MOVE_MESSAGE,
  classifyProposalError,
} from "./proposal-outcome.mjs";

export { NO_SUGGESTED_MOVE_MESSAGE } from "./proposal-outcome.mjs";

/**
 * The bridge throws these messages bare, but the arena's classification matches
 * by suffix so a wrapped message keeps its meaning. Match them the same way.
 *
 * The session waits on `info` and `ready` with the same timeout wording, so
 * only the message naming `suggestion` may end a game.
 */
export function isNoSuggestedMoveError(error) {
  return error instanceof Error && error.message.endsWith(NO_SUGGESTED_MOVE_MESSAGE);
}

/**
 * Classifies an empty suggestion as a forfeit of the current game or as an
 * infrastructure failure.
 *
 * A genuine no-placement answer needs a board to have no placement on and a
 * full TBP round trip to say so. An answer before the bot's first lock comes
 * from a board that cannot be blocked, and a sub-floor answer never reached
 * the process at all — both are faults, and both must stop the series rather
 * than hand the opponent a win.
 *
 * Timeouts and other transport errors remain failures. This compatibility
 * adapter exposes only the historical empty-suggestion result shape.
 *
 * @param {{ error: unknown, locksPlayed: number, elapsedMs: number|null }} failure
 * @returns {{ type: "forfeit" }|{ type: "failure", reason: string }}
 */
export function classifyEmptySuggestion({ error, locksPlayed, elapsedMs }) {
  const result = classifyProposalError({ error, locksPlayed, latencyMs: elapsedMs });
  if (result.status === "terminal") return { type: "forfeit" };
  const reason = result.failure.code === "no-legal-move-before-first-lock"
    ? "before-first-lock"
    : result.failure.code === "no-legal-move-below-latency-floor"
      ? "below-latency-floor"
      : "not-empty-suggestion";
  return { type: "failure", reason };
}

/** Terminal reasons a suggestion failure can end a game with. */
export const SUGGESTION_FAILURE_REASONS = Object.freeze(["no-suggested-move"]);

/**
 * The completed-game view a suggestion failure produces: the side that could
 * not answer loses, and the match view reports the game as over for that
 * reason so the browser starts the next game of the series instead of ending
 * it.
 */
export function suggestionFailureOutcome(bots, losingBotId, reason) {
  if (!SUGGESTION_FAILURE_REASONS.includes(reason)) {
    throw new Error(`unknown suggestion failure reason ${reason}`);
  }
  const winner = bots.find((bot) => bot.id !== losingBotId);
  if (winner === undefined) throw new Error(`no opponent for losing bot ${losingBotId}`);
  return Object.freeze({
    complete: true,
    reason,
    winnerBotId: winner.id,
  });
}

/** Explains a rejected forfeit in the error the series stops on. */
export function emptySuggestionFailureMessage(botId, { reason, locksPlayed, elapsedMs }) {
  const latency = elapsedMs === null || elapsedMs === undefined
    ? "unknown"
    : `${elapsedMs.toFixed(3)} ms`;
  return `${botId} (${reason}, ${locksPlayed} locks, ${latency}): ${NO_SUGGESTED_MOVE_MESSAGE}`;
}
