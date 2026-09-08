import { projectS2AmountOnlyIncomingSnapshot } from "./s2-amount-only-incoming-snapshot.mjs";
import { INPUT_DECISION_REQUEST_ID, assertInputDecisionRequest } from "./input-decision-request.mjs";
import {
  S2_AMOUNT_ONLY_DECISION_REQUEST_ID,
  S2_AMOUNT_ONLY_DECISION_STATE_ID,
  assertS2AmountOnlyDecisionRequest,
  isAdr062QualifiedStaticType,
} from "./s2-amount-only-decision-request.mjs";

export { S2_AMOUNT_ONLY_DECISION_STATE_ID, S2_AMOUNT_ONLY_DECISION_REQUEST_ID, isAdr062QualifiedStaticType };

export function isGuiStaticType(type) {
  return type === "cc2-raw" || type === "cc2-chouhy" || isAdr062QualifiedStaticType(type);
}

export function createGuiStaticDecisionRequest(options) {
  if (options.type !== "cc2-raw" && options.type !== "cc2-chouhy") {
    return createS2AmountOnlyDecisionRequest(options);
  }
  if (options.engine?.botType !== options.type) throw new Error("input decision engine identity mismatch");
  const request = {
    id: INPUT_DECISION_REQUEST_ID, sessionKey: options.sessionKey,
    decision: createS2AmountOnlyDecisionState(options.state), moves: structuredClone(options.moves),
    // The shared input envelope identifies the bot profile, while native GUI
    // response metadata retains its revision-qualified engine identity.
    type: options.type, engine: { botType: options.type, engineId: options.type },
  };
  assertInputDecisionRequest(request);
  return Object.freeze(request);
}

export function createS2AmountOnlyDecisionState(state) {
  const incoming = projectS2AmountOnlyIncomingSnapshot(state);
  const board = state?.board;
  const pieces = state?.pieces;
  const chain = state?.chain;
  const time = state?.time;
  if (board?.fidelity !== "exact" || typeof board.cells !== "string") {
    throw new Error("amount-only decision state requires an exact board");
  }
  if (pieces?.fidelity !== "exact" || chain?.fidelity !== "exact" || time?.fidelity !== "exact") {
    throw new Error("amount-only decision state requires exact public state");
  }
  const decision = {
    id: S2_AMOUNT_ONLY_DECISION_STATE_ID,
    rulesetId: state.rulesetId,
    board: {
      width: board.width,
      height: board.height,
      visibleHeight: board.visibleHeight,
      cells: board.cells,
    },
    pieces: {
      current: pieces.current,
      hold: pieces.hold,
      known: [...pieces.known],
      holdAvailable: pieces.holdAvailable === true,
    },
    chain: { combo: chain.combo, b2b: chain.b2b },
    lockTime: {
      logicalFrame: time.logicalFrame,
      piecesPlaced: time.piecesPlaced,
      frameSemantics: time.frameSemantics,
    },
    incoming: { pendingRows: incoming.pendingRows, dueThisLockRows: incoming.dueThisLockRows },
  };
  assertDecisionState(decision);
  return Object.freeze(decision);
}

export function createS2AmountOnlyDecisionRequest({ sessionKey, state, moves, type, engine }) {
  if (!isAdr062QualifiedStaticType(type)) {
    throw new Error("ADR-062-qualified resolver required");
  }
  if (!Array.isArray(moves) || moves.length === 0) throw new Error("amount-only decision requires moves");
  if (engine?.botType !== type || typeof engine?.engineId !== "string" || engine.engineId.length === 0) {
    throw new Error("amount-only decision engine identity mismatch");
  }
  const request = {
    id: S2_AMOUNT_ONLY_DECISION_REQUEST_ID,
    sessionKey,
    decision: createS2AmountOnlyDecisionState(state),
    moves: structuredClone(moves),
    type,
    engine: { botType: engine.botType, engineId: engine.engineId },
  };
  assertS2AmountOnlyDecisionRequest(request);
  return Object.freeze(request);
}

/** Rebuilds a synthetic GUI input which contains no referee garbage state. */
export function decisionStateToSyntheticGui(decision) {
  assertDecisionState(decision);
  const { board, pieces, chain, lockTime } = decision;
  return {
    board: Array.from({ length: board.height }, (_, y) => Array.from({ length: board.width }, (_, x) => {
      const cell = board.cells[y * board.width + x];
      return cell === "_" ? null : cell;
    })),
    queue: [pieces.current, ...pieces.known].filter((piece) => piece !== null),
    hold: pieces.hold,
    combo: chain.combo,
    back_to_back: chain.b2b > 0,
    randomizer: { type: "seven_bag", bag_state: [] },
    s2: {
      b2b: chain.b2b,
      // This is a fixed empty evaluator value, not referee data.  No future
      // garbage can be generated because the queue is empty.
      garbage: {
        packets: [],
        generatorState: {
          rngState: 0,
          lastTankFrame: 0,
          lastHoleColumn: -1,
          sentForOpener: 0,
          holeChanged: false,
          receivedCountSinceReset: 0,
        },
        capState: { consumedThisTick: 0 },
        fidelity: "exact",
      },
      time: { ...lockTime, fidelity: "exact" },
      movement: { phase: "active-piece", lastWasClear: false },
      clock: { kind: "synthetic-fixed-lock-step", framesPerLock: 1 },
    },
  };
}

function assertDecisionState(decision) {
  const expected = ["board", "chain", "id", "incoming", "lockTime", "pieces", "rulesetId"];
  if (decision === null || typeof decision !== "object" || decision.id !== S2_AMOUNT_ONLY_DECISION_STATE_ID ||
      JSON.stringify(Object.keys(decision).sort()) !== JSON.stringify(expected)) {
    throw new Error("invalid amount-only decision state");
  }
  if (!Number.isSafeInteger(decision.incoming?.pendingRows) || !Number.isSafeInteger(decision.incoming?.dueThisLockRows) ||
      decision.incoming.pendingRows < 0 || decision.incoming.dueThisLockRows < 0 ||
      decision.incoming.dueThisLockRows > decision.incoming.pendingRows) {
    throw new Error("invalid amount-only incoming rows");
  }
}
