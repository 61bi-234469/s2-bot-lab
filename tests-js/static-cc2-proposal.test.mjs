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
import { selectS2F12AmountOnlyPostTankSolvencyRescuePlacement } from
  "../src-js/s2-f12-amount-only-post-tank-solvency-rescue-selector.mjs";
import { selectS2RenQualityPlacement } from "../src-js/s2-ren-quality-selector.mjs";
import { selectS2ThresholdImminentB2bRetentionPlacement } from
  "../src-js/s2-threshold-imminent-b2b-retention-selector.mjs";
import { rankS2AmountOnlyPublicCandidates } from
  "../src-js/s2-amount-only-public-candidates.mjs";
import {
  resolveStaticCc2Proposal,
  resolveStaticCc2Submission,
  resolveQualifiedStaticCc2Submission,
} from "../src-js/static-cc2-proposal.mjs";
import { createS2AmountOnlyDecisionRequest } from "../src-js/s2-amount-only-decision-state.mjs";
import { auditQualifiedStaticCc2Candidates } from "../src-js/s2-amount-only-public-resolver.mjs";
import { resolveGuiStaticSubmission } from "../src-js/gui-static-public-resolver.mjs";
import { createGuiStaticDecisionRequest } from "../src-js/s2-amount-only-decision-state.mjs";

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
    return selectS2F12AmountOnlyPostTankSolvencyRescuePlacement(gui, moves, commonOptions(type));
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

function withHiddenIncoming(gui, { rngState, lastHoleColumn }) {
  const next = structuredClone(gui);
  next.s2.garbage.packets = [{
    packetId: 1,
    sourceGameId: 2,
    amount: 4,
    holeSize: 1,
    arrivalFrame: 0,
    confirmed: true,
    order: 0,
  }];
  next.s2.garbage.generatorState.rngState = rngState;
  next.s2.garbage.generatorState.lastHoleColumn = lastHoleColumn;
  return next;
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

test("raw and chouhy public resolution preserves native first choice and is hidden-garbage blind", () => {
  const { gui, moves } = fixture();
  for (const type of RAW_TYPES) {
    const resolve = (input, proposals) => resolveGuiStaticSubmission(createGuiStaticDecisionRequest({
      sessionKey: "analysis", state: guiStateToCanonical(input), moves: proposals,
      type, engine: publicEngine(type),
    }));
    const left = withHiddenIncoming(gui, { rngState: 123, lastHoleColumn: 0 });
    const right = withHiddenIncoming(gui, { rngState: 456, lastHoleColumn: 9 });
    const actual = resolve(left, moves);
    assert.deepEqual(actual, resolve(right, moves));
    assert.deepEqual(actual.placement, resolve(left, [moves[0]]).placement);
    assert.deepEqual(actual.placement,
      applyCc2FinalPlacementUnderObservedS2(left, moves[0], publicEngine(type)).comparison.witness.placement);
    const invalid = { location: { type: "T", orientation: "north", x: -100, y: 0 }, spin: "none" };
    assert.throws(() => resolve(left, [invalid, ...moves]), /no legal candidate/);
  }
});

test("native GUI Raw/chouhy identities use the same public decision envelope as WASM", () => {
  const { gui, moves } = fixture();
  for (const [type, engineId] of [["cc2-raw", "minuskelvin-cold-clear-2/ed8b193"], ["cc2-chouhy", "chouhy-cold-clear-2/b20a92b"]]) {
    const options = { sessionKey: "left", state: guiStateToCanonical(gui), moves, type, engine: publicEngine(type) };
    const expected = createGuiStaticDecisionRequest(options);
    const actual = createGuiStaticDecisionRequest({ ...options, engine: { botType: type, engineId } });
    assert.deepEqual(actual, expected);
    assert.deepEqual(resolveGuiStaticSubmission(actual), resolveGuiStaticSubmission(expected));
    assert.throws(() => createGuiStaticDecisionRequest({ ...options, engine: { botType: "cc2-s2-f14", engineId } }), /identity mismatch/);
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

test("champion worker envelope keeps placement and score blind to hidden garbage metadata", () => {
  const base = toS2GuiState(createGame(62001));
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 9; x += 1) base.board[y][x] = "G";
  }
  const left = withHiddenIncoming(base, { rngState: 1, lastHoleColumn: 0 });
  const right = withHiddenIncoming(base, { rngState: 99, lastHoleColumn: 8 });
  const moves = analyzeSimpleS2FinalPlacements(guiStateToCanonical(left), { topN: 16 }).moves
    .map((candidate) => canonicalPlacementToGuiMove(
      candidate.placement,
      candidate.transition.lockResult.spin,
    ));
  const type = "cc2-s2-champion";
  const a = resolveStaticCc2Submission({ gui: left, moves, type, engine: publicEngine(type) });
  const b = resolveStaticCc2Submission({ gui: right, moves, type, engine: publicEngine(type) });
  assert.deepEqual(a.placement, b.placement);
  assert.equal(a.score, b.score);
  assert.notEqual(a.positionFingerprint, b.positionFingerprint);
});

test("qualified worker envelope contains only public decision data", () => {
  const base = toS2GuiState(createGame(62011));
  const left = withHiddenIncoming(base, { rngState: 3, lastHoleColumn: 0 });
  const right = withHiddenIncoming(base, { rngState: 9, lastHoleColumn: 8 });
  const moves = analyzeSimpleS2FinalPlacements(guiStateToCanonical(left), { topN: 16 }).moves
    .map((candidate) => canonicalPlacementToGuiMove(candidate.placement, candidate.transition.lockResult.spin));
  const type = "cc2-s2-champion";
  const a = createS2AmountOnlyDecisionRequest({
    sessionKey: "left", state: guiStateToCanonical(left), moves, type, engine: publicEngine(type),
  });
  const b = createS2AmountOnlyDecisionRequest({
    sessionKey: "left", state: guiStateToCanonical(right), moves, type, engine: publicEngine(type),
  });
  assert.deepEqual(a, b);
  const response = resolveQualifiedStaticCc2Submission(a);
  const twinResponse = resolveQualifiedStaticCc2Submission(b);
  assert.deepEqual(Object.keys(response).sort(), ["decisionFingerprint", "placement", "score"]);
  assert.deepEqual(twinResponse, response);
  assert.equal(JSON.stringify(a).includes("rngState"), false);
  assert.equal(JSON.stringify(response).includes("transition"), false);
});

test("qualified request rejects surplus fields and invalid session labels", () => {
  const { gui, moves } = fixture();
  const state = guiStateToCanonical(gui);
  const type = "cc2-s2-champion";
  assert.throws(() => createS2AmountOnlyDecisionRequest({
    sessionKey: "bad key", state, moves, type, engine: publicEngine(type),
  }), /session key/);
  const request = createS2AmountOnlyDecisionRequest({
    sessionKey: "public/strict", state, moves, type, engine: publicEngine(type),
  });
  assert.throws(() => resolveQualifiedStaticCc2Submission({ ...request, harmless: true }), /request keys/);
  assert.throws(() => resolveQualifiedStaticCc2Submission({
    ...request, engine: { ...request.engine, harmless: true },
  }), /engine keys/);
});

test("public candidate audit is fixed to the resolver policy and hidden-state blind", () => {
  const base = toS2GuiState(createGame(62012));
  const left = withHiddenIncoming(base, { rngState: 4, lastHoleColumn: 1 });
  const right = withHiddenIncoming(base, { rngState: 44, lastHoleColumn: 8 });
  const moves = analyzeSimpleS2FinalPlacements(guiStateToCanonical(left), { topN: 16 }).moves
    .map((candidate) => canonicalPlacementToGuiMove(candidate.placement, candidate.transition.lockResult.spin));
  const request = (state) => createS2AmountOnlyDecisionRequest({
    sessionKey: "public/audit", state: guiStateToCanonical(state), moves,
    type: "cc2-s2-champion", engine: publicEngine("cc2-s2-champion"),
  });
  const a = auditQualifiedStaticCc2Candidates(request(left));
  const b = auditQualifiedStaticCc2Candidates(request(right));
  assert.deepEqual(a, b);
  assert.deepEqual(Object.keys(a).sort(), ["candidatePrefixSha256", "candidates", "decisionFingerprint", "id", "policyId", "selected"]);
  assert.equal(a.candidates.length > 0, true);
  assert.equal(a.candidates.some((candidate) => candidate.cc2Rank === a.selected.cc2Rank), true);
  assert.equal(JSON.stringify(a).includes("rngState"), false);
});

test("public qualified resolver preserves F14 selection on representative public positions", () => {
  const type = "cc2-s2-champion";
  for (const seed of [1, 52031, 91205]) {
    const gui = toS2GuiState(createGame(seed));
    const state = guiStateToCanonical(gui);
    const moves = analyzeSimpleS2FinalPlacements(state, { topN: 16 }).moves
      .map((candidate) => canonicalPlacementToGuiMove(
        candidate.placement,
        candidate.transition.lockResult.spin,
      ));
    const qualified = resolveQualifiedStaticCc2Submission(createS2AmountOnlyDecisionRequest({
      sessionKey: `public-${seed}`, state, moves, type, engine: publicEngine(type),
    }));
    const historical = expectedS2(gui, moves, type, publicEngine(type));
    assert.deepEqual(qualified.placement, historical.comparison.witness.placement, String(seed));
    assert.equal(qualified.score, historical.comparison.score, String(seed));
  }
});

test("public qualified resolver preserves witnessed spin, HOLD, and chain selection", () => {
  const gui = toS2GuiState(createGame(33));
  for (let y = 0; y < 40; y += 1) for (let x = 0; x < 10; x += 1) gui.board[y][x] = null;
  for (const [y, row] of ["___G_G____", "GGG___GGGG", "___G_G____"].entries()) {
    for (const [x, cell] of [...row].entries()) gui.board[y][x] = cell === "_" ? null : cell;
  }
  gui.queue = ["T", "I", "T", "O", "S", "Z", "J", "L"];
  gui.hold = "J";
  gui.combo = 2;
  gui.back_to_back = true;
  gui.s2.b2b = 5;
  gui.s2.time.logicalFrame = 200;
  gui.s2.time.piecesPlaced = 7;
  const state = guiStateToCanonical(gui);
  const moves = analyzeSimpleS2FinalPlacements(state, { topN: 16 }).moves
    .map((candidate) => canonicalPlacementToGuiMove(candidate.placement, candidate.transition.lockResult.spin));
  const type = "cc2-s2-champion";
  const request = createS2AmountOnlyDecisionRequest({
    sessionKey: "public-spin-hold-chain", state, moves, type, engine: publicEngine(type),
  });
  const ranked = rankS2AmountOnlyPublicCandidates(request.decision, moves, {
    candidateLimit: 16, allowCompleteReturnedPrefix: true, weightProfileId: "sparse-s2", weights: SPARSE_S2_WEIGHTS,
  });
  assert.equal(ranked.candidates.some((candidate) => candidate.placement.usedHold), true);
  assert.equal(ranked.candidates.some((candidate) => candidate.projection.spin === "mini"), true);
  const qualified = resolveQualifiedStaticCc2Submission(request);
  const historical = expectedS2(gui, moves, type, publicEngine(type));
  assert.deepEqual(qualified.placement, historical.comparison.witness.placement);
  assert.equal(qualified.score, historical.comparison.score);
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
