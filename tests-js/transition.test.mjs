import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

import { canonicalize } from "../scripts/cs1.mjs";
import { RULESET_IDS } from "../src-js/ruleset-profiles.mjs";
import { TRANSITION_KINDS, applyTransition } from "../src-js/transition.mjs";

const FIXTURE_SCHEMA = "s2-analysis-engine/schema/fixture/1";
const GOLDEN_DIR = "fixtures/golden";

// Enumerating the directory instead of listing fixtures by name means a new
// fixture is executed the moment it lands. A fixture that no test remembered to
// reference used to be indistinguishable from one that passes.
const fixtures = readdirSync(GOLDEN_DIR)
  .filter((name) => name.endsWith(".json"))
  .map((name) => ({
    name,
    body: JSON.parse(readFileSync(`${GOLDEN_DIR}/${name}`, "utf8")),
  }))
  .filter(({ body }) => body.$schema === FIXTURE_SCHEMA);

test("the golden corpus contains complete fixtures for every action kind", () => {
  assert.ok(fixtures.length >= 10, `found only ${fixtures.length} complete fixtures`);
  const kinds = new Set(fixtures.map(({ body }) => body.input.action.kind));
  assert.deepEqual([...kinds].sort(), [...TRANSITION_KINDS].sort());
});

for (const { name, body } of fixtures) {
  test(`fixture executes through the dispatcher: ${name}`, () => {
    assert.ok(TRANSITION_KINDS.includes(body.input.action.kind));
    const actual = applyTransition(body.input.state, body.input.action, body.rulesetId);
    assert.deepEqual(actual, body.expected);
  });

  test(`fixture hash covers ruleset, input, and expected: ${name}`, () => {
    const digest = createHash("sha256")
      .update(canonicalize({ rulesetId: body.rulesetId, input: body.input, expected: body.expected }))
      .digest("hex");
    assert.equal(body.hash, `sha256:${digest}`);
  });

  test(`fixture states declare the fixture ruleset: ${name}`, () => {
    assert.equal(body.input.state.rulesetId, body.rulesetId);
    if (body.expected.nextState !== null) {
      assert.equal(body.expected.nextState.rulesetId, body.rulesetId);
    }
  });
}

test("an action kind outside the declared set fails closed", () => {
  const state = fixtures[0].body.input.state;
  assert.throws(
    () => applyTransition(state, { kind: "teleport" }, state.rulesetId),
    /unsupported action kind teleport/,
  );
});

test("a tick must start where the state is and move forward under known semantics", () => {
  const tick = fixtures.find(({ body }) => body.input.action.kind === "tick").body;
  const { state, action } = tick.input;

  assert.throws(
    () => applyTransition(state, { ...action, fromFrame: action.fromFrame + 1 }, tick.rulesetId),
    /tick starts at frame 102, but the state is at 101/,
  );
  assert.throws(
    () => applyTransition(state, { ...action, toFrame: action.fromFrame }, tick.rulesetId),
    /tick must advance to a later frame/,
  );

  // Engine-frame semantics count real frames carrying gravity, ARE and lock
  // delay, none of which this Simulator models.
  const engineFrames = structuredClone(state);
  engineFrames.time.frameSemantics = "engine-frame";
  assert.throws(
    () => applyTransition(engineFrames, action, tick.rulesetId),
    /tick is not defined for frame semantics engine-frame/,
  );
});

test("a transition refuses a ruleset the state does not declare", () => {
  const { body } = fixtures.find(({ body: f }) => f.rulesetId === RULESET_IDS.foundation);
  assert.throws(
    () => applyTransition(body.input.state, body.input.action, RULESET_IDS.b2bCharging),
    /state declares ruleset .*, not /,
  );
  assert.throws(
    () => applyTransition(body.input.state, body.input.action, "tetrio-s2-v19-nope-beta-1-5-0"),
    /unknown ruleset id/,
  );
});

test("confirming a packet the queue does not hold fails closed without a next state", () => {
  const confirm = fixtures.find(
    ({ body }) => body.input.action.kind === "garbage-confirm",
  ).body;
  const action = { ...confirm.input.action, packetId: 999 };

  const result = applyTransition(confirm.input.state, action, confirm.rulesetId);
  assert.deepEqual(result, {
    legality: { legal: false, reason: "packet-unknown" },
    lockResult: null,
    chain: null,
    attackStages: null,
    cancelResult: null,
    tankResult: null,
    nextState: null,
  });

  // A matching packet id under a different source game is still a different
  // packet, so it must not be confirmed by accident.
  assert.equal(
    applyTransition(
      confirm.input.state,
      { ...confirm.input.action, sourceGameId: 4402 },
      confirm.rulesetId,
    ).legality.reason,
    "packet-unknown",
  );
});
