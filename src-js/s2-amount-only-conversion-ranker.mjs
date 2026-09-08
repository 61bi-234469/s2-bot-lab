import { buildCompleteCc2FinalPlacementCandidates } from "./cc2-s2-final-placement-candidates.mjs";
import { createTuningModel } from "./cc2-s2-tuning-model.mjs";
import { scoreEvaluationFeatures } from "./evaluation.mjs";
import { projectS2AmountOnlyLock } from "./s2-amount-only-lock-projection.mjs";
import { extractAmountOnlyDecisionFeatures } from "./s2-amount-only-decision-features.mjs";
import { witnessCanonicalNextTsdOnLockBoard } from "./s2-amount-only-tsd-witness.mjs";
import { assessS2AmountOnlySolvency } from "./s2-amount-only-post-tank-solvency.mjs";
import { classifyS2ConversionQualifiedRenFinisher } from "./s2-conversion-qualified-ren-finisher-evaluator.mjs";

export const S2_AMOUNT_ONLY_CONVERSION_RANKER_ID = "s2-amount-only-conversion-ranker/1";
export const S2_AMOUNT_ONLY_CONVERSION_POLICY =
  "amount-only-conversion-qualified-ren-finisher/1";

export function rankS2AmountOnlyConversionCandidates(guiState, moves, {
  candidateLimit = 16,
  rankPenalty = 25,
  adjustmentScale = 28,
  weightProfileId = "sparse-s2",
  weights = {},
  allowCompleteReturnedPrefix = false,
  engineId = S2_AMOUNT_ONLY_CONVERSION_RANKER_ID,
  comparisonSource = S2_AMOUNT_ONLY_CONVERSION_POLICY,
  verificationMemo = null,
  incoming = { pendingRows: 0, dueThisLockRows: 0 },
} = {}) {
  if (!Array.isArray(moves) || moves.length === 0 || (!allowCompleteReturnedPrefix && moves.length < candidateLimit)) {
    throw new Error("amount-only F12 ranker requires a complete CC2 candidate prefix");
  }
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64 ||
      !Number.isFinite(rankPenalty) || rankPenalty < 0 || rankPenalty > 100 ||
      !Number.isFinite(adjustmentScale) || adjustmentScale < 0 || adjustmentScale > 100) {
    throw new Error("amount-only F12 ranker has an invalid bounded setting");
  }
  const base = buildCompleteCc2FinalPlacementCandidates(guiState, moves, {
    candidateLimit,
    allowCompleteReturnedPrefix,
    engineId,
    comparisonSource,
    verificationMemo,
    selectorLabel: "amount-only conversion-qualified REN finisher",
  });
  const model = createTuningModel(weightProfileId, weights);
  const publicCtx = {
    rulesetId: base.state.rulesetId,
    time: structuredClone(base.state.time),
  };
  const candidates = base.candidates.map(({ cc2Rank, identity, move, verification, placement }) => {
    const action = { kind: "placement", placement };
    const projection = projectS2AmountOnlyLock(base.state, action, incoming);
    const conversion = evaluateS2AmountOnlyConversion(base.state, action, projection, publicCtx, incoming);
    const features = extractAmountOnlyDecisionFeatures(projection);
    const s2Score = scoreEvaluationFeatures(features, model);
    const solvency = assessS2AmountOnlySolvency(projection);
    return {
      cc2Rank,
      identity,
      move,
      verification,
      placement,
      projection,
      conversion,
      features,
      s2Score,
      solvency,
      selectionScore: s2Score + adjustmentScale * conversion.units - cc2Rank * rankPenalty,
    };
  });
  candidates.sort((left, right) => right.selectionScore - left.selectionScore || left.cc2Rank - right.cc2Rank ||
    left.identity.localeCompare(right.identity, "en"));
  return { base, candidates, publicCtx };
}

export function evaluateS2AmountOnlyConversion(state, action, actualProjection, publicCtx, incoming) {
  const noRen = projectS2AmountOnlyLock(renCounterfactualState(state), action, incoming);
  const withheld = projectS2AmountOnlyLock(b2bWithheldState(state), action, incoming);
  const renCombatGain = realisedCombat(actualProjection) - realisedCombat(noRen);
  const releaseValue = realisedCombat(actualProjection) - realisedCombat(withheld);
  const setupClear = (actualProjection.spin === "mini" && actualProjection.lines >= 1)
    || (actualProjection.spin === "normal" && actualProjection.lines === 1);
  const setupWitness = setupClear
    ? witnessCanonicalNextTsdOnLockBoard(actualProjection, publicCtx)
    : Object.freeze({ tAvailable: false, scanned: 0, witnessed: false });
  const classified = classifyS2ConversionQualifiedRenFinisher({
    comboBefore: state.chain.combo,
    comboAfter: actualProjection.comboAfter,
    b2bBefore: state.chain.b2b,
    b2bAfter: actualProjection.b2bAfter,
    lines: actualProjection.lines,
    spin: actualProjection.spin,
    cancelled: actualProjection.cancelledRows,
    renCombatGain,
    setupWitnessed: setupWitness.witnessed === true,
    surgeSent: actualProjection.surgeSent,
    releaseValue,
  });
  return Object.freeze({
    branch: classified.branch,
    units: classified.units,
    qualifies: classified.qualifies,
    comboAfter: actualProjection.comboAfter,
    b2bAfter: actualProjection.b2bAfter,
    lines: actualProjection.lines,
    spin: actualProjection.spin,
    cancelled: actualProjection.cancelledRows,
    surgeSent: actualProjection.surgeSent,
    releaseValue,
    renCombatGain,
  });
}

function realisedCombat(projection) {
  return projection.outgoingAfterCancel + projection.cancelledRows;
}

function renCounterfactualState(state) {
  const counterfactual = structuredClone(state);
  counterfactual.chain.combo = 0;
  return counterfactual;
}

function b2bWithheldState(state) {
  const counterfactual = structuredClone(state);
  counterfactual.chain.b2b = 0;
  return counterfactual;
}
