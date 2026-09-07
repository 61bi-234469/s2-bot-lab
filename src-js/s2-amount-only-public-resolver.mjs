import {
  amountOnlyDecisionFingerprint,
  isAdr062QualifiedStaticType,
} from "./s2-amount-only-decision-request.mjs";
import { selectS2AmountOnlyPublicCandidate } from "./s2-amount-only-public-candidates.mjs";
import { rankS2AmountOnlyPublicCandidates } from "./s2-amount-only-public-candidates.mjs";
import { canonicalize } from "../scripts/cs1.mjs";
import { sha256Hex } from "./sha256.mjs";

export const QUALIFIED_STATIC_CC2_RESOLVER_POLICY = Object.freeze({
  id: "s2-amount-only-public-resolver-policy/1",
  candidateLimit: 16,
  rankPenalty: 25,
  adjustmentScale: 28,
  weightProfileId: "sparse-s2",
  weights: Object.freeze({
  aggregateHeight: -.1, maxHeight: -.4, holes: -1, bumpiness: -.05,
  remainingIncoming: 0, deferredIncoming: -.8, dueIncoming: 0, incomingNextLock: 0,
  confirmedIncoming: 0, tankedIncoming: -.25, visibleTopOutMargin: 0,
  outgoingBeforeCancel: 0, outgoingAfterCancel: 1, cancelled: .8,
  combo: 0, b2b: .6, chargingLevel: 0, surgeSent: .25,
  }),
});

export const QUALIFIED_STATIC_CC2_CANDIDATE_AUDIT_ID =
  "s2-amount-only-public-candidate-audit/1";

/** The live ADR-062 resolver's standalone, public-data-only entry point. */
export function resolveQualifiedStaticCc2Submission(request) {
  if (!isAdr062QualifiedStaticType(request?.type)) throw new Error("ADR-062-qualified resolver required");
  const decisionFingerprint = amountOnlyDecisionFingerprint(request);
  const result = selectS2AmountOnlyPublicCandidate(request.decision, request.moves, {
    ...QUALIFIED_STATIC_CC2_RESOLVER_POLICY,
    allowCompleteReturnedPrefix: true,
  });
  if (result.placement === null || typeof result.placement !== "object") {
    throw new Error(`${request.type} CC2 resolver omitted its selected placement`);
  }
  return Object.freeze({
    decisionFingerprint,
    placement: structuredClone(result.placement),
    score: result.score,
  });
}

/** Public diagnostic-only candidate projection; never used as a live resolver response. */
export function auditQualifiedStaticCc2Candidates(request) {
  if (!isAdr062QualifiedStaticType(request?.type)) throw new Error("ADR-062-qualified resolver required");
  const decisionFingerprint = amountOnlyDecisionFingerprint(request);
  const ranked = rankS2AmountOnlyPublicCandidates(request.decision, request.moves,
    { ...QUALIFIED_STATIC_CC2_RESOLVER_POLICY, allowCompleteReturnedPrefix: true });
  const candidates = ranked.candidates.map((candidate) => Object.freeze({
    cc2Rank: candidate.cc2Rank,
    canonicalPlacement: structuredClone(candidate.placement),
    publicLockProjection: structuredClone(candidate.projection),
    rankingTuple: Object.freeze({ selectionScore: candidate.selectionScore, cc2Rank: candidate.cc2Rank,
      identity: candidate.identity }),
  }));
  const selection = selectS2AmountOnlyPublicCandidate(request.decision, request.moves, {
    ...QUALIFIED_STATIC_CC2_RESOLVER_POLICY,
    allowCompleteReturnedPrefix: true,
  });
  const selected = candidates.find((candidate) => candidate.cc2Rank === selection.selectedCc2Rank);
  if (selected === undefined || JSON.stringify(selected.canonicalPlacement) !== JSON.stringify(selection.placement)) {
    throw new Error("public candidate audit omits resolver selection");
  }
  return Object.freeze({
    id: QUALIFIED_STATIC_CC2_CANDIDATE_AUDIT_ID,
    decisionFingerprint,
    policyId: QUALIFIED_STATIC_CC2_RESOLVER_POLICY.id,
    candidatePrefixSha256: `sha256:${sha256Hex(canonicalize(request.moves.slice(0,
      QUALIFIED_STATIC_CC2_RESOLVER_POLICY.candidateLimit)))}`,
    selected: Object.freeze({
      cc2Rank: selected.cc2Rank,
      canonicalPlacement: structuredClone(selected.canonicalPlacement),
    }),
    candidates: Object.freeze(candidates),
  });
}
