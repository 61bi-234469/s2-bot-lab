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
import { botParameterCapability, normalizeBotParameters } from "./bot-parameters.mjs";
import { matchOutcome, normalizeBotMatchOptions } from "./bot-match-options.mjs";
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
export function createGuiRequestHandlers({ proposeCc2 = null } = {}) {
  let session = null;

  return Object.freeze({
    async handle({ method, path, body = null }) {
      if (method === "GET" && path === "/api/bots") return ok({
        runtime: { mode: "static-wasm", selectionLimit: 512, searchSeed: "5994928009864282113" },
        ruleset: { id: RULESET_IDS.s2Observed, b2bCharging: resolvePlacementRules(RULESET_IDS.s2Observed).b2bCharging },
        bots: [
          ...Object.entries(CC2_LABELS).map(([id, label]) => proposeCc2 === null ? unavailable(id, label) : ({ id, label, available: true, ...staticCc2Capability(id) })),
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
        if (proposeCc2 === null) return fail(503, { error: "CC2 WASM is unavailable" });
        const engine = requireCc2Type(body.engine ?? "cc2-raw");
        try { return ok({ ...(await proposeCc2({ engine, state: body.state })), info: { version: "deterministic-wasm-512" }, engine: publicEngine(engine) }); }
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
      if (method === "POST" && path === "/api/match/step") return stepMatch();
      if (method === "POST" && path === "/api/match/human-lock") return humanLock(body);
      if (method === "GET" && path === "/api/match/round") return round();
      if (method === "GET" && path === "/api/match/ttrm") return fail(409, {
        stage: "static-mode", message: "TTRM export is available from the local server only",
      });
      if (method === "POST" && path === "/api/replay/import") return importReplay(String(body ?? ""));
      return fail(404, { error: "not-found" });
    },
  });

  function startMatch(body) {
    try {
      const left = staticBotType(body.left ?? "s2-simple");
      const right = staticBotType(body.right ?? "s2-simple");
      if (left === "human" && right === "human") throw new Error("only one side can be played by a human");
      const humanSide = left === "human" ? "left" : right === "human" ? "right" : null;
      const config = normalizeBotMatchOptions(body);
      if (humanSide !== null && config.fairComparison) throw new Error("fair comparison cannot include a human player");
      const botParameters = {
        left: normalizeBotParameters(left, body.leftParameters),
        right: normalizeBotParameters(right, body.rightParameters),
      };
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
        ppsByBotId: { left: left === "human" ? null : botParameters.left.pps, right: right === "human" ? null : botParameters.right.pps },
      });
      session = {
        types: { left, right }, humanSide, botParameters, config, ttrmCompatible, queueModel,
        queueSeeds: { left: scenario.bagSeed, right: scenario.bagSeed }, match, recording: createMatchRecording({
          match, meta: { origin: "s2-bot-match/1", users: [{ id: "left", username: "LEFT · ${left}" }, { id: "right", username: "RIGHT · ${right}" }],
            gamemode: "s2-bot-match", ts: new Date().toISOString(), version: 1, parseMs: 0,
            match: { seed: config.seed, fairComparison: config.fairComparison, thinkTimePace: config.thinkTimePace,
              maxTurns: config.maxTurns, firstTo: 1, ttrmCompatible, queueModel,
              bots: { left: { type: left, parameters: botParameters.left }, right: { type: right, parameters: botParameters.right } }, rulesetId: match.rulesetId } },
        }), finishedRound: null, lastSubmissions: [],
      };
      return ok(matchView());
    } catch (error) { return fail(400, { error: messageOf(error) }); }
  }

  async function stepMatch() {
    if (session === null) return fail(409, { error: "match-not-started" });
    const view = matchView();
    if (view.outcome.complete) return fail(409, { error: "match-complete", outcome: view.outcome });
    refillQueues();
    const ids = botMatchNextStep(session.match).botIds;
    const submissions = [];
    for (const botId of ids) {
      if (session.types[botId] === "human") continue;
      const bot = session.match.bots.find((candidate) => candidate.id === botId);
      if (session.types[botId] === "s2-simple") {
        const analysis = analyzeSimpleS2FinalPlacements(bot.state, { topN: 1, allowHold: session.botParameters[botId].allowHold });
        const best = analysis.moves[0];
        if (!best) return fail(422, { error: `${botId} has no legal final placement` });
        submissions.push(submissionFor(bot, best.placement, best.transition, best.score));
      } else {
        const engine = session.types[botId];
        const gui = botMatchToGuiState(session.match, bot.id);
        const state = { board: gui.board, queue: gui.queue.slice(0, session.botParameters[botId].queueDepth), hold: gui.hold, combo: gui.combo, back_to_back: gui.back_to_back, randomizer: { type: "seven_bag", bag_state: [] } };
        const proposal = await proposeCc2({ engine, state });
        const result = isS2(engine) ? selectS2(gui, proposal.suggestion.moves, engine) : applyCc2FinalPlacementUnderObservedS2(gui, proposal.suggestion.moves[0], publicEngine(engine));
        if (result.transition === null) return fail(422, { error: `${botId} CC2 placement rejected` });
        submissions.push(submissionFor(bot, result.comparison.witness.placement, result.transition, result.comparison.score));
      }
    }
    if (submissions.length === 0) return fail(409, { error: "human-lock-required" });
    const before = session.match;
    session.match = advanceBotMatch(before, submissions);
    session.lastSubmissions = submissions;
    session.recording = recordMatchLocks(session.recording, before, session.match, submissions);
    finalize();
    return ok(matchView());
  }

  function humanLock(body) {
    if (session === null) return fail(409, { error: "match-not-started" });
    if (session.humanSide === null) return fail(409, { error: "no-human-player" });
    if (!Number.isSafeInteger(body.lockFrame) || body.lockFrame < 0) return fail(400, { error: "lockFrame must be a non-negative safe integer" });
    const window = externalLockFrameWindow(session.match, session.humanSide);
    if (window === null) return fail(409, { error: "human-lock-not-schedulable" });
    const bot = session.match.bots.find((candidate) => candidate.id === session.humanSide);
    const gui = botMatchToGuiState(session.match, bot.id);
    const result = applyHumanFinalPlacementUnderObservedS2(bot.state, body.placement);
    if (result.transition === null) return fail(422, { error: result.reasons.join(", ") });
    const submission = submissionFor(bot, result.comparison.witness.placement, result.transition, result.comparison.score);
    const before = session.match;
    session.match = advanceBotMatch(before, [submission], { externalLockFrame: Math.min(Math.max(body.lockFrame, window.earliest), window.latest) });
    session.lastSubmissions = [submission];
    session.recording = recordMatchLocks(session.recording, before, session.match, [submission]);
    finalize();
    return ok(matchView());
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

  function matchView() {
    const submitted = new Map(session.lastSubmissions.map((entry) => [entry.botId, entry]));
    const bots = session.match.bots.map((bot) => {
      const gui = botMatchToGuiState(session.match, bot.id);
      const last = submitted.get(bot.id);
      return { id: bot.id, type: session.types[bot.id], board: gui.board, lastPlaced: last?.lastPlaced ?? [], preLockPreview: null,
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
      deliveries: session.match.lastStep?.deliveries ?? [], metricElapsedMs: session.match.clock.logicalFrame * 1000 / 60,
      nextStepFrames: outcome.complete ? null : botMatchNextStep(session.match).frames, bots, replayMeta: session.recording?.meta ?? null };
  }

  function finalize() {
    if (session.finishedRound !== null) return;
    const outcome = matchView().outcome;
    if (outcome.complete) session.finishedRound = finishMatchRecording(session.recording, { outcome, match: session.match });
  }
}

function ok(body) { return { status: 200, body }; }
function fail(status, body) { return { status, body }; }
function messageOf(error) { return error instanceof Error ? error.message : String(error); }
function unavailable(id, label) { return { id, label, available: false, reason: "requires the local server", parameters: [] }; }
function staticCc2Capability(id) { const capability = botParameterCapability(id); capability.description += " Static WASM uses a fixed 512-selection budget; THINK TIME is ignored."; capability.parameters = capability.parameters.map((parameter) => parameter.key === "thinkMs" ? { ...parameter, disabled: true, disabledReason: "Static WASM uses exactly 512 selections" } : parameter); return capability; }
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
