export const CC2_S2_COUNTERFACTUAL_RANK_PENALTIES = Object.freeze([0, 8, 12, 25]);

// Mirrors the rank-penalty portion of compareTuningCandidates. `identity` is
// not needed here because CC2 ranks are unique within the traced prefix.
export function selectCounterfactualCc2Rank(candidates, rankPenalty) {
  const eligible = candidates.filter((candidate) =>
    Number.isInteger(candidate?.cc2Rank) &&
    Number.isFinite(candidate?.s2Score) &&
    typeof candidate?.toppedOut === "boolean"
  );
  if (eligible.length === 0) return null;
  eligible.sort((left, right) =>
    Number(left.toppedOut) - Number(right.toppedOut) ||
    (right.s2Score - right.cc2Rank * rankPenalty) - (left.s2Score - left.cc2Rank * rankPenalty) ||
    left.cc2Rank - right.cc2Rank
  );
  return eligible[0].cc2Rank;
}
