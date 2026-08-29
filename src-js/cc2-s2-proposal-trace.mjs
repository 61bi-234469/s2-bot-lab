import { createHash } from "node:crypto";

import { canonicalize } from "./cs1-core.mjs";

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function projectCc2S2ProposalTrace(proposal) {
  assertRecord(proposal, "proposal trace input");
  const stateKey = nonemptyString(proposal.stateKey, "proposal trace stateKey");
  const engineId = nonemptyString(proposal.engineId, "proposal trace engineId");
  const side = nonemptyString(proposal.side, "proposal trace side");
  const lockNumber = positiveInteger(proposal.lockNumber, "proposal trace lockNumber");
  const selectionLimit = positiveInteger(proposal.selectionLimit, "proposal trace selectionLimit");
  const searchSeed = nonnegativeInteger(proposal.searchSeed, "proposal trace searchSeed");
  const nodes = nonnegativeInteger(proposal.nodes, "proposal trace nodes");
  const selections = nonnegativeInteger(proposal.selections, "proposal trace selections");
  if (!Array.isArray(proposal.orderedMoves) || proposal.orderedMoves.length === 0) {
    throw new Error("proposal trace orderedMoves must be a non-empty array");
  }
  if (!Array.isArray(proposal.candidateValues) ||
      proposal.candidateValues.length !== proposal.orderedMoves.length ||
      !proposal.candidateValues.every(Number.isFinite)) {
    throw new Error("proposal trace candidateValues must contain one finite value for every ordered move");
  }
  const orderedMoves = canonicalJsonValue(proposal.orderedMoves, "proposal trace orderedMoves");
  const candidateValues = canonicalJsonValue(proposal.candidateValues, "proposal trace candidateValues");

  return deepFreeze([
    stateKey,
    engineId,
    side,
    lockNumber,
    selectionLimit,
    searchSeed,
    nodes,
    selections,
    canonicalize(orderedMoves),
    candidateValues,
  ]);
}

export function createCc2S2ProposalGameTrace({ seed, candidateSide }) {
  return gameTrace({
    seed: nonnegativeInteger(seed, "proposal game trace seed"),
    candidateSide: nonemptyString(candidateSide, "proposal game trace candidateSide"),
    proposals: 0,
    nodesTotal: 0,
    selectionsTotal: 0,
    selectionLimitShortfalls: 0,
    traceHash: emptySha256(),
  });
}

export function appendCc2S2ProposalTrace(current, proposal) {
  validateGameTrace(current);
  const projection = projectCc2S2ProposalTrace(proposal);
  if (projection[7] > projection[4]) {
    throw new Error("proposal trace selections exceed the declared selectionLimit");
  }
  const proposalBytes = canonicalize(projection);
  const traceHash = current.proposals === 0
    ? sha256(proposalBytes)
    : sha256(current.traceHash + proposalBytes);

  return gameTrace({
    seed: current.seed,
    candidateSide: current.candidateSide,
    proposals: current.proposals + 1,
    nodesTotal: addSafeIntegers(current.nodesTotal, projection[6], "proposal trace nodesTotal"),
    selectionsTotal: addSafeIntegers(
      current.selectionsTotal,
      projection[7],
      "proposal trace selectionsTotal",
    ),
    selectionLimitShortfalls:
      current.selectionLimitShortfalls + (projection[7] < projection[4] ? 1 : 0),
    traceHash,
  });
}

export function summarizeCc2S2ProposalTrace({ games, declaredGames }) {
  if (!Array.isArray(games)) throw new Error("proposal trace games must be an array");
  if (!Array.isArray(declaredGames)) {
    throw new Error("proposal trace declaredGames must be an array");
  }

  const byIdentity = new Map();
  for (const game of games) {
    validateGameTrace(game);
    const key = gameIdentity(game);
    if (byIdentity.has(key)) throw new Error(`duplicate proposal game trace ${key}`);
    byIdentity.set(key, game);
  }

  const ordered = declaredGames.map((declaration) => {
    assertRecord(declaration, "declared proposal game");
    const identity = {
      seed: nonnegativeInteger(declaration.seed, "declared proposal game seed"),
      candidateSide: nonemptyString(
        declaration.candidateSide,
        "declared proposal game candidateSide",
      ),
    };
    const key = gameIdentity(identity);
    const game = byIdentity.get(key);
    if (game === undefined) throw new Error(`missing proposal game trace ${key}`);
    byIdentity.delete(key);
    return game;
  });
  if (byIdentity.size > 0) {
    throw new Error(`undeclared proposal game trace ${byIdentity.keys().next().value}`);
  }

  let proposals = 0;
  let nodesTotal = 0;
  let selectionsTotal = 0;
  let selectionLimitShortfalls = 0;
  let traceHashChain = emptySha256();
  for (let index = 0; index < ordered.length; index += 1) {
    const game = ordered[index];
    proposals = addSafeIntegers(proposals, game.proposals, "proposal trace proposals");
    nodesTotal = addSafeIntegers(nodesTotal, game.nodesTotal, "proposal trace nodesTotal");
    selectionsTotal = addSafeIntegers(
      selectionsTotal,
      game.selectionsTotal,
      "proposal trace selectionsTotal",
    );
    selectionLimitShortfalls = addSafeIntegers(
      selectionLimitShortfalls,
      game.selectionLimitShortfalls,
      "proposal trace selectionLimitShortfalls",
    );
    traceHashChain = index === 0
      ? game.traceHash
      : sha256(traceHashChain + game.traceHash);
  }

  return deepFreeze({
    proposals,
    nodesTotal,
    selectionsTotal,
    selectionLimitShortfalls,
    traceHashChain,
    perGame: ordered.map(({
      seed,
      candidateSide,
      proposals: gameProposals,
      nodesTotal: gameNodesTotal,
      selectionsTotal: gameSelectionsTotal,
      selectionLimitShortfalls: gameSelectionLimitShortfalls,
      traceHash,
    }) => ({
      seed,
      candidateSide,
      proposals: gameProposals,
      nodesTotal: gameNodesTotal,
      selectionsTotal: gameSelectionsTotal,
      selectionLimitShortfalls: gameSelectionLimitShortfalls,
      traceHash,
    })),
  });
}

function gameTrace(value) {
  return Object.freeze(value);
}

function validateGameTrace(value) {
  assertRecord(value, "proposal game trace");
  nonnegativeInteger(value.seed, "proposal game trace seed");
  nonemptyString(value.candidateSide, "proposal game trace candidateSide");
  nonnegativeInteger(value.proposals, "proposal game trace proposals");
  nonnegativeInteger(value.nodesTotal, "proposal game trace nodesTotal");
  nonnegativeInteger(value.selectionsTotal, "proposal game trace selectionsTotal");
  nonnegativeInteger(
    value.selectionLimitShortfalls,
    "proposal game trace selectionLimitShortfalls",
  );
  if (!SHA256_PATTERN.test(value.traceHash)) {
    throw new Error("proposal game trace traceHash must be a lowercase SHA-256 identity");
  }
}

function canonicalJsonValue(value, label) {
  try {
    canonicalize(value);
  } catch (error) {
    throw new Error(`${label} must be canonicalizable: ${error.message}`, { cause: error });
  }
  return structuredClone(value);
}

function gameIdentity({ seed, candidateSide }) {
  return canonicalize([seed, candidateSide]);
}

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function emptySha256() {
  return sha256("");
}

function addSafeIntegers(left, right, label) {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error(`${label} exceeds the safe integer range`);
  return result;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function nonnegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a nonnegative integer`);
  }
  return value;
}

function nonemptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function assertRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
