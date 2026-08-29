import { fullStateKey } from "./state-keys.mjs";
import { applyTransition, TRANSITION_KINDS } from "./transition.mjs";

export const CANONICAL_TRANSITION_REQUEST_SCHEMA =
  "s2-analysis-engine/schema/canonical-transition-request/1";
export const CANONICAL_TRANSITION_RESPONSE_SCHEMA =
  "s2-analysis-engine/schema/canonical-transition-response/1";

/**
 * Stable final-placement boundary for browser/fumen consumers.
 *
 * This deliberately does not accept a bot spin label. A placement without
 * rotationEvidence is normalized to an explicit non-rotation lock, so the S2
 * Simulator returns `spin: "none"` and the response declares the lost input
 * evidence. A positive spin therefore only comes from S2 rotation/kick
 * evidence, never from CC2 metadata.
 */
export function invokeCanonicalTransition(request) {
  validateEnvelope(request);
  const state = structuredClone(request.state);
  const { action, degraded, warnings } = normalizeAction(request.action);
  const positionFingerprint = fullStateKey(state);
  const transition = applyTransition(state, action, state.rulesetId);
  const legal = transition.legality.legal && transition.nextState !== null;

  return {
    $schema: CANONICAL_TRANSITION_RESPONSE_SCHEMA,
    apiVersion: 1,
    schemaVersion: 1,
    positionFingerprint,
    rulesetId: state.rulesetId,
    status: legal ? (degraded.length === 0 ? "ok" : "degraded") : "illegal",
    degraded,
    warnings,
    transition,
  };
}

/** HTTP-neutral adapter used by the local GUI server and its route tests. */
export function canonicalTransitionHttpResponse(request) {
  try {
    return { statusCode: 200, body: invokeCanonicalTransition(request) };
  } catch (error) {
    return {
      statusCode: 400,
      body: { error: error instanceof Error ? error.message : String(error) },
    };
  }
}

function validateEnvelope(request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    throw new Error("canonical transition request must be an object");
  }
  assertExactKeys(request, ["$schema", "apiVersion", "schemaVersion", "state", "action"], "request");
  if (request.$schema !== CANONICAL_TRANSITION_REQUEST_SCHEMA) {
    throw new Error("unsupported canonical transition request schema");
  }
  if (request.apiVersion !== 1 || request.schemaVersion !== 1) {
    throw new Error("unsupported canonical transition API version");
  }
  if (request.state?.$schema !== "s2-analysis-engine/schema/canonical-state/1" ||
      request.state?.schemaVersion !== 1) {
    throw new Error("state must be S-STATE/1");
  }
  if (request.action === null || typeof request.action !== "object" || Array.isArray(request.action)) {
    throw new Error("canonical transition action must be an object");
  }
  if (!TRANSITION_KINDS.includes(request.action.kind)) {
    throw new Error(`unsupported action kind ${request.action.kind}`);
  }
}

function normalizeAction(source) {
  if (source.kind === "garbage-receive") {
    assertExactKeys(source, ["kind", "packet"], "garbage-receive action");
    assertPacket(source.packet);
    return exactAction(source);
  }
  if (source.kind === "garbage-confirm") {
    assertExactKeys(
      source,
      ["kind", "packetId", "sourceGameId", "arrivalFrame"],
      "garbage-confirm action",
    );
    return exactAction(source);
  }
  if (source.kind === "tick") {
    assertExactKeys(source, ["kind", "fromFrame", "toFrame"], "tick action");
    return exactAction(source);
  }
  assertExactKeys(source, ["kind", "placement"], "placement action");
  const placement = source.placement;
  if (placement === null || typeof placement !== "object" || Array.isArray(placement)) {
    throw new Error("placement action requires a placement object");
  }
  const allowed = ["piece", "rotation", "x", "y", "usedHold", "rotationEvidence"];
  for (const key of ["piece", "rotation", "x", "y", "usedHold"]) {
    if (!(key in placement)) throw new Error(`placement is missing ${key}`);
  }
  for (const key of Object.keys(placement)) {
    if (!allowed.includes(key)) throw new Error(`placement has unsupported property ${key}`);
  }
  if (placement.rotationEvidence !== undefined) {
    return { action: structuredClone(source), degraded: [], warnings: [] };
  }
  return {
    action: {
      kind: "placement",
      placement: {
        ...structuredClone(placement),
        rotationEvidence: { lastInputWasRotation: false, kickIndex: null },
      },
    },
    degraded: ["spin-evidence-unavailable"],
    warnings: [
      "rotationEvidence was omitted; the S2 Simulator evaluated this lock as non-spin",
    ],
  };
}

function exactAction(source) {
  return { action: structuredClone(source), degraded: [], warnings: [] };
}

function assertPacket(packet) {
  if (packet === null || typeof packet !== "object" || Array.isArray(packet)) {
    throw new Error("garbage-receive action requires a packet object");
  }
  assertExactKeys(packet, [
    "packetId",
    "sourceGameId",
    "amount",
    "holeSize",
    "arrivalFrame",
    "confirmed",
    "order",
  ], "garbage packet");
}

function assertExactKeys(value, expected, label) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} properties must be exactly: ${expected.join(", ")}`);
  }
}
