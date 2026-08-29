import { canonicalize } from "./cs1-core.mjs";
import { buildCompleteCc2FinalPlacementCandidates } from "./cc2-s2-final-placement-candidates.mjs";
import { createTuningModel } from "./cc2-s2-tuning.mjs";
import { scoreEvaluationFeatures } from "./evaluation.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import {
  S2_SURGE_RELEASE_SPIKE_EVALUATOR_ID,
  evaluateS2SurgeReleaseSpike,
} from "./s2-surge-release-spike-evaluator.mjs";

export const S2_SURGE_RELEASE_SPIKE_SELECTOR_POLICY =
  "aligned-s2-score-plus-exact-surge-release-spike-gain-minus-cc2-rank/1";
export const S2_SURGE_RELEASE_SPIKE_RETURNED_PREFIX_POLICY =
  "aligned-s2-score-plus-exact-surge-release-spike-gain-returned-prefix-minus-cc2-rank/1";

// Cross-candidate diagnostic only (never a selectionScore adjustment -- see
// the "Why the dominance penalty is not reapplied" section of
// the internal design record 2026-08-20-cc2-s2-f3r-surge-release-spike-protocol.md). Flags a
// non-defensive release (surgeSent > 0, cancelled === 0) that did no better,
// in total realised combat, than some other candidate in the same complete
// set that kept B2B intact (surgeSent === 0, b2bAfter > 0). The baseline
// evaluator already scores `outgoingAfterCancel` (1.2) and `cancelled` (1.0)
// directly (src-js/evaluation.mjs), so a dominated release already scores no
// better there without F3R adding a second, unvalidated fixed penalty on
// top of the measured `releaseValue` this family exists to replace F3's
// fixed constants with.
export function annotateDominatedSurgeRelease(candidates) {
  for (const candidate of candidates) {
    const release = candidate.surgeRelease;
    const realised = release.outgoingAfterCancel + release.cancelled;
    const dominated = release.surgeSent > 0 && release.cancelled === 0 && candidates.some((other) =>
      other !== candidate &&
      other.surgeRelease.surgeSent === 0 && other.surgeRelease.b2bAfter > 0 &&
      other.surgeRelease.outgoingAfterCancel + other.surgeRelease.cancelled >= realised);
    candidate.surgeRelease = { ...release, dominatedNonDefensiveRelease: dominated };
  }
  return candidates;
}

/** Select only from the complete CC2 prefix; missing canonical evidence rejects the selection. */
export function selectS2SurgeReleaseSpikePlacement(guiState, moves, {
  candidateLimit = 16,
  rankPenalty = 25,
  adjustmentScale = 28,
  weightProfileId = "sparse-s2",
  weights = {},
  allowCompleteReturnedPrefix = false,
  engineId = S2_SURGE_RELEASE_SPIKE_EVALUATOR_ID,
  comparisonSource = S2_SURGE_RELEASE_SPIKE_SELECTOR_POLICY,
  verificationMemo = null,
} = {}) {
  if (!Array.isArray(moves) || moves.length === 0 ||
    (!allowCompleteReturnedPrefix && moves.length < candidateLimit)) {
    throw new Error("Surge release spike selector requires a complete CC2 candidate prefix");
  }
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64) {
    throw new Error("Surge release spike candidateLimit must be an integer from 1 to 64");
  }
  if (!Number.isFinite(rankPenalty) || rankPenalty < 0 || rankPenalty > 100 ||
    !Number.isFinite(adjustmentScale) || adjustmentScale < 0 || adjustmentScale > 100) {
    throw new Error("Surge release spike selector has an invalid score parameter");
  }
  if (typeof allowCompleteReturnedPrefix !== "boolean") {
    throw new Error("Surge release spike allowCompleteReturnedPrefix must be boolean");
  }
  const base = buildCompleteCc2FinalPlacementCandidates(guiState, moves, {
    candidateLimit,
    allowCompleteReturnedPrefix,
    engineId,
    comparisonSource,
    verificationMemo,
    selectorLabel: "Surge release spike",
  });
  const model = createTuningModel(weightProfileId, weights);
  const candidates = base.candidates.map(({ cc2Rank, identity, move, verification, placement }) => {
    const record = materializeS2NodeRecord(base.state, { kind: "placement", placement }, {
      witnessIdentity: canonicalize(verification.comparison.witness),
      controllerIdentity: "cc2-final-placement-s2-spin-witness/1",
      budgetIdentity: `cc2-returned-prefix-${base.candidates.length}-ceiling-${candidateLimit}-rank-penalty-${rankPenalty}`,
    });
    const surgeRelease = evaluateS2SurgeReleaseSpike(base.state, record);
    const s2Score = scoreEvaluationFeatures(verification.comparison.features, model);
    return { cc2Rank, identity, move, verification, surgeRelease, s2Score };
  });
  annotateDominatedSurgeRelease(candidates);
  for (const candidate of candidates) {
    candidate.selectionScore = candidate.s2Score + adjustmentScale * candidate.surgeRelease.units - candidate.cc2Rank * rankPenalty;
  }
  candidates.sort((left, right) => right.selectionScore - left.selectionScore ||
    left.cc2Rank - right.cc2Rank || left.identity.localeCompare(right.identity, "en"));
  const best = candidates[0];
  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison,
      engineId,
      source: comparisonSource,
      moveSelectionPolicy: allowCompleteReturnedPrefix
        ? S2_SURGE_RELEASE_SPIKE_RETURNED_PREFIX_POLICY
        : S2_SURGE_RELEASE_SPIKE_SELECTOR_POLICY,
      candidateLimit,
      generatedCandidates: candidates.length,
      returnedCandidateCount: base.returnedCandidateCount,
      completeReturnedPrefix: allowCompleteReturnedPrefix,
      rejectedCandidates: 0,
      selectedCc2Rank: best.cc2Rank,
      rankPenalty,
      score: best.s2Score,
      selectionScore: best.selectionScore,
      surgeReleaseSpike: best.surgeRelease,
      adjustmentScale,
    },
    candidates: candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      identity: candidate.identity,
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      surgeRelease: candidate.surgeRelease,
    })),
    rejectedCandidates: [],
  };
}
