import { fullStateKey } from "./state-keys.mjs";
import { guiStateToCanonical } from "./gui-state.mjs";
import { canonicalTransitionHttpResponse } from "./canonical-transition-api.mjs";
import { compareSimpleSamePositionCandidates } from "./comparison-contract.mjs";
import { analyzeSimpleS2FinalPlacements } from "./simple-s2-bot.mjs";
import {
  advanceBotMatch,
  botMatchNextStep,
  botMatchToGuiState,
  createBotMatch,
  extendBotMatchQueue,
  externalLockFrameWindow,
} from "./bot-match-controller.mjs";
import { applyHumanFinalPlacementUnderObservedS2 } from "./human-s2-adapter.mjs";
import { applyCc2FinalPlacementUnderObservedS2 } from "./cc2-s2-adapter.mjs";
import { selectCc2S2HybridPlacement } from "./cc2-s2-hybrid.mjs";
import { selectS2RenQualityPlacement } from "./s2-ren-quality-selector.mjs";
import { selectS2ConversionQualifiedRenFinisherPlacement } from "./s2-conversion-qualified-ren-finisher-selector.mjs";
import { selectS2F12PostTankSolvencyRescuePlacement } from "./s2-f12-post-tank-solvency-rescue-selector.mjs";
import { selectS2ThresholdImminentB2bRetentionPlacement } from "./s2-threshold-imminent-b2b-retention-selector.mjs";
import { calculatePlayerMetrics } from "../cc2-gui/player-metrics.mjs";
import {
  createMatchRecording,
  finishMatchRecording,
  recordMatchLocks,
} from "./replay/bot-match-recorder.mjs";
import { buildReplayIR, nowMs } from "./replay/ttrm-simulator.mjs";
import { MAX_TTRM_TEXT_LENGTH, TtrmError, parseTtrm } from "./replay/ttrm-parser.mjs";
import { botParameterCapability, fairComparisonBotParameters, normalizeBotParameters } from "./bot-parameters.mjs";
import { matchOutcome, normalizeBotMatchOptions, ppsForCc2Parameters } from "./bot-match-options.mjs";
import { realtimeCc2ThinkMs } from "./bot-match-options.mjs";
import { runBotProposals } from "./bot-proposal-runner.mjs";
import { createLiveMatchMutationQueue } from "./live-match-mutation.mjs";
import { realtimeDeadlineDelayMs, realtimeScheduledLockFrame } from "./realtime-match-pacing.mjs";
import { RULESET_IDS, resolvePlacementRules } from "./ruleset-profiles.mjs";
import { placementGeometry } from "./triangle/placement-geometry.mjs";
import { lockedPieceCells, toS2GuiState, createGame, extendSeededQueue, extendTriangleSeededQueue,
  QUEUE_MODE_LEGACY_LCG, QUEUE_MODE_TRIANGLE_7_BAG } from "../cc2-gui/game.mjs";

const SIMPLE_BOT = Object.freeze({
  id: "s2-simple",
  label: "S2 placement bot",
  available: true,
  ...botParameterCapability("s2-simple"),
});
const HUMAN_BOT = Object.freeze({ id: "human", label: "You (1P)", available: true, ...botParameterCapability("human") });
const CC2_LABELS = Object.freeze({
  "cc2-raw": "Raw CC2 — MinusKelvin upstream (deterministic port)",
  "cc2-chouhy": "CC2 — chouhy fork b20a92b (deterministic port)",
  "cc2-s2": "CC2 S2 — development hybrid",
  "cc2-s2-gen017": "CC2 S2 — Gen 017 aligned",
  "cc2-s2-f11": "CC2 S2 — F11 REN quality",
  "cc2-s2-f12": "CC2 S2 — F12 REN finisher",
  "cc2-s2-f14": "CC2 S2 — F14 post-tank rescue",
  "cc2-s2-f25": "CC2 S2 — F25 B2B retention",
  "cc2-s2-champion": "CC2 S2 — current development champion (not release-qualified)",
});
const SPARSE_S2_WEIGHTS = Object.freeze({ aggregateHeight:-.1,maxHeight:-.4,holes:-1,bumpiness:-.05,remainingIncoming:0,deferredIncoming:-.8,dueIncoming:0,incomingNextLock:0,confirmedIncoming:0,tankedIncoming:-.25,visibleTopOutMargin:0,outgoingBeforeCancel:0,outgoingAfterCancel:1,cancelled:.8,combo:0,b2b:.6,chargingLevel:0,surgeSent:.25 });

/**
 * Transport-neutral browser API. Native CC2 engines are deliberately absent;
 * callers get a stable capability response instead of an import-time failure.
 */
export function createGuiRequestHandlers({ cc2 = null, proposeCc2 = null, now = () => performance.now(), wait = defaultWait } = {}) {
  const cc2Runtime = cc2 ?? (proposeCc2 === null ? null : {
    propose: proposeCc2,
    closeSessions: async () => {},
  });
  let session = null;

  return Object.freeze({
    async handle({ method, path, body = null }) {
      if (method === "GET" && path === "/api/bots") return ok({
        runtime: { mode: "static-wasm", defaultSelectionLimit: 512, searchSeed: "5994928009864282113", timeBudget: "worker-clock-chunked" },
        ruleset: { id: RULESET_IDS.s2Observed, b2bCharging: resolvePlacementRules(RULESET_IDS.s2Observed).b2bCharging },
        bots: [
          ...Object.entries(CC2_LABELS).map(([id, label]) => cc2Runtime === null ? unavailable(id, label) : ({ id, label, available: true, ...staticCc2Capability(id) })),
          SIMPLE_BOT,
          HUMAN_BOT,
        ],
      });
      if (method === "GET" && path === "/api/placement-geometry") return ok({
        rulesetId: RULESET_IDS.s2Observed,
        ...placementGeometry(resolvePlacementRules(RULESET_IDS.s2Observed)),
      });
      if (method === "POST" && path === "/api/simple-s2") {
        return ok(analyzeSimpleS2FinalPlacements(guiStateToCanonical(body.state), { topN: body.n ?? 5 }));
      }
      if (method === "POST" && path === "/api/suggest") {
        if (cc2Runtime === null) return fail(503, { error: "CC2 WASM is unavailable" });
        const engine = requireCc2Type(body.engine ?? "cc2-raw");
        try {
          const parameters = normalizeBotParameters(engine, body.parameters);
          return ok({ ...(await cc2Runtime.propose({ sessionKey: "analysis", engine, state: body.state, ...cc2SearchBudget(parameters) })), info: { version: staticWasmVersion(parameters) }, engine: publicEngine(engine) });
        }
        catch (error) { return fail(422, { error: messageOf(error) }); }
      }
      if (method === "POST" && path === "/api/apply-s2") {
        if (body.engine === "s2-simple") return ok(applyHumanFinalPlacementUnderObservedS2(guiStateToCanonical(body.state), body.move));
        try {
          const engine = requireCc2Type(body.engine);
          const result = isS2(engine) ? selectS2(body.state, body.moves ?? [body.move], engine) : applyCc2FinalPlacementUnderObservedS2(body.state, body.move, publicEngine(engine));
          return result.status === "unsupported" ? fail(422, result) : ok(result);
        } catch (error) { return fail(422, { error: messageOf(error) }); }
      }
      if (method === "POST" && path === "/api/s2/transition") {
        const result = canonicalTransitionHttpResponse(body);
        return { status: result.statusCode, body: result.body };
      }
      if (method === "POST" && path === "/api/compare-simple") {
        try { return ok(compareSimpleSamePositionCandidates(body.baseline, body.challenger)); }
        catch (error) { return fail(422, { error: messageOf(error) }); }
      }
      if (method === "POST" && path === "/api/match/start") return startMatch(body);
      if (method === "POST" && path === "/api/match/step") return stepMatch(body);
      if (method === "POST" && path === "/api/match/human-lock") return humanLock(body);
      if (method === "POST" && path === "/api/match/close") return closeMatch();
      if (method === "GET" && path === "/api/match/round") return round();
      if (method === "GET" && path === "/api/match/ttrm") return fail(409, {
        stage: "static-mode", message: "TTRM export is available from the local server only",
      });
      if (method === "POST" && path === "/api/replay/import") return importReplay(String(body ?? ""));
      return fail(404, { error: "not-found" });
    },
  });

  async function startMatch(body) {
    try {
      const left = staticBotType(body.left ?? "s2-simple");
      const right = staticBotType(body.right ?? "s2-simple");
      if (right === "human") throw new Error("You (1P) is available only on the left side");
      if (left === "human" && right === "human") throw new Error("only one side can be played by a human");
      const humanSide = left === "human" ? "left" : null;
      const config = normalizeBotMatchOptions(body);
      if (humanSide !== null && config.fairComparison) throw new Error("fair comparison cannot include a human player");
      const botParameters = {
        left: config.fairComparison
          ? fairComparisonBotParameters(left, body.leftParameters)
          : normalizeBotParameters(left, body.leftParameters),
        right: config.fairComparison
          ? fairComparisonBotParameters(right, body.rightParameters)
          : normalizeBotParameters(right, body.rightParameters),
      };
      await cc2Runtime?.closeSessions({ sessionKeys: ["left", "right"] });
      const ttrmCompatible = body.ttrmCompatible === true;
      const queueModel = ttrmCompatible ? QUEUE_MODE_TRIANGLE_7_BAG : QUEUE_MODE_LEGACY_LCG;
      const scenario = createGame(config.seed, { queueModel });
      const initial = guiStateToCanonical(toS2GuiState(scenario));
      const match = createBotMatch({
        bots: [
          { id: "left", gameId: 1, state: structuredClone(initial) },
          { id: "right", gameId: 2, state: structuredClone(initial) },
        ],
        mode: "paced",
        ppsByBotId: {
          left: left === "human" ? null : staticPacedRate(left, botParameters.left, config.fairComparison, humanSide !== null),
          right: right === "human" ? null : staticPacedRate(right, botParameters.right, config.fairComparison, humanSide !== null),
        },
      });
      session = {
        types: { left, right }, humanSide, botParameters, config, ttrmCompatible, queueModel,
        mutations: createLiveMatchMutationQueue(), inFlightStep: null,
        queueSeeds: { left: scenario.bagSeed, right: scenario.bagSeed }, match, recording: createMatchRecording({
          match, meta: { origin: "s2-bot-match/1", users: [{ id: "left", username: "LEFT · ${left}" }, { id: "right", username: "RIGHT · ${right}" }],
            gamemode: "s2-bot-match", ts: new Date().toISOString(), version: 1, parseMs: 0,
            match: { seed: config.seed, fairComparison: config.fairComparison,
              maxTurns: config.maxTurns, firstTo: 1, ttrmCompatible, queueModel,
              declaredPpsByBotId: structuredClone(match.pace.ppsByBotId),
              bots: { left: { type: left, parameters: botParameters.left }, right: { type: right, parameters: botParameters.right } }, rulesetId: match.rulesetId } },
        }), finishedRound: null, lastSubmissions: [],
      };
      return ok(matchView());
    } catch (error) { return fail(400, { error: messageOf(error) }); }
  }

  async function stepMatch(body = {}) {
    if (session === null) return fail(409, { error: "match-not-started" });
    if (session.inFlightStep !== null) return session.inFlightStep;
    const activeSession = session;
    const work = runStepMatch(activeSession, body).finally(() => {
      if (activeSession.inFlightStep === work) activeSession.inFlightStep = null;
    });
    activeSession.inFlightStep = work;
    return work;
  }

  async function runStepMatch(activeSession, body) {
    const prepared = await activeSession.mutations.run(() => {
      if (session !== activeSession) return null;
      const view = matchView();
      if (view.outcome.complete) return { complete: view.outcome };
      refillQueues();
      const nextStep = botMatchNextStep(activeSession.match);
      return {
        match: activeSession.match,
        nextStep,
        bots: activeSession.match.bots.filter((bot) => nextStep.botIds.includes(bot.id)),
      };
    });
    if (prepared === null) return fail(409, { error: "match-replaced" });
    if (prepared.complete !== undefined) return fail(409, { error: "match-complete", outcome: prepared.complete });
    if (prepared.bots.every((bot) => activeSession.types[bot.id] === "human")) {
      return fail(409, { error: "human-lock-required" });
    }

    const requestedWallFrame = activeSession.humanSide === null
      ? null
      : validWallFrame(body?.lockFrame, activeSession.match.clock.logicalFrame);
    const startedAt = now();
    let proposals;
    try {
      proposals = await runBotProposals(
        prepared.bots.filter((bot) => activeSession.types[bot.id] !== "human"),
        (bot) => proposeStaticBot(activeSession, prepared.match, bot, prepared.bots.length),
        { serial: activeSession.config.fairComparison },
      );
    } catch (error) {
      await cc2Runtime?.closeSessions({ sessionKeys: ["left", "right"] });
      return fail(422, { error: messageOf(error) });
    }

    if (requestedWallFrame !== null) {
      const elapsedMs = now() - startedAt;
      const delayMs = realtimeDeadlineDelayMs({
        scheduledFrame: prepared.nextStep.logicalFrame,
        requestWallFrame: requestedWallFrame,
        elapsedMs,
      });
      if (delayMs > 0) await wait(delayMs);
    }

    try {
      return await activeSession.mutations.run(() => {
        if (session !== activeSession) return fail(409, { error: "match-replaced" });
        if (matchView().outcome.complete) return fail(409, { error: "match-complete", outcome: matchView().outcome });
        const submissions = proposals.map((proposal) => resolveStaticProposal(activeSession, proposal));
        const before = activeSession.match;
        const scheduledLockFrame = requestedWallFrame === null ? null : realtimeScheduledLockFrame({
          scheduledFrame: botMatchNextStep(before).logicalFrame,
          requestWallFrame: requestedWallFrame,
          elapsedMs: now() - startedAt,
          currentLogicalFrame: before.clock.logicalFrame,
        });
        activeSession.match = advanceBotMatch(before, submissions, { scheduledLockFrame });
        activeSession.lastSubmissions = submissions;
        activeSession.recording = recordMatchLocks(activeSession.recording, before, activeSession.match, submissions);
        finalize();
        const view = matchView(before);
        if (view.outcome.complete) cc2Runtime?.closeSessions({ sessionKeys: ["left", "right"] });
        return ok(view);
      });
    } catch (error) {
      return fail(422, { error: messageOf(error) });
    }
  }

  async function humanLock(body) {
    if (session === null) return fail(409, { error: "match-not-started" });
    const activeSession = session;
    if (activeSession.humanSide === null) return fail(409, { error: "no-human-player" });
    if (!Number.isSafeInteger(body.lockFrame) || body.lockFrame < 0) return fail(400, { error: "lockFrame must be a non-negative safe integer" });
    try {
      return await activeSession.mutations.run(() => {
        if (session !== activeSession) return fail(409, { error: "match-replaced" });
        if (matchView().outcome.complete) return fail(409, { error: "match-complete", outcome: matchView().outcome });
        refillQueues();
        const window = externalLockFrameWindow(activeSession.match, activeSession.humanSide, { allowScheduledOverrun: true });
        const lockFrame = Math.max(body.lockFrame, window.earliest);
        const bot = activeSession.match.bots.find((candidate) => candidate.id === activeSession.humanSide);
        const result = applyHumanFinalPlacementUnderObservedS2(bot.state, body.placement);
        if (result.transition === null) return fail(422, { error: result.reasons.join(", ") });
        const submission = submissionFor(bot, result.comparison.witness.placement, result.transition, result.comparison.score);
        const before = activeSession.match;
        activeSession.match = advanceBotMatch(before, [submission], {
          externalLockFrame: lockFrame,
          allowScheduledOverrun: true,
        });
        activeSession.lastSubmissions = [submission];
        activeSession.recording = recordMatchLocks(activeSession.recording, before, activeSession.match, [submission]);
        finalize();
        const view = matchView();
        if (view.outcome.complete) cc2Runtime?.closeSessions({ sessionKeys: ["left", "right"] });
        return ok(view);
      });
    } catch (error) {
      return fail(422, { error: messageOf(error) });
    }
  }

  async function closeMatch() {
    await cc2Runtime?.closeSessions({ sessionKeys: ["left", "right"] });
    session = null;
    return ok({ closed: true });
  }

  async function proposeStaticBot(activeSession, preparedMatch, bot, dueCount) {
    const type = activeSession.types[bot.id];
    if (type === "s2-simple") return { botId: bot.id, type };
    if (cc2Runtime === null) throw new Error("CC2 WASM is unavailable");
    const parameters = activeSession.botParameters[bot.id];
    const gui = botMatchToGuiState(preparedMatch, bot.id);
    const state = {
      board: gui.board,
      queue: gui.queue.slice(0, parameters.queueDepth),
      hold: gui.hold,
      combo: gui.combo,
      back_to_back: gui.back_to_back,
      randomizer: { type: "seven_bag", bag_state: [] },
    };
    const proposal = await cc2Runtime.propose({
      sessionKey: bot.id,
      engine: type,
      state,
      ...cc2MatchSearchBudget(activeSession, bot.id, dueCount),
    });
    return { botId: bot.id, type, moves: proposal.suggestion.moves };
  }

  function resolveStaticProposal(activeSession, proposal) {
    const bot = activeSession.match.bots.find((candidate) => candidate.id === proposal.botId);
    const type = activeSession.types[bot.id];
    if (type === "s2-simple") {
      const analysis = analyzeSimpleS2FinalPlacements(bot.state, {
        topN: 1,
        allowHold: activeSession.botParameters[bot.id].allowHold,
      });
      const best = analysis.moves[0];
      if (!best) throw new Error(`${bot.id} has no legal final placement`);
      return submissionFor(bot, best.placement, best.transition, best.score);
    }
    const gui = botMatchToGuiState(activeSession.match, bot.id);
    const result = isS2(type)
      ? selectS2(gui, proposal.moves, type)
      : applyCc2FinalPlacementUnderObservedS2(gui, proposal.moves[0], publicEngine(type));
    if (result.transition === null) throw new Error(`${bot.id} CC2 placement rejected`);
    return submissionFor(bot, result.comparison.witness.placement, result.transition, result.comparison.score);
  }

  function cc2MatchSearchBudget(activeSession, botId, dueCount) {
    const parameters = activeSession.botParameters[botId];
    const budget = cc2SearchBudget(parameters);
    if (activeSession.humanSide !== null || parameters.ppsEnabled === false || !parameters.thinkTimeEnabled) return budget;
    return {
      ...budget,
      thinkMs: realtimeCc2ThinkMs({
        thinkMs: parameters.thinkMs,
        stepFrames: 60 / activeSession.match.pace.ppsByBotId[botId],
        serialProposalCount: activeSession.config.fairComparison ? dueCount : 1,
      }),
    };
  }

  function round() {
    if (session === null) return fail(409, { error: "match-not-started" });
    finalize();
    return ok(session.finishedRound ?? finishMatchRecording(session.recording, { outcome: matchView().outcome, match: session.match }));
  }

  function importReplay(text) {
    if (text.length > MAX_TTRM_TEXT_LENGTH) return fail(413, { stage: "size", message: "file is too large" });
    try { return ok({ ir: buildReplayIR(parseTtrm(text), nowMs()) }); }
    catch (error) { return fail(error instanceof TtrmError ? 422 : 500, { stage: error.stage ?? "simulate", message: messageOf(error) }); }
  }

  function submissionFor(bot, move, transition, score) {
    const gui = botMatchToGuiState(session.match, bot.id);
    return { botId: bot.id, result: { transition, comparison: { positionFingerprint: fullStateKey(bot.state) } }, move,
      score, lastPlaced: lockedPieceCells(gui.board, transition, move.piece) };
  }

  function refillQueues() {
    for (const bot of session.match.bots) {
      const current = botMatchToGuiState(session.match, bot.id).queue;
      const extended = session.queueModel === QUEUE_MODE_TRIANGLE_7_BAG
        ? extendTriangleSeededQueue(current, session.queueSeeds[bot.id], 28)
        : extendSeededQueue(current, session.queueSeeds[bot.id], 28);
      session.queueSeeds[bot.id] = extended.bagSeed;
      if (extended.queue.length !== current.length) session.match = extendBotMatchQueue(session.match, bot.id, extended.queue);
    }
  }

  function matchView(preLockMatch = null) {
    const submitted = new Map(session.lastSubmissions.map((entry) => [entry.botId, entry]));
    const bots = session.match.bots.map((bot) => {
      const gui = botMatchToGuiState(session.match, bot.id);
      const last = submitted.get(bot.id);
      const preLockBot = preLockMatch?.bots.find((candidate) => candidate.id === bot.id) ?? null;
      const preLockGui = preLockBot === null ? null : botMatchToGuiState(preLockMatch, bot.id);
      return { id: bot.id, type: session.types[bot.id], board: gui.board, lastPlaced: last?.lastPlaced ?? [],
        preLockPreview: preLockGui === null || last === undefined || session.types[bot.id] === "human"
          ? null
          : preLockPreview(preLockGui, last),
        current: gui.queue[0] ?? null, next: gui.queue.slice(1, 7), hold: gui.hold, holdAvailable: bot.state.pieces.holdAvailable,
        garbage: { pending: gui.s2.garbage.packets.reduce((total, packet) => total + packet.amount, 0), packets: gui.s2.garbage.packets },
        combo: gui.combo, b2b: gui.s2.b2b, piecesPlaced: gui.s2.time.piecesPlaced,
        lines: last?.result?.transition?.lockResult?.lines ?? 0, lastClear: last?.result?.transition?.lockResult ?? null,
        outgoing: last?.result?.transition?.cancelResult?.outgoingAfterCancel ?? 0, score: last?.score ?? null, move: last?.move ?? null,
        stats: bot.stats, metrics: calculatePlayerMetrics({ pieces: bot.stats.turns, attack: bot.stats.attack, garbageCleared: bot.stats.garbageCleared, elapsedFrames: session.match.clock.logicalFrame }),
        toppedOut: gui.board.slice(20).some((row) => row.some((cell) => cell !== null)) };
    });
    const outcome = matchOutcome(bots, session.match.turnNumber, session.config.maxTurns);
    return { status: outcome.complete ? "complete" : "active", turnNumber: session.match.turnNumber, humanSide: session.humanSide,
      mode: session.match.mode, clock: session.match.clock, config: session.config, botParameters: session.botParameters, outcome,
      pacing: { authority: session.humanSide === null ? "synthetic" : "realtime-1p", declaredPpsByBotId: structuredClone(session.match.pace.ppsByBotId) },
      deliveries: session.match.lastStep?.deliveries ?? [], metricElapsedMs: session.match.clock.logicalFrame * 1000 / 60,
      nextStepFrames: outcome.complete ? null : botMatchNextStep(session.match).frames, bots, replayMeta: session.recording?.meta ?? null };
  }

  function finalize() {
    if (session.finishedRound !== null) return;
    const outcome = matchView().outcome;
    if (outcome.complete) session.finishedRound = finishMatchRecording(session.recording, { outcome, match: session.match });
  }
}

function preLockPreview(gui, submission) {
  const placement = submission.result?.comparison?.witness?.placement ?? submission.move;
  if (!isCanonicalPlacement(placement)) return null;
  return { board: gui.board, placement: structuredClone(placement) };
}

function isCanonicalPlacement(placement) {
  return placement !== null && typeof placement === "object" &&
    ["I", "O", "T", "L", "J", "S", "Z"].includes(placement.piece) &&
    ["spawn", "right", "reverse", "left"].includes(placement.rotation) &&
    Number.isSafeInteger(placement.x) && Number.isSafeInteger(placement.y);
}

function ok(body) { return { status: 200, body }; }
function fail(status, body) { return { status, body }; }
function messageOf(error) { return error instanceof Error ? error.message : String(error); }
function validWallFrame(value, fallback) { return Number.isSafeInteger(value) && value >= 0 ? value : fallback; }
function defaultWait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function unavailable(id, label) { return { id, label, available: false, reason: "requires the local server", parameters: [] }; }
function staticCc2Capability(id) { const capability = botParameterCapability(id); capability.description += " 公開WASM版でもTHINK TIMEを利用できます。有効時は端末性能・ブラウザ・実行時負荷によって探索量と選択手が変化します。"; return capability; }
function cc2SearchBudget(parameters) { return {
  selectionLimit: parameters.selectionEnabled ? parameters.selectionLimit : null,
  thinkMs: parameters.thinkTimeEnabled ? parameters.thinkMs : null,
}; }
function staticPacedRate(botType, parameters, fairComparison, realtime) {
  if (fairComparison) return 1;
  return botType.startsWith("cc2-") ? ppsForCc2Parameters(parameters, { realtime }) : parameters.pps;
}
function staticWasmVersion(parameters) {
  if (parameters.selectionEnabled && !parameters.thinkTimeEnabled) return `deterministic-wasm-${parameters.selectionLimit}`;
  return "time-budgeted-wasm";
}
function staticBotType(value) {
  if (value !== "s2-simple" && value !== "human" && !(value in CC2_LABELS)) throw new Error(`unsupported static bot ${value}`);
  return value;
}
function requireCc2Type(value) { if (!(value in CC2_LABELS)) throw new Error(`unsupported CC2 engine ${value}`); return value; }
function isS2(value) { return value.startsWith("cc2-s2"); }
function publicEngine(id) { return { botType: id, engineId: id, label: CC2_LABELS[id], repository: id === "cc2-raw" ? "https://github.com/MinusKelvin/cold-clear-2" : id === "cc2-chouhy" ? "https://github.com/chouhy/cold-clear-2" : "https://github.com/61bi-234469/s2-analysis-engine", commit: id === "cc2-raw" ? "ed8b19327b6bd1410ddd873d8611485bd45d8fae" : id === "cc2-chouhy" ? "b20a92b0ed3230dd910d0674f7a09c552a34dd46" : "ed8b193+local-s2-reranker", comparisonSource: `${id}-final-placement` }; }
function selectS2(gui, moves, id) {
  const common = { candidateLimit:16,rankPenalty:25,adjustmentScale:28,weightProfileId:"sparse-s2",weights:SPARSE_S2_WEIGHTS,allowCompleteReturnedPrefix:true,engineId:id,comparisonSource:`${id}-final-placement` };
  if (id === "cc2-s2-f11") return selectS2RenQualityPlacement(gui,moves,common);
  if (id === "cc2-s2-f12") return selectS2ConversionQualifiedRenFinisherPlacement(gui,moves,common);
  if (id === "cc2-s2-f14") return selectS2F12PostTankSolvencyRescuePlacement(gui,moves,common);
  if (id === "cc2-s2-f25") return selectS2ThresholdImminentB2bRetentionPlacement(gui,moves,common);
  if (id === "cc2-s2-champion") return selectS2F12PostTankSolvencyRescuePlacement(gui,moves,common);
  return selectCc2S2HybridPlacement(gui,moves,publicEngine(id));
}
