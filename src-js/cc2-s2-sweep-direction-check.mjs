// Historical reproduction path: these decisions were recorded under the staged
// screen, so they stay on the frozen legacy rule. A new family declares its own
// N and D and calls `cc2-s2-direction-screen.mjs` instead.
import { evaluateCc2S2LegacyStagedScreen } from "./cc2-s2-direction-screen-legacy.mjs";
import { assertExecutionProfile, SERIAL_EXECUTION_PROFILE } from
  "./cc2-s2-execution-profile.mjs";

/**
 * Validates separate control/candidate sweep reports for one variant and
 * applies the shared two-stage direction screen. CLI I/O and the serialized
 * expected-object shape remain with each evidence-specific wrapper.
 */
export function checkCc2S2SweepDirection({
  controlReport,
  candidateReport,
  controlExtensionReport = null,
  candidateExtensionReport = null,
  expected,
  contract,
  schema,
}) {
  const values = expectedValues(expected, contract.expectedKeys);
  const control = combineReports(
    controlReport,
    controlExtensionReport,
    "control",
    values.controlConfigSha256,
    values,
    contract,
  );
  const candidate = combineReports(
    candidateReport,
    candidateExtensionReport,
    "candidate",
    values.candidateConfigSha256,
    values,
    contract,
  );
  const reasons = [...control.reasons, ...candidate.reasons];
  // Preserve the legacy 8,192 checker contract: the control extension alone
  // determines whether the paired screen spans the extra partition.
  const pairCount = values.seedPairs +
    (controlExtensionReport === null ? 0 : contract.extensionPairs);
  const pairs = [];
  for (let seed = values.seedStart; seed < values.seedStart + pairCount; seed += 1) {
    const controlWins = wins(control.games, seed, values.engineId);
    const candidateWins = wins(candidate.games, seed, values.engineId);
    pairs.push({
      seed,
      controlWins,
      candidateWins,
      result: candidateWins > controlWins ? "better" :
        candidateWins < controlWins ? "worse" : "tie",
    });
  }
  let screen = null;
  if (reasons.length === 0) {
    try {
      screen = evaluateCc2S2LegacyStagedScreen(
        pairs.map(({ seed, result }) => ({ seed, result })),
      );
    } catch (error) {
      reasons.push(`direction screen: ${error.message}`);
    }
  }
  return {
    schema,
    valid: reasons.length === 0,
    reasons,
    expected,
    control: control.summary,
    candidate: candidate.summary,
    paired: {
      pairs,
      betterPairs: screen?.betterPairs ?? null,
      worsePairs: screen?.worsePairs ?? null,
      tiedPairs: screen?.tiedPairs ?? null,
      margin: screen?.margin ?? null,
    },
    screen,
    holdoutPairsRead: 0,
    releaseEvidence: false,
  };
}

function expectedValues(expected, keys) {
  return {
    variantId: expected.variantId,
    engineId: expected.engineId,
    controlConfigSha256: expected[keys.controlConfigSha256],
    candidateConfigSha256: expected[keys.candidateConfigSha256],
    s2Sha256: expected[keys.s2Sha256],
    referenceSha256: expected[keys.referenceSha256],
    referenceVersion: expected[keys.referenceVersion],
    seedStart: expected[keys.seedStart],
    seedPairs: expected[keys.seedPairs],
    selections: expected[keys.selections],
    referenceSelections: expected[keys.referenceSelections],
    searchSeed: expected[keys.searchSeed],
    knownQueue: expected[keys.knownQueue],
    maxLocks: expected[keys.maxLocks],
  };
}

function combineReports(primaryReport, extensionReport, label, configSha256, values, contract) {
  const primary = inspectReport(primaryReport, label, configSha256, {
    seedStart: values.seedStart,
    seedPairs: values.seedPairs,
  }, values, contract);
  if (extensionReport === null) return primary;
  const extension = inspectReport(extensionReport, `${label} extension`, configSha256, {
    seedStart: values.seedStart + values.seedPairs,
    seedPairs: contract.extensionPairs,
  }, values, contract);
  return {
    reasons: [...primary.reasons, ...extension.reasons],
    games: [...primary.games, ...extension.games],
    summary: { primary: primary.summary, extension: extension.summary },
  };
}

function inspectReport(report, label, configSha256, partitionExpected, values, contract) {
  const reasons = [];
  const runtime = report.runtime ?? {};
  const partition = report.seedPartitions?.development ?? {};
  const holdout = report.seedPartitions?.holdout ?? {};
  const arm = report.development?.find((entry) => entry.variant?.id === values.variantId);
  const games = arm?.chunks?.flatMap((chunk) => chunk.games ?? []) ?? [];
  expect(reasons, runtime.challengerConfig?.sha256, configSha256, `${label}: config`);
  expect(reasons, runtime.s2ArtifactSha256, values.s2Sha256,
    `${label}: ${contract.reasonLabels.s2Artifact}`);
  expect(reasons, runtime.chouhyArtifactSha256, values.referenceSha256,
    `${label}: reference artifact`);
  expect(reasons, runtime.referenceBudget?.tbpVersion, values.referenceVersion,
    `${label}: reference version`);
  expect(reasons, runtime.challengerSelectionLimit, values.selections,
    `${label}: ${contract.reasonLabels.selections}`);
  expect(reasons, runtime.referenceBudget?.selectionLimit, values.referenceSelections,
    `${label}: reference selections`);
  expect(reasons, runtime.challengerSearchSeed, values.searchSeed, `${label}: challenger seed`);
  expect(reasons, runtime.referenceBudget?.searchSeed, values.searchSeed, `${label}: reference seed`);
  expect(reasons, runtime.knownQueue, values.knownQueue, `${label}: known queue`);
  expect(reasons, runtime.maxLocksPerSide, values.maxLocks, `${label}: lock cap`);
  checkExecutionProfile(reasons, runtime, SERIAL_EXECUTION_PROFILE, label);
  expect(reasons, runtime.releaseEvidence, false, `${label}: release evidence`);
  expect(reasons, partition.seedStart, partitionExpected.seedStart, `${label}: seed start`);
  expect(reasons, partition.seedPairs, partitionExpected.seedPairs, `${label}: seed pairs`);
  expect(reasons, holdout.seedPairs, 0, `${label}: holdout pairs`);
  expect(reasons, games.length, partitionExpected.seedPairs * 2, `${label}: game count`);
  expect(reasons, arm?.summary?.proposalFailures, 0, `${label}: proposal failures`);
  if ((arm?.summary?.lockLimitDrawRate ?? 1) > 0.1) {
    reasons.push(`${label}: lock-limit draw rate`);
  }
  if (games.some((game) => game.locksPerSide === 0)) reasons.push(`${label}: zero-lock game`);
  checkCompleteSwaps(reasons, games, partitionExpected, label, contract.incompleteSwapMode);
  return {
    reasons,
    games,
    summary: { id: arm?.variant?.id ?? null, summary: arm?.summary ?? null },
  };
}

function checkCompleteSwaps(reasons, games, expected, label, mode) {
  const keys = new Set(games.map((game) => `${game.seed}:${game.swapIndex}`));
  for (let seed = expected.seedStart; seed < expected.seedStart + expected.seedPairs; seed += 1) {
    if (mode === "per-swap") {
      for (const swap of [0, 1]) {
        if (!keys.has(`${seed}:${swap}`)) reasons.push(`${label}: incomplete swap ${seed}:${swap}`);
      }
    } else if (!keys.has(`${seed}:0`) || !keys.has(`${seed}:1`)) {
      reasons.push(`${label}: incomplete swap ${seed}`);
    }
  }
}

function wins(games, seed, engineId) {
  return games.filter((game) => game.seed === seed && game.winnerEngineId === engineId).length;
}

function expect(reasons, actual, expected, label) {
  if (actual !== expected) {
    reasons.push(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function checkExecutionProfile(reasons, runtime, expected, label) {
  try {
    assertExecutionProfile(runtime, expected, `${label}: execution profile`);
  } catch (error) {
    reasons.push(error.message);
  }
}
