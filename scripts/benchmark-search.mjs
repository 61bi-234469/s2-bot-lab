import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { cpus, freemem, platform, release, totalmem } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

import { analyzeDepthOne, analyzeIterativeDeepening } from "../src-js/search.mjs";
import { canonicalize } from "./cs1.mjs";

const DEFAULT_CORPUS = "fixtures/benchmark/search-v1.json";

export function loadSearchBenchmarkCorpus(path = DEFAULT_CORPUS) {
  const corpus = JSON.parse(readFileSync(path, "utf8"));
  if (corpus.$schema !== "s2-analysis-engine/benchmark/search-corpus/1") {
    throw new Error(`unsupported benchmark corpus schema ${corpus.$schema}`);
  }
  const { hash, ...body } = corpus;
  const actual = `sha256:${createHash("sha256").update(canonicalize(body)).digest("hex")}`;
  if (hash !== actual) throw new Error(`benchmark corpus hash mismatch: expected ${hash}, got ${actual}`);
  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    throw new Error("benchmark corpus must contain cases");
  }
  return corpus;
}

export function runSearchBenchmark({
  corpusPath = DEFAULT_CORPUS,
  iterations = 5,
  warmupIterations = 1,
  caseIds = null,
  clock = performance,
  includeEnvironment = false,
} = {}) {
  assertRunOptions(iterations, warmupIterations, clock, includeEnvironment);
  const corpus = loadSearchBenchmarkCorpus(corpusPath);
  const selected = caseIds === null
    ? corpus.cases
    : corpus.cases.filter((testCase) => caseIds.includes(testCase.id));
  if (selected.length === 0) throw new Error("benchmark selection contains no cases");

  const cases = selected.map((testCase) =>
    benchmarkCase(testCase, { iterations, warmupIterations, clock }),
  );
  return {
    $schema: "s2-analysis-engine/schema/search-benchmark-report/1",
    schemaVersion: 1,
    protocol: {
      id: "s2-search-benchmark/1",
      corpusId: corpus.id,
      corpusHash: corpus.hash,
      iterations,
      warmupIterations,
      timing: "depth1-first-result-and-iterative-final-measured-separately",
      correctnessGate: "status/nodes/score/PV must match corpus before timing is comparable",
      scoreComparability: "within-position",
    },
    environment: environmentRecord(includeEnvironment),
    artifacts: artifactRecord(),
    correctness: cases.every((testCase) => testCase.correctness === "passed")
      ? "passed"
      : "failed",
    cases,
  };
}

function benchmarkCase(testCase, { iterations, warmupIterations, clock }) {
  const fixture = JSON.parse(readFileSync(testCase.fixturePath, "utf8"));
  const state = fixture.input.state;
  const cold = measureRun(state, testCase, clock);
  for (let index = 0; index < warmupIterations; index += 1) {
    measureRun(state, testCase, clock);
  }
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    samples.push(measureRun(state, testCase, clock));
  }

  const signatures = [cold, ...samples].map((sample) => sample.signature);
  const expectedSignature = canonicalize(testCase.expected);
  const correctness = signatures.every((signature) => signature === expectedSignature)
    ? "passed"
    : "failed";
  const metrics = correctness === "passed"
    ? {
        firstResultMs: summarize(samples.map((sample) => sample.firstResultMs)),
        finalResultMs: summarize(samples.map((sample) => sample.finalResultMs)),
        nodesPerSecond: summarize(samples.map((sample) => sample.nodesPerSecond)),
        rssDeltaBytes: summarize(samples.map((sample) => sample.rssDeltaBytes)),
        heapUsedDeltaBytes: summarize(samples.map((sample) => sample.heapUsedDeltaBytes)),
      }
    : null;
  const memory = correctness === "passed" ? measureSampledPeakMemory(state, testCase) : null;

  return {
    id: testCase.id,
    fixturePath: testCase.fixturePath,
    rulesetId: state.rulesetId,
    maxDepth: testCase.maxDepth,
    nodeBudget: testCase.nodeBudget,
    deterministicSeed: testCase.deterministicSeed,
    correctness,
    cold: {
      firstResultMs: cold.firstResultMs,
      finalResultMs: cold.finalResultMs,
      nodesPerSecond: cold.nodesPerSecond,
      rssDeltaBytes: cold.rssDeltaBytes,
      heapUsedDeltaBytes: cold.heapUsedDeltaBytes,
    },
    memory,
    metrics,
    result: testCase.expected,
  };
}

function measureSampledPeakMemory(state, testCase) {
  const baseline = process.memoryUsage();
  let peakRss = baseline.rss;
  let peakHeapUsed = baseline.heapUsed;
  const sampleEveryNodes = 32;
  const sample = (nodes) => {
    if (nodes % sampleEveryNodes !== 0) return;
    const usage = process.memoryUsage();
    peakRss = Math.max(peakRss, usage.rss);
    peakHeapUsed = Math.max(peakHeapUsed, usage.heapUsed);
  };
  analyzeIterativeDeepening(state, {
    topN: 1,
    maxDepth: testCase.maxDepth,
    nodeBudget: testCase.nodeBudget,
    deterministicSeed: testCase.deterministicSeed,
    now: () => 0,
    onNode: sample,
  });
  sample(testCase.expected.nodes - (testCase.expected.nodes % sampleEveryNodes));
  return {
    method: "separate-untimed-process-memory-sampling",
    sampleEveryNodes,
    peakRssDeltaBytes: peakRss - baseline.rss,
    peakHeapUsedDeltaBytes: peakHeapUsed - baseline.heapUsed,
  };
}

function measureRun(state, testCase, clock) {
  const memoryBefore = process.memoryUsage();
  const firstStarted = clock.now();
  const first = analyzeDepthOne(state, {
    topN: 1,
    nodeBudget: testCase.nodeBudget,
    deterministicSeed: testCase.deterministicSeed,
    now: () => 0,
  });
  const firstResultMs = clock.now() - firstStarted;

  const finalStarted = clock.now();
  const final = analyzeIterativeDeepening(state, {
    topN: 1,
    maxDepth: testCase.maxDepth,
    nodeBudget: testCase.nodeBudget,
    deterministicSeed: testCase.deterministicSeed,
    now: () => 0,
  });
  const finalResultMs = clock.now() - finalStarted;
  const memoryAfter = process.memoryUsage();

  const actual = {
    nodes: final.nodes,
    // Preserve the exact JavaScript score representation without asking the
    // benchmark corpus to broaden CS/1's deliberately strict number domain.
    score: final.best === null ? null : String(final.best.score),
    principalVariation: (final.best?.principalVariation ?? []).map(({ placement }) => ({
      piece: placement.piece,
      rotation: placement.rotation,
      x: placement.x,
      y: placement.y,
      usedHold: placement.usedHold,
    })),
  };
  if (first.status !== "final" || final.status !== "final") actual.status = final.status;
  return {
    firstResultMs,
    finalResultMs,
    nodesPerSecond: finalResultMs === 0 ? 0 : (final.nodes * 1000) / finalResultMs,
    rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
    heapUsedDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
    signature: canonicalize(actual),
  };
}

function summarize(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1),
  };
}

function percentile(sorted, quantile) {
  return sorted[Math.ceil(quantile * sorted.length) - 1];
}

function environmentRecord(includeEnvironment) {
  if (!includeEnvironment) return { redacted: true };
  const processors = cpus();
  return {
    node: process.version,
    platform: platform(),
    release: release(),
    arch: process.arch,
    cpuModel: processors[0]?.model ?? "unknown",
    logicalCpus: processors.length,
    totalMemoryBytes: totalmem(),
    freeMemoryBytesAtStart: freemem(),
  };
}

function artifactRecord() {
  return [
    "src-js/search.mjs",
    "src-js/evaluation.mjs",
    "src-js/triangle/move-generation.mjs",
  ].map((path) => {
    const bytes = readFileSync(path);
    return {
      path,
      bytes: statSync(path).size,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    };
  });
}

function assertRunOptions(iterations, warmupIterations, clock, includeEnvironment) {
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error("iterations must be a positive safe integer");
  }
  if (!Number.isSafeInteger(warmupIterations) || warmupIterations < 0) {
    throw new Error("warmupIterations must be a non-negative safe integer");
  }
  if (typeof clock?.now !== "function") throw new Error("clock.now must be a function");
  if (typeof includeEnvironment !== "boolean") {
    throw new Error("includeEnvironment must be a boolean");
  }
}

function parseArguments(argv) {
  const options = {};
  for (const argument of argv) {
    if (argument === "--check") options.check = true;
    else if (argument === "--include-environment") options.includeEnvironment = true;
    else if (argument.startsWith("--iterations=")) options.iterations = Number(argument.slice(13));
    else if (argument.startsWith("--warmup=")) options.warmupIterations = Number(argument.slice(9));
    else if (argument.startsWith("--corpus=")) options.corpusPath = argument.slice(9);
    else throw new Error(`unknown argument ${argument}`);
  }
  return options;
}

const entryPath = process.argv[1] === undefined ? null : fileURLToPath(import.meta.url);
if (entryPath !== null && entryPath === process.argv[1]) {
  const { check, ...options } = parseArguments(process.argv.slice(2));
  const report = runSearchBenchmark(options);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (check && report.correctness !== "passed") process.exitCode = 1;
}
