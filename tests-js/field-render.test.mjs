import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createInputExecutionRound } from "../src-js/input-execution-round.mjs";

import {
  DETAIL_METRICS,
  addOverlayPiece,
  inputPieceOverlay,
  matchFieldCellSpec,
  renderDetailMetrics,
  renderFieldRateStats,
  renderMatchField,
  renderMini,
  renderNextList,
} from "../cc2-gui/field-render.mjs";

const originalDocument = globalThis.document;

test("input ghost matches actual hard-drop cells after HOLD and on a stack, respects visibility and active precedence", () => {
  const round = createInputExecutionRound({ seed: 42 });
  const tap = key => round.tick({ left: ["keydown", "keyup"].map(type => ({
    frame: round.frame, type, data: { key, subframe: 0 },
  })) });
  for (const hold of [false, true, false]) {
    if (hold) tap("hold");
    const player = round.refereeView().players[0];
    const before = JSON.stringify(player);
    const overlay = inputPieceOverlay(player.board, player.activeCells, player.current);
    const ghost = [...overlay].filter(([, cell]) => cell.ghost).map(([key]) => key).sort();
    assert.equal(ghost.length, 4);
    assert.equal([...inputPieceOverlay(player.board, player.activeCells, player.current, false).values()].filter(cell => cell.ghost).length, 0);
    assert.equal(JSON.stringify(player), before);
    tap("hardDrop");
    const cells = round.refereeLastLock("left").cells;
    assert.deepEqual(ghost, cells.map(([x, y]) => `${x}:${y}`).sort());
    const resting = inputPieceOverlay(player.board, cells, player.current);
    assert.equal([...resting.values()].filter(cell => cell.ghost).length, 0);
    assert.equal(resting.size, 4);
  }
});

test("input spawn stays visible immediately after HOLD and lock; legacy field size restores", () => {
  const round = createInputExecutionRound({ seed: 42 });
  const container = new FakeElement("section");
  for (const key of [null, "hold", "hardDrop"]) {
    if (key) round.tick({ left: ["keydown", "keyup"].map(type => ({
      frame: round.frame, type, data: { key, subframe: 0 },
    })) });
    const player = round.refereeView().players[0];
    const overlay = new Map();
    addOverlayPiece(overlay, player.activeCells, player.current, false);
    assert.equal(matchFieldCellSpec(player.board, [], overlay).filter(cell => cell.className.includes(" active")).length, 0);
    renderMatchField(container, player.board, [], overlay, { rows: 23 });
    assert.equal(container.children.length, 230);
    assert.equal(container.children.filter(cell => cell.className.includes(" active")).length, 4);
    renderMatchField(container, player.board, [], overlay);
    assert.equal(container.children.length, 200);
  }
});

before(() => {
  globalThis.document = { createElement: (name) => new FakeElement(name) };
});

after(() => {
  if (originalDocument === undefined) delete globalThis.document;
  else globalThis.document = originalDocument;
});

test("matchFieldCellSpec preserves visible order, pieces, and overlay precedence", () => {
  const board = emptyBoard();
  const pieces = ["I", "O", "T", "L", "J", "S", "Z", "G"];
  pieces.forEach((piece, x) => { board[0][x] = piece; });
  board[19][0] = "I";

  const specs = matchFieldCellSpec(board, [[0, 0], [1, 0]]);
  assert.equal(specs.length, 200);
  assert.deepEqual(specs[0], { className: "cell filled", piece: "I" });
  assert.deepEqual(specs.slice(190, 198).map(({ piece }) => piece), pieces);
  assert.match(specs[190].className, / placed/);
  assert.match(specs[191].className, / placed/);

  const overlay = new Map([
    ["0:0", { piece: "Z", ghost: true, edges: " et er" }],
    ["1:0", { piece: "S", ghost: false, edges: " eb el" }],
  ]);
  const overlaid = matchFieldCellSpec(board, [[0, 0], [1, 0]], overlay);
  assert.deepEqual(overlaid[190], { className: "cell filled ghost et er", piece: "Z" });
  assert.deepEqual(overlaid[191], { className: "cell filled active eb el", piece: "S" });
  assert.doesNotMatch(overlaid[190].className, /placed/);
  assert.doesNotMatch(overlaid[191].className, /placed/);
});

test("matchFieldCellSpec keeps the renderer's malformed-board behavior", () => {
  assert.throws(() => matchFieldCellSpec(emptyBoard().slice(0, 19), []), TypeError);

  const shortRow = emptyBoard();
  shortRow[19] = [];
  const specs = matchFieldCellSpec(shortRow, []);
  assert.equal(specs.length, 200);
  assert.deepEqual(specs[0], { className: "cell", piece: null });
});

test("renderMatchField reuses cells, repairs attributes, and invalidates structural caches", () => {
  const board = emptyBoard();
  const container = new FakeElement("section");
  renderMatchField(container, board, []);
  const firstCells = [...container.children];
  assert.equal(firstCells.length, 200);
  assert.ok(firstCells.every((cell) => cell.tagName === "DIV"));
  const unchangedClassWrites = firstCells.reduce((total, cell) => total + cell.classWrites, 0);
  const unchangedAttributeWrites = firstCells.reduce((total, cell) => total + cell.attributeWrites, 0);

  renderMatchField(container, board, []);
  assert.deepEqual(container.children, firstCells);
  assert.equal(firstCells.reduce((total, cell) => total + cell.classWrites, 0), unchangedClassWrites);
  assert.equal(firstCells.reduce((total, cell) => total + cell.attributeWrites, 0), unchangedAttributeWrites);

  board[0][0] = "G";
  renderMatchField(container, board, []);
  assert.deepEqual(container.children, firstCells);
  assert.equal(container.children[190].className, "cell filled");
  assert.equal(container.children[190].getAttribute("data-piece"), "G");

  board[0][0] = null;
  renderMatchField(container, board, []);
  assert.equal(container.children[190].className, "cell");
  assert.equal(container.children[190].getAttribute("data-piece"), null);

  container.children[0].className = "corrupt";
  container.children[0].setAttribute("data-piece", "T");
  renderMatchField(container, board, []);
  assert.equal(container.children[0].className, "cell");
  assert.equal(container.children[0].getAttribute("data-piece"), null);

  container.replaceChildren(new FakeElement("div"));
  renderMatchField(container, board, []);
  assert.equal(container.children.length, 200);
  assert.notEqual(container.children[0], firstCells[0]);

  renderMatchField(container, board, [], null, { cellElement: "span" });
  const spanCells = [...container.children];
  assert.ok(spanCells.every((cell) => cell.tagName === "SPAN"));
  renderMatchField(container, board, [], null, { cellElement: "span" });
  assert.deepEqual(container.children, spanCells);
});

test("renderMini reuses a valid HOLD tree and rebuilds it after identity or structure changes", () => {
  const container = new FakeElement("div");
  renderMini(container, undefined);
  assert.equal(container.children[0].getAttribute("data-piece"), "");
  assert.equal(container.children[0].children.length, 8);

  renderMini(container, "T");
  const firstGrid = container.children[0];
  const firstCells = [...firstGrid.children];
  renderMini(container, "T");
  assert.equal(container.children[0], firstGrid);
  assert.deepEqual(firstGrid.children, firstCells);

  firstGrid.className = "corrupt";
  firstGrid.setAttribute("data-piece", "I");
  firstCells[0].className = "corrupt";
  renderMini(container, "T");
  assert.equal(container.children[0], firstGrid);
  assert.equal(firstGrid.className, "mini-grid");
  assert.equal(firstGrid.getAttribute("data-piece"), "T");
  assert.match(firstCells[0].className, /^mini-cell/);

  renderMini(container, null);
  const emptyGrid = container.children[0];
  assert.notEqual(emptyGrid, firstGrid);
  assert.equal(emptyGrid.getAttribute("data-piece"), "");
  assert.equal(emptyGrid.children.length, 8);

  container.replaceChildren(new FakeElement("div"));
  renderMini(container, null);
  assert.notEqual(container.children[0], emptyGrid);
  assert.equal(container.children.length, 1);
});

test("renderNextList reuses an unchanged NEXT tree and repairs invalidated subtrees", () => {
  const container = new FakeElement("div");
  const pieces = ["I", "T", "O"];
  renderNextList(container, pieces);
  const firstItems = [...container.children];
  const firstGrid = firstItems[0].children[0];
  renderNextList(container, [...pieces]);
  assert.deepEqual(container.children, firstItems);
  assert.equal(firstItems[0].children[0], firstGrid);

  firstItems[0].className = "corrupt";
  firstItems[0].replaceChildren();
  renderNextList(container, [...pieces]);
  assert.equal(container.children[0], firstItems[0]);
  assert.equal(firstItems[0].className, "mini-box");
  assert.notEqual(firstItems[0].children[0], firstGrid);

  renderNextList(container, ["T", "O", "S"]);
  const changedItems = [...container.children];
  assert.notEqual(changedItems[0], firstItems[0]);

  container.replaceChildren(new FakeElement("div"));
  renderNextList(container, ["T", "O", "S"]);
  assert.equal(container.children.length, 3);
  assert.notEqual(container.children[0], changedItems[0]);
});

test("metric renderers retain rows, update changed text, and honor definition signatures", () => {
  const detail = new FakeElement("dl");
  renderDetailMetrics(detail, { apm: 1 });
  const detailRows = [...detail.children];
  const apmValue = detailRows[0].children[1];
  const unchangedWrites = apmValue.textWrites;
  renderDetailMetrics(detail, { apm: 1 });
  assert.deepEqual(detail.children, detailRows);
  assert.equal(apmValue.textWrites, unchangedWrites);

  renderDetailMetrics(detail, { apm: 2 });
  assert.equal(detail.children[0], detailRows[0]);
  assert.equal(apmValue.textContent, "2.00");
  assert.equal(apmValue.textWrites, unchangedWrites + 1);
  detailRows[0].children[0].textContent = "corrupt";
  renderDetailMetrics(detail, { apm: 2 });
  assert.equal(detailRows[0].children[0].textContent, DETAIL_METRICS[0][0]);

  detail.replaceChildren(new FakeElement("div"));
  renderDetailMetrics(detail, { apm: 2 });
  assert.equal(detail.children.length, DETAIL_METRICS.length);
  assert.notEqual(detail.children[0], detailRows[0]);

  const rate = new FakeElement("div");
  const definitions = [["Pieces", "pieces", 0], ["PPS", "pps", 2]];
  renderFieldRateStats(rate, { pieces: 3, pps: 1 }, definitions);
  const rateRows = [...rate.children];
  const piecesValue = rateRows[0].children[0];
  renderFieldRateStats(rate, { pieces: 4, pps: 1 }, definitions.map((entry) => [...entry]));
  assert.deepEqual(rate.children, rateRows);
  assert.equal(piecesValue.textContent, "4");

  renderFieldRateStats(rate, { pieces: 4, pps: 1 }, [["Pieces", "pieces", 1], ["PPS", "pps", 2]]);
  assert.notEqual(rate.children[0], rateRows[0]);
  const rebuiltRow = rate.children[0];

  rate.replaceChildren(new FakeElement("span"));
  renderFieldRateStats(rate, { pieces: 4, pps: 1 }, [["Pieces", "pieces", 1], ["PPS", "pps", 2]]);
  assert.equal(rate.children.length, 2);
  assert.notEqual(rate.children[0], rebuiltRow);
});

function emptyBoard() {
  return Array.from({ length: 20 }, () => Array(10).fill(null));
}

class FakeStyle {
  #properties = new Map();

  setProperty(name, value) {
    this.#properties.set(name, String(value));
  }

  getPropertyValue(name) {
    return this.#properties.get(name) ?? "";
  }
}

class FakeElement {
  #attributes = new Map();
  #className = "";
  #textContent = "";

  constructor(name) {
    this.tagName = String(name).toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = new FakeStyle();
    this.classWrites = 0;
    this.attributeWrites = 0;
    this.textWrites = 0;
    this.dataset = new Proxy({}, {
      get: (_target, property) => this.getAttribute(dataAttribute(property)) ?? undefined,
      set: (_target, property, value) => {
        this.setAttribute(dataAttribute(property), value);
        return true;
      },
      deleteProperty: (_target, property) => {
        this.removeAttribute(dataAttribute(property));
        return true;
      },
    });
  }

  get className() {
    return this.#className;
  }

  set className(value) {
    this.#className = String(value);
    this.classWrites += 1;
  }

  get textContent() {
    return this.#textContent;
  }

  set textContent(value) {
    this.#textContent = String(value);
    this.textWrites += 1;
  }

  append(...children) {
    for (const child of children) {
      child.#detach();
      child.parentNode = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.append(...children);
  }

  getAttribute(name) {
    return this.#attributes.get(name) ?? null;
  }

  setAttribute(name, value) {
    this.#attributes.set(name, String(value));
    this.attributeWrites += 1;
  }

  removeAttribute(name) {
    this.#attributes.delete(name);
    this.attributeWrites += 1;
  }

  #detach() {
    if (this.parentNode === null) return;
    const index = this.parentNode.children.indexOf(this);
    if (index >= 0) this.parentNode.children.splice(index, 1);
    this.parentNode = null;
  }
}

function dataAttribute(property) {
  return `data-${String(property).replace(/[A-Z]/g, (match) => `-${match.toLowerCase()}`)}`;
}
