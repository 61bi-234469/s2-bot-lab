import { createF14LeafConversionGatedProfile } from "./s2-f14-compat-browser.mjs";

// The development champion (2026-09-26): the SPSA-tuned gated leaf-conversion
// profile. Its evidence and identity record live with the development records.
export const CHAMPION_PROFILE_ARGS = Object.freeze({
  scale: "0.1164",
  maxHeight: "8",
  weightOverrides: Object.freeze({
    combo_attack: "2.2999",
    freestyle_exploitation: "0.5968",
    has_back_to_back: "9.1124",
    height: "-2.8242",
    height_upper_half: "-9.5488",
    holes: "-1.1368",
    row_transitions: "-0.6704",
    "spin_clears.2": "4.6297",
  }),
});
export const CHAMPION_NATIVE_BINARY_SHA256 =
  "sha256:f10b1315660034e5ebad6114ac53594263d4105836e40a11228652cfa214f3ad";

/** The previous development champion (2026-09-25..26): the gated profile at
 * kappa 0.25, H 8 and its default weights. Kept as a GUI comparison bot only. */
export const PREVIOUS_CHAMPION_PROFILE_ARGS = Object.freeze({ scale: "0.25", maxHeight: "8" });

/** The champion's gated profile at its default budget (512 selections). */
export function createChampionBaseProfile() {
  return createF14LeafConversionGatedProfile(CHAMPION_PROFILE_ARGS);
}
