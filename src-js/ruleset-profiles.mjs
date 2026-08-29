import { FOUNDATION_PLACEMENT_RULES } from "./triangle/placement-adapter.mjs";
import S2_OBSERVED_MANIFEST from "../rulesets/tetrio-s2-v19-beta-1-5-0-observed.json" with { type: "json" };

export { S2_OBSERVED_MANIFEST };

// Ruleset identity is the canonical key for rule values. A fixture declares
// only a `rulesetId`, so the rules a transition runs under are resolved from
// that id instead of defaulting to a single hardcoded profile. Without this
// step a fixture can be evaluated under rules it never declared, and mechanisms
// that are off in the default profile (B2B charging, Surge) cannot be fixed by
// a fixture at all.
//
// Mechanism-isolation fixtures still use deterministic placeholder identities.
// The observed S2 profile is the exception: its manifest carries the canonical
// normalizedOptionsHash recovered from the 173-key source option registry.
const IDENTITY_PREFIX = "tetrio-s2-v19-";
const IDENTITY_SUFFIX = "-beta-1-5-0";
const IDENTITY_BODY_LENGTH = 64;

function placeholderIdentity(label) {
  if (!/^[a-z0-9-]+$/.test(label) || label.length > IDENTITY_BODY_LENGTH) {
    throw new Error(`invalid placeholder ruleset label ${label}`);
  }
  return `${IDENTITY_PREFIX}${label.padEnd(IDENTITY_BODY_LENGTH, "0")}${IDENTITY_SUFFIX}`;
}

function identityFor(definition) {
  return definition.id ?? placeholderIdentity(definition.label);
}

// Each profile is the Foundation profile plus the listed overrides. Declaring
// the difference instead of a whole rule set keeps a fixture result
// attributable to the mechanism the profile names: a fixture that changes
// because of an unrelated rule would have to change the override list first.
const PROFILE_DEFINITIONS = Object.freeze([
  { key: "foundation", label: "foundation", overrides: {} },
  {
    // This combined profile has a canonical S-RULESET/1 identity. Semantic
    // qualification remains provisional for options that are only guarded and
    // have not yet been admitted as interpreted or operation-irrelevant.
    key: "s2Observed",
    id: S2_OBSERVED_MANIFEST.id,
    overrides: {
      perfectClearGarbage: 5,
      spinBonuses: "all-mini+",
      comboTable: "multiplier",
      b2bChaining: false,
      b2bCharging: { at: 4, base: 3 },
      openerPhase: 14,
      garbageMultiplier: { base: 1, increase: 0.008, marginFrames: 10800 },
      garbageCap: { base: 8, increase: 0, marginFrames: 0 },
      garbageMessiness: { change: 1, within: 0, nosame: false, timeout: 0, center: false },
      garbageHole: { size: 1, speed: 20 },
      kickTable: "SRS+",
      movementAssumption: "engine-frame-with-hidden-spawn-buffer",
    },
  },
  {
    key: "b2bCharging",
    label: "b2bcharging",
    overrides: { b2bCharging: { at: 4, base: 3 } },
  },
  {
    // `combotable: "multiplier"` is the value the S2 profile carries (OQ-001).
    // It scales attack by the combo length and produces fractional garbage,
    // which is what makes the rounding mode observable.
    key: "comboMultiplier",
    label: "combo-multiplier",
    overrides: { comboTable: "multiplier" },
  },
  {
    // A deliberately small cap. The Foundation cap of 100 never binds, so no
    // fixture can show what happens when a placement cannot tank everything
    // it owes.
    key: "tankCap2",
    label: "tank-cap-2",
    overrides: { garbageCap: { base: 2, increase: 0, marginFrames: 0 } },
  },
  {
    // During the opener phase a chunk has twice its normal cancellation
    // strength: its normal send budget and an equal bonus both cancel the
    // incoming FIFO queue. The Foundation phase length of 0 makes the guard
    // false on every placement, so no fixture under it can reach the branch.
    key: "openerPhase",
    label: "opener-phase",
    overrides: { openerPhase: 12 },
  },
  {
    // The Foundation profile never rerolls, so every tanked row in every
    // fixture so far shared one hole column and the messiness rules were
    // unreachable from a ruleset id. `change: 1` rerolls at each packet
    // boundary and `nosame` forces the new column to differ from the last.
    key: "messiness",
    label: "messiness",
    overrides: {
      garbageMessiness: { change: 1, within: 0, nosame: true, timeout: 0, center: false },
    },
  },
  {
    // A two-cell hole narrows the draw to `boardWidth - (holeSize - 1)`
    // columns and widens the gap each tanked row leaves.
    key: "wideGarbageHole",
    label: "wide-garbage-hole",
    overrides: { garbageHole: { size: 2, speed: 0 } },
  },
  {
    // `rounding: "rng"` is the second rounding mode the Triangle queue
    // implements. It only differs from `down` on a fractional attack, so the
    // profile has to carry the combo table that produces one.
    key: "roundingRng",
    label: "rounding-rng",
    overrides: { comboTable: "multiplier", rounding: "rng" },
  },
  {
    // The TETR.IO defaults for a ramping garbage multiplier. The Foundation
    // profile holds it at 1 forever, so no fixture under it can show that the
    // multiplier is read at lock time or that SIM-003 fixes how it is computed.
    key: "dynamicMultiplier",
    label: "dynamic-multiplier",
    overrides: {
      garbageMultiplier: { base: 1, increase: 0.008, marginFrames: 10800 },
    },
  },
  {
    // A capability-boundary profile. Its legal placements depend on data the
    // canonical placement-level model does not contain. Keeping it resolvable
    // lets search report unsupported instead of guessing or throwing unknown-id.
    key: "engineFrameReachability",
    label: "engine-frame-reachability",
    overrides: { movementAssumption: "engine-frame-with-hidden-spawn-buffer" },
  },
]);

const PROFILES = new Map(
  PROFILE_DEFINITIONS.map((definition) => [
    identityFor(definition),
    Object.freeze({
      overrides: Object.freeze(structuredClone(definition.overrides)),
      rules: Object.freeze({ ...FOUNDATION_PLACEMENT_RULES, ...definition.overrides }),
    }),
  ]),
);

export const RULESET_IDS = Object.freeze(
  Object.fromEntries(
    PROFILE_DEFINITIONS.map((definition) => [
      definition.key,
      identityFor(definition),
    ]),
  ),
);

export function resolvePlacementRules(rulesetId) {
  return resolveProfile(rulesetId).rules;
}

export function rulesetOverrides(rulesetId) {
  return resolveProfile(rulesetId).overrides;
}

export function knownRulesetIds() {
  return [...PROFILES.keys()];
}

function resolveProfile(rulesetId) {
  const profile = PROFILES.get(rulesetId);
  if (!profile) throw new Error(`unknown ruleset id ${rulesetId}`);
  return profile;
}
