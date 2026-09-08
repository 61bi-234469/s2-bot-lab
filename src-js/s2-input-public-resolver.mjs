import { inputDecisionFingerprint } from './input-decision-request.mjs';
import { inputBotProfile } from './input-bot-contract.mjs';
import { rankS2AmountOnlyPublicCandidates, projectS2AmountOnlyPublicLock } from './s2-amount-only-public-candidates.mjs';
import { QUALIFIED_STATIC_CC2_RESOLVER_POLICY } from './s2-amount-only-public-resolver.mjs';
import { planInputTarget, INPUT_TARGET_CONTROLLER } from './triangle/input-target-planner.mjs';
import { validateInputPublicMovement } from './triangle/input-public-movement.mjs';
import { canonicalize } from '../scripts/cs1.mjs';
import { sha256Hex } from './sha256.mjs';

/** Opt-in product resolver: retain the qualified selector's first choice,
 * then try its other ranked candidates within one shared input-search budget.
 */
export function resolveQualifiedInputSubmission(request, movement, {
  maxNodes = 128, maxFrames = 60, maxTimeMs = 250, compactInputs = false,
} = {}) {
  const decisionFingerprint = inputDecisionFingerprint(request);
  validateInputPublicMovement(movement);
  const movementFingerprint = `sha256:${sha256Hex(canonicalize(movement))}`;
  if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 1024 ||
      !Number.isSafeInteger(maxFrames) || maxFrames < 1 || maxFrames > 120 ||
      !Number.isFinite(maxTimeMs) || maxTimeMs <= 0 || maxTimeMs > 1000) throw new Error('invalid input resolver budget');
  const options = { ...QUALIFIED_STATIC_CC2_RESOLVER_POLICY, allowCompleteReturnedPrefix: true };
  const ranked = rankS2AmountOnlyPublicCandidates(request.decision, request.moves, options);
  // Match selectS2AmountOnlyPublicCandidate's rescue rule using this ranking.
  // Keep the frozen selector source unchanged; parity is covered by fixtures.
  const profile = inputBotProfile(request.type);
  const nativeOrder = profile.selector === 'cc2-order/1';
  const ordered = nativeOrder ? [...ranked.candidates].sort((a, b) => a.cc2Rank - b.cc2Rank) : ranked.candidates;
  const control = ordered[0];
  const solvent = ranked.candidates.find(candidate => candidate.solvency.solvent);
  const first = !nativeOrder && control.solvency.solvency < 0 && solvent !== undefined ? solvent : control;
  if (!first) throw new Error('input resolver selected candidate is absent from ranked candidates');
  const remaining = ordered.filter(candidate => candidate !== first);
  // An unreachable rescue must not put the unsafe score leader back ahead of
  // the other solvent choices. Keep the qualified first choice and preserve
  // score order within each remaining group.
  const candidates = nativeOrder ? ordered : [first, ...remaining.filter(candidate => candidate.solvency.solvent),
    ...remaining.filter(candidate => !candidate.solvency.solvent)];
  // maxTimeMs bounds path search after ranking, not the whole synchronous
  // resolver call. Individual Engine ticks cannot be preempted.
  const startedAt = performance.now();
  let nodes = 0;
  const attempts = [];
  for (const [adoptionRank, candidate] of candidates.entries()) {
    const remainingTime = maxTimeMs - (performance.now() - startedAt);
    if (nodes >= maxNodes || remainingTime <= 0) break;
    // Keep a real search for the preferred target, but leave each fallback
    // room for a direct route (initial pose, rotation, drop). A fixed 12-node
    // minimum used to exhaust the pool before later candidates were visited.
    // Small caller budgets still fail closed; a sole target gets all nodes.
    const remainingNodes = maxNodes - nodes;
    const candidateNodes = Math.min(remainingNodes, candidates.length === 1 ? remainingNodes :
      adoptionRank === 0 ? Math.max(1, Math.min(Math.floor(maxNodes * 3 / 4), maxNodes - 3 * (candidates.length - 1))) :
        Math.max(1, Math.floor(remainingNodes / (candidates.length - adoptionRank))));
    const candidateTime = Math.min(remainingTime, candidates.length > 1 && adoptionRank === 0 ? maxTimeMs * 3 / 4 : remainingTime);
    const plan = planInputTarget(request, movement, candidate, { maxNodes: candidateNodes, maxFrames, maxTimeMs: candidateTime,
      compactInputs, allowEquivalentSpinWitness: true });
    nodes += plan.nodes;
    attempts.push({ cc2Rank: candidate.cc2Rank, adoptionRank, status: plan.status,
      reason: plan.reason ?? null, nodes: plan.nodes });
    const fallback = fallbackDiagnostic(first, attempts);
    if (plan.status === 'planned') {
      const placement = { ...structuredClone(candidate.placement), rotationEvidence: structuredClone(plan.lock.evidence) };
      const actualProjection = projectS2AmountOnlyPublicLock(ranked.state, placement, request.decision.incoming);
      if (canonicalize(actualProjection) !== canonicalize(candidate.projection)) {
        throw new Error('input rotation witness changed the selected public lock projection');
      }
      return {
        status: 'planned', decisionFingerprint, movementFingerprint, controller: INPUT_TARGET_CONTROLLER,
        placement, plan,
        selection: { originalCc2Rank: first.cc2Rank, selectedCc2Rank: candidate.cc2Rank,
          adoptionRank, reason: adoptionRank === 0 ? 'preferred-reachable' : 'preferred-path-not-found', fallback }, attempts,
        fallback,
      };
    }
  }
  return { status: 'not-found', decisionFingerprint, movementFingerprint, controller: INPUT_TARGET_CONTROLLER,
    attempts, nodes, fallback: fallbackDiagnostic(first, attempts) };
}

/** Keep diagnostics at the reviewed public boundary: a candidate's placement
 * exposes only whether the last input was a rotation and the public kick
 * witness needed to explain it. The Engine's kick index is intentionally not
 * carried into resolver or GUI diagnostics. */
function publicRotationWitness(placement) {
  const evidence = placement?.rotationEvidence ?? {};
  const kickId = typeof evidence.kickId === 'string' ? evidence.kickId : null;
  const kickOffset = Array.isArray(evidence.kickOffset) && evidence.kickOffset.length === 2 &&
    evidence.kickOffset.every(Number.isSafeInteger) ? [...evidence.kickOffset] : null;
  if (evidence.lastInputWasRotation !== true) {
    return { class: 'no-rotation', kickId: null, kickOffset: null };
  }
  if (kickId === '00' && kickOffset?.[0] === 0 && kickOffset?.[1] === 0) {
    return { class: 'no-kick', kickId, kickOffset };
  }
  return { class: 'kicked', kickId, kickOffset };
}

/** The first attempt is the qualified selector's preferred target. Preserve a
 * single compact explanation when later attempts are adopted or all attempts
 * fail; candidate placements themselves remain out of the fallback summary. */
function fallbackDiagnostic(preferred, attempts) {
  const attempt = attempts.find(entry => entry.adoptionRank === 0 && entry.cc2Rank === preferred.cc2Rank);
  if (!attempt || attempt.status === 'planned') return null;
  return {
    preferredCandidate: {
      cc2Rank: preferred.cc2Rank,
      piece: preferred.placement.piece,
      rotation: preferred.placement.rotation,
      spin: preferred.projection.spin,
      lines: preferred.projection.lines,
      rotationWitness: publicRotationWitness(preferred.placement),
    },
    reason: attempt.reason,
  };
}
