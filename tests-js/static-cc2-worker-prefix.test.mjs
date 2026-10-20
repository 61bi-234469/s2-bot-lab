import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";

import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { createStaticCc2Runtime } from "../cc2-gui/static-host.mjs";
import { guiStateToCanonical } from "../src-js/gui-state.mjs";
import { createChampionInputRequest, predictChampionNextRequest } from "../src-js/input-champion-decision.mjs";
import { createS2AmountOnlyDecisionState } from "../src-js/s2-amount-only-decision-state.mjs";
import { createF14LeafConversionGatedProfile } from "../src-js/s2-f14-compat-browser.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));
const wasmPath = path("../bot/cold-clear-2-s2/target/wasm32-unknown-unknown/release/cold_clear_2_s2.wasm");
// What the Pages build copies next to the worker bundle.
const files = {
  "cold_clear_2_s2.wasm": wasmPath,
  "cc2-s2-spawn-integrity-substrate-v2.json": path("../fixtures/tuning/cc2-s2-spawn-integrity-substrate-v2.json"),
  "cc2-s2-spin-value-aligned.json": path("../fixtures/tuning/cc2-s2-spin-value-aligned.json"),
};
// Runs the real Pages worker module (cc2-gui/cc2-worker.mjs, unbundled) in a
// Node worker thread: `self` and `fetch` are the only browser globals it needs.
const shim = `
const { parentPort, workerData } = require("node:worker_threads");
const { readFile } = require("node:fs/promises");
globalThis.self = globalThis;
self.postMessage = (message) => parentPort.postMessage(message);
globalThis.fetch = async (url) => {
  const file = workerData.files[String(url).split("?")[0].split("/").pop()];
  if (!file) return { ok: false, status: 404 };
  const bytes = await readFile(file);
  return { ok: true, status: 200, text: async () => bytes.toString("utf8"),
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
};
const queued = [];
let ready = false;
parentPort.on("message", (data) => ready ? self.onmessage({ data }) : queued.push(data));
import(workerData.module).then(() => { ready = true; for (const data of queued.splice(0)) self.onmessage({ data }); });
`;
class PagesWorker {
  constructor() {
    this.worker = new NodeWorker(shim, { eval: true,
      workerData: { module: new URL("../cc2-gui/cc2-worker.mjs", import.meta.url).href, files } });
    this.worker.on("message", (data) => this.onmessage?.({ data }));
    this.worker.on("error", (error) => this.onerror?.({ message: error.message }));
  }
  postMessage(message) { this.worker.postMessage(message); }
  terminate() { void this.worker.terminate(); }
}

test("Pages worker serves the INPUT queue-prefix speculation and its longer-queue rerank", { skip: !existsSync(wasmPath), timeout: 120_000 }, async () => {
  const profile = createF14LeafConversionGatedProfile({ scale: "0.25", maxHeight: "8" });
  const queue = [..."IOTSZJLTSZJLIO"];
  const base = guiStateToCanonical(toS2GuiState(createGame(1)));
  const state = { ...base, pieces: { ...base.pieces, current: queue[0], known: queue.slice(1), hold: null, holdAvailable: true } };
  const decision = createS2AmountOnlyDecisionState(state);
  const move = analyzeSimpleS2FinalPlacements(state, { topN: 20 }).moves.find((candidate) => !candidate.placement.usedHold);
  const source = createChampionInputRequest(decision, { requestId: "pages-prefix-source", profile, queueDepth: 14 });
  const predicted = predictChampionNextRequest(decision, source, { status: "move", selectedPlacement: move.placement },
    { profile, queueDepth: 14, queueRefillsByBag: true, queuePrefixSpeculation: true });
  assert.equal(predicted.queuePrefix, 1);
  // The real next request: the refill revealed the first piece of the new bag.
  const real = structuredClone(predicted.request);
  real.requestId = "pages-prefix-real";
  real.start.queue.push("T");
  real.selector.pieces.known.push("T");

  const runtime = createStaticCc2Runtime({ WorkerType: PagesWorker });
  const type = "cc2-s2-champion";
  const call = (request) => ({ sessionKey: "right", type, engine: { botType: type, engineId: type }, request, profile: request.execution });
  try {
    assert.equal((await runtime.decideF14(call(source))).status, "move");
    const speculated = await runtime.speculateF14({ ...call(predicted.request), inputSpeculation: true });
    assert.equal(speculated.status, "move");
    const reranked = await runtime.rerankF14(call(real));
    assert.equal(reranked.status, "move", JSON.stringify(reranked).slice(0, 300));
    assert.equal(reranked.search.searchedQueueLength, 13);
    assert.equal(reranked.search.queueLength, 13);
  } finally {
    await runtime.closeSessions();
  }
});

test("Pages worker reranks a QUEUE 16 prefix search with the first three pieces of the new bag", { skip: !existsSync(wasmPath), timeout: 120_000 }, async () => {
  const profile = createF14LeafConversionGatedProfile({ scale: "0.25", maxHeight: "8" });
  const queue = [..."IOTSZJLTSZJLIO"];
  const base = guiStateToCanonical(toS2GuiState(createGame(1)));
  const state = { ...base, pieces: { ...base.pieces, current: queue[0], known: queue.slice(1), hold: null, holdAvailable: true } };
  const decision = createS2AmountOnlyDecisionState(state);
  const move = analyzeSimpleS2FinalPlacements(state, { topN: 20 }).moves.find((candidate) => !candidate.placement.usedHold);
  const source = createChampionInputRequest(decision, { requestId: "pages-prefix16-source", profile, queueDepth: 16 });
  const predicted = predictChampionNextRequest(decision, source, { status: "move", selectedPlacement: move.placement },
    { profile, queueDepth: 16, queueRefillsByBag: true, queuePrefixSpeculation: true });
  assert.equal(predicted.queuePrefix, 3);
  const real = structuredClone(predicted.request);
  real.requestId = "pages-prefix16-real";
  real.start.queue.push("T", "L", "I");
  real.selector.pieces.known.push("T", "L", "I");
  const repeated = structuredClone(real);
  repeated.requestId = "pages-prefix16-repeated";
  repeated.start.queue[15] = "T";
  repeated.selector.pieces.known[repeated.selector.pieces.known.length - 1] = "T";

  const runtime = createStaticCc2Runtime({ WorkerType: PagesWorker });
  const type = "cc2-s2-champion";
  const call = (request) => ({ sessionKey: "right", type, engine: { botType: type, engineId: type }, request, profile: request.execution });
  try {
    assert.equal((await runtime.decideF14(call(source))).status, "move");
    assert.equal((await runtime.speculateF14({ ...call(predicted.request), inputSpeculation: true })).status, "move");
    // A repeated piece cannot open a new bag: the retained search is refused.
    assert.notEqual((await runtime.rerankF14(call(repeated))).status, "move");
    const reranked = await runtime.rerankF14(call(real));
    assert.equal(reranked.status, "move", JSON.stringify(reranked).slice(0, 300));
    assert.equal(reranked.search.searchedQueueLength, 13);
    assert.equal(reranked.search.queueLength, 13);
  } finally {
    await runtime.closeSessions();
  }
});
