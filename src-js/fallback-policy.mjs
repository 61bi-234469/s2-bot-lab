export const DEGRADED_REASONS = Object.freeze([
  "structured-garbage-unavailable",
  "exact-b2b-unavailable",
  "b2b-charging-unavailable",
  "surge-unavailable",
  "cancellation-unavailable",
  "chain-state-unavailable",
  "time-state-unavailable",
  "queue-unknown",
  "movement-model-unavailable",
  "rule-option-guard-only",
  "user-selected-incompatible-engine",
]);

const MECHANISM_REASON = Object.freeze({
  "structured-garbage": "structured-garbage-unavailable",
  "exact-b2b": "exact-b2b-unavailable",
  "b2b-charging": "b2b-charging-unavailable",
  surge: "surge-unavailable",
  cancellation: "cancellation-unavailable",
  "chain-state": "chain-state-unavailable",
  "time-state": "time-state-unavailable",
  "known-queue": "queue-unknown",
  "movement-model": "movement-model-unavailable",
  "rule-option": "rule-option-guard-only",
});

export function assessFallback({ operation, state, engine, manifest, userSelected = false }) {
  const requirements = manifest.operationRequirements?.[operation];
  if (!requirements) throw new Error(`unknown fallback operation ${operation}`);
  validateMechanisms(requirements.currentStateMechanisms);
  validateMechanisms(requirements.reachableMechanisms);

  const support = engine.capabilities?.mechanismSupport ?? {};
  const currentMissing = requirements.currentStateMechanisms.filter(
    (mechanism) =>
      support[mechanism] !== "exact" &&
      !evaluateNeutral(manifest.neutralPredicates?.[mechanism], state),
  );
  const queueUnknown =
    state.pieces?.fidelity !== "exact" || state.pieces?.queueModel?.tail === "unknown";
  const queueBlocked = engine.capabilities?.unknownQueue === "reject" && queueUnknown;
  const informationLoss = Array.isArray(state.informationLoss) ? state.informationLoss : [];
  const inert = currentMissing.length === 0 && !queueBlocked && informationLoss.length === 0;
  const reachableMissing = requirements.reachableMechanisms.filter(
    (mechanism) => support[mechanism] !== "exact",
  );
  const autoFallbackSafe = inert && reachableMissing.length === 0;

  if (autoFallbackSafe) {
    return {
      inert,
      autoFallbackSafe,
      decision: queueUnknown ? "auto-speculative" : "auto-exact",
      resultKind: queueUnknown ? "speculative-input" : "exact-input",
      degraded: queueUnknown ? ["queue-unknown"] : [],
      errorCode: null,
    };
  }

  if (userSelected && inert) {
    const degraded = uniqueReasons([
      ...reachableMissing.map(reasonForMechanism),
      ...(queueUnknown ? ["queue-unknown"] : []),
      "user-selected-incompatible-engine",
    ]);
    return {
      inert,
      autoFallbackSafe,
      decision: "user-degraded",
      resultKind: queueUnknown ? "speculative-input" : "degraded-input",
      degraded,
      errorCode: null,
    };
  }

  const degraded = uniqueReasons([
    ...currentMissing.map(reasonForMechanism),
    ...reachableMissing.map(reasonForMechanism),
    ...(queueBlocked || queueUnknown ? ["queue-unknown"] : []),
    ...informationLoss.map(reasonForInformationLoss),
  ]);
  return {
    inert,
    autoFallbackSafe,
    decision: "unsupported",
    resultKind: null,
    degraded,
    errorCode: "capability-missing",
  };
}

function evaluateNeutral(predicate, state) {
  switch (predicate) {
    case "b2b-inactive":
      return state.chain?.fidelity === "exact" && state.chain.b2b === 0;
    case "chain-inactive":
      return (
        state.chain?.fidelity === "exact" &&
        state.chain.combo === 0 &&
        state.chain.b2b === 0
      );
    case "garbage-empty":
      return state.garbage?.fidelity === "exact" && state.garbage.packets.length === 0;
    case undefined:
      return false;
    default:
      throw new Error(`unknown neutral predicate ${predicate}`);
  }
}

function validateMechanisms(mechanisms) {
  if (!Array.isArray(mechanisms)) throw new Error("operation mechanisms must be arrays");
  for (const mechanism of mechanisms) reasonForMechanism(mechanism);
}

function reasonForMechanism(mechanism) {
  const reason = MECHANISM_REASON[mechanism];
  if (!reason) throw new Error(`unknown fallback mechanism ${mechanism}`);
  return reason;
}

function reasonForInformationLoss(loss) {
  if (loss.field?.startsWith("garbage")) return "structured-garbage-unavailable";
  if (loss.field?.startsWith("chain.b2b")) return "exact-b2b-unavailable";
  if (loss.field?.startsWith("chain")) return "chain-state-unavailable";
  if (loss.field?.startsWith("time")) return "time-state-unavailable";
  if (loss.field?.startsWith("pieces")) return "queue-unknown";
  if (loss.field?.startsWith("board")) return "movement-model-unavailable";
  return "rule-option-guard-only";
}

function uniqueReasons(reasons) {
  return [...new Set(reasons)];
}
