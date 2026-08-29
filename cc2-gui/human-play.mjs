/* Browser-side piece control for the 1P side of a match.
 *
 * Two things live here: the placement geometry the player moves a piece through,
 * and the DAS/ARR/SDF repeat engine that turns held keys into that movement.
 *
 * The geometry is never restated as constants. `/api/placement-geometry`
 * publishes the block layout and the kick table that the server's own placement
 * adapter uses, so a piece the player sees resting in a slot is the same
 * placement the S2 Simulator will evaluate, down to the kick that put it there.
 *
 * Nothing here decides a match result: a lock is only a claim about where the
 * piece came to rest, which the server re-evaluates and witnesses. */

export const BOARD_WIDTH = 10;
export const BOARD_HEIGHT = 40;
export const VISIBLE_ROWS = 20;
// Canonical spawn row for the lowest cell of a piece: the first row above the
// visible field, matching where the queue hands a piece over.
export const SPAWN_ROW = VISIBLE_ROWS;
export const FRAME_DURATION_MS = 1000 / 60;

const NO_ROTATION = Object.freeze({ lastInputWasRotation: false, kickIndex: null });
const ROTATION_INDEX = Object.freeze({ spawn: 0, right: 1, reverse: 2, left: 3 });
const ROTATION_NAMES = Object.freeze(["spawn", "right", "reverse", "left"]);

export function pieceCells(geometry, placement) {
  const blocks = geometry.blocks[placement.piece]?.[placement.rotation];
  if (blocks === undefined) throw new Error(`unsupported placement ${placement.piece} ${placement.rotation}`);
  return blocks.map(([dx, dy]) => [placement.x + dx, placement.y + dy]);
}

export function fits(board, cells) {
  return cells.every(([x, y]) =>
    x >= 0 && x < BOARD_WIDTH && y >= 0 && y < BOARD_HEIGHT && board[y][x] === null);
}

export function isPlaceable(geometry, board, placement) {
  return fits(board, pieceCells(geometry, placement));
}

/**
 * Spawns a piece where the queue hands it over, then lets it settle just far
 * enough to be visible.
 *
 * A piece is handed over above the visible field, which with no natural gravity
 * would leave it permanently out of sight. Stepping down only until its highest
 * cell reaches the top visible row keeps it on screen without inventing a
 * falling speed: on a stack that already reaches the ceiling the piece simply
 * stays where the queue put it, and the lock that follows tops the board out
 * under exactly the same rule the bots are held to.
 */
export function spawnPlacement(geometry, board, piece, usedHold = false) {
  const rotation = geometry.spawnRotation[piece] ?? "spawn";
  const blocks = geometry.blocks[piece]?.[rotation];
  if (blocks === undefined) throw new Error(`unsupported spawn piece ${piece}`);
  const lowest = Math.min(...blocks.map(([, dy]) => dy));
  const highest = Math.max(...blocks.map(([, dy]) => dy));
  let placement = {
    piece,
    rotation,
    x: piece === "O" ? 4 : 3,
    y: SPAWN_ROW - lowest,
    usedHold,
    rotationEvidence: NO_ROTATION,
  };
  if (!isPlaceable(geometry, board, placement)) return null;
  while (placement.y + highest > VISIBLE_ROWS - 1) {
    const lower = { ...placement, y: placement.y - 1 };
    if (!isPlaceable(geometry, board, lower)) break;
    placement = lower;
  }
  return placement;
}

/** Moves a piece by whole cells, or returns `null` when the move is blocked. */
export function shifted(geometry, board, placement, dx, dy) {
  const moved = { ...placement, x: placement.x + dx, y: placement.y + dy, rotationEvidence: NO_ROTATION };
  return isPlaceable(geometry, board, moved) ? moved : null;
}

/** The resting position the piece hard drops to. */
export function dropped(geometry, board, placement) {
  let current = placement;
  for (;;) {
    const lower = { ...current, y: current.y - 1 };
    if (!isPlaceable(geometry, board, lower)) return current;
    current = lower;
  }
}

/** The furthest position a piece can be shifted to in one direction. */
export function shiftedToEnd(geometry, board, placement, dx) {
  let current = placement;
  for (;;) {
    const moved = shifted(geometry, board, current, dx, 0);
    if (moved === null) return current;
    current = moved;
  }
}

/**
 * Rotates using the published kick table, in the order the placement adapter
 * tests it, and records the kick that succeeded as the placement's rotation
 * evidence. `amount` is 1 for clockwise, -1 for counter-clockwise, 2 for 180.
 */
export function rotated(geometry, board, placement, amount) {
  if (amount === 2 && geometry.allow180 === false) return null;
  const from = ROTATION_INDEX[placement.rotation];
  const to = (((from + amount) % 4) + 4) % 4;
  const rotation = ROTATION_NAMES[to];
  const direct = {
    ...placement,
    rotation,
    rotationEvidence: { lastInputWasRotation: true, kickIndex: 0, kickId: "00", kickOffset: [0, 0] },
  };
  if (isPlaceable(geometry, board, direct)) return direct;

  const kickId = `${from}${to}`;
  const tests = geometry.kicks[placement.piece]?.[kickId];
  if (!Array.isArray(tests)) return null;
  for (let index = 0; index < tests.length; index += 1) {
    const [dx, dy] = tests[index];
    const kicked = {
      ...placement,
      rotation,
      x: placement.x + dx,
      y: placement.y + dy,
      rotationEvidence: { lastInputWasRotation: true, kickIndex: index, kickId, kickOffset: [dx, dy] },
    };
    if (isPlaceable(geometry, board, kicked)) return kicked;
  }
  return null;
}

/** The placement payload `/api/match/human-lock` accepts. */
export function lockSubmission(placement) {
  return {
    piece: placement.piece,
    rotation: placement.rotation,
    x: placement.x,
    y: placement.y,
    usedHold: placement.usedHold,
    rotationEvidence: placement.rotationEvidence.lastInputWasRotation
      ? {
        lastInputWasRotation: true,
        kickIndex: placement.rotationEvidence.kickIndex,
        kickId: placement.rotationEvidence.kickId,
        kickOffset: [...placement.rotationEvidence.kickOffset],
      }
      : { lastInputWasRotation: false, kickIndex: null },
  };
}

/**
 * The held-key repeat engine, ported from `fumen-mobile-fork`'s `piece_das`.
 *
 * Every repeat runs on one 60 Hz task list rather than on a timer per key, so
 * horizontal auto-shift and soft drop stay on the same frame grid and the soft
 * drop priority setting can order them. Timer functions are injected so the
 * engine can be exercised without a browser.
 */
export function createPieceRepeat({
  now = () => (typeof performance === "undefined" ? Date.now() : performance.now()),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  const holds = new Map();
  const softDropHolds = new Map();
  const repeatTasks = new Set();
  const instantSoftDropTasks = new Set();
  let ticker = null;
  let epoch = 0;
  let frame = 0;
  let softDropFirst = false;

  const stopTickerIfIdle = () => {
    if (repeatTasks.size === 0 && ticker !== null) {
      clearTimer(ticker);
      ticker = null;
    }
  };

  const onFrame = () => {
    for (const kind of softDropFirst ? ["softDrop", "shift"] : ["shift", "softDrop"]) {
      for (const task of [...repeatTasks]) {
        if (task.kind !== kind || !repeatTasks.has(task)) continue;
        task.accumulated += 1;
        while (task.framesPerStep <= task.accumulated && repeatTasks.has(task)) {
          task.accumulated -= task.framesPerStep;
          task.apply();
        }
      }
    }
  };

  const scheduleFrame = () => {
    if (repeatTasks.size === 0) return;
    const nextAt = epoch + Math.floor(FRAME_DURATION_MS * (frame + 1));
    ticker = setTimer(() => {
      ticker = null;
      frame += 1;
      onFrame();
      scheduleFrame();
    }, Math.max(0, nextAt - now()));
  };

  const register = (kind, framesPerStep, apply) => {
    const task = { kind, framesPerStep, accumulated: 0, apply };
    repeatTasks.add(task);
    if (ticker === null) {
      epoch = now();
      frame = 0;
      scheduleFrame();
    }
    return task;
  };

  const unregister = (task) => {
    if (task !== null) repeatTasks.delete(task);
    stopTickerIfIdle();
  };

  const startArr = (hold) => {
    unregister(hold.initialTask);
    hold.initialTask = null;
    hold.arrActive = true;
    const repeat = hold.arrFrames <= 0
      ? () => {
        if (!hold.softDropPriority || instantSoftDropTasks.size === 0) {
          hold.moveToEnd();
          return;
        }
        // ARR 0 resolves the whole horizontal path at once. With an infinite
        // soft drop held as well, the two are interleaved so a gap between two
        // ledges cannot be skipped over at the original height.
        for (let index = 0; index < BOARD_WIDTH; index += 1) {
          for (const task of [...instantSoftDropTasks]) if (repeatTasks.has(task)) task.apply();
          hold.move();
        }
        for (const task of [...instantSoftDropTasks]) if (repeatTasks.has(task)) task.apply();
      }
      : hold.move;
    repeat();
    hold.arrTask = register("shift", hold.arrFrames <= 0 ? 1 : hold.arrFrames, repeat);
  };

  const cancelHoldTimers = (hold) => {
    hold.version += 1;
    if (hold.dasTimer !== null) {
      clearTimer(hold.dasTimer);
      hold.dasTimer = null;
    }
    if (hold.cutTimer !== null) {
      clearTimer(hold.cutTimer);
      hold.cutTimer = null;
    }
    unregister(hold.initialTask);
    hold.initialTask = null;
    unregister(hold.arrTask);
    hold.arrTask = null;
    hold.arrActive = false;
  };

  const restartArrAfter = (hold, delayMs) => {
    const version = hold.version;
    if (delayMs <= 0) {
      if (holds.get(hold.id) === hold && hold.version === version) startArr(hold);
      return;
    }
    hold.cutTimer = setTimer(() => {
      hold.cutTimer = null;
      if (holds.get(hold.id) === hold && hold.version === version) startArr(hold);
    }, delayMs);
  };

  return {
    startShift(id, { move, moveToEnd, dasFrames, arrFrames, softDropPriority = false }) {
      this.end(id);
      softDropFirst = softDropPriority;
      const hold = {
        id,
        move,
        moveToEnd,
        arrFrames,
        softDropPriority,
        dasTimer: null,
        initialTask: null,
        arrTask: null,
        cutTimer: null,
        arrActive: false,
        version: 0,
      };
      holds.set(id, hold);
      if (softDropPriority) {
        // The first step waits one frame so a soft drop pressed on the same
        // frame is applied first, exactly as the reference engine orders it.
        hold.initialTask = register("shift", 1, () => {
          if (holds.get(id) !== hold) return;
          move();
          unregister(hold.initialTask);
          hold.initialTask = null;
        });
      } else {
        move();
      }
      hold.dasTimer = setTimer(() => {
        hold.dasTimer = null;
        startArr(hold);
      }, framesToMilliseconds(dasFrames));
    },
    startSoftDrop(id, move, sdf) {
      this.endSoftDrop(id);
      move();
      const task = register("softDrop", sdf === Infinity ? 1 : 60 / (sdf * SOFT_DROP_BASE_CELLS_PER_SECOND), move);
      softDropHolds.set(id, task);
      if (sdf === Infinity) instantSoftDropTasks.add(task);
    },
    endSoftDrop(id) {
      const task = softDropHolds.get(id);
      if (task === undefined) return;
      instantSoftDropTasks.delete(task);
      unregister(task);
      softDropHolds.delete(id);
    },
    end(id) {
      const hold = holds.get(id);
      if (hold !== undefined) {
        cancelHoldTimers(hold);
        holds.delete(id);
      }
      this.endSoftDrop(id);
    },
    endAll() {
      for (const id of [...holds.keys()]) this.end(id);
      for (const id of [...softDropHolds.keys()]) this.endSoftDrop(id);
    },
    /**
     * Pauses auto-shift for the DCD delay after a rotation or hold. A hold that
     * is still waiting for its initial DAS timer is left alone: DAS Cut is for
     * charged movement, so a tap followed by a rotation must not gain a delay.
     */
    cutDas(dcdFrames) {
      if (!(dcdFrames > 0)) return;
      for (const hold of [...holds.values()]) {
        if (!hold.arrActive) continue;
        unregister(hold.arrTask);
        hold.arrTask = null;
        hold.arrActive = false;
        if (hold.cutTimer !== null) clearTimer(hold.cutTimer);
        hold.version += 1;
        restartArrAfter(hold, framesToMilliseconds(dcdFrames));
      }
    },
    /**
     * Drops the initial DAS delay for every direction still held when a new
     * piece spawns, so a charged direction keeps its charge across the lock.
     */
    activateDasCut(dcdFrames) {
      for (const hold of [...holds.values()]) {
        cancelHoldTimers(hold);
        restartArrAfter(hold, framesToMilliseconds(dcdFrames ?? 0));
      }
    },
    isActive(id) {
      return holds.has(id) || softDropHolds.has(id);
    },
  };
}

// TETR.IO reads soft drop speed as max(gravity, 0.05G) x SDF. With no natural
// gravity the 0.05G floor always wins, so one SDF step is 3 cells per second.
export const SOFT_DROP_BASE_CELLS_PER_SECOND = 3;

export function framesToMilliseconds(frames) {
  return Math.max(0, frames) * FRAME_DURATION_MS;
}
