import { buildCompleteCc2FinalPlacementCandidates } from "./cc2-s2-final-placement-candidates.mjs";
import { createTuningModel } from "./cc2-s2-tuning.mjs";
import { scoreEvaluationFeatures } from "./evaluation.mjs";
import { materializeS2NodeRecord } from "./s2-node-state-record.mjs";
import { evaluateS2SurgeRetention } from "./s2-surge-retention-evaluator.mjs";

export function applyDominatedSurgeReleasePenalty(candidates) {
  for (const candidate of candidates) {
    const f = candidate.surge;
    const realised = f.outgoingAfterCancel + f.cancelled;
    const dominated = f.surgeSent > 0 && f.cancelled === 0 && candidates.some((other) => other !== candidate &&
      other.surge.surgeSent === 0 && other.surge.b2bAfter > 0 &&
      other.surge.outgoingAfterCancel + other.surge.cancelled >= realised);
    candidate.surge = { ...f, dominatedNonDefensiveRelease: dominated, units: f.units + (dominated ? -1 : 0) };
  }
  return candidates;
}

export function selectS2SurgeRetentionPlacement(guiState, moves, { candidateLimit = 16, rankPenalty = 25, adjustmentScale = 28, weightProfileId = "sparse-s2", weights = {} } = {}) {
  if (!Array.isArray(moves) || moves.length < candidateLimit) throw new Error("Surge selector requires a complete CC2 candidate prefix");
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64 ||
    !Number.isFinite(rankPenalty) || rankPenalty < 0 || rankPenalty > 100 ||
    !Number.isFinite(adjustmentScale) || adjustmentScale < 0 || adjustmentScale > 100) {
    throw new Error("Surge selector has an invalid bounded setting");
  }
  const base = buildCompleteCc2FinalPlacementCandidates(guiState, moves, {
    candidateLimit,
    engineId: "s2-surge-retention-evaluator/1",
    comparisonSource: "exact-surge-retention/1",
    selectorLabel: "Surge",
  });
  const model = createTuningModel(weightProfileId, weights);
  const candidates = base.candidates.map(({ cc2Rank, identity, move, verification, placement }) => {
    const record = materializeS2NodeRecord(base.state, { kind: "placement", placement });
    return { cc2Rank, identity, move, verification, surge: evaluateS2SurgeRetention(base.state, record), s2Score: scoreEvaluationFeatures(verification.comparison.features, model) };
  });
  applyDominatedSurgeReleasePenalty(candidates);
  for (const c of candidates) c.selectionScore = c.s2Score + adjustmentScale * c.surge.units - c.cc2Rank * rankPenalty;
  candidates.sort((a, b) => b.selectionScore - a.selectionScore || a.cc2Rank - b.cc2Rank || a.identity.localeCompare(b.identity, "en"));
  const best = candidates[0];
  return { ...best.verification, move: structuredClone(best.move), comparison: { ...best.verification.comparison, moveSelectionPolicy: "aligned-s2-score-plus-exact-surge-retention-minus-cc2-rank/1", selectedCc2Rank: best.cc2Rank, candidateLimit, rankPenalty, adjustmentScale, surgeRetention: best.surge, generatedCandidates: candidates.length, rejectedCandidates: base.rejectedCandidates.length }, candidates: candidates.map((c) => ({ cc2Rank: c.cc2Rank, identity: c.identity, surge: c.surge, selectionScore: c.selectionScore })), rejectedCandidates: base.rejectedCandidates };
}
