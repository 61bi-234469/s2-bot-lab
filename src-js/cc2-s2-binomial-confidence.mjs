// Exact one-sided binomial test against p=0.5, computed over decisive
// (non-tied) pairs only: returns 1 - P(X >= successes | X ~ Binomial(trials, 0.5)),
// i.e. the confidence that the true decisive-pair win rate exceeds 50%. Uses
// an iterative PMF recurrence (pmf(i+1) = pmf(i) * (n-i)/(i+1) at p=0.5) so it
// stays numerically stable without computing raw binomial coefficients or
// factorials.
//
// Shared by the live direction screen and the frozen legacy staged screen so
// the two rules cannot drift apart on the statistic itself, only on the
// decision built from it.
//
// 2 ** -trials underflows to 0 at trials >= 1075, after which every success
// count would report confidence 1. Refuse rather than invent a bar. The
// live N/D designs (D <= 200) and the D = 461 p=0.55 size are inside this
// limit; CLI `--decisive=` is not.

export const CC2_S2_BINOMIAL_TRIAL_LIMIT = 1023;

export function oneSidedBinomialConfidence(successes, trials) {
  // Validation precedes the zero-trial shortcut: a malformed `trials` must not
  // reach a return path that never inspected it.
  if (!Number.isSafeInteger(trials) || trials < 0) {
    throw new Error("trials must be a non-negative integer");
  }
  if (trials > CC2_S2_BINOMIAL_TRIAL_LIMIT) {
    throw new Error(
      `oneSidedBinomialConfidence trials ${trials} exceed ${CC2_S2_BINOMIAL_TRIAL_LIMIT}`,
    );
  }
  if (trials === 0) return 0.5;
  let pmf = 2 ** -trials;
  let upperTail = 0;
  for (let i = 0; i <= trials; i += 1) {
    if (i >= successes) upperTail += pmf;
    if (i < trials) pmf = (pmf * (trials - i)) / (i + 1);
  }
  return 1 - upperTail;
}
