import { resolvePlacementRules, rulesetOverrides } from "./ruleset-profiles.mjs";
import { createTrace, record } from "./trace.mjs";
import { confirmGarbage, receiveGarbage } from "./triangle/garbage-adapter.mjs";
import { evaluatePlacement } from "./triangle/placement-adapter.mjs";

// The one entry point that turns an `S-FIXTURE/1` action into a staged
// transition result. Fixtures declare `action.kind`, so dispatching here (and
// not in each test) means a fixture cannot quietly be executed by the wrong
// transition, and an action kind the schema declares but the Simulator does not
// implement is visible as a failure rather than as an absent test.
//
// Every kind returns the same stage envelope. Stages a kind does not produce
// are null, never omitted or defaulted, so a comparison against `expected`
// cannot pass by leaving a stage out.
const UNPRODUCED_STAGES = Object.freeze({
  lockResult: null,
  chain: null,
  attackStages: null,
  cancelResult: null,
  tankResult: null,
});

export const TRANSITION_KINDS = Object.freeze([
  "placement",
  "garbage-receive",
  "garbage-confirm",
  "tick",
]);

// The tracing entry point is separate from `applyTransition` so that the
// production signature and the production result stay exactly what the fixture
// corpus hashes. Callers get the same `result` either way plus a list of what
// the transition read on the way there.
export function traceTransition(state, action, rulesetId = state.rulesetId) {
  const trace = createTrace();
  const result = applyTransition(state, action, rulesetId, trace);
  return { result, trace: trace.entries };
}

export function applyTransition(state, action, rulesetId = state.rulesetId, trace = null) {
  // Resolving the ruleset for every kind, not only for placements, keeps an
  // unknown ruleset a hard failure rather than something only rule-sensitive
  // transitions notice.
  const rules = resolvePlacementRules(rulesetId);
  if (state.rulesetId !== rulesetId) {
    throw new Error(`state declares ruleset ${state.rulesetId}, not ${rulesetId}`);
  }
  record(trace, "ruleset", {
    rulesetId,
    overrides: rulesetOverrides(rulesetId),
    actionKind: action.kind,
  });

  switch (action.kind) {
    case "placement":
      return evaluatePlacement(state, action.placement, rules, trace);
    case "garbage-receive":
      return receiveTransition(state, action, trace);
    case "garbage-confirm":
      return confirmTransition(state, action, trace);
    case "tick":
      return tickTransition(state, action, trace);
    default:
      throw new Error(`unsupported action kind ${action.kind}`);
  }
}

function receiveTransition(state, action, trace) {
  const nextGarbage = receiveGarbage(state.garbage, action.packet);
  record(trace, "garbage-queue", {
    before: state.garbage.packets,
    after: nextGarbage.packets,
  });
  return {
    legality: { legal: true, reason: null },
    ...UNPRODUCED_STAGES,
    nextState: withGarbage(state, nextGarbage),
  };
}

function confirmTransition(state, action, trace) {
  const nextGarbage = confirmGarbage(state.garbage, action);
  record(trace, "garbage-queue", {
    before: state.garbage.packets,
    after: nextGarbage === null ? null : nextGarbage.packets,
  });
  if (nextGarbage === null) {
    return {
      legality: { legal: false, reason: "packet-unknown" },
      ...UNPRODUCED_STAGES,
      nextState: null,
    };
  }
  return {
    legality: { legal: true, reason: null },
    ...UNPRODUCED_STAGES,
    nextState: withGarbage(state, nextGarbage),
  };
}

// A tick advances logical time and nothing else. Triangle tanks only inside the
// lock handler (`engine/index.ts`, the non-clear branch that calls
// `garbageQueue.tank`), never from a frame step, so a tick that also tanked
// would consume garbage the lock path is going to consume again. Advancing the
// frame still matters: packet eligibility is compared against the current
// frame, so a tick decides what the next lock is allowed to take.
function tickTransition(state, action, trace) {
  if (state.time?.fidelity !== "exact") {
    throw new Error("tick transitions require exact canonical time state");
  }
  if (state.time.frameSemantics !== "virtual-tank-only") {
    // `engine-frame` semantics count real engine frames, which carry gravity,
    // ARE and lock delay. None of those are modelled here.
    throw new Error(`tick is not defined for frame semantics ${state.time.frameSemantics}`);
  }
  if (action.fromFrame !== state.time.logicalFrame) {
    throw new Error(
      `tick starts at frame ${action.fromFrame}, but the state is at ${state.time.logicalFrame}`,
    );
  }
  if (!Number.isSafeInteger(action.toFrame) || action.toFrame <= action.fromFrame) {
    throw new Error("tick must advance to a later frame");
  }

  const nextState = structuredClone(state);
  nextState.time.logicalFrame = action.toFrame;
  record(trace, "time", {
    fromFrame: action.fromFrame,
    toFrame: action.toFrame,
    frameSemantics: state.time.frameSemantics,
    // Which packets the next lock is now allowed to take is the only thing a
    // tick changes, so it is the only thing worth tracing about one.
    eligiblePackets: state.garbage.packets
      .filter((packet) => packet.arrivalFrame <= action.toFrame)
      .map((packet) => packet.packetId),
  });
  return {
    legality: { legal: true, reason: null },
    ...UNPRODUCED_STAGES,
    nextState,
  };
}

// Cloning the input state keeps the next state's field set identical to the
// input's. A garbage-only state stays garbage-only instead of gaining empty
// board or piece fields it never had.
function withGarbage(state, garbage) {
  const nextState = structuredClone(state);
  nextState.garbage = garbage;
  return nextState;
}
