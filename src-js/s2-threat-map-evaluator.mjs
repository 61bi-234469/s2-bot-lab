import { createHash } from "node:crypto";

import { canonicalize } from "./cs1-core.mjs";
import { extractEvaluationFeatures } from "./evaluation.mjs";

export const THREAT_MAP_FEATURE_SCHEMA_ID =
  "s2-analysis-engine/schema/s2-threat-map-features/1";
export const THREAT_MAP_FEATURE_SCHEMA_VERSION = 1;
export const THREAT_MAP_FEATURE_DEFINITION = Object.freeze({
  garbageHoleDistance: "minimum stack height in a possible incoming-hole window",
  garbageCoveredCells: "occupied cells in the top incoming-row band",
  openWellFreedom: "columns at the minimum post-transition stack height",
  nonlinearTopOutRisk: "squared overflow beyond visible margin after incoming amount",
  incomingAmount: "confirmed remaining incoming packet rows",
  visibleTopOutMargin: "canonical visible height minus occupied maximum height",
});
export const THREAT_MAP_FEATURE_SCHEMA_SHA256 = `sha256:${createHash("sha256")
  .update(canonicalize(THREAT_MAP_FEATURE_DEFINITION))
  .digest("hex")}`;

export function extractS2ThreatMapFeatures(transition) {
  if (transition?.legality?.legal !== true || transition.nextState === null) {
    throw new Error("S2 threat-map features require a legal Simulator transition with a next state");
  }
  const board = transition.nextState.board;
  if (board?.fidelity !== "exact") {
    throw new Error("S2 threat-map features require an exact canonical board state");
  }
  if (!Number.isSafeInteger(board.width) || !Number.isSafeInteger(board.height) ||
      board.width < 1 || board.height < 1 ||
      typeof board.cells !== "string" || board.cells.length !== board.width * board.height ||
      !/^[IJLOSTZG_]+$/.test(board.cells)) {
    throw new Error("S2 threat-map features require valid canonical board geometry and cells");
  }

  const baseline = extractEvaluationFeatures(transition);
  const heights = columnHeights(board);
  const incomingAmount = baseline.confirmedIncoming;
  const maxHoleSize = Math.max(
    1,
    ...(transition.cancelResult?.remainingIncoming ?? []).map((packet) => packet.holeSize ?? 1),
  );
  const garbageHoleDistance = minimumHoleWindowHeight(heights, maxHoleSize);
  const garbageCoveredCells = topBandOccupied(board, incomingAmount);
  const minHeight = Math.min(...heights);
  const openWellFreedom = heights.filter((height) => height === minHeight).length;
  const overflow = Math.max(0, incomingAmount - Math.max(0, baseline.visibleTopOutMargin));
  const nonlinearTopOutRisk = overflow * overflow;

  return {
    $schema: THREAT_MAP_FEATURE_SCHEMA_ID,
    schemaVersion: THREAT_MAP_FEATURE_SCHEMA_VERSION,
    featureSchemaSha256: THREAT_MAP_FEATURE_SCHEMA_SHA256,
    garbageHoleDistance,
    garbageCoveredCells,
    openWellFreedom,
    nonlinearTopOutRisk,
    incomingAmount,
    visibleTopOutMargin: baseline.visibleTopOutMargin,
  };
}

export function scoreS2ThreatMapFeatures(features, weights = {}) {
  assertThreatMapFeatures(features);
  const defaults = {
    garbageHoleDistance: -0.2,
    garbageCoveredCells: -1,
    openWellFreedom: 0.5,
    nonlinearTopOutRisk: -4,
    incomingAmount: -0.1,
    visibleTopOutMargin: 0.1,
  };
  return Object.keys(defaults).reduce(
    (score, key) => score + features[key] * (weights[key] ?? defaults[key]),
    0,
  );
}

export function assertThreatMapFeatures(features) {
  if (features?.$schema !== THREAT_MAP_FEATURE_SCHEMA_ID ||
      features.schemaVersion !== THREAT_MAP_FEATURE_SCHEMA_VERSION ||
      features.featureSchemaSha256 !== THREAT_MAP_FEATURE_SCHEMA_SHA256) {
    throw new Error("S2 threat-map feature identity mismatch");
  }
  for (const key of Object.keys(THREAT_MAP_FEATURE_DEFINITION)) {
    if (!Number.isFinite(features[key])) throw new Error(`S2 threat-map feature ${key} is not finite`);
  }
  return true;
}

function columnHeights(board) {
  return Array.from({ length: board.width }, (_, x) => {
    for (let y = board.height - 1; y >= 0; y -= 1) {
      if (board.cells[y * board.width + x] !== "_") return y + 1;
    }
    return 0;
  });
}

function minimumHoleWindowHeight(heights, holeSize) {
  const width = Math.min(heights.length, Math.max(1, holeSize));
  let best = Number.POSITIVE_INFINITY;
  for (let start = 0; start <= heights.length - width; start += 1) {
    best = Math.min(best, Math.max(...heights.slice(start, start + width)));
  }
  return Number.isFinite(best) ? best : 0;
}

function topBandOccupied(board, rows) {
  const bandStart = Math.max(0, board.height - rows);
  let occupied = 0;
  for (let y = bandStart; y < board.height; y += 1) {
    for (let x = 0; x < board.width; x += 1) {
      if (board.cells[y * board.width + x] !== "_") occupied += 1;
    }
  }
  return occupied;
}
