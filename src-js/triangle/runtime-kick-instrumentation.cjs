"use strict";

const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");

const OBSERVER = Symbol.for("s2-analysis-engine.triangle-kick-observer/1");

const TRIANGLE_CJS_ENGINE = Object.freeze({
  packageVersion: "4.2.7",
  sha256: "4c42bc15e123c0f98aa99ced78d27e34a5c4872c10664c749b5b241a0f9756c8",
});

const ROTATION_NEEDLE = "    #__internal_rotate(newX, newY, newRotation, rotationDirection, kick, _isIRS = false) {";
const ROTATION_REPLACEMENT = `${ROTATION_NEEDLE}\n        globalThis[Symbol.for("s2-analysis-engine.triangle-kick-observer/1")]?.({\n            kind: "rotation", engine: this, frame: this.frame, subframe: this.subframe,\n            piece: this.falling.symbol, fromRotation: this.falling.rotation,\n            toRotation: newRotation, rotationDirection, kickId: kick.id, kickIndex: kick.index,\n            kickOffset: [kick.kick[0], kick.kick[1]], isIRS: _isIRS\n        });`;

const PRE_LOCK_NEEDLE = "    #lock(hard) {";
const PRE_LOCK_REPLACEMENT = `${PRE_LOCK_NEEDLE}\n        globalThis[Symbol.for("s2-analysis-engine.triangle-kick-observer/1")]?.({\n            kind: "pre-lock", engine: this, frame: this.frame, subframe: this.subframe, hard\n        });`;

const LOCK_NEEDLE = "        this.events.emit(\"falling.lock.pre\", undefined);";
const LOCK_REPLACEMENT = `        globalThis[Symbol.for("s2-analysis-engine.triangle-kick-observer/1")]?.({\n            kind: "lock", engine: this, frame: this.frame, subframe: this.subframe, spin: this.lastSpin,\n            piece: this.falling.symbol, rotation: this.falling.rotation\n        });\n${LOCK_NEEDLE}`;

const RESTORE_NEEDLE = "    fromSnapshot(snapshot) {";
const RESTORE_REPLACEMENT = `${RESTORE_NEEDLE}\n        globalThis[Symbol.for("s2-analysis-engine.triangle-kick-observer/1")]?.({\n            kind: "snapshot-restore", engine: this, frame: this.frame, subframe: this.subframe\n        });`;

/**
 * Loads Triangle's CommonJS Engine through a byte-pinned, in-memory-only
 * instrumentation pass. The package file is never modified or copied.
 *
 * This must run before the supplied require function has loaded
 * `@haelp/teto/engine`.
 */
function loadInstrumentedTriangleEngine(requireFromSource) {
  if (typeof requireFromSource !== "function" || typeof requireFromSource.resolve !== "function") {
    throw new TypeError("a Node createRequire() function is required");
  }
  const enginePath = requireFromSource.resolve("@haelp/teto/engine");
  const packagePath = resolve(enginePath, "../../../package.json");
  const packageBody = JSON.parse(readFileSync(packagePath, "utf8"));
  if (packageBody.version !== TRIANGLE_CJS_ENGINE.packageVersion) {
    throw new Error(`Triangle package version mismatch: ${packageBody.version}`);
  }
  if (requireFromSource.cache[enginePath] !== undefined) {
    throw new Error("Triangle Engine was loaded before kick instrumentation");
  }

  const source = readFileSync(enginePath, "utf8");
  const actualHash = createHash("sha256").update(source).digest("hex");
  if (actualHash !== TRIANGLE_CJS_ENGINE.sha256) {
    throw new Error(`Triangle CJS Engine hash mismatch: ${actualHash}`);
  }
  const transformed = replaceExactlyOnce(
    replaceExactlyOnce(
      replaceExactlyOnce(
        replaceExactlyOnce(source, ROTATION_NEEDLE, ROTATION_REPLACEMENT),
        PRE_LOCK_NEEDLE,
        PRE_LOCK_REPLACEMENT,
      ),
      LOCK_NEEDLE,
      LOCK_REPLACEMENT,
    ),
    RESTORE_NEEDLE,
    RESTORE_REPLACEMENT,
  );

  const instrumentedSha256 = createHash("sha256").update(transformed).digest("hex");
  const originalLoader = requireFromSource.extensions[".js"];
  requireFromSource.extensions[".js"] = (module, filename) => {
    if (filename === enginePath) module._compile(transformed, filename);
    else originalLoader(module, filename);
  };
  try {
    return {
      engineModule: requireFromSource("@haelp/teto/engine"),
      collector: createKickEvidenceCollector(),
      evidence: {
        ...TRIANGLE_CJS_ENGINE,
        path: enginePath,
        transform: "triangle-private-kick-observer/1",
        replacements: 4,
        instrumentedSha256,
      },
    };
  } finally {
    requireFromSource.extensions[".js"] = originalLoader;
  }
}

function createKickEvidenceCollector() {
  const states = new WeakMap();
  const completed = [];
  let active = false;

  const observer = (event) => {
    let state = states.get(event.engine);
    if (state === undefined) {
      state = { lastRotation: null, pendingPreLock: null, invalidatedByRestore: false, locks: [] };
      states.set(event.engine, state);
      completed.push(state);
    }
    if (event.kind === "rotation") {
      state.lastRotation = Object.freeze({
        lastInputWasRotation: true,
        kickIndex: event.kickIndex,
        kickId: event.kickId,
        kickOffset: Object.freeze([...event.kickOffset]),
        piece: event.piece,
        fromRotation: event.fromRotation,
        toRotation: event.toRotation,
        direction: Math.abs(event.rotationDirection) === 2
          ? "180"
          : event.rotationDirection === 1 ? "cw" : "ccw",
        at: Object.freeze({ frame: event.frame, subframe: event.subframe }),
        isIRS: event.isIRS,
      });
      state.invalidatedByRestore = false;
    } else if (event.kind === "pre-lock") {
      state.pendingPreLock = Object.freeze({
        at: Object.freeze({ frame: event.frame, subframe: event.subframe }),
        hard: event.hard,
        snapshot: snapshotEngine(event.engine),
      });
    } else if (event.kind === "snapshot-restore") {
      state.lastRotation = null;
      state.pendingPreLock = null;
      state.invalidatedByRestore = true;
    } else if (event.kind === "lock") {
      const positiveSpin = event.spin !== null && event.spin !== "none";
      const matchingRotation = state.lastRotation !== null
        && state.lastRotation.piece === event.piece
        && state.lastRotation.toRotation === event.rotation;
      const unsupported = positiveSpin && !matchingRotation;
      state.locks.push(Object.freeze({
        at: Object.freeze({ frame: event.frame, subframe: event.subframe }),
        spin: event.spin ?? "none",
        status: unsupported ? "unsupported" : "ready",
        reason: unsupported
          ? state.invalidatedByRestore
            ? "kick-evidence-invalidated-by-snapshot-restore"
            : state.lastRotation === null
              ? "kick-evidence-missing"
              : "kick-evidence-lock-pose-mismatch"
          : null,
        rotationEvidence: positiveSpin && matchingRotation ? state.lastRotation : null,
        preLock: state.pendingPreLock,
        postLockSnapshot: snapshotEngine(event.engine),
      }));
      state.lastRotation = null;
      state.pendingPreLock = null;
      state.invalidatedByRestore = false;
    } else {
      throw new Error(`unknown Triangle instrumentation event ${event.kind}`);
    }
  };

  return Object.freeze({
    activate() {
      if (active || globalThis[OBSERVER] !== undefined) {
        throw new Error("Triangle kick observer is already active");
      }
      globalThis[OBSERVER] = observer;
      active = true;
    },
    deactivate() {
      if (!active || globalThis[OBSERVER] !== observer) {
        throw new Error("Triangle kick observer is not active or was replaced");
      }
      delete globalThis[OBSERVER];
      active = false;
    },
    drain() {
      if (active) throw new Error("deactivate the Triangle kick observer before draining");
      return completed.splice(0).map((state) => Object.freeze([...state.locks]));
    },
  });
}

function snapshotEngine(engine) {
  return typeof engine?.snapshot === "function"
    ? deepFreeze(structuredClone(engine.snapshot()))
    : null;
}

function deepFreeze(value, seen = new WeakSet()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function replaceExactlyOnce(source, needle, replacement) {
  const first = source.indexOf(needle);
  if (first < 0 || source.indexOf(needle, first + needle.length) >= 0) {
    throw new Error(`Triangle instrumentation needle count is not exactly one: ${needle}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + needle.length);
}

module.exports = {
  TRIANGLE_CJS_ENGINE,
  createKickEvidenceCollector,
  loadInstrumentedTriangleEngine,
};
