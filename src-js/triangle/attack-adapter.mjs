import { GarbageQueue, garbageCalcV2 } from "@haelp/teto/engine";

import {
  FOUNDATION_GARBAGE_OPTIONS,
  canonicalGarbageToTriangleSnapshot,
  triangleSnapshotToCanonical,
} from "./garbage-adapter.mjs";

export function calculateAttackStages(input) {
  validateInput(input);

  const calculated = garbageCalcV2(
    {
      lines: input.clear.lines,
      spin: input.clear.spin,
      piece: input.clear.piece,
      // Canonical counters are one-based active-chain lengths. Triangle keeps
      // zero-based counters with -1 as the inactive sentinel.
      b2b: Math.max(input.chain.b2b - 1, 0),
      combo: Math.max(input.chain.combo - 1, 0),
      enemies: input.enemies,
    },
    {
      spinBonuses: input.rules.spinBonuses,
      comboTable: input.rules.comboTable,
      garbageTargetBonus: input.rules.garbageTargetBonus,
      b2b: {
        chaining: input.rules.b2bChaining,
        charging: input.rules.b2bCharging,
      },
    },
  );

  const specialBonus =
    input.rules.specialBonus &&
    input.clear.garbageCleared > 0 &&
    (input.clear.spin !== "none" || input.clear.lines >= 4)
      ? 1
      : 0;
  const afterMultiplier = calculated.garbage * input.multiplier;

  const options = queueOptionsFor(input);
  const queue = new GarbageQueue(options);
  queue.fromSnapshot(canonicalGarbageToTriangleSnapshot(input.garbage));
  const afterRounding =
    calculated.garbage > 0 || specialBonus > 0
      ? queue.round(afterMultiplier + specialBonus)
      : 0;
  const perfectClearBonus = input.clear.perfectClear
    ? queue.round(input.rules.perfectClearGarbage * input.multiplier)
    : 0;

  return {
    attackStages: {
      raw: calculated.garbage,
      afterMultiplier,
      afterRounding,
      specialBonus,
      perfectClearBonus,
      surgeChunks: [],
      outgoingBeforeCancel: afterRounding + perfectClearBonus,
    },
    targetBonus: calculated.bonus,
    nextGarbage: triangleSnapshotToCanonical(queue.snapshot(), input.garbage),
  };
}

function queueOptionsFor(input) {
  const options = structuredClone(input.garbageOptions ?? FOUNDATION_GARBAGE_OPTIONS);
  options.rounding = input.rules.rounding;
  options.seed = input.garbage.generatorState.rngState;
  options.specialBonus = input.rules.specialBonus;
  return options;
}

function validateInput(input) {
  if (!Number.isInteger(input.clear.lines) || input.clear.lines < 0) {
    throw new Error("clear.lines must be a non-negative integer");
  }
  if (!["none", "mini", "normal"].includes(input.clear.spin)) {
    throw new Error("clear.spin is not supported");
  }
  if (!Number.isFinite(input.multiplier) || input.multiplier < 0) {
    throw new Error("multiplier must be a finite non-negative number");
  }
  if (!Number.isInteger(input.chain.b2b) || input.chain.b2b < 0) {
    throw new Error("chain.b2b must be a non-negative integer");
  }
  if (!Number.isInteger(input.chain.combo) || input.chain.combo < 0) {
    throw new Error("chain.combo must be a non-negative integer");
  }
  if (typeof input.clear.perfectClear !== "boolean") {
    throw new Error("clear.perfectClear must be a boolean");
  }
  if (
    !Number.isFinite(input.rules.perfectClearGarbage) ||
    input.rules.perfectClearGarbage < 0
  ) {
    throw new Error("perfectClearGarbage must be a finite non-negative number");
  }
}
