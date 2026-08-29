// F9 opponent-effective-pressure counterfactual (ADR-029).
//
// Every attack-side family before this one scored a quantity on its own board:
// F2R the REN-conditioned Quad/TSD spike, F3R the surge release, F23R their
// co-occurrence. All closed at or near control. `outgoingAfterCancel` is not
// what decides a round — what the opponent is actually holding afterwards is.
//
// This evaluator is the first in `src-js` whose input is a MATCH SNAPSHOT
// rather than a single canonical state, because the opponent's state can only
// be advanced by the component that owns garbage delivery between two states:
// the match controller. ADR-029 authorizes that structural change.
//
// The opponent's move is READ, never chosen. In a simultaneous round both
// proposals are produced from the pre-round state, and a round's garbage is
// delivered at its end, so the opponent's submission is already frozen with
// respect to my choice. The declared order — opponent proposal first, then
// candidate evaluation, then one joint advance — is pinned by the protocol and
// recorded per round so a replay cannot silently reverse it.
//
// There is deliberately no cache: a cached counterfactual would have to key on
// the opponent's frozen submission as well as on my candidate, and a colliding
// key would be indistinguishable from a correct result.

import { advanceBotMatch } from "./bot-match-controller.mjs";
import { fullStateKey } from "./state-keys.mjs";

export const S2_OPPONENT_EFFECTIVE_PRESSURE_EVALUATOR_ID =
  "s2-opponent-effective-pressure-evaluator/1";
export const S2_OPPONENT_EFFECTIVE_PRESSURE_POLICY =
  "realised-opponent-round-counterfactual-own-survival-guarded/1";

// Frozen in the internal design record 2026-08-20-cc2-s2-f9-opponent-effective-pressure-protocol.md.
export const S2_OPPONENT_EFFECTIVE_PRESSURE_WEIGHTS = Object.freeze({
  opponentToppedOut: 1,
  opponentTankedRows: 0.05,
  opponentRemainingIncoming: 0.05,
  opponentVisibleMarginLost: 0.05,
});
export const S2_OPPONENT_EFFECTIVE_PRESSURE_CAP = 1;

// The canonical board is 40 rows; the bottom 20 are the visible field. Kept
// local to this module: F9 shares no constant, coefficient, or unit with F7 or
// F8, per the Cloud override record.
const VISIBLE_FIELD_HEIGHT = 20;

/**
 * Advance one simultaneous round with `submission` in my place and the
 * opponent's frozen submission in theirs, and read both sides' realised
 * outcome. Pure with respect to `match`: `advanceBotMatch` clones.
 */
export function advanceOpponentCounterfactual(match, {
  botId,
  opponentBotId,
  submission,
  opponentSubmission,
}) {
  assertRoundInputs(match, { botId, opponentBotId, opponentSubmission });
  const advanced = advanceBotMatch(match, [
    { botId, result: submission },
    { botId: opponentBotId, result: opponentSubmission },
  ]);
  return Object.freeze({
    opponent: sideOutcome(match, advanced, opponentBotId),
    own: sideOutcome(match, advanced, botId),
  });
}

/**
 * The realised pressure delta of one candidate against the control selection,
 * both advanced from the same match snapshot with the same frozen opponent
 * submission.
 *
 * Pressure is never bought with my own survival: a candidate that worsens my
 * own top-out, my own tanked rows, or my own visible margin relative to the
 * control is forced to zero rather than scored.
 */
export function extractS2OpponentEffectivePressure(candidateOutcome, controlOutcome, {
  weights = S2_OPPONENT_EFFECTIVE_PRESSURE_WEIGHTS,
  cap = S2_OPPONENT_EFFECTIVE_PRESSURE_CAP,
} = {}) {
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error("opponent pressure cap must be a positive finite number");
  }
  const opponentToppedOut = Number(candidateOutcome.opponent.toppedOut) -
    Number(controlOutcome.opponent.toppedOut);
  const opponentTankedRows = candidateOutcome.opponent.tankedRows -
    controlOutcome.opponent.tankedRows;
  const opponentRemainingIncoming = candidateOutcome.opponent.remainingIncoming -
    controlOutcome.opponent.remainingIncoming;
  const opponentVisibleMarginLost = controlOutcome.opponent.visibleTopOutMargin -
    candidateOutcome.opponent.visibleTopOutMargin;

  const ownGuardPassed = !(
    (candidateOutcome.own.toppedOut && !controlOutcome.own.toppedOut) ||
    candidateOutcome.own.tankedRows > controlOutcome.own.tankedRows ||
    candidateOutcome.own.visibleTopOutMargin < controlOutcome.own.visibleTopOutMargin
  );

  const raw = weights.opponentToppedOut * opponentToppedOut +
    weights.opponentTankedRows * opponentTankedRows +
    weights.opponentRemainingIncoming * opponentRemainingIncoming +
    weights.opponentVisibleMarginLost * opponentVisibleMarginLost;
  const bounded = Math.max(-cap, Math.min(cap, raw));
  const units = ownGuardPassed ? bounded : 0;

  return Object.freeze({
    opponentToppedOut,
    opponentTankedRows,
    opponentRemainingIncoming,
    opponentVisibleMarginLost,
    opponent: candidateOutcome.opponent,
    own: candidateOutcome.own,
    ownGuardPassed,
    guarded: !ownGuardPassed,
    units,
    qualifies: units !== 0,
  });
}

/**
 * Full evaluation for one candidate: advance the counterfactual, compare it
 * against the control advance, and return the units with the evaluator
 * identity attached.
 */
export function evaluateS2OpponentEffectivePressure(match, {
  botId,
  opponentBotId,
  submission,
  opponentSubmission,
  controlOutcome,
  weights,
  cap,
}) {
  const outcome = advanceOpponentCounterfactual(match, {
    botId,
    opponentBotId,
    submission,
    opponentSubmission,
  });
  return Object.freeze({
    stateKey: fullStateKey(botState(match, botId)),
    opponentStateKey: fullStateKey(botState(match, opponentBotId)),
    opponentSubmissionFingerprint: submissionFingerprint(opponentSubmission),
    ...extractS2OpponentEffectivePressure(outcome, controlOutcome, { weights, cap }),
    evaluator: Object.freeze({
      id: S2_OPPONENT_EFFECTIVE_PRESSURE_EVALUATOR_ID,
      policy: S2_OPPONENT_EFFECTIVE_PRESSURE_POLICY,
      direction: "higher-is-better",
    }),
  });
}

export function submissionFingerprint(submission) {
  const fingerprint = submission?.positionFingerprint ??
    submission?.comparison?.positionFingerprint ?? null;
  if (typeof fingerprint !== "string" || fingerprint.length === 0) {
    throw new Error("opponent submission must carry a position fingerprint");
  }
  return fingerprint;
}

function sideOutcome(before, after, id) {
  const beforeBot = botOf(before, id);
  const afterBot = botOf(after, id);
  return Object.freeze({
    botId: id,
    toppedOut: isToppedOut(afterBot.state.board),
    tankedRows: afterBot.stats.garbageReceived - beforeBot.stats.garbageReceived,
    remainingIncoming: confirmedIncoming(afterBot.state),
    visibleTopOutMargin: visibleTopOutMargin(afterBot.state.board),
  });
}

function confirmedIncoming(state) {
  return (state.garbage?.packets ?? [])
    .filter((packet) => packet.confirmed === true)
    .reduce((total, packet) => total + packet.amount, 0);
}

function isToppedOut(board) {
  for (let index = VISIBLE_FIELD_HEIGHT * board.width; index < board.cells.length; index += 1) {
    if (board.cells[index] !== "_") return true;
  }
  return false;
}

function visibleTopOutMargin(board) {
  let highest = -1;
  for (let index = board.cells.length - 1; index >= 0; index -= 1) {
    if (board.cells[index] !== "_") {
      highest = Math.floor(index / board.width);
      break;
    }
  }
  return VISIBLE_FIELD_HEIGHT - (highest + 1);
}

function botOf(match, id) {
  const bot = match.bots.find((candidate) => candidate.id === id);
  if (bot === undefined) throw new Error(`match has no bot ${id}`);
  return bot;
}

function botState(match, id) {
  return botOf(match, id).state;
}

function assertRoundInputs(match, { botId, opponentBotId, opponentSubmission }) {
  if (match?.mode !== "simultaneous") {
    throw new Error("the opponent counterfactual is defined for a simultaneous round only");
  }
  if (botId === opponentBotId) {
    throw new Error("the opponent counterfactual needs two distinct bot ids");
  }
  // The freeze is checked, not trusted: an opponent submission produced from
  // any state other than this round's pre-round opponent state would make the
  // counterfactual meaningless.
  const expected = fullStateKey(botState(match, opponentBotId));
  if (submissionFingerprint(opponentSubmission) !== expected) {
    throw new Error("the opponent submission is not frozen against this round's opponent state");
  }
}
