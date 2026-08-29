import { legal } from "@haelp/teto/engine";

import {
  EVALUATION_SCORE_SEMANTICS,
  evaluatorModelIdentity,
  extractEvaluationFeatures,
  scoreEvaluationFeatures,
} from "./evaluation.mjs";
import { applyTransition } from "./transition.mjs";
import { RULESET_IDS } from "./ruleset-profiles.mjs";
import { fullStateKey } from "./state-keys.mjs";
import {
  ROTATIONS,
  canonicalBoardToTriangle,
  createPlacedTetromino,
} from "./triangle/placement-adapter.mjs";

export const SIMPLE_S2_BOT_ID = "s2-final-placement-depth1-baseline/1";
export const SIMPLE_S2_MOVEMENT_MODEL = "final-placement-no-frame-reachability";

const NO_SPIN_EVIDENCE = Object.freeze({
  lastInputWasRotation: false,
  kickIndex: null,
  kickId: null,
  kickOffset: null,
});
const ROTATION_NAMES = Object.freeze(Object.keys(ROTATIONS));

// Deliberately simple comparison baseline: enumerate every collision-free,
// supported final resting placement, then let the authoritative Simulator
// transition and the shared evaluator rank it. This does not claim that a
// frame input sequence can reach the placement and cannot propose a spin.
export function analyzeSimpleS2FinalPlacements(state, options = {}) {
  const topN = options.topN ?? 5;
  const allowHold = options.allowHold ?? true;
  if (!Number.isSafeInteger(topN) || topN < 1 || topN > 64) {
    throw new Error("simple S2 bot topN must be an integer from 1 to 64");
  }
  if (typeof allowHold !== "boolean") throw new Error("simple S2 bot allowHold must be a boolean");

  const placements = enumerateFinalPlacements(state, { allowHold });
  const candidates = [];
  for (const placement of placements) {
    const transition = applyTransition(state, { kind: "placement", placement });
    if (!transition.legality.legal) continue;
    if (transition.lockResult.spin !== "none") {
      throw new Error("simple S2 bot produced a spin without rotation evidence");
    }
    const features = extractEvaluationFeatures(transition);
    candidates.push({
      placement,
      transition,
      features,
      score: scoreEvaluationFeatures(features),
    });
  }
  candidates.sort(compareCandidates);

  return {
    bot: {
      id: SIMPLE_S2_BOT_ID,
      movementModel: SIMPLE_S2_MOVEMENT_MODEL,
      depth: 1,
    },
    evaluator: evaluatorModelIdentity(),
    scoreSemantics: EVALUATION_SCORE_SEMANTICS,
    positionFingerprint: fullStateKey(state),
    rulesetId: state.rulesetId,
    generatedMoves: candidates.length,
    moves: candidates.slice(0, topN),
  };
}

export function enumerateFinalPlacements(state, options = {}) {
  assertState(state);
  const allowHold = options.allowHold ?? true;
  if (typeof allowHold !== "boolean") throw new Error("simple S2 bot allowHold must be a boolean");
  const board = canonicalBoardToTriangle(state.board);
  const sources = [{ piece: state.pieces.current, usedHold: false }];
  if (allowHold && state.pieces.holdAvailable) {
    sources.push({
      piece: state.pieces.hold ?? state.pieces.known[0] ?? null,
      usedHold: true,
    });
  }

  const placements = [];
  const seen = new Set();
  for (const source of sources) {
    if (source.piece === null) continue;
    for (const rotation of ROTATION_NAMES) {
      // All tetromino cells are within four cells of their canonical origin.
      // The deliberately broad finite box is filtered by exact board bounds.
      for (let y = -4; y < state.board.height + 4; y += 1) {
        for (let x = -4; x < state.board.width + 4; x += 1) {
          const placement = {
            piece: source.piece,
            rotation,
            x,
            y,
            usedHold: source.usedHold,
            rotationEvidence: NO_SPIN_EVIDENCE,
          };
          const blocks = createPlacedTetromino(state.board, placement).absoluteBlocks;
          if (!withinBoard(blocks, board) || !legal(blocks, board.state)) continue;
          const below = blocks.map(([blockX, blockY]) => [blockX, blockY - 1]);
          if (withinBoard(below, board) && legal(below, board.state)) continue;
          const identity = `${Number(source.usedHold)}:${cellIdentity(blocks)}`;
          if (seen.has(identity)) continue;
          seen.add(identity);
          placements.push(placement);
        }
      }
    }
  }
  placements.sort(comparePlacements);
  return placements;
}

function withinBoard(blocks, board) {
  return blocks.every(([x, y]) =>
    x >= 0 && x < board.width && y >= 0 && y < board.fullHeight
  );
}

function cellIdentity(blocks) {
  return blocks.map(([x, y]) => `${x},${y}`).sort().join("|");
}

function comparePlacements(left, right) {
  return Number(left.usedHold) - Number(right.usedHold) ||
    left.piece.localeCompare(right.piece, "en") ||
    ROTATIONS[left.rotation] - ROTATIONS[right.rotation] ||
    left.x - right.x || left.y - right.y;
}

function compareCandidates(left, right) {
  return right.score - left.score || comparePlacements(left.placement, right.placement);
}

function assertState(state) {
  if (state.rulesetId !== RULESET_IDS.s2Observed) {
    throw new Error("simple S2 bot requires the observed S2 ruleset");
  }
  if (state.board?.fidelity !== "exact" || state.pieces?.fidelity !== "exact") {
    throw new Error("simple S2 bot requires exact board and pieces");
  }
  if (!Number.isSafeInteger(state.board.width) || !Number.isSafeInteger(state.board.height)) {
    throw new Error("simple S2 bot requires integer board geometry");
  }
  const holdSource = state.pieces.holdAvailable
    ? state.pieces.hold ?? state.pieces.known[0] ?? null
    : null;
  if (state.pieces.current === null && holdSource === null) {
    throw new Error("simple S2 bot requires a current or HOLD source piece");
  }
}
