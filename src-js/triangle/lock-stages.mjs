import { calculateAttackStages } from "./attack-adapter.mjs";
import { cancelOutgoing } from "./cancel-adapter.mjs";
import { advanceChain, calculateSurge } from "./chain-adapter.mjs";

export function evaluateLockStages(input) {
  const chainInternal = advanceChain(input.chain, input.clear, {
    perfectClearB2bBonus: input.rules.perfectClearB2bBonus,
  });
  // One options object for the whole lock, so the rounding draw, the cancel
  // reroll and the tank all read the same hole geometry.
  const attack = calculateAttackStages({
    garbageOptions: input.garbageOptions,
    clear: {
      lines: input.clear.lines,
      spin: input.clear.spin,
      piece: input.clear.piece,
      perfectClear: input.clear.perfectClear,
      garbageCleared: input.clear.garbageCleared,
    },
    chain: { combo: chainInternal.comboAfter, b2b: chainInternal.b2bAfter },
    enemies: input.enemies,
    multiplier: input.multiplier,
    rules: input.rules,
    garbage: input.garbage,
  });
  const surge = calculateSurge(
    chainInternal.brokenB2bCount,
    input.rules.b2bCharging,
    input.multiplier,
  );
  const outgoingChunks = [...surge.chunks];
  if (attack.attackStages.afterRounding > 0) {
    outgoingChunks.push(attack.attackStages.afterRounding);
  }
  if (attack.attackStages.perfectClearBonus > 0) {
    outgoingChunks.push(attack.attackStages.perfectClearBonus);
  }

  const cancellation = cancelOutgoing(
    attack.nextGarbage,
    outgoingChunks,
    {
      piecesPlaced: input.piecesPlaced,
      openerPhase: input.rules.openerPhase,
      legacyOpenerPhase: false,
    },
    input.garbageOptions,
  );
  const { brokenB2bCount: _, ...chain } = chainInternal;

  return {
    chain,
    attackStages: {
      ...attack.attackStages,
      surgeChunks: surge.chunks,
      outgoingBeforeCancel: outgoingChunks.reduce((sum, amount) => sum + amount, 0),
    },
    cancelResult: cancellation.cancelResult,
    outgoingChunks: cancellation.outgoingChunks,
    nextGarbage: cancellation.nextGarbage,
    surgeAmount: surge.amount,
  };
}
