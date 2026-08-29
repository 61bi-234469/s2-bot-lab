import { applyTransition } from "./transition.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";
import { observeS2PostTankGarbage } from "./s2-post-tank-garbage.mjs";

export const S2_REN_POST_TANK_DEFERRAL_EVALUATOR_ID =
  "s2-ren-post-tank-deferral-evaluator/1";
export const S2_REN_POST_TANK_DEFERRAL_POLICY =
  "exact-ren-continuation-post-tank-remainder-unit/1";

/**
 * A single-transition diagnostic for the value of continuing REN while an
 * incoming garbage remainder survives the canonical lock.  It is deliberately
 * not a deadline predictor: every garbage number is read after the Simulator
 * has performed cancellation and tanking.
 */
export function evaluateS2RenPostTankDeferral(state, record, { unit = 1 } = {}) {
  if (!Number.isFinite(unit) || unit < 0 || unit > 4) {
    throw new Error("REN post-tank deferral unit must be a finite number from 0 to 4");
  }
  if (state?.chain?.fidelity !== "exact" || !Number.isSafeInteger(state.chain.combo) || state.chain.combo < 0) {
    throw new Error("REN post-tank deferral requires an exact source chain state");
  }
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  const transition = applyTransition(structuredClone(state), structuredClone(record.action), state.rulesetId);
  if (transition.legality?.legal !== true || transition.nextState === null) {
    throw new Error("REN post-tank deferral replay produced no legal transition");
  }
  const postTank = observeS2PostTankGarbage(transition);
  const comboBefore = state.chain.combo;
  const comboAfter = transition.chain?.comboAfter ?? transition.nextState.chain?.combo;
  if (!Number.isSafeInteger(comboAfter) || comboAfter < 0) {
    throw new Error("REN post-tank deferral requires an exact post-transition combo");
  }

  let units = 0;
  let classification = "ren-inactive";
  if (comboBefore >= 1 && comboAfter > comboBefore && postTank.remainingIncoming > 0 && postTank.tankedIncoming === 0) {
    units = unit;
    classification = "ren-continued-with-post-tank-remainder";
  } else if (comboBefore >= 1 && comboAfter === 0 && postTank.tankedIncoming > 0) {
    units = -unit;
    classification = "ren-broken-with-canonical-tank";
  } else if (comboBefore >= 1) {
    classification = "ren-active-no-certified-deferral";
  }

  return Object.freeze({
    stateKey: replayed.stateKey,
    nextStateKey: replayed.nextStateKey,
    units,
    classification,
    comboBefore,
    comboAfter,
    postTank,
    evaluator: Object.freeze({
      id: S2_REN_POST_TANK_DEFERRAL_EVALUATOR_ID,
      policy: S2_REN_POST_TANK_DEFERRAL_POLICY,
      unit,
      direction: "higher-is-better",
      source: "replay-verified canonical S2 transition after cancellation and tanking",
    }),
  });
}
