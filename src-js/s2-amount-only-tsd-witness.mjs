import { applyTransition } from "./transition.mjs";
import { generateReachablePlacements } from "./triangle/move-generation.mjs";
import { resolvePlacementRules } from "./ruleset-profiles.mjs";

export const S2_MINI_TO_TSD_WITNESS_PLACEMENT_CAP = 64;

export const S2_AMOUNT_ONLY_TSD_EMPTY_GARBAGE = Object.freeze({
  packets: Object.freeze([]),
  generatorState: Object.freeze({
    rngState: 123456789,
    lastTankFrame: 0,
    lastHoleColumn: -1,
    sentForOpener: 0,
    holeChanged: false,
    receivedCountSinceReset: 0,
  }),
  capState: Object.freeze({ consumedThisTick: 0 }),
  fidelity: "exact",
});

export function witnessCanonicalNextTsdOnLockBoard(projection, publicCtx, {
  placementCap = S2_MINI_TO_TSD_WITNESS_PLACEMENT_CAP,
} = {}) {
  if (!Number.isSafeInteger(placementCap) || placementCap < 1 || placementCap > 256) {
    throw new Error("lockBoard TSD witness placement cap must be an integer from 1 to 256");
  }
  if (typeof publicCtx?.rulesetId !== "string" || publicCtx.rulesetId.length === 0) {
    throw new Error("lockBoard TSD witness requires publicCtx.rulesetId");
  }
  if (publicCtx.time?.fidelity !== "exact") {
    throw new Error("lockBoard TSD witness requires exact publicCtx.time");
  }
  const nextState = Object.freeze({
    rulesetId: publicCtx.rulesetId,
    board: projection.lockBoard,
    pieces: projection.piecesAfterLock,
    chain: Object.freeze({
      combo: projection.comboAfter,
      b2b: projection.b2bAfter,
      fidelity: "exact",
    }),
    garbage: structuredClone(S2_AMOUNT_ONLY_TSD_EMPTY_GARBAGE),
    time: structuredClone(publicCtx.time),
  });
  if (!tAvailableOnPieces(projection.piecesAfterLock)) {
    return Object.freeze({ tAvailable: false, scanned: 0, witnessed: false });
  }
  const rules = resolvePlacementRules(publicCtx.rulesetId);
  const tPlacements = generateReachablePlacements(nextState, rules)
    .filter((placement) => placement.piece === "T")
    .slice(0, placementCap);
  let scanned = 0;
  for (const placement of tPlacements) {
    scanned += 1;
    const transition = applyTransition(
      structuredClone(nextState),
      { kind: "placement", placement },
      publicCtx.rulesetId,
    );
    if (transition.legality?.legal !== true) continue;
    if (isCanonicalTsd(transition.lockResult)) {
      return Object.freeze({ tAvailable: true, scanned, witnessed: true });
    }
  }
  return Object.freeze({ tAvailable: true, scanned, witnessed: false });
}

function isCanonicalTsd(lockResult) {
  return lockResult?.spin === "normal" && lockResult?.lines === 2;
}

function tAvailableOnPieces(pieces) {
  const current = pieces?.current;
  const hold = pieces?.hold;
  const holdAvailable = pieces?.holdAvailable === true;
  return current === "T" || (holdAvailable && hold === "T");
}
