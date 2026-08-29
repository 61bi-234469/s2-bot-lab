import { canonicalize } from "./cs1-core.mjs";
import {
  evaluateS2F12PostTankSolvencyRescueCandidates,
  formatS2F12PostTankSolvencyRescueSelection,
} from "./s2-f12-post-tank-solvency-rescue-selector.mjs";
import { fullStateKey } from "./state-keys.mjs";
import { resolvePlacementRules } from "./ruleset-profiles.mjs";
import { applyTransition } from "./transition.mjs";

export const S2_THRESHOLD_IMMINENT_B2B_RETENTION_SELECTOR_POLICY =
  "f25-threshold-imminent-b2b-retention-rescue-only/1";

export function resolveS2B2bChargingThresholdFromRules(rules) {
  const charging = rules?.b2bCharging;
  if (charging === false || charging === null || typeof charging !== "object" ||
      !Number.isSafeInteger(charging.at) || charging.at <= 0 ||
      !Number.isSafeInteger(charging.base) || charging.base < 0) {
    throw new Error("F25 rescue requires an enabled canonical B2B charging object");
  }
  return charging.at;
}

export function resolveS2B2bChargingThreshold(state) {
  if (typeof state?.rulesetId !== "string" || state.rulesetId.length === 0) {
    throw new Error("F25 rescue requires a canonical ruleset id");
  }
  return resolveS2B2bChargingThresholdFromRules(resolvePlacementRules(state.rulesetId));
}

function identityKey(candidate) {
  if (candidate?.identity === undefined) {
    throw new Error("F25 rescue requires identity-unique canonical candidate evidence");
  }
  return canonicalize(candidate.identity);
}

function assertCandidateEvidence(candidate, stateKey) {
  const evidence = candidate?.thresholdRetention;
  if (!Number.isSafeInteger(candidate?.cc2Rank) || candidate.cc2Rank < 0 ||
      evidence?.legal !== true || evidence.stateKey !== stateKey ||
      typeof evidence.nextStateKey !== "string" || evidence.nextStateKey.length === 0 ||
      !Number.isSafeInteger(evidence.linesCleared) || evidence.linesCleared < 0 ||
      !Number.isSafeInteger(evidence.b2bAfter) || evidence.b2bAfter < 0 ||
      !Number.isSafeInteger(evidence.surgeSent) || evidence.surgeSent < 0 ||
      !Number.isSafeInteger(evidence.cancelled) || evidence.cancelled < 0 ||
      !Number.isSafeInteger(evidence.solvency)) {
    throw new Error("F25 rescue requires exact canonical evidence for every candidate");
  }
}

function assertCompletePrefix(candidates) {
  const ranks = candidates.map((candidate) => candidate.cc2Rank).sort((left, right) => left - right);
  if (ranks.some((rank, index) => rank !== index)) {
    throw new Error("F25 rescue requires a complete contiguous CC2 prefix");
  }
  const identities = candidates.map(identityKey);
  if (new Set(identities).size !== identities.length) {
    throw new Error("F25 rescue requires identity-unique canonical candidate evidence");
  }
}

export function chooseS2ThresholdImminentB2bRetention(candidates, f14Choice, context) {
  if (!Array.isArray(candidates) || candidates.length < 2 || f14Choice?.selected === undefined) {
    throw new Error("F25 rescue requires F14-ranked candidates and an exact F14 decision");
  }
  const { chargingAt, b2bBefore, pendingBefore, stateKey } = context ?? {};
  if (!Number.isSafeInteger(chargingAt) || chargingAt <= 0 ||
      !Number.isSafeInteger(b2bBefore) || b2bBefore < 0 ||
      !Number.isSafeInteger(pendingBefore) || pendingBefore < 0 ||
      typeof stateKey !== "string" || stateKey.length === 0) {
    throw new Error("F25 rescue requires exact canonical source-state evidence");
  }
  candidates.forEach((candidate) => assertCandidateEvidence(candidate, stateKey));
  assertCompletePrefix(candidates);

  const controlIndex = candidates.indexOf(f14Choice.selected);
  if (controlIndex < 0) {
    throw new Error("F25 F14 control must be one of the exact ranked candidates");
  }
  const rankOne = candidates.filter((candidate) => candidate.cc2Rank === 1);
  if (rankOne.length !== 1) {
    throw new Error("F25 rescue requires the exact CC2 rank-1 prefix member");
  }
  const control = candidates[controlIndex];
  const keeper = rankOne[0];
  const controlEvidence = control.thresholdRetention;
  const keeperEvidence = keeper.thresholdRetention;
  const triggered = b2bBefore === chargingAt &&
    controlEvidence.linesCleared > 0 &&
    controlEvidence.b2bAfter === 0 &&
    controlEvidence.surgeSent === 0 &&
    pendingBefore === 0 &&
    controlEvidence.cancelled === 0 &&
    keeperEvidence.linesCleared === 0 &&
    keeperEvidence.b2bAfter === b2bBefore &&
    keeperEvidence.solvency >= 0;
  return Object.freeze({
    control,
    selected: triggered ? keeper : control,
    keeper,
    triggered,
  });
}

function pendingGarbageBefore(state) {
  if (state?.garbage?.fidelity !== "exact" || !Array.isArray(state.garbage.packets)) {
    throw new Error("F25 rescue requires exact canonical pending garbage");
  }
  const total = state.garbage.packets.reduce((sum, packet) => {
    if (!Number.isSafeInteger(packet?.amount) || packet.amount < 0) {
      throw new Error("F25 rescue requires exact canonical pending garbage");
    }
    return sum + packet.amount;
  }, 0);
  if (!Number.isSafeInteger(total)) {
    throw new Error("F25 rescue requires exact canonical pending garbage");
  }
  return total;
}

function surgeSent(transition) {
  const chunks = transition?.attackStages?.surgeChunks;
  if (!Array.isArray(chunks) || !chunks.every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error("F25 rescue requires exact canonical Surge evidence");
  }
  return chunks.reduce((total, value) => total + value, 0);
}

function enrichCandidate(state, stateKey, candidate) {
  const transition = applyTransition(
    structuredClone(state),
    { kind: "placement", placement: structuredClone(candidate.placement) },
    state.rulesetId,
  );
  if (transition?.legality?.legal !== true || transition.nextState === null) {
    throw new Error("F25 rescue requires a legal canonical transition for every candidate");
  }
  const nextStateKey = fullStateKey(transition.nextState);
  const verification = candidate.verification;
  if (verification?.transition?.legality?.legal !== true || verification.transition.nextState === null ||
      verification.comparison?.positionFingerprint !== stateKey ||
      fullStateKey(verification.transition.nextState) !== nextStateKey ||
      candidate.solvency?.stateKey !== stateKey || candidate.solvency.nextStateKey !== nextStateKey ||
      !Number.isSafeInteger(candidate.solvency?.solvency)) {
    throw new Error("F25 rescue requires replay-bound F14 evidence for every candidate");
  }
  const linesCleared = transition.lockResult?.lines;
  const b2bAfter = transition.chain?.b2bAfter;
  const cancelled = transition.cancelResult?.cancelled;
  if (!Number.isSafeInteger(linesCleared) || linesCleared < 0 ||
      !Number.isSafeInteger(b2bAfter) || b2bAfter < 0 ||
      !Number.isSafeInteger(cancelled) || cancelled < 0) {
    throw new Error("F25 rescue requires exact canonical lock evidence");
  }
  return {
    ...candidate,
    thresholdRetention: Object.freeze({
      stateKey,
      nextStateKey,
      legal: true,
      linesCleared,
      b2bAfter,
      surgeSent: surgeSent(transition),
      cancelled,
      solvency: candidate.solvency.solvency,
    }),
  };
}

function retentionDiagnostic(candidate, choice, context) {
  const evidence = candidate.thresholdRetention;
  const applied = choice.triggered && candidate === choice.selected;
  return Object.freeze({
    chargingAt: context.chargingAt,
    b2bBefore: context.b2bBefore,
    pendingBefore: context.pendingBefore,
    linesCleared: evidence.linesCleared,
    b2bAfter: evidence.b2bAfter,
    surgeSent: evidence.surgeSent,
    cancelled: evidence.cancelled,
    solvency: evidence.solvency,
    applied,
    qualifies: candidate.cc2Rank === 1 && evidence.linesCleared === 0 &&
      evidence.b2bAfter === context.b2bBefore && evidence.solvency >= 0,
    units: applied ? 1 : 0,
  });
}

export function selectS2ThresholdImminentB2bRetentionPlacement(guiState, moves, options = {}) {
  const evaluation = evaluateS2F12PostTankSolvencyRescueCandidates(guiState, moves, {
    ...options,
    unverifiableCandidatePolicy: "fail-closed",
  });
  const f14 = formatS2F12PostTankSolvencyRescueSelection(evaluation);
  const expectedCandidates = Math.min(evaluation.candidateLimit, evaluation.base.returnedCandidateCount);
  if (evaluation.base.rejectedCandidates.length !== 0 || evaluation.candidates.length !== expectedCandidates) {
    throw new Error("F25 rescue requires a complete replay-verified F14-compatible prefix");
  }
  const state = evaluation.base.state;
  if (state?.chain?.fidelity !== "exact" || !Number.isSafeInteger(state.chain.b2b) || state.chain.b2b < 0) {
    throw new Error("F25 rescue requires an exact canonical B2B source state");
  }
  const stateKey = fullStateKey(state);
  const context = Object.freeze({
    chargingAt: resolveS2B2bChargingThreshold(state),
    b2bBefore: state.chain.b2b,
    pendingBefore: pendingGarbageBefore(state),
    stateKey,
  });
  const candidates = evaluation.candidates.map((candidate) => enrichCandidate(state, stateKey, candidate));
  const selectedIndex = evaluation.candidates.indexOf(evaluation.choice.selected);
  if (selectedIndex < 0) throw new Error("F25 rescue lost the exact F14 selected candidate");
  const choice = chooseS2ThresholdImminentB2bRetention(
    candidates,
    { ...evaluation.choice, selected: candidates[selectedIndex] },
    context,
  );
  if (!choice.triggered) return f14;
  const best = choice.selected;
  return {
    ...best.verification,
    move: structuredClone(best.move),
    comparison: {
      ...best.verification.comparison,
      engineId: "s2-threshold-imminent-b2b-retention-selector/1",
      source: S2_THRESHOLD_IMMINENT_B2B_RETENTION_SELECTOR_POLICY,
      moveSelectionPolicy: S2_THRESHOLD_IMMINENT_B2B_RETENTION_SELECTOR_POLICY,
      baseMoveSelectionPolicy: "f12-control-with-post-tank-solvency-rescue-only/1",
      selectedCc2Rank: best.cc2Rank,
      postTankSolvency: best.solvency,
      thresholdImminentB2bRetention: {
        applied: true,
        chargingAt: context.chargingAt,
        b2bBefore: context.b2bBefore,
        pendingBefore: context.pendingBefore,
        controlCc2Rank: choice.control.cc2Rank,
        selectedCc2Rank: best.cc2Rank,
      },
    },
    candidates: candidates.map((candidate) => ({
      cc2Rank: candidate.cc2Rank,
      identity: candidate.identity,
      s2Score: candidate.s2Score,
      selectionScore: candidate.selectionScore,
      conversion: candidate.conversion,
      solvency: candidate.solvency,
      thresholdRetention: retentionDiagnostic(candidate, choice, context),
    })),
  };
}
