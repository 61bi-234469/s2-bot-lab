import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { createGuiRequestHandlers } from "../src-js/gui-request-handlers.mjs";
import { guiStateToCanonical } from "../src-js/gui-state.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";
import { applyHumanFinalPlacementUnderObservedS2 } from "../src-js/human-s2-adapter.mjs";
import { resolveGuiStaticSubmission as resolveQualifiedStaticCc2Submission } from "../src-js/gui-static-public-resolver.mjs";
import { cc2MoveToCanonicalPlacement } from "../src-js/cc2-s2-adapter.mjs";
import { canonicalize } from "../scripts/cs1.mjs";
import { INPUT_BOT_PROFILES } from "../src-js/input-bot-contract.mjs";

const LEGACY_STATIC_ENGINE = "cc2-raw";

function fakeF14Decision({ request }) {
  const piece = request.start.queue[0];
  const selectedMove = { location: {
    type: piece, orientation: "north", x: 4, y: piece === "I" ? 2 : 0,
  }, spin: "none" };
  const selectedPlacement = cc2MoveToCanonicalPlacement({ queue: [piece] }, selectedMove);
  const selectedIdentity = canonicalize(selectedMove);
  return {
    type: "f14_decision", schemaVersion: 1, requestId: request.requestId,
    positionId: request.positionId, generation: request.generation,
    profileId: request.execution.profileId, status: "move", reason: "selection-budget",
    execution: structuredClone(request.execution),
    boundaryAudit: { externalStrategicReselectCalls: 0, legacyF14RescueCalls: 0, legacyF14SelectionCalls: 0 },
    search: { requestedSelections: request.execution.budget.selections, actualSelections: request.execution.budget.selections },
    selectedMove, selectedIdentity, selectedPlacement,
    ranking: { identities: [selectedIdentity] },
  };
}

async function request(handlers, method, path, body = null) {
  const result = await handlers.handle({ method, path, body });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function exerciseStaleOnePlayerProposal(makeSecondError) {
  let proposalCalls = 0;
  let releaseSecondProposal;
  let secondProposalStarted;
  let closed = 0;
  const secondProposalGate = new Promise((resolve) => { releaseSecondProposal = resolve; });
  const startedGate = new Promise((resolve) => { secondProposalStarted = resolve; });
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose({ state }) {
      proposalCalls += 1;
      if (proposalCalls === 2) {
        secondProposalStarted();
        await secondProposalGate;
        throw makeSecondError();
      }
      const piece = state.queue[0];
      return { suggestion: { moves: [{ location: {
        type: piece, orientation: "north", x: proposalCalls === 1 ? 4 : 1, y: piece === "I" ? 2 : 0,
      }, spin: "none" }] } };
    },
    async closeSessions() { closed += 1; },
  }, now: () => 0, wait: async () => {} });
  const seed = 42;
  await request(handlers, "POST", "/api/match/start", {
    left: "human",
    right: LEGACY_STATIC_ENGINE,
    seed,
    rightParameters: { ppsEnabled: true, pps: 1 },
  });
  closed = 0;

  const first = await request(handlers, "POST", "/api/match/step", { lockFrame: 0 });
  assert.equal(first.turnNumber, 1);
  const initial = guiStateToCanonical(toS2GuiState(createGame(seed)));
  const firstPlacement = analyzeSimpleS2FinalPlacements(initial, { topN: 1 }).moves[0].placement;
  const firstHuman = await request(handlers, "POST", "/api/match/human-lock", {
    lockFrame: 1001, placement: firstPlacement,
  });
  assert.equal(firstHuman.turnNumber, 2);

  const staleStep = handlers.handle({ method: "POST", path: "/api/match/step", body: { lockFrame: 0 } });
  await startedGate;
  const afterFirst = applyHumanFinalPlacementUnderObservedS2(initial, firstPlacement).transition.nextState;
  const secondPlacement = analyzeSimpleS2FinalPlacements(afterFirst, { topN: 1 }).moves[0].placement;
  const secondHuman = await request(handlers, "POST", "/api/match/human-lock", {
    lockFrame: 1002, placement: secondPlacement,
  });
  assert.equal(secondHuman.turnNumber, 3);

  releaseSecondProposal();
  const stale = await staleStep;
  assert.equal(stale.status, 200, JSON.stringify(stale.body));
  assert.equal(stale.body.turnNumber, 3);
  assert.equal(stale.body.outcome.complete, false);
  assert.equal(closed, 0);

  const fresh = await request(handlers, "POST", "/api/match/step", { lockFrame: 0 });
  assert.equal(fresh.turnNumber, 4);
  assert.equal(fresh.outcome.complete, false);
  assert.equal(proposalCalls, 3);
  assert.equal(closed, 0);
}

test("static handler lists exactly the INPUT bots and You, unavailable without WASM", async () => {
  const capabilities = await request(createGuiRequestHandlers(), "GET", "/api/bots");
  assert.deepEqual(capabilities.bots.map((bot) => bot.id), ["cc2-raw", "cc2-chouhy", "cc2-s2-f14", "cc2-s2-champion-legacy", "cc2-s2-champion", "human"]);
  assert.ok(capabilities.bots.filter((bot) => bot.id.startsWith("cc2-")).every((bot) => !bot.available));
});

test("static match records a verified stall penalty top-out", async () => {
  const handlers = createGuiRequestHandlers();
  await request(handlers, "POST", "/api/match/start", {
    left: "human",
    right: "s2-simple",
    seed: 42,
  });

  const terminal = await request(handlers, "POST", "/api/match/human-penalty-topout", {
    penaltyRows: 20,
  });
  assert.equal(terminal.status, "complete");
  assert.deepEqual(terminal.outcome, {
    complete: true,
    reason: "top-out",
    winnerBotId: "right",
  });

  const round = await request(handlers, "GET", "/api/match/round");
  assert.equal(round.result.winnerId, "right");
  assert.deepEqual(round.result.reasons, { left: "top-out", right: "winner" });
});

test("static match rejects an unverified stall penalty top-out", async () => {
  const handlers = createGuiRequestHandlers();
  await request(handlers, "POST", "/api/match/start", {
    left: "human",
    right: "s2-simple",
    seed: 42,
  });

  const result = await handlers.handle({
    method: "POST",
    path: "/api/match/human-penalty-topout",
    body: { penaltyRows: 1 },
  });
  assert.equal(result.status, 422);
  assert.equal(result.body.error, "stall penalty rows do not top out the player");
});

test("retired static export directs users to input mode instead of claiming local-only support", async () => {
  const result = await createGuiRequestHandlers().handle({ method: "GET", path: "/api/match/ttrm" });
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { stage: "input-required", message: "Use an input-mode match to save .ttrm" });
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

test("retired family bots are rejected as unsupported by live GUI routes", async () => {
  const handlers = createGuiRequestHandlers({ proposeCc2: async () => assert.fail("must not search") });
  for (const engine of ["cc2-s2-f11", "cc2-s2-f12", "cc2-s2-f25"]) {
    // Retired ids now take the shape unknown CC2 ids always had on each route: /api/suggest
    // throws before any route logic runs, /api/apply-s2 and match start map it to a status.
    await assert.rejects(handlers.handle({ method: "POST", path: "/api/suggest", body: { engine } }),
      new RegExp(`^Error: unsupported CC2 engine ${engine}$`));
    const applied = await handlers.handle({ method: "POST", path: "/api/apply-s2", body: { engine } });
    assert.deepEqual(applied, { status: 422, body: { error: `unsupported CC2 engine ${engine}` } });
    const match = await handlers.handle({ method: "POST", path: "/api/match/start", body: { left: engine, right: "s2-simple" } });
    assert.deepEqual(match, { status: 400, body: { error: `unsupported CC2 engine ${engine}` } });
  }
});

test("F14 stays a live GUI bot through the qualified static resolver", async () => {
  const handlers = createGuiRequestHandlers();
  const state = toS2GuiState(createGame(42));
  const piece = state.queue[0];
  const applied = await request(handlers, "POST", "/api/apply-s2", {
    engine: "cc2-s2-f14", state,
    moves: [{ location: { type: piece, orientation: "north", x: 4, y: piece === "I" ? 2 : 0 }, spin: "none" }],
  });
  const challenger = await request(handlers, "POST", "/api/simple-s2", { state, n: 1 });
  const compared = await request(handlers, "POST", "/api/compare-simple", {
    baseline: applied.comparison, challenger,
  });
  assert.equal(compared.baseline.score, applied.comparison.score);
  assert.ok(applied.move.location);
});

test("static champion match uses the WASM decision route", async () => {
  let selectedPlacement;
  const handlers = createGuiRequestHandlers({ cc2: {
    async decideF14(payload) { const decision = fakeF14Decision(payload); selectedPlacement = decision.selectedPlacement; return decision; },
    async closeSessions() {},
  } });
  await request(handlers, "POST", "/api/match/start", { left: "cc2-s2-champion", right: "s2-simple", seed: 42, preLockPreview: true });
  const stepped = await handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  assert.equal(stepped.status, 200, JSON.stringify(stepped.body));
  assert.deepEqual(stepped.body.bots.find(({ id }) => id === "left").preLockPreview.placement, selectedPlacement);
});

test("qualified analysis supplies canonical comparison identity after public selection", async () => {
  const handlers = createGuiRequestHandlers({ cc2: { decideF14: async (payload) => fakeF14Decision(payload) } });
  const state = toS2GuiState(createGame(42));
  const suggested = await request(handlers, "POST", "/api/suggest", {
    engine: "cc2-s2-champion", state,
  });
  const challenger = await request(handlers, "POST", "/api/simple-s2", { state, n: 1 });
  const compared = await request(handlers, "POST", "/api/compare-simple", {
    baseline: suggested.verification.comparison, challenger,
  });
  assert.equal(compared.contractId, "s2-same-position-comparison/1");
  assert.equal(compared.baseline.score, suggested.verification.comparison.score);
  assert.ok(suggested.suggestion.moves[0].location);
  assert.equal(typeof suggested.suggestion.moves[0].spin, "string");
});

// The GUI offers only the bots TTRM INPUT admits (plus You on the left), so the
// public and local hosts show one list and nothing non-OSS can enter it.
test("selectors offer all INPUT bots with the comparison before the current champion", async () => {
  const html = await readFile(new URL("../cc2-gui/index.html", import.meta.url), "utf8");
  const optionsFor = (id) => [...(html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`))?.[1] ?? "")
    .matchAll(/<option value="([^"]+)"/g)].map((match) => match[1]);
  const orderedBots = ["cc2-raw", "cc2-chouhy", "cc2-s2-f14", "cc2-s2-champion-legacy", "cc2-s2-champion"];
  assert.deepEqual(new Set(orderedBots), new Set(Object.keys(INPUT_BOT_PROFILES)));
  assert.deepEqual(optionsFor("analysis-bot"), orderedBots);
  assert.deepEqual(optionsFor("left-bot"), [...orderedBots, "human"]);
  assert.deepEqual(optionsFor("right-bot"), orderedBots);
});

test("bot-vs-bot selectors expose the current champion", async () => {
  const html = await readFile(new URL("../cc2-gui/index.html", import.meta.url), "utf8");
  for (const id of ["left-bot", "right-bot"]) {
    const select = html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`))?.[1] ?? "";
    assert.match(select, /value="cc2-s2-champion"/);
  }
});

test('legacy champion is available in both match modes on the static host', async () => {
  const handlers = createGuiRequestHandlers({ proposeCc2: async ({ state }) => ({
    suggestion: { moves: [{ location: {
      type: state.queue[0], orientation: "north", x: 4, y: state.queue[0] === "I" ? 2 : 0,
    }, spin: "none" }] },
  }) });
  const bot = (await request(handlers, 'GET', '/api/bots')).bots.find(bot => bot.id === 'cc2-s2-champion-legacy');
  assert.equal(bot.available, true);
  assert.notEqual(bot.inputAvailable, false);
  assert.equal(bot.inputOnly, undefined);
  const seed = 42;
  const result = await handlers.handle({ method: 'POST', path: '/api/match/start',
    body: { left: bot.id, right: 's2-simple', seed, preLockPreview: true } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  const stepped = await request(handlers, 'POST', '/api/match/step');
  const preview = stepped.bots.find(({ id }) => id === 'left').preLockPreview;
  const state = toS2GuiState(createGame(seed));
  const applied = await request(handlers, 'POST', '/api/apply-s2', {
    engine: bot.id, state, moves: [{ location: {
      type: state.queue[0], orientation: 'north', x: 4, y: state.queue[0] === 'I' ? 2 : 0,
    }, spin: 'none' }],
  });
  assert.deepEqual(preview.placement, applied.comparison.witness.placement);
});

test("bot-vs-bot exposes You (1P) only in the left-player selector", async () => {
  const html = await readFile(new URL("../cc2-gui/index.html", import.meta.url), "utf8");
  const optionsFor = (id) => html.match(new RegExp(`<select id="${id}">([\\s\\S]*?)</select>`))?.[1] ?? "";
  assert.match(optionsFor("left-bot"), /<option value="human">You \(1P\)<\/option>/);
  assert.doesNotMatch(optionsFor("right-bot"), /value="human"/);
  assert.match(html, /LEFT BOTで「You \(1P\)」を選ぶと自分でプレイできます/);
});

test("bot-vs-bot defaults to a random seed and unlimited turns", async () => {
  const html = await readFile(new URL("../cc2-gui/index.html", import.meta.url), "utf8");
  assert.match(html, /<input id="match-seed"[^>]* disabled>/);
  assert.match(html, /<input id="match-random-seed" type="checkbox" checked>/);
  assert.match(html, /<input id="match-max-turns"[^>]* disabled>/);
  assert.match(html, /<input id="match-unlimited-turns" type="checkbox" checked>/);
});

test("CC2 pace is bot-specific and the former match-wide pace toggle is absent", async () => {
  const html = await readFile(new URL("../cc2-gui/index.html", import.meta.url), "utf8");
  assert.doesNotMatch(html, /match-think-time-pace|THINK TIME PACE/);
  const capability = (await request(createGuiRequestHandlers({ proposeCc2: async () => ({}) }), "GET", "/api/bots"))
    .bots.find((bot) => bot.id === "cc2-s2-champion");
  assert.equal(capability.fixedDecision, true);
  assert.deepEqual(capability.execution.budget, { mode: "selection", selections: 512, maxMillis: 30000 });
  assert.equal(capability.execution.profileId, "f14-amount-only-compat-b/1");
  assert.deepEqual(capability.parameters.slice(0, 2).map(({ key, controlledBy }) => ({ key, controlledBy })), [
    { key: "ppsEnabled", controlledBy: undefined },
    { key: "pps", controlledBy: "ppsEnabled" },
  ]);
  // SELECTION, THINK TIME and QUEUE DEPTH are adjustable like the other CC2 bots,
  // within what the F14 core runs; the defaults are the champion.
  const byKey = Object.fromEntries(capability.parameters.map((parameter) => [parameter.key, parameter]));
  assert.equal(byKey.selectionLimit.maximum, 1_000_000);
  assert.equal(byKey.selectionLimit.defaultValue, 512);
  assert.equal(byKey.thinkTimeEnabled.defaultValue, false);
  assert.equal(byKey.queueDepth.maximum, 28);
  assert.equal(byKey.queueDepth.minimum, 2);
  assert.equal(byKey.queueDepth.defaultValue, 14);
});

test("match start rejects You (1P) on the right side", async () => {
  const result = await createGuiRequestHandlers().handle({
    method: "POST",
    path: "/api/match/start",
    body: { left: "s2-simple", right: "human" },
  });
  assert.equal(result.status, 400);
  assert.match(result.body.error, /available only on the left side/);
});

test("static CC2 suggestion preserves the GUI response identity contract", async () => {
  let proposalRequest;
  const handlers = createGuiRequestHandlers({ cc2: {
    async decideF14(payload) { proposalRequest = payload.request; return fakeF14Decision(payload); },
  } });
  const state = toS2GuiState(createGame(71001));
  state.s2.b2b = 7;
  const body = await request(handlers, "POST", "/api/suggest", {
    engine: "cc2-s2-champion", state,
  });
  assert.equal(proposalRequest.selector.chain.b2b, 7);
  assert.equal(Object.hasOwn(proposalRequest.selector, "garbage"), false);
  assert.equal(body.info.version, "F14 public profile B WASM");
  assert.equal(body.engine.botType, "cc2-s2-champion");
  assert.equal(body.nativeDecision.search.actualSelections, 512);
  assert.equal(proposalRequest.execution.budget.selections, 512);
});

test("static CC2 champion always uses the fixed F14 selection profile", async () => {
  let decisionRequest;
  const handlers = createGuiRequestHandlers({ cc2: {
    async decideF14(payload) { decisionRequest = payload.request; return fakeF14Decision(payload); },
  } });
  const body = await request(handlers, "POST", "/api/suggest", {
    engine: "cc2-s2-champion",
    state: toS2GuiState(createGame(71002)),
    parameters: { selectionEnabled: true, selectionLimit: 512, thinkTimeEnabled: false, queueDepth: 14 },
  });
  assert.equal(body.info.version, "F14 public profile B WASM");
  assert.equal(decisionRequest.execution.budget.selections, 512);
});

test("static CC2 rejects disabling both search limits", async () => {
  const handlers = createGuiRequestHandlers({ cc2: { decideF14: async () => { throw new Error("must not run"); } } });
  const result = await handlers.handle({
    method: "POST",
    path: "/api/suggest",
    body: { engine: "cc2-s2-champion", state: toS2GuiState(createGame(71003)), parameters: { selectionEnabled: false, thinkTimeEnabled: false } },
  });
  assert.equal(result.status, 422);
  assert.match(result.body.error, /cannot both be disabled/);
});

test("static champion apply-s2 remains unavailable after WASM selection", async () => {
  const result = await createGuiRequestHandlers().handle({
    method: "POST", path: "/api/apply-s2",
    body: { engine: "cc2-s2-champion", state: toS2GuiState(createGame(71004)), move: {} },
  });
  assert.equal(result.status, 422);
});

test("static matches release both CC2 sessions after a proposal failure", async () => {
  const closed = [];
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose() { throw new Error("proposal failed"); },
    async closeSessions(options) { closed.push(options); },
  } });
  await request(handlers, "POST", "/api/match/start", { left: LEGACY_STATIC_ENGINE, right: "s2-simple" });
  closed.length = 0;
  const result = await handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  assert.equal(result.status, 422);
  assert.match(result.body.error, /proposal failed/);
  assert.deepEqual(closed, [{ sessionKeys: ["left", "right"] }]);
});

test("static legacy matches score a searched empty response as one game loss and remain restartable", async () => {
  let calls = 0;
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose({ state }) {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error("CC2 returned no suggested move"), {
          suggestionReceived: true,
          requestToSuggestionMs: 0.25,
          moveInfo: { selections: 512, nodes: 0, candidate_values: [], extra: "searched root" },
        });
      }
      const piece = state.queue[0];
      return { suggestion: { moves: [{ location: {
        type: piece, orientation: "north", x: 4, y: piece === "I" ? 2 : 0,
      }, spin: "none" }] } };
    },
    async closeSessions() {},
  } });
  await request(handlers, "POST", "/api/match/start", {
    left: LEGACY_STATIC_ENGINE, right: "s2-simple", seed: 42,
    leftParameters: { ppsEnabled: false, selectionEnabled: true, selectionLimit: 512, thinkTimeEnabled: false },
  });
  const first = await request(handlers, "POST", "/api/match/step");
  assert.equal(first.bots.find((bot) => bot.id === "left").stats.turns, 1);

  const terminal = await request(handlers, "POST", "/api/match/step");
  assert.deepEqual(terminal.outcome, {
    complete: true,
    reason: "no-suggested-move",
    winnerBotId: "right",
    proposalResult: terminal.outcome.proposalResult,
  });
  assert.equal(terminal.outcome.proposalResult.status, "terminal");
  assert.equal(terminal.outcome.proposalResult.latencyMs, 0.25);
  assert.equal(terminal.outcome.proposalResult.diagnostics.moveInfo.extra, "searched root");
  assert.equal(terminal.nextStepFrames, null);

  const round = await request(handlers, "GET", "/api/match/round");
  assert.equal(round.result.reasons.left, "no-suggested-move");
  assert.equal(round.result.proposalResult.status, "terminal");
  const restarted = await request(handlers, "POST", "/api/match/start", {
    left: LEGACY_STATIC_ENGINE, right: "s2-simple", seed: 43,
  });
  assert.equal(restarted.outcome.complete, false);
});

test("static legacy matches keep malformed CC2 responses as series failures", async () => {
  let calls = 0;
  const handlers = createGuiRequestHandlers({ cc2: {
    async propose({ state }) {
      calls += 1;
      if (calls === 2) throw new Error("CC2 returned malformed suggestion");
      const piece = state.queue[0];
      return { suggestion: { moves: [{ location: {
        type: piece, orientation: "north", x: 4, y: piece === "I" ? 2 : 0,
      }, spin: "none" }] } };
    },
    async closeSessions() {},
  } });
  await request(handlers, "POST", "/api/match/start", {
    left: LEGACY_STATIC_ENGINE, right: "s2-simple", seed: 42,
    leftParameters: { ppsEnabled: false, selectionEnabled: true, selectionLimit: 512, thinkTimeEnabled: false },
  });
  await request(handlers, "POST", "/api/match/step");
  const failed = await handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  assert.equal(failed.status, 422);
  assert.equal(failed.body.error, "CC2 returned malformed suggestion");
});

test("static champion match admission accepts the F14 core's SELECTION, THINK TIME and QUEUE DEPTH range", async () => {
  const handlers = createGuiRequestHandlers();
  const rejected = await handlers.handle({ method: "POST", path: "/api/match/start", body: {
    left: "cc2-s2-champion",
    right: "s2-simple",
    leftParameters: { selectionEnabled: true, selectionLimit: 512, thinkTimeEnabled: false, queueDepth: 29 },
  } });
  assert.notEqual(rejected.status, 200);
  assert.match(rejected.body.error, /queueDepth/);

  const accepted = await request(handlers, "POST", "/api/match/start", {
    left: "cc2-s2-champion",
    right: "s2-simple",
    leftParameters: { ppsEnabled: false, selectionEnabled: true, selectionLimit: 2048, thinkTimeEnabled: true, thinkMs: 300, queueDepth: 28 },
  });
  assert.equal(accepted.botParameters.left.selectionLimit, 2048);
  assert.equal(accepted.botParameters.left.thinkTimeEnabled, true);
  assert.equal(accepted.botParameters.left.queueDepth, 28);
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
    right: LEGACY_STATIC_ENGINE,
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

test("static 1P discards a stale searched-empty forfeit after a human lock", async () => {
  await exerciseStaleOnePlayerProposal(() => Object.assign(new Error("CC2 returned no suggested move"), {
    suggestionReceived: true,
    requestToSuggestionMs: 0.25,
    moveInfo: { selections: 512, nodes: 0, candidate_values: [], extra: "searched root" },
  }));
});

test("static 1P discards a stale proposal failure after a human lock", async () => {
  await exerciseStaleOnePlayerProposal(() => new Error("delayed proposal failed"));
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
      return resolveQualifiedStaticCc2Submission(input);
    },
    async closeSessions() {},
  };
  const handlers = createGuiRequestHandlers({ cc2, now: () => 0, wait: async () => {} });
  const seed = 42;
  await request(handlers, "POST", "/api/match/start", {
    left: "human",
    right: LEGACY_STATIC_ENGINE,
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
  assert.equal(resolveRequests[0].type, LEGACY_STATIC_ENGINE);
  assert.equal(resolveRequests[0].engine.engineId, LEGACY_STATIC_ENGINE);
  assert.deepEqual(resolveRequests[0].decision.board.cells, rightAfterHuman.board.flat().map((cell) => cell ?? "_").join(""));
  assert.deepEqual(resolveRequests[0].decision.pieces.known.slice(0, 6), rightAfterHuman.next);
  assert.equal(resolveRequests[0].decision.lockTime.logicalFrame, firstHuman.body.clock.logicalFrame);

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
  assert.deepEqual(resolveRequests[1].decision.board.cells, rightAfterSecond.board.flat().map((cell) => cell ?? "_").join(""));
  assert.equal(resolveRequests[1].decision.lockTime.logicalFrame, second.body.clock.logicalFrame);
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
    right: LEGACY_STATIC_ENGINE,
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
  await request(handlers, "POST", "/api/match/start", { left: LEGACY_STATIC_ENGINE, right: "s2-simple" });
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
      return { ...resolveQualifiedStaticCc2Submission(input), decisionFingerprint: "wrong-state" };
    },
    async closeSessions() {},
  } });
  await request(handlers, "POST", "/api/match/start", { left: LEGACY_STATIC_ENGINE, right: "s2-simple" });
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
      return resolveQualifiedStaticCc2Submission(input);
    },
    async closeSessions() {},
  } });
  await request(handlers, "POST", "/api/match/start", { left: LEGACY_STATIC_ENGINE, right: "s2-simple" });
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
      return resolveQualifiedStaticCc2Submission(input);
    },
    async closeSessions() {},
  } });
  await request(handlers, "POST", "/api/match/start", { left: LEGACY_STATIC_ENGINE, right: "s2-simple" });
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
  await request(handlers, "POST", "/api/match/start", { left: LEGACY_STATIC_ENGINE, right: "s2-simple" });
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
      return resolveQualifiedStaticCc2Submission(input);
    },
    async closeSessions() {},
  } });
  await request(handlers, "POST", "/api/match/start", {
    left: LEGACY_STATIC_ENGINE,
    right: LEGACY_STATIC_ENGINE,
    seed: 55,
  });
  const before = await request(handlers, "GET", "/api/match/round");
  const stepping = handlers.handle({ method: "POST", path: "/api/match/step", body: {} });
  await startedGate;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await request(handlers, "GET", "/api/match/round"), before);
  assert.equal(resolveInputs[0].decision.lockTime.logicalFrame, resolveInputs[1].decision.lockTime.logicalFrame);
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
      return resolveQualifiedStaticCc2Submission(input);
    };
    const handlers = createGuiRequestHandlers({ cc2 });
    await request(handlers, "POST", "/api/match/start", {
      left: LEGACY_STATIC_ENGINE,
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
  await request(handlers, "POST", "/api/match/start", { left: LEGACY_STATIC_ENGINE, right: LEGACY_STATIC_ENGINE });
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
    left: LEGACY_STATIC_ENGINE, right: "s2-simple",
    leftParameters: { ppsEnabled: true, pps: 4, thinkTimeEnabled: true, thinkMs: 250 },
    rightParameters: { pps: 4 },
  });
  await request(botOnly, "POST", "/api/match/step", {});
  assert.equal(observed.shift(), 175);

  const onePlayer = createGuiRequestHandlers({ cc2, now: () => 0, wait: async () => {} });
  await request(onePlayer, "POST", "/api/match/start", {
    left: "human", right: LEGACY_STATIC_ENGINE,
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
      left: LEGACY_STATIC_ENGINE,
      right: LEGACY_STATIC_ENGINE,
      seed: 77,
      leftParameters: { ppsEnabled: false, selectionEnabled: true, selectionLimit: 512, thinkTimeEnabled: false },
      rightParameters: { ppsEnabled: false, selectionEnabled: true, selectionLimit: 512, thinkTimeEnabled: false },
    });
    await request(handlers, "POST", "/api/match/step", {});
    return request(handlers, "GET", "/api/match/round");
  };
  assert.equal(JSON.stringify(await run()), JSON.stringify(await run()));
});

/* The 1P handicap opens the human side on a stacked board. The canary runs the
   real start/lock/step/round path, because the invariants that matter (28 cells,
   no cavity, no complete row, an untouched opponent board, and a round record
   that describes the board it was played on) are properties of that path rather
   than of the generator alone. */
const HANDICAP_CELLS = 28;
const stackedCells = (board) => board.flat().filter((cell) => cell === "G").length;
const completeRows = (board) => board.filter((row) => row.every((cell) => cell !== null)).length;

async function startHandicapMatch(handlers, { seed = 4242, handicap = { enabled: true }, left = "human" } = {}) {
  return handlers.handle({ method: "POST", path: "/api/match/start", body: {
    left, right: "s2-simple", seed, handicap, maxTurns: null, firstTo: 2,
  } });
}

test("static 1P handicap stacks only the human board and records the terrain per round", async () => {
  const handlers = createGuiRequestHandlers({});
  const started = await startHandicapMatch(handlers, { seed: 4242 });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const [left, right] = started.body.bots;
  assert.equal(stackedCells(left.board), HANDICAP_CELLS);
  assert.equal(completeRows(left.board), 0, "a complete row would be cleared differently by each path");
  // Row 0 of a canonical board is the floor: the terrain sits on it, not in the air.
  assert.ok(left.board[0].includes("G"), "the stack starts on the floor");
  assert.ok(left.board.slice(6).every((row) => row.every((cell) => cell === null)),
    "the stack stays within the declared height cap");
  assert.equal(right.board.flat().filter((cell) => cell !== null).length, 0, "the bot side stays empty");
  assert.equal(left.toppedOut, false);
  assert.equal(started.body.handicap.enabled, true);
  assert.equal(started.body.handicap.appliedTo, "left");
  assert.equal(started.body.handicap.seed, 4242);
  assert.equal(started.body.replayMeta.match.handicap.enabled, true);
  assert.equal(started.body.replayMeta.match.handicap.seed, undefined,
    "the per-game terrain does not belong to the series meta");

  // A human lock on top of the terrain, then one bot step: the real committing path.
  const humanState = guiStateToCanonical(toS2GuiState(createGame(4242)));
  humanState.board = { ...humanState.board, cells: left.board.flat().map((cell) => cell ?? "_").join("") };
  const placement = analyzeSimpleS2FinalPlacements(humanState, { topN: 1 }).moves[0].placement;
  const locked = await handlers.handle({ method: "POST", path: "/api/match/human-lock", body: { lockFrame: 30, placement } });
  assert.equal(locked.status, 200, JSON.stringify(locked.body));
  const stepped = await handlers.handle({ method: "POST", path: "/api/match/step", body: { lockFrame: 60 } });
  assert.equal(stepped.status, 200, JSON.stringify(stepped.body));

  const round = await request(handlers, "GET", "/api/match/round");
  assert.equal(round.handicap.id, "s2-gui-1p-handicap-garbage/1");
  assert.equal(round.handicap.seed, 4242);
  const recordedLeft = round.players.find((player) => player.id === "left");
  const recordedCells = recordedLeft.initial.field.filter((cell) => cell === 8).length;
  assert.equal(recordedCells, HANDICAP_CELLS, "the recorded initial board is the board that was played");
  assert.deepEqual(round.handicap.columnHeights.reduce((sum, height) => sum + height, 0), HANDICAP_CELLS);
});

test("static handicap terrain follows each series game rather than the first one", async () => {
  const handlers = createGuiRequestHandlers({});
  const first = await startHandicapMatch(handlers, { seed: 4242 });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const firstRound = await request(handlers, "GET", "/api/match/round");
  // Game two of the FT series uses seed + 1, exactly as the browser sends it.
  const second = await startHandicapMatch(handlers, { seed: 4243 });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  const secondRound = await request(handlers, "GET", "/api/match/round");
  assert.equal(secondRound.handicap.seed, 4243);
  assert.notDeepEqual(secondRound.handicap.columnHeights, firstRound.handicap.columnHeights);
  // `initial.field` is one flat 10-wide array with row 0 on the floor.
  const heightsOf = (round) => {
    const field = round.players.find((player) => player.id === "left").initial.field;
    return Array.from({ length: 10 }, (_, x) =>
      field.filter((cell, index) => cell === 8 && index % 10 === x).length);
  };
  assert.deepEqual(heightsOf(secondRound), [...secondRound.handicap.columnHeights]);
  assert.deepEqual(heightsOf(firstRound), [...firstRound.handicap.columnHeights]);
});

test("static matches without the handicap still open on an empty board", async () => {
  const handlers = createGuiRequestHandlers({});
  const off = await startHandicapMatch(handlers, { handicap: { enabled: false } });
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.equal(off.body.bots.every((bot) => bot.board.flat().every((cell) => cell === null)), true);
  assert.equal(off.body.handicap.enabled, false);
  const absent = await handlers.handle({ method: "POST", path: "/api/match/start", body: {
    left: "human", right: "s2-simple", seed: 7,
  } });
  assert.equal(absent.status, 200, JSON.stringify(absent.body));
  assert.equal(absent.body.handicap.enabled, false);
  const round = await request(handlers, "GET", "/api/match/round");
  assert.equal(round.handicap, null);
});

test("a handicap request without a 1P side is not applicable, and a malformed one fails closed", async () => {
  const handlers = createGuiRequestHandlers({});
  const botsOnly = await startHandicapMatch(handlers, { left: "s2-simple", handicap: { enabled: true } });
  assert.equal(botsOnly.status, 200, JSON.stringify(botsOnly.body));
  assert.equal(botsOnly.body.handicap.enabled, false, "there is no 1P side to handicap");
  assert.equal(botsOnly.body.bots.every((bot) => bot.board.flat().every((cell) => cell === null)), true);
  for (const handicap of [{ enabled: "yes" }, [], 28]) {
    const rejected = await startHandicapMatch(handlers, { handicap });
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
  }
});
