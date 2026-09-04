/**
 * The DOM builders every field on the page shares.
 *
 * Analysis, match, 1P, and replay fields are the same picture of the same 20
 * visible rows, so they are drawn by one set of functions rather than separate
 * implementations that could drift apart. The derived field specification is
 * pure; DOM builders keep only container-keyed caches and read no app state.
 */

import { VISIBLE_ROWS } from "./human-play.mjs";

export { VISIBLE_ROWS };

/** The gauge track and the board show the same 20 visible rows. */
export const GAUGE_ROWS = VISIBLE_ROWS;

/** The detail grid under a field: label, metric key, and decimal places. */
export const DETAIL_METRICS = Object.freeze([
  ["APM", "apm", 2],
  ["PPS", "pps", 2],
  ["VS", "vs", 2],
  ["APP", "app", 3],
  ["DS/Second", "dsSecond", 3],
  ["DS/Piece", "dsPiece", 3],
  ["VS/APM", "vsApm", 3],
  ["Garbage Eff.", "garbageEfficiency", 3],
  ["Cheese Index", "cheeseIndex", 2],
  ["Weighted APP", "weightedApp", 3],
  ["APP+DS/Piece", "appDsPiece", 3],
  ["Area", "area", 2],
  ["Est. TR", "estTr", 1],
  ["Opener", "opener", 2],
  ["Plonk", "plonk", 2],
  ["Stride", "stride", 2],
  ["Inf DS", "infDs", 2],
]);

const fieldCache = new WeakMap();
const miniCache = new WeakMap();
const nextCache = new WeakMap();
const detailCache = new WeakMap();
const rateCache = new WeakMap();

export function renderDetailMetrics(container, metrics) {
  renderMetricRows(container, metrics, DETAIL_METRICS, detailCache, {
    rowElement: "div",
    valueElement: "dd",
    termElement: "dt",
    termText: (label) => label,
    valueFirst: false,
  });
}

/* `overlay` carries a piece that has not locked - the one a human player is
   moving, the one a replay cursor is watching fall, or a candidate placement a
   thumbnail is previewing. It is drawn over the board rather than into it,
   because the board itself is settled state. `cellElement` exists only for the
   callers that draw a field inside a button, whose content model admits
   phrasing content rather than divs. */
export function matchFieldCellSpec(board, lastPlaced, overlay = null) {
  const placed = new Set((lastPlaced ?? []).map(([x, y]) => `${x}:${y}`));
  const specs = [];
  for (let y = VISIBLE_ROWS - 1; y >= 0; y -= 1) {
    for (let x = 0; x < 10; x += 1) {
      const overlaid = overlay?.get(`${x}:${y}`) ?? null;
      const piece = overlaid?.piece ?? board[y][x];
      const isPlaced = overlaid === null && piece !== null && placed.has(`${x}:${y}`);
      specs.push({
        className: `cell${piece ? " filled" : ""}`
        + (overlaid === null ? "" : `${overlaid.ghost ? " ghost" : " active"}${overlaid.edges}`)
        + (isPlaced ? ` placed${outerEdges(placed, x, y)}` : ""),
        piece: piece ? String(piece) : null,
      });
    }
  }
  return specs;
}

export function renderMatchField(container, board, lastPlaced, overlay = null, { cellElement = "div" } = {}) {
  const specs = matchFieldCellSpec(board, lastPlaced, overlay);
  let cached = fieldCache.get(container);
  if (!validFieldCache(container, cached, cellElement)) {
    const cells = specs.map(() => document.createElement(cellElement));
    container.replaceChildren(...cells);
    cached = { cellElement, cells, specs: Array(specs.length).fill(null) };
    fieldCache.set(container, cached);
  }
  for (let index = 0; index < specs.length; index += 1) {
    const spec = specs[index];
    const previous = cached.specs[index];
    const cell = cached.cells[index];
    if (!sameCellSpec(previous, spec) || !cellMatchesSpec(cell, spec)) applyCellSpec(cell, spec);
  }
  cached.specs = specs;
}

/* Only the cells inside the visible field are drawn, but the rim of a piece
   half above it is still computed from all four cells, so the part that is on
   screen keeps the outline of the whole tetromino. */
export function addOverlayPiece(overlay, cells, piece, ghost) {
  const keys = new Set(cells.map(([x, y]) => `${x}:${y}`));
  for (const [x, y] of cells) {
    overlay.set(`${x}:${y}`, { piece, ghost, edges: outerEdges(keys, x, y) });
  }
}

export function renderNextList(container, pieces) {
  const key = JSON.stringify(pieces);
  let cached = nextCache.get(container);
  if (cached?.key !== key || !validDirectChildren(container, cached?.items, "div")) {
    const items = pieces.map((piece) => {
      const item = document.createElement("div");
      item.className = "mini-box";
      renderMini(item, piece);
      return item;
    });
    container.replaceChildren(...items);
    cached = { key, items };
    nextCache.set(container, cached);
    return;
  }
  for (let index = 0; index < pieces.length; index += 1) {
    const item = cached.items[index];
    if (item.className !== "mini-box") item.className = "mini-box";
    renderMini(item, pieces[index]);
  }
}

export function renderMini(container, piece) {
  const spec = miniSpec(piece);
  let cached = miniCache.get(container);
  if (cached?.piece !== piece || !validMiniCache(container, cached, spec.cells.length)) {
    const grid = document.createElement("div");
    const cells = spec.cells.map(() => document.createElement("span"));
    grid.append(...cells);
    container.replaceChildren(grid);
    cached = { piece, grid, cells };
    miniCache.set(container, cached);
  }
  if (cached.grid.className !== "mini-grid") cached.grid.className = "mini-grid";
  if (cached.grid.getAttribute("data-piece") !== spec.piece) {
    cached.grid.setAttribute("data-piece", spec.piece);
  }
  setStyleProperty(cached.grid, "--mini-cols", spec.cols);
  setStyleProperty(cached.grid, "--mini-rows", spec.rows);
  for (let index = 0; index < spec.cells.length; index += 1) {
    if (cached.cells[index].className !== spec.cells[index]) {
      cached.cells[index].className = spec.cells[index];
    }
  }
}

function miniSpec(piece) {
  const cells = piece ? previewCells(piece) : [];
  // The grid spans the piece's own bounding box rather than the full 4x2 area,
  // so a three-wide piece is not left-aligned and the flat I is not stuck to
  // the top: the enclosing box centres whatever the grid actually is. An empty
  // hold keeps the full 4x2 so the box does not collapse.
  const bounds = cells.length === 0 ? { minX: 0, maxX: 3, minY: 0, maxY: 1 } : {
    minX: Math.min(...cells.map(([x]) => x)),
    maxX: Math.max(...cells.map(([x]) => x)),
    minY: Math.min(...cells.map(([, y]) => y)),
    maxY: Math.max(...cells.map(([, y]) => y)),
  };
  const cols = String(bounds.maxX - bounds.minX + 1);
  const rows = String(bounds.maxY - bounds.minY + 1);
  const occupied = new Set(cells.map(([x, y]) => `${x}:${y}`));
  const cellClasses = [];
  for (let y = bounds.maxY; y >= bounds.minY; y -= 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      cellClasses.push(`mini-cell${occupied.has(`${x}:${y}`) ? " filled" : ""}`);
    }
  }
  return { piece: piece == null ? "" : String(piece), cols, rows, cells: cellClasses };
}

export function previewCells(piece) {
  const offsets = {
    I: [[0, 0], [1, 0], [2, 0], [3, 0]], O: [[1, 0], [2, 0], [1, 1], [2, 1]],
    T: [[0, 0], [1, 0], [2, 0], [1, 1]], L: [[0, 0], [1, 0], [2, 0], [2, 1]],
    J: [[0, 0], [1, 0], [2, 0], [0, 1]], S: [[0, 0], [1, 0], [1, 1], [2, 1]],
    Z: [[0, 1], [1, 1], [1, 0], [2, 0]],
  };
  return offsets[piece];
}

// Only the edges facing away from the rest of the tetromino are drawn, so the
// four cells read as one piece instead of four outlined squares.
export function outerEdges(cells, x, y) {
  return (cells.has(`${x}:${y + 1}`) ? "" : " et")
    + (cells.has(`${x + 1}:${y}`) ? "" : " er")
    + (cells.has(`${x}:${y - 1}`) ? "" : " eb")
    + (cells.has(`${x - 1}:${y}`) ? "" : " el");
}

// The gauge is the queued rise, not the board: only garbage that has been
// accepted but not yet tanked into the field is shown, capped at the 20 visible
// rows so a large pending stack cannot overflow the track.
//
// One segment per incoming attack, stacked from the bottom in arrival order and
// separated by a rule, so a 4+2 rise is not read as a single 6. The track is a
// 20-row grid covering exactly the same box as the field beside it, which is
// what makes one gauge row the height of one board cell.
export function renderGarbageGauge(container, packets, owner) {
  const pending = packets.reduce((total, packet) => total + packet.amount, 0);
  const segments = [];
  let stacked = 0;
  for (const packet of packets) {
    const rows = Math.min(packet.amount, GAUGE_ROWS - stacked);
    if (rows <= 0) break;
    const segment = document.createElement("div");
    segment.className = "gauge-segment";
    // Row 1 is the top of the track, so a segment sitting on `stacked` rows of
    // earlier garbage ends that many rows above the bottom.
    segment.style.gridRow = `${GAUGE_ROWS + 1 - stacked - rows} / span ${rows}`;
    segments.push(segment);
    stacked += rows;
  }
  container.replaceChildren(...segments);
  container.dataset.pending = String(pending);
  container.setAttribute(
    "aria-label",
    `${owner} incoming garbage: ${pending} rows in ${packets.length} attacks`,
  );
}

export function renderFieldRateStats(container, metrics, definitions) {
  renderMetricRows(container, metrics, definitions, rateCache, {
    rowElement: "span",
    valueElement: "b",
    termElement: "small",
    termText: (label) => ` ${label}`,
    valueFirst: true,
  });
}

function validFieldCache(container, cached, cellElement) {
  return cached?.cellElement === cellElement
    && cached.cells.length === 200
    && validDirectChildren(container, cached.cells, cellElement);
}

function validDirectChildren(container, children, elementName) {
  if (!children || container.children.length !== children.length) return false;
  const expectedTag = elementName.toUpperCase();
  return children.every((child, index) => child.parentNode === container
    && container.children[index] === child
    && child.tagName === expectedTag);
}

function sameCellSpec(left, right) {
  return left?.className === right.className && left?.piece === right.piece;
}

function cellMatchesSpec(cell, spec) {
  return cell.className === spec.className && cell.getAttribute("data-piece") === spec.piece;
}

function applyCellSpec(cell, spec) {
  if (cell.className !== spec.className) cell.className = spec.className;
  const actualPiece = cell.getAttribute("data-piece");
  if (spec.piece === null) {
    if (actualPiece !== null) cell.removeAttribute("data-piece");
  } else if (actualPiece !== spec.piece) {
    cell.setAttribute("data-piece", spec.piece);
  }
}

function validMiniCache(container, cached, cellCount) {
  return cached?.grid?.parentNode === container
    && container.children.length === 1
    && container.children[0] === cached.grid
    && cached.grid.tagName === "DIV"
    && cached.cells?.length === cellCount
    && validDirectChildren(cached.grid, cached.cells, "span");
}

function setStyleProperty(element, name, value) {
  if (element.style.getPropertyValue(name) !== value) element.style.setProperty(name, value);
}

function metricSignature(definitions) {
  return JSON.stringify(definitions);
}

function validMetricCache(container, cached, options) {
  if (!validDirectChildren(container, cached?.rows, options.rowElement)) return false;
  const expectedValueTag = options.valueElement.toUpperCase();
  const expectedTermTag = options.termElement.toUpperCase();
  return cached.rows.every((row, index) => {
    const { value, term } = cached.fields[index];
    const expected = options.valueFirst ? [value, term] : [term, value];
    return row.children.length === 2
      && row.children[0] === expected[0]
      && row.children[1] === expected[1]
      && value.parentNode === row
      && term.parentNode === row
      && value.tagName === expectedValueTag
      && term.tagName === expectedTermTag;
  });
}

function renderMetricRows(container, metrics, definitions, cache, options) {
  const signature = metricSignature(definitions);
  let cached = cache.get(container);
  if (cached?.signature !== signature || !validMetricCache(container, cached, options)) {
    const rows = [];
    const fields = [];
    for (const [label] of definitions) {
      const row = document.createElement(options.rowElement);
      const value = document.createElement(options.valueElement);
      const term = document.createElement(options.termElement);
      if (options.valueFirst) row.append(value, term);
      else row.append(term, value);
      rows.push(row);
      fields.push({ value, term });
    }
    container.replaceChildren(...rows);
    cached = { signature, rows, fields };
    cache.set(container, cached);
  }
  definitions.forEach(([label, key, digits], index) => {
    const { value, term } = cached.fields[index];
    const desiredTerm = options.termText(label);
    const desiredValue = formatMetric(metrics?.[key], digits);
    if (term.textContent !== desiredTerm) term.textContent = desiredTerm;
    if (value.textContent !== desiredValue) value.textContent = desiredValue;
  });
}

export function formatMetric(value, digits) {
  return Number.isFinite(value) ? value.toFixed(digits) : "—";
}

export function renderChainCounter(node, label, shown, active) {
  node.textContent = `${label} ${shown}`;
  node.dataset.active = String(active);
}

// Canonical state keeps the chain counter one ahead of the one the engine
// shows: Engine.stats.b2b is -1 with no chain and 0 after the first B2B-eligible
// clear, which canonical state stores as 0 and 1. The viewer shows the engine's
// counting, because that is the number the Surge threshold is quoted against.
export function shownB2b(b2b) {
  return b2b > 0 ? b2b - 1 : "—";
}

// The combo counter carries the same +1 as the B2B one, and one clear on its own
// is not a combo: canonical 1 is the first clear and stays blank, so the counter
// opens at 1 on the second clear in a row.
export function shownCombo(combo) {
  return combo > 1 ? combo - 1 : "—";
}
