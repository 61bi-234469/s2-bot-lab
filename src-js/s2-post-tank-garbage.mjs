/**
 * Authoritative garbage observations after a canonical lock has completed
 * cancellation and tanking.  These values are intentionally separate from
 * evaluation-features/2: its deadline fields describe the pre-tank remaining
 * packet set and must not be used to tune a garbage-delay policy.
 */
export const S2_POST_TANK_GARBAGE_OBSERVATION_ID =
  "s2-post-tank-garbage-observation/1";

export function observeS2PostTankGarbage(transition) {
  if (transition?.legality?.legal !== true || transition.nextState === null) {
    throw new Error("post-tank observation requires a legal canonical transition");
  }
  const packets = transition.nextState?.garbage?.packets;
  const deferred = transition.tankResult?.deferred;
  const inserted = transition.tankResult?.inserted;
  if (transition.nextState?.garbage?.fidelity !== "exact" || !Array.isArray(packets)) {
    throw new Error("post-tank observation requires exact canonical next-state garbage");
  }
  if (!Array.isArray(deferred) || !Array.isArray(inserted)) {
    throw new Error("post-tank observation requires a canonical tank result");
  }
  const frame = transition.nextState?.time?.logicalFrame;
  const clock = transition.nextState?.provenance?.clock;
  if (clock?.kind !== "synthetic-fixed-lock-step" ||
    !Number.isSafeInteger(clock.framesPerLock) || clock.framesPerLock < 1 ||
    !Number.isSafeInteger(frame) || frame < 0) {
    throw new Error("post-tank observation requires an exact canonical fixed-lock clock");
  }
  const framesPerLock = clock.framesPerLock;
  assertPackets(packets, "next-state garbage");
  assertPackets(deferred, "tank deferred garbage");
  assertInsertedRows(inserted);
  if (packetIdentity(deferred) !== packetIdentity(packets)) {
    throw new Error("post-tank deferred packets do not match canonical next-state garbage");
  }
  const cancelled = transition.cancelResult?.cancelled;
  if (!Number.isFinite(cancelled) || cancelled < 0) {
    throw new Error("post-tank observation requires an exact canonical cancellation result");
  }
  const confirmed = packets.filter((packet) => packet.confirmed);
  const amount = sumAmount(packets);
  const confirmedAmount = sumAmount(confirmed);
  return Object.freeze({
    id: S2_POST_TANK_GARBAGE_OBSERVATION_ID,
    frame,
    framesPerLock,
    remainingIncoming: amount,
    confirmedIncoming: confirmedAmount,
    dueIncoming: sumAmount(confirmed.filter((packet) => packet.arrivalFrame <= frame)),
    incomingNextLock: sumAmount(confirmed.filter((packet) => packet.arrivalFrame <= frame + framesPerLock)),
    tankedIncoming: sumAmount(inserted),
    cancelled,
  });
}

function assertPackets(packets, label) {
  for (const packet of packets) {
    if (!Number.isSafeInteger(packet?.packetId) || packet.packetId < 0 ||
      !Number.isSafeInteger(packet?.sourceGameId) || packet.sourceGameId < 0 ||
      !Number.isSafeInteger(packet?.amount) || packet.amount < 1 ||
      !Number.isSafeInteger(packet?.holeSize) || packet.holeSize < 1 ||
      !Number.isSafeInteger(packet?.arrivalFrame) || packet.arrivalFrame < 0 ||
      typeof packet?.confirmed !== "boolean" || !Number.isSafeInteger(packet?.order) || packet.order < 0) {
      throw new Error(`post-tank observation found malformed ${label}`);
    }
  }
}

function assertInsertedRows(rows) {
  for (const row of rows) {
    if (!Number.isSafeInteger(row?.packetId) || row.packetId < 0 ||
      !Number.isSafeInteger(row?.sourceGameId) || row.sourceGameId < 0 ||
      !Number.isSafeInteger(row?.amount) || row.amount < 1 ||
      !Number.isSafeInteger(row?.holeSize) || row.holeSize < 1 ||
      !Number.isSafeInteger(row?.arrivalFrame) || row.arrivalFrame < 0 ||
      typeof row?.confirmed !== "boolean" ||
      !Number.isSafeInteger(row?.holeColumn) || row.holeColumn < 0) {
      throw new Error("post-tank observation found malformed tank inserted garbage");
    }
  }
}

function packetIdentity(packets) {
  return JSON.stringify(packets.map((packet) => ({
    packetId: packet.packetId,
    sourceGameId: packet.sourceGameId,
    amount: packet.amount,
    holeSize: packet.holeSize,
    arrivalFrame: packet.arrivalFrame,
    confirmed: packet.confirmed,
    order: packet.order,
  })).sort((left, right) => left.packetId - right.packetId || left.order - right.order));
}

function sumAmount(packets) {
  return packets.reduce((total, packet) => total + packet.amount, 0);
}
