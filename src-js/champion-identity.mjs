import { createF14LeafConversionGatedProfile } from "./s2-f14-compat-browser.mjs";

// The development champion (2026-09-26, SPSA v2): the gated leaf-conversion
// profile after two SPSA tuning rounds. Its evidence and identity record live
// with the development records.
export const CHAMPION_PROFILE_ARGS = Object.freeze({
  scale: "0.1164",
  maxHeight: "8",
  weightOverrides: Object.freeze({
    back_to_back_clear: "4.6655",
    cell_coveredness: "-0.4398",
    combo_attack: "2.2999",
    freestyle_exploitation: "0.5968",
    has_back_to_back: "7.7069",
    height: "-1.9529",
    height_upper_half: "-9.5488",
    height_upper_quarter: "-65.8205",
    holes: "-0.825",
    "mini_spin_clears.2": "1.0439",
    "normal_clears.4": "2.6543",
    row_transitions: "-0.9132",
    "spin_clears.1": "3.6892",
    "spin_clears.2": "2.1779",
    "spin_clears.3": "8.6403",
    wasted_t: "-2.7843",
  }),
});

/** The SPSA v1 champion (2026-09-26): the first tuning round. Kept as a GUI
 * comparison bot. */
export const SPSA_V1_CHAMPION_PROFILE_ARGS = Object.freeze({
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
