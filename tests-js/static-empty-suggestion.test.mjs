import assert from "node:assert/strict";
import test from "node:test";
import { createGuiRequestHandlers } from "../src-js/gui-request-handlers.mjs";

function searchedEmpty() {
  return Object.assign(new Error("CC2 returned no suggested move"), {
    suggestionReceived: true,
    requestToSuggestionMs: 0.25,
    moveInfo: { selections: 1, nodes: 0, extra: "search complete", candidate_values: [] },
  });
}

function legalMove(state) {
  const piece = state.queue[0];
  return { suggestion: { moves: [{ location: {
    type: piece, orientation: "north", x: 4, y: piece === "I" ? 2 : 0,
  }, spin: "none" }] } };
}

test("verified Pages empty suggestion completes only the current legacy game", async () => {
  let calls = 0;
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose({ state }) {
      calls += 1;
      if (calls === 2) throw searchedEmpty();
      return legalMove(state);
    },
    async closeSessions() {},
  }, now: () => 0 });
  const started = await handlers.handle({ method: "POST", path: "/api/match/start", body: {
    left: "cc2-raw", right: "s2-simple", seed: 42, firstTo: 1,
  } });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const first = await handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const terminal = await handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  assert.equal(terminal.status, 200, JSON.stringify(terminal.body));
  assert.equal(terminal.body.outcome.complete, true);
  assert.equal(terminal.body.outcome.reason, "no-suggested-move");
});

test("malformed empty-suggestion evidence fails closed", async () => {
  let calls = 0;
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose({ state }) {
      calls += 1;
      if (calls === 2) throw "CC2 returned no suggested move";
      return legalMove(state);
    },
    async closeSessions() {},
  }, now: () => 0 });
  await handlers.handle({ method: "POST", path: "/api/match/start", body: {
    left: "cc2-raw", right: "s2-simple", seed: 43,
  } });
  await handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  const result = await handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  assert.equal(result.status, 422);
  assert.match(result.body.error, /CC2 returned no suggested move/);
});
