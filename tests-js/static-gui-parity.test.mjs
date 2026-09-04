import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("single analysis exposes every static CC2 engine", async () => {
  const html = await readFile(new URL("../cc2-gui/index.html", import.meta.url), "utf8");
  const analysis = html.match(/<select id="analysis-bot">([\s\S]*?)<\/select>/)?.[1] ?? "";
  const ids = [...analysis.matchAll(/value="(cc2-[^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(ids, ["cc2-raw", "cc2-chouhy", "cc2-s2", "cc2-s2-gen017", "cc2-s2-f11", "cc2-s2-f12", "cc2-s2-f14", "cc2-s2-f25", "cc2-s2-champion"]);
});

test("bot-vs-bot selectors expose the current development champion", async () => {
  const html = await readFile(new URL("../cc2-gui/index.html", import.meta.url), "utf8");
  for (const id of ["left-bot", "right-bot"]) {
    const select = html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`))?.[1] ?? "";
    assert.match(select, /value="cc2-s2-champion"/);
  }
});

test("bot-vs-bot exposes You (1P) only in the left-player selector", async () => {
  const html = await readFile(new URL("../cc2-gui/index.html", import.meta.url), "utf8");
  const right = html.match(/<select id="right-bot">([\s\S]*?)<\/select>/)?.[1] ?? "";
  assert.doesNotMatch(right, /value="human"/);
  assert.match(html, /LEFT BOTで <strong>You \(1P\)<\/strong> を選ぶ/);
});

test("bot-vs-bot defaults to a random seed and unlimited turns", async () => {
  const html = await readFile(new URL("../cc2-gui/index.html", import.meta.url), "utf8");
  assert.match(html, /<input id="match-seed"[^>]* disabled>/);
  assert.match(html, /<input id="match-random-seed" type="checkbox" checked>/);
  assert.match(html, /<input id="match-max-turns"[^>]* disabled>/);
  assert.match(html, /<input id="match-unlimited-turns" type="checkbox" checked>/);
});

test("static CC2 suggestion preserves the GUI response identity contract", async () => {
  let proposalRequest;
  const handlers = createGuiRequestHandlers({ proposeCc2: async (request) => { proposalRequest = request; return { suggestion: { moves: [{ location: { type: "T", orientation: "north", x: 0, y: 0 }, spin: "none" }], move_info: { nodes: 512, nps: 512 } }, peakMemoryBytes: 65536 }; } });
  const body = await request(handlers, "POST", "/api/suggest", { engine: "cc2-raw", state: {} });
  assert.equal(body.info.version, "deterministic-wasm-512");
  assert.equal(body.engine.botType, "cc2-raw");
  assert.equal(body.suggestion.move_info.nodes, 512);
  assert.equal(proposalRequest.selectionLimit, 512);
  assert.equal(proposalRequest.thinkMs, null);
});

test("static CC2 supports a time-only search budget", async () => {
  let proposalRequest;
  const handlers = createGuiRequestHandlers({ proposeCc2: async (request) => { proposalRequest = request; return { suggestion: { moves: [{}], move_info: {} }, peakMemoryBytes: 65536 }; } });
  const body = await request(handlers, "POST", "/api/suggest", { engine: "cc2-chouhy", state: {}, parameters: { selectionEnabled: false, thinkTimeEnabled: true, thinkMs: 250 } });
  assert.equal(body.info.version, "time-budgeted-wasm");
  assert.equal(proposalRequest.selectionLimit, null);
  assert.equal(proposalRequest.thinkMs, 250);
});

test("static matches expose the selected placement over the pre-lock board", async () => {
  const handlers = createGuiRequestHandlers();
  await request(handlers, "POST", "/api/match/start", {
    left: "s2-simple",
    right: "s2-simple",
    preLockPreview: true,
  });
  const stepped = await request(handlers, "POST", "/api/match/step");
  for (const bot of stepped.bots) {
    assert.ok(bot.preLockPreview);
    assert.ok(bot.preLockPreview.board.every((row) => row.every((cell) => cell === null)));
    assert.equal(typeof bot.preLockPreview.placement.piece, "string");
    assert.ok(bot.lastPlaced.length > 0);
  }
});
