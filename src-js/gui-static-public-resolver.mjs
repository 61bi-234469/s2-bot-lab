import { inputDecisionFingerprint } from "./input-decision-request.mjs";
import { rankS2AmountOnlyPublicCandidates } from "./s2-amount-only-public-candidates.mjs";
import {
  QUALIFIED_STATIC_CC2_RESOLVER_POLICY,
  resolveQualifiedStaticCc2Submission,
} from "./s2-amount-only-public-resolver.mjs";

// GUI-only admission: keep frozen F14/champion resolver bytes and identities.
export function resolveGuiStaticSubmission(request) {
  if (request?.type !== "cc2-raw" && request?.type !== "cc2-chouhy") {
    return resolveQualifiedStaticCc2Submission(request);
  }
  const decisionFingerprint = inputDecisionFingerprint(request);
  // Preserve native first choice; this is not an S2 reranking or fallback.
  const { candidates } = rankS2AmountOnlyPublicCandidates(request.decision, request.moves.slice(0, 1), {
    ...QUALIFIED_STATIC_CC2_RESOLVER_POLICY, candidateLimit: 1, allowCompleteReturnedPrefix: true,
  });
  return Object.freeze({
    decisionFingerprint, placement: structuredClone(candidates[0].placement), score: candidates[0].s2Score,
  });
}
