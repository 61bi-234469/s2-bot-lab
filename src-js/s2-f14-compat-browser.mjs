import { assertStrategicBoundary } from "./s2-strategic-audit.mjs";

export const F14_COMPAT_RULESET_ID =
  "tetrio-s2-v19-2c47b3df945f6714449b92d1b44346ef4bf0e1a20e95be8ed10c28be75c66a60-beta-1-5-0";
export const F14_COMPAT_QUEUE_LIMIT = 14;
export const F14_PUBLIC_PROFILE = "f14-amount-only-compat-b/1";
export const CORE_ALLSPIN_PROFILE = "f14-core-allspin-b/1";
export const RANK_ORDER_PROFILE = "f14-rank-order-b/1";
export const ROOT_OBJECTIVE_PROFILE = "f14-root-objective-b/1";
export const ROOT_LEAF_CONVERSION_GATED_PROFILE = "f14-leaf-conversion-gated-b/1";
export const ROOT_LEAF_CONVERSION_PRESSURE_GATED_PROFILE = "f14-leaf-conversion-pressure-gated-b/1";
export const ROOT_LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE = "f14-leaf-conversion-gated-b2b-charge-b/1";
export const POST_SPIN_POLICY_OFF = "non-t-spin-prior-off/1";
export const FINAL_ORDER_POLICY_CC2 = "cc2-rank-order/1";
export const LEAF_CONVERSION_GATED_MODE = "leaf-conversion-gated-v1";
export const LEAF_CONVERSION_PRESSURE_GATED_MODE = "leaf-conversion-pressure-gated-v1";
export const LEAF_CONVERSION_GATED_B2B_CHARGE_MODE = "leaf-conversion-gated-b2b-charge-v1";
export const F14_COMPAT_CONFIG_HASH =
  "sha256:12665e92fa86934d82b5fd909b1248954e267d4e5c8fcafb0c23024938d1a769";

export function createF14CompatProfile({
  selections = 512,
  maxMillis = 30_000,
  seed = "1395802947",
  configHash = F14_COMPAT_CONFIG_HASH,
} = {}) {
  if (typeof configHash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(configHash)) {
    throw new Error("invalid F14 compat config hash");
  }
  if (!/^\d+$/.test(String(seed))) throw new Error("F14 compat seed must be a u64 decimal string");
  return Object.freeze({
    profileId: "f14-amount-only-compat-a/1",
    configHash,
    seed: String(seed),
    workerConcurrency: 1,
    budget: Object.freeze({ mode: "selection", selections, maxMillis }),
  });
}

// Search-config scalars a gated-profile `weightOverrides` map may set
// (mirrors TUNABLE_WEIGHT_KEYS in bot/cold-clear-2-s2/src/f14_compat/transport.rs).
export const F14_TUNABLE_WEIGHT_KEYS = Object.freeze([
  "freestyle_exploitation", "cell_coveredness", "holes", "row_transitions", "height",
  "height_upper_half", "height_upper_quarter", "tetris_well_depth", "has_back_to_back", "wasted_t",
  "softdrop", "back_to_back_clear", "combo_attack", "perfect_clear",
  "tslot.0", "tslot.1", "tslot.2", "tslot.3",
  "normal_clears.1", "normal_clears.2", "normal_clears.3", "normal_clears.4",
  "mini_spin_clears.1", "mini_spin_clears.2", "mini_spin_clears.3",
  "spin_clears.1", "spin_clears.2", "spin_clears.3",
]);
const CANONICAL_SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u;

function canonicalWeightOverrides(overrides) {
  if (overrides == null || typeof overrides !== "object" || Array.isArray(overrides)) {
    throw new Error("F14 weightOverrides must be an object");
  }
  const keys = Object.keys(overrides).sort();
  if (keys.length === 0) throw new Error("F14 weightOverrides must not be empty");
  const canonical = {};
  for (const key of keys) {
    const value = overrides[key];
    if (!F14_TUNABLE_WEIGHT_KEYS.includes(key)) throw new Error(`F14 weightOverrides key ${key} is not tunable`);
    if (typeof value !== "string" || !CANONICAL_SIGNED_DECIMAL.test(value) || value === "-0"
        || !Number.isFinite(Math.fround(Number(value)))) {
      throw new Error(`F14 weightOverrides ${key} must be a canonical finite decimal string`);
    }
    canonical[key] = value;
  }
  return Object.freeze(canonical);
}

export function createF14LeafConversionGatedProfile({
  scale,
  maxHeight,
  maxMillis = 30_000,
  selections = 512,
  seed = "5994928009864282113",
  configHash = F14_COMPAT_CONFIG_HASH,
  weightOverrides,
} = {}) {
  if (configHash !== F14_COMPAT_CONFIG_HASH) {
    throw new Error("leaf-conversion-gated profile requires the champion compat config hash");
  }
  if (!Number.isSafeInteger(maxMillis) || maxMillis < 0 || maxMillis > 300_000) {
    throw new Error("F14 leaf-conversion-gated maxMillis is outside profile budget bounds");
  }
  if (!Number.isSafeInteger(selections) || selections < 1 || selections > 1_000_000) {
    throw new Error("F14 leaf-conversion-gated selections is outside profile budget bounds");
  }
  if (typeof scale !== "string"
      || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(scale)
      || !Number.isFinite(Number(scale))) {
    throw new Error("F14 leaf-conversion-gated scale must be a finite decimal string");
  }
  if (typeof maxHeight !== "string" || !/^(?:[1-9]|[1-3]\d|40)$/u.test(maxHeight)) {
    throw new Error("F14 leaf-conversion-gated maxHeight must be a decimal integer string from 1 to 40");
  }
  const seedString = String(seed);
  if (!/^\d+$/.test(seedString) || BigInt(seedString) > 0xffff_ffff_ffff_ffffn
      || BigInt(seedString).toString() !== seedString) {
    throw new Error("F14 leaf-conversion-gated seed must be a canonical u64 decimal string");
  }
  return Object.freeze({
    profileId: ROOT_LEAF_CONVERSION_GATED_PROFILE,
    configHash,
    seed: seedString,
    workerConcurrency: 1,
    budget: Object.freeze({ mode: "selection", selections, maxMillis }),
    allocationMode: LEAF_CONVERSION_GATED_MODE,
    leafConversionScale: scale,
    leafConversionMaxHeight: maxHeight,
    finalOrderPolicyId: FINAL_ORDER_POLICY_CC2,
    ...(weightOverrides === undefined ? {} : { weightOverrides: canonicalWeightOverrides(weightOverrides) }),
  });
}

export function createF14LeafConversionPressureGatedProfile({
  scale,
  maxHeight,
  maxMillis = 30_000,
  seed = "5994928009864282113",
  configHash = F14_COMPAT_CONFIG_HASH,
} = {}) {
  if (configHash !== F14_COMPAT_CONFIG_HASH) {
    throw new Error("leaf-conversion-pressure-gated profile requires the champion compat config hash");
  }
  if (!Number.isSafeInteger(maxMillis) || maxMillis < 0 || maxMillis > 300_000) {
    throw new Error("F14 leaf-conversion-pressure-gated maxMillis is outside profile budget bounds");
  }
  if (typeof scale !== "string"
      || !/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/u.test(scale)
      || !Number.isFinite(Number(scale))) {
    throw new Error("F14 leaf-conversion-pressure-gated scale must be a finite decimal string");
  }
  if (typeof maxHeight !== "string" || !/^(?:[1-9]|[1-3]\d|40)$/u.test(maxHeight)) {
    throw new Error("F14 leaf-conversion-pressure-gated maxHeight must be a decimal integer string from 1 to 40");
  }
  const seedString = String(seed);
  if (!/^\d+$/.test(seedString) || BigInt(seedString) > 0xffff_ffff_ffff_ffffn
      || BigInt(seedString).toString() !== seedString) {
    throw new Error("F14 leaf-conversion-pressure-gated seed must be a canonical u64 decimal string");
  }
  return Object.freeze({
    profileId: ROOT_LEAF_CONVERSION_PRESSURE_GATED_PROFILE,
    configHash,
    seed: seedString,
    workerConcurrency: 1,
    budget: Object.freeze({ mode: "selection", selections: 512, maxMillis }),
    allocationMode: LEAF_CONVERSION_PRESSURE_GATED_MODE,
    leafConversionScale: scale,
    leafConversionMaxHeight: maxHeight,
    finalOrderPolicyId: FINAL_ORDER_POLICY_CC2,
  });
}

export function createF14LeafConversionGatedB2bChargeProfile({
  scale,
  maxHeight,
  b2bChargeScale,
  maxMillis = 30_000,
  seed = "5994928009864282113",
  configHash = F14_COMPAT_CONFIG_HASH,
} = {}) {
  if (typeof b2bChargeScale !== "string"
      || !/^(?:0|[1-9]\d*)(?:\.\d*[1-9])?$/u.test(b2bChargeScale)
      || !Number.isFinite(Number(b2bChargeScale))
      || Number(b2bChargeScale) < 0
      || !Number.isFinite(Math.fround(Number(b2bChargeScale)))) {
    throw new Error("F14 b2bChargeScale must be a canonical finite nonnegative decimal string");
  }
  const gated = createF14LeafConversionGatedProfile({
    scale, maxHeight, maxMillis, seed, configHash,
  });
  return Object.freeze({
    ...gated,
    profileId: ROOT_LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE,
    allocationMode: LEAF_CONVERSION_GATED_B2B_CHARGE_MODE,
    b2bChargeScale,
  });
}

export function boardCellsToTbpBoard(cells) {
  if (typeof cells !== "string" || cells.length !== 400) throw new Error("F14 start board cells must be 400 characters");
  const board = [];
  for (let y = 0; y < 40; y += 1) {
    const row = [];
    for (let x = 0; x < 10; x += 1) row.push(cells[y * 10 + x] === "_" ? null : cells[y * 10 + x]);
    board.push(row);
  }
  return board;
}

export function tbpBoardToCells(board) {
  if (!Array.isArray(board) || board.length !== 40) throw new Error("F14 start board must be 40 rows");
  let cells = "";
  for (const row of board) {
    if (!Array.isArray(row) || row.length !== 10) throw new Error("F14 start board rows must be 10 cells");
    for (const cell of row) cells += cell == null ? "_" : cell;
  }
  return cells;
}

export function assertF14StartSelectorProjection(start, selector) {
  if (selector?.rulesetId !== F14_COMPAT_RULESET_ID) throw new Error("F14 selector rulesetId is not the frozen A-profile ruleset");
  if (tbpBoardToCells(start.board) !== selector.board?.cells) throw new Error("F14 start/selector board mismatch");
  if (selector.pieces?.holdAvailable !== true) throw new Error("F14 A-profile selector requires holdAvailable=true");
  if ((start.hold ?? null) !== (selector.pieces?.hold ?? null)) throw new Error("F14 start/selector HOLD mismatch");
  const expectedQueue = [selector.pieces.current, ...selector.pieces.known].slice(0, F14_COMPAT_QUEUE_LIMIT);
  if (!Array.isArray(start.queue) || start.queue.length !== expectedQueue.length
      || start.queue.some((piece, index) => piece !== expectedQueue[index])) {
    throw new Error("F14 start queue must be current plus known, truncated to 14");
  }
  if (start.combo !== selector.chain?.combo) throw new Error("F14 start/selector combo mismatch");
  const startB2b = Number.isInteger(start.b2b) ? start.b2b : (start.back_to_back ? 1 : 0);
  if (startB2b !== selector.chain?.b2b) throw new Error("F14 start/selector B2B mismatch");
  if (start.randomizer?.type !== "seven_bag") throw new Error("F14 start randomizer must be seven_bag");
  if (selector.incoming?.pendingRows !== 0 || selector.incoming?.dueThisLockRows !== 0) {
    throw new Error("F14 A-profile selector incoming must be zero");
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const F14_CONVERSION_BRANCHES = new Set([
  "high-surge-finisher", "ren-quad-tsd-b2b-bridge", "mini-to-tsd-b2b-bridge",
  "high-or-defensive-ren", "unconverted-low-value-ren", "other",
]);
const F14_SCORE_KEYS = ["cc2Rank", "s2Score", "selectionScore", "solvency", "solvent"];
const F14_EXTENDED_SCORE_KEYS = [...F14_SCORE_KEYS, "conversionBranch", "conversionUnits"];
const F14_COMPOSED_FACT_KEYS = [...F14_EXTENDED_SCORE_KEYS, "qualifies", "renCombatGain", "releaseValue", "setupWitnessed", "comboAfter", "b2bAfter", "lines", "spin", "surgeSent", "cancelled"];

function assertF14CandidateScores(response) {
  if (![F14_PUBLIC_PROFILE, CORE_ALLSPIN_PROFILE, RANK_ORDER_PROFILE, ROOT_LEAF_CONVERSION_GATED_PROFILE,
    ROOT_LEAF_CONVERSION_PRESSURE_GATED_PROFILE, ROOT_LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE,
    "f14-composed-ranking-b/1", ROOT_OBJECTIVE_PROFILE].includes(response.profileId)) return;
  const candidates = response.ranking?.candidates;
  if (candidates === undefined) {
    if (response.profileId === RANK_ORDER_PROFILE || response.profileId === ROOT_LEAF_CONVERSION_GATED_PROFILE
        || response.profileId === ROOT_LEAF_CONVERSION_PRESSURE_GATED_PROFILE
        || response.profileId === ROOT_LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE) {
      throw new Error("missing F14 rank-order ranking candidates");
    }
    return;
  }
  if (!Array.isArray(candidates)) throw new Error("invalid F14 public ranking candidates");
  const ranks = new Set();
  for (const candidate of candidates) {
    if (candidate == null || typeof candidate !== "object" || Array.isArray(candidate)) throw new Error("invalid F14 public ranking candidate");
    const keys = Object.keys(candidate).sort();
    const oldShape = [...F14_SCORE_KEYS].sort();
    const extendedShape = [...F14_EXTENDED_SCORE_KEYS].sort();
    const composedShape = [...F14_COMPOSED_FACT_KEYS].sort();
    if (response.profileId === "f14-composed-ranking-b/1" || response.profileId === ROOT_OBJECTIVE_PROFILE) {
      if (stableJson(keys) !== stableJson(composedShape)) throw new Error("invalid F14 composed ranking candidate shape");
    } else if (response.profileId === RANK_ORDER_PROFILE || response.profileId === ROOT_LEAF_CONVERSION_GATED_PROFILE
        || response.profileId === ROOT_LEAF_CONVERSION_PRESSURE_GATED_PROFILE
        || response.profileId === ROOT_LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE
        ? stableJson(keys) !== stableJson(extendedShape)
        : stableJson(keys) !== stableJson(oldShape) && stableJson(keys) !== stableJson(extendedShape)) {
      throw new Error("invalid F14 public ranking candidate shape");
    }
    if (!Number.isSafeInteger(candidate.cc2Rank) || candidate.cc2Rank < 0 || ranks.has(candidate.cc2Rank)
        || ![candidate.s2Score, candidate.selectionScore, candidate.solvency].every(Number.isFinite)
        || typeof candidate.solvent !== "boolean") throw new Error("invalid F14 public ranking candidate score");
    ranks.add(candidate.cc2Rank);
    if (Object.hasOwn(candidate, "conversionBranch")
        && (!F14_CONVERSION_BRANCHES.has(candidate.conversionBranch) || !Number.isFinite(candidate.conversionUnits))) throw new Error("invalid F14 public conversion diagnostics");
    if (Object.hasOwn(candidate, "renCombatGain")
        && (typeof candidate.qualifies !== "boolean" || typeof candidate.setupWitnessed !== "boolean"
          || !["none", "mini", "normal"].includes(candidate.spin)
          || !Number.isSafeInteger(candidate.lines) || candidate.lines < 0 || candidate.lines > 4
          || ![candidate.renCombatGain, candidate.releaseValue, candidate.comboAfter, candidate.b2bAfter, candidate.surgeSent, candidate.cancelled].every(Number.isFinite))) {
      throw new Error("invalid F14 composed conversion facts");
    }
  }
}

function assertF14SelectedPlacement(placement) {
  if (placement == null || typeof placement !== "object" || Array.isArray(placement)) throw new Error("invalid F14 selectedPlacement");
  if (typeof placement.piece !== "string" || typeof placement.rotation !== "string"
      || !Number.isInteger(placement.x) || !Number.isInteger(placement.y) || typeof placement.usedHold !== "boolean") throw new Error("invalid F14 selectedPlacement pose");
  const evidence = placement.rotationEvidence;
  if (evidence == null || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("invalid F14 selectedPlacement rotationEvidence");
  if (typeof evidence.lastInputWasRotation !== "boolean") throw new Error("invalid F14 lastInputWasRotation");
  if (evidence.kickIndex !== null && !Number.isInteger(evidence.kickIndex)) throw new Error("invalid F14 kickIndex");
  if (evidence.kickId !== null && (typeof evidence.kickId !== "string" || evidence.kickId.length > 16)) throw new Error("invalid F14 kickId");
  if (evidence.kickOffset !== null && (!Array.isArray(evidence.kickOffset) || evidence.kickOffset.length !== 2
      || !Number.isInteger(evidence.kickOffset[0]) || !Number.isInteger(evidence.kickOffset[1]))) throw new Error("invalid F14 kickOffset");
}

export function assertF14LeafConversionGatedProfile(profile) {
  try {
    const budget = profile?.budget;
    if (budget == null || typeof budget !== "object" || Array.isArray(budget)
        || !["selection", "time"].includes(budget.mode)
        || !Number.isSafeInteger(budget.selections) || budget.selections < 1 || budget.selections > 1_000_000
        || !Number.isSafeInteger(budget.maxMillis) || budget.maxMillis < 0 || budget.maxMillis > 300_000
        || (budget.mode === "time" && (budget.maxMillis < 10 || budget.maxMillis > 10_000))) {
      throw new Error("invalid profile budget");
    }
    const base = createF14LeafConversionGatedProfile({
      scale: profile?.leafConversionScale,
      maxHeight: profile?.leafConversionMaxHeight,
      seed: profile?.seed,
      configHash: profile?.configHash,
      maxMillis: budget.maxMillis,
      weightOverrides: profile?.weightOverrides,
    });
    const expected = { ...base, budget: {
      mode: budget.mode, selections: budget.selections, maxMillis: budget.maxMillis,
    } };
    if (stableJson(profile) !== stableJson(expected)) throw new Error("profile fields do not match the admitted profile");
  } catch (error) {
    throw new Error(`invalid F14 leaf-conversion-gated profile: ${error.message}`);
  }
}

export function assertF14LeafConversionPressureGatedProfile(profile) {
  try {
    const budget = profile?.budget;
    if (budget == null || typeof budget !== "object" || Array.isArray(budget)
        || budget.mode !== "selection"
        || !Number.isSafeInteger(budget.selections) || budget.selections < 1 || budget.selections > 1_000_000
        || !Number.isSafeInteger(budget.maxMillis) || budget.maxMillis < 0 || budget.maxMillis > 300_000) {
      throw new Error("invalid selection profile budget");
    }
    const base = createF14LeafConversionPressureGatedProfile({
      scale: profile?.leafConversionScale,
      maxHeight: profile?.leafConversionMaxHeight,
      seed: profile?.seed,
      configHash: profile?.configHash,
      maxMillis: budget.maxMillis,
    });
    const expected = { ...base, budget: {
      mode: budget.mode, selections: budget.selections, maxMillis: budget.maxMillis,
    } };
    if (stableJson(profile) !== stableJson(expected)) throw new Error("profile fields do not match the admitted profile");
  } catch (error) {
    throw new Error(`invalid F14 leaf-conversion-pressure-gated profile: ${error.message}`);
  }
}

export function assertF14LeafConversionGatedB2bChargeProfile(profile) {
  try {
    const budget = profile?.budget;
    if (budget == null || typeof budget !== "object" || Array.isArray(budget)
        || budget.mode !== "selection"
        || !Number.isSafeInteger(budget.selections) || budget.selections < 1 || budget.selections > 1_000_000
        || !Number.isSafeInteger(budget.maxMillis) || budget.maxMillis < 0 || budget.maxMillis > 300_000) {
      throw new Error("invalid selection profile budget");
    }
    const base = createF14LeafConversionGatedB2bChargeProfile({
      scale: profile?.leafConversionScale,
      maxHeight: profile?.leafConversionMaxHeight,
      b2bChargeScale: profile?.b2bChargeScale,
      seed: profile?.seed,
      configHash: profile?.configHash,
      maxMillis: budget.maxMillis,
    });
    const expected = { ...base, budget: {
      mode: budget.mode, selections: budget.selections, maxMillis: budget.maxMillis,
    } };
    if (stableJson(profile) !== stableJson(expected)) throw new Error("profile fields do not match the admitted profile");
  } catch (error) {
    throw new Error(`invalid F14 leaf-conversion-gated-b2b-charge profile: ${error.message}`);
  }
}

export function assertF14Response(request, response) {
  if (response?.type !== "f14_decision" || response.schemaVersion !== 1
      || response.requestId !== request.requestId || response.positionId !== request.positionId
      || response.generation !== request.generation || response.profileId !== request.execution.profileId) throw new Error("F14 stale or malformed identity");
  if (request.execution?.budget?.mode === "time"
      && (![F14_PUBLIC_PROFILE, ROOT_LEAF_CONVERSION_GATED_PROFILE].includes(request.execution.profileId)
        || !Number.isSafeInteger(request.execution.budget.maxMillis)
        || request.execution.budget.maxMillis < 10 || request.execution.budget.maxMillis > 10_000)) {
    throw new Error("invalid F14 time budget profile");
  }
  assertStrategicBoundary(response.boundaryAudit);
  if (!["move", "root-no-move", "incomplete", "unsupported", "error"].includes(response.status)) throw new Error("invalid F14 status");
  if (response.profileId === ROOT_LEAF_CONVERSION_GATED_PROFILE) assertF14LeafConversionGatedProfile(request.execution);
  if (response.profileId === ROOT_LEAF_CONVERSION_PRESSURE_GATED_PROFILE) {
    assertF14LeafConversionPressureGatedProfile(request.execution);
  }
  if (response.profileId === ROOT_LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE) {
    assertF14LeafConversionGatedB2bChargeProfile(request.execution);
  }
  if (response.profileId !== ROOT_LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE
      && Object.hasOwn(request.execution ?? {}, "b2bChargeScale")) {
    throw new Error("b2bChargeScale is only admitted for the gated B2B charge profile");
  }
  if (response.profileId === RANK_ORDER_PROFILE || response.profileId === ROOT_LEAF_CONVERSION_GATED_PROFILE
      || response.profileId === ROOT_LEAF_CONVERSION_PRESSURE_GATED_PROFILE
      || response.profileId === ROOT_LEAF_CONVERSION_GATED_B2B_CHARGE_PROFILE) {
    const diagnostics = response.diagnostics;
    const fields = ["postStageConversionComputeCalls", "postStageConversionAddCalls", "postStageRerankCalls"];
    if (diagnostics == null || typeof diagnostics !== "object" || Array.isArray(diagnostics)
        || diagnostics.finalOrderPolicyId !== FINAL_ORDER_POLICY_CC2
        || fields.some((field) => !Number.isSafeInteger(diagnostics[field]) || diagnostics[field] < 0)) throw new Error("invalid F14 rank-order diagnostics");
  }
  if (response.status === "move") {
    const location = response.selectedMove?.location;
    if (location == null || typeof location.type !== "string" || typeof location.orientation !== "string"
        || !Number.isInteger(location.x) || !Number.isInteger(location.y)) throw new Error("invalid F14 selectedMove");
    // A host-clocked time budget ends after at least one selection, within its cap.
    const timeBudget = request.execution.budget.mode === "time";
    if (response.reason !== (timeBudget ? "time-budget" : "selection-budget")) throw new Error("invalid F14 move contract");
    if (stableJson(response.execution) !== stableJson(request.execution)) throw new Error("F14 execution/profile mismatch");
    const actual = response.search?.actualSelections;
    if (response.search?.requestedSelections !== request.execution.budget.selections
        || (timeBudget ? !Number.isSafeInteger(actual) || actual < 1 || actual > request.execution.budget.selections
          : actual !== request.execution.budget.selections)) throw new Error("F14 selection budget not met");
    if (typeof response.selectedIdentity !== "string" || response.selectedIdentity.length === 0) throw new Error("invalid F14 selectedIdentity");
    const identities = response.ranking?.identities;
    if (!Array.isArray(identities) || !identities.includes(response.selectedIdentity)) throw new Error("F14 selected identity is not in ranking");
    assertF14CandidateScores(response);
    assertF14SelectedPlacement(response.selectedPlacement);
    if (response.profileId === CORE_ALLSPIN_PROFILE) {
      const diagnostics = response.diagnostics;
      if (diagnostics == null || typeof diagnostics !== "object" || Array.isArray(diagnostics)
          || diagnostics.postSpinPolicyId !== POST_SPIN_POLICY_OFF
          || !Number.isSafeInteger(diagnostics.nonTSetupWitnessCalls) || diagnostics.nonTSetupWitnessCalls < 0
          || !Number.isSafeInteger(diagnostics.nonTSetupBonusApplied) || diagnostics.nonTSetupBonusApplied < 0) throw new Error("invalid F14 core-allspin diagnostics");
    }
  }
  if (response.profileId === ROOT_OBJECTIVE_PROFILE) {
    if (!["off", "conversion-permutation-v1"].includes(request.execution.allocationMode)) throw new Error("invalid root objective allocation mode");
    const requiresCoreDiagnostics = response.status === "move" || (response.status === "error" && response.reason === "empty-candidates");
    if (requiresCoreDiagnostics) {
      const diagnostics = response.diagnostics;
      const fields = ["coreRankingComposeCalls", "coreRerankCalls", "coreConversionComputeCalls", "postStageConversionComputeCalls", "postStageConversionAddCalls", "postStageRerankCalls"];
      if (diagnostics == null || typeof diagnostics !== "object" || Array.isArray(diagnostics)
          || fields.some((field) => !Number.isSafeInteger(diagnostics[field]) || diagnostics[field] < 0)
          || fields.slice(3).some((field) => diagnostics[field] !== 0)) throw new Error("invalid F14 root objective diagnostics");
    }
  }
  if (response.status !== "move" && response.selectedMove !== null) throw new Error("unexpected F14 move payload");
  if (response.status !== "move" && response.selectedPlacement != null) throw new Error("unexpected F14 selectedPlacement");
  if (typeof response.reason !== "string" || response.reason.length > 256) throw new Error("invalid F14 reason");
  return response;
}

export function createF14DecideRequest(decision, execution, { requestId, generation = 1 } = {}) {
  const start = decision.start;
  const request = {
    type: "f14_decide", schemaVersion: 1, requestId: requestId ?? `f14-request-${generation}`,
    positionId: `f14-position-${decision.seed ?? generation}`, generation,
    execution: structuredClone(execution),
    start: { board: boardCellsToTbpBoard(start.boardCells), queue: start.queue.slice(0, F14_COMPAT_QUEUE_LIMIT), hold: start.hold,
      combo: start.combo, back_to_back: start.back_to_back, b2b: start.b2b, randomizer: structuredClone(start.randomizer) },
    selector: structuredClone(decision.selector),
  };
  assertF14StartSelectorProjection(request.start, request.selector);
  return request;
}

export function f14DecisionFromCanonical(state) {
  const queue = [state.pieces.current, ...state.pieces.known].filter((piece) => piece != null);
  return {
    start: { boardCells: state.board.cells, queue: queue.slice(0, F14_COMPAT_QUEUE_LIMIT), hold: state.pieces.hold ?? null,
      combo: state.chain.combo, back_to_back: state.chain.b2b > 0, b2b: state.chain.b2b,
      randomizer: { type: "seven_bag", bag_state: [] } },
    selector: {
      rulesetId: state.rulesetId,
      board: { fidelity: "exact", width: state.board.width, height: state.board.height, visibleHeight: state.board.visibleHeight, bufferHeight: state.board.bufferHeight, cells: state.board.cells },
      pieces: { current: state.pieces.current, hold: state.pieces.hold ?? null, holdAvailable: state.pieces.holdAvailable !== false, known: [...state.pieces.known] },
      chain: { combo: state.chain.combo, b2b: state.chain.b2b }, time: structuredClone(state.time), incoming: { pendingRows: 0, dueThisLockRows: 0 },
    },
  };
}
