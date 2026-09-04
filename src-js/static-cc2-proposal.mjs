import { applyCc2FinalPlacementUnderObservedS2 } from "./cc2-s2-adapter.mjs";
import { selectCc2S2HybridPlacement } from "./cc2-s2-hybrid.mjs";
import { guiStateToCanonical } from "./gui-state.mjs";
import { fullStateKey } from "./state-keys.mjs";
import { selectS2RenQualityPlacement } from "./s2-ren-quality-selector.mjs";
import { selectS2ConversionQualifiedRenFinisherPlacement } from "./s2-conversion-qualified-ren-finisher-selector.mjs";
import { selectS2F12PostTankSolvencyRescuePlacement } from "./s2-f12-post-tank-solvency-rescue-selector.mjs";
import { selectS2ThresholdImminentB2bRetentionPlacement } from "./s2-threshold-imminent-b2b-retention-selector.mjs";

const SPARSE_S2_WEIGHTS = Object.freeze({
  aggregateHeight: -.1,
  maxHeight: -.4,
  holes: -1,
  bumpiness: -.05,
  remainingIncoming: 0,
  deferredIncoming: -.8,
  dueIncoming: 0,
  incomingNextLock: 0,
  confirmedIncoming: 0,
  tankedIncoming: -.25,
  visibleTopOutMargin: 0,
  outgoingBeforeCancel: 0,
  outgoingAfterCancel: 1,
  cancelled: .8,
  combo: 0,
  b2b: .6,
  chargingLevel: 0,
  surgeSent: .25,
});
const STATIC_CC2_TYPES = new Set([
  "cc2-raw",
  "cc2-chouhy",
  "cc2-s2",
  "cc2-s2-gen017",
  "cc2-s2-f11",
  "cc2-s2-f12",
  "cc2-s2-f14",
  "cc2-s2-f25",
  "cc2-s2-champion",
]);

/** Resolve the existing static analysis result without changing selector semantics. */
export function resolveStaticCc2Proposal({ gui, moves, type, engine }) {
  assertRequest(gui, moves, type, engine);
  if (!type.startsWith("cc2-s2")) {
    return applyCc2FinalPlacementUnderObservedS2(gui, moves[0], engine);
  }
  const common = {
    candidateLimit: 16,
    rankPenalty: 25,
    adjustmentScale: 28,
    weightProfileId: "sparse-s2",
    weights: SPARSE_S2_WEIGHTS,
    allowCompleteReturnedPrefix: true,
    engineId: type,
    comparisonSource: `${type}-final-placement`,
  };
  if (type === "cc2-s2-f11") return selectS2RenQualityPlacement(gui, moves, common);
  if (type === "cc2-s2-f12") {
    return selectS2ConversionQualifiedRenFinisherPlacement(gui, moves, common);
  }
  if (type === "cc2-s2-f14" || type === "cc2-s2-champion") {
    return selectS2F12PostTankSolvencyRescuePlacement(gui, moves, common);
  }
  if (type === "cc2-s2-f25") {
    return selectS2ThresholdImminentB2bRetentionPlacement(gui, moves, common);
  }
  return selectCc2S2HybridPlacement(gui, moves, engine);
}

/** Keep the cross-thread response to the fields consumed by match commit. */
export function resolveStaticCc2Submission(request) {
  const positionFingerprint = fullStateKey(guiStateToCanonical(request.gui));
  const result = resolveStaticCc2Proposal(request);
  if (result.transition === null) {
    throw new Error(`${request.type} CC2 placement rejected`);
  }
  const resultFingerprint = result.comparison?.positionFingerprint;
  if (resultFingerprint !== undefined && resultFingerprint !== positionFingerprint) {
    throw new Error(`${request.type} CC2 resolver returned a stale transition`);
  }
  const placement = result.comparison?.witness?.placement;
  if (placement === null || typeof placement !== "object") {
    throw new Error(`${request.type} CC2 resolver omitted its selected placement`);
  }
  return {
    positionFingerprint,
    transition: result.transition,
    placement,
    score: result.comparison?.score,
  };
}

function assertRequest(gui, moves, type, engine) {
  if (gui === null || typeof gui !== "object") throw new Error("CC2 resolution requires GUI state");
  if (!Array.isArray(moves) || moves.length === 0) throw new Error("CC2 resolution requires candidate moves");
  if (!STATIC_CC2_TYPES.has(type)) throw new Error(`unsupported CC2 engine ${type}`);
  if (engine?.botType !== type || engine?.engineId !== type) {
    throw new Error(`CC2 resolution engine identity mismatch for ${type}`);
  }
}
