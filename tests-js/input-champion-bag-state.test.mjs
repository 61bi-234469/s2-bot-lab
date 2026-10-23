import assert from "node:assert/strict";
import test from "node:test";

import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { canonicalize } from "../scripts/cs1.mjs";
import { championVisibleState } from "../src-js/champion-parameters.mjs";
import { guiStateToCanonical } from "../src-js/gui-state.mjs";
import { createChampionInputRequest, publicSevenBagStateAfterQueue } from "../src-js/input-champion-decision.mjs";
import { createF14LeafConversionGatedProfile } from "../src-js/s2-f14-compat-browser.mjs";
import { createS2AmountOnlyDecisionState } from "../src-js/s2-amount-only-decision-state.mjs";

const profile = createF14LeafConversionGatedProfile({ scale: "0.25", maxHeight: "8" });

const twoBags = [..."IOTSZJL", ..."TSZIOLJ"];

test("public 7-bag state is the rest of the last searched piece's bag", () => {
  assert.deepEqual(publicSevenBagStateAfterQueue(twoBags, 14), []);
  assert.deepEqual(publicSevenBagStateAfterQueue(twoBags, 7), []);
  assert.deepEqual(publicSevenBagStateAfterQueue(twoBags, 10), ["I", "O", "L", "J"]);
  // A partial head bag (the current bag already partly used) aligns from the end.
  assert.deepEqual(publicSevenBagStateAfterQueue(twoBags.slice(3), 9), ["L", "J"]);
});

test("public 7-bag state refuses sequences that are not whole bags from the end", () => {
  assert.equal(publicSevenBagStateAfterQueue(["I", "I", "O"], 3), null);
  assert.equal(publicSevenBagStateAfterQueue([..."IOTSZJL", ..."TSZIOLL"], 10), null);
  assert.equal(publicSevenBagStateAfterQueue(twoBags, 0), null);
  assert.equal(publicSevenBagStateAfterQueue(twoBags, 15), null);
});

test("champion INPUT bagState accepts only empty, public or public-below-14", () => {
  assert.throws(() => createChampionInputRequest({}, { requestId: "r", bagState: "seed" }),
    /bagState must be empty, public or public-below-14/);
});

const publicQueue = [..."IOTSZJLTSZJLIO"];

function positionDecision(queue = publicQueue) {
  const base = guiStateToCanonical(toS2GuiState(createGame(1)));
  return createS2AmountOnlyDecisionState({ ...base,
    pieces: { ...base.pieces, current: queue[0], known: queue.slice(1), hold: null, holdAvailable: true } });
}

function belowRequest(decision, queueDepth, options = {}) {
  return createChampionInputRequest(championVisibleState(decision, queueDepth), { requestId: "below", profile, queueDepth,
    bagState: "public-below-14", publicQueue: [decision.pieces.current, ...decision.pieces.known], ...options });
}

test("below QUEUE 14 the public bag state is the rest of the cut queue's last bag", () => {
  const decision = positionDecision();
  for (const [queueDepth, rest] of [[2, ["T", "S", "Z", "J", "L"]], [5, ["J", "L"]], [6, ["L"]], [7, []],
    [10, ["J", "L", "I", "O"]], [13, ["O"]]]) {
    const request = belowRequest(decision, queueDepth);
    assert.equal(request.start.queue.length, queueDepth);
    assert.deepEqual(request.start.randomizer, { type: "seven_bag", bag_state: rest }, `QUEUE ${queueDepth}`);
  }
});

test("below QUEUE 14 the public bag state needs the public queue it was cut from", () => {
  const decision = positionDecision();
  assert.throws(() => belowRequest(decision, 6, { publicQueue: null }), /needs the public queue/);
  assert.throws(() => belowRequest(decision, 6, { publicQueue: [..."IOTSZ"] }), /needs the public queue/);
  assert.throws(() => belowRequest(decision, 6, { publicQueue: [..."IOTSZLJTSZJLIO"] }), /needs the public queue/);
  // A public queue that does not split into bags keeps the empty bag state.
  const unaligned = [..."IOTSZJLTSZJLII"];
  assert.deepEqual(belowRequest(positionDecision(unaligned), 6).start.randomizer, { type: "seven_bag", bag_state: [] });
});

test("QUEUE 14 and deeper requests keep their bytes with the below-14 bag state", () => {
  // At QUEUE 14 the diagnostic "public" fills in ["O"] for this queue; "public-below-14" must not.
  const queue = [..."LIOTSZJLTSZJLIO"];
  const decision = positionDecision(queue);
  for (const queueDepth of [14, 15, 20]) {
    const empty = createChampionInputRequest(championVisibleState(decision, queueDepth), { requestId: "below", profile, queueDepth });
    assert.equal(canonicalize(belowRequest(decision, queueDepth)), canonicalize(empty), `QUEUE ${queueDepth}`);
  }
  assert.deepEqual(createChampionInputRequest(decision, { requestId: "below", profile, queueDepth: 14, bagState: "public" })
    .start.randomizer.bag_state, ["O"]);
});
