/**
 * The candidate list under the Single Analysis deck.
 *
 * A proposer ranks every root placement it considered, not only the one it
 * plays. This module turns that ranked list into rows the deck can show - each
 * row a thumbnail of the field the candidate was proposed for, with the
 * candidate laid over it, plus what the S2 Simulator says that placement does -
 * and reads nothing outside the arguments it is handed.
 *
 * Nothing here decides or applies a move. A row is a proposal the viewer can
 * adopt; the deck's existing apply path remains the only thing that commits one.
 */

import {
  canonicalPlacementToGuiMove,
  simpleAnalysisToVerification,
} from "./analysis-proposal.mjs";
import { addOverlayPiece, renderMatchField } from "./field-render.mjs";
import { clearLabel, placementCells } from "./game.mjs";

/* The strict prefix width the S2 selectors themselves rank, so the list can
   never ask a proposer for more candidates than the engines read. */
export const CANDIDATE_COUNT_LIMIT = 16;

/**
 * Rows for the simple S2 bot, whose analysis already carries a verified
 * transition per candidate: nothing needs re-verifying against the Simulator
 * that produced it.
 */
export function simpleAnalysisCandidateRows(analysis, count) {
  return analysis.moves.slice(0, count).map((candidate) => {
    const verification = simpleAnalysisToVerification({ ...analysis, moves: [candidate] });
    return {
      move: canonicalPlacementToGuiMove(
        candidate.placement,
        verification.transition.lockResult.spin,
      ),
      verification,
    };
  });
}

/** Two proposals are the same candidate when they name the same locked pose. */
export function moveIdentity(move) {
  const { type, orientation, x, y } = move.location;
  return `${type}:${orientation}:${x}:${y}`;
}

/**
 * The text of one row. A row whose witness the Simulator refused keeps its pose
 * and carries the refusal instead of an outcome, because "this candidate cannot
 * be verified" is itself what the list has to report.
 */
export function describeCandidate(row, currentPiece) {
  const { type, orientation, x, y } = row.move.location;
  const summary = {
    piece: `${type} · ${orientation.toUpperCase()}`,
    position: `(${x}, ${y})`,
    // CC2 may propose the HOLD piece, so the row says where the mino came from
    // rather than leaving it to be inferred from the thumbnail's colour.
    fromHold: type !== currentPiece,
    outcome: null,
    score: null,
    reason: row.reason ?? null,
  };
  if (row.verification === null) return summary;
  const lock = row.verification.transition.lockResult;
  const clear = clearLabel(lock.spin, lock.lines, lock.perfectClear) || "NO CLEAR";
  const attack = row.verification.transition.attackStages.outgoingBeforeCancel;
  summary.outcome = `${clear} · ${attack} ATK`;
  summary.score = `S2 ${row.verification.comparison.score.toFixed(2)}`;
  return summary;
}

export function renderCandidateList(container, rows, { board, currentPiece, onSelect }) {
  container.replaceChildren(...rows.map((row, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "candidate-item";
    item.dataset.index = String(index);
    item.setAttribute("aria-pressed", "false");

    const rank = document.createElement("span");
    rank.className = "candidate-rank";
    rank.textContent = `#${index + 1}`;

    const thumb = document.createElement("span");
    thumb.className = "candidate-thumb";
    renderCandidateThumbnail(thumb, board, row.move);

    const summary = describeCandidate(row, currentPiece);
    const facts = document.createElement("span");
    facts.className = "candidate-facts";
    facts.append(
      line("strong", summary.piece),
      line("small", summary.position),
      ...(summary.fromHold ? [line("small", "← HOLD", "candidate-hold")] : []),
      ...(summary.outcome === null ? [] : [line("small", summary.outcome)]),
      ...(summary.score === null ? [] : [line("small", summary.score, "candidate-score")]),
      ...(summary.reason === null ? [] : [line("small", summary.reason, "candidate-reason")]),
    );

    item.append(rank, thumb, facts);
    if (row.verification === null) item.disabled = true;
    else item.addEventListener("click", () => onSelect(index));
    return item;
  }));
}

/** Marks whichever row the deck is currently holding as its proposal. */
export function markCandidateSelection(container, selected) {
  for (const item of container.children) {
    item.setAttribute("aria-pressed", String(Number(item.dataset.index) === selected));
  }
}

/* The same 20 visible rows the main field draws, at thumbnail scale, with the
   candidate over them: the placement is only readable against the stack it was
   proposed for. The board is the one before the lock, so a clearing candidate
   still shows the rows it fills rather than the rows it leaves behind. */
function renderCandidateThumbnail(container, board, move) {
  const overlay = new Map();
  addOverlayPiece(overlay, placementCells(move), move.location.type, false);
  // A thumbnail sits inside the row's own button, whose content model admits
  // phrasing content only, so its cells are spans rather than divs.
  renderMatchField(container, board, [], overlay, { cellElement: "span" });
}

function line(tag, text, className = null) {
  const node = document.createElement(tag);
  if (className !== null) node.className = className;
  node.textContent = text;
  return node;
}
