import { declareCc2S2ScreenSeeds } from "./cc2-s2-development-seed-shuffle.mjs";

export const CC2_S2_F4_F6_SCREEN_DESIGN = Object.freeze({
  maximumNominalPairs: 480,
  minimumDecisivePairs: 80,
  detectionTarget: 0.65,
  assumedTieRate: 0.8,
});

export const CC2_S2_F4_F6_SCREENS = Object.freeze({
  F4a: Object.freeze({
    id: "F4a",
    protocolId: "f4a-all-spin-mini-direction/1",
    shuffleKey: "f4a-all-spin-mini/1",
    seedStart: 49000,
    count: 480,
  }),
  F4b: Object.freeze({
    id: "F4b",
    protocolId: "f4b-mini-to-tsd-witness-direction/1",
    shuffleKey: "f4b-mini-to-tsd-witness/1",
    seedStart: 49500,
    count: 480,
  }),
  F5: Object.freeze({
    id: "F5",
    protocolId: "f5-nondefensive-small-ren-direction/1",
    shuffleKey: "f5-nondefensive-small-ren/1",
    seedStart: 50000,
    count: 480,
  }),
  F6: Object.freeze({
    id: "F6",
    protocolId: "f6-equal-combat-terrain-direction/1",
    shuffleKey: "f6-equal-combat-terrain/1",
    seedStart: 50500,
    count: 480,
  }),
});

export function declaredCc2S2F4F6ScreenSeeds(familyId) {
  const family = CC2_S2_F4_F6_SCREENS[familyId];
  if (family === undefined) throw new Error(`unknown F4-F6 screen family ${familyId}`);
  return declareCc2S2ScreenSeeds({
    seedStart: family.seedStart,
    count: family.count,
    key: family.shuffleKey,
    take: CC2_S2_F4_F6_SCREEN_DESIGN.maximumNominalPairs,
  });
}
