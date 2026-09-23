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
import { applyTransition } from "../src-js/transition.mjs";
import { defaultBotParameters, normalizeBotParameters } from "../src-js/bot-parameters.mjs";
import { fullStateKey } from "../src-js/state-keys.mjs";
import { createChampionProfile, createChampionRequest, resolveChampionDecision } from "../src-js/champion-parameters.mjs";

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
        const expected = createPublicCompatRequest(probe, { requestId: "r" });
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

test("champion INPUT order keeps the core's selection first, then solvent candidates by score", () => {
  const identity = (x) => canonicalize({ location: { orientation: "north", type: "O", x, y: 1 }, spin: "none" });
  const identities = [0, 2, 4, 6].map(identity);
  // `returnedIdentities` is CC2 order (what cc2Rank indexes); `identities` is
  // the core's ranked order, which differs from it.
  const moves = championInputMoves({ status: "move", selectedIdentity: identities[2], ranking: {
    returnedIdentities: identities, identities: [identities[2], identities[3], identities[0], identities[1]],
    selectedCc2Rank: 2, candidates: [
      { cc2Rank: 0, solvent: false, selectionScore: 10 },
      { cc2Rank: 1, solvent: true, selectionScore: -3 },
      { cc2Rank: 2, solvent: true, selectionScore: -9 },
      { cc2Rank: 3, solvent: true, selectionScore: 1 },
    ] } });
  assert.deepEqual(moves.map(canonicalize), [identities[2], identities[3], identities[1], identities[0]]);
  assert.throws(() => championInputMoves({ status: "incomplete", reason: "deadline" }), /incomplete/);
  const withHold = { status: "move", selectedIdentity: canonicalize({ location: { orientation: "north", type: "T", x: 4, y: 1 }, spin: "none" }),
    ranking: { selectedCc2Rank: 0, returnedIdentities: [
      canonicalize({ location: { orientation: "north", type: "T", x: 4, y: 1 }, spin: "none" }), identities[1], identities[0]],
    candidates: [{ cc2Rank: 0, solvent: true, selectionScore: 0 }, { cc2Rank: 1, solvent: true, selectionScore: -1 },
      { cc2Rank: 2, solvent: true, selectionScore: -2 }] } };
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

test("champion INPUT match locks the WASM F14 core selection, also under incoming garbage", { skip: !existsSync(wasmPath) || !existsSync(rawBinary), timeout: 300_000 }, async (t) => {
  const wasmBytes = readFileSync(wasmPath);
  // Raw CC2 is the opponent so that garbage actually arrives; a mirror match cancels it all.
  const runtime = createNativeInputRuntime({
    engineFor: (type) => type === "cc2-raw" ? { binary: rawBinary } : assert.fail("the champion never starts a CC2 process"),
    f14SessionFor: () => createCc2WasmSession({ wasmBytes }) });
  const decisions = [];
  const plans = [];
  const handlers = createGuiInputMatchHandlers({ runtime: {
    ...runtime,
    decideF14: async (payload) => { const response = await runtime.decideF14(payload); decisions.push({ payload, response }); return response; },
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
    assert.ok(decisions.every(({ payload }) => canonicalize(payload.profile) === canonicalize(createPublicCompatProfile())));
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
    // A fresh core session answers the same request identically.
    const fresh = await createCc2WasmSession({ wasmBytes });
    try {
      for (const { payload, response } of decisions.slice(0, 5)) {
        const again = await fresh.decideF14({ request: payload.request, profile: payload.profile });
        assert.equal(again.selectedIdentity, response.selectedIdentity);
      }
    } finally { await fresh.close(); }
  } finally {
    await runtime.closeSessions();
  }
});

test("champion GUI parameters at their defaults are exactly the champion's profile and request", () => {
  const defaults = defaultBotParameters("cc2-s2-champion");
  assert.equal(canonicalize(createChampionProfile(defaults)), canonicalize(createPublicCompatProfile()));
  for (const seed of [1, 2, 3]) {
    const state = withPendingGarbage(guiStateToCanonical(toS2GuiState(createGame(seed))), seed);
    assert.equal(canonicalize(createChampionRequest(state, defaults, { requestId: "r" })),
      canonicalize(createPublicCompatRequest(state, { requestId: "r" })));
  }
  const timed = createChampionProfile({ ...defaults, thinkTimeEnabled: true, thinkMs: 300, selectionEnabled: false });
  assert.deepEqual(timed.budget, { mode: "time", selections: 1_000_000, maxMillis: 300 });
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

test("champion INPUT match honours THINK TIME and a 15-piece QUEUE DEPTH", { skip: !existsSync(wasmPath), timeout: 120_000 }, async () => {
  const wasmBytes = readFileSync(wasmPath);
  const runtime = createNativeInputRuntime({ engineFor: () => assert.fail("the champion never starts a CC2 process"),
    f14SessionFor: () => createCc2WasmSession({ wasmBytes }) });
  const requests = [];
  const handlers = createGuiInputMatchHandlers({ runtime: { ...runtime,
    decideF14: async (payload) => { requests.push(payload); return runtime.decideF14(payload); } } });
  try {
    const start = await handlers.handle({ method: "POST", path: "/api/input-match/start", body: {
      left: "human", right: "cc2-s2-champion", seed: 42, maxTurns: null,
      rightParameters: { ...defaultBotParameters("cc2-s2-champion"), ppsEnabled: false, thinkTimeEnabled: true, thinkMs: 80, queueDepth: 15 } } });
    assert.equal(start.status, 200, JSON.stringify(start.body));
    let view = start.body;
    for (let frame = 1; frame < 600 && view.bots[1].stats.turns < 1; frame++) {
      view = (await handlers.handle({ method: "POST", path: "/api/input-match/step", body: { sessionId: start.body.sessionId, frame } })).body;
      await new Promise((resolveWait) => setTimeout(resolveWait, 5));
    }
    assert.equal(view.bots[1].stats.turns, 1);
    assert.equal(requests[0].profile.budget.mode, "time");
    assert.equal(requests[0].profile.budget.maxMillis, 80);
    // INPUT shows the current piece and 14 NEXT, so 15 is its deepest queue.
    assert.equal(requests[0].request.start.queue.length, 15);
  } finally { await runtime.closeSessions(); }
});
