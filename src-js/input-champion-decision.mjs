import { F14_COMPAT_QUEUE_LIMIT, createF14DecideRequest, createF14LeafConversionGatedProfile,
  ROOT_LEAF_CONVERSION_GATED_PROFILE } from "./s2-f14-compat-browser.mjs";
import { assertGatedChampionResponse, championVisibleState, extendChampionQueue } from "./champion-parameters.mjs";
import { createS2AmountOnlyDecisionState, decisionStateToSyntheticGui } from "./s2-amount-only-decision-state.mjs";
import { guiStateToCanonical } from "./gui-state.mjs";
import { applyTransition } from "./transition.mjs";

/**
 * The INPUT route only sees the amount-only decision state, never the referee's
 * canonical state. This rebuilds exactly the request createPublicCompatRequest
 * makes from the canonical state behind that decision, so INPUT asks the same
 * gated F14 core the champion's final-placement route asks.
 */
export function createChampionInputRequest(decision, { requestId, generation = 1,
  profile = createF14LeafConversionGatedProfile({ scale: "0.25", maxHeight: "8" }), queueDepth = F14_COMPAT_QUEUE_LIMIT } = {}) {
  if (profile?.profileId !== ROOT_LEAF_CONVERSION_GATED_PROFILE) {
    throw new Error("champion INPUT requires the gated leaf-conversion profile");
  }
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
 * The champion's adoption order for the INPUT planner: its selected
 * (possibly rescue-vetoed) move, then the other candidates in CC2 rank order,
 * which is the gated core's final order. Only reachability can move the
 * planner past the first entry.
 */
export function championInputMoves(response, { current = null, holdAvailable = true } = {}) {
  if (response?.status !== "move") throw new Error(`champion INPUT decision ${response?.status}: ${response?.reason}`);
  assertGatedChampionResponse({ execution: { profileId: ROOT_LEAF_CONVERSION_GATED_PROFILE } }, response);
  const { returnedIdentities, selectedCc2Rank } = response.ranking;
  const moves = [selectedCc2Rank, ...[...returnedIdentities.keys()].filter((rank) => rank !== selectedCc2Rank)]
    .map((rank) => JSON.parse(returnedIdentities[rank]));
  if (holdAvailable) return moves;
  // Only an INPUT replan after this piece's HOLD input sees HOLD spent, which
  // the core cannot be asked about; keep its order among the moves that
  // place the current piece.
  const placeable = moves.filter((move) => move.location.type === current);
  if (placeable.length === 0) throw new Error("champion INPUT decision has no move without HOLD");
  return placeable;
}

/**
 * The next piece's request if the core's selected placement locks as decided,
 * for a speculative search while this piece is being moved. The core's search
 * reads only `start`, and its rerank rebuilds the ranking from the real next
 * request, so only `start` has to come true. Returns null when `start`
 * cannot be known from this position: garbage lands at this lock, or the
 * next queue needs a piece that is not visible yet.
 */
export function predictChampionNextRequest(decision, request, response, { profile, queueDepth }) {
  if (response?.status !== "move" || response.selectedPlacement == null) return null;
  if (decision.incoming.dueThisLockRows > 0) return null;
  const state = { ...guiStateToCanonical(decisionStateToSyntheticGui(decision)), rulesetId: decision.rulesetId };
  const transition = applyTransition(state, { kind: "placement", placement: response.selectedPlacement }, decision.rulesetId);
  if (transition.legality?.legal !== true || transition.nextState?.pieces?.current == null) return null;
  const next = createS2AmountOnlyDecisionState(transition.nextState);
  const predicted = createChampionInputRequest(championVisibleState(next, queueDepth),
    { requestId: `${request.requestId}-next`, profile, queueDepth });
  return predicted.start.queue.length === request.start.queue.length ? predicted : null;
}
