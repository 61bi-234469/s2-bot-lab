import { resolveDynamicValue } from "./dynamic-values.mjs";
import { resolvePlacementRules } from "./ruleset-profiles.mjs";
import { tankGarbage, triangleGarbageOptions } from "./triangle/garbage-adapter.mjs";

export const S2_AMOUNT_ONLY_INCOMING_SNAPSHOT_ID = "s2-amount-only-incoming-snapshot/1";

const ALLOWLIST = Object.freeze(["id", "pendingRows", "dueThisLockRows"]);

export function projectS2AmountOnlyIncomingSnapshot(state) {
  if (state?.garbage?.fidelity !== "exact" || !Array.isArray(state.garbage.packets)) {
    throw new Error("amount-only incoming snapshot requires exact garbage packets");
  }
  if (state?.time?.fidelity !== "exact" || !Number.isSafeInteger(state.time.logicalFrame) || state.time.logicalFrame < 0) {
    throw new Error("amount-only incoming snapshot requires exact non-negative logicalFrame");
  }
  if (typeof state?.rulesetId !== "string" || state.rulesetId.length === 0) {
    throw new Error("amount-only incoming snapshot requires a rulesetId");
  }
  const board = state.board;
  if (
    board?.fidelity !== "exact" ||
    board.width !== 10 ||
    board.height !== 40 ||
    board.visibleHeight !== 20
  ) {
    throw new Error("amount-only incoming snapshot requires a 10x40 board with visibleHeight 20");
  }

  const rules = resolvePlacementRules(state.rulesetId);
  const cap = resolveDynamicValue(rules.garbageCap, state.time);
  if (!Number.isFinite(cap) || cap < 0) {
    throw new Error("amount-only incoming snapshot requires a finite non-negative garbage cap");
  }

  let pendingRows = 0;
  for (const packet of state.garbage.packets) {
    if (!Number.isSafeInteger(packet?.amount) || packet.amount < 1) {
      throw new Error("amount-only incoming snapshot requires positive packet amounts");
    }
    pendingRows += packet.amount;
  }
  if (pendingRows > 255) {
    throw new Error("amount-only incoming snapshot pendingRows exceeds 255");
  }

  const garbageOptions = triangleGarbageOptions(rules, {
    seed: state.garbage.generatorState?.rngState,
    boardWidth: board.width,
  });
  const inserted = tankGarbage(
    state.garbage,
    { frame: state.time.logicalFrame, cap, hard: true },
    garbageOptions,
  ).tankResult.inserted;
  if (!Array.isArray(inserted)) {
    throw new Error("amount-only incoming snapshot requires tank inserted amounts");
  }
  let dueThisLockRows = 0;
  for (const row of inserted) {
    if (!Number.isSafeInteger(row?.amount) || row.amount < 1) {
      throw new Error("amount-only incoming snapshot requires positive tanked amounts");
    }
    dueThisLockRows += row.amount;
  }
  if (dueThisLockRows > pendingRows) {
    throw new Error("amount-only incoming snapshot dueThisLockRows exceeds pendingRows");
  }

  const snapshot = Object.freeze({
    id: S2_AMOUNT_ONLY_INCOMING_SNAPSHOT_ID,
    pendingRows,
    dueThisLockRows,
  });
  for (const key of Object.keys(snapshot)) {
    if (!ALLOWLIST.includes(key)) {
      throw new Error(`amount-only incoming snapshot leaked key ${key}`);
    }
  }
  return snapshot;
}
