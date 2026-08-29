import { DEPTH1_BASELINE_MODEL } from "./evaluation.mjs";

export function createTuningModel(weightProfileId, weightOverrides = {}) {
  const profile = normalizeWeightProfile({ id: weightProfileId, weights: weightOverrides });
  return Object.freeze({
    ...DEPTH1_BASELINE_MODEL,
    id: `s2-depth1-linear-tuning/${profile.id}`,
    version: "experimental",
    modelSha256: null,
    weightsVersion: "experimental",
    weightsSha256: null,
    trainingCorpus: "development-placement-arena",
    weights: profile.weights,
  });
}

function normalizeWeightProfile(profile) {
  if (profile === null || typeof profile !== "object" || Array.isArray(profile)) {
    throw new Error("weight profile must be an object");
  }
  if (typeof profile.id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(profile.id)) {
    throw new Error("weight profile id must be filesystem-safe");
  }
  if (profile.weights === null || typeof profile.weights !== "object" || Array.isArray(profile.weights)) {
    throw new Error(`weight profile ${profile.id} weights must be an object`);
  }
  const baselineNames = new Set(Object.keys(DEPTH1_BASELINE_MODEL.weights));
  for (const [name, value] of Object.entries(profile.weights)) {
    if (!baselineNames.has(name)) throw new Error(`unknown evaluation weight ${name}`);
    if (!Number.isFinite(value)) throw new Error(`evaluation weight ${name} must be finite`);
  }
  return Object.freeze({
    id: profile.id,
    weights: Object.freeze({ ...DEPTH1_BASELINE_MODEL.weights, ...profile.weights }),
  });
}
