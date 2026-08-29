import { RULESET_IDS } from "./ruleset-profiles.mjs";

export function guiStateToCanonical(guiState) {
  assertGuiState(guiState);
  return {
    $schema: "s2-analysis-engine/schema/canonical-state/1",
    schemaVersion: 1,
    rulesetId: RULESET_IDS.s2Observed,
    board: { width: 10, height: 40, visibleHeight: 20, bufferHeight: 20,
      cells: guiState.board.flatMap((row) => row.map((cell) => cell ?? "_")).join(""), fidelity: "exact" },
    pieces: { current: guiState.queue[0], hold: guiState.hold, holdAvailable: true, known: guiState.queue.slice(1),
      queueModel: { type: "7-bag", bagRemaining: [], seed: null, tail: "deterministic" }, fidelity: "exact" },
    chain: { combo: guiState.combo, b2b: guiState.s2.b2b, fidelity: "exact" },
    garbage: structuredClone(guiState.s2.garbage), time: structuredClone(guiState.s2.time),
    movement: structuredClone(guiState.s2.movement),
    informationLoss: guiState.s2.clock?.kind === "synthetic-fixed-lock-step" ? [] : [{
      field: "time.logicalFrame", reason: "no engine-frame clock provider is attached", effect: "degraded",
    }],
    provenance: { sourcePath: "raw-cc2-gui", producedBy: "gui-state", clock: structuredClone(guiState.s2.clock ?? null) },
  };
}

function assertGuiState(state) {
  if (!Array.isArray(state?.board) || state.board.length !== 40) throw new Error("GUI state requires 40 board rows");
  if (!state.board.every((row) => Array.isArray(row) && row.length === 10)) throw new Error("GUI state requires 10 board columns");
  if (!Array.isArray(state.queue) || state.queue.length < 2) throw new Error("GUI state requires current and next pieces");
  if (!Number.isSafeInteger(state.combo) || state.combo < 0) throw new Error("GUI combo must be a non-negative integer");
  if (!Number.isSafeInteger(state.s2?.b2b) || state.s2.b2b < 0) throw new Error("GUI S2 B2B must be a non-negative integer");
  if (state.s2.clock?.kind === "synthetic-fixed-lock-step" &&
      (!Number.isSafeInteger(state.s2.clock.framesPerLock) || state.s2.clock.framesPerLock < 1)) {
    throw new Error("synthetic clock framesPerLock must be a positive integer");
  }
}
