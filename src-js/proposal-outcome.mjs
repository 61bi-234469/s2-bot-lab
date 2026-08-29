// Canonical proposal result and outcome classification.
//
// Proposers report only whether they produced a placement, reached a proven
// no-legal-move terminal, or failed. They never decide the game winner. Arena
// adapters map this value into their existing game record after identifying
// the opposing engine.

export const NO_LEGAL_MOVE_LATENCY_FLOOR_MS = 1;
export const NO_SUGGESTED_MOVE_MESSAGE = "CC2 returned no suggested move";
export const SUGGESTION_TIMEOUT_MESSAGE = "CC2 session timed out waiting for suggestion";

export function successfulProposal({ placement = null, diagnostics = {}, latencyMs = 0 } = {}) {
  return proposalResult({
    status: "ok",
    placement,
    terminal: null,
    failure: null,
    diagnostics,
    latencyMs,
  });
}

export function classifyProposalError({ error, locksPlayed, latencyMs = null, diagnostics = {} }) {
  const message = error instanceof Error ? error.message : String(error);
  const measuredLatency = Number.isFinite(error?.requestToSuggestionMs)
    ? error.requestToSuggestionMs
    : latencyMs;
  const evidence = { ...diagnostics, message };

  if (message.endsWith(SUGGESTION_TIMEOUT_MESSAGE)) {
    return failedProposal({ code: "suggestion-timeout", message, diagnostics: evidence, latencyMs: measuredLatency });
  }
  if (!message.endsWith(NO_SUGGESTED_MOVE_MESSAGE)) {
    return failedProposal({ code: "proposal-error", message, diagnostics: evidence, latencyMs: measuredLatency });
  }
  if (!Number.isSafeInteger(locksPlayed) || locksPlayed < 1) {
    return failedProposal({
      code: "no-legal-move-before-first-lock",
      message,
      diagnostics: evidence,
      latencyMs: measuredLatency,
    });
  }
  if (measuredLatency !== null && measuredLatency !== undefined &&
      measuredLatency < NO_LEGAL_MOVE_LATENCY_FLOOR_MS) {
    return failedProposal({
      code: "no-legal-move-below-latency-floor",
      message,
      diagnostics: evidence,
      latencyMs: measuredLatency,
    });
  }
  return proposalResult({
    status: "terminal",
    placement: null,
    terminal: { code: "no-legal-move" },
    failure: null,
    diagnostics: evidence,
    latencyMs: measuredLatency,
  });
}

export function gameEndFromProposalResult(result, { opponentEngineId = null } = {}) {
  assertProposalResult(result);
  if (result.status === "ok") throw new Error("an ok proposal does not end a game");
  if (result.status === "terminal") {
    return {
      reason: result.terminal.code,
      winnerEngineId: opponentEngineId,
      proposalFailure: null,
      proposalResult: structuredClone(result),
    };
  }
  return {
    reason: "proposal-failure",
    winnerEngineId: null,
    proposalFailure: {
      engineId: result.diagnostics.engineId ?? null,
      side: result.diagnostics.side ?? result.diagnostics.botId ?? null,
      lockNumber: result.diagnostics.lockNumber ?? null,
      elapsedMs: result.latencyMs,
      message: result.failure.message,
      code: result.failure.code,
    },
    proposalResult: structuredClone(result),
  };
}

export function assertProposalResult(result) {
  if (result === null || typeof result !== "object" ||
      !["ok", "terminal", "failure"].includes(result.status)) {
    throw new Error("proposal result status must be ok, terminal, or failure");
  }
  const populated = [result.placement, result.terminal, result.failure].filter((value) => value !== null);
  const expected = result.status === "ok" && result.placement === null ? 0 : 1;
  if (populated.length !== expected) throw new Error("proposal result payload does not match its status");
  if (result.status === "terminal" && result.terminal?.code !== "no-legal-move") {
    throw new Error("proposal terminal must be a proven no-legal-move");
  }
  if (result.status === "failure" && typeof result.failure?.code !== "string") {
    throw new Error("proposal failure code is missing");
  }
  if (result.status === "failure" && typeof result.failure?.message !== "string") {
    throw new Error("proposal failure message is missing");
  }
  if (result.diagnostics === null || typeof result.diagnostics !== "object" ||
      Array.isArray(result.diagnostics) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(result.diagnostics))) {
    throw new Error("proposal diagnostics must be a plain object");
  }
  if (result.status === "terminal" && typeof result.diagnostics.message !== "string") {
    throw new Error("proposal terminal raw message is missing");
  }
  if (result.latencyMs !== null &&
      (!Number.isFinite(result.latencyMs) || result.latencyMs < 0)) {
    throw new Error("proposal latencyMs must be a non-negative number or null");
  }
  return result;
}

export function failedProposal({ code, message, diagnostics = {}, latencyMs = null }) {
  return proposalResult({
    status: "failure",
    placement: null,
    terminal: null,
    failure: { code, message },
    diagnostics,
    latencyMs,
  });
}

function proposalResult({ status, placement, terminal, failure, diagnostics, latencyMs }) {
  if (latencyMs !== null && latencyMs !== undefined &&
      (!Number.isFinite(latencyMs) || latencyMs < 0)) {
    throw new Error("proposal latencyMs must be a non-negative number or null");
  }
  const result = {
    status,
    placement: placement === null ? null : structuredClone(placement),
    terminal: terminal === null ? null : { ...terminal },
    failure: failure === null ? null : { ...failure },
    diagnostics: structuredClone(diagnostics),
    latencyMs: latencyMs ?? null,
  };
  assertProposalResult(result);
  return result;
}
