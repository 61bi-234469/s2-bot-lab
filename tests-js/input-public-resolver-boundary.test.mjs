import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import test from "node:test";

import { Tetromino } from "@haelp/teto/engine";

import { canonicalPlacementToGuiMove } from "../cc2-gui/analysis-proposal.mjs";
import { inputExecutionOptions, INPUT_EXECUTION_PROFILE } from "../src-js/replay/engine-config.mjs";
import { createInputReplaySession } from "../src-js/replay/ttrm-simulator.mjs";
import { resolveQualifiedInputSubmission } from "../src-js/s2-input-public-resolver.mjs";

function receive(frame, { amount, size, iid, gameid }) {
  return {
    frame,
    type: "ige",
    data: {
      type: "interaction",
      data: { type: "garbage", amt: amount, size, iid, gameid, ackiid: 0 },
    },
  };
}

function confirm(frame, { iid, gameid, senderFrame }) {
  return {
    frame,
    type: "ige",
    data: {
      type: "interaction_confirm",
      data: { type: "garbage", iid, gameid, frame: senderFrame },
    },
  };
}

function createProfileSession({ iid, gameid, senderFrame, size }) {
  const session = createInputReplaySession({
    id: "fixture",
    replay: {
      frames: 1,
      events: [],
      options: inputExecutionOptions({ seed: 42 }),
      results: { stats: { garbage: { sent: 0 } } },
    },
  }, { canonicalProfile: INPUT_EXECUTION_PROFILE.id });
  // Both variants receive four rows at frame 0 and confirm them at receiver
  // frame 1. Packet identity, hole size, and the sender's embedded frame are
  // hidden differences.
  session.tick([
    { frame: 0, type: "start" },
    { frame: 0, type: "ige", data: { type: "target", data: { targets: [gameid] } } },
    receive(0, { amount: 4, size, iid, gameid }),
  ]);
  session.tick([confirm(1, { iid, gameid, senderFrame })]);
  return session;
}

function fixedMove(decision, { x = 0, rotation = 0, hold = false } = {}) {
  const symbol = hold ? decision.pieces.known[0] : decision.pieces.current;
  const piece = new Tetromino({
    symbol: symbol.toLowerCase(),
    initialRotation: rotation,
    boardHeight: 20,
    boardWidth: 10,
  });
  piece.x = x;
  piece.y = 10;
  piece.y -= Math.min(...piece.absoluteBlocks.map(([, y]) => y));
  const placement = {
    piece: symbol,
    rotation: ["spawn", "right", "reverse", "left"][rotation],
    x,
    y: piece.y - (symbol === "I" ? 3 : symbol === "O" ? 1 : 2),
    usedHold: hold,
    rotationEvidence: {
      lastInputWasRotation: false,
      kickIndex: null,
      kickId: null,
      kickOffset: null,
    },
  };
  return canonicalPlacementToGuiMove(placement);
}

function requestFor(publicState, moves, type = 'cc2-s2-f14') {
  return {
    id: "cc2-input-decision-request/1",
    sessionKey: "input-public-resolver-boundary",
    type,
    engine: { botType: type, engineId: type },
    decision: publicState.decision,
    moves,
  };
}

function resolverView(result) {
  const plan = structuredClone(result.plan);
  // The bounded planner reports wall-clock duration for diagnostics. It is
  // intentionally excluded from the information-boundary equality check.
  delete plan.elapsedMs;
  return {
    status: result.status,
    decisionFingerprint: result.decisionFingerprint,
    movementFingerprint: result.movementFingerprint,
    controller: result.controller,
    placement: structuredClone(result.placement),
    plan,
    selection: structuredClone(result.selection),
    attempts: structuredClone(result.attempts),
  };
}

for (const type of ['cc2-raw', 'cc2-chouhy', 'cc2-s2-f14', 'cc2-s2-champion'])
test(`${type}: hidden incoming packet identity and sender clock do not affect public resolver execution`, () => {
  const left = createProfileSession({ iid: 1, gameid: 2, senderFrame: 7, size: 1 });
  const right = createProfileSession({ iid: 91, gameid: 99, senderFrame: 47, size: 2 });
  const leftPublic = left.publicState();
  const rightPublic = right.publicState();
  assert.deepEqual(leftPublic, rightPublic);
  assert.equal(leftPublic.decision.incoming.pendingRows, 4);
  assert.equal(leftPublic.decision.incoming.dueThisLockRows, 0);
  assert.equal(leftPublic.movement.frame, 2);

  const moves = [fixedMove(leftPublic.decision)];
  const leftResult = resolveQualifiedInputSubmission(
    requestFor(leftPublic, moves, type),
    leftPublic.movement,
    { maxNodes: 128, maxFrames: 60, maxTimeMs: 1000 },
  );
  const rightResult = resolveQualifiedInputSubmission(
    requestFor(rightPublic, moves, type),
    rightPublic.movement,
    { maxNodes: 128, maxFrames: 60, maxTimeMs: 1000 },
  );
  assert.equal(leftResult.status, "planned", JSON.stringify(leftResult));
  assert.equal(rightResult.status, "planned", JSON.stringify(rightResult));
  assert.deepEqual(resolverView(leftResult), resolverView(rightResult));
  assert.deepEqual(leftResult.plan.events, rightResult.plan.events);
  assert.equal(leftResult.selection.selectedCc2Rank, rightResult.selection.selectedCc2Rank);
});

// Every new local dependency requires an explicit public-boundary review.
const PUBLIC_MODULES = [
  "rulesets/tetrio-s2-v19-beta-1-5-0-observed.json",
  "scripts/cs1.mjs",
  "src-js/cc2-s2-tuning-model.mjs",
  "src-js/cs1-core.mjs",
  "src-js/dynamic-values.mjs",
  "src-js/evaluation.mjs",
  "src-js/input-bot-contract.mjs",
  "src-js/input-decision-payload.mjs",
  "src-js/input-decision-request.mjs",
  "src-js/replay/engine-config.mjs",
  "src-js/replay/ttrm-parser.mjs",
  "src-js/s2-amount-only-decision-request.mjs",
  "src-js/s2-amount-only-post-tank-solvency.mjs",
  "src-js/s2-amount-only-public-candidates.mjs",
  "src-js/s2-amount-only-public-resolver.mjs",
  "src-js/s2-amount-only-public-rules.mjs",
  "src-js/s2-amount-only-search-advance.mjs",
  "src-js/s2-conversion-qualified-ren-finisher-classification.mjs",
  "src-js/s2-input-public-resolver.mjs",
  "src-js/sha256.mjs",
  "src-js/triangle/chain-adapter.mjs",
  "src-js/triangle/input-public-movement.mjs",
  "src-js/triangle/input-rotation-observer.mjs",
  "src-js/triangle/input-target-planner.mjs"
];

test('public resolver and target planner have only reviewed transitive dependencies', () => {
  const seen = new Set();
  for (const entry of ['src-js/s2-input-public-resolver.mjs', 'src-js/triangle/input-target-planner.mjs']) {
    const { metafile } = buildSync({ entryPoints: [entry], bundle: true, write: false, metafile: true, platform: 'node', format: 'esm', logLevel: 'silent' });
    for (const [path, input] of Object.entries(metafile.inputs)) {
      if (!path.startsWith('node_modules/')) {
        assert.ok(PUBLIC_MODULES.includes(path), 'unreviewed public dependency: ' + path);
        assert.doesNotMatch(readFileSync(path, 'utf8'), /\bimport\s*\(\s*[^'"\s]/, 'computed import requires review: ' + path);
        seen.add(path);
      } else assert.ok(['node_modules/@haelp/teto/', 'node_modules/@noble/hashes/', 'node_modules/chalk/'].some(prefix => path.startsWith(prefix)), path);
      for (const dependency of input.imports.filter(item => item.external)) {
        const allowed = path === 'scripts/cs1.mjs' ? ['node:fs', 'node:url'] : path === 'node_modules/@noble/hashes/esm/cryptoNode.js' ? ['node:crypto'] : path === 'node_modules/chalk/source/vendor/supports-color/index.js' ? ['node:process', 'node:os', 'node:tty'] : [];
        assert.ok(allowed.includes(dependency.path), path + ' -> ' + dependency.path);
      }
    }
  }
  assert.deepEqual([...seen].sort(), PUBLIC_MODULES);
});
