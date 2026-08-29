import { GarbageQueue } from "@haelp/teto/engine";

import {
  FOUNDATION_GARBAGE_OPTIONS,
  canonicalGarbageToTriangleSnapshot,
  triangleSnapshotToCanonical,
} from "./garbage-adapter.mjs";

export function cancelOutgoing(
  canonical,
  outgoingChunks,
  context = { piecesPlaced: 0, openerPhase: 0, legacyOpenerPhase: false },
  garbageOptions = FOUNDATION_GARBAGE_OPTIONS,
) {
  if (!outgoingChunks.every((amount) => Number.isInteger(amount) && amount >= 0)) {
    throw new Error("outgoing chunks must be non-negative integers");
  }
  if (!Number.isInteger(context.piecesPlaced) || context.piecesPlaced < 0) {
    throw new Error("piecesPlaced must be a non-negative integer");
  }

  // Cancelling a packet to zero can reroll the hole column, so the cancel path
  // needs the same messiness rules the tank does.
  const options = structuredClone(garbageOptions);
  options.seed = canonical.generatorState.rngState;
  options.openerPhase = context.openerPhase;
  const queue = new GarbageQueue(options);
  queue.fromSnapshot(canonicalGarbageToTriangleSnapshot(canonical));

  const remainingOutgoing = [];
  const cancelledPackets = [];
  for (let index = 0; index < outgoingChunks.length; index += 1) {
    const chunk = outgoingChunks[index];
    const [remaining, cancelled] = queue.cancel(chunk, context.piecesPlaced, {
      openerPhase: context.legacyOpenerPhase,
    });
    mergeCancelled(cancelledPackets, cancelled);

    // Triangle stops cancelling as soon as one attack chunk survives. Later
    // chunks are emitted untouched and, importantly, do not advance the
    // garbage queue's opener/sent accounting.
    if (remaining > 0) {
      remainingOutgoing.push(remaining, ...outgoingChunks.slice(index + 1));
      break;
    }
  }

  const nextGarbage = triangleSnapshotToCanonical(queue.snapshot(), canonical);
  return {
    cancelResult: {
      cancelled: cancelledPackets.reduce((sum, packet) => sum + packet.amount, 0),
      remainingIncoming: structuredClone(nextGarbage.packets),
      outgoingAfterCancel: remainingOutgoing.reduce((sum, amount) => sum + amount, 0),
    },
    outgoingChunks: remainingOutgoing,
    nextGarbage,
  };
}

function mergeCancelled(target, packets) {
  for (const packet of packets) {
    const previous = target.at(-1);
    if (previous && previous.cid === packet.cid && previous.gameid === packet.gameid) {
      previous.amount += packet.amount;
    } else {
      target.push(structuredClone(packet));
    }
  }
}
