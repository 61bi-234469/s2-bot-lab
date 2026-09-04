import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { createGuiRequestHandlers } from "../src-js/gui-request-handlers.mjs";
import { guiStateToCanonical } from "../src-js/gui-state.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";
import { applyHumanFinalPlacementUnderObservedS2 } from "../src-js/human-s2-adapter.mjs";
import { resolveStaticCc2Submission } from "../src-js/static-cc2-proposal.mjs";

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

test("bot-vs-bot selectors keep one automated-bot order and hide retired development variants", async () => {
  const html = await readFile(new URL("../cc2-gui/index.html", import.meta.url), "utf8");
  const optionsFor = (id) => html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`))?.[1] ?? "";
  const botIds = (id) => [...optionsFor(id).matchAll(/<option value="([^"]+)">/g)]
    .map((match) => match[1])
    .filter((botId) => botId !== "human");
  const expected = ["cc2-raw", "cc2-chouhy", "cc2-s2-gen017", "cc2-s2-f14", "cc2-s2-f25", "cc2-s2-champion", "s2-simple"];

  assert.deepEqual(botIds("left-bot"), expected);
  assert.deepEqual(botIds("right-bot"), expected);
  for (const id of ["left-bot", "right-bot"]) {
    assert.doesNotMatch(optionsFor(id), /value="cc2-s2"/);
    assert.doesNotMatch(optionsFor(id), /value="cc2-s2-f11"/);
    assert.doesNotMatch(optionsFor(id), /value="cc2-s2-f12"/);
  }
});

test("bot-vs-bot exposes You (1P) only in the left-player selector", async () => {
  const html = await readFile(new URL("../cc2-gui/index.html", import.meta.url), "utf8");
  const optionsFor = (id) => html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`))?.[1] ?? "";
  assert.match(optionsFor("left-bot"), /<option value="human">You \(1P\)<\/option>/);
  assert.doesNotMatch(optionsFor("right-bot"), /value="human"/);
  assert.match(html, /LEFT BOTで <strong>You \(1P\)<\/strong> を選ぶ/);
});

test("CC2 pace is bot-specific and the former match-wide pace toggle is absent", async () => {
  const html = await readFile(new URL("../cc2-gui/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /match-think-time-pace|THINK TIME PACE/);
  const capability = (await request(createGuiRequestHandlers({ proposeCc2: async () => ({}) }), "GET", "/api/bots"))
    .bots.find((bot) => bot.id === "cc2-raw");
  assert.deepEqual(capability.parameters.slice(0, 2).map(({ key, controlledBy }) => ({ key, controlledBy })), [
    { key: "ppsEnabled", controlledBy: undefined },
    { key: "pps", controlledBy: "ppsEnabled" },
  ]);
});

test("bot-vs-bot defaults to a random seed and unlimited turns", async () => {
  const html = await readFile(new URL("../cc2-gui/index.html", import.meta.url), "utf8");
  assert.match(html, /<input id="match-seed"[^>]* disabled>/);
  assert.match(html, /<input id="match-random-seed" type="checkbox" checked>/);
  assert.match(html, /<input id="match-max-turns"[^>]* disabled>/);
  assert.match(html, /<input id="match-unlimited-turns" type="checkbox" checked>/);
});

test("the 1P Reset key restarts every match state and rerolls RND", async () => {
  const app = await readFile(new URL("../cc2-gui/app.mjs", import.meta.url), "utf8");
  const keydown = app.slice(
    app.indexOf("function handleHumanKeyDown"),
    app.indexOf("function handleHumanKeyUp"),
  );
  assert.match(keydown, /requestHumanMatchRestart\(\)/);
  assert.doesNotMatch(keydown, /matchStarting \|\| matchRoundFinalization/);

  const restart = app.slice(
    app.indexOf("async function activateHumanMatchReset"),
    app.indexOf("function clearMatchArena"),
  );
  assert.match(restart, /if \(matchStartInFlight !== null\) await matchStartInFlight/);
  assert.match(restart, /if \(matchRoundFinalization !== null\) await matchRoundFinalization/);
  assert.match(restart, /excludedRandomSeed:[\s\S]*match-random-seed/);
  assert.match(restart, /rerollRandomSeed: true/);
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

test("static CC2 rejects disabling both search limits", async () => {
  const handlers = createGuiRequestHandlers({ proposeCc2: async () => { throw new Error("must not run"); } });
  const result = await handlers.handle({
    method: "POST",
    path: "/api/suggest",
    body: { engine: "cc2-raw", state: {}, parameters: { selectionEnabled: false, thinkTimeEnabled: false } },
  });
  assert.equal(result.status, 422);
  assert.match(result.body.error, /cannot both be disabled/);
});

test("static matches release both CC2 sessions after a proposal failure", async () => {
  const closed = [];
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose() { throw new Error("proposal failed"); },
    async closeSessions(options) { closed.push(options); },
  } });
  await request(handlers, "POST", "/api/match/start", { left: "cc2-raw", right: "s2-simple" });
  closed.length = 0;
  const result = await handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  assert.equal(result.status, 422);
  assert.match(result.body.error, /proposal failed/);
  assert.deepEqual(closed, [{ sessionKeys: ["left", "right"] }]);
});

test("static CC2 match pacing follows each bot PPS toggle and FAIR override", async () => {
  const selectionPaced = await request(createGuiRequestHandlers(), "POST", "/api/match/start", {
    left: "cc2-raw",
    right: "cc2-chouhy",
    leftParameters: { ppsEnabled: false, selectionEnabled: true, thinkTimeEnabled: false },
    rightParameters: { ppsEnabled: false, selectionEnabled: true, thinkTimeEnabled: false },
  });
  assert.equal(selectionPaced.nextStepFrames, 6);

  const realtimeSelectionPaced = await request(createGuiRequestHandlers(), "POST", "/api/match/start", {
    left: "human",
    right: "cc2-chouhy",
    rightParameters: { ppsEnabled: false, selectionEnabled: true, thinkTimeEnabled: false },
  });
  assert.equal(realtimeSelectionPaced.nextStepFrames, 3);

  const timePaced = await request(createGuiRequestHandlers(), "POST", "/api/match/start", {
    left: "cc2-raw",
    right: "cc2-chouhy",
    leftParameters: { ppsEnabled: false, selectionEnabled: false, thinkTimeEnabled: true, thinkMs: 250 },
    rightParameters: { ppsEnabled: false, selectionEnabled: false, thinkTimeEnabled: true, thinkMs: 250 },
  });
  assert.equal(timePaced.nextStepFrames, 15);

  const fair = await request(createGuiRequestHandlers(), "POST", "/api/match/start", {
    left: "cc2-raw",
    right: "cc2-chouhy",
    fairComparison: true,
    leftParameters: { ppsEnabled: true, selectionEnabled: false, selectionLimit: 999, thinkTimeEnabled: false },
    rightParameters: { ppsEnabled: true, selectionEnabled: false, selectionLimit: 999, thinkTimeEnabled: false },
  });
  assert.equal(fair.nextStepFrames, 60);
  for (const side of ["left", "right"]) {
    assert.equal(fair.botParameters[side].ppsEnabled, false);
    assert.equal(fair.botParameters[side].selectionEnabled, true);
    assert.equal(fair.botParameters[side].selectionLimit, 512);
    assert.equal(fair.botParameters[side].thinkTimeEnabled, false);
  }
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

test("static 1P keeps a human wall-clock lock while one shared bot step is in flight", async () => {
  let releaseProposal;
  let proposalStarted;
  let proposalCalls = 0;
  const started = new Promise((resolve) => { proposalStarted = resolve; });
  const proposalGate = new Promise((resolve) => { releaseProposal = resolve; });
  const cc2 = {
    async propose({ state }) {
      proposalCalls += 1;
      proposalStarted();
      await proposalGate;
      const piece = state.queue[0];
      return {
        suggestion: {
          moves: [{ location: { type: piece, orientation: "north", x: 4, y: piece === "I" ? 2 : 0 }, spin: "none" }],
          move_info: {},
        },
      };
    },
    async closeSessions() {},
  };
  const handlers = createGuiRequestHandlers({ cc2, now: () => 0, wait: async () => {} });
  const seed = 42;
  await request(handlers, "POST", "/api/match/start", {
    left: "human",
    right: "cc2-raw",
    seed,
    rightParameters: { ppsEnabled: true, pps: 1 },
  });

  const firstStep = handlers.handle({ method: "POST", path: "/api/match/step", body: { lockFrame: 0 } });
  const duplicateStep = handlers.handle({ method: "POST", path: "/api/match/step", body: { lockFrame: 0 } });
  await started;
  const initial = guiStateToCanonical(toS2GuiState(createGame(seed)));
  const placement = analyzeSimpleS2FinalPlacements(initial, { topN: 1 }).moves[0].placement;
  const human = await handlers.handle({
    method: "POST",
    path: "/api/match/human-lock",
    body: { lockFrame: 1001, placement },
  });
  assert.equal(human.status, 200, JSON.stringify(human.body));
  assert.equal(human.body.clock.logicalFrame, 1001);
  assert.equal(human.body.nextStepFrames, 1);

  releaseProposal();
  const [stepped, duplicated] = await Promise.all([firstStep, duplicateStep]);
  assert.equal(stepped.status, 200, JSON.stringify(stepped.body));
  assert.equal(duplicated.status, 200, JSON.stringify(duplicated.body));
  assert.equal(stepped.body.clock.logicalFrame, 1002);
  assert.equal(proposalCalls, 1);
});

test("static 1P lets a human lock pass optimistic resolution and retries the current state", async () => {
  let releaseProposal;
  let proposalStarted;
  let releaseResolution;
  let resolutionStarted;
  let releaseRetry;
  let retryStarted;
  const resolveRequests = [];
  let proposalCalls = 0;
  let resolveCalls = 0;
  const proposalGate = new Promise((resolve) => { releaseProposal = resolve; });
  const startedProposal = new Promise((resolve) => { proposalStarted = resolve; });
  const resolutionGate = new Promise((resolve) => { releaseResolution = resolve; });
  const startedResolution = new Promise((resolve) => { resolutionStarted = resolve; });
  const retryGate = new Promise((resolve) => { releaseRetry = resolve; });
  const startedRetry = new Promise((resolve) => { retryStarted = resolve; });
  const cc2 = {
    async propose({ state }) {
      proposalCalls += 1;
      proposalStarted();
      await proposalGate;
      const piece = state.queue[0];
      return { suggestion: { moves: [{ location: {
        type: piece,
        orientation: "north",
        x: 4,
        y: piece === "I" ? 2 : 0,
      }, spin: "none" }] } };
    },
    async resolve(input) {
      resolveCalls += 1;
      resolveRequests.push(structuredClone(input));
      if (resolveCalls === 1) {
        resolutionStarted();
        await resolutionGate;
      } else {
        retryStarted();
        await retryGate;
      }
      return resolveStaticCc2Submission(input);
    },
    async closeSessions() {},
  };
  const handlers = createGuiRequestHandlers({ cc2, now: () => 0, wait: async () => {} });
  const seed = 42;
  await request(handlers, "POST", "/api/match/start", {
    left: "human",
    right: "cc2-raw",
    seed,
    rightParameters: { ppsEnabled: true, pps: 1 },
  });

  const step = handlers.handle({ method: "POST", path: "/api/match/step", body: { lockFrame: 0 } });
  await startedProposal;
  const initial = guiStateToCanonical(toS2GuiState(createGame(seed)));
  const firstPlacement = analyzeSimpleS2FinalPlacements(initial, { topN: 1 }).moves[0].placement;
  const firstHuman = await handlers.handle({
    method: "POST",
    path: "/api/match/human-lock",
    body: { lockFrame: 1001, placement: firstPlacement },
  });
  assert.equal(firstHuman.status, 200, JSON.stringify(firstHuman.body));
  releaseProposal();
  await startedResolution;

  const rightAfterHuman = firstHuman.body.bots.find(({ id }) => id === "right");
  assert.equal(resolveRequests[0].sessionKey, "right");
  assert.equal(resolveRequests[0].type, "cc2-raw");
  assert.equal(resolveRequests[0].engine.engineId, "cc2-raw");
  assert.deepEqual(resolveRequests[0].gui.board, rightAfterHuman.board);
  assert.deepEqual(resolveRequests[0].gui.queue.slice(0, 7), [rightAfterHuman.current, ...rightAfterHuman.next]);
  assert.equal(resolveRequests[0].gui.s2.time.logicalFrame, firstHuman.body.clock.logicalFrame);

  const duplicate = handlers.handle({ method: "POST", path: "/api/match/step", body: { lockFrame: 0 } });
  const afterFirst = applyHumanFinalPlacementUnderObservedS2(initial, firstPlacement).transition.nextState;
  const secondPlacement = analyzeSimpleS2FinalPlacements(afterFirst, { topN: 1 }).moves[0].placement;
  let secondSettled = false;
  const secondHuman = handlers.handle({
    method: "POST",
    path: "/api/match/human-lock",
    body: { lockFrame: 1002, placement: secondPlacement },
  }).finally(() => { secondSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondSettled, true);
  const second = await secondHuman;
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal(second.body.turnNumber, 2);

  releaseResolution();
  await startedRetry;
  const afterSecond = applyHumanFinalPlacementUnderObservedS2(afterFirst, secondPlacement).transition.nextState;
  const thirdPlacement = analyzeSimpleS2FinalPlacements(afterSecond, { topN: 1 }).moves[0].placement;
  let thirdSettled = false;
  const thirdHuman = handlers.handle({
    method: "POST",
    path: "/api/match/human-lock",
    body: { lockFrame: 1003, placement: thirdPlacement },
  }).finally(() => { thirdSettled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(thirdSettled, false);
  releaseRetry();

  const [stepped, duplicated, third] = await Promise.all([step, duplicate, thirdHuman]);
  assert.equal(stepped.status, 200, JSON.stringify(stepped.body));
  assert.deepEqual(duplicated, stepped);
  assert.equal(third.status, 200, JSON.stringify(third.body));
  assert.equal(proposalCalls, 1);
  assert.equal(resolveCalls, 2);
  const rightAfterSecond = second.body.bots.find(({ id }) => id === "right");
  assert.deepEqual(resolveRequests[1].gui.board, rightAfterSecond.board);
  assert.equal(resolveRequests[1].gui.s2.time.logicalFrame, second.body.clock.logicalFrame);
  assert.equal(firstHuman.body.turnNumber, 1);
  assert.equal(stepped.body.turnNumber, 3);
  assert.equal(third.body.turnNumber, 4);
  assert.equal(third.body.bots.find(({ id }) => id === "left").stats.turns, 3);
  assert.equal(stepped.body.bots.find(({ id }) => id === "right").stats.turns, 1);
});

test("static 1P discards a stale failed optimistic resolution and retries locally", async () => {
  let releaseResolution;
  let resolutionStarted;
  let resolveCalls = 0;
  const gate = new Promise((resolve) => { releaseResolution = resolve; });
  const started = new Promise((resolve) => { resolutionStarted = resolve; });
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose({ state }) {
      const piece = state.queue[0];
      return { suggestion: { moves: [{ location: {
        type: piece,
        orientation: "north",
        x: 4,
        y: piece === "I" ? 2 : 0,
      }, spin: "none" }] } };
    },
    async resolve() {
      resolveCalls += 1;
      resolutionStarted();
      await gate;
      throw new Error("stale worker failure");
    },
    async closeSessions() {},
  }, now: () => 0, wait: async () => {} });
  const seed = 42;
  await request(handlers, "POST", "/api/match/start", {
    left: "human",
    right: "cc2-raw",
    seed,
    rightParameters: { ppsEnabled: true, pps: 1 },
  });

  const step = handlers.handle({ method: "POST", path: "/api/match/step", body: { lockFrame: 0 } });
  await started;
  const initial = guiStateToCanonical(toS2GuiState(createGame(seed)));
  const placement = analyzeSimpleS2FinalPlacements(initial, { topN: 1 }).moves[0].placement;
  const human = await handlers.handle({
    method: "POST",
    path: "/api/match/human-lock",
    body: { lockFrame: 1001, placement },
  });
  assert.equal(human.status, 200, JSON.stringify(human.body));
  releaseResolution();
  const stepped = await step;
  assert.equal(stepped.status, 200, JSON.stringify(stepped.body));
  assert.equal(stepped.body.turnNumber, 2);
  assert.equal(resolveCalls, 1);
  assert.equal(stepped.body.bots.find(({ id }) => id === "left").stats.turns, 1);
  assert.equal(stepped.body.bots.find(({ id }) => id === "right").stats.turns, 1);
});

test("static resolution failure is atomic and closes CC2 sessions", async () => {
  const closed = [];
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose({ state }) {
      const piece = state.queue[0];
      return { suggestion: { moves: [{ location: {
        type: piece,
        orientation: "north",
        x: 4,
        y: piece === "I" ? 2 : 0,
      }, spin: "none" }] } };
    },
    async resolve() { throw new Error("resolution failed"); },
    async closeSessions(options) { closed.push(options); },
  } });
  await request(handlers, "POST", "/api/match/start", { left: "cc2-raw", right: "s2-simple" });
  closed.length = 0;
  const before = await request(handlers, "GET", "/api/match/round");
  const failed = await handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  const after = await request(handlers, "GET", "/api/match/round");
  assert.equal(failed.status, 422);
  assert.match(failed.body.error, /resolution failed/);
  assert.deepEqual(after, before);
  assert.deepEqual(closed, [{ sessionKeys: ["left", "right"] }]);
});

test("static resolution rejects a wrong worker fingerprint without committing", async () => {
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose({ state }) {
      const piece = state.queue[0];
      return { suggestion: { moves: [{ location: {
        type: piece,
        orientation: "north",
        x: 4,
        y: piece === "I" ? 2 : 0,
      }, spin: "none" }] } };
    },
    async resolve(input) {
      return { ...resolveStaticCc2Submission(input), positionFingerprint: "wrong-state" };
    },
    async closeSessions() {},
  } });
  await request(handlers, "POST", "/api/match/start", { left: "cc2-raw", right: "s2-simple" });
  const before = await request(handlers, "GET", "/api/match/round");
  const failed = await handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  assert.equal(failed.status, 422);
  assert.match(failed.body.error, /stale transition/);
  assert.deepEqual(await request(handlers, "GET", "/api/match/round"), before);
});

test("closing a match invalidates an in-flight resolution before commit", async () => {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const startedGate = new Promise((resolve) => { started = resolve; });
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose({ state }) {
      const piece = state.queue[0];
      return { suggestion: { moves: [{ location: {
        type: piece,
        orientation: "north",
        x: 4,
        y: piece === "I" ? 2 : 0,
      }, spin: "none" }] } };
    },
    async resolve(input) {
      started();
      await gate;
      return resolveStaticCc2Submission(input);
    },
    async closeSessions() {},
  } });
  await request(handlers, "POST", "/api/match/start", { left: "cc2-raw", right: "s2-simple" });
  const stepping = handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  await startedGate;
  await request(handlers, "POST", "/api/match/close");
  release();
  const result = await stepping;
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "match-replaced");
  const round = await handlers.handle({ method: "GET", path: "/api/match/round" });
  assert.equal(round.status, 409);
});

test("starting a new match invalidates an in-flight old-session resolution", async () => {
  let release;
  let started;
  const gate = new Promise((resolve) => { release = resolve; });
  const startedGate = new Promise((resolve) => { started = resolve; });
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose({ state }) {
      const piece = state.queue[0];
      return { suggestion: { moves: [{ location: {
        type: piece,
        orientation: "north",
        x: 4,
        y: piece === "I" ? 2 : 0,
      }, spin: "none" }] } };
    },
    async resolve(input) {
      started();
      await gate;
      return resolveStaticCc2Submission(input);
    },
    async closeSessions() {},
  } });
  await request(handlers, "POST", "/api/match/start", { left: "cc2-raw", right: "s2-simple" });
  const oldStep = handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  await startedGate;
  const replacement = await request(handlers, "POST", "/api/match/start", {
    left: "s2-simple",
    right: "s2-simple",
    seed: 99,
  });
  assert.equal(replacement.turnNumber, 0);
  release();
  const stale = await oldStep;
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "match-replaced");
  const current = await request(handlers, "GET", "/api/match/round");
  assert.equal(current.players.every((player) => player.locks.length === 0), true);
});

test("an old proposal rejection cannot close a replacement match runtime", async () => {
  let rejectProposal;
  let proposalStarted;
  const gate = new Promise((resolve, reject) => { rejectProposal = reject; });
  const started = new Promise((resolve) => { proposalStarted = resolve; });
  const closed = [];
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose() {
      proposalStarted();
      return gate;
    },
    async closeSessions(options) { closed.push(options); },
  } });
  await request(handlers, "POST", "/api/match/start", { left: "cc2-raw", right: "s2-simple" });
  const oldStep = handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  await started;
  await request(handlers, "POST", "/api/match/start", {
    left: "s2-simple",
    right: "s2-simple",
    seed: 100,
  });
  closed.length = 0;
  rejectProposal(new Error("old proposal stopped"));
  const stale = await oldStep;
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "match-replaced");
  assert.deepEqual(closed, []);
  const replacementStep = await request(handlers, "POST", "/api/match/step", {});
  assert.equal(replacementStep.turnNumber, 1);
});

test("close accepted during start prevents the pending start from publishing a session", async () => {
  let releaseFirstClose;
  let firstCloseStarted;
  let calls = 0;
  const firstClose = new Promise((resolve) => { releaseFirstClose = resolve; });
  const started = new Promise((resolve) => { firstCloseStarted = resolve; });
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose() { throw new Error("not used"); },
    async closeSessions() {
      calls += 1;
      if (calls === 1) {
        firstCloseStarted();
        await firstClose;
      }
    },
  } });
  const starting = handlers.handle({
    method: "POST",
    path: "/api/match/start",
    body: { left: "s2-simple", right: "s2-simple", seed: 1 },
  });
  await started;
  await request(handlers, "POST", "/api/match/close");
  releaseFirstClose();
  const staleStart = await starting;
  assert.equal(staleStart.status, 409);
  assert.equal(staleStart.body.error, "match-replaced");
  assert.equal((await handlers.handle({ method: "GET", path: "/api/match/round" })).status, 409);
});

test("the latest of two concurrent starts owns the published session", async () => {
  let releaseFirstClose;
  let firstCloseStarted;
  let calls = 0;
  const firstClose = new Promise((resolve) => { releaseFirstClose = resolve; });
  const started = new Promise((resolve) => { firstCloseStarted = resolve; });
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose() { throw new Error("not used"); },
    async closeSessions() {
      calls += 1;
      if (calls === 1) {
        firstCloseStarted();
        await firstClose;
      }
    },
  } });
  const first = handlers.handle({
    method: "POST",
    path: "/api/match/start",
    body: { left: "s2-simple", right: "s2-simple", seed: 1 },
  });
  await started;
  const latest = await request(handlers, "POST", "/api/match/start", {
    left: "s2-simple",
    right: "s2-simple",
    seed: 2,
  });
  assert.equal(latest.config.seed, 2);
  releaseFirstClose();
  const stale = await first;
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "match-replaced");
  const stepped = await request(handlers, "POST", "/api/match/step", {});
  assert.equal(stepped.config.seed, 2);
});

test("same-frame bots resolve one snapshot and commit only after all resolutions finish", async () => {
  let bothStarted;
  let releaseRight;
  const startedGate = new Promise((resolve) => { bothStarted = resolve; });
  const rightGate = new Promise((resolve) => { releaseRight = resolve; });
  const resolveInputs = [];
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose({ state }) {
      const piece = state.queue[0];
      return { suggestion: { moves: [{ location: {
        type: piece,
        orientation: "north",
        x: 4,
        y: piece === "I" ? 2 : 0,
      }, spin: "none" }] } };
    },
    async resolve(input) {
      resolveInputs.push(structuredClone(input));
      if (resolveInputs.length === 2) bothStarted();
      if (input.sessionKey === "right") await rightGate;
      return resolveStaticCc2Submission(input);
    },
    async closeSessions() {},
  } });
  await request(handlers, "POST", "/api/match/start", {
    left: "cc2-raw",
    right: "cc2-chouhy",
    seed: 55,
  });
  const before = await request(handlers, "GET", "/api/match/round");
  const stepping = handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  await startedGate;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await request(handlers, "GET", "/api/match/round"), before);
  assert.equal(resolveInputs[0].gui.s2.time.logicalFrame, resolveInputs[1].gui.s2.time.logicalFrame);
  releaseRight();
  const stepped = await stepping;
  assert.equal(stepped.status, 200, JSON.stringify(stepped.body));
  assert.equal(stepped.body.turnNumber, 1);
  assert.equal(stepped.body.bots.every((bot) => bot.stats.turns === 1), true);
});

test("worker and main-thread resolution routes keep fixed-selection match semantics", async () => {
  const run = async (workerResolution) => {
    let resolveCalls = 0;
    const cc2 = {
      async propose({ state }) {
        const piece = state.queue[0];
        return { suggestion: { moves: [{ location: {
          type: piece,
          orientation: "north",
          x: 4,
          y: piece === "I" ? 2 : 0,
        }, spin: "none" }] } };
      },
      async closeSessions() {},
    };
    if (workerResolution) cc2.resolve = async (input) => {
      resolveCalls += 1;
      return resolveStaticCc2Submission(input);
    };
    const handlers = createGuiRequestHandlers({ cc2 });
    await request(handlers, "POST", "/api/match/start", {
      left: "cc2-raw",
      right: "s2-simple",
      seed: 77,
      leftParameters: { ppsEnabled: false, selectionEnabled: true, selectionLimit: 512, thinkTimeEnabled: false },
    });
    const step = await request(handlers, "POST", "/api/match/step", {});
    const round = await request(handlers, "GET", "/api/match/round");
    delete step.replayMeta.ts;
    return { resolveCalls, step, round };
  };
  const fallback = await run(false);
  const worker = await run(true);
  assert.equal(fallback.resolveCalls, 0);
  assert.equal(worker.resolveCalls, 1);
  assert.deepEqual(worker.step, fallback.step);
  assert.deepEqual(worker.round, fallback.round);
});

test("static bot-only match starts same-frame proposals in parallel", async () => {
  let started = 0;
  let bothStarted;
  let release;
  const startedGate = new Promise((resolve) => { bothStarted = resolve; });
  const releaseGate = new Promise((resolve) => { release = resolve; });
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose({ state }) {
      started += 1;
      if (started === 2) bothStarted();
      await releaseGate;
      const piece = state.queue[0];
      return { suggestion: { moves: [{ location: { type: piece, orientation: "north", x: 4, y: piece === "I" ? 2 : 0 }, spin: "none" }] } };
    },
    async closeSessions() {},
  } });
  await request(handlers, "POST", "/api/match/start", { left: "cc2-raw", right: "cc2-chouhy" });
  const stepping = handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  await startedGate;
  assert.equal(started, 2);
  release();
  const result = await stepping;
  assert.equal(result.status, 200, JSON.stringify(result.body));
});

test("static bot-only caps PPS-on think time but 1P keeps the configured budget", async () => {
  const observed = [];
  const cc2 = {
    async propose({ state, thinkMs }) {
      observed.push(thinkMs);
      const piece = state.queue[0];
      return { suggestion: { moves: [{ location: { type: piece, orientation: "north", x: 4, y: piece === "I" ? 2 : 0 }, spin: "none" }] } };
    },
    async closeSessions() {},
  };
  const botOnly = createGuiRequestHandlers({ cc2 });
  await request(botOnly, "POST", "/api/match/start", {
    left: "cc2-raw", right: "s2-simple",
    leftParameters: { ppsEnabled: true, pps: 4, thinkTimeEnabled: true, thinkMs: 250 },
    rightParameters: { pps: 4 },
  });
  await request(botOnly, "POST", "/api/match/step", {});
  assert.equal(observed.shift(), 175);

  const onePlayer = createGuiRequestHandlers({ cc2, now: () => 0, wait: async () => {} });
  await request(onePlayer, "POST", "/api/match/start", {
    left: "human", right: "cc2-raw",
    rightParameters: { ppsEnabled: true, pps: 4, thinkTimeEnabled: true, thinkMs: 250 },
  });
  await request(onePlayer, "POST", "/api/match/step", { lockFrame: 0 });
  assert.equal(observed.shift(), 250);
});

test("fixed-selection bot-only rounds remain byte-identical for the same seed and settings", async () => {
  const run = async () => {
    const handlers = createGuiRequestHandlers({ cc2: {
      async propose({ state }) {
        const piece = state.queue[0];
        return { suggestion: { moves: [{ location: { type: piece, orientation: "north", x: 4, y: piece === "I" ? 2 : 0 }, spin: "none" }] } };
      },
      async closeSessions() {},
    } });
    await request(handlers, "POST", "/api/match/start", {
      left: "cc2-raw",
      right: "cc2-chouhy",
      seed: 77,
      leftParameters: { ppsEnabled: false, selectionEnabled: true, selectionLimit: 512, thinkTimeEnabled: false },
      rightParameters: { ppsEnabled: false, selectionEnabled: true, selectionLimit: 512, thinkTimeEnabled: false },
    });
    await request(handlers, "POST", "/api/match/step", {});
    return request(handlers, "GET", "/api/match/round");
  };
  assert.equal(JSON.stringify(await run()), JSON.stringify(await run()));
});
