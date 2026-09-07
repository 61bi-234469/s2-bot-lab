import { guiStateToCanonical } from "./cc2-s2-adapter.mjs";
import { projectS2AmountOnlyIncomingSnapshot } from "./s2-amount-only-incoming-snapshot.mjs";

export function guiStateToCc2NativeStart(gui, {
  queueLimit = 14,
  includeS2IncomingAmounts = false,
} = {}) {
  if (!Number.isSafeInteger(queueLimit) || queueLimit < 1) {
    throw new Error("queueLimit must be a positive integer");
  }
  const start = {
    board: gui.board,
    queue: gui.queue.slice(0, queueLimit),
    hold: gui.hold,
    combo: gui.combo,
    back_to_back: gui.back_to_back,
    randomizer: gui.randomizer ?? { type: "seven_bag", bag_state: [] },
  };
  if (Number.isInteger(gui.s2?.b2b) && gui.s2.b2b >= 0) start.b2b = gui.s2.b2b;
  if (includeS2IncomingAmounts === true) {
    const snap = projectS2AmountOnlyIncomingSnapshot(guiStateToCanonical(gui));
    start.s2_incoming = {
      pending_rows: snap.pendingRows,
      due_this_lock_rows: snap.dueThisLockRows,
    };
  }
  return start;
}
