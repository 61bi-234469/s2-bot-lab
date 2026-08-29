// F8 realised garbage excavation progress (ADR-028).
//
// The units are a before/after delta across one authoritative Simulator
// transition, computed only from garbage physically on the canonical board
// (`G` cells). That is the whole separation from the two families that were
// rejected for scoring board danger: the threat map counted occupied cells in
// the band where *confirmed incoming* rows would land, and native topology
// risk re-weighted absolute board shape everywhere. Neither read a `G` cell.
//
// The property that keeps this family honest is checked, not described: on a
// board with no `G` cells every term is zero, and so are the units. See
// `tests-js/s2-garbage-excavation-evaluator.test.mjs`.
//
// The Simulator stays the sole authority for line clear, spin, attack, B2B,
// combo, cancellation, tank, and garbage. This module reads the transition's
// own stages and the boards on either side of it; it computes no clear, no
// attack, and no tank of its own.

import { applyTransition } from "./transition.mjs";
import { replayAndVerifyS2NodeRecord } from "./s2-node-state-record.mjs";

export const S2_GARBAGE_EXCAVATION_EVALUATOR_ID = "s2-garbage-excavation-evaluator/1";
export const S2_GARBAGE_EXCAVATION_POLICY =
  "realised-garbage-excavation-before-after-delta-guarded/1";

// Frozen in the internal design record 2026-08-20-cc2-s2-f8-realised-garbage-excavation-protocol.md.
export const S2_GARBAGE_EXCAVATION_WEIGHTS = Object.freeze({
  garbageCellsRemoved: 0.1,
  coverReduced: 0.05,
  accessImproved: 0.05,
});
export const S2_GARBAGE_EXCAVATION_CAP = 1;

// The canonical board is 40 rows; the bottom 20 are the visible field. Kept
// local to this module: F8 shares no constant, coefficient, or unit with F7 or
// F9, per the Cloud override record.
const VISIBLE_FIELD_HEIGHT = 20;

/**
 * The three garbage-relative quantities of a single board. Every one of them
 * is zero on a board with no `G` cells, which is what makes the delta zero
 * there too.
 */
export function extractGarbageStructure(board) {
  assertExactBoard(board);
  const { width, height, cells } = board;

  // Which rows carry garbage at all. A garbage hole is an empty cell in one of
  // these rows, and the column it sits in is by definition a column with no
  // `G` cell of its own — so hole detection cannot be folded into the
  // per-garbage-column loop below.
  const garbageRow = new Array(height).fill(false);
  let garbageCells = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (cells[y * width + x] !== "G") continue;
      garbageRow[y] = true;
      garbageCells += 1;
    }
  }

  let coverCells = 0;
  let accessDistance = 0;
  let holeColumns = 0;
  for (let x = 0; x < width; x += 1) {
    let top = height - 1;
    while (top >= 0 && cells[top * width + x] === "_") top -= 1;

    let highestGarbage = -1;
    for (let y = top; y >= 0; y -= 1) {
      if (cells[y * width + x] === "G") {
        highestGarbage = y;
        break;
      }
    }
    // Non-garbage cells stacked on top of this column's own garbage.
    if (highestGarbage !== -1) {
      for (let y = highestGarbage + 1; y <= top; y += 1) {
        if (cells[y * width + x] !== "_") coverCells += 1;
      }
    }

    // How far down from this column's stack top the first garbage hole starts.
    for (let y = 0; y <= top; y += 1) {
      if (cells[y * width + x] !== "_" || !garbageRow[y]) continue;
      accessDistance += top - y;
      holeColumns += 1;
      break;
    }
  }

  return Object.freeze({ garbageCells, coverCells, accessDistance, holeColumns });
}

/**
 * The excavation delta of one transition, before any guard is applied.
 *
 * `accessImproved` is only meaningful while a garbage hole exists on both
 * sides. When the last garbage hole is gone the distance collapses to zero for
 * a reason that is not excavation progress, so the term is reported as zero and
 * the removal term carries that lock instead.
 */
export function extractS2GarbageExcavation(beforeBoard, transition, {
  weights = S2_GARBAGE_EXCAVATION_WEIGHTS,
  cap = S2_GARBAGE_EXCAVATION_CAP,
} = {}) {
  if (transition?.legality?.legal !== true || transition.nextState === null) {
    throw new Error("garbage excavation requires a legal canonical transition");
  }
  if (!Number.isFinite(cap) || cap <= 0) {
    throw new Error("garbage excavation cap must be a positive finite number");
  }
  assertSameGeometry(beforeBoard, transition.nextState.board);
  const before = extractGarbageStructure(beforeBoard);
  const after = extractGarbageStructure(transition.nextState.board);

  const garbageCellsRemoved = Math.max(0, before.garbageCells - after.garbageCells);
  const coverReduced = Math.max(0, before.coverCells - after.coverCells);
  const accessImproved = before.holeColumns > 0 && after.holeColumns > 0
    ? Math.max(0, before.accessDistance - after.accessDistance)
    : 0;

  const raw = weights.garbageCellsRemoved * garbageCellsRemoved +
    weights.coverReduced * coverReduced +
    weights.accessImproved * accessImproved;
  const units = Math.min(cap, raw);

  const outgoingAfterCancel = transition.cancelResult?.outgoingAfterCancel;
  const cancelled = transition.cancelResult?.cancelled;
  if (!Number.isFinite(outgoingAfterCancel) || outgoingAfterCancel < 0 ||
    !Number.isFinite(cancelled) || cancelled < 0) {
    throw new Error("garbage excavation received malformed cancellation stages");
  }

  return Object.freeze({
    before,
    after,
    garbageCellsRemoved,
    coverReduced,
    accessImproved,
    realisedCombat: outgoingAfterCancel + cancelled,
    toppedOut: transition.tankResult?.toppedOut === true,
    visibleTopOutMargin: visibleTopOutMargin(transition.nextState.board),
    guarded: false,
    // Pre-guard. `applyGarbageExcavationGuards` decides the final units.
    units,
    qualifies: units !== 0,
  });
}

/**
 * Excavation must not buy downstack with firepower or with survival.
 *
 * A candidate keeps its units only when, against the control selection's own
 * transition, it does not reduce realised combat and does not worsen post-tank
 * survival. A candidate failing either guard is forced to zero — never to a
 * negative score, because F8 is not a penalty family.
 */
export function applyGarbageExcavationGuards(candidates, controlExcavation) {
  if (!Array.isArray(candidates)) throw new Error("garbage excavation guards require a candidate list");
  if (controlExcavation === null || typeof controlExcavation !== "object") {
    throw new Error("garbage excavation guards require the control excavation record");
  }
  for (const candidate of candidates) {
    const excavation = candidate.excavation;
    const combatOk = excavation.realisedCombat >= controlExcavation.realisedCombat;
    const survivalOk = (!excavation.toppedOut || controlExcavation.toppedOut) &&
      excavation.visibleTopOutMargin >= controlExcavation.visibleTopOutMargin;
    const guarded = !(combatOk && survivalOk);
    const units = guarded ? 0 : excavation.units;
    candidate.excavation = Object.freeze({
      ...excavation,
      guarded,
      combatGuardPassed: combatOk,
      survivalGuardPassed: survivalOk,
      units,
      qualifies: units !== 0,
    });
  }
  return candidates;
}

export function evaluateS2GarbageExcavation(state, record, options = {}) {
  const replayed = replayAndVerifyS2NodeRecord(state, record);
  const transition = applyTransition(
    structuredClone(state),
    structuredClone(record.action),
    state.rulesetId,
  );
  if (transition.legality?.legal !== true || transition.nextState === null) {
    throw new Error("garbage excavation evaluator replay produced no legal transition");
  }
  return Object.freeze({
    stateKey: replayed.stateKey,
    nextStateKey: replayed.nextStateKey,
    ...extractS2GarbageExcavation(state.board, transition, options),
    evaluator: Object.freeze({
      id: S2_GARBAGE_EXCAVATION_EVALUATOR_ID,
      policy: S2_GARBAGE_EXCAVATION_POLICY,
      direction: "higher-is-better",
    }),
  });
}

function visibleTopOutMargin(board) {
  let highest = -1;
  for (let index = board.cells.length - 1; index >= 0; index -= 1) {
    if (board.cells[index] !== "_") {
      highest = Math.floor(index / board.width);
      break;
    }
  }
  return VISIBLE_FIELD_HEIGHT - (highest + 1);
}

function assertSameGeometry(before, after) {
  assertExactBoard(before);
  if (before.width !== after.width || before.height !== after.height) {
    throw new Error("garbage excavation cannot compare boards of different geometry");
  }
}

function assertExactBoard(board) {
  if (board?.fidelity !== "exact") {
    throw new Error("garbage excavation requires an exact canonical board");
  }
  if (!Number.isSafeInteger(board.width) || !Number.isSafeInteger(board.height) ||
    board.width < 1 || board.height < 1) {
    throw new Error("garbage excavation requires a positive integer board geometry");
  }
  if (typeof board.cells !== "string" || board.cells.length !== board.width * board.height ||
    !/^[IJLOSTZG_]+$/.test(board.cells)) {
    throw new Error("garbage excavation requires canonical board cells");
  }
}
