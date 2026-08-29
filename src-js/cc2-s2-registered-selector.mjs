import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import {
  CC2_S2_FAMILY_SCREEN_REGISTRY,
  getCc2S2FamilyScreenDefinition,
} from "./cc2-s2-family-screen-registry.mjs";

export const CC2_S2_REGISTERED_SELECTOR_BINDING_SCHEMA = "cc2-s2-registered-selector-binding/1";
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort((left, right) => left.localeCompare(right, "en"))
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function cc2S2RegisteredSelectorBindingSha256(value) {
  const projection = { schema: value?.schema, selector: value?.selector, runtime: value?.runtime };
  return `sha256:${createHash("sha256").update(canonical(projection)).digest("hex")}`;
}

function definitionFor(registry, selectorId) {
  if (registry === CC2_S2_FAMILY_SCREEN_REGISTRY) return getCc2S2FamilyScreenDefinition(selectorId);
  const definition = registry?.[selectorId];
  if (definition === undefined) throw new Error(`unknown registered selector ${selectorId}`);
  return definition;
}

function assertRuntimeBinding(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("registered selector runtime binding is required");
  }
  const keys = ["selectorOptions", "artifacts", "search", "telemetryBindings"];
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) {
    throw new Error(`registered selector runtime binding fields mismatch: ${[...missing, ...unknown].join(", ")}`);
  }
  const exactObject = (candidate, label, allowed) => {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`${label} must be an object`);
    }
    const invalid = [...allowed.filter((key) => !(key in candidate)),
      ...Object.keys(candidate).filter((key) => !allowed.includes(key))];
    if (invalid.length > 0) throw new Error(`${label} fields mismatch: ${invalid.join(", ")}`);
  };
  exactObject(value.selectorOptions, "registered selector options", [
    "candidateLimit", "rankPenalty", "adjustmentScale", "weightProfileId", "prefixPolicy",
  ]);
  const { candidateLimit, rankPenalty, adjustmentScale, weightProfileId, prefixPolicy } = value.selectorOptions;
  if (!Number.isSafeInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64 ||
      !Number.isSafeInteger(rankPenalty) || rankPenalty < 0 || rankPenalty > 100 ||
      !Number.isSafeInteger(adjustmentScale) || adjustmentScale < 0 || adjustmentScale > 100 ||
      typeof weightProfileId !== "string" || weightProfileId.length === 0 ||
      !["strict-complete-prefix", "allow-complete-returned-prefix"].includes(prefixPolicy)) {
    throw new Error("registered selector options are invalid");
  }
  exactObject(value.artifacts, "registered selector artifacts", [
    "binarySha256", "nativeConfigSha256", "weightConfigSha256",
  ]);
  if (Object.values(value.artifacts).some((digest) => typeof digest !== "string" || !SHA256.test(digest))) {
    throw new Error("registered selector artifact digest is invalid");
  }
  exactObject(value.search, "registered selector search", ["selectionLimit", "searchSeed"]);
  if (!Number.isSafeInteger(value.search.selectionLimit) || value.search.selectionLimit < 1 ||
      value.search.selectionLimit > 10_000_000 || !Number.isSafeInteger(value.search.searchSeed) ||
      value.search.searchSeed < 0 || value.search.searchSeed > 0xffff_ffff) {
    throw new Error("registered selector search binding is invalid");
  }
  if (!Array.isArray(value.telemetryBindings) || value.telemetryBindings.length === 0) {
    throw new Error("registered selector telemetry bindings are required");
  }
}

function selectorIdentity(definition) {
  return Object.freeze({
    id: definition.id,
    policy: definition.selectorPolicy,
    version: definition.selectorPolicyVersion,
    proposalOrder: definition.proposalOrder,
    contextPolicy: definition.contextPolicy,
    frozenBundleSpecSha256: definition.frozenBundleSpecSha256 ?? null,
  });
}

export function createCc2S2RegisteredSelectorBinding({
  selectorId,
  selectorOptions,
  artifacts,
  search,
  telemetryBindings = null,
  frozenBundleDefinition = null,
}, { registry = CC2_S2_FAMILY_SCREEN_REGISTRY } = {}) {
  let definition;
  if (frozenBundleDefinition !== null) {
    if (frozenBundleDefinition.id !== selectorId || frozenBundleDefinition.capabilities?.frozenBundle !== true) {
      throw new Error("frozen bundle definition does not match selectorId");
    }
    definition = frozenBundleDefinition;
  } else {
    definition = definitionFor(registry, selectorId);
  }
  if (definition.capabilities?.registeredSelector !== true || definition.proposalOrder !== "side-order" ||
      definition.contextPolicy !== "context-free") {
    throw new Error(`registered selector ${selectorId} is not context-free side-order capable`);
  }
  const defaultTelemetryBindings = definition.telemetryBindings ?? [{
    componentId: definition.component.id,
    familyId: definition.id,
    policy: definition.selectorPolicy,
    version: definition.selectorPolicyVersion,
    order: 0,
    diagnosticId: definition.diagnosticId,
  }];
  if (frozenBundleDefinition !== null) {
    for (const [label, supplied, expected] of [
      ["selector options", selectorOptions, definition.selectorOptions],
      ["artifacts", artifacts, definition.artifacts],
      ["search", search, definition.search],
      ["telemetry", telemetryBindings, defaultTelemetryBindings],
    ]) {
      if (supplied !== null && supplied !== undefined && !isDeepStrictEqual(supplied, expected)) {
        throw new Error(`frozen bundle ${label} cannot override the frozen spec`);
      }
    }
  } else if (telemetryBindings !== null && !isDeepStrictEqual(telemetryBindings, defaultTelemetryBindings)) {
    throw new Error("family selector telemetry must match the family registry");
  }
  const runtime = {
    selectorOptions: selectorOptions ?? definition.selectorOptions,
    artifacts: artifacts ?? definition.artifacts,
    search: search ?? definition.search,
    telemetryBindings: telemetryBindings ?? defaultTelemetryBindings,
  };
  assertRuntimeBinding(runtime);
  if (Object.values(runtime).some((value) => value === undefined || value === null)) {
    throw new Error("registered selector binding must include selector options, artifacts, search, and telemetry");
  }
  const binding = {
    schema: CC2_S2_REGISTERED_SELECTOR_BINDING_SCHEMA,
    selector: selectorIdentity(definition),
    runtime,
  };
  return deepFreeze({ ...binding, bindingSha256: cc2S2RegisteredSelectorBindingSha256(binding) });
}

export function createCc2S2RegisteredSelectorAdapter({
  binding,
  runtimeBinding,
  frozenBundleDefinition = null,
}, { registry = CC2_S2_FAMILY_SCREEN_REGISTRY } = {}) {
  if (binding?.schema !== CC2_S2_REGISTERED_SELECTOR_BINDING_SCHEMA) {
    throw new Error(`registered selector binding schema must be ${CC2_S2_REGISTERED_SELECTOR_BINDING_SCHEMA}`);
  }
  if (binding === null || typeof binding !== "object" || Array.isArray(binding) ||
      !isDeepStrictEqual(Object.keys(binding).sort(), ["bindingSha256", "runtime", "schema", "selector"]) ||
      binding.bindingSha256 !== cc2S2RegisteredSelectorBindingSha256(binding)) {
    throw new Error("registered selector binding SHA-256 mismatch");
  }
  assertRuntimeBinding(runtimeBinding);
  if (!isDeepStrictEqual(binding.runtime, runtimeBinding)) {
    throw new Error("registered selector runtime does not exactly match frozen binding");
  }
  let definition;
  if (binding.selector.frozenBundleSpecSha256 !== null) {
    if (frozenBundleDefinition === null) throw new Error("frozen bundle selector implementation is required; fallback is forbidden");
    definition = frozenBundleDefinition;
  } else {
    if (frozenBundleDefinition !== null) throw new Error("unexpected frozen bundle implementation for family selector");
    definition = definitionFor(registry, binding.selector.id);
  }
  if (!isDeepStrictEqual(binding.selector, selectorIdentity(definition))) {
    throw new Error("registered selector identity does not match registry definition");
  }
  if (definition.capabilities?.registeredSelector !== true || definition.proposalOrder !== "side-order" ||
      definition.contextPolicy !== "context-free") {
    throw new Error("registered selector requires unsupported proposal context");
  }
  const frozenOptions = binding.runtime.selectorOptions;
  const allowCompleteReturnedPrefix = frozenOptions.prefixPolicy === "allow-complete-returned-prefix";
  return Object.freeze({
    binding,
    definition,
    select(guiState, moves, { weights = {}, verificationMemo = null } = {}) {
      return definition.selector(guiState, moves, {
        candidateLimit: frozenOptions.candidateLimit,
        rankPenalty: frozenOptions.rankPenalty,
        adjustmentScale: frozenOptions.adjustmentScale,
        weightProfileId: frozenOptions.weightProfileId,
        allowCompleteReturnedPrefix,
        comparisonSource: definition.selectorPolicy,
        weights,
        verificationMemo,
      });
    },
  });
}
