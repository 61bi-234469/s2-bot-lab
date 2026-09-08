import { Board, Mino, Tetromino, kickData, legal } from "@haelp/teto/engine";

import { canonicalize } from "../scripts/cs1.mjs";
import { resolveDynamicValue } from "./dynamic-values.mjs";
import { FEATURE_SCHEMA_ID, FEATURE_SCHEMA_VERSION, scoreEvaluationFeatures } from "./evaluation.mjs";
import { resolveS2AmountOnlyPublicRules } from "./s2-amount-only-public-rules.mjs";
import { advanceS2AmountOnlySearchState } from "./s2-amount-only-search-advance.mjs";
import { assessS2AmountOnlySolvency } from "./s2-amount-only-post-tank-solvency.mjs";
import { classifyS2ConversionQualifiedRenFinisher } from "./s2-conversion-qualified-ren-finisher-classification.mjs";
import { createTuningModel } from "./cc2-s2-tuning-model.mjs";
import { advanceChain, calculateSurge } from "./triangle/chain-adapter.mjs";

export const S2_AMOUNT_ONLY_PUBLIC_CANDIDATES_ID = "s2-amount-only-public-candidates/1";
export const S2_AMOUNT_ONLY_PUBLIC_SPIN_POLICY = "amount-only-public-s2-kickset-witness/1";

const ROTATIONS = Object.freeze({ spawn: 0, right: 1, reverse: 2, left: 3 });
const ORIENTATIONS = Object.freeze({ north: "spawn", east: "right", south: "reverse", west: "left" });
const ROTATION_NAMES = Object.freeze(["spawn", "right", "reverse", "left"]);
const CELL_TO_MINO = Object.freeze({
  I: Mino.I, J: Mino.J, L: Mino.L, O: Mino.O, S: Mino.S, T: Mino.T, Z: Mino.Z, G: Mino.GARBAGE,
});
const MINO_TO_CELL = Object.freeze(
  Object.fromEntries(Object.entries(CELL_TO_MINO).map(([cell, mino]) => [mino, cell])),
);
const ORIGINS = Object.freeze({
  I: Object.freeze({ north: [-1, -2], east: [-2, -2], south: [-2, -1], west: [-1, -1] }),
  O: Object.freeze({ north: [0, 0], east: [0, -1], south: [-1, -1], west: [-1, 0] }),
  JLSTZ: Object.freeze({ north: [-1, -1], east: [-1, -1], south: [-1, -1], west: [-1, -1] }),
});
const HARD_DROP = Object.freeze({ lastInputWasRotation: false, kickIndex: null, kickId: null, kickOffset: null });

/**
 * Builds and ranks the live selector's candidates from the ADR-062 public
 * decision state. This module deliberately has no generic GUI conversion,
 * full-state evaluator, garbage adapter, or transition dependency.
 */
export function selectS2AmountOnlyPublicCandidate(decision, moves, options = {}) {
  const ranked = rankS2AmountOnlyPublicCandidates(decision, moves, options);
  const control = ranked.candidates[0];
  const solvent = ranked.candidates.find((candidate) => candidate.solvency.solvent);
  const selected = control.solvency.solvency < 0 && solvent !== undefined ? solvent : control;
  return Object.freeze({
    placement: structuredClone(selected.placement),
    score: selected.s2Score,
    selectedCc2Rank: selected.cc2Rank,
    candidates: ranked.candidates.map((candidate) => Object.freeze({
      cc2Rank: candidate.cc2Rank,
      selectionScore: candidate.selectionScore,
      solvency: candidate.solvency.solvency,
    })),
  });
}

export function rankS2AmountOnlyPublicCandidates(decision, moves, {
  candidateLimit = 16,
  rankPenalty = 25,
  adjustmentScale = 28,
  weightProfileId = "sparse-s2",
  weights = {},
  allowCompleteReturnedPrefix = false,
} = {}) {
  assertOptions({ candidateLimit, rankPenalty, adjustmentScale, allowCompleteReturnedPrefix });
  const state = publicStateFromDecision(decision);
  if (!Array.isArray(moves) || moves.length === 0 || (!allowCompleteReturnedPrefix && moves.length < candidateLimit)) {
    throw new Error("amount-only public selector requires a complete CC2 candidate prefix");
  }
  const prefix = moves.slice(0, allowCompleteReturnedPrefix ? Math.min(candidateLimit, moves.length) : candidateLimit);
  const identities = prefix.map(canonicalize);
  if (new Set(identities).size !== identities.length) {
    throw new Error("amount-only public selector prefix contains duplicate identities");
  }
  const witnesses = createPublicSpinWitnesses(state);
  const model = createTuningModel(weightProfileId, weights);
  const candidates = [];
  for (const [cc2Rank, move] of prefix.entries()) {
    const requested = cc2MoveToPublicPlacement(state, move);
    const placement = witnesses.get(finalPoseKey(requested)) ?? requested;
    const projection = projectS2AmountOnlyPublicLock(state, placement, decision.incoming);
    if (projection === null) continue;
    const conversion = evaluatePublicConversion(state, placement, projection, decision.incoming);
    const features = publicFeatures(projection);
    const s2Score = scoreEvaluationFeatures(features, model);
    const solvency = assessS2AmountOnlySolvency(projection);
    candidates.push({
      cc2Rank,
      identity: identities[cc2Rank],
      move,
      placement,
      projection,
      conversion,
      features,
      s2Score,
      solvency,
      selectionScore: s2Score + adjustmentScale * conversion.units - cc2Rank * rankPenalty,
    });
  }
  if (candidates.length === 0) throw new Error("amount-only public selector has no legal candidate");
  candidates.sort((left, right) => right.selectionScore - left.selectionScore || left.cc2Rank - right.cc2Rank ||
    left.identity.localeCompare(right.identity, "en"));
  return Object.freeze({ state, candidates: Object.freeze(candidates) });
}

export function projectS2AmountOnlyPublicLock(state, placement, incoming) {
  const rules = resolveS2AmountOnlyPublicRules(state.rulesetId);
  const locked = lockPublicPlacement(state, placement, rules);
  if (locked === null) return null;
  const advance = advanceS2AmountOnlySearchState(incoming, {
    lines: locked.lines,
    spin: locked.spin,
    perfectClear: locked.perfectClear,
    comboAfter: locked.chain.comboAfter,
    b2bAfter: locked.chain.b2bAfter,
    b2bBefore: state.chain.b2b,
  });
  const surge = calculateSurge(
    locked.chain.brokenB2bCount,
    rules.b2bCharging,
    resolveDynamicValue(rules.garbageMultiplier, state.time),
  );
  const lockBoard = Object.freeze({ ...state.board, cells: locked.cells, fidelity: "exact" });
  const occupiedHeightAfterLock = occupiedHeight(lockBoard);
  const visibleMarginAfterLock = lockBoard.visibleHeight - occupiedHeightAfterLock;
  return Object.freeze({
    id: "s2-amount-only-public-lock-projection/1",
    legal: true,
    lines: locked.lines,
    spin: locked.spin,
    comboAfter: locked.chain.comboAfter,
    b2bAfter: locked.chain.b2bAfter,
    cancelledRows: advance.cancelledRows,
    tankRows: advance.tankRows,
    remainingRows: advance.remainingRows,
    outgoingBeforeCancel: advance.outgoingBeforeCancel,
    outgoingAfterCancel: advance.outgoingAfterCancel,
    surgeSent: surge.amount,
    visibleHeight: lockBoard.visibleHeight,
    occupiedHeightAfterLock,
    visibleMarginAfterLock,
    amountToppedOut: occupiedHeightAfterLock + advance.tankRows > lockBoard.visibleHeight,
    lockBoard,
    piecesAfterLock: Object.freeze({ ...locked.pieces, fidelity: "exact" }),
  });
}

function publicStateFromDecision(decision) {
  if (decision?.id !== "s2-amount-only-decision-state/1") throw new Error("invalid amount-only public decision state");
  const { board, pieces, chain, lockTime } = decision;
  if (!Number.isSafeInteger(board?.width) || !Number.isSafeInteger(board?.height) ||
      board.width !== 10 || board.height !== 40 || board.visibleHeight !== 20 ||
      typeof board.cells !== "string" || board.cells.length !== board.width * board.height || !/^[IJLOSTZG_]+$/.test(board.cells)) {
    throw new Error("amount-only public decision has invalid board");
  }
  if (!Array.isArray(pieces?.known) || !Number.isInteger(chain?.combo) || !Number.isInteger(chain?.b2b) ||
      !Number.isInteger(lockTime?.logicalFrame) || !Number.isInteger(lockTime?.piecesPlaced)) {
    throw new Error("amount-only public decision has invalid public state");
  }
  return Object.freeze({
    rulesetId: decision.rulesetId,
    board: Object.freeze({ ...board, fidelity: "exact" }),
    pieces: Object.freeze({ ...pieces, known: Object.freeze([...pieces.known]), fidelity: "exact" }),
    chain: Object.freeze({ ...chain, fidelity: "exact" }),
    time: Object.freeze({ ...lockTime, fidelity: "exact" }),
  });
}

function cc2MoveToPublicPlacement(state, move) {
  const { type: piece, orientation, x, y } = move?.location ?? {};
  const rotation = ORIENTATIONS[orientation];
  const family = piece === "I" || piece === "O" ? piece : ["J", "L", "S", "T", "Z"].includes(piece) ? "JLSTZ" : null;
  const origin = family === null ? undefined : ORIGINS[family][orientation];
  if (rotation === undefined || origin === undefined || !Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new Error("unsupported CC2 public placement");
  }
  return {
    piece, rotation, x: x + origin[0], y: y + origin[1],
    usedHold: piece !== state.pieces.current,
    rotationEvidence: HARD_DROP,
  };
}

function lockPublicPlacement(state, placement, rules) {
  const available = placement.usedHold ? (state.pieces.hold ?? state.pieces.known[0] ?? null) : state.pieces.current;
  if (placement.piece !== available || (placement.usedHold && !state.pieces.holdAvailable) || !(placement.rotation in ROTATIONS)) return null;
  const board = boardFromCells(state.board);
  const piece = placedTetromino(state.board, placement);
  const blocks = piece.absoluteBlocks;
  if (!legal(blocks, board.state) || legal(blocks.map(([x, y]) => [x, y - 1]), board.state)) return null;
  const spin = detectPublicSpin(piece, board, placement, rules);
  board.add(...blocks.map(([x, y]) => [{ mino: piece.symbol, connections: 0 }, x, y]));
  const cleared = board.clearLines();
  const perfectClear = board.perfectClear;
  const chain = advanceChain({ combo: state.chain.combo, b2b: state.chain.b2b }, {
    lines: cleared.lines, spin, piece: placement.piece, perfectClear, garbageCleared: cleared.garbageCleared,
  }, { perfectClearB2bBonus: rules.perfectClearB2bBonus });
  return { lines: cleared.lines, spin, perfectClear, chain, cells: cellsFromBoard(board), pieces: advancePieces(state.pieces, placement.usedHold) };
}

function createPublicSpinWitnesses(state) {
  const rules = resolveS2AmountOnlyPublicRules(state.rulesetId);
  const witnesses = new Map();
  for (const candidate of generatePublicReachablePlacements(state, rules)) {
    if (!candidate.rotationEvidence.lastInputWasRotation) continue;
    const locked = lockPublicPlacement(state, candidate, rules);
    if (locked === null || locked.spin === "none") continue;
    const key = finalPoseKey(candidate);
    const old = witnesses.get(key);
    if (old === undefined || spinRank(locked.spin) > spinRank(old.spin)) witnesses.set(key, { ...candidate, spin: locked.spin });
  }
  return new Map([...witnesses].map(([key, candidate]) => [key, withoutSpin(candidate)]));
}

function* generatePublicReachablePlacements(state, rules) {
  const board = boardFromCells(state.board);
  const kickTable = kickData[rules.kickTable];
  if (kickTable === undefined) throw new Error(`unknown public kick table ${rules.kickTable}`);
  const sources = [{ usedHold: false, piece: state.pieces.current }];
  if (state.pieces.holdAvailable) sources.push({ usedHold: true, piece: state.pieces.hold ?? state.pieces.known[0] ?? null });
  for (const source of sources) {
    if (source.piece === null) continue;
    const queue = [];
    const seen = new Set();
    for (const rotation of ROTATION_NAMES) for (let x = -4; x < state.board.width + 4; x += 1) {
      const seed = { piece: source.piece, rotation, x, y: 0, usedHold: source.usedHold, rotationEvidence: HARD_DROP };
      const topY = highestInBoundsY(board, seed);
      if (topY !== null && legalAt(board, seed, topY)) enqueue(queue, seen, { ...seed, y: topY });
    }
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (!legalAt(board, current, current.y - 1)) yield current;
      for (const dx of [-1, 1]) {
        const next = { ...current, x: current.x + dx, rotationEvidence: HARD_DROP };
        if (legalAt(board, next, next.y)) enqueue(queue, seen, next);
      }
      const down = { ...current, y: current.y - 1, rotationEvidence: HARD_DROP };
      if (legalAt(board, down, down.y)) enqueue(queue, seen, down);
      for (const amount of rules.allow180 === false ? [1, -1] : [1, -1, 2]) {
        const rotated = rotatePublicWithKicks(board, current, amount, kickTable);
        if (rotated !== null) enqueue(queue, seen, rotated);
      }
    }
  }
}

function rotatePublicWithKicks(board, current, amount, table) {
  const from = ROTATIONS[current.rotation];
  const to = ((from + amount) % 4 + 4) % 4;
  const rotation = ROTATION_NAMES[to];
  const direct = { ...current, rotation, rotationEvidence: { lastInputWasRotation: true, kickIndex: 0, kickId: "00", kickOffset: [0, 0] } };
  if (legalAt(board, direct, direct.y)) return direct;
  const kickId = `${from}${to}`;
  const tests = (table[`${current.piece.toLowerCase()}_kicks`] ?? table.kicks)?.[kickId];
  if (!Array.isArray(tests)) return null;
  for (let index = 0; index < tests.length; index += 1) {
    const [dx, dy] = tests[index];
    const kicked = { ...current, rotation, x: current.x + dx, y: current.y - dy,
      rotationEvidence: { lastInputWasRotation: true, kickIndex: index, kickId, kickOffset: [dx, -dy] } };
    if (legalAt(board, kicked, kicked.y)) return kicked;
  }
  return null;
}

function evaluatePublicConversion(state, placement, projection, incoming) {
  const noRen = projectS2AmountOnlyPublicLock({ ...state, chain: { ...state.chain, combo: 0 } }, placement, incoming);
  const withheld = projectS2AmountOnlyPublicLock({ ...state, chain: { ...state.chain, b2b: 0 } }, placement, incoming);
  const renCombatGain = realisedCombat(projection) - realisedCombat(noRen);
  const releaseValue = realisedCombat(projection) - realisedCombat(withheld);
  const setupClear = (projection.spin === "mini" && projection.lines >= 1) || (projection.spin === "normal" && projection.lines === 1);
  const setupWitnessed = setupClear && publicNextTsdWitness(projection, state.rulesetId, state.time);
  return Object.freeze(classifyS2ConversionQualifiedRenFinisher({
    comboBefore: state.chain.combo, comboAfter: projection.comboAfter,
    b2bBefore: state.chain.b2b, b2bAfter: projection.b2bAfter,
    lines: projection.lines, spin: projection.spin, cancelled: projection.cancelledRows,
    renCombatGain, setupWitnessed, surgeSent: projection.surgeSent, releaseValue,
  }));
}

function publicNextTsdWitness(projection, rulesetId, time) {
  const state = { rulesetId, board: projection.lockBoard, pieces: projection.piecesAfterLock,
    chain: { combo: projection.comboAfter, b2b: projection.b2bAfter }, time };
  if (!(state.pieces.current === "T" || (state.pieces.holdAvailable && state.pieces.hold === "T"))) return false;
  let scanned = 0;
  const rules = resolveS2AmountOnlyPublicRules(rulesetId);
  for (const placement of generatePublicReachablePlacements(state, rules)) {
    if (placement.piece !== "T" || ++scanned > 64) continue;
    const locked = lockPublicPlacement(state, placement, rules);
    if (locked?.spin === "normal" && locked.lines === 2) return true;
  }
  return false;
}

function publicFeatures(projection) {
  const heights = [];
  let holes = 0;
  for (let x = 0; x < projection.lockBoard.width; x += 1) {
    let highest = -1;
    for (let y = projection.lockBoard.height - 1; y >= 0; y -= 1) if (projection.lockBoard.cells[y * 10 + x] !== "_") { highest = y; break; }
    heights.push(highest + 1);
    for (let y = 0; y < highest; y += 1) if (projection.lockBoard.cells[y * 10 + x] === "_") holes += 1;
  }
  const bumpiness = heights.slice(1).reduce((sum, height, index) => sum + Math.abs(height - heights[index]), 0);
  return Object.freeze({
    $schema: FEATURE_SCHEMA_ID, schemaVersion: FEATURE_SCHEMA_VERSION,
    aggregateHeight: heights.reduce((sum, value) => sum + value, 0), maxHeight: Math.max(...heights), holes, bumpiness,
    toppedOut: projection.amountToppedOut ? 1 : 0, remainingIncoming: 0, deferredIncoming: projection.remainingRows,
    dueIncoming: 0, incomingNextLock: 0, confirmedIncoming: 0, tankedIncoming: projection.tankRows,
    visibleTopOutMargin: projection.visibleMarginAfterLock - projection.tankRows,
    outgoingBeforeCancel: projection.outgoingBeforeCancel, outgoingAfterCancel: projection.outgoingAfterCancel,
    cancelled: projection.cancelledRows, combo: projection.comboAfter, b2b: projection.b2bAfter,
    chargingLevel: projection.b2bAfter, surgeSent: projection.surgeSent,
  });
}

function boardFromCells(canonical) {
  const board = new Board({ width: canonical.width, height: canonical.height, buffer: 0 });
  for (let i = 0; i < canonical.cells.length; i += 1) if (canonical.cells[i] !== "_") {
    board.add([{ mino: CELL_TO_MINO[canonical.cells[i]], connections: 0 }, i % canonical.width, Math.floor(i / canonical.width)]);
  }
  return board;
}
function cellsFromBoard(board) { return board.state.flatMap((row) => row.map((tile) => tile === null ? "_" : MINO_TO_CELL[tile.mino])).join(""); }
function placedTetromino(board, placement) {
  const piece = new Tetromino({ symbol: CELL_TO_MINO[placement.piece], initialRotation: ROTATIONS[placement.rotation], boardHeight: board.height, boardWidth: board.width });
  piece.x = placement.x; piece.y = placement.y + (placement.piece === "I" ? 3 : placement.piece === "O" ? 1 : 2); return piece;
}
function legalAt(board, placement, y) {
  const blocks = placedTetromino(board, { ...placement, y }).absoluteBlocks;
  return !blocks.some(([x, by]) => x < 0 || by < 0 || x >= board.width || by >= board.fullHeight) && legal(blocks, board.state);
}
function highestInBoundsY(board, placement) {
  const blocks = placedTetromino(board, { ...placement, y: 0 }).absoluteBlocks;
  const high = Math.max(...blocks.map(([, y]) => y)); const low = Math.min(...blocks.map(([, y]) => y));
  const top = board.fullHeight - 1 - high; return top + low < 0 ? null : top;
}
function enqueue(queue, seen, placement) {
  const evidence = placement.rotationEvidence;
  const id = `${placement.x}:${placement.y}:${placement.rotation}:${evidence.lastInputWasRotation ? 1 : 0}:${isFinOrTst(evidence) ? 1 : 0}`;
  if (!seen.has(id)) { seen.add(id); queue.push(placement); }
}
function detectPublicSpin(piece, board, placement, rules) {
  if (!placement.rotationEvidence.lastInputWasRotation || rules.spinBonuses === "none") return "none";
  const all = [[-1, 0], [1, 0], [0, 1], [0, -1]].every(([dx, dy]) => !legal(piece.absoluteBlocks.map(([x, y]) => [x + dx, y + dy]), board.state));
  let tSpin = "none";
  if (piece.symbol === Mino.T) {
    const x = placement.x + 1; const y = placement.y + 1;
    const corners = [board.occupied(x - 1, y + 1), board.occupied(x + 1, y + 1), board.occupied(x - 1, y - 1), board.occupied(x + 1, y - 1)];
    if (corners.filter(Boolean).length >= 3) {
      const front = { spawn: [0, 1], right: [1, 3], reverse: [2, 3], left: [0, 2] }[placement.rotation];
      tSpin = front.every((index) => corners[index]) || isFinOrTst(placement.rotationEvidence) ? "normal" : "mini";
    }
  }
  if (rules.spinBonuses === "T-spins") return tSpin;
  if (rules.spinBonuses === "all-mini+") return spinRank(tSpin) >= 1 ? tSpin : all ? "mini" : "none";
  if (rules.spinBonuses === "all+") return spinRank(tSpin) >= 1 ? tSpin : all ? (piece.symbol === Mino.T ? "mini" : "normal") : "none";
  return tSpin;
}
function advancePieces(pieces, usedHold) {
  if (!usedHold) return { current: pieces.known[0] ?? null, hold: pieces.hold, known: pieces.known.slice(1), holdAvailable: true };
  if (pieces.hold !== null) return { current: pieces.known[0] ?? null, hold: pieces.current, known: pieces.known.slice(1), holdAvailable: true };
  return { current: pieces.known[1] ?? null, hold: pieces.current, known: pieces.known.slice(2), holdAvailable: true };
}
function finalPoseKey(placement) { return `${placement.piece}:${placement.rotation}:${placement.x}:${placement.y}:${placement.usedHold ? 1 : 0}`; }
function withoutSpin(candidate) { const { spin: _, ...placement } = candidate; return placement; }
function spinRank(spin) { return ({ none: 0, mini: 1, normal: 2 })[spin] ?? -1; }
function isFinOrTst(evidence) { const [x, y] = evidence.kickOffset ?? []; return ((evidence.kickId === "23" || evidence.kickId === "03") && x === 1 && y === -2) || ((evidence.kickId === "21" || evidence.kickId === "01") && x === -1 && y === -2); }
function occupiedHeight(board) { for (let y = board.height - 1; y >= 0; y -= 1) for (let x = 0; x < board.width; x += 1) if (board.cells[y * board.width + x] !== "_") return y + 1; return 0; }
function realisedCombat(projection) { return projection.outgoingAfterCancel + projection.cancelledRows; }
function assertOptions({ candidateLimit, rankPenalty, adjustmentScale, allowCompleteReturnedPrefix }) {
  if (!Number.isInteger(candidateLimit) || candidateLimit < 1 || candidateLimit > 64 || !Number.isFinite(rankPenalty) || rankPenalty < 0 || rankPenalty > 100 || !Number.isFinite(adjustmentScale) || adjustmentScale < 0 || adjustmentScale > 100 || typeof allowCompleteReturnedPrefix !== "boolean") throw new Error("amount-only public selector has invalid bounded settings");
}
