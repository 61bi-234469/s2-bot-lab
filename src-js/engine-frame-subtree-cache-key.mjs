import { createHash } from "node:crypto";

import { canonicalize } from "./cs1-core.mjs";

export const ENGINE_FRAME_SUBTREE_CACHE_KEY = "s2-engine-frame-subtree/1";

const CONTROLLER_OPTION_KEYS = Object.freeze([
  "captureContinuations",
  "maxHeldEdges",
  "maxIdleFrames",
  "maxInputFrames",
  "maxNodes",
  "maxSnapshotBytes",
  "width",
]);

const REMAINING_BUDGET_KEYS = Object.freeze([
  "memoryBytes",
  "nodes",
  "timeMs",
]);

/**
 * Create a deterministic key for a completed engine-frame continuation
 * subtree. Callers prepare `stateKey` with fullStateKey() and prepare the
 * continuation identity with the controller that owns the snapshot.
 *
 * Remaining budgets are deliberately part of the identity. A subtree that
 * completed with a larger remaining budget must not make a smaller-budget run
 * appear to have completed work it could not have entered. `null` is the only
 * representation of an unbounded budget; Infinity is rejected before CS/1.
 */
export function engineFrameSubtreeCacheKey({
  stateKey,
  continuationIdentity,
  controller,
  controllerOptions,
  remainingDepth,
  remainingBudgets,
}) {
  controllerOptions = { width: null, ...controllerOptions };
  assertDigest(stateKey, "s2-full-state/1:sha256:", "prepared full state key");
  assertDigest(continuationIdentity, "sha256:", "continuation identity");
  if (typeof controller !== "string" || controller.length === 0) {
    throw new Error("engine-frame subtree cache key requires a controller id");
  }
  if (!Number.isSafeInteger(remainingDepth) || remainingDepth < 1) {
    throw new Error("remainingDepth must be a positive safe integer");
  }
  assertExactKeys(controllerOptions, CONTROLLER_OPTION_KEYS, "controllerOptions");
  if (controllerOptions.captureContinuations !== true) {
    throw new Error("engine-frame subtree caching requires continuation capture");
  }
  for (const key of ["maxHeldEdges", "maxIdleFrames", "maxInputFrames"]) {
    assertNonNegativeSafeInteger(controllerOptions[key], `controllerOptions.${key}`);
  }
  for (const key of ["maxNodes", "maxSnapshotBytes"]) {
    assertPositiveSafeInteger(controllerOptions[key], `controllerOptions.${key}`);
  }
  if (controllerOptions.width !== null) {
    assertPositiveSafeInteger(controllerOptions.width, "controllerOptions.width");
  }

  assertExactKeys(remainingBudgets, REMAINING_BUDGET_KEYS, "remainingBudgets");
  assertNullableNonNegativeSafeInteger(remainingBudgets.nodes, "remainingBudgets.nodes");
  assertNullableNonNegativeSafeInteger(
    remainingBudgets.memoryBytes,
    "remainingBudgets.memoryBytes",
  );
  if (
    remainingBudgets.timeMs !== null &&
    (!Number.isFinite(remainingBudgets.timeMs) || remainingBudgets.timeMs < 0)
  ) {
    throw new Error("remainingBudgets.timeMs must be a finite non-negative number or null");
  }

  const payload = {
    controller,
    controllerOptions: Object.fromEntries(
      CONTROLLER_OPTION_KEYS.map((key) => [key, controllerOptions[key]]),
    ),
    continuationIdentity,
    remainingBudgets: Object.fromEntries(
      REMAINING_BUDGET_KEYS.map((key) => [key, remainingBudgets[key]]),
    ),
    remainingDepth,
    stateKey,
  };
  const digest = createHash("sha256").update(canonicalize(payload)).digest("hex");
  return `${ENGINE_FRAME_SUBTREE_CACHE_KEY}:sha256:${digest}`;
}

function assertDigest(value, prefix, label) {
  const pattern = new RegExp(`^${escapeRegex(prefix)}[0-9a-f]{64}$`);
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} must be a canonical SHA-256 identity`);
  }
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  if (
    actual.length !== expected.length ||
    actual.some((key, index) => key !== expected[index])
  ) {
    throw new Error(`${label} must contain exactly ${expected.join(",")}`);
  }
}

function assertPositiveSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
}

function assertNullableNonNegativeSafeInteger(value, label) {
  if (value !== null) assertNonNegativeSafeInteger(value, label);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
