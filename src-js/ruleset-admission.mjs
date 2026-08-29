import { canonicalize } from "./cs1-core.mjs";
import { sha256Hex } from "./sha256.mjs";
import {
  HEADLESS_ARENA_LOCKOUT_POLICY,
  HEADLESS_ARENA_TERMINAL_POLICY,
} from "./arena-terminal.mjs";
import S2_OBSERVED_MANIFEST from "../rulesets/tetrio-s2-v19-beta-1-5-0-observed.json" with { type: "json" };

const EXPECTED_NORMALIZED_HASH = "sha256:2c47b3df945f6714449b92d1b44346ef4bf0e1a20e95be8ed10c28be75c66a60";
const EXPECTED_RULESET_ID = "tetrio-s2-v19-2c47b3df945f6714449b92d1b44346ef4bf0e1a20e95be8ed10c28be75c66a60-beta-1-5-0";

// This catalog is deliberately independent of optionRegistry.semanticAdmission.
// The manifest is evidence supplied to the gate, not authority that may weaken
// the gate by changing its own counts or deleting an unsupported option.
const INTERPRETED = Object.freeze([
  "allclear_b2b",
  "allclear_garbage",
  "allow180",
  "b2bchaining",
  "b2bcharge_at",
  "b2bcharge_base",
  "b2bcharging",
  "combotable",
  "garbagecap",
  "garbagecapincrease",
  "garbagecapmargin",
  "garbageholesize",
  "garbageincrease",
  "garbagemargin",
  "garbagemultiplier",
  "garbagespecialbonus",
  "garbagespeed",
  "garbagetargetbonus",
  "kickset",
  "messiness_center",
  "messiness_change",
  "messiness_inner",
  "messiness_nosame",
  "messiness_timeout",
  "openerphase",
  "roundmode",
  "spinbonuses",
  "usebombs",
]);

const HARDCODED_COMPATIBLE = Object.freeze({
  allclears: true,
  allclear_b2b_sends: true,
  garbageblocking: "combo blocking",
});

const MOVEMENT_GUARDS = Object.freeze([
  "g",
  "gincrease",
  "gmargin",
  "gravitymay20g",
  "infinite_movement",
  "lockresets",
  "locktime",
]);

const TRANSITION_GUARDS = Object.freeze([
  "boardbuffer",
  "boardheight",
  "boardwidth",
  "clutch",
  "topoutisclear",
]);

const GUARD_ONLY = Object.freeze([...MOVEMENT_GUARDS, ...TRANSITION_GUARDS].sort());
const EXPECTED_OPTIONS = S2_OBSERVED_MANIFEST.normalizedOptions;
const EXPECTED_KEYS = Object.freeze(Object.keys(EXPECTED_OPTIONS).sort());
const EXPLICIT_KEYS = new Set([
  ...INTERPRETED,
  ...Object.keys(HARDCODED_COMPATIBLE),
  ...GUARD_ONLY,
]);
const INACTIVE = Object.freeze(EXPECTED_KEYS.filter((key) => !EXPLICIT_KEYS.has(key)));

const MOVEMENT_OPERATIONS = new Set([
  "analyzeBest",
  "analyzeTopN",
  "analyzeSequence",
  "evaluatePlayedMove",
]);
const OPERATIONS = new Set(["evaluatePosition", ...MOVEMENT_OPERATIONS]);

export const DEPTH_ONE_MOVEMENT_CAPABILITY =
  "engine-frame-single-held-controller/4-depth1";
export const HEADLESS_ARENA_CAPABILITY =
  "engine-frame-single-held-controller/4-exact-lock-arena/1";
export const HEADLESS_ARENA_RUNTIME_CAPABILITY = Object.freeze({
  movementModel: HEADLESS_ARENA_CAPABILITY,
  exactLockCadence: true,
  spawnRuntime: "pinned-triangle-engine",
  topOutMapping: "spawn-blockout-loss",
  terminalPolicy: HEADLESS_ARENA_TERMINAL_POLICY,
  topOutOptionValue: false,
  noLockOutOptionValue: true,
  lockoutPolicy: HEADLESS_ARENA_LOCKOUT_POLICY,
});

const EXPECTED_COUNTS = Object.freeze({
  interpreted: 28,
  hardcodedCompatible: 3,
  valueInactiveOrOperationIrrelevant: 119,
  guardOnly: 12,
});

export const RULESET_ADMISSION_CLASSES = Object.freeze({
  interpreted: INTERPRETED,
  hardcodedCompatible: HARDCODED_COMPATIBLE,
  valueInactiveOrOperationIrrelevant: INACTIVE,
  guardOnly: Object.freeze({
    movement: MOVEMENT_GUARDS,
    transition: TRANSITION_GUARDS,
  }),
  counts: EXPECTED_COUNTS,
});

/**
 * Validate the observed S2 ruleset and decide whether one S-API operation may
 * run. The function has no I/O and never mutates the supplied manifest.
 *
 * `valid` means the option block and its semantic-admission declaration match
 * the target profile. `admitted` additionally requires every guard relevant to
 * the operation to have an implementation. At present no guard is interpreted,
 * so the observed target is intentionally unsupported with closed reason codes.
 */
export function evaluateRulesetAdmission(manifest, operation, capability = null) {
  const issues = [];
  if (!OPERATIONS.has(operation)) {
    issues.push(issue("unknown-operation", null, `unknown operation ${String(operation)}`));
  }

  if (!isPlainObject(manifest)) {
    issues.push(issue("invalid-manifest", null, "manifest must be an object"));
    return admissionResult(operation, issues, [], []);
  }

  const options = manifest.normalizedOptions;
  if (!isPlainObject(options)) {
    issues.push(issue("invalid-options", null, "normalizedOptions must be an object"));
    validateSemanticDeclaration(manifest, issues);
    return admissionResult(operation, issues, [], []);
  }

  const actualKeys = Object.keys(options).sort();
  const actualHash = `sha256:${sha256Hex(canonicalize(options))}`;
  if (
    manifest.normalizedOptionsHash !== EXPECTED_NORMALIZED_HASH ||
    actualHash !== EXPECTED_NORMALIZED_HASH ||
    manifest.id !== EXPECTED_RULESET_ID
  ) {
    issues.push(issue(
      "ruleset-identity-mismatch",
      null,
      "ruleset id, declared hash, and canonical option bytes must match the admitted S2 target",
    ));
  }
  for (const key of actualKeys) {
    if (!Object.hasOwn(EXPECTED_OPTIONS, key)) {
      issues.push(issue("unknown-option", key, `unknown normalized option ${key}`));
    }
  }
  for (const key of EXPECTED_KEYS) {
    if (!Object.hasOwn(options, key)) {
      issues.push(issue("missing-option", key, `missing normalized option ${key}`));
      continue;
    }
    const expected = EXPECTED_OPTIONS[key];
    const actual = options[key];
    const expectedType = jsonType(expected);
    const actualType = jsonType(actual);
    if (actualType !== expectedType || !validJsonValue(actual)) {
      issues.push(issue(
        "option-type-mismatch",
        key,
        `${key} must have JSON type ${expectedType}; received ${actualType}`,
      ));
      continue;
    }

    // The current runtime profile is compiled from this exact canonical option
    // block. Accepting a different same-typed value would silently execute the
    // old rules under a new identity. Each class gets a distinct diagnostic so
    // an implementation can deliberately widen only the corresponding gate.
    if (!jsonEqual(actual, expected)) {
      if (Object.hasOwn(HARDCODED_COMPATIBLE, key)) {
        issues.push(issue(
          "hardcoded-value-mismatch",
          key,
          `${key} is compatible only with ${JSON.stringify(HARDCODED_COMPATIBLE[key])}`,
        ));
      } else if (GUARD_ONLY.includes(key)) {
        issues.push(issue(
          "unaccepted-guard-value",
          key,
          `${key} has not been admitted with value ${JSON.stringify(actual)}`,
        ));
      } else if (INACTIVE.includes(key)) {
        issues.push(issue(
          "inactive-predicate-false",
          key,
          `${key} is inactive only at the observed target value`,
        ));
      } else {
        issues.push(issue(
          "interpreted-value-mismatch",
          key,
          `${key} differs from the compiled target profile`,
        ));
      }
    }
  }

  validateSemanticDeclaration(manifest, issues);
  const movement = MOVEMENT_OPERATIONS.has(operation) &&
    !implementsMovementGuards(operation, capability)
    ? [...MOVEMENT_GUARDS]
    : [];
  const transition = OPERATIONS.has(operation) ? [...TRANSITION_GUARDS] : [];
  return admissionResult(operation, issues, movement, transition);
}

/**
 * Narrow admission for the headless arena runtime. This does not promote the
 * manifest's general S-API qualification: it binds every guard-only value to
 * the pinned Triangle movement/spawn runtime and the arena's explicit top-out
 * terminal mapping at the observed target identity.
 */
export function evaluateHeadlessArenaRulesetAdmission(manifest, capability = null) {
  const base = evaluateRulesetAdmission(manifest, "analyzeBest", {
    movementModel: DEPTH_ONE_MOVEMENT_CAPABILITY,
    maxDepth: 1,
  });
  const capabilityValid = capability === HEADLESS_ARENA_RUNTIME_CAPABILITY;
  if (!base.valid || !capabilityValid) {
    return {
      ...base,
      operation: "runHeadlessArena",
      admitted: false,
      status: "unsupported",
      degraded: ["rule-option-guard-only"],
      unsupportedOptions: {
        movement: capabilityValid ? [] : [...MOVEMENT_GUARDS],
        transition: [...TRANSITION_GUARDS],
      },
    };
  }
  return {
    ...base,
    operation: "runHeadlessArena",
    admitted: true,
    status: "admitted",
    degraded: [],
    unsupportedOptions: { movement: [], transition: [] },
    guardBindings: {
      boardGeometry: ["boardbuffer", "boardheight", "boardwidth"],
      triangleSpawn: ["clutch"],
      triangleMovement: [...MOVEMENT_GUARDS],
      arenaTerminal: ["topoutisclear"],
    },
  };
}

function implementsMovementGuards(operation, capability) {
  return operation !== "analyzeSequence" &&
    isPlainObject(capability) &&
    capability.movementModel === DEPTH_ONE_MOVEMENT_CAPABILITY &&
    capability.maxDepth === 1;
}

function validateSemanticDeclaration(manifest, issues) {
  const declaration = manifest.optionRegistry?.semanticAdmission;
  if (!isPlainObject(declaration)) {
    issues.push(issue(
      "invalid-semantic-admission",
      null,
      "optionRegistry.semanticAdmission must be an object",
    ));
    return;
  }
  if (!jsonEqual(declaration.counts, EXPECTED_COUNTS)) {
    issues.push(issue(
      "semantic-count-mismatch",
      null,
      "semantic admission counts do not match the executable catalog",
    ));
  }
  if (!jsonEqual(declaration.hardcodedCompatible, HARDCODED_COMPATIBLE)) {
    issues.push(issue(
      "hardcoded-declaration-mismatch",
      null,
      "hardcodedCompatible does not match the executable catalog",
    ));
  }
  if (!sameStringSet(declaration.guardOnly, GUARD_ONLY)) {
    issues.push(issue(
      "guard-declaration-mismatch",
      null,
      "guardOnly does not match the executable catalog",
    ));
  }
}

function admissionResult(operation, issues, movement, transition) {
  const invalid = issues.length > 0;
  const degraded = [];
  // Structural or value errors are ruleset errors, never movement speculation.
  if (invalid || transition.length > 0) degraded.push("rule-option-guard-only");
  if (!invalid && movement.length > 0) degraded.unshift("movement-model-unavailable");
  return {
    operation,
    valid: !invalid,
    admitted: !invalid && degraded.length === 0,
    status: !invalid && degraded.length === 0 ? "admitted" : "unsupported",
    degraded,
    unsupportedOptions: {
      movement,
      transition,
    },
    issues,
    classificationCounts: { ...EXPECTED_COUNTS },
  };
}

function issue(code, option, message) {
  return { code, option, message };
}

function sameStringSet(actual, expected) {
  return Array.isArray(actual) &&
    actual.every((value) => typeof value === "string") &&
    actual.length === expected.length &&
    [...actual].sort().every((value, index) => value === expected[index]);
}

function jsonType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "object" ? "object" : typeof value;
}

function validJsonValue(value) {
  if (typeof value === "number") return Number.isFinite(value);
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (Array.isArray(value)) return value.every(validJsonValue);
  return isPlainObject(value) && Object.values(value).every(validJsonValue);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) &&
      left.length === right.length && left.every((value, index) => jsonEqual(value, right[index]));
  }
  if (!isPlainObject(left) || !isPlainObject(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length &&
    leftKeys.every((key, index) => key === rightKeys[index] && jsonEqual(left[key], right[key]));
}
