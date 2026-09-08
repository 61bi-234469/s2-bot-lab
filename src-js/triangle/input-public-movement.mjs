const TOP_LEVEL_KEYS = Object.freeze([
  "falling", "input", "frame", "subframe", "hold", "holdLocked", "lastSpin",
  "lastWasClear", "glock", "state", "handling",
]);
const FALLING_KEYS = Object.freeze([
  "symbol", "location", "rotation", "aox", "aoy", "fallingRotations", "highestY",
  "ihs", "irs", "keys", "locking", "lockResets", "rotResets", "safeLock", "totalRotations",
]);
const INPUT_KEYS = Object.freeze([
  "lShift", "rShift", "lastShift", "firstInputTime", "time", "lastPieceTime", "keys",
]);
const SHIFT_KEYS = Object.freeze(["held", "arr", "das", "dir"]);
const INPUT_TIME_KEYS = Object.freeze(["start", "zero", "locked", "prev"]);
const INPUT_KEY_KEYS = Object.freeze(["softDrop", "hold", "rotateCW", "rotateCCW", "rotate180"]);
const HANDLING_KEYS = Object.freeze([
  "arr", "das", "dcd", "sdf", "safelock", "cancel", "may20g", "irs", "ihs",
]);
const PIECES = new Set(["i", "j", "l", "o", "s", "t", "z"]);
const SPINS = new Set(["none", "mini", "normal"]);
const HANDLING_MODES = new Set(["off", "hold", "tap"]);
const STATE_MASK = 0x7fff;

/**
 * Copies the movement state needed by a public input planner from a pinned
 * Triangle Engine. The copy is deliberately assembled field by field so that
 * Engine snapshot additions cannot cross the referee/public boundary.
 */
export function projectInputPublicMovement(engine) {
  if (engine === null || typeof engine !== "object" || Array.isArray(engine)) {
    throw new Error("input public movement engine must be an object");
  }
  if (engine.falling === null || typeof engine.falling !== "object" || Array.isArray(engine.falling)) {
    throw new Error("input public movement engine falling is missing");
  }
  if (engine.input === null || typeof engine.input !== "object" || Array.isArray(engine.input)) {
    throw new Error("input public movement engine input is missing");
  }
  if (engine.handling === null || typeof engine.handling !== "object" || Array.isArray(engine.handling)) {
    throw new Error("input public movement engine handling is missing");
  }

  const falling = engine.falling;
  const input = engine.input;
  const handling = engine.handling;
  const projection = {
    falling: {
      symbol: falling.symbol,
      location: [falling.location?.[0], falling.location?.[1]],
      rotation: falling.rotation,
      aox: falling.aox,
      aoy: falling.aoy,
      fallingRotations: falling.fallingRotations,
      highestY: falling.highestY,
      ihs: falling.ihs,
      irs: falling.irs,
      keys: falling.keys,
      locking: falling.locking,
      lockResets: falling.lockResets,
      rotResets: falling.rotResets,
      safeLock: falling.safeLock,
      totalRotations: falling.totalRotations,
    },
    input: {
      lShift: {
        held: input.lShift?.held,
        arr: input.lShift?.arr,
        das: input.lShift?.das,
        dir: input.lShift?.dir,
      },
      rShift: {
        held: input.rShift?.held,
        arr: input.rShift?.arr,
        das: input.rShift?.das,
        dir: input.rShift?.dir,
      },
      lastShift: input.lastShift,
      firstInputTime: input.firstInputTime,
      time: {
        start: input.time?.start,
        zero: input.time?.zero,
        locked: input.time?.locked,
        prev: input.time?.prev,
      },
      lastPieceTime: input.lastPieceTime,
      keys: {
        softDrop: input.keys?.softDrop,
        hold: input.keys?.hold,
        rotateCW: input.keys?.rotateCW,
        rotateCCW: input.keys?.rotateCCW,
        rotate180: input.keys?.rotate180,
      },
    },
    frame: engine.frame,
    subframe: engine.subframe,
    hold: engine.held,
    holdLocked: engine.holdLocked,
    lastSpin: engine.lastSpin,
    lastWasClear: engine.lastWasClear,
    glock: engine.glock,
    state: engine.state,
    handling: {
      arr: handling.arr,
      das: handling.das,
      dcd: handling.dcd,
      sdf: handling.sdf,
      safelock: handling.safelock,
      cancel: handling.cancel,
      may20g: handling.may20g,
      irs: handling.irs,
      ihs: handling.ihs,
    },
  };
  validateInputPublicMovement(projection);
  return projection;
}

/** Validates the closed, Engine-derived public movement projection. */
export function validateInputPublicMovement(value) {
  exactKeys(value, TOP_LEVEL_KEYS, "input public movement");
  validateFalling(value.falling);
  validateInput(value.input);
  validateMovement(value);
  return true;
}

function validateFalling(value) {
  exactKeys(value, FALLING_KEYS, "input public movement falling");
  piece(value.symbol, "input public movement falling.symbol");
  finiteTuple(value.location, 2, "input public movement falling.location");
  rotation(value.rotation, "input public movement falling.rotation");
  finiteFields(value, [
    "aox", "aoy", "fallingRotations", "highestY", "keys", "locking", "lockResets",
    "rotResets", "safeLock", "totalRotations",
  ], "input public movement falling");
  boolean(value.ihs, "input public movement falling.ihs");
  finiteIntegerInRange(value.irs, 0, 3, "input public movement falling.irs");
}

function validateInput(value) {
  exactKeys(value, INPUT_KEYS, "input public movement input");
  validateShift(value.lShift, -1, "input public movement input.lShift");
  validateShift(value.rShift, 1, "input public movement input.rShift");
  finiteFields(value, ["lastShift", "firstInputTime", "lastPieceTime"], "input public movement input");
  if (!Number.isInteger(value.lastShift) || value.lastShift < -1 || value.lastShift > 1) {
    throw new Error("input public movement input.lastShift must be -1, 0, or 1");
  }
  validateInputTime(value.time);
  exactKeys(value.keys, INPUT_KEY_KEYS, "input public movement input.keys");
  for (const key of INPUT_KEY_KEYS) boolean(value.keys[key], `input public movement input.keys.${key}`);
}

function validateShift(value, dir, label) {
  exactKeys(value, SHIFT_KEYS, label);
  boolean(value.held, `${label}.held`);
  finiteFields(value, ["arr", "das"], label);
  if (value.arr < 0 || value.das < 0) throw new Error(`${label} timing values must be non-negative`);
  if (value.dir !== dir) throw new Error(`${label}.dir must be ${dir}`);
}

function validateInputTime(value) {
  exactKeys(value, INPUT_TIME_KEYS, "input public movement input.time");
  finiteFields(value, ["start", "prev"], "input public movement input.time");
  boolean(value.zero, "input public movement input.time.zero");
  boolean(value.locked, "input public movement input.time.locked");
}

function validateMovement(value) {
  finiteFields(value, ["frame", "subframe", "glock"], "input public movement");
  if (value.frame < 0) throw new Error("input public movement frame must be non-negative");
  if (value.subframe < 0) throw new Error("input public movement subframe must be non-negative");
  pieceOrNull(value.hold, "input public movement hold");
  boolean(value.holdLocked, "input public movement holdLocked");
  spinOrNull(value.lastSpin, "input public movement lastSpin");
  boolean(value.lastWasClear, "input public movement lastWasClear");
  if (!Number.isInteger(value.state) || value.state < 0 || value.state > STATE_MASK ||
      (value.state & ~STATE_MASK) !== 0) {
    throw new Error("input public movement state contains unknown flags");
  }
  validateHandling(value.handling);
}

function validateHandling(value) {
  exactKeys(value, HANDLING_KEYS, "input public movement handling");
  finiteFields(value, ["arr", "das", "dcd", "sdf"], "input public movement handling");
  for (const key of ["arr", "das", "dcd", "sdf"]) {
    if (value[key] < 0) throw new Error(`input public movement handling.${key} must be non-negative`);
  }
  for (const key of ["safelock", "cancel", "may20g"]) {
    boolean(value[key], `input public movement handling.${key}`);
  }
  for (const key of ["irs", "ihs"]) {
    if (!HANDLING_MODES.has(value[key])) {
      throw new Error(`input public movement handling.${key} has an unsupported mode`);
    }
  }
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value);
  if (actual.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key)) ||
      actual.some((key) => !expected.includes(key))) {
    throw new Error(`${label} has an invalid field set`);
  }
}

function finiteFields(value, keys, label) {
  for (const key of keys) {
    if (!Number.isFinite(value[key])) throw new Error(`${label}.${key} must be finite`);
  }
}

function finiteTuple(value, length, label) {
  if (!Array.isArray(value) || value.length !== length || !value.every(Number.isFinite)) {
    throw new Error(`${label} must contain ${length} finite values`);
  }
}

function finiteIntegerInRange(value, minimum, maximum, label) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
}

function rotation(value, label) {
  finiteIntegerInRange(value, 0, 3, label);
}

function piece(value, label) {
  if (!PIECES.has(value)) throw new Error(`${label} must be a lower-case tetromino symbol`);
}

function pieceOrNull(value, label) {
  if (value !== null) piece(value, label);
}

function spinOrNull(value, label) {
  if (value !== null && !SPINS.has(value)) throw new Error(`${label} has an unsupported spin value`);
}

function boolean(value, label) {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean`);
}
