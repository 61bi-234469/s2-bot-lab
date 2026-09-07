import { performKick } from '@haelp/teto/engine';

const NO_ROTATION = Object.freeze({ lastInputWasRotation: false, kickIndex: null, kickId: null, kickOffset: null });
const ROTATIONS = Object.freeze({ rotateCW: 1, rotateCCW: -1, rotate180: 2 });
const STATE_SLEEP = 128;

/**
 * Referee-only observation of the Engine's actual rotation operations.
 *
 * The public rotate methods are wrapped at installation time. The pinned
 * Engine's keydown path calls its private rotation helper instead of those
 * methods, so its public `falling` object is narrowly proxied as well: the
 * helper's x/y/rotation/counter writes are observed without reading a private
 * snapshot or changing the execution path. Both paths use the same
 * performKick prediction and the same immediate pose/counter checks.
 */
export function createInputRotationObserver(engine) {
  if (engine === null || typeof engine !== 'object') throw new TypeError('an Engine instance is required');
  if (engine.handling?.irs !== 'off' || engine.handling?.ihs !== 'off') {
    throw new Error('canonical input rotation observer requires IRS/IHS off');
  }

  let rotationWitness = null;
  let rotationPrefix = null;
  let privateRotation = null;
  let suppressPrivateObservation = false;
  let fallingProxy = null;
  const proxies = new WeakMap();

  const descriptor = Object.getOwnPropertyDescriptor(engine, 'falling');
  if (descriptor === undefined || !('value' in descriptor)) throw new Error('Engine falling field is unavailable');

  const capture = falling => ({
    falling,
    symbol: falling.symbol,
    location: [falling.location[0], falling.location[1]],
    rotation: falling.rotation,
    totalRotations: falling.totalRotations,
    lockResets: falling.lockResets,
    rotResets: falling.rotResets,
    aox: falling.aox,
    aoy: falling.aoy,
  });

  const expectedRotation = (before, amount) => {
    const rotation = ((before.rotation + amount) % 4 + 4) % 4;
    const kick = performKick(
      engine.kickTableName,
      before.symbol,
      before.location,
      [before.aox, before.aoy],
      !engine.misc.movement.infinite && before.totalRotations > engine.misc.movement.lockResets + 15,
      before.falling.states[rotation],
      before.rotation,
      rotation,
      engine.board.state,
    );
    const allowed = (engine.state & STATE_SLEEP) === 0;
    if (!allowed || !kick) return { success: false, before, rotation, kick: null };
    const newLocation = kick === true ? before.location : kick.newLocation;
    return {
      success: true,
      before,
      rotation,
      kick,
      x: newLocation[0],
      y: newLocation[1],
      totalRotations: before.totalRotations + 1,
      lockResets: Math.min(before.lockResets + 1, 31),
      rotResets: Math.min(before.rotResets + 1, 63),
      evidence: {
        lastInputWasRotation: true,
        kickIndex: kick === true ? 0 : kick.index,
        kickId: kick === true ? '00' : kick.id,
        kickOffset: kick === true ? [0, 0] : [...kick.kick],
      },
    };
  };

  const samePoseAndCounters = (actual, expected) => actual.falling === expected.before.falling &&
    actual.rotation === expected.rotation && actual.location[0] === expected.x &&
    actual.location[1] === expected.y && actual.totalRotations === expected.totalRotations &&
    actual.lockResets === expected.lockResets && actual.rotResets === expected.rotResets;

  const samePose = (actual, expected) => actual.falling === expected.before.falling &&
    actual.rotation === expected.rotation && actual.location[0] === expected.x &&
    actual.location[1] === expected.y;

  const unchangedPoseAndCounters = (actual, before) => actual.falling === before.falling &&
    actual.rotation === before.rotation && actual.location[0] === before.location[0] &&
    actual.location[1] === before.location[1] && actual.totalRotations === before.totalRotations &&
    actual.lockResets === before.lockResets && actual.rotResets === before.rotResets;

  const recordRotation = (falling, evidence) => {
    rotationWitness = { falling, evidence };
  };

  const verifyPublicResult = (before, expected, result) => {
    const actual = capture(engine.falling);
    if (result !== expected.success) {
      throw new Error('Engine rotation result differs from performKick prediction');
    }
    if (!expected.success) {
      if (!unchangedPoseAndCounters(actual, before)) {
        throw new Error('blocked Engine rotation changed pose or counters');
      }
      return;
    }
    if (!samePoseAndCounters(actual, expected)) {
      throw new Error('Engine rotation differs from performKick at its execution call');
    }
    recordRotation(engine.falling, expected.evidence);
  };

  const verifyPrivateResult = () => {
    if (privateRotation === null) return;
    const actual = capture(privateRotation.before.falling);
    if (!samePoseAndCounters(actual, privateRotation.expected)) {
      throw new Error('Engine rotation differs from performKick at its execution call');
    }
    recordRotation(fallingProxy, privateRotation.expected.evidence);
    privateRotation = null;
  };

  const wrapFalling = falling => {
    if (falling === null || typeof falling !== 'object') return falling;
    const existing = proxies.get(falling);
    if (existing !== undefined) return existing;
    const proxy = new Proxy(falling, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        // Tetromino methods use private fields. Bind them to the real target
        // so the observation proxy does not become a private-field receiver.
        return typeof value === 'function' ? value.bind(target) : value;
      },
      set(target, property, value) {
        if (!suppressPrivateObservation && (property === 'x' || property === 'y')) {
          verifyPrivateResult();
          if (rotationPrefix === null) rotationPrefix = capture(target);
        }

        const result = Reflect.set(target, property, value, target);

        if (!suppressPrivateObservation && property === 'rotation' && rotationPrefix !== null) {
          const amount = ((value - rotationPrefix.rotation) % 4 + 4) % 4;
          const expected = expectedRotation(rotationPrefix, amount);
          // A successful Engine rotation writes x, y, then rotation. The
          // rotation setter is therefore the earliest exact post-call pose.
          const actual = {
            falling: target,
            rotation: target.rotation,
            location: [target.location[0], target.location[1]],
            totalRotations: target.totalRotations,
            lockResets: target.lockResets,
            rotResets: target.rotResets,
          };
          const poseExpected = { ...expected, before: { ...expected.before, falling: target } };
          if (!expected.success || !samePose(actual, poseExpected)) {
            throw new Error('Engine rotation differs from performKick at its execution call');
          }
          privateRotation = { before: rotationPrefix, expected };
          rotationPrefix = null;
        }

        if (!suppressPrivateObservation && property === 'totalRotations' && privateRotation !== null) {
          verifyPrivateResult();
        }
        return result;
      },
    });
    proxies.set(falling, proxy);
    return proxy;
  };

  fallingProxy = wrapFalling(descriptor.value);
  Object.defineProperty(engine, 'falling', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get() { return fallingProxy; },
    set(value) {
      verifyPrivateResult();
      rotationPrefix = null;
      fallingProxy = wrapFalling(value);
    },
  });

  for (const [name, amount] of Object.entries(ROTATIONS)) {
    const original = engine[name];
    if (typeof original !== 'function') throw new Error(`Engine.${name} is unavailable`);
    engine[name] = (...args) => {
      const before = capture(engine.falling);
      const expected = expectedRotation(before, amount);
      suppressPrivateObservation = true;
      let result;
      try {
        result = original(...args);
      } finally {
        suppressPrivateObservation = false;
      }
      verifyPublicResult(before, expected, result);
      return result;
    };
  }

  return {
    checkBoundary() {
      verifyPrivateResult();
      if (rotationPrefix !== null) throw new Error('incomplete Engine rotation observation');
    },

    beforeTick(_events) {
      verifyPrivateResult();
      if (rotationPrefix !== null) throw new Error('incomplete Engine rotation observation');
    },

    beforeMerge() {
      verifyPrivateResult();
      if (rotationPrefix !== null) throw new Error('incomplete Engine rotation observation');
    },

    evidenceForLock() {
      verifyPrivateResult();
      const evidence = engine.lastSpin !== null && rotationWitness?.falling === engine.falling
        ? rotationWitness.evidence : NO_ROTATION;
      if (engine.lastSpin !== null && engine.lastSpin !== 'none' && rotationWitness?.falling !== engine.falling) {
        throw new Error('unqualified spin evidence');
      }
      return evidence;
    },
  };
}
