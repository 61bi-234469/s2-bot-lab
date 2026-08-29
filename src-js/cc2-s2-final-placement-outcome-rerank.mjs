import { canonicalize } from "./cs1-core.mjs";
import {
  applyCc2FinalPlacementUnderObservedS2,
  createCc2SpinWitnessIndex,
} from "./cc2-s2-adapter.mjs";

export const CC2_S2_FINAL_OUTCOME_RERANK_ID = "s2-cc2-final-placement-outcome-rerank/1";
export const CC2_S2_FINAL_OUTCOME_RERANK_POLICY =
  "non-terminal-outgoing-cancel-b2b-combo-low-tank-defer-board-risk-identity/1";

export function selectCc2S2FinalPlacementOutcomeRerank(guiState, moves, { candidateLimit = 16 } = {}) {
  if (!Array.isArray(moves) || !Number.isSafeInteger(candidateLimit) ||
      candidateLimit < 1 || candidateLimit > 64 || moves.length < candidateLimit) {
    throw new Error("final outcome rerank requires a complete bounded CC2 prefix");
  }
  const prefix = moves.slice(0, candidateLimit);
  const identities = prefix.map(canonicalize);
  if (new Set(identities).size !== identities.length) throw new Error("final outcome rerank prefix contains duplicate identities");
  const index = createCc2SpinWitnessIndex(guiState);
  const candidates = [];
  for (const [cc2Rank, move] of prefix.entries()) {
    const verification = applyCc2FinalPlacementUnderObservedS2(guiState, move, { spinWitnessIndex: index,
      engineId: CC2_S2_FINAL_OUTCOME_RERANK_ID, comparisonSource: CC2_S2_FINAL_OUTCOME_RERANK_ID });
    if (verification.transition === null) return { status: "unsupported", transition: null, move: null,
      reasons: ["final-outcome-rerank-incomplete-prefix", ...verification.reasons],
      rejectedCandidates: [{ cc2Rank, identity: identities[cc2Rank], reasons: verification.reasons }] };
    candidates.push({ cc2Rank, move, identity: identities[cc2Rank], verification,
      outcome: outcome(verification.transition) });
  }
  candidates.sort(compareFinalOutcomeCandidates);
  const best = candidates[0];
  return { ...best.verification, move: structuredClone(best.move), comparison: { ...best.verification.comparison,
    evaluator: { id: CC2_S2_FINAL_OUTCOME_RERANK_ID, ordering: CC2_S2_FINAL_OUTCOME_RERANK_POLICY },
    moveSelectionPolicy: CC2_S2_FINAL_OUTCOME_RERANK_POLICY, candidateLimit, generatedCandidates: candidates.length,
    rejectedCandidates: 0, selectedCc2Rank: best.cc2Rank },
  candidates: candidates.map(({ cc2Rank, identity, outcome: value }) => ({ cc2Rank, identity, outcome: value })), rejectedCandidates: [] };
}

export function compareFinalOutcomeCandidates(left, right) {
  const a = left.outcome; const b = right.outcome;
  return Number(a.toppedOut) - Number(b.toppedOut) || b.outgoing - a.outgoing || b.cancelled - a.cancelled ||
    b.b2b - a.b2b || b.combo - a.combo || a.tanked - b.tanked || a.deferred - b.deferred ||
    a.maxHeight - b.maxHeight || a.buriedHoles - b.buriedHoles || a.coveredCells - b.coveredCells ||
    b.wellContinuity - a.wellContinuity || left.identity.localeCompare(right.identity, "en");
}

export function boardRisk(board) {
  const { width, height, cells } = board;
  const occupied = (x, y) => cells[y * width + x] !== "_";
  let maxHeight = 0; let buriedHoles = 0; let coveredCells = 0; let wellContinuity = 0;
  for (let x = 0; x < width; x += 1) {
    let highest = -1; for (let y = height - 1; y >= 0; y -= 1) if (occupied(x, y)) { highest = y; break; }
    maxHeight = Math.max(maxHeight, highest + 1); let run = 0;
    for (let y = 0; y < height; y += 1) {
      if (!occupied(x, y) && y < highest) buriedHoles += 1;
      if (occupied(x, y) && y > 0 && !occupied(x, y - 1)) coveredCells += 1;
      run = occupied(x, y) ? 0 : run + 1; wellContinuity = Math.max(wellContinuity, run);
    }
  }
  return { maxHeight, buriedHoles, coveredCells, wellContinuity };
}

function outcome(transition) {
  const risk = boardRisk(transition.nextState.board);
  return { toppedOut: transition.tankResult?.toppedOut === true, outgoing: transition.cancelResult?.outgoingAfterCancel ?? 0,
    cancelled: transition.cancelResult?.cancelled ?? 0, b2b: transition.chain?.b2bAfter ?? 0,
    combo: transition.chain?.comboAfter ?? 0, tanked: (transition.tankResult?.inserted ?? []).reduce((n, p) => n + p.amount, 0),
    deferred: (transition.tankResult?.deferred ?? []).reduce((n, p) => n + p.amount, 0), ...risk };
}
