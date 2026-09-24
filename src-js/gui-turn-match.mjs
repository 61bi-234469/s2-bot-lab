/**
 * Turn match: the 1P side and its bot opponent place one piece per turn instead
 * of racing each other on a shared real-time clock.
 *
 * This module is the only place that decides what a turn match is, so the
 * static/WASM transport and the local native server cannot drift into different
 * turn rules. It converts one browser request into the match controller's own
 * `alternating` / `simultaneous` modes, which already own the schedule:
 *
 * - `simultaneous`: both sides commit one placement for the same turn, neither
 *   having seen the other's. The 1P lock carries the turn, because a turn
 *   cannot be advanced until the person has played their half of it.
 * - `human-first` / `bot-first`: `alternating`, starting from the named side.
 *
 * Two properties follow from the legacy final-placement route this runs on and
 * are the reason a turn match never opens under TTRM INPUT:
 *
 * - No natural gravity. A piece stays where the player leaves it until they
 *   drop it, so a turn has no falling deadline.
 * - No wall clock. The shared clock advances by the match's own `framesPerTurn`
 *   per turn, and no side is scheduled against real time, so the STALL PENALTY
 *   budget has nothing to measure and is not part of a turn match.
 */

export const TURN_MATCH_ID = "s2-gui-turn-match/1";
export const TURN_MATCH_ORDERS = Object.freeze(["simultaneous", "human-first", "bot-first"]);
export const DEFAULT_TURN_MATCH_ORDER = "simultaneous";

/**
 * Validates the browser's turn match request. Like the 1P handicap, a request
 * with no 1P side has nobody to take a turn against, so it is reported as not
 * applicable instead of failing the round start: a saved ON setting must not
 * block a bot-versus-bot match. A malformed payload still fails closed.
 */
export function normalizeTurnMatch(input, { humanSide = null } = {}) {
  if (humanSide !== null && humanSide !== "left" && humanSide !== "right") {
    throw new Error("turn match humanSide must be left, right, or null");
  }
  if (input === null || input === undefined) return disabledTurnMatch();
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new Error("turn match must be an object");
  }
  const requested = input.enabled ?? false;
  if (typeof requested !== "boolean") throw new Error("turn match enabled must be a boolean");
  const order = input.order ?? DEFAULT_TURN_MATCH_ORDER;
  if (!TURN_MATCH_ORDERS.includes(order)) throw new Error(`unsupported turn match order ${order}`);
  return Object.freeze({ id: TURN_MATCH_ID, enabled: requested && humanSide !== null, order });
}

function disabledTurnMatch() {
  return Object.freeze({ id: TURN_MATCH_ID, enabled: false, order: DEFAULT_TURN_MATCH_ORDER });
}

/**
 * The `createBotMatch` options one turn match asks for, or `null` when the
 * round keeps the ordinary paced schedule.
 */
export function turnMatchControllerOptions(turnMatch, humanSide) {
  if (turnMatch?.enabled !== true) return null;
  if (humanSide !== "left" && humanSide !== "right") {
    throw new Error("a turn match requires a 1P side");
  }
  const opponent = humanSide === "left" ? "right" : "left";
  // `simultaneous` never reads a starting side; naming the 1P side keeps the
  // snapshot's declared starter meaningful rather than positional.
  if (turnMatch.order === "simultaneous") {
    return Object.freeze({ mode: "simultaneous", startingBotId: humanSide });
  }
  return Object.freeze({
    mode: "alternating",
    startingBotId: turnMatch.order === "human-first" ? humanSide : opponent,
  });
}
