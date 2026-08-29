import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { canonicalize } from "./cs1-core.mjs";
import { playCc2HeadlessGame } from "./cc2-headless-game.mjs";
import { requestCc2Suggestion } from "./cc2-bridge.mjs";
import { createProcessMemorySampler } from "./process-memory-sampler.mjs";
import {
  ARENA_CC2_COLLECTION_WINDOW_MS,
  ARENA_CC2_MAX_CONCURRENCY,
  createArenaPhaseBuffer,
  createArenaPhaseCoordinator,
} from "./arena-phase-scheduler.mjs";
import { ENGINE_FRAME_SCHEDULER_YIELD_NODES } from "./triangle/engine-frame-move-generation.mjs";
import { mapArenaJobs } from "./arena-execution.mjs";
import { assertProposalResult, classifyProposalError } from "./proposal-outcome.mjs";

export const BOT_ARENA_REPORT_SCHEMA = "s2-analysis-engine/schema/bot-arena-report/1";
export const BOT_ARENA_PROTOCOL = "s2-cc2-headless-arena/1";
export const CHOUHY_REFERENCE_COMMIT = "b20a92b0ed3230dd910d0674f7a09c552a34dd46";
export const ARENA_WITNESS_SELECTION_POLICY = "shortest-duration-then-controller-canonical-order/1";

const createdProtocols = new WeakSet();
const normalizedGames = new WeakSet();
// A parsed JSON report can be schema/semantically valid without proving that the
// games were executed by this runner. Release qualification therefore accepts
// only reports created by runHeadlessArena in this process.
const trustedArenaReports = new WeakSet();

export const REFERENCE_ARENA_PROFILE = Object.freeze({
  pps: 1,
  thinkMs: 250,
  knownQueue: 14,
  maxLocksPerSide: 500,
  movementModel: "engine-frame-single-held-controller/4",
  execution: "serial-stable-side-order",
});

export function createArenaProtocol({
  engines,
  rulesetId,
  evaluator,
  seeds,
  seedPartition = "development",
  profile = {},
} = {}) {
  if (!Array.isArray(engines) || engines.length !== 2) {
    throw new Error("arena requires exactly two engines");
  }
  const normalizedEngines = engines.map(normalizeEngine);
  if (normalizedEngines[0].id === normalizedEngines[1].id) {
    throw new Error("arena engine ids must be distinct");
  }
  nonEmptyString(rulesetId, "rulesetId");
  const normalizedEvaluator = normalizeEvaluator(evaluator);
  if (!Array.isArray(seeds) || seeds.length === 0) throw new Error("arena seeds must not be empty");
  const normalizedSeeds = seeds.map((seed) => uint32(seed, "arena seed"));
  if (new Set(normalizedSeeds).size !== normalizedSeeds.length) {
    throw new Error("arena seeds must be unique");
  }
  if (!["development", "holdout"].includes(seedPartition)) {
    throw new Error("seedPartition must be development or holdout");
  }
  const normalizedProfile = {
    pps: numberInRange(profile.pps ?? REFERENCE_ARENA_PROFILE.pps, 0.1, 20, "pps"),
    thinkMs: integerInRange(profile.thinkMs ?? REFERENCE_ARENA_PROFILE.thinkMs, 10, 60_000, "thinkMs"),
    knownQueue: integerInRange(profile.knownQueue ?? REFERENCE_ARENA_PROFILE.knownQueue, 1, 100, "knownQueue"),
    maxLocksPerSide: integerInRange(
      profile.maxLocksPerSide ?? REFERENCE_ARENA_PROFILE.maxLocksPerSide,
      1, 100_000, "maxLocksPerSide",
    ),
    movementModel: movementModel(profile.movementModel ?? REFERENCE_ARENA_PROFILE.movementModel),
    execution: REFERENCE_ARENA_PROFILE.execution,
  };
  const protocol = Object.freeze({
    id: BOT_ARENA_PROTOCOL,
    engines: Object.freeze(normalizedEngines),
    rulesetId,
    evaluator: Object.freeze(normalizedEvaluator),
    seedPartition,
    seeds: Object.freeze(normalizedSeeds),
    profile: Object.freeze(normalizedProfile),
  });
  createdProtocols.add(protocol);
  return protocol;
}

export function arenaGames(protocol) {
  assertProtocol(protocol);
  return Object.freeze(protocol.seeds.flatMap((seed, pairIndex) => [
    gameDescriptor(protocol, seed, pairIndex, 0),
    gameDescriptor(protocol, seed, pairIndex, 1),
  ]));
}

export async function runHeadlessArena(protocol, playGame, {
  now = () => new Date().toISOString(),
  parallelism = 1,
  searchEffortBaseline = null,
} = {}) {
  integerInRange(parallelism, 1, 64, "parallelism");
  return runArena(protocol, playGame, now, false, parallelism, searchEffortBaseline);
}

/** Release-evidence runner with a fixed game implementation (no callback injection). */
export async function runTrustedCc2Arena(protocol, {
  engines,
  now = () => new Date().toISOString(),
  parallelism = 1,
  searchEffortBaseline = null,
} = {}) {
  verifyRuntimeArtifacts(protocol, engines);
  const report = await runTrustedArenaWithSampler(
    protocol, engines, now, parallelism, searchEffortBaseline,
  );
  verifyRuntimeArtifacts(protocol, engines);
  return report;
}

export async function runTrustedCc2VsS2Arena(protocol, {
  engines,
  now = () => new Date().toISOString(),
  parallelism = 1,
  searchEffortBaseline = null,
} = {}) {
  verifyRuntimeArtifacts(protocol, engines);
  const report = await runTrustedArenaWithSampler(
    protocol, engines, now, parallelism, searchEffortBaseline,
  );
  verifyRuntimeArtifacts(protocol, engines);
  return report;
}

async function runTrustedArenaWithSampler(
  protocol,
  engines,
  now,
  parallelism,
  searchEffortBaseline,
) {
  integerInRange(parallelism, 1, 64, "parallelism");
  if (parallelism > 1) {
    const pool = createArenaWorkerPool(engines, parallelism);
    try {
      return await runArena(
        protocol,
        (descriptor, currentProtocol) => pool.play(descriptor, currentProtocol),
        now,
        true,
        parallelism,
        searchEffortBaseline,
        Math.min(arenaGames(protocol).length, parallelism * 2),
      );
    } finally {
      await pool.close();
    }
  }
  const sampler = createProcessMemorySampler();
  try {
    return await runArena(
      protocol,
      (descriptor, currentProtocol) => playCc2HeadlessGame(descriptor, currentProtocol, {
        engines,
        requestSuggestion: (request) => requestCc2Suggestion({
          ...request,
          samplePeakMemory: sampler.sample,
        }),
      }),
      now,
      true,
      1,
      searchEffortBaseline,
    );
  } finally {
    await sampler.close();
  }
}

function createArenaWorkerPool(engines, workerCount) {
  const phaseBuffer = createArenaPhaseBuffer(workerCount);
  const coordinator = createArenaPhaseCoordinator(phaseBuffer, workerCount);
  const slots = Array.from({ length: workerCount }, (_, workerIndex) =>
    createArenaWorkerSlot(workerIndex));
  let taskId = 0;
  let closed = false;

  return Object.freeze({
    play(descriptor, protocol) {
      if (closed) return Promise.reject(new Error("arena worker pool is closed"));
      const slot = slots[descriptor.pairIndex % slots.length];
      const run = slot.tail.then(() => dispatch(slot, descriptor, protocol));
      slot.tail = run.catch(() => {});
      return run;
    },
    async close() {
      if (closed) return;
      closed = true;
      await Promise.allSettled(slots.map((slot) => slot.tail));
      await Promise.all(slots.map(closeSlot));
      coordinator.close();
    },
  });

  function createArenaWorkerSlot(workerIndex) {
    const worker = new Worker(new URL("./cc2-headless-game-worker.mjs", import.meta.url), {
      workerData: { phaseBuffer, workerIndex, workerCount },
    });
    const slot = {
      worker,
      workerIndex,
      tail: Promise.resolve(),
      pending: new Map(),
      closeResolve: null,
      failed: null,
    };
    coordinator.attach(workerIndex, (message) => worker.postMessage(message));
    worker.on("message", (message) => {
      if (["scheduler-state", "cc2-request", "cc2-release"].includes(message?.type)) {
        coordinator.handle(workerIndex, message);
        return;
      }
      if (message?.type === "result") {
        const pending = slot.pending.get(message.taskId);
        if (pending === undefined) return;
        slot.pending.delete(message.taskId);
        if (message.ok === true) pending.resolve(message.result);
        else pending.reject(new Error(message.error ?? "arena worker failed"));
        return;
      }
      if (message?.type === "closed") slot.closeResolve?.();
    });
    worker.on("error", failSlot);
    worker.on("exit", (code) => {
      coordinator.detach(workerIndex);
      if (!closed || code !== 0) failSlot(new Error(`arena worker exited with code ${code}`));
      slot.closeResolve?.();
    });
    return slot;

    function failSlot(error) {
      slot.failed = error;
      for (const pending of slot.pending.values()) pending.reject(error);
      slot.pending.clear();
    }
  }

  function dispatch(slot, descriptor, protocol) {
    if (slot.failed !== null) return Promise.reject(slot.failed);
    taskId += 1;
    return new Promise((resolve, reject) => {
      slot.pending.set(taskId, { resolve, reject });
      slot.worker.postMessage({
        type: "play",
        taskId,
        descriptor: structuredClone(descriptor),
        protocol: structuredClone(protocol),
        engines: structuredClone(engines),
      });
    });
  }

  function closeSlot(slot) {
    if (slot.worker.threadId === -1) return Promise.resolve();
    if (slot.failed !== null) return slot.worker.terminate().then(() => {});
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        slot.worker.terminate().finally(resolve);
      }, 5_000);
      slot.closeResolve = () => {
        clearTimeout(timeout);
        resolve();
      };
      slot.worker.postMessage({ type: "close" });
    });
  }
}

export function s2ArenaImplementationSha256() {
  const entries = [
    "./arena-execution.mjs",
    "./arena-phase-scheduler.mjs",
    "./arena-proposal-cache.mjs",
    "./arena-report-schema.mjs",
    "./cc2-headless-game-worker.mjs",
    "./cc2-headless-game.mjs",
    "./headless-arena.mjs",
    "./process-memory-sampler.mjs",
    "./proposal-outcome.mjs",
    "./s2-arena-proposer.mjs",
    "./triangle/engine-frame-move-generation.mjs",
    "./transition.mjs",
    "./evaluation.mjs",
    "./ruleset-admission.mjs",
    "./arena-terminal.mjs",
    "../schema/bot-arena-report.schema.json",
    "../rulesets/tetrio-s2-v19-beta-1-5-0-observed.json",
  ].sort().map((relative) => ({ relative, path: fileURLToPath(new URL(relative, import.meta.url)) }));
  const hash = createHash("sha256");
  for (const { relative, path } of entries) hash.update(relative).update("\0").update(readFileSync(path));
  return `sha256:${hash.digest("hex")}`;
}

function verifyRuntimeArtifacts(protocol, engines) {
  for (const identity of protocol.engines) {
    const runtime = engines?.[identity.id];
    if (runtime === null || typeof runtime !== "object") {
      throw new Error(`trusted arena runtime ${identity.id} is missing`);
    }
    const actual = runtime.runtimeKind === "s2-native-js"
      ? s2ArenaImplementationSha256()
      : typeof runtime.binary === "string"
        ? `sha256:${createHash("sha256").update(readFileSync(runtime.binary)).digest("hex")}`
        : null;
    if (actual !== identity.artifactSha256) {
      throw new Error(`trusted arena runtime ${identity.id} artifact SHA-256 mismatch`);
    }
  }
}

async function runArena(
  protocol,
  playGame,
  now,
  trusted,
  parallelism = 1,
  searchEffortBaseline = null,
  dispatchConcurrency = parallelism,
) {
  assertProtocol(protocol);
  if (typeof playGame !== "function") throw new Error("playGame must be a function");
  const startedAt = now();
  const descriptors = arenaGames(protocol);
  const results = await mapArenaJobs(
    descriptors,
    dispatchConcurrency,
    (descriptor) => playGame(descriptor, protocol),
  );
  const searchEffort = evaluatePairedSearchEffort(
    protocol,
    descriptors,
    results,
    parallelism,
    searchEffortBaseline,
  );
  if (searchEffort.degradedReason !== null) {
    for (const result of results) {
      result.degraded = [...(result.degraded ?? []), searchEffort.degradedReason];
    }
  }
  const games = results.map((result, index) =>
    normalizeGameResult(descriptors[index], result, protocol.profile));
  const completedAt = now();
  const report = deepFreeze({
    $schema: BOT_ARENA_REPORT_SCHEMA,
    schemaVersion: 1,
    protocol: structuredClone(protocol),
    startedAt,
    completedAt,
    runtime: {
      gameParallelism: parallelism,
      scheduling: trusted && parallelism > 1
        ? {
            id: "persistent-seed-pair-pool-with-cc2-quiescence-barrier/1",
            workerPool: true,
            seedPairAffinity: true,
            cc2PhaseBarrier: true,
            collectionWindowMs: ARENA_CC2_COLLECTION_WINDOW_MS,
            maxConcurrentCc2: ARENA_CC2_MAX_CONCURRENCY,
            s2YieldEveryNodes: ENGINE_FRAME_SCHEDULER_YIELD_NODES,
          }
        : {
            id: "inline-or-caller-managed/1",
            workerPool: false,
            seedPairAffinity: false,
            cc2PhaseBarrier: false,
            collectionWindowMs: 0,
            maxConcurrentCc2: 1,
            s2YieldEveryNodes: 0,
          },
      searchEffort: {
        status: searchEffort.status,
        samples: searchEffort.samples,
        medianRatio: searchEffort.medianRatio,
        lowerQuartileRatio: searchEffort.lowerQuartileRatio,
      },
    },
    games,
    summary: summarizeArena(protocol, games),
  });
  if (trusted) trustedArenaReports.add(report);
  return report;
}

/** Revalidates a parsed report without trusting in-process WeakSet brands. */
export function validateArenaReport(report) {
  if (report?.$schema !== BOT_ARENA_REPORT_SCHEMA || report.schemaVersion !== 1) {
    throw new Error("invalid arena report schema identity");
  }
  nonEmptyString(report.startedAt, "report startedAt");
  nonEmptyString(report.completedAt, "report completedAt");
  if (report.runtime === null || typeof report.runtime !== "object" || Array.isArray(report.runtime) ||
      ![
        ["gameParallelism", "searchEffort"],
        ["gameParallelism", "scheduling", "searchEffort"],
      ].some((keys) => isDeepStrictEqual(Object.keys(report.runtime).sort(), keys))) {
    throw new Error("report runtime is invalid");
  }
  integerInRange(report.runtime.gameParallelism, 1, 64, "report gameParallelism");
  if (report.runtime.scheduling !== undefined) {
    normalizeSchedulingRuntime(report.runtime.scheduling, report.runtime.gameParallelism);
  }
  normalizeSearchEffortRuntime(report.runtime.searchEffort);
  const protocol = createArenaProtocol(report.protocol);
  if (!isDeepStrictEqual(protocol, report.protocol)) throw new Error("arena report protocol is not canonical");
  if (!Array.isArray(report.games)) throw new Error("arena report games must be an array");
  const expected = arenaGames(protocol);
  const games = report.games.map((game, index) => {
    if (expected[index] === undefined) throw new Error("arena report has unexpected games");
    assertDescriptorMatches(expected[index], game);
    const normalized = normalizeGameResult(expected[index], game, protocol.profile);
    if (!isDeepStrictEqual(normalized, game)) throw new Error("arena report game is not canonical");
    return normalized;
  });
  const summary = summarizeArena(protocol, games);
  if (!isDeepStrictEqual(summary, report.summary)) throw new Error("arena report summary mismatch");
  return true;
}

function evaluatePairedSearchEffort(protocol, descriptors, results, parallelism, baseline) {
  if (parallelism === 1 && baseline === null) return searchEffortResult("not-required", [], null);
  if (baseline === null) return searchEffortResult("unverified", [], "cc2-search-effort-unverified");
  validateArenaReport(baseline);
  if (!isDeepStrictEqual(baseline.protocol, protocol)) {
    throw new Error("search effort baseline protocol does not match the arena protocol");
  }
  if (baseline.runtime.gameParallelism !== 1) {
    throw new Error("search effort baseline must be a serial arena report");
  }
  const ratios = [];
  for (let index = 0; index < descriptors.length; index += 1) {
    const descriptor = descriptors[index];
    const baselineGame = baseline.games[index];
    if (baselineGame?.gameId !== descriptor.gameId) {
      throw new Error("search effort baseline game order does not match descriptors");
    }
    const current = results[index]?.moveInfo?.byEngine;
    const reference = baselineGame.moveInfo?.byEngine;
    if (current === null || typeof current !== "object" || reference === null || typeof reference !== "object") {
      return searchEffortResult("unavailable", ratios, "cc2-search-effort-unavailable");
    }
    for (const engineId of Object.keys(reference)) {
      const expectedSamples = reference[engineId]?.samples ?? [];
      if (expectedSamples.length === 0) continue;
      const actualSamples = current[engineId]?.samples ?? [];
      const expectedPositions = proposalPositions(baselineGame, engineId);
      const actualPositions = proposalPositions(results[index], engineId);
      if (actualSamples.length !== expectedSamples.length ||
          expectedPositions.length !== expectedSamples.length ||
          actualPositions.length !== actualSamples.length) {
        return searchEffortResult("unavailable", ratios, "cc2-search-effort-unavailable");
      }
      for (let sample = 0; sample < expectedSamples.length; sample += 1) {
        // Once prior time-budgeted choices diverge, later positions are no
        // longer paired observations and must not be compared as CPU effort.
        if (expectedPositions[sample] !== actualPositions[sample]) continue;
        const expected = expectedSamples[sample]?.nodes;
        const actual = actualSamples[sample]?.nodes;
        if (!Number.isSafeInteger(expected) || expected <= 0 ||
            !Number.isSafeInteger(actual) || actual <= 0) {
          return searchEffortResult("unavailable", ratios, "cc2-search-effort-unavailable");
        }
        ratios.push(actual / expected);
      }
    }
  }
  if (ratios.length === 0) {
    return searchEffortResult("unavailable", ratios, "cc2-search-effort-unavailable");
  }
  const medianRatio = quantile(ratios, 0.5);
  const lowerQuartileRatio = quantile(ratios, 0.25);
  const clearlyDegraded = medianRatio < 0.75 || lowerQuartileRatio < 0.65;
  const varianceAccepted = !clearlyDegraded && (medianRatio < 0.9 || lowerQuartileRatio < 0.9);
  return searchEffortResult(
    clearlyDegraded ? "degraded" : varianceAccepted ? "variance-accepted" : "passed",
    ratios,
    clearlyDegraded ? "cc2-search-effort-degraded" : null,
  );
}

function proposalPositions(game, engineId) {
  return (game?.executionTrace ?? []).flatMap((entry) =>
    (entry?.proposals ?? [])
      .filter((proposal) => proposal.engineId === engineId)
      .map((proposal) => proposal.positionFingerprint));
}

function searchEffortResult(status, ratios, degradedReason) {
  return {
    status,
    samples: ratios.length,
    medianRatio: ratios.length === 0 ? null : quantile(ratios, 0.5),
    lowerQuartileRatio: ratios.length === 0 ? null : quantile(ratios, 0.25),
    degradedReason,
  };
}

function normalizeSearchEffortRuntime(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !isDeepStrictEqual(Object.keys(value).sort(), ["lowerQuartileRatio", "medianRatio", "samples", "status"])) {
    throw new Error("report search effort runtime is invalid");
  }
  if (!["not-required", "unverified", "unavailable", "variance-accepted", "degraded", "passed"].includes(value.status)) {
    throw new Error("report search effort status is invalid");
  }
  integerInRange(value.samples, 0, Number.MAX_SAFE_INTEGER, "report search effort samples");
  for (const field of ["medianRatio", "lowerQuartileRatio"]) {
    if (value[field] !== null && (!Number.isFinite(value[field]) || value[field] < 0)) {
      throw new Error(`report search effort ${field} is invalid`);
    }
  }
  return value;
}

function normalizeSchedulingRuntime(value, parallelism) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      !isDeepStrictEqual(Object.keys(value).sort(), [
        "cc2PhaseBarrier", "collectionWindowMs", "id", "maxConcurrentCc2",
        "s2YieldEveryNodes", "seedPairAffinity", "workerPool",
      ])) {
    throw new Error("report scheduling runtime is invalid");
  }
  nonEmptyString(value.id, "report scheduling id");
  for (const key of ["workerPool", "seedPairAffinity", "cc2PhaseBarrier"]) {
    if (typeof value[key] !== "boolean") throw new Error(`report scheduling ${key} is invalid`);
  }
  integerInRange(value.collectionWindowMs, 0, 60_000, "report scheduling collectionWindowMs");
  integerInRange(value.maxConcurrentCc2, 1, 64, "report scheduling maxConcurrentCc2");
  integerInRange(value.s2YieldEveryNodes, 0, Number.MAX_SAFE_INTEGER, "report scheduling s2YieldEveryNodes");
  if (value.workerPool !== (parallelism > 1 && value.id !== "inline-or-caller-managed/1")) {
    throw new Error("report scheduling worker pool does not match parallelism");
  }
}

function quantile(values, probability) {
  const sorted = [...values].sort((left, right) => left - right);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

export function summarizeArena(protocol, games) {
  assertProtocol(protocol);
  if (!Array.isArray(games)) throw new Error("games must be an array");
  if (games.length !== protocol.seeds.length * 2) {
    throw new Error("arena summary requires exactly two completed games per seed");
  }
  const expected = arenaGames(protocol);
  for (let index = 0; index < games.length; index += 1) {
    const game = games[index];
    if (!normalizedGames.has(game)) throw new Error("arena summary accepts only normalized game records");
    assertDescriptorMatches(expected[index], game);
    if (index % 2 === 1 && games[index - 1].initialStateFingerprints.left !== game.initialStateFingerprints.left) {
      throw new Error("swapped games must share the same initial canonical state");
    }
    if (index % 2 === 1 && !isDeepStrictEqual(games[index - 1].queueStreamSha256, game.queueStreamSha256)) {
      throw new Error("swapped games must share the same queue streams");
    }
  }
  const referenceId = protocol.engines[0].id;
  const challengerId = protocol.engines[1].id;
  let wins = 0;
  let losses = 0;
  let draws = 0;
  let maxTurnDraws = 0;
  let abnormalGames = 0;
  let disqualifyingDegradedGames = 0;
  for (const game of games) {
    if (game.winnerEngineId === challengerId) wins += 1;
    else if (game.winnerEngineId === referenceId) losses += 1;
    else draws += 1;
    if (game.winnerEngineId === null && game.reason === "max-turns") maxTurnDraws += 1;
    if (["engine-error", "unsupported"].includes(game.reason)) abnormalGames += 1;
    // Strength evidence is fail-closed: every degradation is disqualifying
    // until the protocol explicitly models and tests it as non-strength-affecting.
    if (game.degraded.length > 0) {
      disqualifyingDegradedGames += 1;
    }
  }
  const decisive = wins + losses;
  const interval = wilsonInterval(wins, decisive);
  const gamesPlayed = games.length;
  const pointEstimate = decisive === 0 ? null : wins / decisive;
  const maxTurnDrawRate = gamesPlayed === 0 ? null : maxTurnDraws / gamesPlayed;
  const referenceProfile = isReferenceProfile(protocol) &&
    protocol.engines[0].sourceCommit === CHOUHY_REFERENCE_COMMIT;
  const developmentGate = protocol.seedPartition === "development" &&
    protocol.seeds.length >= 500 && pointEstimate !== null && pointEstimate >= 0.55 &&
    interval.lower > 0.5 && maxTurnDrawRate <= 0.1 && abnormalGames === 0 &&
    referenceProfile && disqualifyingDegradedGames === 0;
  const holdoutGate = protocol.seedPartition === "holdout" &&
    protocol.seeds.length >= 100 && wins > losses && maxTurnDrawRate <= 0.1 &&
    abnormalGames === 0 && referenceProfile && disqualifyingDegradedGames === 0;
  return {
    referenceEngineId: referenceId,
    challengerEngineId: challengerId,
    seedPairs: protocol.seeds.length,
    gamesPlayed,
    wins,
    losses,
    draws,
    maxTurnDraws,
    abnormalGames,
    disqualifyingDegradedGames,
    unverifiedSerialGames: 0,
    decisiveGames: decisive,
    pointEstimate,
    wilson95: interval,
    maxTurnDrawRate,
    gate: {
      partitionQualified: developmentGate || holdoutGate,
      releaseEligible: false,
      kind: protocol.seedPartition,
      reason: developmentGate || holdoutGate ? "passed" : "requirements-not-met",
    },
  };
}

export function evaluateArenaReleaseGate(developmentReport, holdoutReport) {
  if (!trustedArenaReports.has(developmentReport) || !trustedArenaReports.has(holdoutReport)) {
    throw new Error("release gate accepts only reports executed by the trusted arena runner");
  }
  const developmentSummary = developmentReport.summary;
  const holdoutSummary = holdoutReport.summary;
  if (developmentSummary.gate.kind !== "development") {
    throw new Error("release gate requires a development arena summary");
  }
  if (holdoutSummary?.gate?.kind !== "holdout") {
    throw new Error("release gate requires a holdout arena summary");
  }
  if (canonicalIdentity(developmentReport.protocol) !== canonicalIdentity(holdoutReport.protocol)) {
    throw new Error("development and holdout arena identities must match");
  }
  const developmentSeeds = new Set(developmentReport.protocol.seeds);
  if (holdoutReport.protocol.seeds.some((seed) => developmentSeeds.has(seed))) {
    throw new Error("development and holdout seeds must be disjoint");
  }
  const passed = developmentSummary.gate.partitionQualified && holdoutSummary.gate.partitionQualified;
  return Object.freeze({
    eligible: passed,
    reason: passed ? "passed" : "development-or-holdout-requirements-not-met",
    development: structuredClone(developmentSummary.gate),
    holdout: structuredClone(holdoutSummary.gate),
  });
}

export function wilsonInterval(successes, trials, z = 1.959963984540054) {
  integerInRange(successes, 0, Number.MAX_SAFE_INTEGER, "successes");
  integerInRange(trials, 0, Number.MAX_SAFE_INTEGER, "trials");
  if (successes > trials) throw new Error("successes cannot exceed trials");
  if (trials === 0) return { lower: null, upper: null };
  const p = successes / trials;
  const z2 = z * z;
  const denominator = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denominator;
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * trials)) / trials) / denominator;
  return { lower: center - margin, upper: center + margin };
}

function gameDescriptor(protocol, seed, pairIndex, swapIndex) {
  const ordered = swapIndex === 0 ? protocol.engines : [...protocol.engines].reverse();
  return Object.freeze({
    gameId: `${protocol.seedPartition}-${pairIndex + 1}-${swapIndex === 0 ? "a" : "b"}`,
    pairIndex,
    swapIndex,
    seed,
    sides: Object.freeze([
      Object.freeze({ side: "left", engineId: ordered[0].id }),
      Object.freeze({ side: "right", engineId: ordered[1].id }),
    ]),
    execution: protocol.profile.execution,
  });
}

function normalizeGameResult(descriptor, result, profile) {
  if (result === null || typeof result !== "object") throw new Error(`game ${descriptor.gameId} returned no result`);
  if (!["top-out", "max-turns", "engine-error", "unsupported"].includes(result.reason)) {
    throw new Error(`game ${descriptor.gameId} returned unsupported reason`);
  }
  const engineIds = descriptor.sides.map((side) => side.engineId);
  if (result.winnerEngineId !== null && !engineIds.includes(result.winnerEngineId)) {
    throw new Error(`game ${descriptor.gameId} winner is not a participant`);
  }
  if (result.reason !== "top-out" && result.winnerEngineId !== null) {
    throw new Error(`game ${descriptor.gameId} cannot have a winner for ${result.reason}`);
  }
  const initialStateFingerprints = result.initialStateFingerprints;
  if (initialStateFingerprints === null || typeof initialStateFingerprints !== "object") {
    throw new Error(`game ${descriptor.gameId} initial state fingerprints are missing`);
  }
  for (const side of ["left", "right"]) stateFingerprint(initialStateFingerprints[side], `${side} initial state fingerprint`);
  if (initialStateFingerprints.left !== initialStateFingerprints.right) {
    throw new Error(`game ${descriptor.gameId} sides must start from the same canonical state`);
  }
  const queueStreamSha256 = result.queueStreamSha256;
  if (queueStreamSha256 === null || typeof queueStreamSha256 !== "object" || Array.isArray(queueStreamSha256)) {
    throw new Error(`game ${descriptor.gameId} queue stream hashes are missing`);
  }
  for (const side of ["left", "right"]) sha256(queueStreamSha256[side], `${side} queue stream SHA-256`);
  if (queueStreamSha256.left !== queueStreamSha256.right) {
    throw new Error(`game ${descriptor.gameId} sides must use the same generated queue source`);
  }
  const queueObservationSha256 = result.queueObservationSha256;
  if (queueObservationSha256 === null || typeof queueObservationSha256 !== "object" ||
      Array.isArray(queueObservationSha256)) {
    throw new Error(`game ${descriptor.gameId} queue observation hashes are missing`);
  }
  for (const side of ["left", "right"]) {
    sha256(queueObservationSha256[side], `${side} queue observation SHA-256`);
  }
  const turns = integerInRange(result.turns, 0, Number.MAX_SAFE_INTEGER, "game turns");
  if (turns > profile.maxLocksPerSide) throw new Error(`game ${descriptor.gameId} exceeds its lock limit`);
  if (result.reason === "max-turns" && turns !== profile.maxLocksPerSide) {
    throw new Error(`game ${descriptor.gameId} max-turn result does not match its lock limit`);
  }
  const peakMemoryBytes = result.peakMemoryBytes ?? null;
  if (peakMemoryBytes !== null) integerInRange(peakMemoryBytes, 0, Number.MAX_SAFE_INTEGER, "peakMemoryBytes");
  if (result.degraded !== undefined && !Array.isArray(result.degraded)) {
    throw new Error(`game ${descriptor.gameId} degraded reasons must be an array`);
  }
  const stats = normalizeGameStats(descriptor, result.stats, turns);
  const latency = normalizeGameLatency(descriptor, result.latency, turns, result.reason);
  const moveInfo = normalizeMoveInfo(descriptor, result.moveInfo);
  const degraded = [...new Set(result.degraded ?? [])];
  if (!degraded.every((reason) => typeof reason === "string" && reason.length > 0)) {
    throw new Error(`game ${descriptor.gameId} degraded reasons must be non-empty strings`);
  }
  if (latency === null) degraded.push("latency-unavailable");
  if (peakMemoryBytes === null) degraded.push("peak-memory-unavailable");
  const executionTrace = normalizeExecutionTrace(
    descriptor,
    result.executionTrace,
    turns,
    profile,
    initialStateFingerprints,
  );
  const lockCadenceMismatch = profile.movementModel === "engine-frame-single-held-controller/4" &&
    executionTrace.some((entry) => entry.proposals.some((proposal) =>
      proposal.lockedAtFrame + 1 !== entry.logicalFrame
    ));
  if (lockCadenceMismatch) degraded.push("lock-cadence-not-exact");
  const proposalResult = result.proposalResult === undefined
    ? null
    : normalizeHeadlessProposalResult(descriptor, result.proposalResult, turns, result.reason);
  if (proposalResult?.status === "ok") {
    throw new Error(`game ${descriptor.gameId} cannot end with an ok proposal result`);
  }
  if (proposalResult !== null && !["engine-error", "unsupported"].includes(result.reason)) {
    throw new Error(`game ${descriptor.gameId} proposal result requires an abnormal reason`);
  }
  const game = Object.freeze({
    ...structuredClone(descriptor),
    winnerEngineId: result.winnerEngineId,
    reason: result.reason,
    turns,
    executionEvidence: "serial-due-turn-trace-verified",
    executionTrace,
    initialStateFingerprints: structuredClone(initialStateFingerprints),
    queueStreamSha256: structuredClone(queueStreamSha256),
    queueObservationSha256: structuredClone(queueObservationSha256),
    stats,
    latency,
    moveInfo,
    peakMemoryBytes,
    ...(proposalResult === null ? {} : { proposalResult }),
    degraded: Object.freeze([...new Set(degraded)]),
  });
  normalizedGames.add(game);
  return game;
}

function normalizeHeadlessProposalResult(descriptor, value, turns, reason) {
  const proposalResult = structuredClone(assertProposalResult(value));
  const code = proposalResult.status === "terminal"
    ? proposalResult.terminal.code
    : proposalResult.failure.code;
  if (code === "post-lock-continuation-unsupported") {
    if (proposalResult.status !== "failure" || reason !== "unsupported") {
      throw new Error(`game ${descriptor.gameId} continuation failure outcome is invalid`);
    }
    if (proposalResult.diagnostics.lockNumber !== turns ||
        !Array.isArray(proposalResult.diagnostics.unsupported) ||
        proposalResult.diagnostics.unsupported.length === 0) {
      throw new Error(`game ${descriptor.gameId} continuation failure provenance is invalid`);
    }
    for (const entry of proposalResult.diagnostics.unsupported) {
      assertProposalActor(descriptor, entry, `game ${descriptor.gameId} continuation failure`);
      if (typeof entry.reason !== "string" || entry.reason.length === 0) {
        throw new Error(`game ${descriptor.gameId} continuation failure reason is invalid`);
      }
    }
    return proposalResult;
  }
  if (code === "unsupported-placement") {
    if (proposalResult.status !== "failure" || reason !== "unsupported" ||
        !Array.isArray(proposalResult.diagnostics.reasons) ||
        proposalResult.diagnostics.reasons.length === 0 ||
        !proposalResult.diagnostics.reasons.every((entry) => typeof entry === "string" && entry.length > 0) ||
        proposalResult.failure.message !== proposalResult.diagnostics.reasons.join("; ")) {
      throw new Error(`game ${descriptor.gameId} unsupported placement provenance is invalid`);
    }
    assertProposalActor(descriptor, proposalResult.diagnostics, `game ${descriptor.gameId} proposal result`);
    if (proposalResult.diagnostics.lockNumber !== turns + 1) {
      throw new Error(`game ${descriptor.gameId} proposal result lock number is invalid`);
    }
    return proposalResult;
  }
  if (![
    "no-legal-move",
    "suggestion-timeout",
    "proposal-error",
    "no-legal-move-before-first-lock",
    "no-legal-move-below-latency-floor",
  ].includes(code)) {
    throw new Error(`game ${descriptor.gameId} proposal result code is unsupported`);
  }
  if (reason !== "engine-error") {
    throw new Error(`game ${descriptor.gameId} caught proposal outcome is invalid`);
  }
  assertProposalActor(descriptor, proposalResult.diagnostics, `game ${descriptor.gameId} proposal result`);
  if (proposalResult.diagnostics.lockNumber !== turns + 1) {
    throw new Error(`game ${descriptor.gameId} proposal result lock number is invalid`);
  }
  const rawMessage = proposalResult.diagnostics.message;
  if (typeof rawMessage !== "string" ||
      (proposalResult.status === "failure" && proposalResult.failure.message !== rawMessage)) {
    throw new Error(`game ${descriptor.gameId} proposal result raw message is invalid`);
  }
  const reclassified = classifyProposalError({
    error: new Error(rawMessage),
    locksPlayed: turns,
    latencyMs: proposalResult.latencyMs,
  });
  const reclassifiedCode = reclassified.status === "terminal"
    ? reclassified.terminal.code
    : reclassified.failure.code;
  if (proposalResult.status !== reclassified.status || code !== reclassifiedCode) {
    throw new Error(`game ${descriptor.gameId} proposal result contradicts its raw evidence`);
  }
  return proposalResult;
}

function assertProposalActor(descriptor, diagnostics, label) {
  if (diagnostics === null || typeof diagnostics !== "object" || Array.isArray(diagnostics)) {
    throw new Error(`${label} actor is invalid`);
  }
  const actorSide = diagnostics.side ?? diagnostics.botId;
  if (diagnostics.side !== undefined && diagnostics.botId !== undefined &&
      diagnostics.side !== diagnostics.botId) {
    throw new Error(`${label} side and botId disagree`);
  }
  const side = descriptor.sides.find((candidate) => candidate.side === actorSide);
  if (side === undefined || side.engineId !== diagnostics.engineId) {
    throw new Error(`${label} actor does not match the game descriptor`);
  }
}

function normalizeMoveInfo(descriptor, moveInfo) {
  const expected = descriptor.sides.map(({ engineId }) => engineId).sort();
  if (moveInfo === undefined) {
    return {
      byEngine: Object.fromEntries(descriptor.sides.map(({ side, engineId }) => [
        engineId,
        { side, samples: [] },
      ])),
    };
  }
  if (moveInfo === null || typeof moveInfo !== "object" || Array.isArray(moveInfo) ||
      moveInfo.byEngine === null || typeof moveInfo.byEngine !== "object" || Array.isArray(moveInfo.byEngine) ||
      !isDeepStrictEqual(Object.keys(moveInfo.byEngine).sort(), expected)) {
    throw new Error(`game ${descriptor.gameId} moveInfo must identify both engines exactly`);
  }
  return {
    byEngine: Object.fromEntries(descriptor.sides.map(({ side, engineId }) => {
      const entry = moveInfo.byEngine[engineId];
      if (entry === null || typeof entry !== "object" || Array.isArray(entry) ||
          entry.side !== side || !Array.isArray(entry.samples)) {
        throw new Error(`game ${descriptor.gameId} moveInfo is invalid for ${engineId}`);
      }
      const samples = entry.samples.map((sample) => {
        if (sample === null || typeof sample !== "object" || Array.isArray(sample)) {
          throw new Error(`game ${descriptor.gameId} moveInfo sample is invalid for ${engineId}`);
        }
        integerInRange(sample.nodes, 1, Number.MAX_SAFE_INTEGER, `${engineId} moveInfo nodes`);
        if (!Number.isFinite(sample.nps) || sample.nps <= 0) {
          throw new Error(`game ${descriptor.gameId} moveInfo nps is invalid for ${engineId}`);
        }
        return { nodes: sample.nodes, nps: sample.nps };
      });
      return [engineId, { side, samples }];
    })),
  };
}

function normalizeGameStats(descriptor, stats, turns) {
  if (stats === null || typeof stats !== "object" || Array.isArray(stats)) {
    throw new Error(`game ${descriptor.gameId} stats must be an object`);
  }
  const expected = descriptor.sides.map(({ engineId }) => engineId).sort();
  if (!isDeepStrictEqual(Object.keys(stats).sort(), expected)) {
    throw new Error(`game ${descriptor.gameId} stats must identify both engines exactly`);
  }
  return Object.fromEntries(descriptor.sides.map(({ side, engineId }) => {
    const value = stats[engineId];
    if (value === null || typeof value !== "object" || Array.isArray(value) || value.side !== side) {
      throw new Error(`game ${descriptor.gameId} stats side is invalid for ${engineId}`);
    }
    for (const field of ["turns", "attack", "garbageCancelled", "garbageCleared", "garbageSent", "garbageReceived"]) {
      integerInRange(value[field], 0, Number.MAX_SAFE_INTEGER, `${engineId} stats ${field}`);
    }
    if (value.turns !== turns) throw new Error(`game ${descriptor.gameId} stats turns do not match the game`);
    if (value.metrics === null || typeof value.metrics !== "object" || Array.isArray(value.metrics)) {
      throw new Error(`game ${descriptor.gameId} metrics are missing for ${engineId}`);
    }
    for (const field of ["apm", "pps", "vs"]) {
      if (!Number.isFinite(value.metrics[field]) || value.metrics[field] < 0) {
        throw new Error(`game ${descriptor.gameId} ${engineId} metric ${field} is invalid`);
      }
    }
    return [engineId, structuredClone(value)];
  }));
}

function normalizeGameLatency(descriptor, latency, turns, reason) {
  if (latency === undefined || latency === null) return null;
  if (typeof latency !== "object" || Array.isArray(latency) ||
      latency.unit !== "milliseconds-request-to-suggestion" ||
      latency.byEngine === null || typeof latency.byEngine !== "object" || Array.isArray(latency.byEngine)) {
    throw new Error(`game ${descriptor.gameId} latency is invalid`);
  }
  const expected = descriptor.sides.map(({ engineId }) => engineId).sort();
  if (!isDeepStrictEqual(Object.keys(latency.byEngine).sort(), expected)) {
    throw new Error(`game ${descriptor.gameId} latency must identify both engines exactly`);
  }
  const byEngine = Object.fromEntries(descriptor.sides.map(({ side, engineId }) => {
    const value = latency.byEngine[engineId];
    if (value === null || typeof value !== "object" || Array.isArray(value) || value.side !== side ||
        !Array.isArray(value.samples) || !value.samples.every((sample) => Number.isFinite(sample) && sample >= 0)) {
      throw new Error(`game ${descriptor.gameId} latency samples are invalid for ${engineId}`);
    }
    const maximumSamples = ["engine-error", "unsupported"].includes(reason) ? turns + 1 : turns;
    if (value.samples.length < turns || value.samples.length > maximumSamples) {
      throw new Error(`game ${descriptor.gameId} latency sample count is invalid for ${engineId}`);
    }
    const expectedMax = value.samples.length === 0 ? null : Math.max(...value.samples);
    const expectedMean = value.samples.length === 0
      ? null
      : value.samples.reduce((sum, sample) => sum + sample, 0) / value.samples.length;
    if (!sameNumber(value.max, expectedMax) || !sameNumber(value.mean, expectedMean)) {
      throw new Error(`game ${descriptor.gameId} latency aggregates are invalid for ${engineId}`);
    }
    return [engineId, { side, samples: [...value.samples], max: value.max, mean: value.mean }];
  }));
  return { unit: latency.unit, byEngine };
}

function sameNumber(actual, expected) {
  if (actual === null || expected === null) return actual === expected;
  return Number.isFinite(actual) && Math.abs(actual - expected) <= Number.EPSILON * Math.max(1, Math.abs(expected)) * 4;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function normalizeExecutionTrace(descriptor, trace, turns, profile, initialStateFingerprints) {
  if (!Array.isArray(trace) || trace.length !== turns) {
    throw new Error(`game ${descriptor.gameId} requires one serial trace entry per turn`);
  }
  const expectedOrder = descriptor.sides.map((side) => side.engineId);
  let previousFrame = -1;
  return trace.map((entry, turnIndex) => {
    const expectedFrame = Math.round((turnIndex + 1) * 60 / profile.pps);
    if (!Number.isSafeInteger(entry?.logicalFrame) || entry.logicalFrame <= previousFrame) {
      throw new Error(`game ${descriptor.gameId} execution trace frames must increase`);
    }
    if (entry.logicalFrame !== expectedFrame) {
      throw new Error(`game ${descriptor.gameId} execution trace does not match its PPS cadence`);
    }
    if (JSON.stringify(entry.orderedEngineIds) !== JSON.stringify(expectedOrder)) {
      throw new Error(`game ${descriptor.gameId} execution trace is not stable side order`);
    }
    if (!Array.isArray(entry.proposals) || entry.proposals.length !== expectedOrder.length) {
      throw new Error(`game ${descriptor.gameId} execution trace requires one proposal per side`);
    }
    const proposals = entry.proposals.map((proposal, index) => {
      if (proposal?.engineId !== expectedOrder[index]) {
        throw new Error(`game ${descriptor.gameId} proposal order does not match its side order`);
      }
      stateFingerprint(proposal.positionFingerprint, "proposal position fingerprint");
      nonEmptyString(proposal.witnessKind, "proposal witnessKind");
      if (proposal.witnessKind !== profile.movementModel) {
        throw new Error(`game ${descriptor.gameId} proposal witness does not match its movement model`);
      }
      if (profile.movementModel === "engine-frame-single-held-controller/4" &&
          proposal.witnessSelectionPolicy !== ARENA_WITNESS_SELECTION_POLICY) {
        throw new Error(`game ${descriptor.gameId} proposal witness selection policy is invalid`);
      }
      const moveSelectionPolicy = proposal.moveSelectionPolicy ?? null;
      if (moveSelectionPolicy !== null &&
          moveSelectionPolicy !== "highest-evaluation-then-canonical-placement/1") {
        throw new Error(`game ${descriptor.gameId} proposal move selection policy is invalid`);
      }
      if (turnIndex === 0 && proposal.positionFingerprint !== initialStateFingerprints[descriptor.sides[index].side]) {
        throw new Error(`game ${descriptor.gameId} first proposal does not match its initial state`);
      }
      if (proposal.lockedAtFrame !== null &&
          (!Number.isSafeInteger(proposal.lockedAtFrame) || proposal.lockedAtFrame < 0)) {
        throw new Error(`game ${descriptor.gameId} proposal lockedAtFrame is invalid`);
      }
      if (proposal.continuationIdentity !== null) sha256(proposal.continuationIdentity, "proposal continuationIdentity");
      if (proposal.continuationStateFingerprint !== null) {
        stateFingerprint(proposal.continuationStateFingerprint, "proposal continuation state fingerprint");
      }
      if (profile.movementModel === "engine-frame-single-held-controller/4" &&
          (proposal.lockedAtFrame === null || proposal.continuationIdentity === null ||
            proposal.continuationStateFingerprint === null)) {
        throw new Error(`game ${descriptor.gameId} engine-frame proposal requires lock and continuation evidence`);
      }
      const placementWitness = normalizePlacementWitness(
        descriptor,
        proposal.placementWitness,
        profile.movementModel,
        proposal.lockedAtFrame,
      );
      stateFingerprint(proposal.transitionStateFingerprint, "proposal transition state fingerprint");
      const lockResult = normalizeTraceLockResult(descriptor, proposal.lockResult);
      const postAdvanceStateFingerprint = proposal.postAdvanceStateFingerprint ?? null;
      if (postAdvanceStateFingerprint !== null) {
        stateFingerprint(postAdvanceStateFingerprint, "proposal post-advance state fingerprint");
      }
      const syncStatus = proposal.syncStatus ?? null;
      if (syncStatus !== null && !["ready", "top-out", "unsupported"].includes(syncStatus)) {
        throw new Error(`game ${descriptor.gameId} proposal syncStatus is invalid`);
      }
      const syncReason = proposal.syncReason ?? null;
      if (syncReason !== null) nonEmptyString(syncReason, "proposal syncReason");
      const syncedStateFingerprint = proposal.syncedStateFingerprint ?? null;
      if (syncedStateFingerprint !== null) {
        stateFingerprint(syncedStateFingerprint, "proposal synced state fingerprint");
      }
      const syncedContinuationIdentity = proposal.syncedContinuationIdentity ?? null;
      if (syncedContinuationIdentity !== null) {
        sha256(syncedContinuationIdentity, "proposal synced continuation identity");
      }
      if (profile.movementModel === "engine-frame-single-held-controller/4" &&
          (postAdvanceStateFingerprint === null || syncStatus === null)) {
        throw new Error(`game ${descriptor.gameId} engine-frame proposal requires post-advance sync evidence`);
      }
      if (syncStatus === "ready" &&
          (syncedStateFingerprint === null || syncedContinuationIdentity === null || syncReason !== null)) {
        throw new Error(`game ${descriptor.gameId} ready proposal sync evidence is incomplete`);
      }
      if (["top-out", "unsupported"].includes(syncStatus) && syncReason === null) {
        throw new Error(`game ${descriptor.gameId} failed proposal sync requires a reason`);
      }
      return Object.freeze({
        engineId: proposal.engineId,
        positionFingerprint: proposal.positionFingerprint,
        witnessKind: proposal.witnessKind,
        witnessSelectionPolicy: proposal.witnessSelectionPolicy ?? null,
        moveSelectionPolicy,
        lockedAtFrame: proposal.lockedAtFrame,
        continuationIdentity: proposal.continuationIdentity,
        continuationStateFingerprint: proposal.continuationStateFingerprint,
        placementWitness,
        transitionStateFingerprint: proposal.transitionStateFingerprint,
        lockResult,
        postAdvanceStateFingerprint,
        syncStatus,
        syncReason,
        syncedStateFingerprint,
        syncedContinuationIdentity,
      });
    });
    previousFrame = entry.logicalFrame;
    return Object.freeze({
      logicalFrame: entry.logicalFrame,
      orderedEngineIds: Object.freeze([...entry.orderedEngineIds]),
      proposals: Object.freeze(proposals),
    });
  });
}

function normalizePlacementWitness(descriptor, witness, movementModelId, lockedAtFrame) {
  if (witness === null || typeof witness !== "object" || Array.isArray(witness)) {
    throw new Error(`game ${descriptor.gameId} placement witness is missing`);
  }
  if (!"IJLOSTZ".includes(witness.piece) || witness.piece.length !== 1 ||
      !["spawn", "right", "reverse", "left"].includes(witness.rotation) ||
      !Number.isSafeInteger(witness.x) || !Number.isSafeInteger(witness.y) ||
      typeof witness.usedHold !== "boolean") {
    throw new Error(`game ${descriptor.gameId} placement witness is invalid`);
  }
  const rotation = witness.rotationEvidence;
  if (rotation === null || typeof rotation !== "object" ||
      typeof rotation.lastInputWasRotation !== "boolean") {
    throw new Error(`game ${descriptor.gameId} rotation witness is invalid`);
  }
  if (movementModelId === "final-placement-only/2") {
    return Object.freeze({
      piece: witness.piece,
      rotation: witness.rotation,
      x: witness.x,
      y: witness.y,
      usedHold: witness.usedHold,
      rotationEvidence: structuredClone(rotation),
    });
  }
  const movement = witness.movementEvidence;
  if (movement === null || typeof movement !== "object" ||
      movement.controller !== movementModelId ||
      !Number.isSafeInteger(movement.startedAtFrame) || movement.startedAtFrame < 0 ||
      movement.lockedAtFrame !== lockedAtFrame || movement.startedAtFrame > movement.lockedAtFrame ||
      movement.lockedAt?.frame !== lockedAtFrame ||
      !Number.isFinite(movement.lockedAt?.subframe) || movement.lockedAt.subframe < 0 ||
      movement.lockedAt.subframe >= 1 || !Array.isArray(movement.inputs) ||
      !movement.inputs.every((input) => typeof input === "string" && input.length > 0) ||
      movement.inputs.at(-1) !== "hardDrop") {
    throw new Error(`game ${descriptor.gameId} movement witness is invalid`);
  }
  return Object.freeze({
    piece: witness.piece,
    rotation: witness.rotation,
    x: witness.x,
    y: witness.y,
    usedHold: witness.usedHold,
    rotationEvidence: structuredClone(rotation),
    movementEvidence: structuredClone(movement),
  });
}

function normalizeTraceLockResult(descriptor, lockResult) {
  if (lockResult === null || typeof lockResult !== "object" || Array.isArray(lockResult) ||
      !Number.isSafeInteger(lockResult.lines) || lockResult.lines < 0 || lockResult.lines > 4 ||
      !["none", "mini", "normal"].includes(lockResult.spin) ||
      typeof lockResult.perfectClear !== "boolean" || !Array.isArray(lockResult.clearedRows) ||
      lockResult.clearedRows.length !== lockResult.lines ||
      !lockResult.clearedRows.every((row) => Number.isSafeInteger(row) && row >= 0 && row < 40)) {
    throw new Error(`game ${descriptor.gameId} trace lock result is invalid`);
  }
  return Object.freeze({
    clearedRows: Object.freeze([...lockResult.clearedRows]),
    lines: lockResult.lines,
    spin: lockResult.spin,
    perfectClear: lockResult.perfectClear,
  });
}

function normalizeEngine(engine) {
  if (engine === null || typeof engine !== "object") throw new Error("arena engine identity is missing");
  for (const key of ["id", "sourceCommit", "artifactSha256", "configSha256"]) nonEmptyString(engine[key], `engine ${key}`);
  if (!/^[0-9a-f]{40}$/.test(engine.sourceCommit)) throw new Error("engine sourceCommit must be a full Git commit");
  sha256(engine.artifactSha256, "artifactSha256");
  sha256(engine.configSha256, "configSha256");
  return Object.freeze({
    id: engine.id,
    sourceCommit: engine.sourceCommit,
    artifactSha256: engine.artifactSha256,
    configSha256: engine.configSha256,
  });
}

function normalizeEvaluator(evaluator) {
  if (evaluator === null || typeof evaluator !== "object") throw new Error("arena evaluator identity is missing");
  for (const key of ["id", "schemaSha256", "weightsSha256"]) nonEmptyString(evaluator[key], `evaluator ${key}`);
  sha256(evaluator.schemaSha256, "evaluator schemaSha256");
  sha256(evaluator.weightsSha256, "evaluator weightsSha256");
  return structuredClone(evaluator);
}

function assertProtocol(protocol) {
  if (!createdProtocols.has(protocol)) throw new Error("arena protocol must be created by createArenaProtocol");
}

function assertDescriptorMatches(expected, actual) {
  if (expected.gameId !== actual.gameId || expected.seed !== actual.seed ||
      expected.pairIndex !== actual.pairIndex || expected.swapIndex !== actual.swapIndex ||
      JSON.stringify(expected.sides) !== JSON.stringify(actual.sides)) {
    throw new Error("arena game record does not match its expected seed-pair descriptor");
  }
}

function isReferenceProfile(protocol) {
  return protocol.profile.pps === REFERENCE_ARENA_PROFILE.pps &&
    protocol.profile.thinkMs === REFERENCE_ARENA_PROFILE.thinkMs &&
    protocol.profile.knownQueue === REFERENCE_ARENA_PROFILE.knownQueue &&
    protocol.profile.maxLocksPerSide === REFERENCE_ARENA_PROFILE.maxLocksPerSide &&
    protocol.profile.movementModel === REFERENCE_ARENA_PROFILE.movementModel;
}

function movementModel(value) {
  if (!["engine-frame-single-held-controller/4", "final-placement-only/2"].includes(value)) {
    throw new Error("movementModel must be engine-frame-single-held-controller/4 or final-placement-only/2");
  }
  return value;
}

function canonicalIdentity(protocol) {
  return canonicalize({
    engines: protocol.engines,
    rulesetId: protocol.rulesetId,
    evaluator: protocol.evaluator,
    profile: protocol.profile,
  });
}

function sha256(value, label) {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a SHA-256 identity`);
}

function stateFingerprint(value, label) {
  if (!/^s2-full-state\/1:sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${label} must be a canonical state fingerprint`);
  }
}

function nonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
}

function uint32(value, label) {
  return integerInRange(value, 0, 0xffff_ffff, label);
}

function integerInRange(value, minimum, maximum, label) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function numberInRange(value, minimum, maximum, label) {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be a number from ${minimum} to ${maximum}`);
  }
  return value;
}
