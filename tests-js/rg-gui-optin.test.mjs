// RG (EXPERIMENTAL), the GUI opt-in: the setting (src-js/bot-parameters.mjs RG_PARAMETER) and the spike pools an
// INPUT round owns (src-js/gui-input-match.mjs championRgSpikeFactory). Self-contained: no WASM or engine is run.
import test from "node:test";
import assert from "node:assert/strict";
import { createGuiInputMatchHandlers } from "../src-js/gui-input-match.mjs";

const championParameters = (rgEnabled) => ({ ppsEnabled: true, pps: 1, selectionEnabled: true, selectionLimit: 2048, thinkTimeEnabled: false,
  thinkMs: 250, queueDepth: 14, ...(rgEnabled ? { rgEnabled: true } : {}) });
const startBody = (left, right, extra = {}) => ({ left: "cc2-s2-champion", right: "cc2-s2-champion", seed: 7, maxTurns: null,
  leftParameters: championParameters(left), rightParameters: championParameters(right), ...extra });
const start = (handlers, body) => handlers.handle({ method: "POST", path: "/api/input-match/start", body });
const fakePool = (id, closed) => ({ id, request: async () => assert.fail("not searched"), close: async () => { closed.push(id); } });

test("RG (EXPERIMENTAL): only the current champion offers it, off by default and left out while off; FAIR turns it off", async () => {
  const { RG_PARAMETER, defaultBotParameters, normalizeBotParameters, fairComparisonBotParameters, botParameterCapability } = await import("../src-js/bot-parameters.mjs");
  assert.equal(RG_PARAMETER.defaultValue, false);
  assert.equal(Object.hasOwn(defaultBotParameters("cc2-s2-champion"), "rgEnabled"), false);
  assert.equal(Object.hasOwn(normalizeBotParameters("cc2-s2-champion", { rgEnabled: false }), "rgEnabled"), false);
  assert.equal(normalizeBotParameters("cc2-s2-champion", { rgEnabled: true }).rgEnabled, true);
  assert.equal(Object.hasOwn(fairComparisonBotParameters("cc2-s2-champion", { rgEnabled: true }), "rgEnabled"), false);
  assert.ok(botParameterCapability("cc2-s2-champion").parameters.some((p) => p.key === "rgEnabled"));
  for (const former of ["cc2-s2-champion-spsa-v10", "cc2-s2-champion-spsa-v7", "cc2-s2-champion-tree-reuse", "cc2-s2-champion-profile-b"]) {
    assert.throws(() => normalizeBotParameters(former, { rgEnabled: true }), /unsupported .* parameter rgEnabled/);
  }
});

test("RG (EXPERIMENTAL): a round starts a pool per ON side and closes it when replaced or closed; OFF starts none", async () => {
  const runtime = { closeSessions: async () => {} };
  const started = [], closed = [];
  const factory = async (id) => { const pool = { id, request: async () => assert.fail("not searched"), close: async () => { closed.push(id); } }; started.push(id); return pool; };
  const handlers = createGuiInputMatchHandlers({ runtime, championRgSpikeFactory: factory });
  const champion = (rgEnabled) => ({ ppsEnabled: true, pps: 1, selectionEnabled: true, selectionLimit: 2048, thinkTimeEnabled: false, thinkMs: 250, queueDepth: 14,
    ...(rgEnabled ? { rgEnabled: true } : {}) });
  const start = (left, right) => handlers.handle({ method: "POST", path: "/api/input-match/start",
    body: { left: "cc2-s2-champion", right: "cc2-s2-champion", seed: 7, maxTurns: null, leftParameters: champion(left), rightParameters: champion(right) } });
  const off = await start(false, false);
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.deepEqual(started, []);
  assert.equal(off.body.bots.some((b) => b.inputExecution.rg), false);
  const one = await start(false, true);
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.deepEqual(started, ["right"]);
  assert.ok(one.body.bots[1].inputExecution.rg && !one.body.bots[0].inputExecution.rg);
  // A new round (an FT game or a restart) replaces the round and closes its pool.
  const both = await start(true, true);
  assert.equal(both.status, 200, JSON.stringify(both.body));
  assert.deepEqual(closed, ["right"]);
  assert.deepEqual(started, ["right", "left", "right"]);
  await handlers.handle({ method: "POST", path: "/api/input-match/close", body: { sessionId: both.body.sessionId } });
  assert.deepEqual(closed.sort(), ["left", "right", "right"]);
});

test("RG (EXPERIMENTAL): a host without a pool refuses it, and a pool that cannot start fails the start and closes the others", async () => {
  const runtime = { closeSessions: async () => {} };
  const params = { ppsEnabled: true, pps: 1, selectionEnabled: true, selectionLimit: 2048, thinkTimeEnabled: false, thinkMs: 250, queueDepth: 14, rgEnabled: true };
  const body = { left: "cc2-s2-champion", right: "cc2-s2-champion", seed: 7, maxTurns: null, leftParameters: params, rightParameters: params };
  const none = await createGuiInputMatchHandlers({ runtime }).handle({ method: "POST", path: "/api/input-match/start", body });
  assert.notEqual(none.status, 200);
  assert.match(JSON.stringify(none.body), /RG \(EXPERIMENTAL\) is unavailable on this host/);
  const closed = [];
  const failing = createGuiInputMatchHandlers({ runtime, championRgSpikeFactory: async (id) => {
    if (id === "right") throw new Error("no workers");
    return { request: async () => assert.fail("not searched"), close: async () => { closed.push(id); } };
  } });
  const refused = await failing.handle({ method: "POST", path: "/api/input-match/start", body });
  assert.notEqual(refused.status, 200);
  assert.match(JSON.stringify(refused.body), /RG \(EXPERIMENTAL\) could not start: no workers/);
  assert.deepEqual(closed, ["left"]);
});

test("RG (EXPERIMENTAL): a start replaced while its pools are starting closes them and fails", async () => {
  const closed = [];
  let release = null;
  const gate = new Promise((resolve) => { release = resolve; });
  const handlers = createGuiInputMatchHandlers({ runtime: { closeSessions: async () => {} },
    championRgSpikeFactory: async (id) => { await gate; return fakePool(id, closed); } });
  const first = start(handlers, startBody(false, true));
  await new Promise((resolve) => setImmediate(resolve));
  const second = await start(handlers, startBody(false, false));
  assert.equal(second.status, 200, JSON.stringify(second.body));
  release();
  const replaced = await first;
  assert.notEqual(replaced.status, 200);
  assert.match(JSON.stringify(replaced.body), /match-replaced/);
  assert.deepEqual(closed, ["right"]);
});

test("RG (EXPERIMENTAL): a start that fails after its pools started closes them", async () => {
  const closed = [];
  const handlers = createGuiInputMatchHandlers({ runtime: { closeSessions: async () => {} },
    championRgSpikeFactory: async (id) => fakePool(id, closed) });
  const refused = await start(handlers, startBody(true, true, { seed: -1 }));
  assert.notEqual(refused.status, 200);
  assert.deepEqual(closed.sort(), ["left", "right"]);
  // The handlers stay usable: a later start runs with fresh pools.
  const next = await start(handlers, startBody(false, true));
  assert.equal(next.status, 200, JSON.stringify(next.body));
});
