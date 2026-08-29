import { createHash } from "node:crypto";

import { canonicalize } from "./cs1-core.mjs";

const EMPTY_HASH = digest("");

export function createCc2S2CommittedMoveTrace(prior = null) {
  const priorEvidence = prior === null ? emptyEvidence() : validateEvidence(prior);
  let records = priorEvidence.records;
  let traceHashChain = priorEvidence.traceHashChain;
  const perGame = new Map(priorEvidence.perGame.map((entry) => [
    gameKey(entry.seed, entry.candidateSide),
    { ...entry },
  ]));

  return Object.freeze({
    append({ seed, candidateSide, round, submissions }) {
      if (!Number.isSafeInteger(seed) || seed < 0 ||
          !["left", "right"].includes(candidateSide) ||
          !Number.isSafeInteger(round) || round < 1 ||
          !Array.isArray(submissions) || submissions.length !== 2) {
        throw new Error("committed move trace event is invalid");
      }
      for (const expectedBotId of ["left", "right"]) {
        const submission = submissions.find((entry) => entry?.botId === expectedBotId);
        const move = submission?.committed?.move;
        if (move === null || typeof move !== "object" || Array.isArray(move)) {
          throw new Error(`committed move trace is missing ${expectedBotId} move`);
        }
        const projection = canonicalize([seed, candidateSide, round, expectedBotId, move]);
        traceHashChain = chain(traceHashChain, projection);
        const key = gameKey(seed, candidateSide);
        const game = perGame.get(key) ?? {
          seed,
          candidateSide,
          commits: 0,
          traceHash: EMPTY_HASH,
        };
        game.commits += 1;
        game.traceHash = chain(game.traceHash, projection);
        perGame.set(key, game);
        records += 1;
      }
    },
    evidence() {
      return Object.freeze({
        schema: "s2-analysis-engine/cc2-s2-committed-move-trace/1",
        records,
        traceHashChain,
        perGame: Object.freeze([...perGame.values()].map((entry) => Object.freeze({ ...entry }))),
      });
    },
  });
}

function emptyEvidence() {
  return { records: 0, traceHashChain: EMPTY_HASH, perGame: [] };
}

function validateEvidence(value) {
  if (value?.schema !== "s2-analysis-engine/cc2-s2-committed-move-trace/1" ||
      !Number.isSafeInteger(value.records) || value.records < 0 ||
      !isHash(value.traceHashChain) || !Array.isArray(value.perGame)) {
    throw new Error("prior committed move trace evidence is invalid");
  }
  let records = 0;
  const keys = new Set();
  for (const entry of value.perGame) {
    const key = gameKey(entry?.seed, entry?.candidateSide);
    if (keys.has(key) || !Number.isSafeInteger(entry.commits) || entry.commits < 0 || !isHash(entry.traceHash)) {
      throw new Error("prior committed move per-game evidence is invalid");
    }
    keys.add(key);
    records += entry.commits;
  }
  if (records !== value.records) throw new Error("prior committed move trace count is inconsistent");
  return structuredClone(value);
}

function gameKey(seed, candidateSide) {
  if (!Number.isSafeInteger(seed) || !["left", "right"].includes(candidateSide)) {
    throw new Error("committed move game identity is invalid");
  }
  return `${seed}:${candidateSide}`;
}

function chain(previous, projection) {
  return digest(`${previous}${projection}`);
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function isHash(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}
