// Rule RG on the INPUT route. INPUT sees only the
// amount-only decision, so RG's position is rebuilt from the champion request's selector (board, pieces with the
// visible NEXT, chain, lock time, pending and due rows): the same inputs the rule reads from a referee state in the
// native match runner. No Node imports.
//
// Results are kept per key so a speculative search's RG can serve the real decision: the key is the selector, the
// champion's selected identity and ranking, and the root child values RG reads. The lock frame is left out of the key
// while it is below RG_FRAME_INVARIANT_BELOW: until the garbage multiplier leaves its base (frame 10,800) the spike
// search and the lock rules give the same answer at any frame, and the deepest frame RG reaches is 780 past the
// decision (a 60-frame child, then 12 locks of 60). NEXT counts up to RG_KEY_KNOWN pieces. Any other change
// (incoming rows, those NEXT pieces, the core's answer) computes RG again.
import { canonicalize } from "../scripts/cs1.mjs";
import { guiStateToCanonical } from "./gui-state.mjs";
import { decisionStateToSyntheticGui } from "./s2-amount-only-decision-state.mjs";
import { projectS2AmountOnlyIncomingSnapshot } from "./s2-amount-only-incoming-snapshot.mjs";
import { RG_RULE, createRgRule } from "./rg-spike-rerank.mjs";
import { applyTransition } from "./transition.mjs";

export const RG_FRAME_INVARIANT_BELOW = 9_900;
// RG reads at most 16 NEXT pieces: a child's lock takes one (two when HOLD was empty) and the spike search then sees
// 14 (known_cap). A longer NEXT that agrees on these gives the same answer.
export const RG_KEY_KNOWN = 16;
const DECISION_STATE_ID = "s2-amount-only-decision-state/1";

/** RG's position for a champion request: the selector's public state with the amount-only garbage queue. */
export function rgStateFromRequest(request) {
  const s = request?.selector;
  if (!s?.board || !s.pieces || !s.chain || !s.time || !s.incoming) throw new Error("RG needs a champion request selector");
  const decision = { id: DECISION_STATE_ID, rulesetId: s.rulesetId,
    board: { width: s.board.width, height: s.board.height, visibleHeight: s.board.visibleHeight, cells: s.board.cells },
    pieces: { current: s.pieces.current, hold: s.pieces.hold ?? null, known: [...s.pieces.known], holdAvailable: s.pieces.holdAvailable === true },
    chain: { combo: s.chain.combo, b2b: s.chain.b2b },
    lockTime: { logicalFrame: s.time.logicalFrame, piecesPlaced: s.time.piecesPlaced, frameSemantics: s.time.frameSemantics },
    incoming: { pendingRows: s.incoming.pendingRows, dueThisLockRows: s.incoming.dueThisLockRows } };
  const state = { ...guiStateToCanonical(decisionStateToSyntheticGui(decision)), rulesetId: s.rulesetId };
  // The packets of src-js/rg-spike-rerank.mjs amountOnlyGarbage: due rows land at this lock, the rest at the next.
  const frame = state.time.logicalFrame, packets = [];
  const packet = (amount, arrivalFrame) => packets.push({ packetId: packets.length + 1, sourceGameId: 9998, amount, holeSize: 1,
    arrivalFrame, confirmed: true, order: packets.length });
  const { pendingRows, dueThisLockRows } = decision.incoming;
  if (dueThisLockRows > 0) packet(dueThisLockRows, frame - 600);
  if (pendingRows > dueThisLockRows) packet(pendingRows - dueThisLockRows, frame + 40);
  state.garbage.packets = packets;
  Object.assign(state.garbage.generatorState, { rngState: RG_RULE.publicGarbage.holeSeed, lastHoleColumn: -1, holeChanged: false,
    sentForOpener: 0, receivedCountSinceReset: 0 });
  const seen = projectS2AmountOnlyIncomingSnapshot(state);
  if (seen.pendingRows !== pendingRows || seen.dueThisLockRows !== dueThisLockRows) throw new Error("RG position does not project its incoming rows");
  return state;
}

/**
 * A speculative request with the incoming rows guessed for it: the rows left after `placement` locks on the
 * current request's RG position (cancel, tank). The speculative search's own request carries none (it is predicted
 * from a position without packets). A guess is only a cache key: a wrong one costs a computation, never a move.
 */
export function rgGuessIncoming(nextRequest, currentRequest, placement) {
  if (!placement) return nextRequest;
  try {
    const state = rgStateFromRequest(currentRequest);
    const tr = applyTransition(state, { kind: "placement", placement }, state.rulesetId);
    if (tr.legality?.legal !== true || !tr.nextState) return nextRequest;
    const { pendingRows, dueThisLockRows } = projectS2AmountOnlyIncomingSnapshot(tr.nextState);
    return { ...nextRequest, selector: { ...nextRequest.selector, incoming: { pendingRows, dueThisLockRows } } };
  } catch {
    return nextRequest;
  }
}

/** The cache key of one RG result (see the header). */
export function rgKey(request, response, rootChildValues) {
  const selector = structuredClone(request.selector);
  if (selector.time.logicalFrame < RG_FRAME_INVARIANT_BELOW) selector.time.logicalFrame = "below-multiplier-ramp";
  selector.pieces.known = selector.pieces.known.slice(0, RG_KEY_KNOWN);
  return canonicalize({ selector, selected: response.selectedIdentity ?? null, identities: response.ranking?.identities ?? [],
    children: rootChildValues?.children ?? null });
}

/** The wait modes of `createInputRg`. */
export function normalizeRgWait(wait = "block") {
  if (wait === "block" || wait === "ready") return wait;
  if (Number.isSafeInteger(wait) && wait > 0 && wait <= 1_000) return wait;
  throw new Error(`invalid RG wait ${JSON.stringify(wait)}: "block", "ready" or 1-1000 ms`);
}

/**
 * RG for one INPUT side over a spike search (src-js/spike-wasm-client.mjs). `apply(request, response, rootChildValues)`
 * returns the rule's result (choice null = keep the core's move) and whether it came from the cache; `prepare` starts
 * the same computation for a speculative search without waiting. Failures reject (no fallback move). `onApply`
 * (checks only) sees every applied decision with its inputs and result. `onFailure` hears every failed computation,
 * a speculative one included; a move response without root child values throws.
 *
 * `wait`: "block" (default) waits for RG on every decision, as before. "ready" and a
 * number of ms are the non-blocking forms: a decision uses RG's result only when it is already computed ("ready") or
 * finishes within that many ms; otherwise it keeps the core's move (`ready: false`, reason "not-ready"). A decision
 * never starts a computation it would not wait for. The non-blocking forms bound the background work: one
 * computation runs at a time, at most `maxQueued` wait behind it (a newer prepare drops the oldest queued one), the
 * newest queued runs next, and a decision drops every queued computation for its piece or an earlier one. A result
 * that arrives after its decision only fills the cache; it never changes a move already made. "Not ready" and
 * "dropped" are not failures; a failed computation still fails as in "block". `settle()` drops the queue and waits
 * for every started computation (a round's checks call it before closing so no failure goes unseen).
 */
export function createInputRg(spike, { capacity = 8, onApply = null, onPrepare = null, onFailure = null, wait = "block",
  maxQueued = 1, now = () => performance.now(), createRule = createRgRule } = {}) {
  const mode = normalizeRgWait(wait);
  if (!Number.isSafeInteger(maxQueued) || maxQueued < 1 || maxQueued > 8) throw new Error("invalid RG maxQueued");
  // `createRule` is replaced only by the scheduling tests.
  const rule = createRule(spike);
  const cache = new Map();
  const started = new Set();
  const queue = [];
  let running = null;
  const counters = { started: 0, dropped: 0, maxQueue: 0 };
  const remember = (key, entry) => {
    cache.set(key, entry);
    while (cache.size > capacity) {
      const [oldKey, old] = cache.entries().next().value;
      if (old.state === "queued") drop(old);
      else cache.delete(oldKey);
    }
  };
  function drop(entry) {
    const k = queue.indexOf(entry);
    if (k >= 0) queue.splice(k, 1);
    entry.state = "dropped"; entry.doneAt = now(); counters.dropped++;
    if (cache.get(entry.key) === entry) cache.delete(entry.key);
  }
  const run = (entry) => {
    entry.state = "running"; entry.startedAt = now(); counters.started++;
    const { request, response, rootChildValues } = entry.input;
    const withChildren = { ...response, diagnostics: { ...(response.diagnostics ?? {}), rootChildValues } };
    entry.promise = Promise.resolve().then(() => rule.ruleRG(rgStateFromRequest(request), request, withChildren))
      .then((result) => { entry.state = "done"; entry.doneAt = now(); entry.result = result; return result; },
        (error) => { entry.state = "failed"; entry.doneAt = now(); throw error; });
    // A failure is reported even when no decision ever waits for this key (a speculation that was not used).
    entry.promise.catch((error) => onFailure?.(error));
    started.add(entry.promise);
    entry.promise.then(() => started.delete(entry.promise), () => started.delete(entry.promise));
    return entry.promise;
  };
  const newEntry = (request, response, rootChildValues, origin) => ({ key: rgKey(request, response, rootChildValues), origin,
    input: { request, response, rootChildValues }, piece: request.selector.time.piecesPlaced, state: "queued", queuedAt: now(), promise: null });
  // Block: the computation starts at once (the behaviour before the wait modes).
  const computeBlock = (request, response, rootChildValues, origin) => {
    const entry = newEntry(request, response, rootChildValues, origin);
    if (cache.has(entry.key)) return { entry: cache.get(entry.key), cached: true };
    run(entry);
    remember(entry.key, entry);
    return { entry, cached: false };
  };
  // Non-blocking: one running computation, a short queue, newest first.
  function pump() {
    if (running !== null || queue.length === 0) return;
    const entry = queue.pop();
    running = entry;
    run(entry).then(() => {}, () => {}).finally(() => { running = null; pump(); });
  }
  function enqueue(request, response, rootChildValues, origin) {
    const entry = newEntry(request, response, rootChildValues, origin);
    if (cache.has(entry.key)) return;
    queue.push(entry);
    while (queue.length > maxQueued) drop(queue[0]);
    counters.maxQueue = Math.max(counters.maxQueue, queue.length);
    remember(entry.key, entry);
    pump();
  }
  const statusOf = (entry) => (entry === undefined ? "missing" : entry.state);
  const pendingState = (entry) => entry !== undefined && (entry.state === "queued" || entry.state === "running");
  return Object.freeze({
    wait: mode,
    counters: () => ({ ...counters, queued: queue.length, running: running !== null }),
    prepare(request, response, rootChildValues) {
      if (response?.status === "move" && rootChildValues) {
        onPrepare?.({ request, response, rootChildValues });
        if (mode === "block") computeBlock(request, response, rootChildValues, "prepare");
        else enqueue(request, response, rootChildValues, "prepare");
      }
    },
    async apply(request, response, rootChildValues) {
      if (response?.status !== "move") return { applicable: false, reason: "no-move", choice: null, cached: false };
      if (!rootChildValues) throw new Error("RG: a move response without root child values");
      if (mode === "block") {
        const { entry, cached } = computeBlock(request, response, rootChildValues, "apply");
        const result = { ...(await entry.promise), cached };
        onApply?.({ request, response, rootChildValues, result });
        return result;
      }
      const decidedAt = now();
      const entry = cache.get(rgKey(request, response, rootChildValues));
      const seen = statusOf(entry);
      if (mode !== "ready" && pendingState(entry)) {
        // A bounded wait: the decision's own key runs next if it is still queued.
        if (entry.state === "queued") { queue.splice(queue.indexOf(entry), 1); queue.push(entry); pump(); }
        const deadline = decidedAt + mode;
        while (pendingState(entry) && now() < deadline) {
          const left = Math.max(0, deadline - now());
          await Promise.race([(entry.promise ?? new Promise((r) => setTimeout(r, Math.min(left, 2)))).then(() => {}, () => {}),
            new Promise((r) => setTimeout(r, left))]);
        }
      }
      const usedAt = now();
      if (entry?.state === "failed") await entry.promise;
      // This piece and earlier ones are decided: their queued computations are stale.
      for (const q of [...queue]) if (q.piece <= request.selector.time.piecesPlaced) drop(q);
      const wait = { mode, seen, final: statusOf(entry), waitedMs: usedAt - decidedAt, decidedAt,
        origin: entry?.origin ?? null, queuedAt: entry?.queuedAt ?? null, startedAt: entry?.startedAt ?? null, doneAt: entry?.doneAt ?? null,
        queue: queue.length };
      const result = entry?.state === "done"
        ? { ...entry.result, cached: true, ready: true, wait }
        : { applicable: false, reason: "not-ready", choice: null, cached: false, ready: false, wait };
      // `later()` (checks only): where this decision's computation got to after the decision.
      onApply?.({ request, response, rootChildValues, result,
        later: () => ({ state: statusOf(entry), startedAt: entry?.startedAt ?? null, doneAt: entry?.doneAt ?? null }) });
      return result;
    },
    async settle() {
      for (const q of [...queue]) drop(q);
      await Promise.all([...started]);
    },
  });
}

/** The core's move order with RG's choice first (the planner adopts the first reachable move). */
export function rgInputMoves(moves, choice) {
  if (choice === null) return moves;
  const want = canonicalize(JSON.parse(choice));
  const k = moves.findIndex((move) => canonicalize(move) === want);
  if (k < 0) return null;
  return [moves[k], ...moves.slice(0, k), ...moves.slice(k + 1)];
}
