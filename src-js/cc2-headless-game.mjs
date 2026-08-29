import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { calculatePlayerMetrics } from "../cc2-gui/player-metrics.mjs";
import { classifyArenaSpawnBlockouts } from "./arena-terminal.mjs";
import { createGame, extendSeededQueue, toS2GuiState } from "../cc2-gui/game.mjs";
import { matchOutcome } from "./bot-match-options.mjs";
import {
  advanceBotMatch,
  botMatchNextStep,
  botMatchToGuiState,
  createBotMatch,
  extendBotMatchQueue,
  synchronizeBotMatchMovementStates,
} from "./bot-match-controller.mjs";
import { requestCc2Suggestion } from "./cc2-bridge.mjs";
import {
  applyCc2FinalPlacementUnderObservedS2,
  applyCc2ReachableFinalPlacementUnderObservedS2,
  cc2EngineFrameContinuationForResult,
  guiStateToCanonical,
} from "./cc2-s2-adapter.mjs";
import { fullStateKey } from "./state-keys.mjs";
import { classifyProposalError, failedProposal } from "./proposal-outcome.mjs";
import {
  proposeS2ArenaDepthOne,
  s2ArenaContinuationForResult,
} from "./s2-arena-proposer.mjs";
import { resolvePlacementRules } from "./ruleset-profiles.mjs";
import {
  advanceEngineFrameContinuationToState,
  engineFrameContinuationIdentity,
  inspectEngineFrameSpawn,
} from "./triangle/engine-frame-move-generation.mjs";

/** Runs one descriptor from headless-arena.mjs using two fixed CC2 binaries. */
export async function playCc2HeadlessGame(descriptor, protocol, {
  engines,
  requestSuggestion = requestCc2Suggestion,
  now = () => performance.now(),
  phaseScheduler = null,
} = {}) {
  assertRuntimeEngines(descriptor, protocol, engines);
  const scenario = createGame(descriptor.seed);
  const scenarioGui = toS2GuiState(scenario);
  const initial = guiStateToCanonical(scenarioGui);
  if (initial.rulesetId !== protocol.rulesetId) throw new Error("arena runtime ruleset does not match its protocol");
  const initialFingerprint = fullStateKey(initial);
  let match = createBotMatch({
    bots: [
      { id: "left", gameId: 1, state: initial },
      { id: "right", gameId: 2, state: structuredClone(initial) },
    ],
    mode: "paced",
    ppsByBotId: { left: protocol.profile.pps, right: protocol.profile.pps },
  });
  const queueSeeds = { left: scenario.bagSeed, right: scenario.bagSeed };
  const engineBySide = Object.fromEntries(descriptor.sides.map(({ side, engineId }) => [side, engines[engineId]]));
  const latencySamplesMs = { left: [], right: [] };
  const moveInfoSamples = { left: [], right: [] };
  const executionTrace = [];
  const queueObservationSha256 = { left: emptySha256(), right: emptySha256() };
  const queueStreamSha256 = plannedQueueStreamSha256(
    scenarioGui.queue,
    scenario.bagSeed,
    protocol.profile.maxLocksPerSide + protocol.profile.knownQueue + 1,
  );
  let peakMemoryBytes = null;
  let memorySamplesExpected = 0;
  let memorySamplesRecorded = 0;
  const continuationBySide = { left: null, right: null };
  const degraded = new Set(protocol.profile.movementModel === "final-placement-only/2"
    ? ["frame-exact-reachability-unavailable"]
    : []);
  if (Object.values(engineBySide).some((engine) =>
    engine.runtimeKind === "s2-native-js" && engine.sourceWorktreeCommitted !== true
  )) degraded.add("s2-source-worktree-uncommitted");

  while (true) {
    const view = outcomeView(match, protocol.profile.maxLocksPerSide, continuationBySide);
    if (view.complete) {
      return gameResult({
        descriptor,
        match,
        outcome: view,
        engineBySide,
        initialFingerprint,
        latencySamplesMs,
        executionTrace,
        degraded,
        peakMemoryBytes,
        queueStreamSha256,
        queueObservationSha256,
        memorySamplesExpected,
        memorySamplesRecorded,
        moveInfoSamples,
      });
    }
    match = refillQueues(match, queueSeeds, protocol.profile.knownQueue);
    if (protocol.profile.movementModel === "engine-frame-single-held-controller/4" &&
        Object.values(continuationBySide).some((continuation) => continuation !== null)) {
      const refreshed = refreshContinuations(match, continuationBySide);
      match = refreshed.match;
      Object.assign(continuationBySide, refreshed.continuations);
    }
    const nextStep = botMatchNextStep(match);
    const dueSides = match.bots.filter((bot) => nextStep.botIds.includes(bot.id));
    const orderedEngineIds = [];
    const proposals = [];
    const submissions = [];
    for (const bot of dueSides) {
      const side = bot.id;
      const engine = engineBySide[side];
      orderedEngineIds.push(engine.id);
      const gui = botMatchToGuiState(match, side);
      queueObservationSha256[side] = chainedQueueObservationSha256(queueObservationSha256[side], gui);
      const started = now();
      let result;
      try {
        if (engine.runtimeKind === "s2-native-js") {
          phaseScheduler?.enterS2();
          try {
            result = proposeS2ArenaDepthOne(bot.state, {
              continuation: continuationBySide[side],
              targetLockFrame: nextStep.logicalFrame - 1,
              engineId: engine.id,
              knownQueue: protocol.profile.knownQueue,
              yieldControl: phaseScheduler?.yieldS2 ?? null,
            });
          } finally {
            phaseScheduler?.leaveS2();
          }
        } else {
          memorySamplesExpected += 1;
          await phaseScheduler?.acquireCc2();
          let response;
          try {
            response = await requestSuggestion({
              binary: engine.binary,
              thinkMs: protocol.profile.thinkMs,
              state: {
                board: gui.board,
                queue: gui.queue.slice(0, protocol.profile.knownQueue),
                hold: gui.hold,
                combo: gui.combo,
                back_to_back: gui.back_to_back,
                randomizer: gui.randomizer,
              },
            });
          } finally {
            phaseScheduler?.releaseCc2();
          }
          if (response.info?.version !== engine.tbpVersion) {
            throw new Error(
              `runtime engine ${engine.id} TBP version mismatch: expected ${engine.tbpVersion}, got ${response.info?.version ?? "missing"}`,
            );
          }
          const observedLatency = Number.isFinite(response.requestToSuggestionMs)
            ? response.requestToSuggestionMs
            : now() - started;
          latencySamplesMs[side].push(observedLatency);
          if (Number.isSafeInteger(response.peakMemoryBytes) && response.peakMemoryBytes >= 0) {
            memorySamplesRecorded += 1;
            peakMemoryBytes = peakMemoryBytes === null
              ? response.peakMemoryBytes
              : Math.max(peakMemoryBytes, response.peakMemoryBytes);
          }
          const moveInfo = response.suggestion.move_info;
          if (Number.isSafeInteger(moveInfo?.nodes) && moveInfo.nodes > 0 &&
              Number.isFinite(moveInfo?.nps) && moveInfo.nps > 0) {
            moveInfoSamples[side].push({ nodes: moveInfo.nodes, nps: moveInfo.nps });
          } else {
            degraded.add("cc2-search-effort-unavailable");
          }
          const move = response.suggestion.moves[0];
          const applyMove = protocol.profile.movementModel === "engine-frame-single-held-controller/4"
            ? applyCc2ReachableFinalPlacementUnderObservedS2
            : applyCc2FinalPlacementUnderObservedS2;
          result = applyMove(gui, move, {
            engineId: engine.id,
            comparisonSource: engine.comparisonSource,
            continuation: continuationBySide[side],
            targetLockFrame: nextStep.logicalFrame - 1,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const proposalResult = classifyProposalError({
          error,
          locksPlayed: match.turnNumber,
          latencyMs: now() - started,
          diagnostics: {
            engineId: engine.id,
            side,
            lockNumber: match.turnNumber + 1,
            runtimeKind: engine.runtimeKind ?? "cc2-binary",
          },
        });
        degraded.add(`engine-error:${engine.id}:${message}`);
        // The v1 release report treats every proposer exception as abnormal.
        // Keep that projection until a separately reviewed schema/scoring migration.
        return gameResult({
          descriptor, match, outcome: { winnerBotId: null, reason: "engine-error" }, engineBySide,
          initialFingerprint, latencySamplesMs, executionTrace, degraded, peakMemoryBytes,
          queueStreamSha256, queueObservationSha256,
          memorySamplesExpected, memorySamplesRecorded, moveInfoSamples, proposalResult,
        });
      }
      if (engine.runtimeKind === "s2-native-js") {
        const elapsed = now() - started;
        latencySamplesMs[side].push(elapsed);
        degraded.add("s2-depth1-budget-unqualified");
        degraded.add("s2-native-memory-measurement-not-isolated");
      }
      if (result.transition === null) {
        for (const reason of result.reasons) degraded.add(reason);
        const reasons = result.reasons ?? ["proposal returned no transition"];
        const proposalResult = failedProposal({
          code: "unsupported-placement",
          message: reasons.join("; "),
          diagnostics: {
            engineId: engine.id,
            side,
            lockNumber: match.turnNumber + 1,
            reasons: structuredClone(reasons),
          },
          latencyMs: latencySamplesMs[side].at(-1) ?? null,
        });
        return gameResult({
          descriptor, match, outcome: { winnerBotId: null, reason: "unsupported" }, engineBySide,
            initialFingerprint, latencySamplesMs, executionTrace, degraded, peakMemoryBytes,
            queueStreamSha256, queueObservationSha256,
            memorySamplesExpected, memorySamplesRecorded, moveInfoSamples, proposalResult,
        });
      }
      for (const reason of result.reasons ?? []) degraded.add(reason);
      proposals.push({
        engineId: engine.id,
        positionFingerprint: result.comparison.positionFingerprint,
        witnessKind: protocol.profile.movementModel,
        witnessSelectionPolicy: result.comparison.witnessSelectionPolicy,
        moveSelectionPolicy: result.comparison.moveSelectionPolicy ?? null,
        lockedAtFrame: result.comparison.witness.movementEvidence?.lockedAtFrame ?? null,
        continuationIdentity: result.comparison.continuation?.identity ?? null,
        continuationStateFingerprint: result.comparison.continuation?.projectedStateFingerprint ?? null,
        placementWitness: structuredClone(
          result.comparison.witness.placement ?? result.comparison.witness,
        ),
        transitionStateFingerprint: fullStateKey(result.transition.nextState),
        lockResult: {
          clearedRows: [...result.transition.lockResult.clearedRows],
          lines: result.transition.lockResult.lines,
          spin: result.transition.lockResult.spin,
          perfectClear: result.transition.lockResult.perfectClear,
        },
      });
      submissions.push({
        botId: side,
        result,
        continuation: protocol.profile.movementModel === "engine-frame-single-held-controller/4"
          ? engine.runtimeKind === "s2-native-js"
            ? s2ArenaContinuationForResult(result)
            : cc2EngineFrameContinuationForResult(result)
          : null,
      });
    }
    let advanced = advanceBotMatch(match, submissions);
    if (protocol.profile.movementModel === "engine-frame-single-held-controller/4") {
      const synchronized = [];
      const nextContinuations = {};
      const toppedOut = [];
      const unsupported = [];
      for (const submission of submissions) {
        const bot = advanced.bots.find((candidate) => candidate.id === submission.botId);
        const postAdvanceStateFingerprint = fullStateKey(bot.state);
        const proposal = proposals.find((candidate) => candidate.engineId === engineBySide[submission.botId].id);
        const sync = submission.continuation === null
          ? { status: "unsupported", reason: "post-lock-continuation-unavailable", state: null, continuation: null }
          : advanceEngineFrameContinuationToState(bot.state, submission.continuation);
        proposal.postAdvanceStateFingerprint = postAdvanceStateFingerprint;
        proposal.syncStatus = sync.status;
        proposal.syncReason = sync.reason;
        proposal.syncedStateFingerprint = sync.state === null ? null : fullStateKey(sync.state);
        proposal.syncedContinuationIdentity = sync.continuation === null
          ? null
          : engineFrameContinuationIdentity(sync.continuation);
        if (sync.status === "unsupported") {
          degraded.add(sync.reason);
          unsupported.push({
            botId: submission.botId,
            side: submission.botId,
            engineId: engineBySide[submission.botId].id,
            reason: sync.reason,
          });
          continue;
        }
        if (sync.status === "top-out") {
          toppedOut.push(submission.botId);
          continue;
        }
        synchronized.push({
          botId: submission.botId,
          expectedStateFingerprint: postAdvanceStateFingerprint,
          state: sync.state,
        });
        nextContinuations[submission.botId] = sync.continuation;
      }
      executionTrace.push({ logicalFrame: nextStep.logicalFrame, orderedEngineIds, proposals });
      if (unsupported.length > 0) {
        const proposalResult = failedProposal({
          code: "post-lock-continuation-unsupported",
          message: unsupported.map(({ engineId, reason }) => `${engineId}: ${reason}`).join("; "),
          diagnostics: {
            lockNumber: advanced.turnNumber,
            unsupported: structuredClone(unsupported),
          },
        });
        return gameResult({
          descriptor, match: advanced, outcome: { winnerBotId: null, reason: "unsupported" }, engineBySide,
          initialFingerprint, latencySamplesMs, executionTrace, degraded, peakMemoryBytes,
          queueStreamSha256, queueObservationSha256,
            memorySamplesExpected, memorySamplesRecorded, moveInfoSamples, proposalResult,
        });
      }
      if (toppedOut.length > 0) {
        const terminal = matchOutcome(
          classifyArenaSpawnBlockouts({
            topOutIsClear: false,
            blockedBotIds: toppedOut,
            botIds: advanced.bots.map((bot) => bot.id),
          }),
          advanced.turnNumber,
          protocol.profile.maxLocksPerSide,
        );
        return gameResult({
          descriptor, match: advanced, outcome: terminal, engineBySide,
          initialFingerprint, latencySamplesMs, executionTrace, degraded, peakMemoryBytes,
          queueStreamSha256, queueObservationSha256,
          memorySamplesExpected, memorySamplesRecorded, moveInfoSamples,
        });
      }
      advanced = synchronizeBotMatchMovementStates(advanced, synchronized);
      Object.assign(continuationBySide, nextContinuations);
    } else {
      executionTrace.push({ logicalFrame: nextStep.logicalFrame, orderedEngineIds, proposals });
    }
    match = advanced;
  }
}

function refillQueues(match, queueSeeds, knownQueue) {
  let next = match;
  for (const bot of next.bots) {
    const current = botMatchToGuiState(next, bot.id).queue;
    const extended = extendSeededQueue(current, queueSeeds[bot.id], Math.max(knownQueue, 28));
    queueSeeds[bot.id] = extended.bagSeed;
    if (extended.queue.length !== current.length) next = extendBotMatchQueue(next, bot.id, extended.queue);
  }
  return next;
}

function refreshContinuations(match, continuationBySide) {
  const replacements = [];
  const continuations = {};
  for (const bot of match.bots) {
    const continuation = continuationBySide[bot.id];
    if (continuation === null) continue;
    const expectedStateFingerprint = fullStateKey(bot.state);
    const refreshed = advanceEngineFrameContinuationToState(bot.state, continuation);
    if (refreshed.status !== "ready") {
      throw new Error(`continuation queue refresh failed for ${bot.id}: ${refreshed.reason}`);
    }
    replacements.push({ botId: bot.id, expectedStateFingerprint, state: refreshed.state });
    continuations[bot.id] = refreshed.continuation;
  }
  return {
    match: replacements.length === 0 ? match : synchronizeBotMatchMovementStates(match, replacements),
    continuations,
  };
}

function outcomeView(match, maxLocksPerSide, continuationBySide) {
  const movementRules = resolvePlacementRules(match.rulesetId);
  const blockedBotIds = match.bots.filter((bot) => continuationBySide[bot.id] === null &&
      inspectEngineFrameSpawn(bot.state, movementRules).status === "top-out")
    .map((bot) => bot.id);
  const bots = classifyArenaSpawnBlockouts({
    topOutIsClear: false,
    blockedBotIds,
    botIds: match.bots.map((bot) => bot.id),
  });
  return matchOutcome(bots, match.turnNumber, maxLocksPerSide);
}

function gameResult({
  descriptor,
  match,
  outcome,
  engineBySide,
  initialFingerprint,
  latencySamplesMs,
  executionTrace,
  degraded,
  peakMemoryBytes = null,
  queueStreamSha256,
  queueObservationSha256,
  memorySamplesExpected = 0,
  memorySamplesRecorded = 0,
  moveInfoSamples = { left: [], right: [] },
  proposalResult = null,
}) {
  const winnerSide = outcome.winnerBotId;
  return {
    winnerEngineId: winnerSide === null ? null : engineBySide[winnerSide].id,
    reason: outcome.reason,
    turns: match.turnNumber,
    initialStateFingerprints: { left: initialFingerprint, right: initialFingerprint },
    queueStreamSha256: { left: queueStreamSha256, right: queueStreamSha256 },
    queueObservationSha256: structuredClone(queueObservationSha256),
    stats: Object.fromEntries(match.bots.map((bot) => [engineBySide[bot.id].id, {
      side: bot.id,
      ...bot.stats,
      metrics: calculatePlayerMetrics({
        pieces: bot.stats.turns,
        attack: bot.stats.attack,
        garbageCleared: bot.stats.garbageCleared,
        elapsedFrames: match.clock.logicalFrame,
      }),
    }])),
    latency: {
      unit: "milliseconds-request-to-suggestion",
      byEngine: Object.fromEntries(Object.entries(latencySamplesMs).map(([side, samples]) => [
        engineBySide[side].id,
        { side, samples, max: samples.length === 0 ? null : Math.max(...samples), mean: mean(samples) },
      ])),
    },
    peakMemoryBytes: memorySamplesExpected > 0 && memorySamplesRecorded === memorySamplesExpected
      ? peakMemoryBytes
      : null,
    ...(proposalResult === null ? {} : { proposalResult: structuredClone(proposalResult) }),
    moveInfo: {
      byEngine: Object.fromEntries(Object.entries(moveInfoSamples).map(([side, samples]) => [
        engineBySide[side].id,
        { side, samples: structuredClone(samples) },
      ])),
    },
    degraded: [...degraded, ...(
      memorySamplesExpected > 0 && memorySamplesRecorded !== memorySamplesExpected
        ? ["peak-memory-partial"]
        : []
    )],
    executionTrace,
  };
}

function plannedQueueStreamSha256(initialQueue, bagSeed, length) {
  const planned = extendSeededQueue(initialQueue, bagSeed, length).queue.slice(0, length);
  return `sha256:${createHash("sha256").update(JSON.stringify(planned)).digest("hex")}`;
}

function emptySha256() {
  return `sha256:${createHash("sha256").update("").digest("hex")}`;
}

function chainedQueueObservationSha256(previous, gui) {
  const observation = {
    current: gui.current,
    hold: gui.hold,
    queue: gui.queue,
  };
  return `sha256:${createHash("sha256").update(JSON.stringify({ previous, observation })).digest("hex")}`;
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function assertRuntimeEngines(descriptor, protocol, engines) {
  if (engines === null || typeof engines !== "object") throw new Error("runtime engines are required");
  for (const { engineId } of descriptor.sides) {
    const engine = engines[engineId];
    const identity = protocol.engines.find((candidate) => candidate.id === engineId);
    const runtimeValid = engine?.runtimeKind === "s2-native-js"
      ? engine.sourceCommit === identity?.sourceCommit
      : engine?.sourceCommit === identity?.sourceCommit &&
        engine.tbpVersion === `0.1.0 ${identity.sourceCommit.slice(0, 7)}` &&
        typeof engine.binary === "string" && engine.binary.length > 0;
    if (!engine || engine.id !== engineId || !runtimeValid) {
      throw new Error(`runtime engine ${engineId} is unavailable`);
    }
  }
}
