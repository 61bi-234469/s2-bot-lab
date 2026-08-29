const ORIENTATION_BY_ROTATION = Object.freeze({
  spawn: "north",
  right: "east",
  reverse: "south",
  left: "west",
});

/**
 * Converts the public canonical placement boundary back to the TBP-shaped move
 * used only by the GUI's ghost and placement highlighter.
 */
export function canonicalPlacementToGuiMove(placement, spin = "none") {
  const { piece, rotation, x, y } = placement ?? {};
  const orientation = ORIENTATION_BY_ROTATION[rotation];
  if (orientation === undefined) throw new Error(`unsupported canonical rotation ${rotation}`);
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) {
    throw new Error("canonical placement coordinates must be integers");
  }
  const [guiX, guiY] = guiOrigin(piece, orientation, x, y);
  return {
    location: { type: piece, orientation, x: guiX, y: guiY },
    // This is the Simulator result, not a proposer claim. It is carried only so
    // existing presentation helpers can diagnose the displayed placement.
    spin: canonicalSpinToGuiSpin(spin),
  };
}

/** Normalizes a simple-bot candidate to the same verified result shape as CC2. */
export function simpleAnalysisToVerification(analysis) {
  const best = analysis?.moves?.[0];
  if (!best?.placement || !best?.transition?.legality?.legal) {
    throw new Error("simple S2 bot has no legal final placement");
  }
  return {
    status: "degraded",
    reasons: ["final-placement-no-frame-reachability"],
    transition: best.transition,
    comparison: {
      source: "simple-s2-final-placement",
      engineId: analysis.bot.id,
      status: "degraded",
      reasons: ["final-placement-no-frame-reachability"],
      positionFingerprint: analysis.positionFingerprint,
      rulesetId: analysis.rulesetId,
      witness: {
        kind: "final-placement-only",
        placement: best.placement,
      },
      evaluator: analysis.evaluator,
      scoreSemantics: analysis.scoreSemantics,
      features: best.features,
      score: best.score,
    },
  };
}

function guiOrigin(piece, orientation, x, y) {
  if (piece === "I") {
    return ({
      north: [x + 1, y + 2],
      east: [x + 2, y + 2],
      south: [x + 2, y + 1],
      west: [x + 1, y + 1],
    })[orientation];
  }
  if (piece === "O") {
    return ({
      north: [x, y],
      east: [x, y + 1],
      south: [x + 1, y + 1],
      west: [x + 1, y],
    })[orientation];
  }
  if (["T", "L", "J", "S", "Z"].includes(piece)) return [x + 1, y + 1];
  throw new Error(`unsupported canonical piece ${piece}`);
}

function canonicalSpinToGuiSpin(spin) {
  if (spin === "none" || spin === "mini") return spin;
  if (spin === "normal") return "full";
  throw new Error(`unsupported canonical spin ${spin}`);
}
