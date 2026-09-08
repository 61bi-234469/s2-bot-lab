import S2_OBSERVED_MANIFEST from "../rulesets/tetrio-s2-v19-beta-1-5-0-observed.json" with { type: "json" };

const PUBLIC_RULES = Object.freeze({
  rulesetId: S2_OBSERVED_MANIFEST.id,
  perfectClearB2bBonus: 1,
  b2bCharging: Object.freeze({ at: 4, base: 3 }),
  garbageMultiplier: Object.freeze({ base: 1, increase: 0.008, marginFrames: 10800 }),
  kickTable: "SRS+",
  allow180: true,
  spinBonuses: "all-mini+",
});

/** Public values needed by the qualified F14/champion decision evaluator. */
export function resolveS2AmountOnlyPublicRules(rulesetId) {
  if (rulesetId !== PUBLIC_RULES.rulesetId) throw new Error("unsupported amount-only public ruleset");
  return PUBLIC_RULES;
}
