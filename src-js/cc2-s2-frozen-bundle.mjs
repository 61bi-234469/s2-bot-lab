import { createHash } from "node:crypto";

import {
  CC2_S2_FAMILY_SCREEN_REGISTRY,
  getCc2S2FamilyScreenDefinition,
} from "./cc2-s2-family-screen-registry.mjs";

export const CC2_S2_FROZEN_BUNDLE_SPEC_SCHEMA = "cc2-s2-frozen-bundle-spec/1";
export const CC2_S2_FROZEN_BUNDLE_BASE_FAMILY = "F12";
export const CC2_S2_FROZEN_BUNDLE_CONFLICT_POLICY = "reject-conflict";
export const CC2_S2_FROZEN_BUNDLE_TIE_BREAK =
  "declared-component-order-then-cc2-rank-then-canonical-identity";
export const CC2_S2_FROZEN_BUNDLE_FALLBACK_POLICY = "forbid";

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const COMPONENT_SEMANTICS = new Set(["additive", "exclusive", "guard", "rescue"]);
const PREFIX_POLICIES = new Set(["strict-complete-prefix", "allow-complete-returned-prefix"]);

function object(value, label, keys) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(", ")}`);
  return value;
}

function string(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} is required`);
  return value;
}

function integer(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function sha256(value, label) {
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error(`${label} must be a sha256: digest`);
  return value;
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function definitionFor(registry, familyId) {
  if (registry === CC2_S2_FAMILY_SCREEN_REGISTRY) return getCc2S2FamilyScreenDefinition(familyId);
  const definition = registry?.[familyId];
  if (definition === undefined) throw new Error(`unknown family ${familyId}`);
  return definition;
}

function assertComponentBinding(binding, label, expectedOrder, registry, { base = false } = {}) {
  object(binding, label, ["componentId", "familyId", "policy", "version", "order", ...(base ? [] : ["semantics"])]);
  string(binding.componentId, `${label}.componentId`);
  string(binding.familyId, `${label}.familyId`);
  string(binding.policy, `${label}.policy`);
  integer(binding.version, `${label}.version`, 1, 1_000_000);
  if (binding.order !== expectedOrder) throw new Error(`${label}.order must equal ${expectedOrder}`);
  const definition = definitionFor(registry, binding.familyId);
  if (binding.policy !== definition.selectorPolicy || binding.version !== definition.selectorPolicyVersion) {
    throw new Error(`${label} policy/version does not match family registry`);
  }
  if (binding.familyId !== CC2_S2_FROZEN_BUNDLE_BASE_FAMILY && !definition.capabilities?.frozenBundleMvpComponent) {
    throw new Error(`${label} is not a context-free side-order MVP component`);
  }
  if (definition.proposalOrder !== "side-order" || definition.contextPolicy !== "context-free") {
    throw new Error(`${label} requires unsupported proposal context`);
  }
  if (!base && !COMPONENT_SEMANTICS.has(binding.semantics)) {
    throw new Error(`${label}.semantics is unsupported`);
  }
  return definition;
}

function assertTelemetryBindings(value, base, components, registry) {
  if (!Array.isArray(value) || value.length !== components.length + 1) {
    throw new Error("frozen bundle telemetryBindings must bind base and every component");
  }
  const expected = [base, ...components];
  value.forEach((binding, index) => {
    object(binding, `telemetryBindings[${index}]`, ["componentId", "familyId", "policy", "version", "order", "diagnosticId"]);
    const component = expected[index];
    const definition = definitionFor(registry, component.familyId);
    for (const key of ["componentId", "familyId", "policy", "version", "order"]) {
      if (binding[key] !== component[key]) throw new Error(`telemetryBindings[${index}].${key} does not match component`);
    }
    if (binding.diagnosticId !== definition.diagnosticId) {
      throw new Error(`telemetryBindings[${index}].diagnosticId does not match family registry`);
    }
  });
}

export function loadCc2S2FrozenBundleSpec(bytes, { registry = CC2_S2_FAMILY_SCREEN_REGISTRY } = {}) {
  if (!(typeof bytes === "string" || Buffer.isBuffer(bytes)) || bytes.length === 0) {
    throw new Error("frozen bundle spec bytes are required");
  }
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
  const spec = JSON.parse(text);
  object(spec, "frozen bundle spec", [
    "schema", "bundleId", "bundlePolicy", "bundleVersion", "base", "components", "composition",
    "selectorOptions", "artifacts", "search", "telemetryBindings",
  ]);
  if (spec.schema !== CC2_S2_FROZEN_BUNDLE_SPEC_SCHEMA) {
    throw new Error(`frozen bundle spec schema must be ${CC2_S2_FROZEN_BUNDLE_SPEC_SCHEMA}`);
  }
  string(spec.bundleId, "frozen bundle spec bundleId");
  string(spec.bundlePolicy, "frozen bundle spec bundlePolicy");
  integer(spec.bundleVersion, "frozen bundle spec bundleVersion", 1, 1_000_000);
  if (!spec.bundlePolicy.endsWith(`/${spec.bundleVersion}`)) {
    throw new Error("frozen bundle policy must end with bundleVersion");
  }

  const baseDefinition = assertComponentBinding(spec.base, "frozen bundle base", 0, registry, { base: true });
  if (spec.base.familyId !== CC2_S2_FROZEN_BUNDLE_BASE_FAMILY ||
      spec.base.componentId !== CC2_S2_FROZEN_BUNDLE_BASE_FAMILY) {
    throw new Error("frozen bundle base must be F12");
  }
  if (!Array.isArray(spec.components) || spec.components.length < 2 || spec.components.length > 3) {
    throw new Error("frozen bundle must contain exactly 2 or 3 components");
  }
  const componentIds = new Set([spec.base.componentId]);
  const familyIds = new Set([spec.base.familyId]);
  const definitions = spec.components.map((component, index) => {
    const definition = assertComponentBinding(component, `frozen bundle component ${index}`, index + 1, registry);
    if (componentIds.has(component.componentId)) throw new Error("frozen bundle component IDs must be unique");
    if (familyIds.has(component.familyId)) throw new Error("frozen bundle component families must be unique and exclude F12");
    componentIds.add(component.componentId);
    familyIds.add(component.familyId);
    return definition;
  });

  object(spec.composition, "frozen bundle composition", ["conflict", "tieBreak", "fallback"]);
  if (spec.composition.conflict !== CC2_S2_FROZEN_BUNDLE_CONFLICT_POLICY) {
    throw new Error(`frozen bundle conflict policy must be ${CC2_S2_FROZEN_BUNDLE_CONFLICT_POLICY}`);
  }
  if (spec.composition.tieBreak !== CC2_S2_FROZEN_BUNDLE_TIE_BREAK) {
    throw new Error(`frozen bundle tie break must be ${CC2_S2_FROZEN_BUNDLE_TIE_BREAK}`);
  }
  if (spec.composition.fallback !== CC2_S2_FROZEN_BUNDLE_FALLBACK_POLICY) {
    throw new Error("frozen bundle fallback is forbidden");
  }

  object(spec.selectorOptions, "frozen bundle selectorOptions", [
    "candidateLimit", "rankPenalty", "adjustmentScale", "weightProfileId", "prefixPolicy",
  ]);
  integer(spec.selectorOptions.candidateLimit, "selectorOptions.candidateLimit", 1, 64);
  integer(spec.selectorOptions.rankPenalty, "selectorOptions.rankPenalty", 0, 100);
  integer(spec.selectorOptions.adjustmentScale, "selectorOptions.adjustmentScale", 0, 100);
  string(spec.selectorOptions.weightProfileId, "selectorOptions.weightProfileId");
  if (!PREFIX_POLICIES.has(spec.selectorOptions.prefixPolicy)) {
    throw new Error("selectorOptions.prefixPolicy is unsupported");
  }

  object(spec.artifacts, "frozen bundle artifacts", ["binarySha256", "nativeConfigSha256", "weightConfigSha256"]);
  for (const key of ["binarySha256", "nativeConfigSha256", "weightConfigSha256"]) {
    sha256(spec.artifacts[key], `artifacts.${key}`);
  }
  object(spec.search, "frozen bundle search", ["selectionLimit", "searchSeed"]);
  integer(spec.search.selectionLimit, "search.selectionLimit", 1, 10_000_000);
  integer(spec.search.searchSeed, "search.searchSeed", 0, 0xffff_ffff);
  assertTelemetryBindings(spec.telemetryBindings, spec.base, spec.components, registry);

  const rawSha256 = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  return deepFreeze({ ...spec, rawSha256, definitions: { base: baseDefinition, components: definitions } });
}

export function createCc2S2FrozenBundleSpec({
  bundleId,
  bundlePolicy,
  bundleVersion,
  components,
  composition = {},
  selectorOptions,
  artifacts,
  search,
}, { registry = CC2_S2_FAMILY_SCREEN_REGISTRY } = {}) {
  if (!Array.isArray(components)) throw new Error("frozen bundle components are required");
  const base = definitionFor(registry, CC2_S2_FROZEN_BUNDLE_BASE_FAMILY);
  const bind = (definition, componentId, order, semantics = undefined) => ({
    componentId,
    familyId: definition.id,
    policy: definition.selectorPolicy,
    version: definition.selectorPolicyVersion,
    order,
    ...(semantics === undefined ? {} : { semantics }),
  });
  const baseBinding = bind(base, CC2_S2_FROZEN_BUNDLE_BASE_FAMILY, 0);
  const componentBindings = components.map((component, index) => {
    object(component, `component declaration ${index}`, ["componentId", "familyId", "semantics"]);
    return bind(definitionFor(registry, component.familyId), component.componentId, index + 1, component.semantics);
  });
  const allBindings = [baseBinding, ...componentBindings];
  const spec = {
    schema: CC2_S2_FROZEN_BUNDLE_SPEC_SCHEMA,
    bundleId,
    bundlePolicy,
    bundleVersion,
    base: baseBinding,
    components: componentBindings,
    composition: {
      conflict: composition.conflict ?? CC2_S2_FROZEN_BUNDLE_CONFLICT_POLICY,
      tieBreak: composition.tieBreak ?? CC2_S2_FROZEN_BUNDLE_TIE_BREAK,
      fallback: composition.fallback ?? CC2_S2_FROZEN_BUNDLE_FALLBACK_POLICY,
    },
    selectorOptions,
    artifacts,
    search,
    telemetryBindings: allBindings.map(({ componentId, familyId, policy, version, order }) => ({
      componentId,
      familyId,
      policy,
      version,
      order,
      diagnosticId: definitionFor(registry, familyId).diagnosticId,
    })),
  };
  const bytes = `${JSON.stringify(spec, null, 2)}\n`;
  return Object.freeze({ bytes, spec: loadCc2S2FrozenBundleSpec(bytes, { registry }) });
}

export function createCc2S2FrozenBundleDefinition(spec, implementation) {
  if (spec?.schema !== CC2_S2_FROZEN_BUNDLE_SPEC_SCHEMA || typeof spec.rawSha256 !== "string") {
    throw new Error("a validated frozen bundle spec is required");
  }
  object(implementation, "frozen bundle implementation", ["selector", "policy", "version", "specSha256"]);
  if (typeof implementation.selector !== "function") throw new Error("frozen bundle implementation selector is required");
  if (implementation.policy !== spec.bundlePolicy || implementation.version !== spec.bundleVersion ||
      implementation.specSha256 !== spec.rawSha256) {
    throw new Error("frozen bundle implementation binding does not match frozen spec");
  }
  return Object.freeze({
    id: spec.bundleId,
    selector: implementation.selector,
    selectorPolicy: spec.bundlePolicy,
    selectorPolicyVersion: spec.bundleVersion,
    proposalOrder: "side-order",
    contextPolicy: "context-free",
    capabilities: Object.freeze({
      proposalOrder: "side-order",
      contextPolicy: "context-free",
      registeredSelector: true,
      frozenBundle: true,
    }),
    frozenBundleSpecSha256: spec.rawSha256,
    selectorOptions: spec.selectorOptions,
    artifacts: spec.artifacts,
    search: spec.search,
    telemetryBindings: spec.telemetryBindings,
  });
}
