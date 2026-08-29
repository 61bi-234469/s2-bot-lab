// F7 next-lock survival frontier (ADR-027).
//
// The question this evaluator answers is deliberately small: after a root
// candidate is locked, does the known next piece have ANY S2-reachable
// placement that does not top out? Not which one is best, not what it is
// worth — only whether one exists. The single quantity that crosses the lock
// boundary is a boolean, which is what separates this family from the depth-2
// tree that closed at margin -9.
//
// Cost forced the shape of the search. A complete S2 reachability enumeration
// costs ~39 ms per state on the reference container, and 16 candidates per
// lock cannot pay that. So the two possible answers are established
// differently:
//
//   - SURVIVAL is established by a witness. Hard-drop placements are generated
//     first (~1.2 ms). One whose blocks all sit below the visible ceiling is a
//     non-top-out continuation, and finding it ends the search. Line clears
//     only lower the stack, so no clear can turn such a placement into a
//     top-out — the witness cannot be wrong in the optimistic direction.
//   - DEATH is never concluded from the cheap path. Without a witness the
//     evaluator enumerates the complete S2-reachable set and applies the
//     Simulator to every member, and reports `survives: false` only when that
//     exhaustive set is empty or every member tops out.
//
// `exhaustive` and `witnessSource` are on the record so a reader can tell
// which path produced the answer, and so a claimed death without an exhaustive
// enumeration is a failure rather than a result.

import { applyTransition } from "./transition.mjs";
import { resolvePlacementRules } from "./ruleset-profiles.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";
import { generateHardDropPlacements, generateReachablePlacements } from "./triangle/move-generation.mjs";
import { placementGeometry } from "./triangle/placement-geometry.mjs";

export const S2_NEXT_LOCK_SURVIVAL_EVALUATOR_ID = "s2-next-lock-survival-evaluator/1";
export const S2_NEXT_LOCK_SURVIVAL_POLICY = "exact-next-lock-non-top-out-continuation-existence/1";

// The canonical board is 40 rows; the visible field is the bottom 20. A cell
// at or above this row is a top-out, which is the same rule the match runners
// apply to a committed state.
export const VISIBLE_FIELD_HEIGHT = 20;

/**
 * Existence of a non-top-out continuation for the next lock from `state`.
 *
 * Returns the witness path that produced the answer so the caller can record
 * it. A `survives: false` result always carries `exhaustive: true`.
 */
export function findNextLockSurvival(state) {
  assertExactBoard(state?.board);
  if (state?.pieces?.fidelity !== "exact") {
    throw new Error("next-lock survival requires exact canonical piece state");
  }
  // The generated witness is fed straight back to the Simulator.  It must use
  // the state profile's actual kick table (S2 currently uses SRS+), rather
  // than the generic SRS default used by standalone move generation.
  const movementRules = resolvePlacementRules(state.rulesetId);
  const geometry = placementGeometry(movementRules);

  for (const placement of generateHardDropPlacements(state)) {
    if (belowVisibleCeiling(placement, geometry)) {
      return Object.freeze({
        survives: true,
        exhaustive: false,
        witnessSource: "hard-drop-below-visible-ceiling",
        continuationCount: null,
      });
    }
  }

  // No cheap witness: prove the answer either way over the complete frontier.
  let continuationCount = 0;
  for (const placement of generateReachablePlacements(state, movementRules)) {
    const transition = applyTransition(
      structuredClone(state),
      { kind: "placement", placement },
      state.rulesetId,
    );
    if (transition.legality?.legal !== true || transition.nextState === null) continue;
    if (isToppedOut(transition.nextState)) continue;
    continuationCount += 1;
  }
  return Object.freeze({
    survives: continuationCount > 0,
    exhaustive: true,
    witnessSource: continuationCount > 0 ? "exhaustive-s2-reachable-frontier" : null,
    continuationCount,
  });
}

/**
 * Units for one root candidate. `0` when the candidate leaves the next lock a
 * continuation, `-1` when it leaves none. A candidate only "qualifies" when it
 * is a dead end, which is what makes the activation count meaningful: it
 * counts rescue opportunities, not positions.
 */
export function extractS2NextLockSurvival(postLockState) {
  const survival = findNextLockSurvival(postLockState);
  if (!survival.survives && !survival.exhaustive) {
    throw new Error("next-lock survival cannot report death without an exhaustive frontier");
  }
  const units = survival.survives ? 0 : -1;
  return Object.freeze({
    survives: survival.survives,
    exhaustive: survival.exhaustive,
    witnessSource: survival.witnessSource,
    continuationCount: survival.continuationCount,
    nextPiece: postLockState.pieces.current,
    holdAvailable: postLockState.pieces.holdAvailable === true,
    qualifies: units !== 0,
    units,
  });
}

export function evaluateS2NextLockSurvival(state, record) {
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  const transition = applyTransition(
    structuredClone(state),
    structuredClone(record.action),
    state.rulesetId,
  );
  if (transition.legality?.legal !== true || transition.nextState === null) {
    throw new Error("next-lock survival evaluator replay produced no legal transition");
  }
  return Object.freeze({
    stateKey: replayed.stateKey,
    nextStateKey: replayed.nextStateKey,
    ...extractS2NextLockSurvival(transition.nextState),
    evaluator: Object.freeze({
      id: S2_NEXT_LOCK_SURVIVAL_EVALUATOR_ID,
      policy: S2_NEXT_LOCK_SURVIVAL_POLICY,
      direction: "higher-is-better",
    }),
  });
}

export function isToppedOut(state) {
  const board = state.board;
  for (let index = VISIBLE_FIELD_HEIGHT * board.width; index < board.cells.length; index += 1) {
    if (board.cells[index] !== "_") return true;
  }
  return false;
}

function belowVisibleCeiling(placement, geometry) {
  const blocks = geometry.blocks[placement.piece]?.[placement.rotation];
  if (blocks === undefined) {
    throw new Error(`next-lock survival has no geometry for ${placement.piece}/${placement.rotation}`);
  }
  return blocks.every(([, dy]) => placement.y + dy < VISIBLE_FIELD_HEIGHT);
}

function assertExactBoard(board) {
  if (board?.fidelity !== "exact") {
    throw new Error("next-lock survival requires an exact canonical board");
  }
  if (!Number.isSafeInteger(board.width) || !Number.isSafeInteger(board.height) ||
    board.width < 1 || board.height <= VISIBLE_FIELD_HEIGHT) {
    throw new Error("next-lock survival requires a canonical board taller than the visible field");
  }
  if (typeof board.cells !== "string" || board.cells.length !== board.width * board.height ||
    !/^[IJLOSTZG_]+$/.test(board.cells)) {
    throw new Error("next-lock survival requires canonical board cells");
  }
}
