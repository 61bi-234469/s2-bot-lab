import assert from "node:assert/strict";
import test from "node:test";

import { canonicalPlacementToGuiMove } from "../cc2-gui/analysis-proposal.mjs";
import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import {
  applyCc2FinalPlacementUnderObservedS2,
  guiStateToCanonical,
} from "../src-js/cc2-s2-adapter.mjs";
import { selectCc2S2HybridPlacement } from "../src-js/cc2-s2-hybrid.mjs";
import { fullStateKey } from "../src-js/state-keys.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";
import { selectS2ConversionQualifiedRenFinisherPlacement } from
  "../src-js/s2-conversion-qualified-ren-finisher-selector.mjs";
import { selectS2F12PostTankSolvencyRescuePlacement } from
  "../src-js/s2-f12-post-tank-solvency-rescue-selector.mjs";
import { selectS2RenQualityPlacement } from "../src-js/s2-ren-quality-selector.mjs";
import { selectS2ThresholdImminentB2bRetentionPlacement } from
  "../src-js/s2-threshold-imminent-b2b-retention-selector.mjs";
import {
  resolveStaticCc2Proposal,
  resolveStaticCc2Submission,
} from "../src-js/static-cc2-proposal.mjs";

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

const RAW_TYPES = ["cc2-raw", "cc2-chouhy"];
const S2_TYPES = [
  "cc2-s2",
  "cc2-s2-gen017",
  "cc2-s2-f11",
  "cc2-s2-f12",
  "cc2-s2-f14",
  "cc2-s2-f25",
  "cc2-s2-champion",
];

function publicEngine(type) {
  return {
    botType: type,
    engineId: type,
    label: type,
    repository: "https://example.invalid/engine",
    commit: "test-commit",
    comparisonSource: `${type}-final-placement`,
  };
}

function commonOptions(type) {
  return {
    candidateLimit: 16,
    rankPenalty: 25,
    adjustmentScale: 28,
    weightProfileId: "sparse-s2",
    weights: SPARSE_S2_WEIGHTS,
    allowCompleteReturnedPrefix: true,
    engineId: type,
    comparisonSource: `${type}-final-placement`,
  };
}

function expectedS2(gui, moves, type, engine) {
  if (type === "cc2-s2-f11") {
    return selectS2RenQualityPlacement(gui, moves, commonOptions(type));
  }
  if (type === "cc2-s2-f12") {
    return selectS2ConversionQualifiedRenFinisherPlacement(gui, moves, commonOptions(type));
  }
  if (type === "cc2-s2-f14" || type === "cc2-s2-champion") {
    return selectS2F12PostTankSolvencyRescuePlacement(gui, moves, commonOptions(type));
  }
  if (type === "cc2-s2-f25") {
    return selectS2ThresholdImminentB2bRetentionPlacement(gui, moves, commonOptions(type));
  }
  return selectCc2S2HybridPlacement(gui, moves, engine);
}

function fixture() {
  const gui = toS2GuiState(createGame(91205));
  const moves = analyzeSimpleS2FinalPlacements(guiStateToCanonical(gui), { topN: 16 }).moves
    .map((candidate) => canonicalPlacementToGuiMove(
      candidate.placement,
      candidate.transition.lockResult.spin,
    ));
  return { gui, moves };
}

test("static proposal preserves raw and chouhy final-placement resolution", () => {
  const { gui, moves } = fixture();
  for (const type of RAW_TYPES) {
    const engine = publicEngine(type);
    assert.deepEqual(
      resolveStaticCc2Proposal({ gui, moves, type, engine }),
      applyCc2FinalPlacementUnderObservedS2(gui, moves[0], engine),
      type,
    );
  }
});

test("static proposal preserves every existing S2 type mapping", () => {
  const { gui, moves } = fixture();
  for (const type of S2_TYPES) {
    const engine = publicEngine(type);
    assert.deepEqual(
      resolveStaticCc2Proposal({ gui, moves, type, engine }),
      expectedS2(gui, moves, type, engine),
      type,
    );
  }
});

test("static submission returns only the fingerprint, transition, placement, and score", () => {
  const { gui, moves } = fixture();
  for (const type of [...RAW_TYPES, ...S2_TYPES]) {
    const engine = publicEngine(type);
    const proposal = resolveStaticCc2Proposal({ gui, moves, type, engine });
    const submission = resolveStaticCc2Submission({ gui, moves, type, engine });
    assert.deepEqual(Object.keys(submission).sort(), [
      "placement",
      "positionFingerprint",
      "score",
      "transition",
    ], type);
    assert.equal(submission.positionFingerprint, fullStateKey(guiStateToCanonical(gui)), type);
    assert.deepEqual(submission.transition, proposal.transition, type);
    assert.deepEqual(submission.placement, proposal.comparison.witness.placement, type);
    assert.equal(submission.score, proposal.comparison.score, type);
  }
});

test("static proposal rejects mismatched worker engine identities", () => {
  const { gui, moves } = fixture();
  assert.throws(
    () => resolveStaticCc2Proposal({
      gui,
      moves,
      type: "cc2-chouhy",
      engine: publicEngine("cc2-raw"),
    }),
    /engine identity mismatch/,
  );
  assert.throws(
    () => resolveStaticCc2Submission({
      gui,
      moves,
      type: "cc2-s2-champion",
      engine: { ...publicEngine("cc2-s2-champion"), engineId: "cc2-s2-f14" },
    }),
    /engine identity mismatch/,
  );
  assert.throws(
    () => resolveStaticCc2Proposal({
      gui,
      moves,
      type: "cc2-unknown",
      engine: publicEngine("cc2-unknown"),
    }),
    /unsupported CC2 engine/,
  );
});

