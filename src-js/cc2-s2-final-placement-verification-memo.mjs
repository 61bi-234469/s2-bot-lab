import { canonicalize } from "./cs1-core.mjs";
import {
  applyCc2FinalPlacementUnderObservedS2,
  createCc2SpinWitnessIndex,
  guiStateToCanonical,
} from "./cc2-s2-adapter.mjs";
import { fullStateKey } from "./state-keys.mjs";

/**
 * Creates a verification cache whose lifetime is one game lock.
 *
 * Cached values contain only the physical Simulator result. Caller-specific
 * comparison identities are removed before storage and stamped back onto a
 * fresh clone on every read. This lets tolerant control and strict family
 * selectors share the expensive witness/transition work without merging
 * their reporting semantics.
 */
export function createCc2S2LockFinalPlacementVerificationMemo() {
  const entries = new Map();
  const witnessIndexes = new Map();
  let hits = 0;
  let misses = 0;
  let stores = 0;

  return Object.freeze({
    verify(guiState, move, { engineId, comparisonSource }) {
      if (typeof engineId !== "string" || engineId.length === 0 ||
          typeof comparisonSource !== "string" || comparisonSource.length === 0) {
        throw new Error("final-placement verification memo requires comparison identities");
      }
      const state = guiStateToCanonical(guiState);
      const stateKey = fullStateKey(state);
      const key = `${stateKey}|${canonicalize(move)}`;
      let entry = entries.get(key);
      if (entry === undefined) {
        misses += 1;
        try {
          let spinWitnessIndex = witnessIndexes.get(stateKey);
          if (spinWitnessIndex === undefined) {
            spinWitnessIndex = createCc2SpinWitnessIndex(guiState);
            witnessIndexes.set(stateKey, spinWitnessIndex);
          }
          const result = applyCc2FinalPlacementUnderObservedS2(guiState, move, {
            engineId: "physical-final-placement-verification",
            comparisonSource: "physical-final-placement-verification",
            spinWitnessIndex,
          });
          const physical = structuredClone(result);
          if (physical.comparison !== undefined) {
            delete physical.comparison.engineId;
            delete physical.comparison.source;
          }
          entry = { status: "fulfilled", value: physical };
        } catch (error) {
          entry = {
            status: "rejected",
            message: error instanceof Error ? error.message : String(error),
          };
        }
        entries.set(key, entry);
        stores += 1;
      } else {
        hits += 1;
      }
      if (entry.status === "rejected") throw new Error(entry.message);
      const result = structuredClone(entry.value);
      if (result.comparison !== undefined) {
        result.comparison = {
          source: comparisonSource,
          engineId,
          ...result.comparison,
        };
      }
      return result;
    },
    evidence() {
      return Object.freeze({ hits, misses, stores });
    },
  });
}

export function verifyCc2S2FinalPlacement(guiState, move, engine, verificationMemo = null) {
  if (verificationMemo === null || verificationMemo === undefined) {
    return applyCc2FinalPlacementUnderObservedS2(guiState, move, engine);
  }
  if (typeof verificationMemo.verify !== "function") {
    throw new Error("final-placement verificationMemo must expose verify()");
  }
  return verificationMemo.verify(guiState, move, engine);
}
