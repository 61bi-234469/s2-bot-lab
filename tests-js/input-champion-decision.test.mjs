import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { guiStateToCanonical } from "../src-js/gui-state.mjs";
import { createPublicCompatProfile, createPublicCompatRequest } from "../src-js/public-compat-request.mjs";
import { createS2AmountOnlyDecisionState } from "../src-js/s2-amount-only-decision-state.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";
import { championInputMoves, createChampionInputRequest } from "../src-js/input-champion-decision.mjs";
import { createGuiInputMatchHandlers } from "../src-js/gui-input-match.mjs";
import { createNativeInputRuntime } from "../src-js/native-input-runtime.mjs";
import { createCc2WasmSession } from "../src-js/cc2-wasm-engine.mjs";
import { canonicalize } from "../scripts/cs1.mjs";
import { firstResponseMismatch } from "../scripts/f14-response-comparator.mjs";
import { applyTransition } from "../src-js/transition.mjs";
import { defaultBotParameters, normalizeBotParameters } from "../src-js/bot-parameters.mjs";
import { fullStateKey } from "../src-js/state-keys.mjs";
import { createChampionBaseProfile, createChampionProfile, createChampionRequest, resolveChampionDecision } from "../src-js/champion-parameters.mjs";

// Pending garbage on the canonical state; the request carries only its row counts.
function withPendingGarbage(state, turn) {
  const received = applyTransition(state, { kind: "garbage-receive", packet: { packetId: 1, sourceGameId: "opponent",
    amount: 1 + (turn % 4), holeSize: 1, arrivalFrame: state.time.logicalFrame + (turn % 2 === 0 ? 0 : 60),
    confirmed: true, order: state.garbage.packets.length } }, state.rulesetId);
  return received.nextState;
}

const wasmPath = resolve("bot/cold-clear-2-s2/target/wasm32-unknown-unknown/release/cold_clear_2_s2.wasm");
const rawBinary = resolve(`bot/cold-clear-2-upstream/target/release/cold-clear-2-upstream${process.platform === "win32" ? ".exe" : ""}`);

test("INPUT champion request equals the final-placement champion request for the same position", () => {
  let compared = 0;
  let heldStates = 0;
  let withIncoming = 0;
  for (const seed of [1, 2, 3, 4, 5]) {
    let state = guiStateToCanonical(toS2GuiState(createGame(seed)));
    for (let turn = 0; turn < 40; turn++) {
      for (const probe of [state, withPendingGarbage(state, turn)]) {
        const profile = createChampionBaseProfile();
        const expected = createPublicCompatRequest(probe, { requestId: "r", profile });
        const actual = createChampionInputRequest(createS2AmountOnlyDecisionState(probe), { requestId: "r" });
        assert.equal(canonicalize(actual), canonicalize(expected), `seed ${seed} turn ${turn}`);
        if (expected.selector.incoming.pendingRows > 0) withIncoming++;
        compared++;
      }
      if (state.pieces.hold !== null) heldStates++;
      const moves = analyzeSimpleS2FinalPlacements(state, { topN: 3 }).moves;
      const next = moves[turn % moves.length]?.transition?.nextState;
      if (!next) break;
      state = next;
    }
  }
  assert.ok(compared >= 300 && heldStates > 0 && withIncoming >= 150,
    `${compared} positions, ${heldStates} with hold, ${withIncoming} with incoming rows`);
});

test("champion INPUT order keeps the core selection first, then CC2 rank order", () => {
  const identity = (x) => canonicalize({ location: { orientation: "north", type: "O", x, y: 1 }, spin: "none" });
  const identities = [0, 2, 4, 6].map(identity);
  const gated = (ranking, selectedIdentity) => ({ status: "move", profileId: "f14-leaf-conversion-gated-b/1",
    diagnostics: { finalOrderPolicyId: "cc2-rank-order/1", postStageRerankCalls: 1,
      postStageConversionComputeCalls: 4, postStageConversionAddCalls: 4 },
    selectedIdentity, ranking });
  const candidates = [
    { cc2Rank: 0, solvent: false, solvency: -2, selectionScore: 10 },
    { cc2Rank: 1, solvent: true, solvency: 1, selectionScore: -3 },
    { cc2Rank: 2, solvent: true, solvency: 2, selectionScore: -9 },
    { cc2Rank: 3, solvent: true, solvency: 3, selectionScore: 1 },
  ];
  // A rescue selects the first solvent rank; the rest follow in CC2 order.
  const rescue = { rescueApplied: true, selectedCc2Rank: 1, returnedIdentities: identities, identities: [...identities], candidates };
  assert.deepEqual(championInputMoves(gated(rescue, identities[1])).map(canonicalize),
    [identities[1], identities[0], identities[2], identities[3]]);
  // The gate mirrors Rust choose_rescue and the cc2-rank-order final order.
  assert.throws(() => championInputMoves(gated({ ...rescue, identities: [identities[0], identities[2], identities[1], identities[3]] }, identities[1])),
    /CC2 rank order/);
  assert.throws(() => championInputMoves(gated({ ...rescue, selectedCc2Rank: 2 }, identities[2])), /first solvent/);
  const zeroSolvency = candidates.map((candidate) => candidate.cc2Rank === 0 ? { ...candidate, solvency: 0 } : candidate);
  assert.throws(() => championInputMoves(gated({ ...rescue, candidates: zeroSolvency }, identities[1])), /rank 0/);
  assert.throws(() => championInputMoves({ status: "incomplete", reason: "deadline" }), /incomplete/);
  const held = canonicalize({ location: { orientation: "north", type: "T", x: 4, y: 1 }, spin: "none" });
  const withHold = gated({ rescueApplied: false, selectedCc2Rank: 0, identities: [held, identities[1], identities[0]],
    returnedIdentities: [held, identities[1], identities[0]],
    candidates: [{ cc2Rank: 0, solvent: true, solvency: 1, selectionScore: 0 }, { cc2Rank: 1, solvent: true, solvency: 1, selectionScore: -1 },
      { cc2Rank: 2, solvent: true, solvency: 1, selectionScore: -2 }] }, held);
  // A replan after this piece's HOLD cannot place the held piece.
  assert.deepEqual(championInputMoves(withHold, { current: "O", holdAvailable: false }).map(canonicalize), [identities[1], identities[0]]);
});

test("champion INPUT with SELECTION off and a 10 ms THINK TIME keeps playing", { skip: !existsSync(wasmPath), timeout: 300_000 }, async () => {
  // The reported stop: a shallow search ranks candidates away from CC2 order,
  // so the core's selection is not identities[selectedCc2Rank].
  const wasmBytes = readFileSync(wasmPath);
  const runtime = createNativeInputRuntime({ engineFor: () => assert.fail("the champion never starts a CC2 process"),
    f14SessionFor: () => createCc2WasmSession({ wasmBytes }) });
  const responses = [];
  const handlers = createGuiInputMatchHandlers({ runtime: { ...runtime,
    decideF14: async (payload) => { const response = await runtime.decideF14(payload); responses.push(response); return response; } } });
  const parameters = { ...defaultBotParameters("cc2-s2-champion"), ppsEnabled: false, selectionEnabled: false, thinkTimeEnabled: true, thinkMs: 10 };
  try {
    const start = await handlers.handle({ method: "POST", path: "/api/input-match/start", body: {
      left: "human", right: "cc2-s2-champion", seed: 42, maxTurns: null, rightParameters: parameters } });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    let view = start.body;
    for (let frame = 1; frame < 20_000 && view.bots[1].stats.turns < 40 && !view.outcome.complete; frame += 2) {
      const stepped = await handlers.handle({ method: "POST", path: "/api/input-match/step", body: { sessionId: start.body.sessionId, frame } });
      assert.equal(stepped.status, 200, JSON.stringify(stepped.body));
      view = stepped.body;
      await new Promise((resolveWait) => setTimeout(resolveWait, 2));
    }
    assert.ok(view.bots[1].stats.turns >= 20 || view.outcome.complete, `champion placed ${view.bots[1].stats.turns}`);
    for (const response of responses.filter(({ status }) => status === "move")) {
      assert.equal(canonicalize(championInputMoves(response)[0]), response.selectedIdentity);
    }
  } finally { await runtime.closeSessions(); }
});

function stripF14Timing(value) {
  if (Array.isArray(value)) return value.map(stripF14Timing);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !['nps', 'elapsed', 'elapsedMs', 'elapsedMillis', 'durationMs'].includes(key))
    .map(([key, child]) => [key, stripF14Timing(child)]));
}

test("F14 rerank matches fresh decisions on constructed positions and rejects a changed board", {
  skip: !existsSync(wasmPath),
  timeout: 180_000,
}, async () => {
  const wasmBytes = readFileSync(wasmPath);
  const session = await createCc2WasmSession({ wasmBytes });
  let compared = 0;
  try {
    const states = [];
    for (const seed of [31, 47]) {
      let state = guiStateToCanonical(toS2GuiState(createGame(seed)));
      states.push(state, withPendingGarbage(state, seed));
      const moves = analyzeSimpleS2FinalPlacements(state, { topN: 2 }).moves;
      if (moves[0]?.transition?.nextState) states.push(moves[0].transition.nextState);
    }
    for (const [index, state] of states.entries()) {
      const profile = createPublicCompatProfile();
      const base = createPublicCompatRequest(state, { requestId: `constructed-${index}`, profile });
      const pairs = [
        [{ pendingRows: 0, dueThisLockRows: 0 }, { pendingRows: 3, dueThisLockRows: 0 }],
        [{ pendingRows: 4, dueThisLockRows: 0 }, { pendingRows: 4, dueThisLockRows: 4 }],
      ];
      for (const [incomingA, incomingB] of pairs) {
        const original = structuredClone(base);
        original.requestId = `constructed-a-${compared}`;
        original.positionId = `constructed-position-a-${compared}`;
        original.selector.incoming = incomingA;
        const baseline = await session.decideF14({ request: original, profile });
        assert.equal(baseline.status, 'move', `constructed position ${index}: ${baseline.reason}`);

        const target = structuredClone(original);
        target.requestId = `constructed-b-${compared}`;
        target.positionId = `constructed-position-b-${compared}`;
        target.generation = (original.generation ?? 0) + 1;
        target.selector.incoming = incomingB;
        const reranked = await session.rerankF14({ request: target, profile });
        const fresh = await session.decideF14({ request: target, profile });
        assert.deepEqual(stripF14Timing(reranked), stripF14Timing(fresh), `constructed position ${index}`);
        compared++;
      }
    }

    const source = createPublicCompatRequest(guiStateToCanonical(toS2GuiState(createGame(59))), { requestId: 'board-base' });
    const profile = source.execution;
    await session.decideF14({ request: source, profile });
    const changedBoard = structuredClone(source);
    changedBoard.requestId = 'board-rerank-mismatch';
    changedBoard.positionId = 'board-rerank-mismatch-position';
    changedBoard.generation += 1;
    changedBoard.selector.board.visibleHeight += 1;
    changedBoard.selector.board.bufferHeight = changedBoard.selector.board.height - changedBoard.selector.board.visibleHeight;
    const mismatch = await session.rerankF14({ request: changedBoard, profile });
    assert.equal(mismatch.status, 'error');
    assert.equal(mismatch.reason, 'rerank-mismatch');
  } finally { await session.close(); }
  assert.ok(compared > 0);
});

test("F14 rerank accepts changed selector time and rebuilds the ranking context", {
  skip: !existsSync(wasmPath),
  timeout: 180_000,
}, async () => {
  const wasmBytes = readFileSync(wasmPath);
  const session = await createCc2WasmSession({ wasmBytes });
  const source = JSON.parse(readFileSync(resolve("fixtures/diagnostics/f14-public-search-rescue-request.json"), "utf8"));
  const profile = source.execution;
  const cases = [
    ["time-at-margin", 10_799, 10_800, { pendingRows: 0, dueThisLockRows: 0 }, { pendingRows: 0, dueThisLockRows: 0 }],
    ["time-above-margin", 10_799, 10_801, { pendingRows: 0, dueThisLockRows: 0 }, { pendingRows: 0, dueThisLockRows: 0 }],
    ["time-accumulator", 10_799, 12_300, { pendingRows: 0, dueThisLockRows: 0 }, { pendingRows: 0, dueThisLockRows: 0 }],
    ["large-time", 10_799, 36_000, { pendingRows: 0, dueThisLockRows: 0 }, { pendingRows: 0, dueThisLockRows: 0 }],
    ["incoming-only", 10_799, 10_799, { pendingRows: 0, dueThisLockRows: 0 }, { pendingRows: 19, dueThisLockRows: 0 }],
    ["time-and-incoming", 10_799, 36_000, { pendingRows: 0, dueThisLockRows: 0 }, { pendingRows: 19, dueThisLockRows: 0 }],
  ];
  let changedFromA = false;
  try {
    for (const [index, [name, frameA, frameB, incomingA, incomingB]] of cases.entries()) {
      const original = structuredClone(source);
      original.requestId = `time-rerank-a-${index}`;
      original.positionId = `time-rerank-position-a-${index}`;
      original.generation = 2;
      original.selector.time.logicalFrame = frameA;
      original.selector.incoming = incomingA;
      const baseline = await session.decideF14({ request: original, profile });
      assert.equal(baseline.status, "move", `${name} request A: ${baseline.reason}`);

      const target = structuredClone(original);
      target.requestId = `time-rerank-b-${index}`;
      target.positionId = `time-rerank-position-b-${index}`;
      target.generation = 3;
      target.selector.time.logicalFrame = frameB;
      target.selector.incoming = incomingB;
      const reranked = await session.rerankF14({ request: target, profile });
      const fresh = await session.decideF14({ request: target, profile });
      assert.deepEqual(stripF14Timing(reranked), stripF14Timing(fresh), name);
      if (baseline.selectedIdentity !== fresh.selectedIdentity ||
          baseline.ranking.rescueApplied !== fresh.ranking.rescueApplied) changedFromA = true;
    }
  } finally { await session.close(); }
  assert.ok(changedFromA, "the changed time/incoming cases include a decision different from request A");
});

test("local INPUT runtime re-finalizes the gated champion search through an existing session", {
  skip: !existsSync(wasmPath),
  timeout: 120_000,
}, async () => {
  const wasmBytes = readFileSync(wasmPath);
  const runtime = createNativeInputRuntime({
    engineFor: () => assert.fail('F14 INPUT never starts a CC2 proposal process'),
    f14SessionFor: () => createCc2WasmSession({ wasmBytes }),
  });
  try {
    const profile = createChampionBaseProfile();
    const state = withPendingGarbage(guiStateToCanonical(toS2GuiState(createGame(67))), 4);
    const request = createPublicCompatRequest(state, { requestId: 'local-rerank', profile });
    const payload = { sessionKey: 'input-rerank-test/right', type: 'cc2-s2-champion',
      engine: { botType: 'cc2-s2-champion', engineId: 'cc2-s2-champion' }, profile, request };
    const zeroed = structuredClone(request);
    zeroed.selector.incoming = { pendingRows: 0, dueThisLockRows: 0 };
    const baseline = await runtime.decideF14({ ...payload, request: zeroed });
    assert.equal(baseline.status, 'move');
    const target = structuredClone(request);
    target.requestId = 'local-rerank-target';
    target.positionId = 'local-rerank-target-position';
    target.generation += 1;
    const reranked = await runtime.rerankF14({ ...payload, request: target });
    const fresh = await runtime.decideF14({ ...payload, request: target });
    assert.deepEqual(stripF14Timing(reranked), stripF14Timing(fresh));
  } finally { await runtime.closeSessions(); }
});

test("champion INPUT match locks the WASM F14 core selection, also under incoming garbage", { skip: !existsSync(wasmPath) || !existsSync(rawBinary), timeout: 300_000 }, async (t) => {
  const wasmBytes = readFileSync(wasmPath);
  // Raw CC2 is the opponent so that garbage actually arrives; a mirror match cancels it all.
  const runtime = createNativeInputRuntime({
    engineFor: (type) => type === "cc2-raw" ? { binary: rawBinary } : assert.fail("the champion never starts a CC2 process"),
    f14SessionFor: () => createCc2WasmSession({ wasmBytes }) });
  const decisions = [];
  const plans = [];
  const handlers = createGuiInputMatchHandlers({ championQueuePrefixSpeculation: true, runtime: {
    ...runtime,
    decideF14: async (payload) => { const response = await runtime.decideF14(payload); decisions.push({ payload, response }); return response; },
    // An incoming-only change, or the next piece whose `start` a speculative
    // search predicted, re-ranks the retained search; it is a core decision
    // too. A refused rerank falls back to decideF14.
    rerankF14: async (payload) => {
      const response = await runtime.rerankF14(payload);
      if (response.status === "move") decisions.push({ payload, response, reranked: true });
      return response;
    },
    resolveInput: async (payload) => { const result = await runtime.resolveInput(payload); plans.push({ payload, result }); return result; },
  } });
  try {
    const start = await handlers.handle({ method: "POST", path: "/api/input-match/start",
      body: { left: "cc2-raw", right: "cc2-s2-champion", seed: 42, maxTurns: null } });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    let view = start.body;
    for (let frame = 1; frame < 20_000 && !view.outcome.complete && view.bots.some((bot) => bot.stats.turns < 40); frame += 2) {
      view = (await handlers.handle({ method: "POST", path: "/api/input-match/step",
        body: { sessionId: start.body.sessionId, frame } })).body;
      await new Promise((resolveWait) => setTimeout(resolveWait, 2));
    }
    assert.ok(view.bots.every((bot) => bot.stats.turns >= 20), JSON.stringify(view.bots.map((bot) => bot.stats.turns)));
    const gatedProfile = createChampionBaseProfile();
    assert.ok(decisions.every(({ payload }) => canonicalize(payload.profile) === canonicalize(gatedProfile)));
    assert.ok(decisions.some(({ payload }) => payload.request.selector.incoming.pendingRows > 0), "a decision saw incoming rows");
    const pose = (placement) => [placement.piece, placement.rotation, placement.x, placement.y, placement.usedHold];
    const planned = plans.filter(({ payload, result }) => payload.request.type === "cc2-s2-champion" && result.status === "planned");
    // The first move handed to the planner is always the core's selection.
    for (const { payload, result } of planned) {
      const decided = decisions.findLast(({ response }) => canonicalize(JSON.parse(response.selectedIdentity)) === canonicalize(payload.request.moves[0]));
      assert.ok(decided, "the planner's first target is a core selection");
      if (result.selection.adoptionRank === 0) assert.deepEqual(pose(result.placement), pose(decided.response.selectedPlacement));
    }
    const preferred = planned.filter(({ result }) => result.selection.adoptionRank === 0).length;
    assert.ok(preferred / planned.length >= 0.9, `${preferred}/${planned.length} plans locked the core selection`);
    t.diagnostic(`${decisions.length} core decisions, ${decisions.filter(({ payload }) => payload.request.selector.incoming.pendingRows > 0).length} with incoming rows; ${preferred}/${planned.length} plans on the core selection`);
    // Most pieces reuse the search run while the previous piece was moved.
    const champion = view.bots.find((bot) => bot.type === "cc2-s2-champion").inputExecution;
    assert.ok(champion.championSpeculationHits > champion.championSpeculations / 2, JSON.stringify(champion));
    assert.ok(champion.championSpeculationHits > 0,
      "a gated retained-search speculation was reused instead of triggering a fresh-search fallback");
    // A one-piece queue-prefix speculation searched one piece
    // fewer than the real request and must say so; it is not a fresh answer.
    const prefixReranks = decisions.filter(({ response }) => response.search?.searchedQueueLength !== undefined);
    for (const { payload, response } of prefixReranks) {
      assert.equal(response.search.searchedQueueLength, payload.request.start.queue.length - 1);
      assert.equal(response.search.queueLength, response.search.searchedQueueLength);
    }
    // A fresh core session answers the same request identically, also for
    // the other re-ranked (exact speculative or incoming-only) decisions.
    const exact = decisions.filter(({ response }) => response.search?.searchedQueueLength === undefined);
    const fresh = await createCc2WasmSession({ wasmBytes });
    try {
      for (const { payload, response } of [...exact.slice(0, 5), ...exact.filter((decision) => decision.reranked).slice(0, 20)]) {
        const again = await fresh.decideF14({ request: payload.request, profile: payload.profile });
        assert.equal(firstResponseMismatch(again, response), null);
      }
    } finally { await fresh.close(); }
  } finally {
    await runtime.closeSessions();
  }
});

test("champion GUI parameters always build the gated leaf-conversion profile and request", () => {
  const defaults = defaultBotParameters("cc2-s2-champion");
  const gatedBase = createChampionBaseProfile();
  assert.equal(canonicalize(createChampionProfile(defaults)), canonicalize(gatedBase));
  for (const seed of [1, 2, 3]) {
    const state = withPendingGarbage(guiStateToCanonical(toS2GuiState(createGame(seed))), seed);
    assert.equal(canonicalize(createChampionRequest(state, defaults, { requestId: "r" })),
      canonicalize(createPublicCompatRequest(state, { requestId: "r", profile: gatedBase })));
  }
  const timed = createChampionProfile({ ...defaults, thinkTimeEnabled: true, thinkMs: 300, selectionEnabled: false });
  assert.deepEqual(timed.budget, { mode: "time", selections: 1_000_000, maxMillis: 300 });
  const gatedParameters = { ...defaults, selectionLimit: 384 };
  assert.equal(canonicalize(createChampionProfile(gatedParameters)), canonicalize({
    ...gatedBase, budget: { ...gatedBase.budget, selections: 384 },
  }));
  const gatedTimed = createChampionProfile({ ...gatedParameters, selectionEnabled: false, thinkTimeEnabled: true, thinkMs: 300 });
  assert.equal(canonicalize(gatedTimed), canonicalize({
    ...gatedBase, budget: { mode: "time", selections: 1_000_000, maxMillis: 300 },
  }));
  assert.throws(() => createChampionProfile({ ...defaults, queueDepth: 29 }), /QUEUE DEPTH must be 2-28/);
  // The core's search needs a NEXT piece; depth 1 crashed the WASM core.
  assert.throws(() => createChampionProfile({ ...defaults, queueDepth: 1 }), /QUEUE DEPTH must be 2-28/);
  assert.throws(() => normalizeBotParameters("cc2-s2-champion", { queueDepth: 1 }), /queueDepth/);
});

test("champion THINK TIME and QUEUE DEPTH decide through the WASM core", { skip: !existsSync(wasmPath), timeout: 120_000 }, async () => {
  const session = await createCc2WasmSession({ wasmBytes: readFileSync(wasmPath) });
  try {
    const gui = toS2GuiState(createGame(11));
    const state = guiStateToCanonical(gui);
    const parameters = { ...defaultBotParameters("cc2-s2-champion"), selectionEnabled: false, thinkTimeEnabled: true, thinkMs: 60, queueDepth: 3 };
    const request = createChampionRequest(state, parameters, { requestId: "timed" });
    assert.equal(request.start.queue.length, 3);
    const response = await session.decideF14({ request, profile: request.execution });
    assert.equal(response.status, "move", JSON.stringify(response));
    assert.equal(response.reason, "time-budget");
    assert.ok(response.search.actualSelections >= 1 && response.search.actualSelections < 1_000_000);
    const resolved = resolveChampionDecision({ state, gui, request, response, parameters });
    assert.equal(resolved.transition.legality.legal, true);
    assert.equal(resolved.positionFingerprint, fullStateKey(state));
    // The full queue survives the lock even though the core saw three pieces.
    assert.equal(resolved.transition.nextState.pieces.known.length, state.pieces.known.length - 1);

    const gatedTimedRequest = createChampionRequest(state, parameters, { requestId: "gated-timed" });
    const gatedTimedResponse = await session.decideF14({ request: gatedTimedRequest, profile: gatedTimedRequest.execution });
    assert.equal(gatedTimedResponse.status, "move", JSON.stringify(gatedTimedResponse));
    assert.equal(gatedTimedResponse.reason, "time-budget");
    assert.ok(gatedTimedResponse.search.actualSelections >= 1
      && gatedTimedResponse.search.actualSelections <= gatedTimedRequest.execution.budget.selections);
    assert.equal(resolveChampionDecision({ state, gui, request: gatedTimedRequest, response: gatedTimedResponse,
      parameters }).transition.legality.legal, true);

    const gatedParameters = { ...defaultBotParameters("cc2-s2-champion"), selectionLimit: 64 };
    const gatedRequest = createChampionRequest(state, gatedParameters, { requestId: "gated" });
    const gatedResponse = await session.decideF14({ request: gatedRequest, profile: gatedRequest.execution });
    assert.equal(gatedRequest.execution.profileId, "f14-leaf-conversion-gated-b/1");
    assert.equal(resolveChampionDecision({ state, gui, request: gatedRequest, response: gatedResponse,
      parameters: gatedParameters }).transition.legality.legal, true);
    assert.throws(() => resolveChampionDecision({ state, gui, request: gatedRequest,
      response: { ...gatedResponse, diagnostics: { ...gatedResponse.diagnostics, finalOrderPolicyId: "all-spin-rerank/1" } },
      parameters: gatedParameters }), /cc2-rank-order\/1 final order/);
    assert.throws(() => resolveChampionDecision({ state, gui, request: gatedRequest,
      response: { ...gatedResponse, profileId: "f14-amount-only-compat-b/1" }, parameters: gatedParameters }),
    /must use the gated leaf-conversion profile/);

    const counted = { ...parameters, selectionEnabled: true, selectionLimit: 64, thinkTimeEnabled: false };
    const fixedRequest = createChampionRequest(state, counted, { requestId: "counted" });
    const fixed = await session.decideF14({ request: fixedRequest, profile: fixedRequest.execution });
    assert.equal(fixed.reason, "selection-budget");
    assert.equal(fixed.search.actualSelections, 64);

    // Like the other CC2 bots, the champion can search a queue beyond 14.
    const deep = { ...counted, queueDepth: 20 };
    const deepRequest = createChampionRequest(state, deep, { requestId: "deep" });
    assert.equal(deepRequest.start.queue.length, 20);
    const deepResponse = await session.decideF14({ request: deepRequest, profile: deepRequest.execution });
    assert.equal(deepResponse.status, "move", JSON.stringify(deepResponse));
    assert.equal(resolveChampionDecision({ state, gui, request: deepRequest, response: deepResponse, parameters: deep })
      .transition.legality.legal, true);
    const tampered = { ...deepRequest, start: { ...deepRequest.start, queue: deepRequest.start.queue.slice(0, 19) } };
    assert.throws(() => resolveChampionDecision({ state, gui, request: tampered, response: deepResponse, parameters: deep }),
      /does not match/);
    // A decision searched on the default 14 pieces cannot stand in for the 20-piece request.
    const shallowRequest = { ...deepRequest, start: { ...deepRequest.start, queue: deepRequest.start.queue.slice(0, 14) } };
    const shallowResponse = await session.decideF14({ request: shallowRequest, profile: shallowRequest.execution });
    assert.equal(shallowResponse.search.queueLength, undefined);
    assert.equal(deepResponse.search.queueLength, 20);
    assert.throws(() => resolveChampionDecision({ state, gui, request: deepRequest, response: shallowResponse, parameters: deep }),
      /not searched on the requested queue/);
  } finally { await session.close(); }
});

test("champion INPUT match honours THINK TIME and a QUEUE DEPTH beyond 14", { skip: !existsSync(wasmPath), timeout: 120_000 }, async () => {
  const wasmBytes = readFileSync(wasmPath);
  const runtime = createNativeInputRuntime({ engineFor: () => assert.fail("the champion never starts a CC2 process"),
    f14SessionFor: () => createCc2WasmSession({ wasmBytes }) });
  const requests = [];
  const handlers = createGuiInputMatchHandlers({ runtime: { ...runtime,
    decideF14: async (payload) => { requests.push(payload); return runtime.decideF14(payload); } } });
  try {
    const start = await handlers.handle({ method: "POST", path: "/api/input-match/start", body: {
      left: "human", right: "cc2-s2-champion", seed: 42, maxTurns: null,
      rightParameters: { ...defaultBotParameters("cc2-s2-champion"), ppsEnabled: false, thinkTimeEnabled: true, thinkMs: 80, queueDepth: 20 } } });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    let view = start.body;
    for (let frame = 1; frame < 600 && view.bots[1].stats.turns < 1; frame++) {
      view = (await handlers.handle({ method: "POST", path: "/api/input-match/step", body: { sessionId: start.body.sessionId, frame } })).body;
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    assert.equal(view.bots[1].stats.turns, 1);
    assert.equal(requests[0].profile.budget.mode, "time");
    assert.equal(requests[0].profile.budget.maxMillis, 80);
    // A depth beyond 14 searches every public piece up to QUEUE DEPTH: the
    // Triangle queue holds 13-19 NEXT after a spawn.
    const { known } = requests[0].request.selector.pieces;
    assert.equal(requests[0].request.start.queue.length, Math.min(20, 1 + known.length));
  } finally { await runtime.closeSessions(); }
});
