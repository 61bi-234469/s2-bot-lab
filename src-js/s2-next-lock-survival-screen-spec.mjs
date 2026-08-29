// F7 direction-screen design, frozen before any pair is played (ADR-026).
//
// This module belongs to F7 alone. F8 and F9 have their own, with their own
// reserved blocks and their own shuffle keys, because the Cloud override
// record requires the three families to share no protocol, block, or evidence.

import { declareCc2S2ScreenSeeds } from "./cc2-s2-development-seed-shuffle.mjs";

export const S2_NEXT_LOCK_SURVIVAL_SCREEN = Object.freeze({
  id: "F7",
  protocolId: "f7-next-lock-survival-frontier-direction/1",
  shuffleKey: "f7-next-lock-survival-frontier/1",
  reservedStart: 53000,
  reservedCount: 480,
  // ADR-026 worked design: D = 80 / N = 480 gives power 90.0% at alpha 7.3%
  // for a detection target of p >= 0.65 at an assumed 80% tie rate.
  maximumNominalPairs: 480,
  minimumDecisivePairs: 80,
  detectionTarget: 0.65,
  assumedTieRate: 0.8,
});

export function declaredS2NextLockSurvivalScreenSeeds() {
  return declareCc2S2ScreenSeeds({
    seedStart: S2_NEXT_LOCK_SURVIVAL_SCREEN.reservedStart,
    count: S2_NEXT_LOCK_SURVIVAL_SCREEN.reservedCount,
    key: S2_NEXT_LOCK_SURVIVAL_SCREEN.shuffleKey,
    take: S2_NEXT_LOCK_SURVIVAL_SCREEN.maximumNominalPairs,
  });
}
