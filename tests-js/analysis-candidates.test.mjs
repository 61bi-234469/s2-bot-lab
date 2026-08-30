import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  CANDIDATE_COUNT_LIMIT,
  describeCandidate,
  moveIdentity,
  simpleAnalysisCandidateRows,
} from "../cc2-gui/analysis-candidates.mjs";
import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { cc2MoveToCanonicalPlacement, guiStateToCanonical } from "../src-js/cc2-s2-adapter.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const markup = read("../cc2-gui/index.html");
const app = read("../cc2-gui/app.mjs");
const ids = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));

function simpleAnalysis(topN) {
  return analyzeSimpleS2FinalPlacements(guiStateToCanonical(toS2GuiState(createGame())), { topN });
}

test("a simple S2 row keeps the analysis order and the placement it was ranked for", () => {
  const gui = toS2GuiState(createGame());
  const analysis = simpleAnalysis(5);
  const rows = simpleAnalysisCandidateRows(analysis, 5);

  assert.equal(rows.length, 5);
  for (const [index, row] of rows.entries()) {
    const candidate = analysis.moves[index];
    // The row's move is the one the deck would apply, so it has to project back
    // onto exactly the placement the analysis scored.
    assert.deepEqual(cc2MoveToCanonicalPlacement(gui, row.move), candidate.placement);
    assert.equal(row.verification.transition, candidate.transition);
    assert.equal(row.verification.comparison.score, candidate.score);
  }
});

test("a narrower list is a prefix of the wider one, not a different ranking", () => {
  const analysis = simpleAnalysis(CANDIDATE_COUNT_LIMIT);
  const wide = simpleAnalysisCandidateRows(analysis, CANDIDATE_COUNT_LIMIT);
  const narrow = simpleAnalysisCandidateRows(analysis, 3);

  assert.equal(wide.length, CANDIDATE_COUNT_LIMIT);
  assert.deepEqual(narrow.map((row) => moveIdentity(row.move)),
    wide.slice(0, 3).map((row) => moveIdentity(row.move)));
});

test("a row reports the Simulator's own outcome for its own placement", () => {
  const analysis = simpleAnalysis(3);
  const [row] = simpleAnalysisCandidateRows(analysis, 3);
  const summary = describeCandidate(row, row.move.location.type);
  const { transition } = row.verification;

  assert.equal(summary.piece, `${row.move.location.type} · ${row.move.location.orientation.toUpperCase()}`);
  assert.equal(summary.position, `(${row.move.location.x}, ${row.move.location.y})`);
  assert.ok(summary.outcome.endsWith(`${transition.attackStages.outgoingBeforeCancel} ATK`));
  assert.equal(summary.score, `S2 ${row.verification.comparison.score.toFixed(2)}`);
  assert.equal(summary.reason, null);
  assert.equal(summary.fromHold, false);
});

test("a candidate that is not the current piece is marked as coming from HOLD", () => {
  const analysis = simpleAnalysis(1);
  const [row] = simpleAnalysisCandidateRows(analysis, 1);
  const other = ["I", "O", "T", "L", "J", "S", "Z"].find((piece) => piece !== row.move.location.type);

  assert.equal(describeCandidate(row, other).fromHold, true);
});

test("an unverifiable candidate keeps its pose and carries the refusal instead of an outcome", () => {
  const analysis = simpleAnalysis(1);
  const [row] = simpleAnalysisCandidateRows(analysis, 1);
  const summary = describeCandidate({ move: row.move, verification: null, reason: "witness rejected" },
    row.move.location.type);

  assert.equal(summary.outcome, null);
  assert.equal(summary.score, null);
  assert.equal(summary.reason, "witness rejected");
  assert.equal(summary.position, `(${row.move.location.x}, ${row.move.location.y})`);
});

test("move identity separates two poses of the same piece", () => {
  const spawn = { location: { type: "T", orientation: "north", x: 4, y: 1 }, spin: "none" };
  const turned = { location: { type: "T", orientation: "east", x: 4, y: 1 }, spin: "none" };

  assert.equal(moveIdentity(spawn), moveIdentity({ ...spawn, spin: "full" }));
  assert.notEqual(moveIdentity(spawn), moveIdentity(turned));
});

test("the candidate deck only reaches for elements the page actually has", () => {
  const section = app.slice(app.indexOf("function toggleCandidates"), app.indexOf("async function startMatch"));
  const looked = new Set([...section.matchAll(/elements\["([^"]+)"\]/g)].map((match) => match[1]));

  assert.ok(looked.has("candidate-list") && looked.has("candidate-panel"), "the deck drives its own panel");
  for (const id of looked) assert.ok(ids.has(`${id}`), `index.html is missing #${id}`);
});

test("the count control never asks a proposer for more than the selectors rank", () => {
  const options = [...markup.matchAll(/<option value="(\d+)">上位/g)].map((match) => Number(match[1]));

  assert.ok(options.length > 0, "the candidate count control should offer widths");
  for (const value of options) assert.ok(value >= 1 && value <= CANDIDATE_COUNT_LIMIT, `width ${value}`);
});
