export const F12_MIN_B2B_BEFORE = 6;
export const F12_MIN_SURGE_SENT = 5;
export const F12_MIN_RELEASE_VALUE = 5;

export function classifyS2ConversionQualifiedRenFinisher({
  comboBefore, comboAfter, b2bBefore, b2bAfter, lines, spin, cancelled, renCombatGain,
  setupWitnessed = false, surgeSent, releaseValue,
}) {
  if (![comboBefore, comboAfter, b2bBefore, b2bAfter, lines, surgeSent].every(Number.isSafeInteger) ||
      comboBefore < 0 || comboAfter < 0 || b2bBefore < 0 || b2bAfter < 0 || lines < 0 || surgeSent < 0 ||
      !["none", "mini", "normal"].includes(spin) || !Number.isFinite(cancelled) || cancelled < 0 ||
      !Number.isFinite(renCombatGain) || !Number.isFinite(releaseValue) || typeof setupWitnessed !== "boolean") {
    throw new Error("F12 classification requires finite canonical stages");
  }
  const continuingRen = comboBefore >= 1 && comboAfter > comboBefore;
  const difficultClear = (lines === 4 && spin === "none") || (lines === 2 && spin === "normal");
  const b2bBridge = continuingRen && difficultClear && b2bAfter > 0 && renCombatGain > 0;
  const setupBridge = continuingRen && ((spin === "mini" && lines >= 1) || (spin === "normal" && lines === 1)) &&
    b2bAfter > 0 && setupWitnessed;
  const highSurgeFinisher = b2bBefore >= F12_MIN_B2B_BEFORE && surgeSent >= F12_MIN_SURGE_SENT &&
    releaseValue >= F12_MIN_RELEASE_VALUE;
  const highOrDefensive = continuingRen && (comboAfter >= 6 || cancelled > 0);
  const lowValue = spin === "none" && (lines === 1 || lines === 2) && continuingRen && comboAfter < 6 && cancelled === 0;
  if (highSurgeFinisher) return Object.freeze({ branch: "high-surge-finisher", units: releaseValue / 4, qualifies: true });
  if (b2bBridge) return Object.freeze({ branch: "ren-quad-tsd-b2b-bridge", units: renCombatGain / 4, qualifies: true });
  if (setupBridge) return Object.freeze({ branch: "mini-to-tsd-b2b-bridge", units: 1.25, qualifies: true });
  if (highOrDefensive) return Object.freeze({ branch: "high-or-defensive-ren", units: Math.max(0, renCombatGain) / 4, qualifies: renCombatGain > 0 });
  if (lowValue) return Object.freeze({ branch: "unconverted-low-value-ren", units: -0.6, qualifies: true });
  return Object.freeze({ branch: "other", units: 0, qualifies: false });
}
