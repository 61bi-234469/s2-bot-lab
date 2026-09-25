import assert from "node:assert/strict";
import test from "node:test";

import { createChampionInputRequest, publicSevenBagStateAfterQueue } from "../src-js/input-champion-decision.mjs";

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

test("champion INPUT bagState accepts only empty or public", () => {
  assert.throws(() => createChampionInputRequest({}, { requestId: "r", bagState: "seed" }), /bagState must be empty or public/);
});
