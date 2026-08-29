/**
 * ReplayIR point space and per-frame visual state.
 *
 * Ported from `fumen-mobile-fork` (`src/lib/ttrm/timeline.ts`, MIT).  For one
 * player, every position with a settled board is one array:
 *
 *   index 0      : initial   round start (zero placements), frame 0
 *   index 1..L   : locks[index - 1]
 *   index L + 1  : terminal  the final replayed frame
 *
 * The index is the displayed turn number, so `locks[0]` is turn 1.
 *
 * Pure functions only. This module is also served to the browser, so it must
 * not import anything that is not itself pure.
 */

import { FIELD_HEIGHT, FIELD_WIDTH, PIECE } from "./pieces.mjs";
import { gaugeAtFrame, getGarbageTimeline, tankedAtFrame } from "./replay-garbage.mjs";

export const FRAMES_PER_SECOND = 60;

export function pointCount(player) {
  return player.locks.length + 2;
}

export function lastPointIndex(player) {
  return pointCount(player) - 1;
}

export function clampPointIndex(player, index) {
  return Math.min(lastPointIndex(player), Math.max(0, index));
}

export function pointAt(player, index) {
  const clamped = clampPointIndex(player, index);
  if (clamped === 0) {
    const { initial } = player;
    return {
      index: 0,
      kind: "initial",
      frame: initial.frame,
      field: initial.field,
      hold: initial.hold,
      current: initial.current,
      next: initial.next,
      clippedRowCount: 0,
    };
  }
  if (clamped === lastPointIndex(player)) {
    const { terminal } = player;
    return {
      index: clamped,
      kind: "terminal",
      frame: terminal.frame,
      field: terminal.field,
      hold: terminal.hold,
      current: terminal.current,
      next: terminal.next,
      clippedRowCount: terminal.clippedRowCount,
    };
  }
  const lock = player.locks[clamped - 1];
  return {
    index: clamped,
    kind: "lock",
    frame: lock.frame,
    field: lock.fieldAfter,
    hold: lock.hold,
    current: lock.current,
    next: lock.next,
    clippedRowCount: lock.clippedRowCount,
  };
}

export function frameAt(player, index) {
  return pointAt(player, index).frame;
}

/**
 * The last point settled at or before `frame`.  Several locks can share one
 * frame, so the last entry satisfying `<=` is the answer.
 */
export function indexAtFrame(player, frame) {
  if (player.terminal.frame <= frame) return lastPointIndex(player);
  const { locks } = player;
  if (locks.length === 0 || frame < locks[0].frame) return 0;
  let low = 0;
  let high = locks.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (locks[middle].frame <= frame) low = middle;
    else high = middle;
  }
  return low + 1;
}

function visualFrame(player, frame) {
  const finite = Number.isFinite(frame) ? frame : 0;
  return Math.min(player.terminal.frame, Math.max(0, Math.floor(finite)));
}

/** The last change point with `frame <= target`. One boundary rule for all views. */
export function changePointAtFrame(points, frame) {
  if (points.length === 0 || frame < points[0].frame) return undefined;
  let low = 0;
  let high = points.length;
  while (low + 1 < high) {
    const middle = (low + high) >>> 1;
    if (points[middle].frame <= frame) low = middle;
    else high = middle;
  }
  return points[low];
}

function sourceHeightOf(field) {
  for (let y = FIELD_HEIGHT - 1; y >= 0; y -= 1) {
    const start = y * FIELD_WIDTH;
    if (field.slice(start, start + FIELD_WIDTH).some((cell) => cell !== PIECE.EMPTY)) return y + 1;
  }
  return 0;
}

// A hand-written IR (tests, older evidence) has no visual timeline; the settled
// point space is the fallback so every reader keeps working.
function fallbackBoardAtFrame(player, frame) {
  const index = indexAtFrame(player, frame);
  if (index === 0) {
    return {
      frame: player.initial.frame,
      field: player.initial.field,
      sourceHeight: sourceHeightOf(player.initial.field),
      clippedRowCount: 0,
    };
  }
  if (index === lastPointIndex(player)) {
    return {
      frame: player.terminal.frame,
      field: player.terminal.field,
      sourceHeight: player.terminal.sourceHeight,
      clippedRowCount: player.terminal.clippedRowCount,
    };
  }
  const lock = player.locks[index - 1];
  return {
    frame: lock.frame,
    field: lock.fieldAfter,
    sourceHeight: lock.sourceHeight,
    clippedRowCount: lock.clippedRowCount,
  };
}

export function boardAtFrame(player, frame) {
  const target = visualFrame(player, frame);
  return changePointAtFrame(player.visual?.boards ?? [], target) ?? fallbackBoardAtFrame(player, target);
}

export function queueAtFrame(player, frame) {
  const target = visualFrame(player, frame);
  const point = changePointAtFrame(player.visual?.queues ?? [], target);
  if (point !== undefined) return point;
  const fallback = pointAt(player, indexAtFrame(player, target));
  return { frame: fallback.frame, hold: fallback.hold, current: fallback.current, next: fallback.next };
}

export function activeAtFrame(player, frame) {
  const target = visualFrame(player, frame);
  if (player.terminal.frame <= target) return undefined;
  const active = changePointAtFrame(player.visual?.active ?? [], target);
  const point = pointAt(player, indexAtFrame(player, target));
  // With no new active piece since the latest lock, the piece just placed must
  // not be redrawn as if it were still falling: nothing is shown until spawn.
  if (point.kind === "lock" && (active === undefined || active.frame < point.frame)) return undefined;
  return active;
}

export function garbageAtFrame(player, frame) {
  const target = visualFrame(player, frame);
  return changePointAtFrame(player.visual?.garbage ?? [], target);
}

export function visualAtFrame(player, frame) {
  const target = visualFrame(player, frame);
  const board = boardAtFrame(player, target);
  const queue = queueAtFrame(player, target);
  return {
    frame: target,
    field: board.field,
    sourceHeight: board.sourceHeight,
    clippedRowCount: board.clippedRowCount,
    active: activeAtFrame(player, target),
    hold: queue.hold,
    current: queue.current,
    next: queue.next,
    garbage: garbageAtFrame(player, target),
  };
}

// The pose captured at `falling.lock.pre`. The visual timeline holds each
// frame's final state, so on a hard-dropped turn the piece is still airborne
// one frame earlier: the resting pose is only available from the lock itself.
function preLockActiveOf(lock, frame) {
  if (lock.cells === undefined || lock.cells.length === 0) return undefined;
  return {
    frame,
    piece: lock.piece,
    rotation: lock.rotation,
    x: lock.x,
    y: lock.y,
    cells: lock.cells.map(([x, y]) => [x, y]),
  };
}

// The pre-placement board must not already contain this turn's cells. Two locks
// inside one frame can leave the earlier placement out of the change point, and
// showing that as-is would be a different position entirely.
function fitsOnBoard(field, cells) {
  return cells.every(([x, y]) => {
    if (x < 0 || FIELD_WIDTH <= x || y < 0 || FIELD_HEIGHT <= y) return true;
    return field[y * FIELD_WIDTH + x] === PIECE.EMPTY;
  });
}

/**
 * The moment just before turn `index` locks: placed but not yet settled.
 * Undefined for a turn that cannot be reconstructed, and the caller then falls
 * back to the settled point.
 */
export function preLockPointAt(player, index) {
  const lock = player.locks[index - 1];
  if (index < 1 || lock === undefined || lock.frame <= 0) return undefined;
  const previous = player.locks[index - 2];
  if (previous !== undefined && lock.frame <= previous.frame) return undefined;
  const frame = lock.frame - 1;
  const active = preLockActiveOf(lock, frame);
  if (active === undefined) return undefined;
  const board = boardAtFrame(player, frame);
  if (!fitsOnBoard(board.field, active.cells)) return undefined;
  return {
    index,
    frame,
    confirmedIndex: index - 1,
    visual: {
      frame,
      active,
      field: board.field,
      sourceHeight: board.sourceHeight,
      clippedRowCount: board.clippedRowCount,
      // HOLD does not move between the placement and the next spawn, so the
      // lock's value is also the pre-lock one. Putting the piece that spawned
      // after the lock back at the head of NEXT restores the pre-lock queue.
      hold: lock.hold,
      current: lock.piece,
      next: lock.current !== null ? [lock.current, ...lock.next] : lock.next,
      garbage: garbageAtFrame(player, frame),
    },
  };
}

/** Where turn stepping lands: just before the placement settles when available. */
export function stopFrameAt(player, index) {
  return preLockPointAt(player, index)?.frame ?? frameAt(player, index);
}

export function framesToSeconds(frames) {
  return frames / FRAMES_PER_SECOND;
}

/** `m:ss.s`, used for both the cursor and the total. */
export function formatFrameTime(frames) {
  const seconds = Math.max(0, framesToSeconds(frames));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest < 10 ? "0" : ""}${rest.toFixed(1)}`;
}

/**
 * Cumulative stats at one point of the point space.
 *
 * TETR.IO's `received` is deliberately absent: it was found to be
 * unreproducible from a replay. The two garbage values reported instead
 * (`gauge`, `tanked`) are self-consistent under the engine, and the gauge is
 * read at the cursor frame rather than at the settled lock frame so that the
 * gauge bar and the stat row cannot disagree.
 */
export function statsAt(player, index, frame) {
  const point = pointAt(player, index);
  const placed = point.kind === "initial"
    ? 0
    : point.kind === "terminal" ? player.locks.length : point.index;
  const counted = player.locks.slice(0, placed);
  const totals = counted.reduce((sum, lock) => ({
    attack: sum.attack + lock.attack,
    garbageCleared: sum.garbageCleared + (lock.garbageCleared ?? 0),
  }), { attack: 0, garbageCleared: 0 });
  const seconds = framesToSeconds(point.frame);
  const last = counted[counted.length - 1];
  const garbage = getGarbageTimeline(player);
  const garbageFrame = frame !== undefined ? frame : point.frame;
  const pps = seconds > 0 ? placed / seconds : 0;
  const apm = seconds > 0 ? totals.attack * 60 / seconds : 0;
  // APP and Area come from the TetraStats-derived formulas (`tetrio_report_app`);
  // VS reproduces `Engine#dynamicStats` from attack and cleared rows.
  const app = pps > 0 ? apm / (pps * 60) : 0;
  const vs = seconds > 0 ? (totals.attack + totals.garbageCleared) * 100 / seconds : 0;
  const dsSecond = vs / 100 - apm / 60;
  const dsPiece = pps > 0 ? dsSecond / pps : 0;
  const garbageEfficiency = pps > 0 ? ((app * dsSecond) / pps) * 2 : 0;
  const area = pps > 0
    ? apm + pps * 45 + vs * 0.444 + app * 185 + dsSecond * 175 + dsPiece * 450 + garbageEfficiency * 315
    : 0;
  return {
    placed,
    seconds,
    pps,
    apm,
    app,
    vs,
    area,
    attack: totals.attack,
    garbageCleared: totals.garbageCleared,
    gauge: gaugeAtFrame(garbage, garbageFrame),
    tanked: tankedAtFrame(garbage, garbageFrame),
    frame: point.frame,
    totalLocks: player.locks.length,
    b2b: last !== undefined ? Math.max(0, last.clear.b2b) : 0,
    // The engine's combo counter sits at -1 while no combo is running; the
    // viewer rounds that up to 0.
    ren: last !== undefined ? Math.max(0, last.clear.ren) : 0,
    lastClear: last !== undefined ? last.clear : null,
  };
}
