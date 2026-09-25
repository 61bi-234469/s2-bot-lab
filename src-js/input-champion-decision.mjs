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
  profile = createF14LeafConversionGatedProfile({ scale: "0.25", maxHeight: "8" }), queueDepth = F14_COMPAT_QUEUE_LIMIT,
  bagState = "empty" } = {}) {
  if (bagState !== "empty" && bagState !== "public") throw new Error("champion INPUT bagState must be empty or public");
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
  const extended = extendChampionQueue(request, queueDepth);
  if (bagState === "empty" || queueDepth < F14_COMPAT_QUEUE_LIMIT) return extended;
  // Below QUEUE 14 the visible NEXT is already cut, so its end is not a bag boundary.
  const remaining = publicSevenBagStateAfterQueue(queue, extended.start.queue.length);
  if (remaining === null) return extended;
  return { ...extended, start: { ...extended.start, randomizer: { type: "seven_bag", bag_state: remaining } } };
}

/**
 * Pieces still left in the 7-bag of the last searched piece, from public
 * pieces only (no seed or hidden queue): `sequence` is the current piece followed by the whole
 * public NEXT, whose end is a bag boundary because the queue is refilled one
 * bag at a time. The searched queue is its first `queueLength` pieces. Returns
 * null when the sequence does not split into distinct-piece bags from its end,
 * so a caller keeps the plain new-bag assumption.
 */
/** Pieces (current included) below which the /2 INPUT queue appends a 7-bag. */
export const INPUT_QUEUE_REFILL_BELOW = 14;

export function publicSevenBagStateAfterQueue(sequence, queueLength) {
  if (!Array.isArray(sequence) || !Number.isInteger(queueLength) || queueLength < 1 || queueLength > sequence.length) {
    return null;
  }
  const validPieces = new Set(["I", "O", "T", "S", "Z", "J", "L"]);
  if (sequence.some((piece) => !validPieces.has(piece))) return null;
  for (let end = sequence.length; end > 0; end -= 7) {
    const block = sequence.slice(Math.max(0, end - 7), end);
    if (new Set(block).size !== block.length) return null;
  }
  const boundary = sequence.length - 7 * Math.floor((sequence.length - queueLength) / 7);
  return sequence.slice(queueLength, boundary);
}

/**
 * The champion's adoption order for the INPUT planner: its selected
 * (possibly rescue-vetoed) move, then the other candidates in CC2 rank order,
 * which is the gated core's final order. Only reachability can move the
 * planner past the first entry.
 */
export function championInputMoves(response, { current = null, holdAvailable = true, allowQueuePrefix = false } = {}) {
  if (response?.status !== "move") throw new Error(`champion INPUT decision ${response?.status}: ${response?.reason}`);
  const request = { execution: { profileId: ROOT_LEAF_CONVERSION_GATED_PROFILE } };
  if (allowQueuePrefix) {
    const searchedQueueLength = response.search?.searchedQueueLength;
    if (!Number.isSafeInteger(searchedQueueLength) || searchedQueueLength < 1) {
      throw new Error("champion INPUT prefix rerank has invalid searched queue length");
    }
    request.start = { queue: { length: searchedQueueLength + 1 } };
  }
  assertGatedChampionResponse(request, response, { allowQueuePrefix });
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
export function predictChampionNextRequest(decision, request, response, { profile, queueDepth,
  queueRefillsByBag = false, queuePrefixSpeculation = false } = {}) {
  if (response?.status !== "move" || response.selectedPlacement == null) return null;
  if (decision.incoming.dueThisLockRows > 0) return null;
  const state = { ...guiStateToCanonical(decisionStateToSyntheticGui(decision)), rulesetId: decision.rulesetId };
  const transition = applyTransition(state, { kind: "placement", placement: response.selectedPlacement }, decision.rulesetId);
  if (transition.legality?.legal !== true || transition.nextState?.pieces?.current == null) return null;
  const next = createS2AmountOnlyDecisionState(transition.nextState);
  const predicted = createChampionInputRequest(championVisibleState(next, queueDepth),
    { requestId: `${request.requestId}-next`, profile, queueDepth });
  if (predicted.start.queue.length === request.start.queue.length) return { request: predicted, queuePrefix: 0 };
  // The /2 INPUT queue refills one 7-bag only when fewer than
  // INPUT_QUEUE_REFILL_BELOW pieces (current included) would remain. Without
  // a refill the next public queue is exactly this one, so the predicted
  // `start` is the real one; the core's rerank still checks it byte for byte.
  if (queueRefillsByBag !== true) return null;
  const publicQueue = [next.pieces.current, ...next.pieces.known].filter((piece) => piece != null);
  if (predicted.start.queue.some((piece, index) => piece !== publicQueue[index])) return null;
  if (publicQueue.length >= INPUT_QUEUE_REFILL_BELOW) return { request: predicted, queuePrefix: 0 };
  // A refill appends a whole bag: the next search queue at QUEUE 14 is this
  // public queue plus one unknown piece of a new bag (opt-in).
  if (queuePrefixSpeculation !== true || queueDepth !== predicted.start.queue.length + 1 ||
      predicted.start.queue.length !== publicQueue.length ||
      publicSevenBagStateAfterQueue(publicQueue, publicQueue.length)?.length !== 0) return null;
  const prefixRequest = { ...predicted,
    start: { ...predicted.start, randomizer: { type: "seven_bag", bag_state: [] } } };
  return { request: prefixRequest, queuePrefix: 1 };
}
