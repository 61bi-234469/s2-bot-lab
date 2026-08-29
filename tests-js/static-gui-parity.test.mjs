import assert from "node:assert/strict";
import test from "node:test";
import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { createGuiRequestHandlers } from "../src-js/gui-request-handlers.mjs";

async function request(handlers, method, path, body = null) {
  const result = await handlers.handle({ method, path, body });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

test("static handler exposes only browser-capable bots", async () => {
  const capabilities = await request(createGuiRequestHandlers(), "GET", "/api/bots");
  assert.ok(capabilities.bots.find((bot) => bot.id === "s2-simple" && bot.available));
  assert.ok(capabilities.bots.filter((bot) => bot.id.startsWith("cc2-")).every((bot) => !bot.available));
});

test("static handler answers the same pure API family used by the GUI", async () => {
  const handlers = createGuiRequestHandlers();
  const state = toS2GuiState(createGame(42));
  const simple = await request(handlers, "POST", "/api/simple-s2", { state, n: 1 });
  assert.equal(simple.moves.length, 1);
  const applied = await request(handlers, "POST", "/api/apply-s2", {
    engine: "s2-simple", state, move: simple.moves[0].placement,
  });
  assert.equal(applied.transition.lockResult.lines >= 0, true);
  const compared = await request(handlers, "POST", "/api/compare-simple", {
    baseline: applied.comparison,
    challenger: simple,
  });
  assert.equal(compared.contractId, "s2-same-position-comparison/1");
});
