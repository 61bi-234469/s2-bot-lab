import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  projectS2AmountOnlyPublicCandidates,
  projectS2AmountOnlyPublicCandidatesWithPreferredWitness,
} from "../src-js/s2-amount-only-public-candidates.mjs";
import { resolveCoreOrderedInputSubmission } from "../src-js/s2-input-public-resolver.mjs";
import { resolveInputJob } from "../src-js/input-public-job.mjs";

const targets = JSON.parse(readFileSync(new URL("../fixtures/input-execution/spin-targets.json", import.meta.url), "utf8"));
const CHAMPION = "cc2-s2-champion";
const cases = targets.cases.map((entry) => ({
  id: entry.id,
  request: { ...entry.request, id: "cc2-input-decision-request/1", type: CHAMPION, engine: { botType: CHAMPION, engineId: CHAMPION } },
  movement: entry.movement,
}));
const options = (moves) => ({ candidateLimit: Math.min(16, moves.length), allowCompleteReturnedPrefix: true });
const view = (candidate) => ({ cc2Rank: candidate.cc2Rank, identity: candidate.identity, move: candidate.move,
  placement: candidate.placement, projection: candidate.projection });
const clean = (value) => Array.isArray(value) ? value.map(clean)
  : value && typeof value === "object"
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== "elapsedMs").map(([key, entry]) => [key, clean(entry)]))
    : value;
/** The core serializes its placement with sorted keys and reports null kick fields for a drop. */
function coreShaped(placement) {
  const evidence = placement.rotationEvidence;
  return { piece: placement.piece, rotation: placement.rotation,
    rotationEvidence: { kickId: evidence.kickId, kickIndex: evidence.kickIndex, kickOffset: evidence.kickOffset === null ? null : [...evidence.kickOffset],
      lastInputWasRotation: evidence.lastInputWasRotation },
    usedHold: placement.usedHold, x: placement.x, y: placement.y };
}

test("preferred witness: the core-shaped selected placement yields the eager candidate list byte for byte", () => {
  assert.ok(cases.length > 0);
  for (const { id, request } of cases) {
    const eager = projectS2AmountOnlyPublicCandidates(request.decision, request.moves, options(request.moves));
    const witness = coreShaped(eager.candidates[0].placement);
    const lazy = projectS2AmountOnlyPublicCandidatesWithPreferredWitness(request.decision, request.moves,
      { ...options(request.moves), preferredWitness: witness });
    assert.equal(JSON.stringify(view(lazy.candidates[0])), JSON.stringify(view(eager.candidates[0])), `${id} first`);
    assert.equal(JSON.stringify(lazy.candidates.map(view)), JSON.stringify(eager.candidates.map(view)), `${id} all`);
  }
});

test("preferred witness: a witness that does not name the preferred pose falls back to the eager projection", () => {
  for (const { id, request } of cases) {
    const eager = projectS2AmountOnlyPublicCandidates(request.decision, request.moves, options(request.moves));
    const other = { ...eager.candidates[0].placement, x: eager.candidates[0].placement.x + 1 };
    for (const witness of [other, null, { piece: "T" }, { ...eager.candidates[0].placement, rotationEvidence: { lastInputWasRotation: true } }]) {
      const lazy = projectS2AmountOnlyPublicCandidatesWithPreferredWitness(request.decision, request.moves,
        { ...options(request.moves), preferredWitness: witness });
      assert.equal(JSON.stringify(lazy.candidates.map(view)), JSON.stringify(eager.candidates.map(view)), `${id} ${JSON.stringify(witness)}`);
    }
  }
});

test("preferred witness: the core-order resolver and the input job return the same plan with and without it", () => {
  for (const { id, request, movement } of cases) {
    const eager = projectS2AmountOnlyPublicCandidates(request.decision, request.moves, options(request.moves));
    const witness = coreShaped(eager.candidates[0].placement);
    for (const compactInputs of [false, true]) {
      const without = resolveCoreOrderedInputSubmission(request, movement, { compactInputs, maxTimeMs: 1000 });
      const withWitness = resolveCoreOrderedInputSubmission(request, movement, { compactInputs, maxTimeMs: 1000, preferredWitness: witness });
      assert.equal(JSON.stringify(clean(withWitness)), JSON.stringify(clean(without)), `${id} compact=${compactInputs}`);
    }
    const startFrame = request.decision.lockTime.logicalFrame;
    const jobWithout = resolveInputJob({ request, movement, startFrame });
    const jobWith = resolveInputJob({ request, movement, startFrame, preferredWitness: witness });
    assert.equal(JSON.stringify(clean(jobWith)), JSON.stringify(clean(jobWithout)), `${id} job`);
    assert.equal(jobWith.decisionFingerprint, jobWithout.decisionFingerprint);
  }
});
