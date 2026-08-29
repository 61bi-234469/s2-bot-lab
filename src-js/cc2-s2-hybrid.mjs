import { collectTolerantCc2FinalPlacementCandidates } from
  "./cc2-s2-final-placement-candidates.mjs";

export const CC2_S2_HYBRID_ID = "cold-clear-2-s2-hybrid/1";
export const CC2_S2_CANDIDATE_GENERATOR_ID =
  "minuskelvin-cold-clear-2/ed8b193-root-candidates/1";
export const CC2_S2_SELECTION_POLICY = "s2-evaluation-minus-cc2-rank-penalty/1";

/**
 * Uses CC2's deep search as a positional prior and the canonical S2 Simulator
 * as the final tactical authority. Invalid standard-Tetris candidates are
 * discarded instead of being repaired or silently applied under different
 * rules.
 */
export function selectCc2S2HybridPlacement(guiState, moves, {
  candidateLimit = 16,
  // Preserve CC2's deeper positional judgment by default. An alternate root
  // must have an overwhelming canonical S2 tactical advantage (for example,
  // avoiding top-out) before it can replace the searched top move.
  rankPenalty = 100,
  engineId = CC2_S2_HYBRID_ID,
  comparisonSource = "cold-clear-2-s2-hybrid-final-placement",
} = {}) {
  assertOptions(moves, candidateLimit, rankPenalty);
  const collection = collectTolerantCc2FinalPlacementCandidates(guiState, moves, {
    candidateLimit,
    engineId,
    comparisonSource,
  });
  const candidates = collection.candidates.map(({
    cc2Rank,
    identity,
    move,
    verification,
  }) => {
    const s2Score = verification.comparison.score;
    return {
      cc2Rank,
      move,
      verification,
      s2Score,
      selectionScore: s2Score - cc2Rank * rankPenalty,
      identity,
    };
  });
  const rejected = collection.rejectedCandidates;
  candidates.sort((left, right) =>
    right.selectionScore - left.selectionScore ||
    left.cc2Rank - right.cc2Rank ||
    left.identity.localeCompare(right.identity, "en")
  );
  const best = candidates[0] ?? null;
  if (best === null) {
    return {
      status: "unsupported",
      reasons: ["cc2-s2-hybrid-has-no-legal-candidate"],
      transition: null,
      move: null,
      rejectedCandidates: rejected,
    };
  }

  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison,
      source: comparisonSource,
      engineId,
      candidateGenerator: CC2_S2_CANDIDATE_GENERATOR_ID,
      moveSelectionPolicy: CC2_S2_SELECTION_POLICY,
      candidateLimit,
      generatedCandidates: candidates.length,
      rejectedCandidates: rejected.length,
      selectedCc2Rank: best.cc2Rank,
      rankPenalty,
      s2Score: best.s2Score,
      selectionScore: best.selectionScore,
    },
    candidates: candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      move: structuredClone(candidate.move),
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      spin: candidate.verification.transition.lockResult.spin,
      outgoingAfterCancel: candidate.verification.transition.cancelResult.outgoingAfterCancel,
    })),
    rejectedCandidates: rejected,
  };
}

function assertOptions(moves, candidateLimit, rankPenalty) {
  if (!Array.isArray(moves) || moves.length === 0) {
    throw new Error("CC2 S2 hybrid requires at least one candidate move");
  }
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64) {
    throw new Error("candidateLimit must be an integer from 1 to 64");
  }
  if (!Number.isFinite(rankPenalty) || rankPenalty < 0 || rankPenalty > 100) {
    throw new Error("rankPenalty must be a number from 0 to 100");
  }
}
