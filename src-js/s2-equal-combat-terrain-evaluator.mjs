import { applyTransition } from "./transition.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";

export const S2_EQUAL_COMBAT_TERRAIN_EVALUATOR_ID = "s2-equal-combat-terrain-evaluator/1";
export const S2_EQUAL_COMBAT_TERRAIN_POLICY = "equal-combat-holes-coveredness-height-tiebreak/1";
export const S2_EQUAL_COMBAT_TERRAIN_CAP = 0.9;

export function extractBoardTerrain(board) {
  if (board?.fidelity !== "exact") {
    throw new Error("terrain extraction requires an exact canonical board");
  }
  if (!Number.isSafeInteger(board.width) || !Number.isSafeInteger(board.height) ||
    board.width < 1 || board.height < 1) {
    throw new Error("terrain extraction requires a positive integer board geometry");
  }
  if (typeof board.cells !== "string" || !/^[IJLOSTZG_]+$/.test(board.cells) ||
    board.cells.length !== board.width * board.height) {
    throw new Error("terrain extraction requires canonical board cells");
  }
  const heights = [];
  let holes = 0;
  let coveredness = 0;
  for (let x = 0; x < board.width; x += 1) {
    let highest = -1;
    for (let y = board.height - 1; y >= 0; y -= 1) {
      if (board.cells[y * board.width + x] !== "_") {
        highest = y;
        break;
      }
    }
    heights.push(highest + 1);
    let holeBelow = false;
    let filledAboveHole = 0;
    for (let y = 0; y <= highest; y += 1) {
      if (board.cells[y * board.width + x] === "_") {
        holes += 1;
        holeBelow = true;
      } else if (holeBelow) {
        filledAboveHole += 1;
      }
    }
    coveredness += filledAboveHole;
  }
  const maxHeight = Math.max(0, ...heights);
  const rawTerrain = -0.2 * holes - 0.06 * coveredness - 0.1 * maxHeight;
  return Object.freeze({ holes, coveredness, maxHeight, rawTerrain });
}

export function extractS2EqualCombatTerrain(transition) {
  if (transition?.legality?.legal !== true || transition.nextState === null) {
    throw new Error("terrain extraction requires a legal canonical transition");
  }
  const outgoingAfterCancel = transition.cancelResult?.outgoingAfterCancel;
  const cancelled = transition.cancelResult?.cancelled;
  if (!Number.isFinite(outgoingAfterCancel) || outgoingAfterCancel < 0 ||
    !Number.isFinite(cancelled) || cancelled < 0) {
    throw new Error("terrain extraction received malformed cancellation stages");
  }
  return Object.freeze({
    realisedCombat: outgoingAfterCancel + cancelled,
    outgoingAfterCancel,
    cancelled,
    ...extractBoardTerrain(transition.nextState.board),
    units: 0,
    equalCombatTie: false,
    qualifies: false,
  });
}

export function applyEqualCombatTerrainTieBreak(candidates, { cap = S2_EQUAL_COMBAT_TERRAIN_CAP } = {}) {
  if (!Number.isFinite(cap) || cap <= 0) throw new Error("terrain cap must be a positive finite number");
  if (!Array.isArray(candidates)) throw new Error("terrain tie-break requires a candidate list");
  const maxCombat = candidates.reduce((best, candidate) => Math.max(best, candidate.terrain.realisedCombat), -Infinity);
  const tied = candidates.filter((candidate) => candidate.terrain.realisedCombat === maxCombat);
  const tiedSet = new Set(tied);
  const mean = tied.length >= 2
    ? tied.reduce((sum, candidate) => sum + candidate.terrain.rawTerrain, 0) / tied.length
    : 0;
  for (const candidate of candidates) {
    const inTie = tied.length >= 2 && tiedSet.has(candidate);
    const units = inTie ? Math.max(-cap, Math.min(cap, candidate.terrain.rawTerrain - mean)) : 0;
    candidate.terrain = Object.freeze({
      ...candidate.terrain,
      equalCombatTie: inTie,
      units,
      qualifies: inTie && units !== 0,
    });
  }
  return candidates;
}

export function evaluateS2EqualCombatTerrain(state, record) {
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  const transition = applyTransition(structuredClone(state), structuredClone(record.action), state.rulesetId);
  if (transition.legality?.legal !== true || transition.nextState === null) {
    throw new Error("terrain evaluator replay produced no legal transition");
  }
  return Object.freeze({
    stateKey: replayed.stateKey,
    nextStateKey: replayed.nextStateKey,
    ...extractS2EqualCombatTerrain(transition),
    evaluator: Object.freeze({
      id: S2_EQUAL_COMBAT_TERRAIN_EVALUATOR_ID,
      policy: S2_EQUAL_COMBAT_TERRAIN_POLICY,
      direction: "higher-is-better",
    }),
  });
}
