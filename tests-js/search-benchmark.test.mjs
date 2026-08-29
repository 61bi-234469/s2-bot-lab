import test from "node:test";
import assert from "node:assert/strict";

import {
  loadSearchBenchmarkCorpus,
  runSearchBenchmark,
} from "../scripts/benchmark-search.mjs";

test("search benchmark corpus has a valid identity and closed expected results", () => {
  const corpus = loadSearchBenchmarkCorpus();
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(corpus.cases.length, 4);
  assert.equal(new Set(corpus.cases.map((testCase) => testCase.id)).size, corpus.cases.length);
  for (const testCase of corpus.cases) {
    assert.equal(testCase.maxDepth, 2);
    assert.equal(testCase.expected.principalVariation.length, 2);
  }
});

test("benchmark excludes no run when search matches the correctness corpus", () => {
  let tick = 0;
  const report = runSearchBenchmark({
    iterations: 1,
    warmupIterations: 0,
    caseIds: ["partial-cancellation"],
    clock: { now: () => tick++ },
  });

  assert.equal(report.correctness, "passed");
  assert.equal(report.cases[0].correctness, "passed");
  assert.notEqual(report.cases[0].metrics, null);
  assert.equal(report.cases[0].metrics.firstResultMs.p50, 1);
  assert.equal(report.cases[0].metrics.finalResultMs.p50, 1);
  assert.equal(report.protocol.scoreComparability, "within-position");
  assert.deepEqual(report.environment, { redacted: true });
});

test("benchmark environment details require explicit opt-in", () => {
  let tick = 0;
  const report = runSearchBenchmark({
    iterations: 1,
    warmupIterations: 0,
    caseIds: ["partial-cancellation"],
    clock: { now: () => tick++ },
    includeEnvironment: true,
  });
  assert.equal(report.environment.redacted, undefined);
  assert.equal(typeof report.environment.platform, "string");
  assert.equal(typeof report.environment.totalMemoryBytes, "number");
});

test("benchmark options fail closed", () => {
  assert.throws(() => runSearchBenchmark({ iterations: 0 }), /iterations/);
  assert.throws(() => runSearchBenchmark({ warmupIterations: -1 }), /warmupIterations/);
  assert.throws(() => runSearchBenchmark({ caseIds: ["missing"] }), /no cases/);
  assert.throws(() => runSearchBenchmark({ includeEnvironment: "yes" }), /includeEnvironment/);
});
