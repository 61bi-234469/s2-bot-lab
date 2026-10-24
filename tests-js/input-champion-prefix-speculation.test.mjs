import assert from "node:assert/strict";
import test from "node:test";

import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { guiStateToCanonical } from "../src-js/gui-state.mjs";
import { createS2AmountOnlyDecisionState } from "../src-js/s2-amount-only-decision-state.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";
import { canonicalize } from "../scripts/cs1.mjs";
import { assertGatedChampionResponse, championVisibleState } from "../src-js/champion-parameters.mjs";
import { decisionStateToSyntheticGui } from "../src-js/s2-amount-only-decision-state.mjs";
import { applyTransition } from "../src-js/transition.mjs";
import { isChampionInputSpeculationHit } from "../src-js/gui-input-match.mjs";
import { championInputMoves, createChampionInputRequest, predictChampionNextRequest } from "../src-js/input-champion-decision.mjs";
import { createF14LeafConversionGatedProfile } from "../src-js/s2-f14-compat-browser.mjs";

const profile = createF14LeafConversionGatedProfile({ scale: "0.25", maxHeight: "8" });
const boundaryQueue = [..."IOTSZJLTSZJLIO"];

function boundaryPosition(queue = boundaryQueue) {
  const base = guiStateToCanonical(toS2GuiState(createGame(1)));
  const state = { ...base, pieces: { ...base.pieces, current: queue[0], known: queue.slice(1), hold: null, holdAvailable: true } };
  const decision = createS2AmountOnlyDecisionState(state);
  const move = analyzeSimpleS2FinalPlacements(state, { topN: 20 }).moves.find((candidate) => !candidate.placement.usedHold);
  assert.ok(move, "fixture queue has a legal placement without HOLD");
  const request = createChampionInputRequest(decision, { requestId: "prefix-source", profile, queueDepth: 14 });
  const response = { status: "move", selectedPlacement: move.placement };
  return { decision, request, response };
}

test("prediction marks a one-piece prefix only for a validated /2 public bag boundary", () => {
  const { decision, request, response } = boundaryPosition();
  assert.equal(request.start.queue.length, 14);
  const predicted = predictChampionNextRequest(decision, request, response, {
    profile, queueDepth: 14, queueRefillsByBag: true, queuePrefixSpeculation: true,
  });
  assert.equal(predicted.queuePrefix, 1);
  assert.equal(predicted.request.start.queue.length, 13);
  assert.deepEqual(predicted.request.start.randomizer, { type: "seven_bag", bag_state: [] });
  assert.equal(predicted.request.selector.pieces.current, boundaryQueue[1]);

  assert.equal(predictChampionNextRequest(decision, request, response, {
    profile, queueDepth: 14, queueRefillsByBag: true, queuePrefixSpeculation: false,
  }), null);
  assert.equal(predictChampionNextRequest(decision, request, response, {
    profile, queueDepth: 14, queueRefillsByBag: false, queuePrefixSpeculation: true,
  }), null);
  assert.equal(predictChampionNextRequest(decision, request, response, {
    profile, queueDepth: 14, queueRefillsByBag: "other-input-profile", queuePrefixSpeculation: true,
  }), null);

  const invalidBag = [...boundaryQueue];
  invalidBag[8] = invalidBag[7];
  const invalid = boundaryPosition(invalidBag);
  assert.equal(predictChampionNextRequest(invalid.decision, invalid.request, invalid.response, {
    profile, queueDepth: 14, queueRefillsByBag: true, queuePrefixSpeculation: true,
  }), null);
});

test("without a refill the next /2 request is predicted exactly, also beyond QUEUE 14", () => {
  // 16 public pieces: after this placement 15 remain, no bag is appended.
  const queue = [..."IOTSZJLTSZJLIOZL"];
  const { decision, request, response } = boundaryPosition(queue);
  const at20 = createChampionInputRequest(decision, { requestId: "exact-source", profile, queueDepth: 20 });
  assert.equal(at20.start.queue.length, 16);
  const exact = predictChampionNextRequest(decision, at20, response, { profile, queueDepth: 20, queueRefillsByBag: true });
  assert.equal(exact.queuePrefix, 0);
  assert.deepEqual(exact.request.start.queue, queue.slice(1));
  assert.deepEqual(exact.request.start.randomizer, { type: "seven_bag", bag_state: [] });
  assert.equal(predictChampionNextRequest(decision, at20, response, { profile, queueDepth: 20 }), null);
  // At QUEUE 14 the search queue keeps its length, as before.
  assert.equal(predictChampionNextRequest(decision, request, response, { profile, queueDepth: 14 }).queuePrefix, 0);
});

test("INPUT speculation hit accepts exact matches and only the marked one-piece prefix", () => {
  const execution = { profileId: profile.profileId, seed: profile.seed };
  const retained = {
    execution,
    queuePrefix: 1,
    start: { board: [[null]], queue: ["I", "O", "T"], hold: null, combo: 0, b2b: 0,
      randomizer: { type: "seven_bag", bag_state: [] } },
  };
  const real = { execution: structuredClone(execution), start: { ...structuredClone(retained.start), queue: ["I", "O", "T", "S"] } };
  assert.equal(isChampionInputSpeculationHit(retained, real), true);
  assert.equal(isChampionInputSpeculationHit({ ...retained, queuePrefix: 0 }, real), false);
  assert.equal(isChampionInputSpeculationHit({ ...retained, queuePrefix: 1 }, {
    ...real, execution: { ...execution, seed: "changed" },
  }), false);
  assert.equal(isChampionInputSpeculationHit(retained, {
    ...real, start: { ...real.start, queue: ["I", "O", "T", "S", "Z"] },
  }), false);
  assert.equal(isChampionInputSpeculationHit(retained, {
    ...real, start: { ...real.start, queue: ["I", "O", "J", "S"] },
  }), false);
  assert.equal(isChampionInputSpeculationHit({ ...retained, start: {
    ...retained.start, randomizer: { type: "seven_bag", bag_state: ["L"] },
  } }, real), false);
  assert.equal(isChampionInputSpeculationHit(retained, {
    ...real, start: { ...real.start, hold: "T" },
  }), false);

  const exact = { ...retained, queuePrefix: 0 };
  assert.equal(isChampionInputSpeculationHit(exact, { execution, start: structuredClone(exact.start) }), true);
});

test("gated INPUT response validation requires truthful prefix search lengths only on that path", () => {
  const request = { execution: profile, start: { queue: Array(14).fill("I") } };
  const identity = JSON.stringify({ location: { type: "I", orientation: "spawn", x: 0, y: -2, usedHold: false }, spin: "none" });
  const response = {
    status: "move", profileId: profile.profileId,
    diagnostics: { finalOrderPolicyId: "cc2-rank-order/1" },
    search: { queueLength: 13, searchedQueueLength: 13 },
    selectedIdentity: identity,
    ranking: { rescueApplied: false, selectedCc2Rank: 0, identities: [identity], returnedIdentities: [identity],
      candidates: [{ cc2Rank: 0, solvent: true, solvency: 0 }] },
  };
  assertGatedChampionResponse(request, response, { allowQueuePrefix: true });
  assert.equal(championInputMoves(response, { allowQueuePrefix: true }).length, 1);
  assert.throws(() => championInputMoves(response), /unexpectedly reports a prefix/);
  assert.throws(() => assertGatedChampionResponse(request, response), /unexpectedly reports a prefix/);
  assert.throws(() => assertGatedChampionResponse(request, {
    ...response, search: { queueLength: 14, searchedQueueLength: 13 },
  }, { allowQueuePrefix: true }), /invalid searched queue length/);
});

test("beyond QUEUE 14 the prefix is the first k pieces of the new bag", () => {
  const { decision, request, response } = boundaryPosition();
  for (const [queueDepth, unseen] of [[14, 1], [15, 2], [16, 3], [20, 7]]) {
    const deep = createChampionInputRequest(decision, { requestId: "deep-source", profile, queueDepth });
    const predicted = predictChampionNextRequest(decision, deep, response, {
      profile, queueDepth, queueRefillsByBag: true, queuePrefixSpeculation: true,
    });
    assert.equal(predicted.queuePrefix, unseen, `QUEUE ${queueDepth}`);
    assert.deepEqual(predicted.request.start.queue, boundaryQueue.slice(1));
    assert.deepEqual(predicted.request.start.randomizer, { type: "seven_bag", bag_state: [] });
  }
  assert.equal(predictChampionNextRequest(decision, request, response, {
    profile, queueDepth: 16, queueRefillsByBag: true, queuePrefixSpeculation: false,
  }), null);
});

test("INPUT speculation hit accepts a k-piece prefix only with k distinct new pieces", () => {
  const execution = { profileId: profile.profileId, seed: profile.seed };
  const retained = {
    execution,
    queuePrefix: 3,
    start: { board: [[null]], queue: ["I", "O", "T"], hold: null, combo: 0, b2b: 0,
      randomizer: { type: "seven_bag", bag_state: [] } },
  };
  const real = (queue) => ({ execution: structuredClone(execution), start: { ...structuredClone(retained.start), queue } });
  assert.equal(isChampionInputSpeculationHit(retained, real(["I", "O", "T", "S", "Z", "J"])), true);
  assert.equal(isChampionInputSpeculationHit(retained, real(["I", "O", "T", "S", "Z"])), false);
  assert.equal(isChampionInputSpeculationHit(retained, real(["I", "O", "T", "S", "Z", "J", "L"])), false);
  assert.equal(isChampionInputSpeculationHit(retained, real(["I", "O", "T", "S", "Z", "S"])), false);
  assert.equal(isChampionInputSpeculationHit({ ...retained, queuePrefix: 1 }, real(["I", "O", "T", "S", "Z", "J"])), false);
  assert.equal(isChampionInputSpeculationHit({ ...retained, queuePrefix: 8 },
    real(["I", "O", "T", "S", "Z", "J", "L", "I", "O", "T", "S"])), false);
});

test("gated INPUT response validation reads the searched length off the k unseen pieces", () => {
  const request = { execution: profile, start: { queue: Array(16).fill("I") } };
  const identity = JSON.stringify({ location: { type: "I", orientation: "spawn", x: 0, y: -2, usedHold: false }, spin: "none" });
  const response = {
    status: "move", profileId: profile.profileId,
    diagnostics: { finalOrderPolicyId: "cc2-rank-order/1" },
    search: { queueLength: 13, searchedQueueLength: 13 },
    selectedIdentity: identity,
    ranking: { rescueApplied: false, selectedCc2Rank: 0, identities: [identity], returnedIdentities: [identity],
      candidates: [{ cc2Rank: 0, solvent: true, solvency: 0 }] },
  };
  assertGatedChampionResponse(request, response, { allowQueuePrefix: 3 });
  assert.equal(championInputMoves(response, { allowQueuePrefix: 3 }).length, 1);
  assert.throws(() => assertGatedChampionResponse(request, response, { allowQueuePrefix: 2 }), /invalid searched queue length/);
  assert.throws(() => assertGatedChampionResponse(request, response, { allowQueuePrefix: 8 }), /0\.\.7 unseen pieces/);
});

test("a first HOLD at the boundary leaves 12 public pieces, so one more piece is unseen", () => {
  const base = guiStateToCanonical(toS2GuiState(createGame(1)));
  const state = { ...base, pieces: { ...base.pieces, current: boundaryQueue[0], known: boundaryQueue.slice(1), hold: null, holdAvailable: true } };
  const decision = createS2AmountOnlyDecisionState(state);
  const move = analyzeSimpleS2FinalPlacements(state, { topN: 40 }).moves.find((candidate) => candidate.placement.usedHold);
  assert.ok(move, "fixture queue has a legal placement with HOLD");
  for (const [queueDepth, unseen] of [[14, 2], [16, 4], [20, 7]]) {
    const request = createChampionInputRequest(decision, { requestId: "hold-source", profile, queueDepth });
    const predicted = predictChampionNextRequest(decision, request, { status: "move", selectedPlacement: move.placement }, {
      profile, queueDepth, queueRefillsByBag: true, queuePrefixSpeculation: true,
    });
    assert.equal(predicted.queuePrefix, unseen, `QUEUE ${queueDepth}`);
    assert.deepEqual(predicted.request.start.queue, boundaryQueue.slice(2));
    assert.equal(predicted.request.start.hold, boundaryQueue[0]);
  }
});

// The real next position: the predicted lock, then the /2 refill of one new
// bag when fewer than 14 pieces (current included) remain.
function realNextRequest(decision, placement, queueDepth, newBag = [..."ZSJLTIO"]) {
  const state = { ...guiStateToCanonical(decisionStateToSyntheticGui(decision)), rulesetId: decision.rulesetId };
  const { nextState } = applyTransition(state, { kind: "placement", placement }, decision.rulesetId);
  const next = createS2AmountOnlyDecisionState(nextState);
  const publicQueue = [next.pieces.current, ...next.pieces.known];
  const refilled = publicQueue.length < 14
    ? { ...next, pieces: { ...next.pieces, known: [...next.pieces.known, ...newBag] } } : next;
  return createChampionInputRequest(championVisibleState(refilled, queueDepth), { requestId: "real", profile, queueDepth,
    bagState: "public-below-14", publicQueue: [refilled.pieces.current, ...refilled.pieces.known] });
}

test("below QUEUE 14 the predicted next start carries the public bag state of the real one", () => {
  const { decision, response } = boundaryPosition();
  const base = guiStateToCanonical(toS2GuiState(createGame(1)));
  const state = { ...base, pieces: { ...base.pieces, current: boundaryQueue[0], known: boundaryQueue.slice(1), hold: null, holdAvailable: true } };
  const holdMove = analyzeSimpleS2FinalPlacements(state, { topN: 40 }).moves.find((candidate) => candidate.placement.usedHold);
  assert.ok(holdMove, "fixture queue has a legal placement with HOLD");
  const publicQueue = [decision.pieces.current, ...decision.pieces.known];
  for (const [placement, label] of [[response.selectedPlacement, "lock"], [holdMove.placement, "first HOLD"]]) {
    for (const queueDepth of [2, 5, 6, 12]) {
      const request = createChampionInputRequest(championVisibleState(decision, queueDepth), { requestId: "below-source",
        profile, queueDepth, bagState: "public-below-14", publicQueue });
      const predicted = predictChampionNextRequest(decision, request, { status: "move", selectedPlacement: placement }, {
        profile, queueDepth, queueRefillsByBag: true, queuePrefixSpeculation: true, publicBagState: true,
      });
      assert.equal(predicted.queuePrefix, 0, `${label} QUEUE ${queueDepth}`);
      const real = realNextRequest(decision, placement, queueDepth);
      assert.equal(canonicalize(predicted.request.start), canonicalize(real.start), `${label} QUEUE ${queueDepth}`);
      assert.equal(isChampionInputSpeculationHit({ start: predicted.request.start, execution: predicted.request.execution,
        queuePrefix: 0 }, real), true, `${label} QUEUE ${queueDepth}`);
    }
  }
  // Non-empty after the lock at QUEUE 5 (the rest of the first bag after O T S Z J is L).
  const at5 = predictChampionNextRequest(decision, createChampionInputRequest(championVisibleState(decision, 5),
    { requestId: "below-source", profile, queueDepth: 5, bagState: "public-below-14", publicQueue }), response,
  { profile, queueDepth: 5, queueRefillsByBag: true, publicBagState: true });
  assert.deepEqual(at5.request.start.randomizer, { type: "seven_bag", bag_state: ["L"] });
  // Off keeps the empty bag state.
  const off = predictChampionNextRequest(decision, createChampionInputRequest(championVisibleState(decision, 5),
    { requestId: "below-source", profile, queueDepth: 5 }), response, { profile, queueDepth: 5, queueRefillsByBag: true });
  assert.deepEqual(off.request.start.randomizer, { type: "seven_bag", bag_state: [] });
});

test("QUEUE 13 after a first HOLD at 14 public pieces skips speculation with the public bag state", () => {
  const base = guiStateToCanonical(toS2GuiState(createGame(1)));
  const state = { ...base, pieces: { ...base.pieces, current: boundaryQueue[0], known: boundaryQueue.slice(1), hold: null, holdAvailable: true } };
  const decision = createS2AmountOnlyDecisionState(state);
  const move = analyzeSimpleS2FinalPlacements(state, { topN: 40 }).moves.find((candidate) => candidate.placement.usedHold);
  const response = { status: "move", selectedPlacement: move.placement };
  const publicQueue = [decision.pieces.current, ...decision.pieces.known];
  const on = createChampionInputRequest(championVisibleState(decision, 13), { requestId: "q13", profile, queueDepth: 13,
    bagState: "public-below-14", publicQueue });
  assert.equal(predictChampionNextRequest(decision, on, response, {
    profile, queueDepth: 13, queueRefillsByBag: true, queuePrefixSpeculation: true, publicBagState: true,
  }), null);
  const off = createChampionInputRequest(championVisibleState(decision, 13), { requestId: "q13", profile, queueDepth: 13 });
  assert.equal(predictChampionNextRequest(decision, off, response, {
    profile, queueDepth: 13, queueRefillsByBag: true, queuePrefixSpeculation: true,
  }).queuePrefix, 1);
});
