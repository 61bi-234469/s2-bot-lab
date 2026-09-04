import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { extname, join, normalize, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { createCc2Session, requestCc2Suggestion } from "../src-js/cc2-bridge.mjs";
import {
  suggestionFailureOutcome,
} from "../src-js/cc2-suggestion-failure.mjs";
import {
  classifyProposalError,
  successfulProposal,
} from "../src-js/proposal-outcome.mjs";
import { applyCc2FinalPlacementUnderObservedS2 } from "../src-js/cc2-s2-adapter.mjs";
import { selectCc2S2HybridPlacement } from "../src-js/cc2-s2-hybrid.mjs";
import { selectS2RenQualityPlacement } from "../src-js/s2-ren-quality-selector.mjs";
import { selectS2ConversionQualifiedRenFinisherPlacement } from "../src-js/s2-conversion-qualified-ren-finisher-selector.mjs";
import { selectS2F12PostTankSolvencyRescuePlacement } from "../src-js/s2-f12-post-tank-solvency-rescue-selector.mjs";
import { selectS2ThresholdImminentB2bRetentionPlacement } from "../src-js/s2-threshold-imminent-b2b-retention-selector.mjs";
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
import { placementGeometry } from "../src-js/triangle/placement-geometry.mjs";
import {
  QUEUE_MODE_LEGACY_LCG,
  QUEUE_MODE_TRIANGLE_7_BAG,
  createGame,
  extendSeededQueue,
  extendTriangleSeededQueue,
  lockedPieceCells,
  toS2GuiState,
} from "../cc2-gui/game.mjs";
import { fullStateKey } from "../src-js/state-keys.mjs";
import {
  matchOutcome,
  normalizeBotMatchOptions,
  ppsForCc2Parameters,
  realtimeCc2ThinkMs,
} from "../src-js/bot-match-options.mjs";
import { runBotProposals } from "../src-js/bot-proposal-runner.mjs";
import { calculatePlayerMetrics } from "../cc2-gui/player-metrics.mjs";
import { botParameterCapability, fairComparisonBotParameters, normalizeBotParameters } from "../src-js/bot-parameters.mjs";
import { loadS2Config, s2ConfigArguments } from "../src-js/cc2-s2-config.mjs";
import { RULESET_IDS, resolvePlacementRules } from "../src-js/ruleset-profiles.mjs";
import { canonicalTransitionHttpResponse } from "../src-js/canonical-transition-api.mjs";
import { MAX_TTRM_TEXT_LENGTH, TtrmError, parseTtrm } from "../src-js/replay/ttrm-parser.mjs";
import { buildReplayIR, nowMs } from "../src-js/replay/ttrm-simulator.mjs";
import {
  createMatchRecording,
  finishMatchRecording,
  recordMatchLocks,
} from "../src-js/replay/bot-match-recorder.mjs";
import { BotMatchTtrmError, buildBotMatchTtrm } from "../src-js/replay/bot-match-ttrm-export.mjs";

const root = resolve(fileURLToPath(new URL("../cc2-gui", import.meta.url)));
const GUI_CC2_SEARCH_SEED = "5994928009864282113";
const options = parseArguments(process.argv.slice(2));
const f11WeightConfig = JSON.parse(readFileSync("fixtures/tuning/cc2-s2-initial-weight-grid.json", "utf8"));
const f11Weights = f11WeightConfig.weightProfiles?.find((profile) => profile.id === "sparse-s2")?.weights;
if (f11Weights === undefined) throw new Error("F11 GUI bot requires the sparse-s2 weight profile");
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
  "cc2-s2": Object.freeze({
    botType: "cc2-s2",
    engineId: "cold-clear-2-s2-hybrid/1",
    label: "CC2 S2 — Gen 008/009 rank-25 champion (512, development)",
    repository: "https://github.com/61bi-234469/s2-bot-lab",
    commit: "ed8b193+local-s2-reranker",
    comparisonSource: "cold-clear-2-s2-hybrid-final-placement",
    protocolName: "Cold Clear 2 S2",
    binary: options.s2Binary,
    config: null,
  }),
  "cc2-s2-gen017": Object.freeze({
    botType: "cc2-s2-gen017",
    engineId: "cold-clear-2-s2-hybrid/gen017-aligned/1",
    label: "CC2 S2 — Gen 017 aligned mini-spin value (512, development)",
    repository: "https://github.com/61bi-234469/s2-bot-lab",
    commit: "ed8b193+local-s2-reranker",
    comparisonSource: "cold-clear-2-s2-hybrid-gen017-aligned-final-placement",
    protocolName: "Cold Clear 2 S2",
    binary: options.s2Binary,
    config: loadS2Config("fixtures/tuning/cc2-s2-spin-value-aligned.json"),
  }),
  "cc2-s2-f11": Object.freeze({
    botType: "cc2-s2-f11",
    engineId: "cold-clear-2-s2-f11-ren-quality/1",
    label: "CC2 S2 — F11 REN quality (development)",
    repository: "https://github.com/61bi-234469/s2-bot-lab",
    commit: "ed8b193+local-s2-reranker",
    comparisonSource: "cold-clear-2-s2-f11-ren-quality-final-placement",
    protocolName: "Cold Clear 2 S2",
    binary: options.s2Binary,
    config: loadS2Config("fixtures/tuning/cc2-s2-spin-value-aligned.json"),
  }),
  "cc2-s2-f12": Object.freeze({
    botType: "cc2-s2-f12",
    engineId: "cold-clear-2-s2-f12-conversion-qualified-ren-finisher/1",
    label: "CC2 S2 — F12 Conversion-Qualified REN Finisher (development)",
    repository: "https://github.com/61bi-234469/s2-bot-lab",
    commit: "ed8b193+local-s2-reranker",
    comparisonSource: "cold-clear-2-s2-f12-conversion-qualified-ren-finisher-final-placement",
    protocolName: "Cold Clear 2 S2",
    binary: options.s2Binary,
    config: loadS2Config("fixtures/tuning/cc2-s2-spin-value-aligned.json"),
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
  "cc2-s2-f25": Object.freeze({
    botType: "cc2-s2-f25",
    engineId: "cold-clear-2-s2-f25-threshold-imminent-b2b-retention/1",
    label: "CC2 S2 — F25 threshold-imminent B2B retention (development)",
    repository: "https://github.com/61bi-234469/s2-bot-lab",
    commit: "ed8b193+local-s2-reranker",
    comparisonSource: "cold-clear-2-s2-f25-threshold-imminent-b2b-retention-final-placement",
    protocolName: "Cold Clear 2 S2",
    binary: options.s2Binary,
    config: loadS2Config("fixtures/tuning/cc2-s2-spin-value-aligned.json"),
  }),
  "cc2-s2-champion": Object.freeze({
    botType: "cc2-s2-champion",
    engineId: "cold-clear-2-s2-development-champion/f14-substrate-v2-search-state/1",
    label: "CC2 S2 — current development champion (not release-qualified)",
    repository: "https://github.com/61bi-234469/s2-bot-lab",
    commit: "development-snapshot-f14-substrate-v2-search-state",
    comparisonSource: "cold-clear-2-s2-development-champion-final-placement",
    protocolName: "Cold Clear 2 S2",
    binary: options.s2Binary,
    config: loadS2Config("fixtures/tuning/cc2-s2-spawn-integrity-substrate-v2.json"),
  }),
});
/* Modules the browser and Node share verbatim. Each URL basename matches the
   file's own name, so the relative imports inside them resolve to another entry
   of this table when the browser fetches them. */
const SHARED_MODULES = new Map([
  ["/shared/bot-parameters.mjs", "../src-js/bot-parameters.mjs"],
  ["/shared/bot-match-options.mjs", "../src-js/bot-match-options.mjs"],
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
let matchMutations = Promise.resolve();
const server = createServer(async (request, response) => {
  try {
    if (request.method === "POST" && request.url === "/api/suggest") {
      const body = await readJson(request);
      const engine = requireCc2Engine(body.engine ?? "cc2-raw");
      const result = await requestCc2Suggestion({
        binary: engine.binary,
        state: body.state,
        thinkMs: body.thinkMs,
        expectedName: engine.protocolName,
      });
      return sendJson(response, 200, { ...result, engine: publicEngine(engine) });
    }
    if (request.method === "POST" && request.url === "/api/apply-s2") {
      const body = await readJson(request);
      const engine = requireCc2Engine(body.engine ?? "cc2-raw");
      const result = isCc2S2Type(engine.botType)
        ? selectCc2S2Placement(body.state, body.moves ?? [body.move], engine)
        : applyCc2FinalPlacementUnderObservedS2(body.state, body.move, engine);
      return sendJson(response, result.status === "unsupported" ? 422 : 200, result);
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
      try {
        leftType = assertBotType(body.left ?? "cc2-raw");
        rightType = assertBotType(body.right ?? "s2-simple");
        humanSide = resolveHumanSide(leftType, rightType);
        config = normalizeBotMatchOptions(body);
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
      } catch (error) {
        return sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      }
      await closeCc2MatchSessions(matchSession);
      const ttrmCompatible = body.ttrmCompatible === true;
      const queueModel = ttrmCompatible ? QUEUE_MODE_TRIANGLE_7_BAG : QUEUE_MODE_LEGACY_LCG;
      const scenario = createGame(config.seed, { queueModel });
      const initial = guiStateToCanonical(toS2GuiState(scenario));
      const match = createBotMatch({
        bots: [
          { id: "left", gameId: 1, state: initial },
          { id: "right", gameId: 2, state: structuredClone(initial) },
        ],
        mode: "paced",
        // A human side is declared as externally paced: their lock times come
        // from the browser as they actually play, not from a configured rate.
        ppsByBotId: {
          left: pacedRateFor("left", leftType, humanSide, config, botParameters),
          right: pacedRateFor("right", rightType, humanSide, config, botParameters),
        },
      });
      matchSession = {
        types: { left: leftType, right: rightType },
        humanSide,
        botParameters,
        config,
        ttrmCompatible,
        queueModel,
        cc2Sessions: new Map(),
        queueSeeds: { left: scenario.bagSeed, right: scenario.bagSeed },
        match,
        recording: createMatchRecording({ match, meta: matchReplayMeta({
          match,
          config,
          types: { left: leftType, right: rightType },
          botParameters,
          firstTo: positiveIntegerOrDefault(body.firstTo, 1),
          ttrmCompatible,
          queueModel,
        }) }),
        finishedRound: null,
      };
      return sendJson(response, 200, matchView(matchSession));
    }
    if (request.method === "POST" && request.url === "/api/match/step") {
      if (matchSession === null) return sendJson(response, 409, { error: "match-not-started" });
      const currentView = matchView(matchSession);
      if (currentView.outcome.complete) return sendJson(response, 409, { error: "match-complete", outcome: currentView.outcome });
      // The match clock is owned by the canonical match snapshot.  In
      // particular, browser wall time and search latency must not affect PPS,
      // APM, or any other rate calculated from this match.
      await readJson(request);
      return sendJson(response, 200, await stepScheduledBots(matchSession));
    }
    if (request.method === "POST" && request.url === "/api/match/human-lock") {
      if (matchSession === null) return sendJson(response, 409, { error: "match-not-started" });
      const session = matchSession;
      if (session.humanSide === null) return sendJson(response, 409, { error: "no-human-player" });
      const body = await readJson(request);
      const requestedFrame = body.lockFrame;
      if (!Number.isSafeInteger(requestedFrame) || requestedFrame < 0) {
        return sendJson(response, 400, { error: "lockFrame must be a non-negative safe integer" });
      }
      // A scheduled bot lock that lands on the very next frame leaves no frame
      // for the player, so the bot is advanced first and the lock retried.
      // Advancing always moves the clock, so this terminates.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const outcome = matchView(session).outcome;
        if (outcome.complete) return sendJson(response, 409, { error: "match-complete", outcome });
        const view = await withMatchMutation(() => commitHumanLock(session, body.placement, requestedFrame));
        if (view !== null) return sendJson(response, 200, view);
        await stepScheduledBots(session);
      }
      return sendJson(response, 409, { error: "human-lock-not-schedulable" });
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
      if (matchSession === null || matchSession.recording === undefined) {
        return sendJson(response, 409, { stage: "match", message: "match-not-started" });
      }
      if (!matchSession.ttrmCompatible) {
        return sendJson(response, 409, {
          stage: "compatibility",
          message: "start the match with QUEUE MODEL set to TTRM QUEUE before exporting .ttrm",
        });
      }
      const view = matchView(matchSession);
      if (view.outcome.complete) finalizeMatchRecording(matchSession, view.outcome);
      try {
        const text = buildBotMatchTtrm(matchSession.recording, { outcome: view.outcome });
        return sendText(response, 200, text, "application/json; charset=utf-8");
      } catch (error) {
        if (error instanceof BotMatchTtrmError) {
          return sendJson(response, 422, {
            stage: error.stage,
            lockIndex: error.lockIndex,
            message: error.message,
          });
        }
        throw error;
      }
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
            available: engine.binary !== null && existsSync(engine.binary),
            reason: engine.binary !== null && existsSync(engine.binary) ? null : "requires a local CC2 binary",
            ...botParameterCapability(engine.botType),
          })),
          { id: "s2-simple", label: "S2 placement bot", available: true, ...botParameterCapability("s2-simple") },
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
    console.log(`${engine.label}: ${engine.binary !== null && existsSync(engine.binary) ? engine.binary : "unavailable (set a local binary path)"}`);
  }
});

process.once("exit", () => {
  if (!(matchSession?.cc2Sessions instanceof Map)) return;
  for (const cc2Session of matchSession.cc2Sessions.values()) cc2Session.terminate();
});

/** Serializes one mutation of the live match snapshot against every other. */
function withMatchMutation(work) {
  const result = matchMutations.then(work, work);
  matchMutations = result.then(() => undefined, () => undefined);
  return result;
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
async function stepScheduledBots(session) {
  // This is the only path that reaches an engine, so counting its depth is
  // enough to know whether a search is in flight. `/api/match/step` and
  // `/api/match/human-lock` can overlap, so the count has to nest rather than
  // be a flag.
  cancelEngineIdleTimeout();
  searchesInFlight += 1;
  try {
    return await runScheduledBots(session);
  } finally {
    searchesInFlight -= 1;
    if (searchesInFlight === 0 && session.cc2Sessions.size > 0) scheduleEngineIdleTimeout(session);
  }
}

async function runScheduledBots(session) {
  const prepared = await withMatchMutation(() => {
    refillMatchQueues(session);
    const nextStep = botMatchNextStep(session.match);
    return { dueBots: session.match.bots.filter((bot) => nextStep.botIds.includes(bot.id)) };
  });
  const proposals = await runBotProposals(
    prepared.dueBots,
    (bot) => searchForBot(session, bot, prepared.dueBots.length),
    { serial: session.config.fairComparison },
  );
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
    const submissions = proposals.map((proposal) => resolveProposal(session, proposal));
    const before = session.match;
    const after = advanceBotMatch(before, submissions);
    session.match = after;
    session.recording = recordMatchLocks(session.recording, before, after, submissions);
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
    cc2Session = await createCc2Session({
      binary: engine.binary,
      binaryArguments: s2ConfigArguments(engine.config ?? null),
      expectedName: engine.protocolName,
      selectionLimit: parameters.selectionEnabled ? parameters.selectionLimit : null,
      searchSeed: GUI_CC2_SEARCH_SEED,
    });
    session.cc2Sessions.set(bot.id, cc2Session);
  }
  const gui = botMatchToGuiState(session.match, bot.id);
  let cc2;
  const searchStartedAt = performance.now();
  try {
    cc2 = await cc2Session.suggest({
      timeLimitEnabled: parameters.thinkTimeEnabled,
      thinkMs: parameters.ppsEnabled === false
        ? parameters.thinkMs
        : realtimeCc2ThinkMs({
          thinkMs: parameters.thinkMs,
          stepFrames: botLockCadenceFrames(session, bot.id),
          serialProposalCount: session.config.fairComparison ? dueCount : 1,
        }),
      state: {
        board: gui.board,
        queue: gui.queue.slice(0, parameters.queueDepth),
        hold: gui.hold,
        combo: gui.combo,
        back_to_back: gui.back_to_back,
        randomizer: gui.randomizer,
      },
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
  // A `.ttrm` stores key events, not final placements. CC2 chooses
  // final cells directly and may use a HOLD sequence that cannot be recreated
  // by the pinned Engine from a synthetic 60f lock clock. In the explicit
  // export-compatible mode, use the deterministic no-HOLD controller for
  // those engines so every recorded lock has a real input witness. Normal
  // matches keep each selected engine's unmodified final-placement policy.
  if (session.ttrmCompatible && proposal.type !== "s2-simple" && proposal.type !== "human") {
    const analysis = analyzeSimpleS2FinalPlacements(bot.state, { topN: 1, allowHold: false });
    const best = analysis.moves[0];
    if (!best) throw new Error(`${bot.id} has no TTRM-safe final placement`);
    return {
      botId: bot.id,
      result: {
        transition: best.transition,
        comparison: { positionFingerprint: fullStateKey(bot.state), ttrmController: "s2-simple-no-hold/1" },
      },
      move: best.placement,
      score: best.score,
      ttrmController: "s2-simple-no-hold/1",
      lastPlaced: lockedPieceCells(gui.board, best.transition, best.placement.piece),
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
  const result = isCc2S2Type(proposal.type)
    ? selectCc2S2Placement(gui, proposal.moves, engine)
    : applyCc2FinalPlacementUnderObservedS2(gui, proposal.moves[0], engine);
  const move = isCc2S2Type(proposal.type) ? result.move : proposal.moves[0];
  if (result.transition === null) throw new Error(`${bot.id} CC2 placement rejected: ${result.reasons.join(", ")}`);
  return {
    botId: bot.id,
    result,
    move,
    score: result.comparison.score,
    cc2: proposal.info,
    lastPlaced: lockedPieceCells(gui.board, result.transition, move.location.type),
  };
}

/**
 * Applies one player lock, or returns `null` when the schedule leaves no frame
 * for it yet.
 *
 * The requested frame is the browser's own real-time reading of the shared
 * match clock. It is clamped into the window that keeps the clock monotone, so
 * a lock the player made while the opponent's proposal was still in flight is
 * recorded just before that opponent's lock rather than after it. The error is
 * bounded by the opponent's search latency and is part of the declared
 * synthetic clock, not a measurement of the player's real cadence.
 */
function commitHumanLock(session, placement, requestedFrame) {
  if (matchView(session).outcome.complete) throw new Error("match-complete");
  refillMatchQueues(session);
  const window = externalLockFrameWindow(session.match, session.humanSide);
  if (window === null) return null;
  const lockFrame = Math.min(Math.max(requestedFrame, window.earliest), window.latest);
  const bot = session.match.bots.find((candidate) => candidate.id === session.humanSide);
  const gui = botMatchToGuiState(session.match, bot.id);
  const result = applyHumanFinalPlacementUnderObservedS2(bot.state, placement);
  if (result.transition === null) {
    throw new Error(`player placement rejected: ${result.reasons.join(", ")}`);
  }
  const submission = {
    botId: bot.id,
    result,
    move: result.comparison.witness.placement,
    score: result.comparison.score,
    lastPlaced: lockedPieceCells(gui.board, result.transition, result.comparison.witness.placement.piece),
  };
  const before = session.match;
  const after = advanceBotMatch(before, [submission], { externalLockFrame: lockFrame });
  session.match = after;
  session.recording = recordMatchLocks(session.recording, before, after, [submission]);
  const view = matchView(session, [submission]);
  finalizeMatchRecording(session, view.outcome);
  return view;
}

function resolveHumanSide(leftType, rightType) {
  if (leftType === "human" && rightType === "human") {
    throw new Error("only one side can be played by a human");
  }
  if (leftType === "human") return "left";
  if (rightType === "human") return "right";
  return null;
}

function pacedRateFor(side, botType, humanSide, config, botParameters) {
  if (botType === "human") return null;
  if (config.fairComparison) return 1;
  return botType.startsWith("cc2-")
    ? ppsForCc2Parameters(botParameters[side])
    : botParameters[side].pps;
}

function refillMatchQueues(session) {
  for (const bot of session.match.bots) {
    const current = botMatchToGuiState(session.match, bot.id).queue;
    const extended = session.queueModel === QUEUE_MODE_TRIANGLE_7_BAG
      ? extendTriangleSeededQueue(current, session.queueSeeds[bot.id], 28)
      : extendSeededQueue(current, session.queueSeeds[bot.id], 28);
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
    void closeCc2MatchSessions(session);
  }, ENGINE_IDLE_TIMEOUT_MS);
  // The idle timer must never be the reason this server stays alive.
  engineIdleTimer.unref();
}

async function closeCc2MatchSessions(session) {
  // Whoever closes the sessions first wins: a pending timeout has nothing left
  // to release, and a new match must not be torn down by the old match's timer.
  cancelEngineIdleTimeout();
  if (!(session?.cc2Sessions instanceof Map)) return;
  await Promise.allSettled([...session.cc2Sessions.values()].map((cc2Session) => cc2Session.close()));
  session.cc2Sessions.clear();
}

function assertBotType(value) {
  if (!["cc2-raw", "cc2-chouhy", "cc2-s2", "cc2-s2-gen017", "cc2-s2-f11", "cc2-s2-f12", "cc2-s2-f14", "cc2-s2-f25", "cc2-s2-champion", "s2-simple", "human"].includes(value)) throw new Error(`unsupported match bot ${value}`);
  if (value === "cc2-raw" || value === "cc2-chouhy" || isCc2S2Type(value)) requireCc2Engine(value);
  return value;
}

function requireCc2Engine(botType) {
  const engine = cc2Engines[botType];
  if (engine === undefined) throw new Error(`unsupported CC2 engine ${botType}`);
  if (engine.binary === null || !existsSync(engine.binary)) throw new Error(`${engine.label} binary not found; provide a local binary path`);
  return engine;
}

function isCc2S2Type(botType) {
  return botType === "cc2-s2" || botType === "cc2-s2-gen017" || botType === "cc2-s2-f11" || botType === "cc2-s2-f12" || botType === "cc2-s2-f14" || botType === "cc2-s2-f25" || botType === "cc2-s2-champion";
}

function selectCc2S2Placement(guiState, moves, engine) {
  if (engine.botType === "cc2-s2-f11") {
    return selectS2RenQualityPlacement(guiState, moves, {
      candidateLimit: 16,
      rankPenalty: 25,
      adjustmentScale: 28,
      weightProfileId: "sparse-s2",
      weights: f11Weights,
      allowCompleteReturnedPrefix: true,
      engineId: engine.engineId,
      comparisonSource: engine.comparisonSource,
    });
  }
  if (engine.botType === "cc2-s2-f12") {
    return selectS2ConversionQualifiedRenFinisherPlacement(guiState, moves, {
      candidateLimit: 16,
      rankPenalty: 25,
      adjustmentScale: 28,
      weightProfileId: "sparse-s2",
      weights: f11Weights,
      allowCompleteReturnedPrefix: true,
      engineId: engine.engineId,
      comparisonSource: engine.comparisonSource,
    });
  }
  if (engine.botType === "cc2-s2-f14") {
    return selectS2F12PostTankSolvencyRescuePlacement(guiState, moves, {
      candidateLimit: 16,
      rankPenalty: 25,
      adjustmentScale: 28,
      weightProfileId: "sparse-s2",
      weights: f11Weights,
      allowCompleteReturnedPrefix: true,
      engineId: engine.engineId,
      comparisonSource: engine.comparisonSource,
    });
  }
  if (engine.botType === "cc2-s2-f25") {
    return selectS2ThresholdImminentB2bRetentionPlacement(guiState, moves, {
      candidateLimit: 16,
      rankPenalty: 25,
      adjustmentScale: 28,
      weightProfileId: "sparse-s2",
      weights: f11Weights,
      allowCompleteReturnedPrefix: true,
      engineId: engine.engineId,
      comparisonSource: engine.comparisonSource,
    });
  }
  if (engine.botType === "cc2-s2-champion") {
    return selectS2F12PostTankSolvencyRescuePlacement(guiState, moves, {
      candidateLimit: 16,
      rankPenalty: 25,
      adjustmentScale: 28,
      weightProfileId: "sparse-s2",
      weights: f11Weights,
      allowCompleteReturnedPrefix: true,
      engineId: engine.engineId,
      comparisonSource: engine.comparisonSource,
    });
  }
  return selectCc2S2HybridPlacement(guiState, moves, engine);
}

function publicEngine(engine) {
  return {
    engineId: engine.engineId,
    label: engine.label,
    repository: engine.repository,
    commit: engine.commit,
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
  return {
    status: outcome.complete ? "complete" : "active",
    turnNumber: session.match.turnNumber,
    humanSide: session.humanSide,
    mode: session.match.mode,
    clock: session.match.clock,
    config: session.config,
    botParameters: session.botParameters,
    outcome,
    deliveries: session.match.lastStep?.deliveries ?? [],
    metricElapsedMs: session.match.clock.logicalFrame * 1000 / 60,
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

function matchReplayMeta({ match, config, types, botParameters, firstTo, ttrmCompatible, queueModel }) {
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
  const portArgument = args.find((arg) => arg.startsWith("--port="));
  const s2Fallback = fileURLToPath(new URL("../bot/cold-clear-2-s2/target/release/cold-clear-2-s2.exe", import.meta.url));
  const resolveOptionalPath = (value) => value === undefined ? null : resolve(value);
  const rawBinary = resolveOptionalPath(
    rawBinaryArgument?.slice("--cc2-raw=".length)
      ?? legacyBinaryArgument?.slice("--cc2=".length)
      ?? process.env.CC2_RAW_BINARY
      ?? process.env.CC2_BINARY,
  );
  const chouhyBinary = resolveOptionalPath(
    chouhyBinaryArgument?.slice("--cc2-chouhy=".length)
      ?? process.env.CC2_CHOUHY_BINARY
  );
  const s2Binary = resolve(
    s2BinaryArgument?.slice("--cc2-s2=".length)
      ?? process.env.CC2_S2_BINARY
      ?? s2Fallback,
  );
  const port = Number(portArgument?.slice("--port=".length) ?? 4173);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("port must be an integer from 1 to 65535");
  return { rawBinary, chouhyBinary, s2Binary, port };
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
