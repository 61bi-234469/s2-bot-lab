import { selectS2F12PostTankSolvencyRescuePlacement } from "./s2-f12-post-tank-solvency-rescue-selector.mjs";
import {
  S2_THRESHOLD_IMMINENT_B2B_RETENTION_SELECTOR_POLICY,
  selectS2ThresholdImminentB2bRetentionPlacement,
} from "./s2-threshold-imminent-b2b-retention-selector.mjs";

export const S2_THRESHOLD_IMMINENT_B2B_RETENTION_FALLBACK_SELECTOR_POLICY =
  "f25-threshold-imminent-b2b-retention-rescue-only/2";

function bindRepairedPolicy(selection) {
  if (selection?.comparison?.moveSelectionPolicy !== S2_THRESHOLD_IMMINENT_B2B_RETENTION_SELECTOR_POLICY) {
    return selection;
  }
  return {
    ...selection,
    comparison: {
      ...selection.comparison,
      engineId: "s2-threshold-imminent-b2b-retention-fallback-selector/1",
      source: S2_THRESHOLD_IMMINENT_B2B_RETENTION_FALLBACK_SELECTOR_POLICY,
      moveSelectionPolicy: S2_THRESHOLD_IMMINENT_B2B_RETENTION_FALLBACK_SELECTOR_POLICY,
    },
  };
}

/**
 * F25R preserves the frozen F25 decision wherever rank 1 exists. A complete
 * one-candidate prefix has no alternative rank to rescue to, so it is an
 * exact F14 no-op instead of a proposal failure.
 */
export function selectS2ThresholdImminentB2bRetentionFallbackPlacement(guiState, moves, options = {}) {
  if (Array.isArray(moves) && moves.length === 1) {
    return selectS2F12PostTankSolvencyRescuePlacement(guiState, moves, {
      ...options,
      unverifiableCandidatePolicy: "fail-closed",
    });
  }
  return bindRepairedPolicy(selectS2ThresholdImminentB2bRetentionPlacement(guiState, moves, options));
}
