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

// The champion 2026-10-03..10-10: Legacy backup consistency searched at 2,048
// selections with the search tree kept across requests (tree_reuse_floor 256).
// Its decisions depend on the request sequence. Kept as a former-champion GUI bot.
export const TREE_REUSE_CHAMPION_PROFILE_ARGS = Object.freeze({
  ...BACKUP_CONSISTENCY_CHAMPION_PROFILE_ARGS,
  selections: 2048,
  weightOverrides: Object.freeze({ ...BACKUP_CONSISTENCY_CHAMPION_PROFILE_ARGS.weightOverrides, tree_reuse_floor: "256" }),
});

// The champion 2026-10-10..20: the tree-reuse champion with ten clear-type and
// B2B weights retuned by SPSA for attack per piece. Kept as a former-champion GUI bot.
export const SPSA_V7_CHAMPION_PROFILE_ARGS = Object.freeze({
  ...TREE_REUSE_CHAMPION_PROFILE_ARGS,
  weightOverrides: Object.freeze({
    ...TREE_REUSE_CHAMPION_PROFILE_ARGS.weightOverrides,
    "normal_clears.1": "-0.1243",
    "normal_clears.2": "1.1979",
    "normal_clears.3": "2.5124",
    "normal_clears.4": "2.5434",
    tetris_well_depth: "0.2938",
    has_back_to_back: "7.3547",
    back_to_back_clear: "5.3267",
    combo_attack: "2.3463",
    "mini_spin_clears.1": "-0.1177",
    wasted_t: "-3.4694",
  }),
});

// The SPSA v10 champion: the SPSA v7 champion plus the rescue top-out fallback
// (when CC2 rank 0 tops out on its lock and the rescue does not fire, the first
// rank that does not top out is played), with ten shape and height weights
// retuned by SPSA for attack per piece and wins. Kept as a former-champion GUI bot.
export const SPSA_V10_CHAMPION_PROFILE_ARGS = Object.freeze({
  ...SPSA_V7_CHAMPION_PROFILE_ARGS,
  weightOverrides: Object.freeze({
    ...SPSA_V7_CHAMPION_PROFILE_ARGS.weightOverrides,
    rescue_topout_fallback: "1",
    cell_coveredness: "-0.355",
    holes: "-0.7294",
    row_transitions: "-1.0473",
    height: "-1.9339",
    height_upper_half: "-9.2752",
    height_upper_quarter: "-70.3881",
    "spin_clears.1": "3.6697",
    "spin_clears.2": "2.4043",
    "spin_clears.3": "8.7453",
    freestyle_exploitation: "0.4689",
  }),
});

// The current champion (2026-10-20): the SPSA v10 champion with the ten SPSA v7
// keys retuned again by SPSA for attack per piece and wins.
export const CHAMPION_PROFILE_ARGS = Object.freeze({
  ...SPSA_V10_CHAMPION_PROFILE_ARGS,
  weightOverrides: Object.freeze({
    ...SPSA_V10_CHAMPION_PROFILE_ARGS.weightOverrides,
    "normal_clears.1": "0.0451",
    "normal_clears.2": "0.8246",
    "normal_clears.3": "2.3987",
    "normal_clears.4": "2.4037",
    tetris_well_depth: "0.3687",
    has_back_to_back: "6.3455",
    back_to_back_clear: "5.1363",
    combo_attack: "2.2408",
    "mini_spin_clears.1": "0.0005",
    wasted_t: "-4.0602",
  }),
});

/** The champion's gated profile at its default budget (2,048 selections, tree reuse, SPSA v11 weights). */
export function createChampionBaseProfile() {
  return createF14LeafConversionGatedProfile(CHAMPION_PROFILE_ARGS);
}
