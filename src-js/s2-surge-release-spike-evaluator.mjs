import { applyTransition } from "./transition.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";

export const S2_SURGE_RELEASE_SPIKE_EVALUATOR_ID = "s2-surge-release-spike-evaluator/1";
export const S2_SURGE_RELEASE_SPIKE_POLICY =
  "exact-surge-release-realised-combat-minus-no-pending-b2b-counterfactual/1";

/**
 * F3R evaluates the canonical realised-combat *increase* a placement gets
 * from releasing a charged Surge (breaking a pending B2B chain), not the
 * placement's total realised combat (the baseline evaluator already scores
 * `outgoingAfterCancel` and `cancelled` directly). It runs the identical
 * placement twice through the S2 Simulator: once from the true source chain
 * state, once from a counterfactual source state whose pending B2B is
 * withheld (`chain.b2b` forced to `0`, so there is nothing to break and
 * therefore nothing to Surge). Everything else `calculateSurge` and
 * `calculateAttackStages` read -- clear geometry, combo, garbage queue,
 * rounding seed, multiplier -- is unchanged between the two runs. Both runs
 * share the same post-break `b2bAfter` (a break always zeroes it, whether
 * the pre-break count was the real value or the withheld `0`), so the
 * garbage-calc table's own B2B input is identical in both runs too: the only
 * thing that differs is `brokenB2bCount`, hence Surge, hence the difference
 * this evaluator measures. See
 * the internal design record 2026-08-20-cc2-s2-f3r-surge-release-spike-protocol.md for the
 * full causal-design argument, including why this same technique does not
 * extend to Surge *retention* (F3R measures release only; retention is out
 * of this family's scope, not merely unmeasured within it).
 */
export function evaluateS2SurgeReleaseSpike(state, record) {
  if (state?.chain?.fidelity !== "exact" || !Number.isSafeInteger(state.chain.b2b) || state.chain.b2b < 0) {
    throw new Error("Surge release spike evaluator requires an exact source chain state");
  }
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  const actualTransition = applyTransition(structuredClone(state), structuredClone(record.action), state.rulesetId);
  if (actualTransition.legality?.legal !== true || actualTransition.nextState === null) {
    throw new Error("Surge release spike evaluator replay produced no legal transition");
  }
  const counterfactualTransition = applyTransition(
    b2bWithheldState(state),
    structuredClone(record.action),
    state.rulesetId,
  );
  if (counterfactualTransition.legality?.legal !== true || counterfactualTransition.nextState === null) {
    throw new Error("Surge release spike evaluator produced no legal no-pending-B2B counterfactual transition");
  }
  return Object.freeze({
    stateKey: replayed.stateKey,
    nextStateKey: replayed.nextStateKey,
    ...extractS2SurgeReleaseSpike(state.chain.b2b, actualTransition, counterfactualTransition),
    evaluator: Object.freeze({
      id: S2_SURGE_RELEASE_SPIKE_EVALUATOR_ID,
      policy: S2_SURGE_RELEASE_SPIKE_POLICY,
      direction: "higher-is-better",
      source: "replay-verified canonical S2 Surge/cancellation, actual vs. no-pending-B2B counterfactual chain.b2b",
    }),
  });
}

// The only field a no-pending-B2B counterfactual changes is the source
// chain.b2b. Board, pieces, combo, garbage queue, and time stay exactly as
// observed so the Simulator is the only thing computing the Surge
// difference.
export function b2bWithheldState(state) {
  if (state?.chain?.fidelity !== "exact" || !Number.isSafeInteger(state.chain.b2b) || state.chain.b2b < 0) {
    throw new Error("B2B-withheld counterfactual state requires an exact source chain state");
  }
  const counterfactual = structuredClone(state);
  counterfactual.chain.b2b = 0;
  return counterfactual;
}

/** Pure projection of two canonical results; it never calculates a Surge amount by hand. */
export function extractS2SurgeReleaseSpike(b2bBefore, actualTransition, counterfactualTransition) {
  if (!Number.isSafeInteger(b2bBefore) || b2bBefore < 0 ||
    actualTransition?.legality?.legal !== true || counterfactualTransition?.legality?.legal !== true) {
    throw new Error("Surge release spike extraction requires two legal canonical transitions and a b2b count");
  }
  const surgeSent = sumSurgeChunks(actualTransition.attackStages?.surgeChunks);
  const b2bAfter = actualTransition.chain?.b2bAfter;
  if (surgeSent === null || !Number.isSafeInteger(b2bAfter) || b2bAfter < 0) {
    throw new Error("Surge release spike extraction received malformed canonical attack stages");
  }
  const actualRealisedCombat = realisedCombat(actualTransition, "actual");
  const counterfactualRealisedCombat = realisedCombat(counterfactualTransition, "no-pending-B2B counterfactual");
  const actualCancelled = actualTransition.cancelResult.cancelled;
  const actualOutgoingAfterCancel = actualTransition.cancelResult.outgoingAfterCancel;
  const counterfactualCancelled = counterfactualTransition.cancelResult.cancelled;
  const counterfactualOutgoingAfterCancel = counterfactualTransition.cancelResult.outgoingAfterCancel;

  const releaseValue = actualRealisedCombat - counterfactualRealisedCombat;
  // Only informative when the mechanism actually fired (surgeSent > 0): a
  // "continuing B2B" (difficult clear, no break) candidate can show a
  // non-zero releaseValue here too, because forcing chain.b2b to 0 also
  // changes that candidate's *continuing* B2B bonus, not just a withheld
  // Surge. `qualifies` below gates on surgeSent, not on releaseValue alone,
  // so that contamination never reaches `units` (proved by a dedicated test).
  const qualifies = surgeSent > 0 && releaseValue > 0;
  const units = qualifies ? releaseValue / 4 : 0;
  return Object.freeze({
    b2bBefore,
    b2bAfter,
    surgeSent,
    actualRealisedCombat,
    counterfactualRealisedCombat,
    releaseValue,
    cancelled: actualCancelled,
    outgoingAfterCancel: actualOutgoingAfterCancel,
    // Decomposition only: how much of releaseValue materialized as cancelling
    // incoming garbage vs. as surviving outgoing attack. These always sum to
    // releaseValue (cancellation only redistributes, never destroys, realised
    // combat -- see the protocol doc's conservation argument) so neither
    // component is scored on its own; they are diagnostic telemetry.
    defensiveComponent: actualCancelled - counterfactualCancelled,
    offensiveComponent: actualOutgoingAfterCancel - counterfactualOutgoingAfterCancel,
    // Informational label only, kept for continuity with F3's original
    // defensive/non-defensive split; it plays no role in `units`.
    defensiveRelease: surgeSent > 0 && actualCancelled > 0,
    qualifies,
    units,
  });
}

function sumSurgeChunks(chunks) {
  if (!Array.isArray(chunks) || !chunks.every((value) => Number.isInteger(value) && value > 0)) return null;
  return chunks.reduce((sum, value) => sum + value, 0);
}

function realisedCombat(transition, label) {
  const outgoingAfterCancel = transition.cancelResult?.outgoingAfterCancel;
  const cancelled = transition.cancelResult?.cancelled;
  if (!Number.isFinite(outgoingAfterCancel) || outgoingAfterCancel < 0 || !Number.isFinite(cancelled) || cancelled < 0) {
    throw new Error(`Surge release spike extraction received malformed ${label} cancellation stage`);
  }
  return outgoingAfterCancel + cancelled;
}
