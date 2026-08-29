import { PAIRED_SEQUENTIAL_TEST_QUALIFICATION } from "./paired-sequential-test.mjs";

export const SEQUENTIAL_PROMOTION_RULE_ID = "sequential-accept-h1-then-effect-then-evidence/1";

/**
 * Whether a sequential run was executed under the settings the boundaries were
 * qualified with. The recorded error rates only describe that configuration: a
 * different pair cap watches the boundaries for a different length of time, and
 * different hypotheses or boundaries are simply a different test. A run outside
 * it is experimental and must not open a sealed holdout.
 */
export function sequentialQualificationStatus(config) {
  const expected = {
    h0: 0.5,
    h1: 0.55,
    alpha: 0.01,
    beta: 0.02,
    minimumPairs: 50,
    maxPairs: PAIRED_SEQUENTIAL_TEST_QUALIFICATION.maxPairs,
  };
  const mismatches = Object.entries(expected)
    .filter(([name, value]) => config?.[name] !== value)
    .map(([name, value]) => `${name}=${config?.[name]} (qualified ${value})`);
  return {
    id: PAIRED_SEQUENTIAL_TEST_QUALIFICATION.id,
    qualified: mismatches.length === 0,
    mismatches,
    promotionAllowed: mismatches.length === 0,
    reason: mismatches.length === 0
      ? "settings match the qualified configuration"
      : "settings differ from the qualified configuration, so the recorded error rates do not apply",
  };
}

/**
 * Promotion rule for a sequential run, fixed here rather than derived from the
 * results. Only a candidate the sequential test actually accepted, on a valid
 * partition, under the qualified configuration, may be read against the
 * holdout; ranking a sequentially stopped sample by a fixed-N interval would
 * not match the rule that stopped it. If nothing qualifies, nothing is
 * promoted and the holdout stays sealed.
 *
 * Among accepted candidates the order is: larger estimated effect first, then
 * stronger evidence, then fewer pairs spent, then the stable variant id.
 */
export function rankSequentialPromotable(results) {
  if (!Array.isArray(results)) throw new Error("development results must be an array");
  return results
    .filter((result) => {
      const sequential = result?.sequential;
      if (sequential === null || sequential === undefined) return false;
      if (sequential.validity?.usable !== true) return false;
      if (sequential.decision !== "accept-h1") return false;
      return sequentialQualificationStatus(sequential.config).promotionAllowed;
    })
    .sort((left, right) =>
      right.sequential.expectedPairScore - left.sequential.expectedPairScore ||
      right.sequential.llr - left.sequential.llr ||
      left.sequential.pairs - right.sequential.pairs ||
      left.variant.id.localeCompare(right.variant.id, "en"));
}
