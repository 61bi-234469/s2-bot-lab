import { canonicalize } from "./cs1-core.mjs";
import {
  createCc2SpinWitnessIndex,
  guiStateToCanonical,
} from "./cc2-s2-adapter.mjs";
import { verifyCc2S2FinalPlacement } from "./cc2-s2-final-placement-verification-memo.mjs";

export const CC2_S2_UNVERIFIABLE_CANDIDATE_POLICIES = Object.freeze([
  "record-and-skip",
  "fail-closed",
]);

/**
 * Builds a strict, replay-verified CC2 final-placement prefix.
 *
 * Evaluator policy, scoring, ranking, and report projection stay with the
 * caller. Tolerant selectors that skip invalid or duplicate moves deliberately
 * do not use this boundary.
 *
 * The prefix contract is strict and unchanged: CC2 must return the declared
 * number of candidates, the prefix may not contain duplicate identities, and
 * every scored candidate is a replay-verified canonical transition.
 *
 * What is deliberately *not* strict is an individual CC2 candidate whose
 * witness the Simulator refuses. A rejected rotation witness (for example
 * `rotation evidence does not match the configured kick table`), an illegal
 * pose, or a missing witnessed placement is a property of that one proposal,
 * not of the run: under the default `record-and-skip` policy it is recorded in
 * `rejectedCandidates` and excluded from ranking, exactly as the tolerant
 * builder already does for the control selector. Before this policy existed the
 * throw escaped the selector, was classified as a proposal failure, and
 * invalidated an otherwise healthy game (J2) even though the control engine
 * played the same position without incident.
 *
 * Fail-closed behaviour is retained: if the whole prefix is unverifiable there
 * is nothing rankable and the boundary throws. `unverifiableCandidatePolicy:
 * "fail-closed"` restores the original per-candidate throw for callers (and
 * correctness fixtures) that want the strictest possible reading.
 */
export function buildCompleteCc2FinalPlacementCandidates(guiState, moves, {
  candidateLimit,
  allowCompleteReturnedPrefix = false,
  engineId,
  comparisonSource,
  selectorLabel,
  unverifiableCandidatePolicy = "record-and-skip",
  verificationMemo = null,
}) {
  if (typeof selectorLabel !== "string" || selectorLabel.length === 0) {
    throw new Error("strict final-placement selectorLabel must be a non-empty string");
  }
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64) {
    throw new Error(`${selectorLabel} candidateLimit must be an integer from 1 to 64`);
  }
  if (typeof allowCompleteReturnedPrefix !== "boolean") {
    throw new Error(`${selectorLabel} allowCompleteReturnedPrefix must be boolean`);
  }
  if (!CC2_S2_UNVERIFIABLE_CANDIDATE_POLICIES.includes(unverifiableCandidatePolicy)) {
    throw new Error(
      `${selectorLabel} unverifiableCandidatePolicy must be one of ${CC2_S2_UNVERIFIABLE_CANDIDATE_POLICIES.join(", ")}`,
    );
  }
  if (!Array.isArray(moves) || moves.length === 0 ||
      (!allowCompleteReturnedPrefix && moves.length < candidateLimit)) {
    throw new Error(`${selectorLabel} selector requires a complete CC2 candidate prefix`);
  }
  if (typeof engineId !== "string" || engineId.length === 0 ||
      typeof comparisonSource !== "string" || comparisonSource.length === 0) {
    throw new Error(`${selectorLabel} selector requires engine and comparison identities`);
  }
  const prefix = moves.slice(0, allowCompleteReturnedPrefix
    ? Math.min(candidateLimit, moves.length)
    : candidateLimit);
  const identities = prefix.map(canonicalize);
  if (new Set(identities).size !== identities.length) {
    throw new Error(`${selectorLabel} selector prefix contains duplicate identities`);
  }
  const state = guiStateToCanonical(guiState);
  const witnessIndex = verificationMemo === null
    ? createCc2SpinWitnessIndex(guiState)
    : null;
  const candidates = [];
  const rejectedCandidates = [];
  const reject = (cc2Rank, reason) => {
    if (unverifiableCandidatePolicy === "fail-closed") {
      throw new Error(`${selectorLabel} candidate ${cc2Rank} ${reason}`);
    }
    rejectedCandidates.push({ cc2Rank, identity: identities[cc2Rank], reason });
  };
  for (const [cc2Rank, move] of prefix.entries()) {
    let verification;
    try {
      verification = verifyCc2S2FinalPlacement(guiState, move, {
        engineId,
        comparisonSource,
        spinWitnessIndex: witnessIndex,
      }, verificationMemo);
    } catch (error) {
      // A witness the Simulator refuses to admit is evidence about this
      // candidate. It never becomes a scored placement, and it must not end
      // the game the way an unhandled throw did.
      reject(cc2Rank, `witness rejected: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (verification.transition === null) {
      reject(cc2Rank, `has no legal witnessed transition: ${verification.reasons.join(",")}`);
      continue;
    }
    const placement = verification.comparison.witness?.placement;
    if (placement === null || placement === undefined) {
      reject(cc2Rank, "is missing a witnessed placement");
      continue;
    }
    candidates.push({ cc2Rank, identity: identities[cc2Rank], move, verification, placement });
  }
  if (candidates.length === 0) {
    throw new Error(
      `${selectorLabel} selector has no verifiable candidate in the complete CC2 prefix`,
    );
  }
  return { state, candidates, rejectedCandidates, returnedCandidateCount: moves.length };
}

/**
 * Collects the rank-preserving tolerant prefix used by the legacy hybrid and
 * tuning selectors. Verification failures are recorded and skipped; duplicate
 * identities keep only their first original CC2 rank. Identity construction
 * retains the callers' existing fail-closed behavior.
 *
 * Scoring, cached-value lookup, ranking, and report projection stay with the
 * caller. In particular, callers must index parallel CC2 values by cc2Rank,
 * not by the compacted candidate-array index.
 */
export function collectTolerantCc2FinalPlacementCandidates(guiState, moves, {
  candidateLimit,
  allowCompleteReturnedPrefix = true,
  engineId,
  comparisonSource,
  verificationMemo = null,
}) {
  if (typeof allowCompleteReturnedPrefix !== "boolean") {
    throw new Error("tolerant final-placement allowCompleteReturnedPrefix must be boolean");
  }
  if (!Array.isArray(moves) || moves.length === 0 ||
      (!allowCompleteReturnedPrefix && moves.length < candidateLimit)) {
    throw new Error("tolerant final-placement selector requires a complete CC2 candidate prefix");
  }
  const witnessIndex = verificationMemo === null
    ? createCc2SpinWitnessIndex(guiState)
    : null;
  const candidates = [];
  const rejectedCandidates = [];
  const seen = new Set();
  for (const [cc2Rank, move] of moves.slice(0, candidateLimit).entries()) {
    const identity = canonicalize(move);
    if (seen.has(identity)) continue;
    seen.add(identity);
    let verification;
    try {
      verification = verifyCc2S2FinalPlacement(guiState, move, {
        engineId,
        comparisonSource,
        spinWitnessIndex: witnessIndex,
      }, verificationMemo);
    } catch (error) {
      rejectedCandidates.push({
        cc2Rank,
        reason: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (verification.transition === null) {
      rejectedCandidates.push({ cc2Rank, reason: verification.reasons.join(",") });
      continue;
    }
    candidates.push({ cc2Rank, identity, move, verification });
  }
  return { candidates, rejectedCandidates, returnedCandidateCount: moves.length };
}
