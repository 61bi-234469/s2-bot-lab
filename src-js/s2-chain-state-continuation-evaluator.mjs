import { applyTransition } from "./transition.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";

export const S2_CHAIN_STATE_CONTINUATION_EVALUATOR_ID = "m7-sneb-cs1-exact-chain-state-continuation/1";
export const S2_CHAIN_STATE_CONTINUATION_POLICY =
  "exact-post-state-chain-next-queue-line-readiness-linear-contribution/1";
export const CS1_CONTRIBUTION_SCALE = 4;

// This is deliberately a post-state feature, not a second-ply search.  It
// considers the footprint of the next known piece against already exposed
// near-complete rows; it neither generates nor applies a next placement.
const HORIZONTAL_FOOTPRINTS = Object.freeze({
  I: Object.freeze([1, 4]), O: Object.freeze([2]), T: Object.freeze([2, 3]),
  J: Object.freeze([2, 3]), L: Object.freeze([2, 3]), S: Object.freeze([2, 3]),
  Z: Object.freeze([2, 3]),
});

export function evaluateS2ChainStateContinuation(state, record, { contributionScale = CS1_CONTRIBUTION_SCALE } = {}) {
  if (!Number.isFinite(contributionScale) || contributionScale < 0 || contributionScale > 16) {
    throw new Error("CS1 contributionScale must be a finite number from 0 to 16");
  }
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  const transition = applyTransition(structuredClone(state), structuredClone(record.action), state.rulesetId);
  if (transition.legality?.legal !== true || transition.nextState === null) {
    throw new Error("CS1 replay produced no legal post-transition state");
  }
  const features = extractCs1Features(transition.nextState, replayed.features);
  return Object.freeze({
    stateKey: replayed.stateKey,
    nextStateKey: replayed.nextStateKey,
    features: Object.freeze(features),
    contribution: features.units * contributionScale,
    evaluator: Object.freeze({
      id: S2_CHAIN_STATE_CONTINUATION_EVALUATOR_ID,
      policy: S2_CHAIN_STATE_CONTINUATION_POLICY,
      contributionScale,
      unit: "CS1 continuation unit",
      direction: "higher-is-better",
      normalization: "integer units capped to [-3, 6] before fixed scale",
    }),
  });
}

export function extractCs1Features(nextState, evaluationFeatures) {
  if (nextState?.chain?.fidelity !== "exact" || nextState?.pieces?.fidelity !== "exact") {
    throw new Error("CS1 requires exact canonical chain and known-queue state");
  }
  const immediateClear = evaluationFeatures.outgoingBeforeCancel > 0;
  const nextPiece = nextState.pieces.current;
  if (typeof nextPiece !== "string" || HORIZONTAL_FOOTPRINTS[nextPiece] === undefined) {
    throw new Error("CS1 requires a known next tetromino");
  }
  const queueLineReadiness = immediateClear ? countNearClearFootprints(nextState.board, nextPiece) : 0;
  // No attack amount enters this contribution.  A clear merely opens the
  // continuation question; exact B2B/REN and the next known piece decide it.
  const b2bRetention = immediateClear && nextState.chain.b2b > 0 ? 2 : 0;
  const renContinuation = immediateClear ? Math.min(3, Math.max(0, nextState.chain.combo)) : 0;
  const heightRisk = Math.min(3, Math.floor(evaluationFeatures.maxHeight / 8));
  const units = Math.max(-3, Math.min(6, b2bRetention + renContinuation + queueLineReadiness - heightRisk));
  return {
    immediateClear,
    b2bAfter: nextState.chain.b2b,
    comboAfter: nextState.chain.combo,
    nextPiece,
    queueLineReadiness,
    heightRisk,
    units,
  };
}

export function countNearClearFootprints(board, nextPiece) {
  if (board?.fidelity !== "exact" || !Number.isSafeInteger(board.width) || !Number.isSafeInteger(board.height) ||
    typeof board.cells !== "string" || board.cells.length !== board.width * board.height) {
    throw new Error("CS1 requires an exact canonical board");
  }
  const footprints = HORIZONTAL_FOOTPRINTS[nextPiece];
  let count = 0;
  for (let y = 0; y < board.height; y += 1) {
    const row = board.cells.slice(y * board.width, (y + 1) * board.width);
    const gaps = row.match(/_+/g) ?? [];
    // A row is a local continuation opportunity only when its entire missing
    // area is one exposed run matching a possible horizontal footprint.
    if (gaps.length === 1 && gaps[0].length < board.width && footprints.includes(gaps[0].length)) count += 1;
  }
  return Math.min(2, count);
}
