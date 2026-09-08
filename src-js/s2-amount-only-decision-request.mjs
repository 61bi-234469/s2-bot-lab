import { canonicalize } from "../scripts/cs1.mjs";
import { sha256Hex } from "./sha256.mjs";

export const S2_AMOUNT_ONLY_DECISION_STATE_ID = "s2-amount-only-decision-state/1";
export const S2_AMOUNT_ONLY_DECISION_REQUEST_ID = "s2-amount-only-decision-request/1";

const QUALIFIED_TYPES = new Set(["cc2-s2-f14", "cc2-s2-champion"]);

export function isAdr062QualifiedStaticType(type) {
  return QUALIFIED_TYPES.has(type);
}

export function assertS2AmountOnlyDecisionRequest(request) {
  assertExactKeys(request, ["decision", "engine", "id", "moves", "sessionKey", "type"], "amount-only decision request");
  if (request?.id !== S2_AMOUNT_ONLY_DECISION_REQUEST_ID) {
    throw new Error("invalid amount-only decision request");
  }
  if (!isAdr062QualifiedStaticType(request.type)) {
    throw new Error("ADR-062-qualified resolver required");
  }
  if (!Array.isArray(request.moves) || request.moves.length === 0) {
    throw new Error("amount-only decision request requires moves");
  }
  if (request.engine?.botType !== request.type || typeof request.engine?.engineId !== "string" || request.engine.engineId.length === 0) {
    throw new Error("amount-only decision engine identity mismatch");
  }
  assertExactKeys(request.engine, ["botType", "engineId"], "amount-only decision engine");
  if (typeof request.sessionKey !== "string" || !/^[a-z0-9][a-z0-9._/-]{0,127}$/u.test(request.sessionKey)) {
    throw new Error("invalid amount-only decision session key");
  }
  assertDecisionState(request.decision);
  assertNoForbiddenKeys(request);
}

function assertExactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) {
    throw new Error(`invalid ${label} keys`);
  }
}

export function amountOnlyDecisionFingerprint(request) {
  assertS2AmountOnlyDecisionRequest(request);
  const { sessionKey: _sessionKey, ...fingerprinted } = request;
  return `${S2_AMOUNT_ONLY_DECISION_REQUEST_ID}:sha256:${sha256Hex(canonicalize(fingerprinted))}`;
}

function assertDecisionState(decision) {
  const expected = ["board", "chain", "id", "incoming", "lockTime", "pieces", "rulesetId"];
  if (decision === null || typeof decision !== "object" || decision.id !== S2_AMOUNT_ONLY_DECISION_STATE_ID ||
      JSON.stringify(Object.keys(decision).sort()) !== JSON.stringify(expected)) {
    throw new Error("invalid amount-only decision state");
  }
  if (!Number.isSafeInteger(decision.incoming?.pendingRows) || !Number.isSafeInteger(decision.incoming?.dueThisLockRows) ||
      decision.incoming.pendingRows < 0 || decision.incoming.dueThisLockRows < 0 ||
      decision.incoming.dueThisLockRows > decision.incoming.pendingRows) {
    throw new Error("invalid amount-only incoming rows");
  }
}

function assertNoForbiddenKeys(value) {
  const forbidden = new Set(["garbage", "packets", "packetId", "sourceGameId", "arrivalFrame", "order", "holeColumn", "holeSize", "generatorState", "rngState", "lastHoleColumn"]);
  const visit = (current) => {
    if (current === null || typeof current !== "object") return;
    for (const [key, child] of Object.entries(current)) {
      if (forbidden.has(key)) throw new Error(`amount-only decision request contains forbidden ${key}`);
      visit(child);
    }
  };
  visit(value);
}
