import { canonicalize } from "./cs1-core.mjs";
import { sha256Hex } from "./sha256.mjs";

/**
 * Carries the same wire code as `StateKeyError` in `src/state_key.rs`. A
 * refusal is part of the behaviour these keys define, so the runtimes have to
 * agree on which rule they hit, not merely on the fact that both refused.
 */
export class StateKeyError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function fullStateKey(state) {
  assertStateObject(state);
  const payload = structuredClone(state);
  delete payload.provenance;
  return hashKey("s2-full-state/1", payload);
}

export function currentPieceStructuralKey(state) {
  assertExactMoveState(state);
  return hashKey("s2-current-piece/1", {
    schemaVersion: state.schemaVersion,
    rulesetId: state.rulesetId,
    board: state.board,
    current: state.pieces.current,
  });
}

export function holdAwareMoveGenerationKey(state) {
  assertExactMoveState(state);
  const queueHead = state.pieces.known[0] ?? null;
  if (state.pieces.holdAvailable && state.pieces.hold === null && queueHead === null) {
    throw new StateKeyError(
      "unknown-queue-after-empty-hold",
      "HOLD with an empty slot requires a known queue head",
    );
  }
  return hashKey("s2-hold-aware/1", {
    schemaVersion: state.schemaVersion,
    rulesetId: state.rulesetId,
    board: state.board,
    current: state.pieces.current,
    hold: state.pieces.hold,
    holdAvailable: state.pieces.holdAvailable,
    queueHead,
  });
}

function assertStateObject(state) {
  if (state === null || typeof state !== "object" || Array.isArray(state)) {
    throw new StateKeyError("not-an-object", "canonical state must be an object");
  }
}

function assertExactMoveState(state) {
  assertStateObject(state);
  if (state.board?.fidelity !== "exact" || state.pieces?.fidelity !== "exact") {
    throw new StateKeyError(
      "inexact-move-state",
      "move-generation keys require exact board and piece state",
    );
  }
}

function hashKey(namespace, payload) {
  const digest = sha256Hex(canonicalize(payload));
  return `${namespace}:sha256:${digest}`;
}
