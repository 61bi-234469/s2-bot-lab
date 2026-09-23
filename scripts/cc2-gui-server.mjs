import { createPublicCompatProfile } from "../src-js/public-compat-request.mjs";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { extname, normalize, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createCc2Session, requestCc2Suggestion } from "../src-js/cc2-bridge.mjs";
import { createCc2WasmSession } from "../src-js/cc2-wasm-engine.mjs";
import { createGuiInputMatchHandlers } from '../src-js/gui-input-match.mjs';
import { applyQualifiedCc2Suggestion } from "../src-js/gui-request-handlers.mjs";
import { assertChampionParameters, createChampionProfile, createChampionRequest, resolveChampionDecision } from "../src-js/champion-parameters.mjs";
import { isInputBotType } from '../src-js/input-bot-contract.mjs';
import { createNativeInputRuntime } from '../src-js/native-input-runtime.mjs';
import {
  suggestionFailureOutcome,
} from "../src-js/cc2-suggestion-failure.mjs";
import {
  classifyProposalError,
  successfulProposal,
} from "../src-js/proposal-outcome.mjs";
import { attachS2SubmissionFingerprint } from "../src-js/s2-f12-amount-only-post-tank-solvency-rescue-selector.mjs";
import { guiStateToCanonical } from "../src-js/cc2-s2-adapter.mjs";
import { invokeAnalysis } from "../src-js/analysis-api.mjs";
import {
  compareSamePositionCandidates,
  compareSimpleSamePositionCandidates,
} from "../src-js/comparison-contract.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";
import {
  advanceBotMatch,
  botMatchNextStep,
  botMatchToGuiState,
  createBotMatch,
  extendBotMatchQueue,
  externalLockFrameWindow,
} from "../src-js/bot-match-controller.mjs";
import { applyHumanFinalPlacementUnderObservedS2 } from "../src-js/human-s2-adapter.mjs";
import {
  HANDICAP_GARBAGE_ID,
  applyHandicapToLegacyStart,
  normalizeHandicapGarbage,
} from "../src-js/gui-1p-handicap-garbage.mjs";
import { normalizeTurnMatch, turnMatchControllerOptions } from "../src-js/gui-turn-match.mjs";
import { placementGeometry } from "../src-js/triangle/placement-geometry.mjs";
import {
  QUEUE_MODE_LEGACY_LCG,
  createGame,
  extendSeededQueue,
  lockedPieceCells,
  toS2GuiState,
} from "../cc2-gui/game.mjs";
import { fullStateKey } from "../src-js/state-keys.mjs";
import { applyTransition } from "../src-js/transition.mjs";
import {
  createGuiStaticDecisionRequest as createS2AmountOnlyDecisionRequest,
  isGuiStaticType as isAdr062QualifiedStaticType,
} from "../src-js/s2-amount-only-decision-state.mjs";
import { resolveGuiStaticSubmission as resolveQualifiedStaticCc2Submission } from "../src-js/gui-static-public-resolver.mjs";
import {
  matchOutcome,
  normalizeBotMatchOptions,
  ppsForCc2Parameters,
  realtimeCc2ThinkMs,
} from "../src-js/bot-match-options.mjs";
import { runBotProposals } from "../src-js/bot-proposal-runner.mjs";
import { createLiveMatchMutationQueue } from "../src-js/live-match-mutation.mjs";
import { realtimeDeadlineDelayMs, realtimeScheduledLockFrame } from "../src-js/realtime-match-pacing.mjs";
import { stallPenaltyProjectionTopsOut } from "../src-js/stall-penalty-topout.mjs";
import { calculatePlayerMetrics } from "../cc2-gui/player-metrics.mjs";
import { botParameterCapability, fairComparisonBotParameters, normalizeBotParameters } from "../src-js/bot-parameters.mjs";
import { loadS2Config, s2ConfigArguments } from "../src-js/cc2-s2-config.mjs";
import { RULESET_IDS, resolvePlacementRules } from "../src-js/ruleset-profiles.mjs";
import { canonicalTransitionHttpResponse } from "../src-js/canonical-transition-api.mjs";
import { guiStateToCc2NativeStart } from "../src-js/cc2-s2-native-start.mjs";
import { MAX_TTRM_TEXT_LENGTH, TtrmError, parseTtrm } from "../src-js/replay/ttrm-parser.mjs";
import { buildReplayIR, nowMs } from "../src-js/replay/ttrm-simulator.mjs";
import {
  appendMatchLocks,
  createMatchRecording,
  finishMatchRecording,
} from "../src-js/replay/bot-match-recorder.mjs";


const root = resolve(fileURLToPath(new URL("../cc2-gui", import.meta.url)));
const GUI_CC2_SEARCH_SEED = "5994928009864282113";
const options = parseArguments(process.argv.slice(2));
const cc2Engines = Object.freeze({
  "cc2-raw": Object.freeze({
    botType: "cc2-raw",
    engineId: "minuskelvin-cold-clear-2/ed8b193",
    label: "Raw CC2 — MinusKelvin upstream",
    repository: "https://github.com/MinusKelvin/cold-clear-2",
    commit: "ed8b19327b6bd1410ddd873d8611485bd45d8fae",
    comparisonSource: "minuskelvin-cc2-final-placement",
    binary: options.rawBinary,
  }),
  "cc2-chouhy": Object.freeze({
    botType: "cc2-chouhy",
    engineId: "chouhy-cold-clear-2/b20a92b",
    label: "CC2 — chouhy fork (b20a92b)",
    repository: "https://github.com/chouhy/cold-clear-2",
    commit: "b20a92b0ed3230dd910d0674f7a09c552a34dd46",
    comparisonSource: "chouhy-cc2-final-placement",
    binary: options.chouhyBinary,
  }),
  "cc2-s2-f14": Object.freeze({
    botType: "cc2-s2-f14",
    engineId: "cold-clear-2-s2-f14-post-tank-solvency-rescue/1",
    label: "CC2 S2 — F14 post-tank solvency rescue (development)",
    repository: "https://github.com/61bi-234469/s2-bot-lab",
    commit: "ed8b193+local-s2-reranker",
    comparisonSource: "cold-clear-2-s2-f14-post-tank-solvency-rescue-final-placement",
    protocolName: "Cold Clear 2 S2",
    binary: options.s2Binary,
    config: loadS2Config("fixtures/tuning/cc2-s2-spin-value-aligned.json"),
  }),
  "cc2-s2-champion": Object.freeze({
    botType: "cc2-s2-champion",
    engineId: "cold-clear-2-s2-development-champion/f14-substrate-v2-search-state/1",
    label: "CC2 S2 — current development champion (not release-qualified)",
    repository: "https://github.com/61bi-234469/s2-bot-lab",
    commit: "local-development-champion-f14-substrate-v2-search-state",
    comparisonSource: "cold-clear-2-s2-development-champion-final-placement",
    protocolName: "Cold Clear 2 S2",
    binary: options.f14ChampionBinary,
    wasm: options.f14Wasm,
    f14Compat: options.f14ChampionBinary !== null,
    f14WasmCompat: options.f14ChampionBinary === null && options.f14Wasm !== null,
    f14Public: options.f14ChampionBinary !== null || options.f14Wasm !== null,
    wasmSha256: fileSha256IfPresent(options.f14Wasm),
    config: loadS2Config("fixtures/tuning/cc2-s2-spawn-integrity-substrate-v2.json"),
  }),
});
/* Modules the browser and Node share verbatim. Each URL basename matches the
   file's own name, so the relative imports inside them resolve to another entry
   of this table when the browser fetches them. */
const SHARED_MODULES = new Map([
  ["/shared/input-bot-contract.mjs", "../src-js/input-bot-contract.mjs"],
  ["/shared/bot-parameters.mjs", "../src-js/bot-parameters.mjs"],
  ["/shared/bot-match-options.mjs", "../src-js/bot-match-options.mjs"],
  ["/shared/stall-penalty-topout.mjs", "../src-js/stall-penalty-topout.mjs"],
  ["/shared/pieces.mjs", "../src-js/replay/pieces.mjs"],
  ["/shared/replay-garbage.mjs", "../src-js/replay/replay-garbage.mjs"],
  ["/shared/replay-timeline.mjs", "../src-js/replay/replay-timeline.mjs"],
  ["/shared/replay-ir-validation.mjs", "../src-js/replay/replay-ir-validation.mjs"],
]);
const runId = randomUUID();
let nextRequestId = 1;
let matchSession = null;
/* Every mutation of the live match snapshot runs through this chain. A human
   player locks whenever they press the key, which can land while a bot proposal
   is still being computed, and two overlapping advances would each build their
   next state from the same stale snapshot. Bot search deliberately happens
   outside the chain, so waiting for a slow opponent never delays the player's
   own lock. */
const matchMutations = createLiveMatchMutationQueue();

// INPUT keeps its resolution worker. CC2 bots propose through their native
// executables; the champion decides through the same F14 WASM core as its
// final-placement route, read from `f14InputWasm` and bound to its startup hash.
const inputChampionWasm = Object.freeze({ label: cc2Engines["cc2-s2-champion"].label,
  wasm: options.f14InputWasm, wasmSha256: fileSha256IfPresent(options.f14InputWasm) });
const inputRuntime = createNativeInputRuntime({ engineFor: inputEngineFor, f14SessionFor: inputF14Session });
async function inputF14Session(type) {
  if (type !== "cc2-s2-champion") throw new Error(`unsupported F14 INPUT bot ${type}`);
  if (inputChampionWasm.wasmSha256 === null) throw new Error(`${inputChampionWasm.label} WASM artifact not found: ${inputChampionWasm.wasm}`);
  return createCc2WasmSession({ wasmBytes: readWasmBytesMatchingHash(inputChampionWasm) });
}
function inputEngineFor(type) {
  if (type === "cc2-s2-f14") return {
    botType: type,
    engineId: "cold-clear-2-s2-f14-post-tank-solvency-rescue/1",
    protocolName: "Cold Clear 2 S2",
    binary: options.s2Binary,
    config: loadS2Config("fixtures/tuning/cc2-s2-spin-value-aligned.json"),
  };
  if (type === "cc2-s2-champion") {
    if (inputChampionWasm.wasmSha256 === null) throw new Error(`${inputChampionWasm.label} WASM artifact not found: ${inputChampionWasm.wasm}`);
    return { botType: type, f14Core: true };
  }
  return requireCc2Engine(type);
}
/* INPUT availability is reported separately because the champion's INPUT
   route always has the WASM core (explicit locator or build output), even
   when final placement is bound to a native `--f14-champion` binary. */
function inputUnavailableReason(type) {
  if (!isInputBotType(type)) return undefined;
  try { inputEngineFor(type); return null; }
  catch (error) { return error.message; }
}
const inputMatches = createGuiInputMatchHandlers({ runtime: inputRuntime });
const server = createServer(async (request, response) => {
  try {
    if (request.url.startsWith('/api/input-match/')) {
      const result = await inputMatches.handle({ method: request.method, path: request.url,
        body: request.method === 'POST' ? await readJson(request) : null });
      return sendJson(response, result.status, result.body);
    }
    if (request.method === "POST" && request.url === "/api/suggest") {
      const body = await readJson(request);
      const engine = requireCc2Engine(body.engine ?? "cc2-raw");
      if (engine.f14Compat) {
        const parameters = nativeChampionParameters(normalizeBotParameters(engine.botType, body.parameters));
        const state = guiStateToCanonical(body.state);
        const nativeRequest = createChampionRequest(state, parameters, { requestId: `analysis-${nextRequestId++}`, generation: 1 });
        const abort = new AbortController();
        const disconnected = () => { if (!response.writableEnded) abort.abort(); };
        response.once("close", disconnected);
        let session;
        let payload;
        try {
          session = await createCc2Session({ binary: engine.binary, expectedName: engine.protocolName,
            f14CompatProfile: nativeRequest.execution, suggestTimeoutMs: 32_000 });
          const nativeDecision = await session.decide({ request: nativeRequest, signal: abort.signal });
          const resolved = resolveChampionDecision({ state, gui: body.state, request: nativeRequest, response: nativeDecision, parameters });
          payload = {
            engine: publicEngine(engine), info: { name: engine.protocolName, version: "F14 public profile B" },
            suggestion: { moves: [nativeDecision.selectedMove] },
            nativeDecision,
            verification: { ...resolved.verification, move: nativeDecision.selectedMove },
          };
        } finally {
          try { await session?.close(); }
          finally { response.off("close", disconnected); }
        }
        if (abort.signal.aborted) return;
        return sendJson(response, 200, payload);
      }
      if (engine.f14WasmCompat) {
        const parameters = normalizeBotParameters(engine.botType, body.parameters);
        const state = guiStateToCanonical(body.state);
        const nativeRequest = createChampionRequest(state, parameters, { requestId: `analysis-${nextRequestId++}`, generation: 1 });
        const profile = nativeRequest.execution;
        let session;
        let payload;
        try {
          session = await createF14WasmSession(engine);
          const nativeDecision = await session.decideF14({ request: nativeRequest, profile });
          const resolved = resolveChampionDecision({ state, gui: body.state, request: nativeRequest, response: nativeDecision, parameters });
          payload = {
            engine: publicEngine(engine), info: { name: engine.protocolName, version: "F14 public profile B WASM" },
            suggestion: { moves: [nativeDecision.selectedMove] },
            nativeDecision,
            verification: { ...resolved.verification, move: nativeDecision.selectedMove },
          };
        } finally {
          await session?.close();
        }
        return sendJson(response, 200, payload);
      }
      if (!isAdr062QualifiedStaticType(engine.botType)) throw new Error("ADR-062-qualified resolver required");
      const result = await requestCc2Suggestion({
        binary: engine.binary,
        state: guiStateToCc2NativeStart(body.state),
        thinkMs: body.thinkMs,
        expectedName: engine.protocolName,
      });
      return sendJson(response, 200, { ...result, engine: publicEngine(engine) });
    }
    if (request.method === "POST" && request.url === "/api/apply-s2") {
      const body = await readJson(request);
      const engine = requireCc2Engine(body.engine ?? "cc2-raw");
      if (engine.f14Compat || engine.f14WasmCompat) return sendJson(response, 422, { error: "F14 native compatibility publishes a verified final decision through /api/suggest; external reranking is unsupported" });
      const result = applyQualifiedCc2Suggestion({ type: engine.botType, engine: publicEngine(engine),
        state: guiStateToCanonical(body.state), moves: body.moves ?? [body.move] });
      return sendJson(response, result.status, result.body);
    }
    if (request.method === "POST" && request.url === "/api/s2/transition") {
      const body = await readJson(request);
      const result = canonicalTransitionHttpResponse(body);
      return sendJson(response, result.statusCode, result.body);
    }
    if (request.method === "POST" && request.url === "/api/analyze-s2") {
      const body = await readJson(request);
      const state = guiStateToCanonical(body.state);
      const result = invokeAnalysis({
        apiVersion: 1,
        runId,
        requestId: String(nextRequestId++),
        operation: "analyzeTopN",
        rulesetId: state.rulesetId,
        positionFingerprint: fullStateKey(state),
        state,
        params: { n: body.n ?? 5, maxDepth: body.maxDepth ?? 1 },
        budget: { kind: "time", thinkMs: body.thinkMs ?? 500, deadlineMs: null, nodes: null },
        determinism: { enabled: true, seed: 0 },
      });
      return sendJson(response, result.status === "error" ? 400 : 200, result);
    }
    if (request.method === "POST" && request.url === "/api/compare") {
      const body = await readJson(request);
      try {
        return sendJson(response, 200, compareSamePositionCandidates(body.baseline, body.challenger));
      } catch (error) {
        return sendJson(response, 422, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (request.method === "POST" && request.url === "/api/simple-s2") {
      const body = await readJson(request);
      const state = guiStateToCanonical(body.state);
      return sendJson(response, 200, analyzeSimpleS2FinalPlacements(state, { topN: body.n ?? 5 }));
    }
    if (request.method === "POST" && request.url === "/api/compare-simple") {
      const body = await readJson(request);
      try {
        return sendJson(response, 200, compareSimpleSamePositionCandidates(body.baseline, body.challenger));
      } catch (error) {
        return sendJson(response, 422, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (request.method === "POST" && request.url === "/api/match/start") {
      const body = await readJson(request);
      let leftType;
      let rightType;
      let config;
      let botParameters;
      let humanSide;
      let handicap;
      let turnMatch;
      try {
        leftType = assertBotType(body.left ?? "cc2-raw");
        rightType = assertBotType(body.right ?? "s2-simple");
        humanSide = resolveHumanSide(leftType, rightType);
        config = normalizeBotMatchOptions(body);
        handicap = normalizeHandicapGarbage(body.handicap, { humanSide });
        turnMatch = normalizeTurnMatch(body.turnMatch, { humanSide });
        if (humanSide !== null && config.fairComparison) {
          throw new Error("fair comparison fixes both sides at 1 PPS and cannot include a human player");
        }
        botParameters = {
          left: config.fairComparison
            ? fairComparisonBotParameters(leftType, body.leftParameters)
            : normalizeBotParameters(leftType, body.leftParameters),
          right: config.fairComparison
            ? fairComparisonBotParameters(rightType, body.rightParameters)
            : normalizeBotParameters(rightType, body.rightParameters),
        };
        for (const [side, type] of [["left", leftType], ["right", rightType]]) {
          if (type === "cc2-s2-champion") {
            if (cc2Engines[type].f14Compat) nativeChampionParameters(botParameters[side]);
            else assertChampionParameters(botParameters[side]);
          }
        }
      } catch (error) {
        return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      await closeCc2MatchSessions(matchSession);
      if (body.ttrmCompatible === true) return sendJson(response, 409, { error: 'Use /api/input-match/start for .ttrm input execution' });
      const ttrmCompatible = false;
      const queueModel = QUEUE_MODE_LEGACY_LCG;
      const scenario = createGame(config.seed, { queueModel });
      const initial = guiStateToCanonical(toS2GuiState(scenario));
      // The 1P handicap changes only the human side's start position. The
      // opposing bot keeps the ordinary empty board.
      const handicapStart = handicap.enabled
        ? applyHandicapToLegacyStart(initial, { seed: config.seed, appliedTo: humanSide })
        : null;
      const startState = (botId) => structuredClone(
        handicapStart !== null && botId === humanSide ? handicapStart.state : initial,
      );
      const turnOptions = turnMatchControllerOptions(turnMatch, humanSide);
      const match = createBotMatch({
        bots: [
          { id: "left", gameId: 1, state: startState("left") },
          { id: "right", gameId: 2, state: startState("right") },
        ],
        // A turn match has no rate for either side: the controller's own
        // alternating/simultaneous schedule owns every lock frame.
        ...(turnOptions ?? {
          mode: "paced",
          // A human side is declared as externally paced: their lock times come
          // from the browser as they actually play, not from a configured rate.
          ppsByBotId: {
            left: pacedRateFor("left", leftType, humanSide, config, botParameters),
            right: pacedRateFor("right", rightType, humanSide, config, botParameters),
          },
        }),
      });
      matchSession = {
        types: { left: leftType, right: rightType },
        humanSide,
        turnMatch,
        botParameters,
        config,
        ttrmCompatible,
        queueModel,
        cc2Sessions: new Map(),
        inFlightStep: null,
        queueSeeds: { left: scenario.bagSeed, right: scenario.bagSeed },
        match,
        handicap: handicapStart?.record ?? { id: HANDICAP_GARBAGE_ID, enabled: false },
        recording: createMatchRecording({ match, handicap: handicapStart?.record ?? null, meta: matchReplayMeta({
          match,
          config,
          types: { left: leftType, right: rightType },
          botParameters,
          firstTo: positiveIntegerOrDefault(body.firstTo, 1),
          ttrmCompatible,
          queueModel,
          handicapEnabled: handicap.enabled,
          turnMatch,
        }) }),
        finishedRound: null,
      };
      return sendJson(response, 200, matchView(matchSession));
    }
    if (request.method === "POST" && request.url === "/api/match/step") {
      if (matchSession === null) return sendJson(response, 409, { error: "match-not-started" });
      const currentView = matchView(matchSession);
      if (currentView.outcome.complete) return sendJson(response, 409, { error: "match-complete", outcome: currentView.outcome });
      // Bot-only keeps the canonical synthetic clock. In 1P the browser sends
      // its monotonic wall frame and a late opponent is committed no earlier
      // than the measured completion frame.
      const body = await readJson(request);
      // A turn match advances through the 1P lock while the person is the due
      // side; a step would otherwise commit a turn with one half missing.
      if (matchSession.turnMatch.enabled &&
          botMatchNextStep(matchSession.match).botIds.includes(matchSession.humanSide)) {
        return sendJson(response, 409, { error: "human-lock-required" });
      }
      return sendJson(response, 200, await stepScheduledBots(matchSession, { requestedWallFrame: body?.lockFrame }));
    }
    if (request.method === "POST" && request.url === "/api/match/human-lock") {
      if (matchSession === null) return sendJson(response, 409, { error: "match-not-started" });
      const session = matchSession;
      if (session.humanSide === null) return sendJson(response, 409, { error: "no-human-player" });
      const body = await readJson(request);
      if (session.turnMatch.enabled) {
        const dueBotIds = botMatchNextStep(session.match).botIds;
        if (!dueBotIds.includes(session.humanSide)) return sendJson(response, 409, { error: "not-your-turn" });
        // A simultaneous turn is carried by this lock. Joining an in-flight
        // turn would drop the placement silently, so it is refused instead.
        if (dueBotIds.length > 1 && session.inFlightStep !== null) {
          return sendJson(response, 409, { error: "turn-in-progress" });
        }
        try {
          const view = dueBotIds.length > 1
            ? await stepScheduledBots(session, { turnPlacement: body.placement })
            : await withMatchMutation(() => commitTurnHumanLock(session, body.placement));
          if (view.outcome.complete) await closeCc2MatchSessions(session);
          return sendJson(response, 200, view);
        } catch (error) {
          return sendJson(response, 422, { error: error instanceof Error ? error.message : String(error) });
        }
      }
      const requestedFrame = body.lockFrame;
      if (!Number.isSafeInteger(requestedFrame) || requestedFrame < 0) {
        return sendJson(response, 400, { error: "lockFrame must be a non-negative safe integer" });
      }
      const outcome = matchView(session).outcome;
      if (outcome.complete) return sendJson(response, 409, { error: "match-complete", outcome });
      const view = await withMatchMutation(() => commitHumanLock(session, body.placement, requestedFrame));
      return sendJson(response, 200, view);
    }
    if (request.method === "POST" && request.url === "/api/match/human-penalty-topout") {
      if (matchSession === null) return sendJson(response, 409, { error: "match-not-started" });
      const session = matchSession;
      if (session.humanSide === null) return sendJson(response, 409, { error: "no-human-player" });
      const body = await readJson(request);
      try {
        const view = await withMatchMutation(() => commitHumanPenaltyTopOut(session, body.penaltyRows));
        await closeCc2MatchSessions(session);
        return sendJson(response, 200, view);
      } catch (error) {
        return sendJson(response, 422, { error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (request.method === "POST" && request.url === "/api/match/close") {
      await readJson(request);
      const session = matchSession;
      matchSession = null;
      await closeCc2MatchSessions(session);
      return sendJson(response, 200, { closed: true });
    }
    if (request.method === "GET" && request.url === "/api/match/round") {
      if (matchSession === null || matchSession.recording === undefined) {
        return sendJson(response, 409, { error: "match-not-started" });
      }
      if (matchSession.finishedRound !== null) return sendJson(response, 200, structuredClone(matchSession.finishedRound));
      const view = matchView(matchSession);
      if (view.outcome.complete) finalizeMatchRecording(matchSession, view.outcome);
      const round = matchSession.finishedRound ?? finishMatchRecording(matchSession.recording, {
        outcome: view.outcome,
        match: matchSession.match,
      });
      return sendJson(response, 200, round);
    }
    if (request.method === "GET" && request.url === "/api/match/ttrm") {
      return sendJson(response, 409, { stage: 'input-required', message: 'Use an input-mode match to save .ttrm' });
    }
    if (request.method === "GET" && request.url === "/api/placement-geometry") {
      return sendJson(response, 200, {
        rulesetId: RULESET_IDS.s2Observed,
        ...placementGeometry(resolvePlacementRules(RULESET_IDS.s2Observed)),
      });
    }
    if (request.method === "GET" && request.url === "/api/bots") {
      return sendJson(response, 200, {
        // Every GUI state is built under the observed S2 profile, so the rules
        // the viewer needs to read a counter are resolved from that profile
        // rather than restated in the front end. B2B charging is the only one
        // so far: Surge fires when a chain longer than `at` is broken.
        ruleset: {
          id: RULESET_IDS.s2Observed,
          b2bCharging: resolvePlacementRules(RULESET_IDS.s2Observed).b2bCharging,
        },
        bots: [
          ...Object.values(cc2Engines).map((engine) => ({
            ...publicEngine(engine),
            id: engine.botType,
            available: engineUnavailableReason(engine) === null,
            reason: engineUnavailableReason(engine),
            ...(isInputBotType(engine.botType) ? {
              inputAvailable: inputUnavailableReason(engine.botType) === null,
              inputReason: inputUnavailableReason(engine.botType),
            } : {}),
            ...botParameterCapability(engine.botType),
            ...((engine.f14Compat || engine.f14WasmCompat) ? { fixedDecision: true, execution: createPublicCompatProfile(),
              description: engine.f14WasmCompat ? "F14 public profile B: local final placement and INPUT use the WASM artifact (--f14-wasm or the build output). The defaults (512 selections, THINK TIME off, queue 14) are the champion. Not release-qualified." : "F14 public profile B: local final placement uses one Rust process (THINK TIME needs the WASM core); INPUT uses the WASM core. The defaults are the champion. Not release-qualified." } : {}),
          })),
          { id: "human", label: "You (1P)", available: true, ...botParameterCapability("human") },
        ],
      });
    }
    if (request.method === "POST" && request.url === "/api/replay/import") {
      const startedAt = nowMs();
      let text;
      try {
        text = await readText(request, MAX_TTRM_TEXT_LENGTH);
      } catch (error) {
        return sendJson(response, 413, { stage: "size", message: error instanceof Error ? error.message : String(error) });
      }
      try {
        // Parsing and the per-player engine replay are one request: the browser
        // has no Triangle Engine, so ReplayIR is only ever produced here.
        return sendJson(response, 200, { ir: buildReplayIR(parseTtrm(text), startedAt) });
      } catch (error) {
        if (error instanceof TtrmError) {
          return sendJson(response, 422, { stage: error.stage, message: error.message });
        }
        return sendJson(response, 500, {
          stage: "simulate",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (request.method === "GET" && SHARED_MODULES.has(request.url)) {
      const moduleFile = resolve(root, SHARED_MODULES.get(request.url));
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
      createReadStream(moduleFile).pipe(response);
      return;
    }
    if (request.method !== "GET") return sendJson(response, 405, { error: "method-not-allowed" });
    const requested = request.url === "/" ? "index.html" : request.url.slice(1).split("?")[0];
    const file = resolve(root, normalize(requested));
    if (!file.startsWith(`${root}\\`) && file !== root) {
      return sendJson(response, 404, { error: "not-found" });
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      return sendJson(response, 404, { error: "not-found" });
    }
    response.writeHead(200, { "content-type": contentType(file), "cache-control": "no-store" });
    createReadStream(file).pipe(response);
  } catch (error) {
    sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

server.listen(options.port, "127.0.0.1", () => {
  console.log(`CC2 GUI: http://127.0.0.1:${options.port}/`);
  for (const engine of Object.values(cc2Engines)) {
    const artifact = engine.f14WasmCompat
      ? (engine.wasmSha256 === null ? `unavailable (${engine.wasm})` : `WASM ${engine.wasm} (${engine.wasmSha256})`)
      : (isFilePath(engine.binary) ? engine.binary : `unavailable (${engine.binary ?? "not configured"})`);
    console.log(`${engine.label}: ${artifact}`);
  }
});

process.once("exit", () => {
  if (!(matchSession?.cc2Sessions instanceof Map)) return;
  for (const cc2Session of matchSession.cc2Sessions.values()) {
    if (typeof cc2Session.terminate === "function") cc2Session.terminate();
    else void cc2Session.close?.();
  }
});

/** Serializes one mutation of the live match snapshot against every other. */
function withMatchMutation(work) {
  return matchMutations.run(work);
}

/**
 * Runs the bots the synthetic schedule has due next.
 *
 * Search happens outside the mutation chain and its placement is re-evaluated
 * against the position as it stands when the lock is actually committed. A
 * human opponent can lock while a bot is still searching, and the garbage that
 * delivers changes the searching bot's canonical state without changing which
 * placements are legal from its board.
 */
async function stepScheduledBots(session, options = {}) {
  if(session.engineCleanupError)throw new Error(session.engineCleanupError);
  if (session.inFlightStep !== null) return session.inFlightStep;
  cancelEngineIdleTimeout();
  searchesInFlight += 1;
  const work = runScheduledBots(session, options).finally(() => {
    searchesInFlight -= 1;
    if (searchesInFlight === 0 && session.cc2Sessions.size > 0) scheduleEngineIdleTimeout(session);
    if (session.inFlightStep === work) session.inFlightStep = null;
  });
  session.inFlightStep = work;
  return work;
}

async function runScheduledBots(session, { requestedWallFrame = null, turnPlacement = null } = {}) {
  // A turn match has no wall clock to be late against: every lock frame comes
  // from the controller's own turn schedule.
  const realtime = session.humanSide !== null && !session.turnMatch.enabled;
  const requestFrame = realtime && Number.isSafeInteger(requestedWallFrame) && requestedWallFrame >= 0
    ? requestedWallFrame
    : session.match.clock.logicalFrame;
  const startedAt = performance.now();
  const prepared = await withMatchMutation(() => {
    refillMatchQueues(session);
    const nextStep = botMatchNextStep(session.match);
    // A simultaneous turn schedules the 1P side too. Their half arrives as
    // `turnPlacement` rather than from a search, so only bots are proposed for.
    return { nextStep, dueBots: session.match.bots.filter((bot) =>
      nextStep.botIds.includes(bot.id) && session.types[bot.id] !== "human") };
  });
  const proposals = await runBotProposals(
    prepared.dueBots,
    (bot) => searchForBot(session, bot, prepared.dueBots.length),
    { serial: session.config.fairComparison },
  );
  if (realtime) {
    const elapsedMs = performance.now() - startedAt;
    const delayMs = realtimeDeadlineDelayMs({
      scheduledFrame: prepared.nextStep.logicalFrame,
      requestWallFrame: requestFrame,
      elapsedMs,
    });
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const stepped = await withMatchMutation(() => {
    if (matchView(session).outcome.complete) return matchView(session);
    const failed = proposals.find((proposal) => proposal.proposalResult?.status === "failure");
    if (failed !== undefined) {
      session.forcedOutcome = {
        complete: true,
        reason: "proposal-failure",
        winnerBotId: null,
        proposalResult: structuredClone(failed.proposalResult),
      };
      const view = matchView(session);
      finalizeMatchRecording(session, view.outcome);
      return view;
    }
    const forfeited = proposals.find((proposal) => proposal.type === "forfeit");
    if (forfeited !== undefined) {
      session.forcedOutcome = {
        ...suggestionFailureOutcome(
        session.match.bots,
        forfeited.botId,
        forfeited.reason,
        ),
        proposalResult: structuredClone(forfeited.proposalResult),
      };
      const view = matchView(session);
      finalizeMatchRecording(session, view.outcome);
      return view;
    }
    let submissions = proposals.map((proposal) => resolveProposal(session, proposal));
    const before = session.match;
    // The person's half of a simultaneous turn is evaluated against the same
    // snapshot the bot searched from, inside the boundary that commits both,
    // so neither side saw the other's placement.
    if (turnPlacement !== null) submissions = [...submissions, humanTurnSubmission(session, before, turnPlacement)];
    const scheduledLockFrame = realtime ? realtimeScheduledLockFrame({
      scheduledFrame: botMatchNextStep(before).logicalFrame,
      requestWallFrame: requestFrame,
      elapsedMs: performance.now() - startedAt,
      currentLogicalFrame: before.clock.logicalFrame,
    }) : null;
    const after = advanceBotMatch(before, submissions, { scheduledLockFrame });
    // This live session owns its recorder. Publish the match only after the
    // append has staged every lock and delivery without error.
    appendMatchLocks(session.recording, before, after, submissions);
    session.match = after;
    const view = matchView(session, submissions, before);
    finalizeMatchRecording(session, view.outcome);
    return view;
  });
  // A finished match never searches again: the next step returns
  // `match-complete` and a new match rebuilds its own sessions. Releasing the
  // engine processes here keeps a finished tab from holding two of them.
  if (stepped.outcome.complete) await closeCc2MatchSessions(session);
  return stepped;
}

/**
 * The real-time budget a bot's search has to fit in is one of its own locks,
 * not the time left until the next lock on the shared clock. Those are the same
 * thing in a bot-only match, where nothing but a lock moves the clock. A human
 * opponent moves it whenever they place a piece, which would otherwise shrink
 * the budget towards its floor for no reason the bot can see.
 */
function botLockCadenceFrames(session, botId) {
  const pps = session.match.pace.ppsByBotId[botId];
  return 60 / pps;
}

/** Asks one bot for a placement. Only CC2 has a search this has to wait for. */
async function searchForBot(session, bot, dueCount) {
  const type = session.types[bot.id];
  const parameters = session.botParameters[bot.id];
  if (type === "s2-simple") {
    return {
      botId: bot.id,
      type,
      proposalResult: successfulProposal({ diagnostics: { engineType: type } }),
    };
  }
  const engine = requireCc2Engine(type);
  let cc2Session = session.cc2Sessions.get(bot.id);
  if (cc2Session === undefined) {
    if (engine.f14WasmCompat) {
      cc2Session = await createF14WasmSession(engine);
    } else {
      cc2Session = await createCc2Session({
        binary: engine.binary,
        binaryArguments: !engine.f14Compat ? s2ConfigArguments(engine.config ?? null) : [],
        expectedName: engine.protocolName,
        selectionLimit: !engine.f14Compat && parameters.selectionEnabled ? parameters.selectionLimit : null,
        searchSeed: !engine.f14Compat ? GUI_CC2_SEARCH_SEED : null,
        f14CompatProfile: engine.f14Compat ? createChampionProfile(nativeChampionParameters(parameters)) : null,
      });
    }
    session.cc2Sessions.set(bot.id, cc2Session);
  }
  const gui = botMatchToGuiState(session.match, bot.id);
  let cc2;
  const searchStartedAt = performance.now();
  try {
    if (engine.f14WasmCompat) {
      const request = createChampionRequest(bot.state, parameters, {
        requestId: `gui-${bot.id}-${bot.stats.turns + 1}`, generation: bot.stats.turns + 1,
      });
      const response = await cc2Session.decideF14({ request, profile: request.execution });
      const resolved = resolveChampionDecision({ state: bot.state, gui, request, response, parameters });
      return { botId: bot.id, type, nativeResolved: resolved,
        proposalResult: successfulProposal({ diagnostics: { botId: bot.id, engineType: type }, latencyMs: performance.now() - searchStartedAt }) };
    }
    if (engine.f14Compat) {
      const request = createChampionRequest(bot.state, nativeChampionParameters(parameters), {
        requestId: `gui-${bot.id}-${bot.stats.turns + 1}`, generation: bot.stats.turns + 1,
      });
      const response = await cc2Session.decide({ request });
      const resolved = resolveChampionDecision({ state: bot.state, gui, request, response, parameters });
      return { botId: bot.id, type, nativeResolved: resolved,
        proposalResult: successfulProposal({ diagnostics: { botId: bot.id, engineType: type }, latencyMs: performance.now() - searchStartedAt }) };
    }
    cc2 = await cc2Session.suggest({
      timeLimitEnabled: parameters.thinkTimeEnabled,
      thinkMs: session.humanSide !== null || parameters.ppsEnabled === false
        ? parameters.thinkMs
        : realtimeCc2ThinkMs({
          thinkMs: parameters.thinkMs,
          stepFrames: botLockCadenceFrames(session, bot.id),
          serialProposalCount: session.config.fairComparison ? dueCount : 1,
        }),
      state: guiStateToCc2NativeStart(gui, { queueLimit: parameters.queueDepth }),
    });
  } catch (error) {
    const failure = {
      locksPlayed: bot.stats.turns,
      elapsedMs: performance.now() - searchStartedAt,
    };
    const classification = classifyProposalError({
      error,
      locksPlayed: failure.locksPlayed,
      latencyMs: failure.elapsedMs,
      diagnostics: { botId: bot.id, engineType: type },
    });
    if (classification.failure?.code === "suggestion-timeout") {
      // A timed-out process may answer the old request later. Do not let that
      // stale reply affect a later game. A timeout remains a fail-closed
      // proposal failure and does not award the opponent a win.
      cc2Session.terminate();
      session.cc2Sessions.delete(bot.id);
    }
    // A valid CC2 response can contain no placement. That is a loss for this
    // game, not an infrastructure error that abandons the remaining series.
    // An empty answer that no search could have produced is the opposite: it
    // must stop the series rather than score a win for the opponent.
    if (classification.status === "terminal") {
      return {
        botId: bot.id,
        type: "forfeit",
        reason: "no-suggested-move",
        proposalResult: classification,
      };
    }
    return { botId: bot.id, type: "failure", proposalResult: classification };
  }
  const latencyMs = Number.isFinite(cc2.requestToSuggestionMs)
    ? cc2.requestToSuggestionMs
    : performance.now() - searchStartedAt;
  return {
    botId: bot.id,
    type,
    moves: cc2.suggestion.moves,
    info: cc2.suggestion.move_info,
    proposalResult: successfulProposal({ diagnostics: { botId: bot.id, engineType: type }, latencyMs }),
  };
}

/** Turns a searched proposal into a submission against the current position. */
function resolveProposal(session, proposal) {
  const bot = session.match.bots.find((candidate) => candidate.id === proposal.botId);
  const parameters = session.botParameters[bot.id];
  const gui = botMatchToGuiState(session.match, bot.id);
  if (proposal.type === "cc2-s2-champion" && cc2Engines[proposal.type].f14Public) {
    const resolved = proposal.nativeResolved;
    if (resolved?.positionFingerprint !== fullStateKey(bot.state)) {
      throw new Error("F14 native compatibility stale result");
    }
    if (resolved?.transition?.legality?.legal !== true || resolved.transition.nextState === null) {
      throw new Error(`${bot.id} native placement rejected`);
    }
    const move = resolved.placement;
    return {
      botId: bot.id,
      result: resolved,
      positionFingerprint: resolved.positionFingerprint,
      move,
      score: resolved.score,
      nativeDecision: resolved.nativeDecision,
      lastPlaced: lockedPieceCells(gui.board, resolved.transition, move.piece),
    };
  }
  if (proposal.type === "s2-simple") {
    const analysis = analyzeSimpleS2FinalPlacements(bot.state, {
      topN: 1,
      allowHold: parameters.allowHold,
    });
    const best = analysis.moves[0];
    if (!best) throw new Error(`${bot.id} has no legal final placement`);
    return {
      botId: bot.id,
      result: {
        transition: best.transition,
        comparison: { positionFingerprint: fullStateKey(bot.state) },
      },
      move: best.placement,
      score: best.score,
      lastPlaced: lockedPieceCells(gui.board, best.transition, best.placement.piece),
    };
  }
  const engine = requireCc2Engine(proposal.type);
  if (!isAdr062QualifiedStaticType(proposal.type)) throw new Error("ADR-062-qualified resolver required");
  const resolved = resolveQualifiedStaticCc2Submission(createS2AmountOnlyDecisionRequest({
    sessionKey: bot.id, state: bot.state, moves: proposal.moves, type: proposal.type, engine: publicEngine(engine),
  }));
  const transition = applyTransition(bot.state, { kind: "placement", placement: resolved.placement }, bot.state.rulesetId);
  if (transition.legality?.legal !== true || transition.nextState === null) throw new Error(`${bot.id} CC2 placement rejected`);
  const result = { transition, comparison: { score: resolved.score } };
  const move = resolved.placement;
  return {
    ...attachS2SubmissionFingerprint(bot.id, bot.state, result),
    move,
    score: result.comparison.score,
    cc2: proposal.info,
    lastPlaced: lockedPieceCells(gui.board, result.transition, move.piece),
  };
}

/**
 * Applies one player lock, or returns `null` when the schedule leaves no frame
 * for it yet.
 *
 * The requested frame is the browser's real-time reading. A 1P lock may pass
 * an overdue scheduled bot; the controller rebases every missed bot deadline
 * in this same immutable update so no invalid snapshot escapes.
 */
function commitHumanLock(session, placement, requestedFrame) {
  if (matchView(session).outcome.complete) throw new Error("match-complete");
  refillMatchQueues(session);
  const window = externalLockFrameWindow(session.match, session.humanSide, { allowScheduledOverrun: true });
  const lockFrame = Math.max(requestedFrame, window.earliest);
  const before = session.match;
  const submission = humanTurnSubmission(session, before, placement);
  const after = advanceBotMatch(before, [submission], {
    externalLockFrame: lockFrame,
    allowScheduledOverrun: true,
  });
  // The live session owns this recorder; a failed append leaves the prior
  // match and recording snapshot available to the caller.
  appendMatchLocks(session.recording, before, after, [submission]);
  session.match = after;
  const view = matchView(session, [submission]);
  finalizeMatchRecording(session, view.outcome);
  return view;
}

/**
 * The 1P half of one alternating turn. A turn match ignores the browser's wall
 * frame: the controller's own turn schedule owns every lock frame, and a
 * placement offered outside the person's turn is refused before reaching here.
 */
function commitTurnHumanLock(session, placement) {
  if (matchView(session).outcome.complete) throw new Error("match-complete");
  refillMatchQueues(session);
  const before = session.match;
  const submission = humanTurnSubmission(session, before, placement);
  const after = advanceBotMatch(before, [submission]);
  appendMatchLocks(session.recording, before, after, [submission]);
  session.match = after;
  const view = matchView(session, [submission]);
  finalizeMatchRecording(session, view.outcome);
  return view;
}

/** The person's placement, re-evaluated by the referee against `match`. */
function humanTurnSubmission(session, match, placement) {
  const bot = match.bots.find((candidate) => candidate.id === session.humanSide);
  const gui = botMatchToGuiState(match, bot.id);
  const result = applyHumanFinalPlacementUnderObservedS2(bot.state, placement);
  if (result.transition === null) {
    throw new Error(`player placement rejected: ${result.reasons.join(", ")}`);
  }
  return {
    botId: bot.id,
    result,
    move: result.comparison.witness.placement,
    score: result.comparison.score,
    lastPlaced: lockedPieceCells(gui.board, result.transition, result.comparison.witness.placement.piece),
  };
}

function commitHumanPenaltyTopOut(session, penaltyRows) {
  const currentView = matchView(session);
  if (currentView.outcome.complete) throw new Error("match-complete");
  const player = currentView.bots.find((bot) => bot.id === session.humanSide);
  if (!stallPenaltyProjectionTopsOut(player.board, penaltyRows)) {
    throw new Error("stall penalty rows do not top out the player");
  }
  session.forcedOutcome = matchOutcome(
    currentView.bots.map((bot) => bot.id === session.humanSide ? { ...bot, toppedOut: true } : bot),
    session.match.turnNumber,
    session.config.maxTurns,
  );
  const view = matchView(session);
  finalizeMatchRecording(session, view.outcome);
  return view;
}

function resolveHumanSide(leftType, rightType) {
  if (rightType === "human") {
    throw new Error("You (1P) is available only on the left side");
  }
  if (leftType === "human" && rightType === "human") {
    throw new Error("only one side can be played by a human");
  }
  if (leftType === "human") return "left";
  return null;
}

function pacedRateFor(side, botType, humanSide, config, botParameters) {
  if (botType === "human") return null;
  if (config.fairComparison) return 1;
  return botType.startsWith("cc2-")
    ? ppsForCc2Parameters(botParameters[side], { realtime: humanSide !== null })
    : botParameters[side].pps;
}

function refillMatchQueues(session) {
  for (const bot of session.match.bots) {
    const current = botMatchToGuiState(session.match, bot.id).queue;
    const extended = extendSeededQueue(current, session.queueSeeds[bot.id], 28);
    session.queueSeeds[bot.id] = extended.bagSeed;
    if (extended.queue.length !== current.length) {
      session.match = extendBotMatchQueue(session.match, bot.id, extended.queue);
    }
  }
}

// A match nobody is stepping still owns one engine process per CC2 bot. The
// bots are stopped between requests, so they cost little, but a tab left open
// should not hold them indefinitely. Every request re-starts the search from
// the full position and `searchForBot` rebuilds a missing session in about
// 25 ms, so letting them go costs the next lock nothing measurable.
const ENGINE_IDLE_TIMEOUT_MS = 60_000;
let engineIdleTimer = null;
let searchesInFlight = 0;

function cancelEngineIdleTimeout() {
  if (engineIdleTimer === null) return;
  clearTimeout(engineIdleTimer);
  engineIdleTimer = null;
}

function scheduleEngineIdleTimeout(session) {
  cancelEngineIdleTimeout();
  if (searchesInFlight > 0) return;
  engineIdleTimer = setTimeout(() => {
    engineIdleTimer = null;
    if (searchesInFlight > 0) return;
    void closeCc2MatchSessions(session).catch(error=>{session.engineCleanupError=`GUI engine cleanup failed: ${error.message}`;});
  }, ENGINE_IDLE_TIMEOUT_MS);
  // The idle timer must never be the reason this server stays alive.
  engineIdleTimer.unref();
}

async function closeCc2MatchSessions(session) {
  // Whoever closes the sessions first wins: a pending timeout has nothing left
  // to release, and a new match must not be torn down by the old match's timer.
  cancelEngineIdleTimeout();
  if (!(session?.cc2Sessions instanceof Map)) return;
  for(const source of session.cc2Sessions.values())source.discardUncommittedTerminalChoice?.();
  const entries=[...session.cc2Sessions.entries()];
  const results=await Promise.allSettled(entries.map(([,source])=>source.close()));
  const failures=[];for(const [i,result] of results.entries()){
    if(result.status==='fulfilled')session.cc2Sessions.delete(entries[i][0]);else failures.push(result.reason);
  }
  if(failures.length)throw new AggregateError(failures,'GUI engine cleanup failed');
}

function assertBotType(value) {
  if (!["cc2-raw", "cc2-chouhy", "cc2-s2-f14", "cc2-s2-champion", "s2-simple", "human"].includes(value)) throw new Error(`unsupported match bot ${value}`);
  if (value in cc2Engines) requireCc2Engine(value);
  if (value in cc2Engines && !isAdr062QualifiedStaticType(value)) throw new Error("ADR-062-qualified resolver required");
  return value;
}

/* The pinned native `--f14-champion` binary has no host-clocked time budget;
   THINK TIME runs only on the WASM core. */
function nativeChampionParameters(parameters) {
  assertChampionParameters(parameters);
  if (parameters.thinkTimeEnabled) throw new Error("CC2 S2 champion THINK TIME needs the WASM core (omit --f14-champion)");
  return parameters;
}

function requireCc2Engine(botType) {
  const engine = cc2Engines[botType];
  if (engine === undefined) throw new Error(`unsupported CC2 engine ${botType}`);
  if (engine.f14WasmCompat) {
    if (engine.wasmSha256 === null) throw new Error(`${engine.label} WASM artifact not found: ${engine.wasm ?? "not configured"}`);
    readWasmBytesMatchingHash(engine);
    return engine;
  }
  if (!isFilePath(engine.binary)) throw new Error(`${engine.label} binary not found: ${engine.binary ?? "not configured"}`);
  return engine;
}

function isFilePath(path) {
  return typeof path === "string" && existsSync(path) && statSync(path).isFile();
}

function fileSha256IfPresent(path) {
  if (!isFilePath(path)) return null;
  return sha256Bytes(readFileSync(path));
}

async function createF14WasmSession(engine) {
  if (!engine.f14WasmCompat || engine.wasmSha256 === null) {
    throw new Error(`${engine.label} WASM artifact unavailable`);
  }
  return createCc2WasmSession({ wasmBytes: readWasmBytesMatchingHash(engine) });
}

function readWasmBytesMatchingHash(engine) {
  let wasmBytes;
  try {
    wasmBytes = readFileSync(engine.wasm);
  } catch {
    throw new Error(`${engine.label} WASM artifact unavailable: ${engine.wasm}`);
  }
  const observedSha256 = sha256Bytes(wasmBytes);
  if (observedSha256 !== engine.wasmSha256) {
    throw new Error(`${engine.label} WASM artifact changed since startup: ${engine.wasm}`);
  }
  return wasmBytes;
}

function sha256Bytes(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function engineUnavailableReason(engine) {
  try { requireCc2Engine(engine.botType); return null; }
  catch (error) { return error.message; }
}

function publicEngine(engine) {
  return {
    botType: engine.botType,
    engineId: engine.engineId,
    label: engine.label,
    repository: engine.repository,
    commit: engine.commit,
    ...(engine.f14WasmCompat ? { wasmSha256: engine.wasmSha256 } : {}),
  };
}

function matchView(session, submissions = [], preLockMatch = null) {
  const submitted = new Map(submissions.map((entry) => [entry.botId, entry]));
  const bots = session.match.bots.map((bot) => {
    const gui = botMatchToGuiState(session.match, bot.id);
    const last = submitted.get(bot.id) ?? null;
    const preLockBot = preLockMatch?.bots.find((candidate) => candidate.id === bot.id) ?? null;
    const preLockGui = preLockBot === null ? null : botMatchToGuiState(preLockMatch, bot.id);
    return {
      id: bot.id,
      type: session.types[bot.id],
      board: gui.board,
      // Cells the bot's most recent placement left on this board, so the viewer
      // can see what the last move actually contributed to the stack.
      lastPlaced: last?.lastPlaced ?? [],
      // This is a display-only snapshot captured before `advanceBotMatch`.
      // The lock, state, metrics, recorder, and replay have already committed
      // by the time the response is returned.
      preLockPreview: preLockBot === null || last === null || session.types[bot.id] === "human"
        ? null
        : preLockPreview(preLockGui, last),
      current: gui.queue[0] ?? null,
      // Six previews for five NEXT boxes: a player who holds an empty slot
      // takes the head of the queue, so the sixth piece is what fills the box
      // the swap frees before the server has confirmed the lock.
      next: gui.queue.slice(1, 7),
      hold: gui.hold,
      holdAvailable: bot.state.pieces.holdAvailable,
      // Garbage the Simulator has queued but not yet tanked into the board.
      // Triangle only tanks on a non-clearing lock, so this is exactly the
      // rise a bot can still cancel.
      garbage: {
        pending: gui.s2.garbage.packets.reduce((total, packet) => total + packet.amount, 0),
        packets: gui.s2.garbage.packets.map((packet) => ({
          amount: packet.amount,
          confirmed: packet.confirmed,
          arrivalFrame: packet.arrivalFrame,
        })),
      },
      combo: gui.combo,
      b2b: gui.s2.b2b,
      piecesPlaced: gui.s2.time.piecesPlaced,
      lines: last?.result?.transition?.lockResult?.lines ?? 0,
      lastClear: last?.result?.transition?.lockResult ?? null,
      outgoing: last?.result?.transition?.cancelResult?.outgoingAfterCancel ?? 0,
      score: last?.score ?? null,
      move: last?.move ?? null,
      stats: bot.stats,
      metrics: calculatePlayerMetrics({
        pieces: bot.stats.turns,
        attack: bot.stats.attack,
        garbageCleared: bot.stats.garbageCleared,
        elapsedFrames: session.match.clock.logicalFrame,
      }),
      toppedOut: gui.board.slice(20).some((row) => row.some((cell) => cell !== null)),
    };
  });
  const outcome = session.forcedOutcome ?? matchOutcome(bots, session.match.turnNumber, session.config.maxTurns);
  const nextStep = outcome.complete ? null : botMatchNextStep(session.match);
  const turnMatch = session.turnMatch ?? normalizeTurnMatch(null);
  return {
    status: outcome.complete ? "complete" : "active",
    turnNumber: session.match.turnNumber,
    humanSide: session.humanSide,
    mode: session.match.mode,
    clock: session.match.clock,
    config: session.config,
    botParameters: session.botParameters,
    handicap: structuredClone(session.handicap ?? { id: HANDICAP_GARBAGE_ID, enabled: false }),
    turnMatch: structuredClone(turnMatch),
    pacing: {
      authority: session.humanSide === null ? "synthetic" : turnMatch.enabled ? "turn" : "realtime-1p",
      declaredPpsByBotId: session.match.pace === null ? null : structuredClone(session.match.pace.ppsByBotId),
    },
    outcome,
    deliveries: session.match.lastStep?.deliveries ?? [],
    metricElapsedMs: session.match.clock.logicalFrame * 1000 / 60,
    // Which side owes the next placement. A turn match is driven from it: the
    // browser steps the opponent only while the person is not the due side.
    dueBotIds: nextStep === null ? [] : [...nextStep.botIds],
    nextStepFrames: nextStep?.frames ?? null,
    bots,
    replayMeta: session.recording === undefined ? null : structuredClone(session.recording.meta),
  };
}

function preLockPreview(gui, submission) {
  const placement = submission.result?.comparison?.witness?.placement
    ?? submission.move;
  if (!isCanonicalPlacement(placement)) return null;
  return {
    board: gui.board,
    placement: structuredClone(placement),
  };
}

function isCanonicalPlacement(placement) {
  return placement !== null && typeof placement === "object" &&
    ["I", "O", "T", "L", "J", "S", "Z"].includes(placement.piece) &&
    ["spawn", "right", "reverse", "left"].includes(placement.rotation) &&
    Number.isSafeInteger(placement.x) && Number.isSafeInteger(placement.y);
}

function finalizeMatchRecording(session, outcome) {
  if (!outcome?.complete || session.finishedRound !== null || session.recording === undefined) return;
  session.finishedRound = finishMatchRecording(session.recording, {
    outcome,
    match: session.match,
  });
}

function matchReplayMeta({ match, config, types, botParameters, firstTo, ttrmCompatible, queueModel,
  handicapEnabled = false, turnMatch = normalizeTurnMatch(null) }) {
  const users = ["left", "right"].map((id) => ({
    id,
    username: `${id.toUpperCase()} · ${matchBotLabel(types[id])}`,
  }));
  return {
    origin: "s2-bot-match/1",
    users,
    gamemode: "s2-bot-match",
    ts: new Date().toISOString(),
    version: 1,
    parseMs: 0,
    match: {
      seed: config.seed,
      fairComparison: config.fairComparison,
      maxTurns: config.maxTurns,
      firstTo,
      ttrmCompatible: ttrmCompatible === true,
      queueModel: queueModel ?? QUEUE_MODE_LEGACY_LCG,
      declaredPpsByBotId: match.pace === null ? null : structuredClone(match.pace.ppsByBotId),
      turnMatch: { id: turnMatch.id, enabled: turnMatch.enabled, order: turnMatch.order },
      // Series-level meta keeps only what every game shares. The per-game seed
      // and terrain live in each round record.
      handicap: { id: HANDICAP_GARBAGE_ID, enabled: handicapEnabled === true },
      bots: {
        left: { type: types.left, label: matchBotLabel(types.left), parameters: structuredClone(botParameters.left) },
        right: { type: types.right, label: matchBotLabel(types.right), parameters: structuredClone(botParameters.right) },
      },
      rulesetId: match.rulesetId,
    },
  };
}

function matchBotLabel(type) {
  if (cc2Engines[type] !== undefined) return cc2Engines[type].label;
  return ({
    "s2-simple": "S2 placement bot",
    human: "You (1P)",
  })[type] ?? type;
}

function positiveIntegerOrDefault(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseArguments(args) {
  const legacyBinaryArgument = args.find((arg) => arg.startsWith("--cc2="));
  const rawBinaryArgument = args.find((arg) => arg.startsWith("--cc2-raw="));
  const chouhyBinaryArgument = args.find((arg) => arg.startsWith("--cc2-chouhy="));
  const s2BinaryArgument = args.find((arg) => arg.startsWith("--cc2-s2="));
  const f14WasmArgument = args.find((arg) => arg.startsWith("--f14-wasm="));
  const portArgument = args.find((arg) => arg.startsWith("--port="));
  const executableSuffix = process.platform === "win32" ? ".exe" : "";
  const rawFallback = fileURLToPath(new URL(
    `../bot/cold-clear-2-upstream/target/release/cold-clear-2-upstream${executableSuffix}`,
    import.meta.url,
  ));
  const chouhyFallback = fileURLToPath(new URL(
    `../bot/cold-clear-2-chouhy/target/release/cold-clear-2-chouhy${executableSuffix}`,
    import.meta.url,
  ));
  const s2Fallback = fileURLToPath(new URL(
    `../bot/cold-clear-2-s2/target/release/cold-clear-2-s2${executableSuffix}`,
    import.meta.url,
  ));
  const rawBinary = resolve(
    rawBinaryArgument?.slice("--cc2-raw=".length)
      ?? legacyBinaryArgument?.slice("--cc2=".length)
      ?? process.env.CC2_RAW_BINARY
      ?? process.env.CC2_BINARY
      ?? rawFallback,
  );
  const chouhyBinary = resolve(
    chouhyBinaryArgument?.slice("--cc2-chouhy=".length)
      ?? process.env.CC2_CHOUHY_BINARY
      ?? chouhyFallback,
  );
  const s2Binary = resolve(
    s2BinaryArgument?.slice("--cc2-s2=".length)
      ?? process.env.CC2_S2_BINARY
      ?? s2Fallback,
  );
  // The public server decides the champion only through the WASM core; its
  // bridge has no native F14 protocol, so there is no --f14-champion route.
  const f14ChampionBinary = null;
  const f14WasmLocator = f14WasmArgument?.slice("--f14-wasm=".length) ?? process.env.CC2_F14_WASM;
  // Like the native executables, the champion's WASM core defaults to the
  // repository build output; it never replaces an explicit --f14-champion.
  const f14WasmFallback = fileURLToPath(new URL(
    "../bot/cold-clear-2-s2/target/wasm32-unknown-unknown/release/cold_clear_2_s2.wasm", import.meta.url));
  const f14InputWasm = resolve(f14WasmLocator ?? f14WasmFallback);
  const f14Wasm = f14WasmLocator !== undefined ? resolve(f14WasmLocator)
    : f14ChampionBinary === null && existsSync(f14WasmFallback) ? f14WasmFallback : null;
  const port = Number(portArgument?.slice("--port=".length) ?? 4173);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("port must be an integer from 1 to 65535");
  return { rawBinary, chouhyBinary, s2Binary, f14ChampionBinary, f14Wasm, f14InputWasm, port };
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1_000_000) throw new Error("request too large");
  }
  return JSON.parse(body);
}

/* A .ttrm is read as text, not JSON: the parser owns the refusal for a file
   that is not one, and it reports which stage rejected it. */
async function readText(request, limit) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > limit) {
      throw new Error(`file is too large (> ${Math.floor(limit / (1024 * 1024))}MB)`);
    }
  }
  return body;
}

function sendJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

function sendText(response, status, value, contentTypeValue = "text/plain; charset=utf-8") {
  response.writeHead(status, { "content-type": contentTypeValue, "cache-control": "no-store" });
  response.end(value);
}

function contentType(file) {
  return ({ ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8" })[extname(file)] ?? "application/octet-stream";
}
