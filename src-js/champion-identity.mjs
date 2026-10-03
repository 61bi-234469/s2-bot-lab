import { createF14LeafConversionGatedProfile } from "./s2-f14-compat-browser.mjs";

/** The REN attack gain champion (2026-09-27..30): the SPSA v2 tuned gated
 * leaf-conversion profile plus the opt-in pre-cancel REN attack gain. Kept as a
 * former-champion GUI bot and pinned by older evaluation contracts. */
export const REN_GAIN_CHAMPION_PROFILE_ARGS = Object.freeze({
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
    leaf_ren_attack_gain: "1",
    "mini_spin_clears.2": "1.0439",
    "normal_clears.4": "2.6543",
    row_transitions: "-0.9132",
    "spin_clears.1": "3.6892",
    "spin_clears.2": "2.1779",
    "spin_clears.3": "8.6403",
    wasted_t: "-2.7843",
  }),
});

/** The SPSA v2 champion (2026-09-26..27): the same tuned weights without the
 * REN attack gain. Kept as a former-champion GUI bot and pinned by older
 * evaluation contracts. */
export const SPSA_V2_CHAMPION_PROFILE_ARGS = Object.freeze({
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

/** The previous development champion (2026-09-25..26): the gated profile at
 * kappa 0.25, H 8 and its default weights. Kept as a GUI comparison bot only. */
export const PREVIOUS_CHAMPION_PROFILE_ARGS = Object.freeze({ scale: "0.25", maxHeight: "8" });

// The champion 2026-09-30..10-03 (Sold Slear, Legacy backup consistency): the
// REN attack gain champion plus the opt-in legacy_backup_consistency key. Kept
// as a former-champion GUI bot at 512 selections.
export const BACKUP_CONSISTENCY_CHAMPION_PROFILE_ARGS = Object.freeze({
  ...REN_GAIN_CHAMPION_PROFILE_ARGS,
  weightOverrides: Object.freeze({ ...REN_GAIN_CHAMPION_PROFILE_ARGS.weightOverrides, legacy_backup_consistency: "1" }),
});

// The current champion (2026-10-03): Legacy backup consistency searched at
// 2,048 selections with the search tree kept across requests
// (tree_reuse_floor 256). Its decisions depend on the request sequence.
export const CHAMPION_PROFILE_ARGS = Object.freeze({
  ...BACKUP_CONSISTENCY_CHAMPION_PROFILE_ARGS,
  selections: 2048,
  weightOverrides: Object.freeze({ ...BACKUP_CONSISTENCY_CHAMPION_PROFILE_ARGS.weightOverrides, tree_reuse_floor: "256" }),
});

/** The champion's gated profile at its default budget (2,048 selections, tree reuse). */
export function createChampionBaseProfile() {
  return createF14LeafConversionGatedProfile(CHAMPION_PROFILE_ARGS);
}
