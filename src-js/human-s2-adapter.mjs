import {
  EVALUATION_SCORE_SEMANTICS,
  evaluatorModelIdentity,
  extractEvaluationFeatures,
  scoreEvaluationFeatures,
} from "./evaluation.mjs";
import { fullStateKey } from "./state-keys.mjs";
import { applyTransition } from "./transition.mjs";
import { resolvePlacementRules } from "./ruleset-profiles.mjs";
import { findReachableRotationPlacement } from "./triangle/move-generation.mjs";

export const HUMAN_FINAL_PLACEMENT_POLICY = Object.freeze({
  id: "human-final-placement-policy/1",
  reachability: "independently-witnessed-within-s2-kickset-for-rotation-locks",
  spin: "player-rotation-admitted-only-with-matching-s2-rotation-kick-witness",
});

const ROTATIONS = Object.freeze(["spawn", "right", "reverse", "left"]);
const PIECES = Object.freeze(["I", "O", "T", "L", "J", "S", "Z"]);

/**
 * Runs one player-submitted final placement through the canonical S2 transition.
 *
 * The browser owns the piece movement, so the only thing it can prove on its own
 * is where the piece came to rest. A lock whose last input was a rotation is
 * therefore treated exactly like an external bot's spin claim: the S2 kickset
 * reachability model has to find the same resting pose reached by a rotation of
 * the same fin/TST shape before that evidence is admitted. Without a witness the
 * lock is re-evaluated as a plain drop, so a front end cannot mint spin attack by
 * asserting a rotation the rule model does not support.
 */
export function applyHumanFinalPlacementUnderObservedS2(state, input) {
  const submitted = normalizeHumanPlacement(input);
  const witnessed = submitted.rotationEvidence.lastInputWasRotation
    ? witnessRotationLock(state, submitted)
    : null;
  const rotationUnwitnessed = submitted.rotationEvidence.lastInputWasRotation && witnessed === null;
  const placement = witnessed?.placement ?? {
    ...submitted,
    rotationEvidence: rotationUnwitnessed
      ? { lastInputWasRotation: false, kickIndex: null }
      : submitted.rotationEvidence,
  };
  const transition = applyTransition(state, { kind: "placement", placement });
  const reasons = ["human-frame-reachability-not-witnessed"];
  if (rotationUnwitnessed) {
    reasons.push("human-rotation-not-independently-witnessed", "spin-classification-limited-to-none");
  }
  if (!transition.legality.legal) {
    return {
      status: "unsupported",
      reasons: [`human-final-placement-illegal-under-s2:${transition.legality.reason}`],
      policy: HUMAN_FINAL_PLACEMENT_POLICY,
      transition: null,
    };
  }
  const features = extractEvaluationFeatures(transition);
  return {
    status: "degraded",
    reasons,
    policy: HUMAN_FINAL_PLACEMENT_POLICY,
    transition,
    comparison: {
      source: "human-final-placement",
      status: "degraded",
      reasons,
      positionFingerprint: fullStateKey(state),
      rulesetId: state.rulesetId,
      witness: {
        kind: witnessed === null
          ? "player-final-placement-only"
          : "player-final-placement-with-s2-rotation-witness",
        placement,
        spinWitness: witnessed?.witness ?? null,
      },
      evaluator: evaluatorModelIdentity(),
      scoreSemantics: EVALUATION_SCORE_SEMANTICS,
      features,
      score: scoreEvaluationFeatures(features),
    },
  };
}

function witnessRotationLock(state, submitted) {
  const rules = resolvePlacementRules(state.rulesetId);
  const candidate = findReachableRotationPlacement(state, submitted, rules);
  if (candidate === null) return null;
  return {
    placement: candidate,
    witness: {
      kind: "s2-kickset-reachability-witness",
      submittedRotationEvidence: structuredClone(submitted.rotationEvidence),
      rotationEvidence: structuredClone(candidate.rotationEvidence),
    },
  };
}

/**
 * Accepts only the fields a placement is made of. A front end that sends an
 * extra property is rejected instead of having it silently ignored, because the
 * ignored field would otherwise look like it had been applied.
 */
export function normalizeHumanPlacement(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("human placement must be an object");
  }
  const allowed = ["piece", "rotation", "x", "y", "usedHold", "rotationEvidence"];
  const unknown = Object.keys(input).find((key) => !allowed.includes(key));
  if (unknown !== undefined) throw new Error(`unsupported human placement field ${unknown}`);
  if (!PIECES.includes(input.piece)) throw new Error("human placement piece is unsupported");
  if (!ROTATIONS.includes(input.rotation)) throw new Error("human placement rotation is unsupported");
  if (!Number.isSafeInteger(input.x) || !Number.isSafeInteger(input.y)) {
    throw new Error("human placement coordinates must be safe integers");
  }
  if (typeof input.usedHold !== "boolean") throw new Error("human placement requires a HOLD flag");
  return {
    piece: input.piece,
    rotation: input.rotation,
    x: input.x,
    y: input.y,
    usedHold: input.usedHold,
    rotationEvidence: normalizeRotationEvidence(input.rotationEvidence),
  };
}

function normalizeRotationEvidence(evidence) {
  if (evidence === null || typeof evidence !== "object" || Array.isArray(evidence)) {
    throw new Error("human placement requires rotation evidence");
  }
  if (evidence.lastInputWasRotation !== true) {
    if (evidence.lastInputWasRotation !== false) {
      throw new Error("rotation evidence requires a boolean lastInputWasRotation");
    }
    return { lastInputWasRotation: false, kickIndex: null };
  }
  if (!Number.isSafeInteger(evidence.kickIndex) || evidence.kickIndex < 0) {
    throw new Error("rotation evidence requires a non-negative kick index");
  }
  if (!/^[0-3][0-3]$/.test(evidence.kickId ?? "")) {
    throw new Error("rotation evidence requires a rotation transition id");
  }
  if (
    !Array.isArray(evidence.kickOffset) ||
    evidence.kickOffset.length !== 2 ||
    !evidence.kickOffset.every(Number.isSafeInteger)
  ) {
    throw new Error("rotation evidence requires an integer kick offset");
  }
  return {
    lastInputWasRotation: true,
    kickIndex: evidence.kickIndex,
    kickId: evidence.kickId,
    kickOffset: [...evidence.kickOffset],
  };
}
