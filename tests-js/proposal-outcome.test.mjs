import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  SUGGESTION_TIMEOUT_MESSAGE,
  classifyProposalError,
  gameEndFromProposalResult,
} from "../src-js/proposal-outcome.mjs";
import {
  isScorableGameResult,
  proposalClassificationFromGame,
  summarizeProposalClassifications,
} from "../src-js/cc2-s2-game-validity.mjs";

const fixture = JSON.parse(readFileSync(
  new URL("../fixtures/arena/proposal-outcome-cases.json", import.meta.url),
  "utf8",
));

test("shared proposal cases classify provenance once", () => {
  for (const entry of fixture.cases) {
    const error = Object.assign(new Error(entry.message), {
      requestToSuggestionMs: entry.requestToSuggestionMs,
    });
    const result = classifyProposalError({
      error,
      locksPlayed: entry.locksPlayed,
      latencyMs: 999,
      diagnostics: {
        engineId: entry.engineId,
        side: entry.side,
        lockNumber: entry.lockNumber,
      },
    });
    assert.equal(result.status, entry.expectedStatus, entry.id);
    assert.equal(result.terminal?.code ?? result.failure?.code, entry.expectedCode, entry.id);
    assert.equal(result.latencyMs, entry.requestToSuggestionMs, `${entry.id}: bridge timing wins`);
    assert.equal(result.diagnostics.message, entry.message, `${entry.id}: raw message retained`);

    const end = gameEndFromProposalResult(result, { opponentEngineId: "candidate" });
    const game = {
      ...end,
      locksPerSide: entry.locksPlayed,
    };
    assert.equal(isScorableGameResult(game), entry.scorable, entry.id);
    assert.equal(proposalClassificationFromGame(game), game.proposalResult, entry.id);
    assert.equal(
      game.winnerEngineId,
      entry.expectedStatus === "terminal" ? "candidate" : null,
      entry.id,
    );
  }
});

test("terminal provenance does not increment proposal failures", () => {
  const games = fixture.cases.map((entry) => {
    const error = Object.assign(new Error(entry.message), {
      requestToSuggestionMs: entry.requestToSuggestionMs,
    });
    const result = classifyProposalError({
      error,
      locksPlayed: entry.locksPlayed,
      diagnostics: {
        engineId: entry.engineId,
        side: entry.side,
        lockNumber: entry.lockNumber,
      },
    });
    return {
      ...gameEndFromProposalResult(result, { opponentEngineId: "candidate" }),
      locksPerSide: entry.locksPlayed,
    };
  });
  assert.deepEqual(summarizeProposalClassifications(games, { challengerEngineId: "control" }), {
    proposalFailures: 2,
    challengerProposalFailures: 1,
    noLegalMoveLosses: 1,
    challengerNoLegalMoveLosses: 1,
  });
});

test("the F1 requestToSuggestionMs legacy shape uses the same latency gate", () => {
  for (const entry of fixture.cases.slice(0, 2)) {
    const game = {
      reason: "proposal-failure",
      winnerEngineId: null,
      locksPerSide: entry.locksPlayed,
      proposalFailure: {
        message: entry.message,
        requestToSuggestionMs: entry.requestToSuggestionMs,
        round: entry.lockNumber - 1,
        botId: entry.side,
        engineId: entry.engineId,
      },
    };
    const result = proposalClassificationFromGame(game);
    assert.equal(result.status, entry.expectedStatus, entry.id);
    assert.equal(result.latencyMs, entry.requestToSuggestionMs, entry.id);
    assert.equal(isScorableGameResult(game), entry.scorable, entry.id);
  }
});

test("the observed F1 terminal shape keeps provenance without counting a failure", () => {
  const entry = fixture.cases[0];
  const game = {
    reason: "no-legal-move",
    winnerEngineId: "candidate",
    locksPerSide: entry.locksPlayed,
    proposalFailure: {
      message: entry.message,
      requestToSuggestionMs: entry.requestToSuggestionMs,
      round: entry.lockNumber - 1,
      botId: entry.side,
      engineId: entry.engineId,
    },
  };
  assert.deepEqual(summarizeProposalClassifications([game], { challengerEngineId: "control" }), {
    proposalFailures: 0,
    challengerProposalFailures: 0,
    noLegalMoveLosses: 1,
    challengerNoLegalMoveLosses: 1,
  });
});

test("a malformed canonical proposal result fails closed", () => {
  for (const proposalResult of [
    { status: "terminal" },
    {
      status: "terminal",
      placement: null,
      terminal: { code: "no-legal-move" },
      failure: null,
      latencyMs: 5.5,
    },
    {
      status: "terminal",
      placement: null,
      terminal: { code: "no-legal-move" },
      failure: null,
      diagnostics: { message: "CC2 returned no suggested move" },
      latencyMs: -1,
    },
  ]) {
    const game = {
      reason: "no-legal-move",
      winnerEngineId: "candidate",
      locksPerSide: 10,
      proposalResult,
    };
    assert.equal(proposalClassificationFromGame(game), null);
    assert.equal(isScorableGameResult(game), false);
  }
});

test("a suggestion timeout is a fail-closed proposal failure", () => {
  const result = classifyProposalError({
    error: new Error(SUGGESTION_TIMEOUT_MESSAGE),
    locksPlayed: 40,
    latencyMs: 10_000,
  });
  assert.equal(result.status, "failure");
  assert.equal(result.failure.code, "suggestion-timeout");
  assert.equal(gameEndFromProposalResult(result).winnerEngineId, null);
});
