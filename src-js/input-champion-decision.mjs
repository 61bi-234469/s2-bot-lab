import { F14_COMPAT_QUEUE_LIMIT, createF14DecideRequest } from "./s2-f14-compat-browser.mjs";
import { createPublicCompatProfile } from "./public-compat-request.mjs";
import { extendChampionQueue } from "./champion-parameters.mjs";

/**
 * The INPUT route only sees the amount-only decision state, never the referee's
 * canonical state. This rebuilds exactly the request createPublicCompatRequest
 * makes from the canonical state behind that decision, so INPUT asks the same
 * F14 profile-B core the champion's final-placement route asks.
 */
export function createChampionInputRequest(decision, { requestId, generation = 1, profile = createPublicCompatProfile(), queueDepth = F14_COMPAT_QUEUE_LIMIT } = {}) {
  const { board, pieces, chain, lockTime, incoming, rulesetId } = decision;
  // The core's A-profile contract always has HOLD available; see championInputMoves.
  const queue = [pieces.current, ...pieces.known].filter((piece) => piece != null);
  const request = createF14DecideRequest({
    start: { boardCells: board.cells, queue: queue.slice(0, F14_COMPAT_QUEUE_LIMIT), hold: pieces.hold ?? null,
      combo: chain.combo, back_to_back: chain.b2b > 0, b2b: chain.b2b,
      randomizer: { type: "seven_bag", bag_state: [] } },
    selector: {
      rulesetId,
      board: { fidelity: "exact", width: board.width, height: board.height, visibleHeight: board.visibleHeight,
        bufferHeight: board.height - board.visibleHeight, cells: board.cells },
      pieces: { current: pieces.current, hold: pieces.hold ?? null, holdAvailable: true, known: [...pieces.known] },
      chain: { combo: chain.combo, b2b: chain.b2b },
      time: { ...structuredClone(lockTime), fidelity: "exact" },
      incoming: { pendingRows: 0, dueThisLockRows: 0 },
    },
  }, profile, { requestId, generation });
  // Set after construction, exactly as createPublicCompatRequest does.
  request.selector.incoming = { pendingRows: incoming.pendingRows, dueThisLockRows: incoming.dueThisLockRows };
  return extendChampionQueue(request, queueDepth);
}

/**
 * The champion's own adoption order for the INPUT planner: its selected move,
 * then its other ranked candidates, solvent before insolvent and by selection
 * score within each group. Only reachability can move the planner past the
 * first entry.
 */
export function championInputMoves(response, { current = null, holdAvailable = true } = {}) {
  if (response?.status !== "move") throw new Error(`champion INPUT decision ${response?.status}: ${response?.reason}`);
  // `identities` is the core's ranked order; `returnedIdentities` is CC2 order,
  // the one a `cc2Rank` indexes.
  const { returnedIdentities, candidates, selectedCc2Rank } = response.ranking;
  if (returnedIdentities?.[selectedCc2Rank] !== response.selectedIdentity) throw new Error("champion INPUT selected identity mismatch");
  const rest = candidates.filter((candidate) => candidate.cc2Rank !== selectedCc2Rank)
    .sort((a, b) => Number(b.solvent) - Number(a.solvent) || b.selectionScore - a.selectionScore || a.cc2Rank - b.cc2Rank);
  const moves = [selectedCc2Rank, ...rest.map((candidate) => candidate.cc2Rank)].map((rank) => JSON.parse(returnedIdentities[rank]));
  if (holdAvailable) return moves;
  // Only an INPUT replan after this piece's HOLD input sees HOLD spent, which
  // the core cannot be asked about; keep its order among the moves that
  // place the current piece.
  const placeable = moves.filter((move) => move.location.type === current);
  if (placeable.length === 0) throw new Error("champion INPUT decision has no move without HOLD");
  return placeable;
}
