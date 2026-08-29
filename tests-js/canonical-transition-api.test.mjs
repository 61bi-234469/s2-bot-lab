import { readFileSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import {
  CANONICAL_TRANSITION_REQUEST_SCHEMA,
  CANONICAL_TRANSITION_RESPONSE_SCHEMA,
  canonicalTransitionHttpResponse,
  invokeCanonicalTransition,
} from "../src-js/canonical-transition-api.mjs";
import { guiStateToCanonical } from "../src-js/cc2-s2-adapter.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";
import { fullStateKey } from "../src-js/state-keys.mjs";

function request(state, placement) {
  return {
    $schema: CANONICAL_TRANSITION_REQUEST_SCHEMA,
    apiVersion: 1,
    schemaVersion: 1,
    state,
    action: { kind: "placement", placement },
  };
}

function initialPlacement() {
  const state = guiStateToCanonical(toS2GuiState(createGame(1514)));
  const candidate = analyzeSimpleS2FinalPlacements(state, { topN: 1 }).moves[0].placement;
  return {
    state,
    placement: {
      piece: candidate.piece,
      rotation: candidate.rotation,
      x: candidate.x,
      y: candidate.y,
      usedHold: candidate.usedHold,
      rotationEvidence: structuredClone(candidate.rotationEvidence),
    },
  };
}

test("canonical transition service returns all S2 display stages and next state", () => {
  const { state, placement } = initialPlacement();
  const before = structuredClone(state);
  const response = invokeCanonicalTransition(request(state, placement));

  assert.equal(response.$schema, CANONICAL_TRANSITION_RESPONSE_SCHEMA);
  assert.equal(response.status, "ok");
  assert.equal(response.positionFingerprint, fullStateKey(state));
  assert.equal(response.rulesetId, state.rulesetId);
  assert.deepEqual(response.degraded, []);
  assert.deepEqual(Object.keys(response.transition).sort(), [
    "attackStages",
    "cancelResult",
    "chain",
    "legality",
    "lockResult",
    "nextState",
    "tankResult",
  ]);
  assert.equal(response.transition.legality.legal, true);
  assert.equal(typeof response.transition.lockResult.spin, "string");
  assert.equal(typeof response.transition.attackStages.outgoingBeforeCancel, "number");
  assert.equal(typeof response.transition.chain.b2bAfter, "number");
  assert.equal(typeof response.transition.chain.comboAfter, "number");
  assert.equal(typeof response.transition.cancelResult.cancelled, "number");
  assert.ok(Array.isArray(response.transition.tankResult.deferred));
  assert.equal(response.transition.nextState.$schema, "s2-analysis-engine/schema/canonical-state/1");
  assert.deepEqual(state, before, "public transition must not mutate the caller's canonical state");
});

test("missing rotation evidence fails safe to non-spin and declares degradation", () => {
  const { state, placement } = initialPlacement();
  delete placement.rotationEvidence;
  const response = invokeCanonicalTransition(request(state, placement));

  assert.equal(response.status, "degraded");
  assert.deepEqual(response.degraded, ["spin-evidence-unavailable"]);
  assert.equal(response.transition.lockResult.spin, "none");
  assert.match(response.warnings[0], /evaluated this lock as non-spin/);
});

test("the public placement action does not accept a CC2 spin label", () => {
  const { state, placement } = initialPlacement();
  assert.throws(
    () => invokeCanonicalTransition(request(state, { ...placement, spin: "full" })),
    /unsupported property spin/,
  );
});

test("request and response schemas close their public envelopes", () => {
  const requestSchema = JSON.parse(
    readFileSync("schema/canonical-transition-request.schema.json", "utf8"),
  );
  const responseSchema = JSON.parse(
    readFileSync("schema/canonical-transition-response.schema.json", "utf8"),
  );
  assert.equal(requestSchema.$id, CANONICAL_TRANSITION_REQUEST_SCHEMA);
  assert.equal(responseSchema.$id, CANONICAL_TRANSITION_RESPONSE_SCHEMA);
  assert.equal(requestSchema.additionalProperties, false);
  assert.equal(requestSchema.$defs.action.oneOf.every((entry) => entry.additionalProperties === false), true);
  assert.equal(responseSchema.additionalProperties, false);
  assert.equal(responseSchema.$defs.transition.additionalProperties, false);
  assert.deepEqual(responseSchema.properties.transition, { $ref: "#/$defs/transition" });
});

test("request envelope rejects unknown properties before Simulator execution", () => {
  const { state, placement } = initialPlacement();
  assert.throws(
    () => invokeCanonicalTransition({ ...request(state, placement), botSpin: "full" }),
    /request properties must be exactly/,
  );
});

test("local-server adapter maps valid requests to 200 and contract errors to 400", () => {
  const { state, placement } = initialPlacement();
  const accepted = canonicalTransitionHttpResponse(request(state, placement));
  assert.equal(accepted.statusCode, 200);
  assert.equal(accepted.body.$schema, CANONICAL_TRANSITION_RESPONSE_SCHEMA);

  const rejected = canonicalTransitionHttpResponse({ ...request(state, placement), botSpin: "full" });
  assert.equal(rejected.statusCode, 400);
  assert.match(rejected.body.error, /request properties must be exactly/);
});
