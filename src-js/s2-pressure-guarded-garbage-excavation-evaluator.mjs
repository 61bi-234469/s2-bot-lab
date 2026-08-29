export const S2_PRESSURE_GUARDED_GARBAGE_EXCAVATION_EVALUATOR_ID =
  "s2-pressure-guarded-garbage-excavation-evaluator/1";
export const S2_PRESSURE_GUARDED_GARBAGE_EXCAVATION_POLICY =
  "f8-excavation-unless-negative-f9-pressure/1";

export function combineS2PressureGuardedGarbageExcavation(excavation, pressure) {
  if (!Number.isFinite(excavation?.units) || !Number.isFinite(pressure?.units)) {
    throw new Error("pressure-guarded excavation requires finite F8 and F9 units");
  }
  const opponentPressureVeto = excavation.units !== 0 && pressure.units < 0;
  return Object.freeze({
    excavation,
    pressure,
    rawExcavationUnits: excavation.units,
    opponentPressureUnits: pressure.units,
    opponentPressureVeto,
    cooccursWithNonzeroPressure: excavation.units !== 0 && pressure.units !== 0,
    qualifies: excavation.units !== 0 && !opponentPressureVeto,
    units: opponentPressureVeto ? 0 : excavation.units,
    evaluator: Object.freeze({
      id: S2_PRESSURE_GUARDED_GARBAGE_EXCAVATION_EVALUATOR_ID,
      policy: S2_PRESSURE_GUARDED_GARBAGE_EXCAVATION_POLICY,
      direction: "higher-is-better",
    }),
  });
}
