import { canonicalize } from "./cs1-core.mjs";
import { resolveDynamicValue } from "./dynamic-values.mjs";
import { resolvePlacementRules } from "./ruleset-profiles.mjs";
import {
  evaluateS2F12PostTankSolvencyRescueCandidates,
  formatS2F12PostTankSolvencyRescueSelection,
} from "./s2-f12-post-tank-solvency-rescue-selector.mjs";

export const S2_F14_CAPPED_NEXT_TANK_SURVIVAL_RESCUE_SELECTOR_POLICY =
  "f14-control-with-capped-next-tank-survival-rescue-only/1";

/**
 * ADR-048. F14's `solvency = visibleMargin - postTankDebt` compares the board's
 * room against the *entire* outstanding debt, but S2 inserts at most
 * `garbageCap` rows on a lock that clears nothing, so the whole debt can never
 * land at once. F24 acts only in the branch F14 abandons -- its choice
 * insolvent and no solvent candidate -- and asks the narrower question the cap
 * actually poses: does this candidate survive the next forced tank?
 *
 * The predicate is a worst-case guarantee, not a prediction. If the next lock
 * clears a line nothing inserts at all, so the guarantee only becomes safer;
 * nothing here values a choice the bot might make later.
 *
 * There is deliberately no `toppedOut` conjunct. `tankResult.toppedOut` is
 * hardcoded `false` in the canonical placement path (see ADR-048 Context), so
 * such a guard is inert -- the defect this family avoids repeating.
 */

/**
 * The cap is read from the canonical ruleset rather than hardcoded. A ramping
 * cap would make `min(debt, capNow)` understate a later tank, so the worst-case
 * guarantee is only sound while the cap is constant; anything else fails closed.
 */
export function resolveS2CanonicalGarbageCap(state) {
  if (state?.time?.fidelity !== "exact" || typeof state?.rulesetId !== "string") {
    throw new Error("F24 rescue requires exact canonical time and a canonical ruleset id");
  }
  const spec = resolvePlacementRules(state.rulesetId).garbageCap;
  if (spec?.increase !== 0) {
    throw new Error("F24 rescue requires a non-ramping canonical garbage cap");
  }
  // Triangle floors a fractional cap inside `tank`; mirror that exactly.
  const cap = Math.floor(resolveDynamicValue(spec, state.time));
  if (!Number.isSafeInteger(cap) || cap < 0) {
    throw new Error("F24 rescue requires an exact non-negative canonical garbage cap");
  }
  return cap;
}

function assertCandidateEvidence(candidate) {
  const solvency = candidate?.solvency;
  if (!Number.isFinite(solvency?.solvency) ||
      !Number.isSafeInteger(solvency?.visibleMargin) ||
      !Number.isSafeInteger(solvency?.postTankDebt) || solvency.postTankDebt < 0 ||
      typeof solvency?.stateKey !== "string" || solvency.stateKey.length === 0 ||
      typeof solvency?.nextStateKey !== "string" || solvency.nextStateKey.length === 0) {
    throw new Error("F24 rescue requires exact F14 post-tank solvency for every candidate");
  }
}

function identityKey(candidate) {
  if (candidate?.identity === undefined) throw new Error("F24 rescue requires unique candidate identities");
  return canonicalize(candidate.identity);
}

/** Rows that the next zero-clear lock can actually insert, bounded by the cap. */
export function nextTankLoad(candidate, garbageCap) {
  return Math.min(candidate.solvency.postTankDebt, garbageCap);
}

export function survivesNextTank(candidate, garbageCap) {
  return survivalSurplus(candidate, garbageCap) >= 0;
}

/** Rows of room left over once the capped next tank has landed. */
export function survivalSurplus(candidate, garbageCap) {
  return candidate.solvency.visibleMargin - nextTankLoad(candidate, garbageCap);
}

/**
 * Per-candidate activation record for the family registry. `units` follows the
 * F22 convention: nonzero only on the candidate actually applied, carrying the
 * rows of survival margin the rescue bought over the abandoned F14 choice.
 * Whole-population conjunct counting is the offline activation script's job,
 * because the runner only records diagnostics on locks where the family
 * returned its own result.
 */
export function cappedSurvivalDiagnostic(candidate, garbageCap, replacedControl = null) {
  const surplus = survivalSurplus(candidate, garbageCap);
  return Object.freeze({
    garbageCap,
    visibleMargin: candidate.solvency.visibleMargin,
    postTankDebt: candidate.solvency.postTankDebt,
    nextTankLoad: nextTankLoad(candidate, garbageCap),
    survivalSurplus: surplus,
    survivesNextTank: surplus >= 0,
    applied: replacedControl !== null,
    qualifies: surplus < 0,
    units: replacedControl === null ? 0 : surplus - survivalSurplus(replacedControl, garbageCap),
  });
}

/**
 * Candidates stay in immutable F14 base order. F24 is a Boolean survival
 * replacement, not an aggregate score or a new ranking policy.
 */
export function chooseS2F14CappedNextTankSurvival(candidates, f14Choice, garbageCap) {
  if (!Array.isArray(candidates) || candidates.length === 0 || f14Choice?.selected === undefined) {
    throw new Error("F24 rescue requires F14-ranked candidates and an F14 control decision");
  }
  if (typeof f14Choice.rescued !== "boolean") {
    throw new Error("F24 rescue requires an exact F14 rescue disposition");
  }
  if (!Number.isSafeInteger(garbageCap) || garbageCap < 0) {
    throw new Error("F24 rescue requires an exact non-negative canonical garbage cap");
  }
  candidates.forEach(assertCandidateEvidence);
  const identities = candidates.map(identityKey);
  if (new Set(identities).size !== identities.length) {
    throw new Error("F24 rescue requires unique candidate identities");
  }
  const controlIndex = candidates.indexOf(f14Choice.selected);
  if (controlIndex === -1) throw new Error("F24 rescue F14 control must be one of the exact ranked candidates");
  const control = candidates[controlIndex];

  // ADR-048 step 4. Both cases imply the F14 selection already survives:
  // `solvency >= 0` gives `visibleMargin >= postTankDebt >= min(postTankDebt, cap)`,
  // and a successful rescue selects a solvent candidate. Spelling the branch out
  // keeps the "F24 cannot contradict F14" property readable rather than implicit.
  const abandoned = !f14Choice.rescued && candidates[0].solvency.solvency < 0;
  if (!abandoned) {
    return Object.freeze({ control, selected: control, abandoned: false, triggered: false, rescued: false, eligible: [] });
  }

  // ADR-048 step 5.
  const triggered = !survivesNextTank(control, garbageCap);
  // ADR-048 step 6. The control fails the predicate here, so it cannot appear
  // among the survivors and needs no separate exclusion.
  const eligible = triggered ? candidates.filter((candidate) => survivesNextTank(candidate, garbageCap)) : [];
  return Object.freeze({
    control,
    selected: eligible[0] ?? control,
    abandoned: true,
    triggered,
    rescued: eligible.length > 0,
    eligible,
  });
}

export function selectS2F14CappedNextTankSurvivalRescuePlacement(guiState, moves, options = {}) {
  const evaluation = evaluateS2F12PostTankSolvencyRescueCandidates(guiState, moves, options);
  const f14 = formatS2F12PostTankSolvencyRescueSelection(evaluation);
  const candidates = evaluation.candidates;
  const garbageCap = resolveS2CanonicalGarbageCap(evaluation.base.state);
  const choice = chooseS2F14CappedNextTankSurvival(candidates, evaluation.choice, garbageCap);
  // Without a proved survivor, preserve the exact F14 result byte for byte.
  if (!choice.rescued) return f14;
  const best = choice.selected;
  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison,
      engineId: "s2-f14-capped-next-tank-survival-rescue-selector/1",
      source: S2_F14_CAPPED_NEXT_TANK_SURVIVAL_RESCUE_SELECTOR_POLICY,
      moveSelectionPolicy: S2_F14_CAPPED_NEXT_TANK_SURVIVAL_RESCUE_SELECTOR_POLICY,
      baseMoveSelectionPolicy: "f12-control-with-post-tank-solvency-rescue-only/1",
      selectedCc2Rank: best.cc2Rank,
      postTankSolvency: best.solvency,
      cappedNextTankSurvival: {
        applied: true,
        garbageCap,
        controlCc2Rank: choice.control.cc2Rank,
        controlSolvency: choice.control.solvency.solvency,
        controlVisibleMargin: choice.control.solvency.visibleMargin,
        controlNextTankLoad: nextTankLoad(choice.control, garbageCap),
        selectedNextTankLoad: nextTankLoad(best, garbageCap),
        qualifyingSurvivors: choice.eligible.length,
      },
    },
    candidates: candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      identity: candidate.identity,
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      conversion: candidate.conversion,
      solvency: candidate.solvency,
      cappedSurvival: cappedSurvivalDiagnostic(
        candidate, garbageCap, candidate === best ? choice.control : null,
      ),
    })),
  };
}
