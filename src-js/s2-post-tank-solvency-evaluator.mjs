import { applyTransition } from "./transition.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";
import { observeS2PostTankGarbage } from "./s2-post-tank-garbage.mjs";

export const S2_POST_TANK_SOLVENCY_EVALUATOR_ID = "s2-post-tank-solvency-evaluator/1";
export const S2_POST_TANK_SOLVENCY_POLICY =
  "exact-post-tank-visible-margin-minus-remaining-debt/1";

/**
 * The F14 diagnostic is intentionally a post-lock observation, not a scoring
 * feature.  It uses only the canonical board after tanking and F0's exact
 * remaining packet total.  A non-negative result is solvent unless the
 * canonical tank result reports a top out.
 */
export function assessS2PostTankSolvency(transition) {
  if (transition?.legality?.legal !== true || transition.nextState === null) {
    throw new Error("post-tank solvency requires a legal canonical transition");
  }
  if (typeof transition.tankResult?.toppedOut !== "boolean") {
    throw new Error("post-tank solvency requires a canonical tank top-out result");
  }
  const postTank = observeS2PostTankGarbage(transition);
  const visibleMargin = exactVisibleMargin(transition.nextState.board);
  const postTankDebt = postTank.remainingIncoming;
  if (!Number.isSafeInteger(postTankDebt) || postTankDebt < 0) {
    throw new Error("post-tank solvency requires an exact remaining debt");
  }
  const solvency = visibleMargin - postTankDebt;
  const toppedOut = transition.tankResult.toppedOut;
  const solvent = !toppedOut && solvency >= 0;
  return Object.freeze({
    visibleMargin,
    postTankDebt,
    solvency,
    toppedOut,
    solvent,
    qualifies: solvency < 0,
    // Telemetry only: negative units count candidates for which an F14 rescue
    // may be available.  The selector never adds this to an F12 score.
    units: solvency < 0 ? -1 : 0,
    postTank,
  });
}

export function evaluateS2PostTankSolvency(state, record) {
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  const transition = applyTransition(
    structuredClone(state),
    structuredClone(record.action),
    state.rulesetId,
  );
  if (transition.legality?.legal !== true || transition.nextState === null) {
    throw new Error("post-tank solvency evaluator replay produced no legal transition");
  }
  return Object.freeze({
    stateKey: replayed.stateKey,
    nextStateKey: replayed.nextStateKey,
    ...assessS2PostTankSolvency(transition),
    evaluator: Object.freeze({
      id: S2_POST_TANK_SOLVENCY_EVALUATOR_ID,
      policy: S2_POST_TANK_SOLVENCY_POLICY,
      direction: "higher-is-better",
    }),
  });
}

function exactVisibleMargin(board) {
  if (board?.fidelity !== "exact" || !Number.isSafeInteger(board.width) ||
    !Number.isSafeInteger(board.height) || board.width < 1 || board.height < 1 ||
    typeof board.cells !== "string" || board.cells.length !== board.width * board.height ||
    !/^[IJLOSTZG_]+$/.test(board.cells)) {
    throw new Error("post-tank solvency requires an exact canonical board");
  }
  const visibleHeight = board.visibleHeight ?? board.height;
  if (!Number.isSafeInteger(visibleHeight) || visibleHeight < 1 || visibleHeight > board.height) {
    throw new Error("post-tank solvency requires a canonical visible height");
  }
  let maxHeight = 0;
  for (let y = board.height - 1; y >= 0 && maxHeight === 0; y -= 1) {
    for (let x = 0; x < board.width; x += 1) {
      if (board.cells[y * board.width + x] !== "_") {
        maxHeight = y + 1;
        break;
      }
    }
  }
  return visibleHeight - maxHeight;
}
