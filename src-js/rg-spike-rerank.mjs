// Rule RG (`spike-rerank-rg/1`, guarded spike re-rank) for the browser, without Node imports.
// Among the root children within q 2 of the selected move (q desc, max 6, selected included), pick the lowest
// amount-only spike height F'a that is 3+ rows below the selected move's, whose 13-lock pre-cancel attack A13 is no
// less, and whose own lock does not top out; otherwise keep the selected move. Ties: q desc, rank asc, identity.
// Single-candidate decisions are not searched; the candidates of a decision are resolved with one reachable listing
// and searched in one "batch" request (`evaluation: "batched"`).
// The spike search is any object with `request(line)` that answers "batch" requests: the WASM client or worker pool
// of src-js/spike-wasm-client.mjs.
// Only public amounts are read: the garbage queue is rebuilt from the pending and due row counts, with a
// public hole seed; referee RNG, packet ids and arrival frames are dropped.
import { cc2MoveToCanonicalPlacement } from "./cc2-s2-adapter.mjs";
import { applyTransition } from "./transition.mjs";
import { listS2AmountOnlyPublicReachablePlacements } from "./s2-amount-only-public-candidates.mjs";
import { projectS2AmountOnlyIncomingSnapshot } from "./s2-amount-only-incoming-snapshot.mjs";

export const RG_RULE = Object.freeze({ id: "spike-rerank-rg/1", delta: 2, maxCandidates: 6, margin: 3, spike: 20,
  settings: Object.freeze([Object.freeze({ width: 32, horizon: 12 })]),
  publicGarbage: Object.freeze({ holeSeed: 987654321, freshColumn: true }) });

export const isToppedOut = (state) => state.board.cells.slice(20 * state.board.width).split("").some((c) => c !== "_");

/** The state with a `rows`-row packet due at the next lock (as the spike-stress search injects it). */
export function injectSpike(state, rows, { holeSeed = null, freshColumn = false } = {}) {
  const next = structuredClone(state);
  const packets = next.garbage.packets;
  const order = packets.reduce((m, p) => Math.max(m, p.order), -1) + 1;
  const packetId = packets.reduce((m, p) => Math.max(m, p.packetId), 0) + 1;
  packets.push({ packetId, sourceGameId: 9999, amount: rows, holeSize: 1, arrivalFrame: next.time.logicalFrame - 600,
    confirmed: true, order });
  if (holeSeed !== null) next.garbage.generatorState.rngState = holeSeed;
  if (freshColumn) { next.garbage.generatorState.lastHoleColumn = -1; next.garbage.generatorState.holeChanged = false; }
  return next;
}

export function boardColumns(board) {
  const occupancy = Array(10).fill(0n), g = Array(10).fill(0n);
  for (let y = 0; y < board.height; y++) for (let x = 0; x < board.width; x++) {
    const c = board.cells[y * board.width + x];
    if (c !== "_") occupancy[x] |= 1n << BigInt(y);
    if (c === "G") g[x] |= 1n << BigInt(y);
  }
  return { occupancy, g };
}

/** One spike-search request line for a state whose spike is already injected (columns are BigInt). */
export function toSearchRequest(id, state, settings, { known = 14 } = {}) {
  if (state.board.width !== 10 || state.board.height !== 40) throw new Error("spike search needs a 10x40 board");
  const { occupancy, g } = boardColumns(state.board);
  const gs = state.garbage.generatorState;
  return { id, mode: "search", spike: 0, known_cap: known, settings: settings.map(({ width, horizon }) => [width, horizon]),
    occupancy, g, current: state.pieces.current, hold: state.pieces.hold, holdAvailable: state.pieces.holdAvailable,
    known: state.pieces.known.slice(0, known), combo: state.chain.combo, b2b: state.chain.b2b,
    frame: state.time.logicalFrame, piecesPlaced: state.time.piecesPlaced,
    packets: [...state.garbage.packets].sort((a, b) => a.order - b.order).map((p) => ({ amount: p.amount, frame: p.arrivalFrame })),
    rng: gs.rngState, lastColumn: gs.lastHoleColumn, hasChangedColumn: gs.holeChanged, sent: gs.sentForOpener, received: gs.receivedCountSinceReset };
}

/**
 * The garbage queue rebuilt from the public amounts only: the due rows land at this lock, the rest at the next one;
 * hole columns come from a public seed with no previous column, and the opener counters are 0.
 */
export function amountOnlyGarbage(state, holeSeed = RG_RULE.publicGarbage.holeSeed) {
  const { pendingRows, dueThisLockRows } = projectS2AmountOnlyIncomingSnapshot(state);
  const next = structuredClone(state), frame = next.time.logicalFrame, packets = [];
  const packet = (amount, arrivalFrame) => packets.push({ packetId: packets.length + 1, sourceGameId: 9998, amount, holeSize: 1,
    arrivalFrame, confirmed: true, order: packets.length });
  if (dueThisLockRows > 0) packet(dueThisLockRows, frame - 600);
  if (pendingRows > dueThisLockRows) packet(pendingRows - dueThisLockRows, frame + 40); // due once 60 frames pass
  next.garbage.packets = packets;
  Object.assign(next.garbage.generatorState, { rngState: holeSeed, lastHoleColumn: -1, holeChanged: false, sentForOpener: 0, receivedCountSinceReset: 0 });
  return next;
}

// Returned identity -> reachable public placement (by its witness). `reachable`: the request's
// listing, computed once per decision; it depends on `request.selector` only.
const pose = (p) => [p.piece, p.rotation, p.x, p.y, p.usedHold].join(",");
export function resolveIdentity(state, request, identity, reachable = null) {
  const move = JSON.parse(identity);
  const requested = cc2MoveToCanonicalPlacement({ queue: [state.pieces.current] }, move), want = pose(requested);
  const appState = state.pieces.holdAvailable === undefined ? { ...state, pieces: { ...state.pieces, holdAvailable: request.selector.pieces.holdAvailable } } : state;
  const options = (reachable ?? listS2AmountOnlyPublicReachablePlacements(request.selector)).filter((c) => pose(c) === want);
  if (!options.length) { if (move.spin !== "none") return null; options.push(requested); }
  const tr = (c) => applyTransition(appState, { kind: "placement", placement: c }, state.rulesetId);
  const chosen = options.find((c) => c.rotationEvidence.lastInputWasRotation && (tr(c).lockResult?.spin ?? "none") !== "none")
    ?? options.find((c) => !c.rotationEvidence.lastInputWasRotation) ?? options[0];
  const transition = tr(chosen);
  if (transition.legality?.legal !== true || transition.nextState === null) throw new Error(`illegal forced placement ${identity}`);
  return { placement: chosen, transition };
}

/**
 * Rule RG over a spike search. `ruleRG(state, request, response)` takes the champion's F14 response with
 * `diagnostics.rootChildValues` and returns `{ applicable, reason, choice, rows, resolvedChoice? }` (choice null =
 * keep the selected move). `onSearchRequest` (checks only) sees every search line.
 */
export function createRgRule(spike, { onSearchRequest = null, settings = RG_RULE.settings, margin = RG_RULE.margin } = {}) {
  if (typeof spike?.request !== "function") throw new Error("RG needs a spike search with request()");
  // `settings` / `margin` (checks only): one spike
  // search setting other than RG's width 32, horizon 12, and the rows a candidate's spike height must be below the
  // selected move's. The defaults are rule RG.
  if (!(Array.isArray(settings) && settings.length === 1 && Number.isSafeInteger(settings[0]?.width) && settings[0].width >= 1
    && Number.isSafeInteger(settings[0]?.horizon) && settings[0].horizon >= 1)) throw new Error("RG takes exactly one spike search setting { width, horizon }");
  if (!(Number.isFinite(margin) && margin > 0)) throw new Error("RG margin must be a positive number");
  let serial = 0;
  const prepare = (state, placement) => {
    const view = amountOnlyGarbage(state);
    const tr = applyTransition(view, { kind: "placement", placement }, state.rulesetId);
    if (tr.legality?.legal !== true || !tr.nextState) return null;
    const top = isToppedOut(tr.nextState);
    const next = tr.nextState; next.time.logicalFrame = state.time.logicalFrame + 60;
    const line = toSearchRequest(serial++, injectSpike(next, RG_RULE.spike, RG_RULE.publicGarbage), settings);
    onSearchRequest?.(line);
    return { line, top, immediate: tr.attackStages?.outgoingBeforeCancel ?? 0 };
  };
  const finish = (p, r) => {
    const A13 = p.immediate + r.attack;
    return { F: Number.isFinite(r.F) ? r.F : null, A13: Number.isFinite(A13) ? A13 : null, top: p.top };
  };
  const none = () => ({ F: null, A13: null, top: null });
  async function evaluateMany(state, placements) {
    const prepared = placements.map((placement) => (placement === null ? null : prepare(state, placement)));
    const lines = prepared.filter((p) => p !== null).map((p) => p.line);
    const reply = lines.length ? await spike.request({ id: `batch-${serial++}`, mode: "batch", requests: lines }) : { replies: [] };
    if (!Array.isArray(reply?.replies) || reply.replies.length !== lines.length || reply.replies.some((x, k) => x?.id !== lines[k].id))
      throw new Error("spike batch reply does not answer its lines in order");
    let k = 0;
    return prepared.map((p) => (p === null ? none() : finish(p, reply.replies[k++].results[0])));
  }
  const rankOf = (ranking, id) => { const i = ranking.indexOf(id); return i < 0 ? 1e9 : i; };
  async function ruleRG(state, request, res) {
    const ranking = res.ranking?.identities ?? [];
    const children = res.diagnostics?.rootChildValues?.children ?? [];
    const sel = children.find((c) => c.identity === res.selectedIdentity);
    if (!sel) return { applicable: false, reason: "selected-not-in-root-children", choice: null };
    const order = (a, b) => b.value - a.value || rankOf(ranking, a.identity) - rankOf(ranking, b.identity) || (a.identity < b.identity ? -1 : 1);
    let cands = children.filter((c) => c.value >= sel.value - RG_RULE.delta).sort(order).slice(0, RG_RULE.maxCandidates);
    if (!cands.includes(sel)) cands = [...cands.slice(0, RG_RULE.maxCandidates - 1), sel];
    if (cands.length === 1) {
      return { applicable: true, reason: "single-candidate", choice: null,
        rows: [{ identity: sel.identity, value: sel.value, rank: ranking.indexOf(sel.identity), F: null, A13: null, top: null, resolved: null }] };
    }
    const reachable = listS2AmountOnlyPublicReachablePlacements(request.selector);
    const resolved = cands.map((c) => resolveIdentity(state, request, c.identity, reachable));
    const stresses = await evaluateMany(state, resolved.map((r) => r?.placement ?? null));
    const rows = cands.map((c, k) => ({ identity: c.identity, value: c.value, rank: ranking.indexOf(c.identity),
      F: stresses[k].F, A13: stresses[k].A13, top: stresses[k].top, resolved: resolved[k] !== null }));
    const selRow = rows.find((r) => r.identity === sel.identity);
    if (selRow.F === null || selRow.A13 === null) return { applicable: false, reason: "selected-stress-unavailable", choice: null, rows };
    const better = rows.filter((r) => r.F !== null && r.A13 !== null && r.top === false && r.F <= selRow.F - margin && r.A13 >= selRow.A13)
      .sort((a, b) => a.F - b.F || b.value - a.value || rankOf(ranking, a.identity) - rankOf(ranking, b.identity) || (a.identity < b.identity ? -1 : 1));
    const choice = better[0]?.identity ?? null;
    const k = cands.findIndex((c) => c.identity === choice);
    return { applicable: true, reason: null, choice, rows, ...(k < 0 ? {} : { resolvedChoice: resolved[k] }) };
  }
  return Object.freeze({ ruleRG });
}
