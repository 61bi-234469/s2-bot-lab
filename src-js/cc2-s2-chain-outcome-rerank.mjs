import { canonicalize } from "./cs1-core.mjs";
import { createHash } from "node:crypto";

import {
  applyCc2ReachableFinalPlacementUnderObservedS2,
  createCc2EngineFrameWitnessIndex,
} from "./cc2-s2-adapter.mjs";
import { createTuningModel } from "./cc2-s2-tuning.mjs";
import { extractEvaluationFeatures, scoreEvaluationFeatures } from "./evaluation.mjs";
import { fullStateKey } from "./state-keys.mjs";
import { guiStateToCanonical } from "./cc2-s2-adapter.mjs";

export const CC2_S2_CHAIN_OUTCOME_RERANK_ID = "s2-cc2-candidate-chain-outcome-rerank/1";
export const CC2_S2_CHAIN_OUTCOME_RERANK_POLICY =
  "non-terminal-outgoing-cancel-b2b-combo-low-tank-defer-board-identity/1";
export const CC2_S2_CHAIN_OUTCOME_RERANK_CACHE_KEY = "s2-cc2-chain-outcome-rerank/1";

/**
 * Reorders exactly the supplied CC2 prefix. Unlike the older hybrid selector,
 * a missing witness or transition invalidates the whole proposal set: an
 * evaluator must never silently reduce the set it claims to rank.
 */
export function selectCc2S2ChainOutcomeRerank(guiState, moves, {
  candidateLimit = 16,
  engineId = CC2_S2_CHAIN_OUTCOME_RERANK_ID,
  comparisonSource = "s2-cc2-candidate-chain-outcome-rerank",
} = {}) {
  if (!Array.isArray(moves) || moves.length < candidateLimit) {
    throw new Error("chain-outcome rerank requires a complete CC2 candidate prefix");
  }
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64) {
    throw new Error("candidateLimit must be an integer from 1 to 64");
  }
  const prefix = moves.slice(0, candidateLimit);
  const identities = prefix.map(canonicalize);
  if (new Set(identities).size !== identities.length) throw new Error("chain-outcome rerank prefix contains duplicate identities");
  const witnessIndex = createCc2EngineFrameWitnessIndex(guiState, prefix, { maxHeldEdges: 0 });
  const rerankIdentity = chainOutcomeRerankCacheKey(guiState, prefix, { candidateLimit });
  const model = createTuningModel("sparse-s2", {});
  const candidates = [];
  for (const [cc2Rank, move] of prefix.entries()) {
    const verification = applyCc2ReachableFinalPlacementUnderObservedS2(guiState, move, {
      engineId,
      comparisonSource,
      engineFrameWitnessIndex: witnessIndex,
    });
    if (verification.transition === null) {
      return unsupported(cc2Rank, identities[cc2Rank], verification.reasons);
    }
    const features = extractEvaluationFeatures(verification.transition);
    candidates.push({ cc2Rank, move, identity: identities[cc2Rank], verification, outcome: {
      toppedOut: features.toppedOut === 1,
      outgoingAfterCancel: features.outgoingAfterCancel,
      cancelled: features.cancelled,
      b2bAfter: features.b2b,
      comboAfter: features.combo,
      tankedIncoming: features.tankedIncoming,
      deferredIncoming: features.deferredIncoming,
      boardScore: scoreEvaluationFeatures(features, model),
    } });
  }
  candidates.sort(compareChainOutcomeCandidates);
  const best = candidates[0];
  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison,
      engineId,
      source: comparisonSource,
      evaluator: { id: CC2_S2_CHAIN_OUTCOME_RERANK_ID, ordering: CC2_S2_CHAIN_OUTCOME_RERANK_POLICY, cacheKey: rerankIdentity },
      moveSelectionPolicy: CC2_S2_CHAIN_OUTCOME_RERANK_POLICY,
      candidateLimit,
      generatedCandidates: candidates.length,
      rejectedCandidates: 0,
      selectedCc2Rank: best.cc2Rank,
    },
    candidates: candidates.map(({ cc2Rank, identity, outcome }) => ({ cc2Rank, identity, outcome: structuredClone(outcome) })),
    rejectedCandidates: [],
  };
}

/** Binds cache/report identity to state, exact input prefix, and policy version. */
export function chainOutcomeRerankCacheKey(guiState, moves, { candidateLimit = moves?.length } = {}) {
  if (!Array.isArray(moves) || !Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || moves.length < candidateLimit) {
    throw new Error("chain-outcome cache key requires a complete bounded prefix");
  }
  const prefix = moves.slice(0, candidateLimit).map(canonicalize);
  if (new Set(prefix).size !== prefix.length) throw new Error("chain-outcome cache key prefix contains duplicate identities");
  const payload = { policy: CC2_S2_CHAIN_OUTCOME_RERANK_POLICY, candidateLimit, prefix,
    stateKey: fullStateKey(guiStateToCanonical(guiState)) };
  return `${CC2_S2_CHAIN_OUTCOME_RERANK_CACHE_KEY}:sha256:${createHash("sha256").update(canonicalize(payload)).digest("hex")}`;
}

export function compareChainOutcomeCandidates(left, right) {
  return Number(left.outcome.toppedOut) - Number(right.outcome.toppedOut) ||
    right.outcome.outgoingAfterCancel - left.outcome.outgoingAfterCancel ||
    right.outcome.cancelled - left.outcome.cancelled ||
    right.outcome.b2bAfter - left.outcome.b2bAfter ||
    right.outcome.comboAfter - left.outcome.comboAfter ||
    left.outcome.tankedIncoming - right.outcome.tankedIncoming ||
    left.outcome.deferredIncoming - right.outcome.deferredIncoming ||
    right.outcome.boardScore - left.outcome.boardScore ||
    left.identity.localeCompare(right.identity, "en");
}

function unsupported(cc2Rank, identity, reasons) {
  return { status: "unsupported", reasons: ["chain-outcome-rerank-incomplete-prefix", ...reasons], transition: null, move: null,
    rejectedCandidates: [{ cc2Rank, identity, reasons: [...reasons] }] };
}
