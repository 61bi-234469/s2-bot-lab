import { canonicalize } from "./cs1-core.mjs";
import { buildCompleteCc2FinalPlacementCandidates } from "./cc2-s2-final-placement-candidates.mjs";
import { createTuningModel } from "./cc2-s2-tuning.mjs";
import { scoreEvaluationFeatures } from "./evaluation.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import {
  S2_REN_QUAD_TSD_SPIKE_EVALUATOR_ID,
  evaluateS2RenQuadTsdSpike,
} from "./s2-ren-quad-tsd-spike-evaluator.mjs";
import {
  S2_SURGE_RELEASE_SPIKE_EVALUATOR_ID,
  evaluateS2SurgeReleaseSpike,
} from "./s2-surge-release-spike-evaluator.mjs";

// F23R combines two already-closed, independently measured families -- F2R
// (REN Quad/TSD realised-combat gain, ported unchanged, see
// the internal design record 2026-08-20-f2r-prerequisite-port-provenance.md) and F3R (Surge
// release realised-combat gain, the internal design record 2026-08-20-cc2-s2-f3r-surge-release-spike-protocol.md)
// -- into one additive selectionScore, unmodified from either family's own
// units, scale, or qualifying rule:
//
//   selectionScore = s2Score + adjustmentScale * (renQuadTsdSpike.units +
//                     surgeReleaseSpike.units) - cc2Rank * rankPenalty
//
// Neither evaluator is redefined and neither coefficient is retuned here.
// F23R exists to test whether a candidate SET can contain both a
// REN-continuation option and a Surge-release option at the same decision
// point (a genuine contextual choice), not to invent a new causal quantity.
// See the internal design record 2026-08-20-cc2-s2-f23r-quad-tsd-surge-release-cooccurrence-protocol.md.
//
// On the *same* candidate the two evaluators are structurally exclusive, not
// just empirically rare: renQuadTsdSpike only qualifies on a "difficult"
// clear (Quad, or a normal-spin Double = TSD; src-js/triangle/chain-adapter.mjs's
// `difficult = clear.spin !== "none" || clear.lines >= 4`), and a difficult
// clear always continues B2B (`b2bAfter += 1`) rather than breaking it, so
// `brokeB2b` stays false and `brokenB2bCount` stays 0 -- `calculateSurge`
// therefore always returns a zero amount, making `surgeSent` on that same
// actual transition always 0 and surgeReleaseSpike.qualifies always false.
// The reverse holds too: surgeReleaseSpike only qualifies when `surgeSent >
// 0`, which requires a non-difficult break clear, which can never be
// `clearKind === "quad" | "tsd"`. So `renQuadTsdSpike.units` and
// `surgeReleaseSpike.units` can never both be non-zero for one candidate;
// summing them never double-counts a single placement's own value. Two
// *different* candidates in the same returned set qualifying for the two
// families respectively is the co-occurrence this family measures.
export const S2_F23R_COMBINED_SPIKE_SELECTOR_POLICY =
  "aligned-s2-score-plus-exact-ren-quad-tsd-spike-gain-plus-exact-surge-release-spike-gain-minus-cc2-rank/1";
export const S2_F23R_COMBINED_SPIKE_RETURNED_PREFIX_POLICY =
  "aligned-s2-score-plus-exact-ren-quad-tsd-spike-gain-plus-exact-surge-release-spike-gain-returned-prefix-minus-cc2-rank/1";
export const S2_F23R_COMBINED_SPIKE_ENGINE_ID = "s2-f23r-combined-spike-selector/1";

/** Select only from the complete CC2 prefix; missing canonical evidence rejects the selection. */
export function selectS2F23RCombinedSpikePlacement(guiState, moves, {
  candidateLimit = 16,
  rankPenalty = 25,
  adjustmentScale = 28,
  weightProfileId = "sparse-s2",
  weights = {},
  allowCompleteReturnedPrefix = false,
  engineId = S2_F23R_COMBINED_SPIKE_ENGINE_ID,
  comparisonSource = S2_F23R_COMBINED_SPIKE_SELECTOR_POLICY,
  verificationMemo = null,
} = {}) {
  if (!Array.isArray(moves) || moves.length === 0 ||
    (!allowCompleteReturnedPrefix && moves.length < candidateLimit)) {
    throw new Error("F23R combined spike selector requires a complete CC2 candidate prefix");
  }
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64) {
    throw new Error("F23R combined spike candidateLimit must be an integer from 1 to 64");
  }
  if (!Number.isFinite(rankPenalty) || rankPenalty < 0 || rankPenalty > 100 ||
    !Number.isFinite(adjustmentScale) || adjustmentScale < 0 || adjustmentScale > 100) {
    throw new Error("F23R combined spike selector has an invalid score parameter");
  }
  if (typeof allowCompleteReturnedPrefix !== "boolean") {
    throw new Error("F23R combined spike allowCompleteReturnedPrefix must be boolean");
  }
  const base = buildCompleteCc2FinalPlacementCandidates(guiState, moves, {
    candidateLimit,
    allowCompleteReturnedPrefix,
    engineId,
    comparisonSource,
    verificationMemo,
    selectorLabel: "F23R combined REN Quad/TSD + Surge release spike",
  });
  const model = createTuningModel(weightProfileId, weights);
  const candidates = base.candidates.map(({ cc2Rank, identity, move, verification, placement }) => {
    const record = materializeS2NodeRecord(base.state, { kind: "placement", placement }, {
      witnessIdentity: canonicalize(verification.comparison.witness),
      controllerIdentity: "cc2-final-placement-s2-spin-witness/1",
      budgetIdentity: `cc2-returned-prefix-${base.candidates.length}-ceiling-${candidateLimit}-rank-penalty-${rankPenalty}`,
    });
    const renQuadTsdSpike = evaluateS2RenQuadTsdSpike(base.state, record);
    const surgeReleaseSpike = evaluateS2SurgeReleaseSpike(base.state, record);
    const s2Score = scoreEvaluationFeatures(verification.comparison.features, model);
    const combinedUnits = renQuadTsdSpike.units + surgeReleaseSpike.units;
    return {
      cc2Rank, identity, move, verification, renQuadTsdSpike, surgeReleaseSpike, s2Score, combinedUnits,
      selectionScore: s2Score + adjustmentScale * combinedUnits - cc2Rank * rankPenalty,
    };
  });
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
        ? S2_F23R_COMBINED_SPIKE_RETURNED_PREFIX_POLICY
        : S2_F23R_COMBINED_SPIKE_SELECTOR_POLICY,
      candidateLimit,
      generatedCandidates: candidates.length,
      returnedCandidateCount: base.returnedCandidateCount,
      completeReturnedPrefix: allowCompleteReturnedPrefix,
      rejectedCandidates: 0,
      selectedCc2Rank: best.cc2Rank,
      rankPenalty,
      score: best.s2Score,
      selectionScore: best.selectionScore,
      renQuadTsdSpike: best.renQuadTsdSpike,
      surgeReleaseSpike: best.surgeReleaseSpike,
      combinedUnits: best.combinedUnits,
      adjustmentScale,
    },
    candidates: candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      identity: candidate.identity,
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      renQuadTsdSpike: candidate.renQuadTsdSpike,
      surgeReleaseSpike: candidate.surgeReleaseSpike,
      combinedUnits: candidate.combinedUnits,
    })),
    rejectedCandidates: [],
  };
}

export {
  S2_REN_QUAD_TSD_SPIKE_EVALUATOR_ID,
  S2_SURGE_RELEASE_SPIKE_EVALUATOR_ID,
};
