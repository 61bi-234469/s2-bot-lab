export function advanceChain(chain, clear, rules = { perfectClearB2bBonus: 0 }) {
  validate(chain, clear, rules);

  const comboAfter = clear.lines > 0 ? chain.combo + 1 : 0;
  let b2bAfter = chain.b2b;
  let brokeB2b = false;
  let brokenB2bCount = 0;

  if (clear.lines > 0) {
    const difficult = clear.spin !== "none" || clear.lines >= 4;
    if (clear.perfectClear && rules.perfectClearB2bBonus > 0) {
      b2bAfter += rules.perfectClearB2bBonus;
    } else if (difficult) {
      b2bAfter += 1;
    } else {
      brokeB2b = chain.b2b > 0;
      brokenB2bCount = chain.b2b;
      b2bAfter = 0;
    }
  }

  return {
    comboBefore: chain.combo,
    comboAfter,
    b2bBefore: chain.b2b,
    b2bAfter,
    brokeB2b,
    brokenB2bCount,
  };
}

export function calculateSurge(brokenB2bCount, charging, multiplier) {
  if (!Number.isInteger(brokenB2bCount) || brokenB2bCount < 0) {
    throw new Error("brokenB2bCount must be a non-negative integer");
  }
  if (charging === false || brokenB2bCount <= charging.at) {
    return { amount: 0, chunks: [] };
  }
  if (!Number.isInteger(charging.at) || !Number.isInteger(charging.base)) {
    throw new Error("charging threshold and base must be integers");
  }
  if (!Number.isFinite(multiplier) || multiplier < 0) {
    throw new Error("multiplier must be a finite non-negative number");
  }

  const amount = Math.floor(
    (brokenB2bCount - charging.at + charging.base) * multiplier,
  );
  const first = Math.round(amount / 3);
  const chunks = [first, first, amount - 2 * first].filter((chunk) => chunk > 0);
  return { amount, chunks };
}

function validate(chain, clear, rules) {
  for (const [name, value] of Object.entries(chain)) {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error(`chain.${name} must be a non-negative integer`);
    }
  }
  if (!Number.isInteger(clear.lines) || clear.lines < 0) {
    throw new Error("clear.lines must be a non-negative integer");
  }
  if (!["none", "mini", "normal"].includes(clear.spin)) {
    throw new Error("clear.spin is not supported");
  }
  if (!Number.isInteger(rules.perfectClearB2bBonus) || rules.perfectClearB2bBonus < 0) {
    throw new Error("perfectClearB2bBonus must be a non-negative integer");
  }
}

