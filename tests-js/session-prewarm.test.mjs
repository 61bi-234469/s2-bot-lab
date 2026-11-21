// Round-start session preparation and the shared compiled WASM: the first decision finds the session it would have
// opened already started (same key), and a session made from a compiled module decides like one made from the bytes.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { createStaticCc2Runtime } from "../cc2-gui/static-host.mjs";
import { guiStateToCanonical } from "../src-js/gui-state.mjs";
import { createCc2WasmSession } from "../src-js/cc2-wasm-engine.mjs";
import { createCc2WasmWorkerSession } from "../src-js/cc2-wasm-worker-session.mjs";
import { createGuiInputMatchHandlers } from "../src-js/gui-input-match.mjs";
import { createNativeInputRuntime } from "../src-js/native-input-runtime.mjs";
import { createPublicCompatProfile, createPublicCompatRequest } from "../src-js/public-compat-request.mjs";

const wasmPath = resolve("bot/cold-clear-2-s2/target/wasm32-unknown-unknown/release/cold_clear_2_s2.wasm");

test("a session made from a compiled module decides like one made from the bytes, in process and in a worker",
  { skip: !existsSync(wasmPath), timeout: 180_000 }, async () => {
    const wasmBytes = readFileSync(wasmPath);
    const wasmModule = await WebAssembly.compile(wasmBytes);
    const fromBytes = await createCc2WasmSession({ wasmBytes });
    const fromModule = await createCc2WasmSession({ wasmModule });
    const worker = await createCc2WasmWorkerSession({ wasmModule });
    try {
      const profile = createPublicCompatProfile();
      const strip = (response) => { const copy = structuredClone(response); if (copy?.search?.reuse) delete copy.search.reuse.micros; return copy; };
      for (const seed of [31, 32, 33]) {
        const request = createPublicCompatRequest(guiStateToCanonical(toS2GuiState(createGame(seed))), { requestId: `m${seed}` });
        request.execution = structuredClone(profile);
        const expected = strip(await fromBytes.decideF14({ request, profile }));
        assert.equal(expected.status, "move");
        assert.deepEqual(strip(await fromModule.decideF14({ request, profile })), expected);
        assert.deepEqual(strip(await worker.decideF14({ request, profile })), expected);
      }
    } finally { await worker.close(); }
    await assert.rejects(createCc2WasmSession({ wasmModule: {} }), /WebAssembly.Module/);
  });

function recordingWorker(log, { refuseModule = false } = {}) {
  return class {
    postMessage(message) {
      if (refuseModule && message.payload?.wasmModule) throw Object.assign(new Error("cannot clone"), { name: "DataCloneError" });
      log.push({ type: message.type, resolverOnly: message.payload?.resolverOnly === true,
        module: message.payload?.wasmModule instanceof WebAssembly.Module });
      queueMicrotask(() => this.onmessage({ data: { id: message.id, ok: true,
        value: message.type === "decideF14" ? { status: "move" } : message.type === "suggest" ? { suggestion: { moves: [], move_info: {} } }
          : message.type === "resolveInput" ? { status: "planned" } : {} } }));
    }
    terminate() {}
  };
}

test("static runtime: prepared sessions are the ones the first decideF14, propose and resolveInput use", async () => {
  const log = [];
  const runtime = createStaticCc2Runtime({ WorkerType: recordingWorker(log) });
  try {
    await runtime.prepareSessions({ sessions: [
      { sessionKey: "r/left", type: "cc2-s2-champion", f14: true },
      { sessionKey: "r/right", type: "cc2-raw", f14: false, selectionLimit: 512, inputCandidates: true },
      { sessionKey: "", type: "cc2-raw" },
    ] });
    // Two engine workers and two resolution-only workers, nothing else.
    assert.equal(log.filter((m) => m.type === "init").length, 4);
    assert.equal(log.filter((m) => m.type === "init" && m.resolverOnly).length, 2);
    await runtime.decideF14({ sessionKey: "r/left", type: "cc2-s2-champion", engine: { botType: "cc2-s2-champion", engineId: "cc2-s2-champion" },
      request: {}, profile: {} });
    await runtime.propose({ sessionKey: "r/right", engine: "cc2-raw", state: { input_candidates: true }, selectionLimit: 512, thinkMs: null });
    await runtime.resolveInput({ request: { sessionKey: "r/left", type: "cc2-s2-champion" } });
    assert.equal(log.filter((m) => m.type === "init").length, 4, "no worker was started again");
    // Preparing a key that exists changes nothing.
    await runtime.prepareSessions({ sessions: [{ sessionKey: "r/left", type: "cc2-s2-champion", f14: true }] });
    assert.equal(log.filter((m) => m.type === "init").length, 4);
  } finally { await runtime.closeSessions(); }
});

test("static runtime hands each engine worker the page's compiled module, and falls back when it cannot be passed",
  { skip: !existsSync(wasmPath) }, async () => {
    const bytes = readFileSync(wasmPath);
    const originalFetch = globalThis.fetch;
    let fetches = 0;
    globalThis.fetch = async (url) => { fetches++; assert.match(String(url), /cold_clear_2_s2\.wasm$/); return new Response(bytes); };
    try {
      const log = [];
      const runtime = createStaticCc2Runtime({ WorkerType: recordingWorker(log) });
      const f14 = (key) => ({ sessionKey: key, type: "cc2-s2-champion", engine: { botType: "cc2-s2-champion", engineId: "cc2-s2-champion" }, request: {}, profile: {} });
      // The first worker does not wait for the page compile (it gets no module); once the compile is done, the next
      // workers get the module, and the page fetched the WASM once.
      await runtime.decideF14(f14("a"));
      for (let turn = 0; turn < 200; turn++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        await runtime.decideF14(f14(`b${turn}`));
        if (log.filter((m) => m.type === "init").at(-1).module) break;
      }
      const inits = log.filter((m) => m.type === "init");
      assert.equal(inits[0].module, false);
      assert.equal(inits.at(-1).module, true, "a later worker got the compiled module");
      assert.equal(fetches, 1, "the page fetched and compiled the WASM once");
      await runtime.closeSessions();
      const refusing = [];
      const fallback = createStaticCc2Runtime({ WorkerType: recordingWorker(refusing, { refuseModule: true }) });
      assert.equal((await fallback.decideF14(f14("c"))).status, "move");
      assert.deepEqual(refusing.filter((m) => m.type === "init").map((m) => m.module), [false]);
      await fallback.closeSessions();
    } finally { globalThis.fetch = originalFetch; }
  });

test("native runtime: a prepared F14 session is used by decideF14; an unavailable engine is left to the first decision", async () => {
  let created = 0;
  const runtime = createNativeInputRuntime({
    engineFor: (type) => { if (type === "cc2-raw") throw new Error("Raw CC2 binary not found"); return { botType: type, f14Core: true }; },
    f14SessionFor: async () => { created++; return { decideF14: async () => ({ status: "move" }), close: async () => {} }; },
  });
  try {
    await runtime.prepareSessions({ sessions: [
      { sessionKey: "k/left", type: "cc2-s2-champion", f14: true },
      { sessionKey: "k/right", type: "cc2-raw", f14: false, selectionLimit: 512, inputCandidates: true },
    ] });
    assert.equal(created, 1);
    const response = await runtime.decideF14({ sessionKey: "k/left", type: "cc2-s2-champion",
      engine: { botType: "cc2-s2-champion", engineId: "cc2-s2-champion" }, request: {}, profile: {} });
    assert.equal(response.status, "move");
    assert.equal(created, 1, "decideF14 used the prepared session");
    await assert.rejects(runtime.propose({ sessionKey: "k/right", engine: "cc2-raw", state: { input_candidates: true }, selectionLimit: 512, thinkMs: null }),
      /Raw CC2 binary not found/);
  } finally { await runtime.closeSessions(); }
});

test("an INPUT round prepares each bot side under the key and budget its first decision uses", async () => {
  const prepared = [];
  const runtime = {
    prepareSessions: async ({ sessions }) => { prepared.push(...sessions); },
    closeSessions: async () => {},
  };
  const handlers = createGuiInputMatchHandlers({ runtime });
  const start = await handlers.handle({ method: "POST", path: "/api/input-match/start", body: {
    left: "cc2-s2-champion", right: "cc2-chouhy", seed: 7, maxTurns: null,
    rightParameters: { selectionEnabled: true, selectionLimit: 1024 } } });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const keys = [`${start.body.sessionId}/left`, `${start.body.sessionId}/right`];
  assert.deepEqual(prepared, [
    { sessionKey: keys[0], type: "cc2-s2-champion", f14: true },
    { sessionKey: keys[1], type: "cc2-chouhy", f14: false, inputCandidates: true, selectionLimit: 1024 },
  ]);
  prepared.length = 0;
  const human = await handlers.handle({ method: "POST", path: "/api/input-match/start", body: {
    left: "human", right: "cc2-s2-champion-spsa-v10", seed: 8, maxTurns: null } });
  assert.equal(human.status, 200, JSON.stringify(human.body));
  assert.deepEqual(prepared.map((p) => p.type), ["cc2-s2-champion-spsa-v10"]);
});

test("static runtime: closing a round does not wait for a worker whose init never answers; unused prepared entries close when idle", async () => {
  const terminated = [];
  class SilentInit {
    constructor() { terminated.push(false); this.index = terminated.length - 1; }
    postMessage(message) { if (message.type !== "init") queueMicrotask(() => this.onmessage({ data: { id: message.id, ok: true, value: {} } })); }
    terminate() { terminated[this.index] = true; }
  }
  const runtime = createStaticCc2Runtime({ WorkerType: SilentInit });
  const preparing = runtime.prepareSessions({ sessions: [{ sessionKey: "s/left", type: "cc2-s2-champion", f14: true }] });
  await new Promise((resolve) => setImmediate(resolve));
  const closed = await Promise.race([runtime.closeSessions({ sessionKeys: ["s/left"] }).then(() => "closed"),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 2000))]);
  assert.equal(closed, "closed");
  assert.ok(terminated.length === 2 && terminated.every(Boolean), "both starting workers were ended");
  await preparing;

  const log = [];
  const idle = createStaticCc2Runtime({ WorkerType: recordingWorker(log), idleTimeoutMs: 20 });
  await idle.prepareSessions({ sessions: [{ sessionKey: "i/left", type: "cc2-s2-champion", f14: true }] });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await idle.decideF14({ sessionKey: "i/left", type: "cc2-s2-champion", engine: { botType: "cc2-s2-champion", engineId: "cc2-s2-champion" }, request: {}, profile: {} });
  // The idle entry was closed, so the decision started a new engine worker.
  assert.equal(log.filter((m) => m.type === "init" && !m.resolverOnly).length, 2);
  await idle.closeSessions();
});

test("static runtime: the threaded build starts without waiting for the page's single-thread compile", async () => {
  const originalFetch = globalThis.fetch;
  const hadIsolation = Object.hasOwn(globalThis, "crossOriginIsolated");
  const isolation = globalThis.crossOriginIsolated;
  globalThis.fetch = () => new Promise(() => {});
  globalThis.crossOriginIsolated = true;
  const sent = [];
  class Threaded {
    postMessage(message) { sent.push({ type: message.type, threaded: Boolean(message.payload?.threadedWasm), module: Boolean(message.payload?.wasmModule) });
      queueMicrotask(() => this.onmessage({ data: { id: message.id, ok: true, value: message.type === "decideF14" ? { status: "move" } : {} } })); }
    terminate() {}
  }
  try {
    const runtime = createStaticCc2Runtime({ WorkerType: Threaded });
    const response = await Promise.race([runtime.decideF14({ sessionKey: "t", type: "cc2-s2-champion",
      engine: { botType: "cc2-s2-champion", engineId: "cc2-s2-champion" }, request: {}, profile: {} }), new Promise((resolve) => setTimeout(() => resolve(null), 2000))]);
    assert.equal(response?.status, "move");
    assert.deepEqual(sent[0], { type: "init", threaded: true, module: false });
    await runtime.closeSessions();
  } finally {
    globalThis.fetch = originalFetch;
    if (hadIsolation) globalThis.crossOriginIsolated = isolation; else delete globalThis.crossOriginIsolated;
  }
});

test("static runtime: a page WASM fetch that never settles delays no worker; a late resolveInput starts no resolver", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => new Promise(() => {});
  try {
    const log = [];
    const runtime = createStaticCc2Runtime({ WorkerType: recordingWorker(log) });
    // Raw CC2's WASM has not been compiled by the page in this process.
    const first = runtime.propose({ sessionKey: "f/left", engine: "cc2-raw", state: { input_candidates: true }, selectionLimit: 512, thinkMs: null });
    const second = runtime.propose({ sessionKey: "f/right", engine: "cc2-raw", state: { input_candidates: true }, selectionLimit: 512, thinkMs: null });
    const outcome = await Promise.race([Promise.all([first, second]).then(() => "resolved"), new Promise((resolve) => setTimeout(() => resolve("pending"), 2000))]);
    assert.equal(outcome, "resolved");
    assert.deepEqual(log.filter((m) => m.type === "init").map((m) => m.module), [false, false]);
    await runtime.closeSessions();
  } finally { globalThis.fetch = originalFetch; }

  let releaseInit;
  const log = [];
  class HeldInit {
    postMessage(message) {
      log.push({ type: message.type, resolverOnly: message.payload?.resolverOnly === true });
      const reply = () => this.onmessage({ data: { id: message.id, ok: true, value: {} } });
      if (message.type === "init" && message.payload?.resolverOnly !== true) releaseInit = reply; else queueMicrotask(reply);
    }
    terminate() {}
  }
  const runtime = createStaticCc2Runtime({ WorkerType: HeldInit });
  const proposed = runtime.propose({ sessionKey: "g/left", engine: "cc2-s2-f14", state: {}, selectionLimit: 512, thinkMs: null }).catch(() => null);
  const resolved = runtime.resolveInput({ request: { sessionKey: "g/left", type: "cc2-s2-f14" } }).then(() => "resolved", (error) => error.message);
  for (let turn = 0; turn < 100 && releaseInit === undefined; turn++) await new Promise((resolve) => setImmediate(resolve));
  // Close removes the entry while the engine init is held: the pending init is rejected and its late reply is ignored,
  // so resolveInput fails without starting a resolver.
  const closing = runtime.closeSessions({ sessionKeys: ["g/left"] });
  releaseInit();
  await closing;
  assert.match(await resolved, /replaced|closed/);
  await proposed;
  assert.equal(log.filter((m) => m.resolverOnly).length, 0, "no resolver was started after the close");
});

test("an INPUT round start does not wait for its sessions to start", { timeout: 10_000 }, async () => {
  const runtime = { prepareSessions: () => new Promise(() => {}), closeSessions: async () => {} };
  const handlers = createGuiInputMatchHandlers({ runtime });
  const started = performance.now();
  const start = await handlers.handle({ method: "POST", path: "/api/input-match/start", body: {
    left: "cc2-s2-champion", right: "cc2-raw", seed: 9, maxTurns: null } });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  assert.ok(performance.now() - started < 1000);
  const closed = await handlers.handle({ method: "POST", path: "/api/input-match/close", body: { sessionId: start.body.sessionId } });
  assert.equal(closed.status, 200);
});
