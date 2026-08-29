// Shared fail-closed rules for whether a recorded game may score as a result.
//
// Background: infrastructure failures must invalidate a game rather than score it.
// an infrastructure fault made engines answer "no suggested move" on the first
// lock in ~0.1 ms, and the old suffix-based classification scored those games
// as terminal losses. These rules make such games infrastructure failures that
// invalidate the run instead of feeding W-L-D, pair scores, or Wilson bounds.

import {
  NO_SUGGESTED_MOVE_MESSAGE,
  assertProposalResult,
  classifyProposalError,
} from "./proposal-outcome.mjs";

export { NO_LEGAL_MOVE_LATENCY_FLOOR_MS } from "./proposal-outcome.mjs";

export function isNoLegalMoveShaped(game) {
  return game?.proposalResult?.terminal?.code === "no-legal-move" ||
    game?.reason === "no-legal-move" ||
    (game?.reason === "proposal-failure" &&
      typeof game?.proposalFailure?.message === "string" &&
      game.proposalFailure.message.endsWith(NO_SUGGESTED_MOVE_MESSAGE));
}

// A "no suggested move" answer is a believable terminal loss only when the
// engine already played at least one lock in this game and the failing
// response took at least as long as a real search. An empty board cannot have
// no legal move, and a sub-floor response cannot be a search result.
export function isLegitimateNoLegalMoveLoss(game) {
  if (!isNoLegalMoveShaped(game)) return false;
  return proposalClassificationFromGame(game)?.status === "terminal";
}

// A game may enter W-L-D, pair scores, and Wilson intervals only when it ended
// for a game reason. Zero-lock games and proposal failures are infrastructure
// evidence, never results.
export function isScorableGameResult(game) {
  if (game?.locksPerSide === 0) return false;
  if (game?.proposalResult !== undefined && game?.proposalResult !== null) {
    const classification = proposalClassificationFromGame(game);
    if (classification === null || classification.status === "failure") return false;
  }
  if (isNoLegalMoveShaped(game)) return isLegitimateNoLegalMoveLoss(game);
  return game?.reason !== "proposal-failure";
}

export function proposalClassificationFromGame(game) {
  if (game?.proposalResult?.status === "terminal" || game?.proposalResult?.status === "failure") {
    try {
      return assertProposalResult(game.proposalResult);
    } catch {
      return null;
    }
  }
  if (!isNoLegalMoveShaped(game) && game?.reason !== "proposal-failure") return null;
  const evidence = game?.proposalFailure ?? {};
  const message = typeof evidence.message === "string"
    ? evidence.message
    : isNoLegalMoveShaped(game)
      ? NO_SUGGESTED_MOVE_MESSAGE
      : "unclassified proposal failure";
  return classifyProposalError({
    error: Object.assign(new Error(message), {
      requestToSuggestionMs: Number.isFinite(evidence.requestToSuggestionMs)
        ? evidence.requestToSuggestionMs
        : undefined,
    }),
    locksPlayed: game?.locksPerSide,
    latencyMs: evidence.elapsedMs ?? null,
    diagnostics: {
      engineId: evidence.engineId ?? null,
      side: evidence.side ?? evidence.botId ?? null,
      lockNumber: evidence.lockNumber ?? (Number.isSafeInteger(evidence.round) ? evidence.round + 1 : null),
    },
  });
}

export function proposalActorId(game) {
  return game?.proposalResult?.diagnostics?.engineId ??
    game?.proposalResult?.diagnostics?.botId ??
    game?.proposalFailure?.engineId ??
    game?.proposalFailure?.botId ??
    null;
}

export function summarizeProposalClassifications(games, { challengerEngineId = null } = {}) {
  let proposalFailures = 0;
  let challengerProposalFailures = 0;
  let noLegalMoveLosses = 0;
  let challengerNoLegalMoveLosses = 0;
  for (const game of games) {
    const actorId = proposalActorId(game);
    if (!isScorableGameResult(game)) {
      proposalFailures += 1;
      if (challengerEngineId !== null && actorId === challengerEngineId) {
        challengerProposalFailures += 1;
      }
    } else if (isLegitimateNoLegalMoveLoss(game)) {
      noLegalMoveLosses += 1;
      if (challengerEngineId !== null && actorId === challengerEngineId) {
        challengerNoLegalMoveLosses += 1;
      }
    }
  }
  return {
    proposalFailures,
    challengerProposalFailures,
    noLegalMoveLosses,
    challengerNoLegalMoveLosses,
  };
}
