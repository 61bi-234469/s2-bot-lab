import { GarbageQueue } from "@haelp/teto/engine";

export const TRIANGLE_PROVENANCE = Object.freeze({
  package: "@haelp/teto",
  version: "4.2.7",
  commit: "70aa2ad4650346cb5df62a9b10d82a8384a45cc2",
  license: "MIT",
  role: "initial-simulator",
});

export class GarbageTransitionError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const FOUNDATION_GARBAGE_OPTIONS = Object.freeze({
  cap: {
    value: 100,
    marginTime: 0,
    increase: 0,
    absolute: Number.MAX_SAFE_INTEGER,
    max: Number.MAX_SAFE_INTEGER,
  },
  messiness: { change: 0, within: 0, nosame: false, timeout: 0, center: false },
  garbage: { speed: 0, holeSize: 1 },
  multiplier: { value: 1, increase: 0, marginTime: 0 },
  bombs: false,
  seed: 0,
  boardWidth: 10,
  rounding: "down",
  openerPhase: 0,
  specialBonus: false,
});

// Hole geometry is a rule, not a constant. Triangle decides where a tanked row
// leaves its hole from `messiness` and `garbage.holeSize`, and `garbage.speed`
// decides which frame a packet becomes tankable at. Building the queue options
// from the resolved ruleset instead of from the frozen Foundation constant is
// what lets a fixture declare those rules and observe them; before this the
// values were unreachable from a `rulesetId`.
//
// The width comes from the canonical board rather than from the ruleset,
// because it is board geometry: `#reroll_column` draws over
// `boardWidth - (holeSize - 1)` columns.
export function triangleGarbageOptions(rules, { seed, boardWidth }) {
  if (!Number.isSafeInteger(boardWidth) || boardWidth <= 0) {
    throw new Error("garbage options need a positive board width");
  }
  const messiness = rules.garbageMessiness;
  if (
    !Number.isFinite(messiness.change) ||
    !Number.isFinite(messiness.within) ||
    typeof messiness.nosame !== "boolean" ||
    !Number.isSafeInteger(messiness.timeout) ||
    typeof messiness.center !== "boolean"
  ) {
    throw new Error("garbage messiness rules are malformed");
  }
  if (!Number.isSafeInteger(rules.garbageHole.size) || rules.garbageHole.size < 1) {
    throw new Error("garbage hole size must be a positive safe integer");
  }
  if (!Number.isSafeInteger(rules.garbageHole.speed) || rules.garbageHole.speed < 0) {
    throw new Error("garbage speed must be a non-negative safe integer frame count");
  }

  return {
    ...structuredClone(FOUNDATION_GARBAGE_OPTIONS),
    messiness: { ...messiness },
    garbage: { speed: rules.garbageHole.speed, holeSize: rules.garbageHole.size },
    bombs: rules.garbageBombs,
    seed,
    boardWidth,
    rounding: rules.rounding,
    openerPhase: rules.openerPhase,
    specialBonus: rules.specialBonus,
  };
}

export function canonicalGarbageToTriangleSnapshot(garbage) {
  assertExactGarbage(garbage);
  const packets = [...garbage.packets].sort((left, right) => left.order - right.order);
  packets.forEach((packet, index) => {
    if (packet.order !== index) {
      throw new Error("canonical packet order must be contiguous from zero");
    }
  });

  return {
    seed: garbage.generatorState.rngState,
    lastTankTime: garbage.generatorState.lastTankFrame,
    lastColumn:
      garbage.generatorState.lastHoleColumn < 0
        ? null
        : garbage.generatorState.lastHoleColumn,
    sent: garbage.generatorState.sentForOpener,
    hasChangedColumn: garbage.generatorState.holeChanged,
    lastReceivedCount: garbage.generatorState.receivedCountSinceReset,
    queue: packets.map((packet) => ({
      cid: packet.packetId,
      gameid: packet.sourceGameId,
      amount: packet.amount,
      size: packet.holeSize,
      frame: packet.arrivalFrame,
      confirmed: packet.confirmed,
    })),
  };
}

export function triangleSnapshotToCanonical(snapshot, envelope) {
  return {
    packets: snapshot.queue.map((packet, order) => ({
      packetId: packet.cid,
      sourceGameId: packet.gameid,
      amount: packet.amount,
      holeSize: packet.size,
      arrivalFrame: packet.frame,
      confirmed: packet.confirmed,
      order,
    })),
    generatorState: {
      rngState: snapshot.seed,
      lastTankFrame: snapshot.lastTankTime,
      lastHoleColumn: snapshot.lastColumn ?? -1,
      sentForOpener: snapshot.sent,
      holeChanged: snapshot.hasChangedColumn,
      receivedCountSinceReset: snapshot.lastReceivedCount,
    },
    capState: structuredClone(envelope.capState),
    fidelity: envelope.fidelity,
  };
}

export function receiveGarbage(canonical, packet, options = FOUNDATION_GARBAGE_OPTIONS) {
  if (!Number.isSafeInteger(packet.amount) || packet.amount <= 0) {
    throw new GarbageTransitionError(
      "invalid-packet-amount",
      "garbage packet amount must be a positive safe integer",
    );
  }
  if (
    canonical.packets.some(
      (current) =>
        current.packetId === packet.packetId && current.sourceGameId === packet.sourceGameId,
    )
  ) {
    throw new GarbageTransitionError(
      "duplicate-packet",
      "duplicate garbage packet identity",
    );
  }
  const queue = new GarbageQueue(structuredClone(options));
  queue.fromSnapshot(canonicalGarbageToTriangleSnapshot(canonical));
  queue.receive({
    cid: packet.packetId,
    gameid: packet.sourceGameId,
    amount: packet.amount,
    size: packet.holeSize,
    frame: packet.arrivalFrame,
    confirmed: packet.confirmed,
  });
  return triangleSnapshotToCanonical(queue.snapshot(), canonical);
}

// Returns null when the queue holds no packet with that identity. Triangle
// reports the same case as a false return rather than throwing, and a confirm
// for an unknown packet means the caller and the queue disagree about what is
// incoming, which must not be silently ignored.
export function confirmGarbage(canonical, action, options = FOUNDATION_GARBAGE_OPTIONS) {
  if (!Number.isSafeInteger(action.arrivalFrame) || action.arrivalFrame < 0) {
    throw new Error("confirm arrival frame must be a non-negative safe integer");
  }
  const queue = new GarbageQueue(structuredClone(options));
  queue.fromSnapshot(canonicalGarbageToTriangleSnapshot(canonical));
  if (!queue.confirm(action.packetId, action.sourceGameId, action.arrivalFrame)) {
    return null;
  }
  return triangleSnapshotToCanonical(queue.snapshot(), canonical);
}

export function tankGarbage(
  canonical,
  { frame, cap, hard = false },
  options = FOUNDATION_GARBAGE_OPTIONS,
) {
  assertTankAction(frame, cap, hard);
  const queue = new GarbageQueue(structuredClone(options));
  queue.fromSnapshot(canonicalGarbageToTriangleSnapshot(canonical));
  const inserted = queue.tank(frame, cap, hard).map((row) => ({
    packetId: row.cid,
    sourceGameId: row.gameid,
    amount: row.amount,
    holeSize: row.size,
    arrivalFrame: row.frame,
    confirmed: row.confirmed,
    holeColumn: row.column,
  }));
  const nextGarbage = triangleSnapshotToCanonical(queue.snapshot(), canonical);
  nextGarbage.capState.consumedThisTick = inserted.length;

  return {
    tankResult: {
      inserted,
      deferred: structuredClone(nextGarbage.packets),
      toppedOut: false,
    },
    nextGarbage,
  };
}

function assertExactGarbage(garbage) {
  if (garbage.fidelity !== "exact") {
    throw new Error("Triangle snapshot import requires exact canonical garbage state");
  }
  const identities = new Set();
  for (const packet of garbage.packets) {
    const identity = `${packet.packetId}:${packet.sourceGameId}`;
    if (identities.has(identity)) throw new Error("duplicate canonical packet identity");
    identities.add(identity);
  }
}

function assertTankAction(frame, cap, hard) {
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new Error("tank frame must be a non-negative safe integer");
  }
  // A ramping cap is fractional between whole rows. Triangle floors it inside
  // `tank`, so the fractional part is what decides which frame the cap crosses
  // the next row boundary and must not be rounded away here.
  if (!Number.isFinite(cap) || cap < 0) {
    throw new Error("tank cap must be a finite non-negative number");
  }
  if (typeof hard !== "boolean") throw new Error("tank hard flag must be boolean");
}
