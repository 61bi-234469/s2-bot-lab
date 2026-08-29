export const FEATURE_SCHEMA_ID = "s2-analysis-engine/schema/evaluation-features/2";
export const FEATURE_SCHEMA_VERSION = 2;
export const FEATURE_SCHEMA_SHA256 =
  "sha256:04de3656e0b3261cbcdf9bfa44acae4efeff6034da72ff4d8e137defefd6e3e9";

export const EVALUATION_SCORE_SEMANTICS = Object.freeze({
  unit: "engine-internal",
  direction: "higher-is-better",
  origin: "unspecified",
  comparability: "within-position",
  specialValues: Object.freeze({ topOut: -1000000, unknown: null }),
  normalizable: false,
});

// This is a deliberately small, inspectable baseline rather than a selected
// production evaluator. Every value comes from the Simulator's staged result
// or next canonical state; rule values are never recalculated here.
export const DEPTH1_BASELINE_MODEL = Object.freeze({
  id: "s2-depth1-linear-baseline",
  version: 2,
  modelSha256: "sha256:ced505996d812b2dd9591235c40d57c4c3505a9bd4992e44db4a155fc4f7ca4d",
  featureSchema: FEATURE_SCHEMA_ID,
  featureSchemaSha256: FEATURE_SCHEMA_SHA256,
  weightsVersion: 2,
  weightsSha256: "sha256:71fa3b2a83221a574c97c361b3b2b64005d99991f46efd5d3745a74386df4132",
  trainingCorpus: null,
  comparability: "within-position",
  weights: Object.freeze({
    aggregateHeight: -0.35,
    maxHeight: -0.7,
    holes: -4.0,
    bumpiness: -0.2,
    toppedOut: -1000000,
    remainingIncoming: -0.4,
    deferredIncoming: -0.3,
    dueIncoming: -4.0,
    incomingNextLock: -2.0,
    confirmedIncoming: -0.25,
    tankedIncoming: -2.5,
    visibleTopOutMargin: 0.4,
    outgoingBeforeCancel: 0.5,
    outgoingAfterCancel: 1.2,
    cancelled: 1.0,
    combo: 0.15,
    b2b: 0.7,
    chargingLevel: 0.25,
    surgeSent: 2.0,
  }),
});

export function evaluatorModelIdentity(model = DEPTH1_BASELINE_MODEL) {
  return {
    id: model.id,
    version: model.version,
    featureSchema: model.featureSchema,
    featureSchemaSha256: model.featureSchemaSha256,
    weightsVersion: model.weightsVersion,
    weightsSha256: model.weightsSha256,
    trainingCorpus: model.trainingCorpus,
    comparability: model.comparability,
  };
}

export function extractEvaluationFeatures(transition) {
  if (transition?.legality?.legal !== true || transition.nextState === null) {
    throw new Error("evaluation requires a legal Simulator transition with a next state");
  }

  const board = boardFeatures(transition.nextState.board);
  const remainingIncoming = sumPacketAmount(transition.cancelResult?.remainingIncoming);
  const deferredIncoming = sumPacketAmount(transition.tankResult?.deferred);
  const frame = transition.nextState.time?.logicalFrame ?? 0;
  const framesPerLock = transition.nextState.provenance?.clock?.framesPerLock ?? 60;
  const remainingPackets = transition.cancelResult?.remainingIncoming ?? [];
  const dueIncoming = sumPacketAmount(remainingPackets.filter((packet) =>
    packet.confirmed && packet.arrivalFrame <= frame
  ));
  const incomingNextLock = sumPacketAmount(remainingPackets.filter((packet) =>
    packet.confirmed && packet.arrivalFrame <= frame + framesPerLock
  ));
  const confirmedIncoming = sumPacketAmount(remainingPackets.filter((packet) => packet.confirmed));
  const tankedIncoming = sumPacketAmount(transition.tankResult?.inserted);
  const surgeSent = sumNumbers(transition.attackStages?.surgeChunks);
  const b2b = transition.chain?.b2bAfter ?? transition.nextState.chain?.b2b ?? 0;

  return {
    $schema: FEATURE_SCHEMA_ID,
    schemaVersion: FEATURE_SCHEMA_VERSION,
    aggregateHeight: board.aggregateHeight,
    maxHeight: board.maxHeight,
    holes: board.holes,
    bumpiness: board.bumpiness,
    toppedOut: transition.tankResult?.toppedOut === true ? 1 : 0,
    remainingIncoming,
    deferredIncoming,
    dueIncoming,
    incomingNextLock,
    confirmedIncoming,
    tankedIncoming,
    visibleTopOutMargin: (transition.nextState.board.visibleHeight ?? transition.nextState.board.height) - board.maxHeight,
    outgoingBeforeCancel: transition.attackStages?.outgoingBeforeCancel ?? 0,
    outgoingAfterCancel: transition.cancelResult?.outgoingAfterCancel ?? 0,
    cancelled: transition.cancelResult?.cancelled ?? 0,
    combo: transition.chain?.comboAfter ?? transition.nextState.chain?.combo ?? 0,
    b2b,
    // B2B is the only charging progress present in canonical state. Keeping it
    // as a separate observable lets later model comparisons weight ordinary
    // B2B value and charging/Surge potential independently.
    chargingLevel: b2b,
    surgeSent,
  };
}

export function scoreEvaluationFeatures(features, model = DEPTH1_BASELINE_MODEL) {
  if (features?.$schema !== model.featureSchema) {
    throw new Error(`feature schema ${features?.$schema ?? "missing"} is not ${model.featureSchema}`);
  }
  if (features.schemaVersion !== FEATURE_SCHEMA_VERSION) {
    throw new Error(
      `feature schema version ${features.schemaVersion ?? "missing"} is not ${FEATURE_SCHEMA_VERSION}`,
    );
  }

  const expectedProperties = new Set(["$schema", "schemaVersion", ...Object.keys(model.weights)]);
  for (const name of Object.keys(features)) {
    if (!expectedProperties.has(name)) throw new Error(`unknown evaluation feature ${name}`);
  }
  if (!(features.toppedOut === 0 || features.toppedOut === 1)) {
    throw new Error("feature toppedOut must be 0 or 1");
  }

  let score = 0;
  for (const [name, weight] of Object.entries(model.weights)) {
    const value = features[name];
    if (!Number.isFinite(value)) throw new Error(`feature ${name} is not finite`);
    score += value * weight;
  }
  return score;
}

function boardFeatures(board) {
  if (board?.fidelity !== "exact") {
    throw new Error("evaluation requires exact canonical board state");
  }
  if (
    !Number.isSafeInteger(board.width) ||
    !Number.isSafeInteger(board.height) ||
    board.width < 1 ||
    board.height < 1
  ) {
    throw new Error("evaluation requires a positive integer board geometry");
  }
  if (typeof board.cells !== "string" || !/^[IJLOSTZG_]+$/.test(board.cells)) {
    throw new Error("evaluation requires canonical board cells");
  }
  if (board.cells.length !== board.width * board.height) {
    throw new Error("canonical board cell count does not match its geometry");
  }

  const heights = [];
  let holes = 0;
  for (let x = 0; x < board.width; x += 1) {
    let highest = -1;
    for (let y = board.height - 1; y >= 0; y -= 1) {
      if (board.cells[y * board.width + x] !== "_") {
        highest = y;
        break;
      }
    }
    heights.push(highest + 1);
    for (let y = 0; y < highest; y += 1) {
      if (board.cells[y * board.width + x] === "_") holes += 1;
    }
  }

  let bumpiness = 0;
  for (let x = 1; x < heights.length; x += 1) {
    bumpiness += Math.abs(heights[x] - heights[x - 1]);
  }
  return {
    aggregateHeight: sumNumbers(heights),
    maxHeight: Math.max(0, ...heights),
    holes,
    bumpiness,
  };
}

function sumPacketAmount(packets) {
  if (packets === null || packets === undefined) return 0;
  return packets.reduce((total, packet) => total + packet.amount, 0);
}

function sumNumbers(values) {
  if (values === null || values === undefined) return 0;
  return values.reduce((total, value) => total + value, 0);
}
