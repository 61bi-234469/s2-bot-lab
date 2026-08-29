/**
 * The DOM builders every field on the page shares.
 *
 * Analysis, match, 1P, and replay fields are the same picture of the same 20
 * visible rows, so they are drawn by one set of functions rather than separate
 * implementations that could drift apart. Everything here is pure: it writes
 * into the container it is handed and reads nothing else.
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

export function renderDetailMetrics(container, metrics) {
  container.replaceChildren(...DETAIL_METRICS.map(([label, key, digits]) => {
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const value = document.createElement("dd");
    term.textContent = label;
    value.textContent = formatMetric(metrics?.[key], digits);
    row.append(term, value);
    return row;
  }));
}

/* `overlay` carries a piece that has not locked - the one a human player is
   moving, or the one a replay cursor is watching fall. It is drawn over the
   board rather than into it, because the board itself is settled state. */
export function renderMatchField(container, board, lastPlaced, overlay = null) {
  const placed = new Set((lastPlaced ?? []).map(([x, y]) => `${x}:${y}`));
  const cells = [];
  for (let y = VISIBLE_ROWS - 1; y >= 0; y -= 1) {
    for (let x = 0; x < 10; x += 1) {
      const cell = document.createElement("div");
      const overlaid = overlay?.get(`${x}:${y}`) ?? null;
      const piece = overlaid?.piece ?? board[y][x];
      const isPlaced = overlaid === null && piece !== null && placed.has(`${x}:${y}`);
      cell.className = `cell${piece ? " filled" : ""}`
        + (overlaid === null ? "" : `${overlaid.ghost ? " ghost" : " active"}${overlaid.edges}`)
        + (isPlaced ? ` placed${outerEdges(placed, x, y)}` : "");
      const marker = piece ?? null;
      if (marker) cell.dataset.piece = marker;
      cells.push(cell);
    }
  }
  container.replaceChildren(...cells);
}

export function renderNextList(container, pieces) {
  container.replaceChildren(...pieces.map((piece) => {
    const item = document.createElement("div");
    item.className = "mini-box";
    renderMini(item, piece);
    return item;
  }));
}

export function renderMini(container, piece) {
  const grid = document.createElement("div");
  grid.className = "mini-grid";
  grid.dataset.piece = piece ?? "";
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
  grid.style.setProperty("--mini-cols", String(bounds.maxX - bounds.minX + 1));
  grid.style.setProperty("--mini-rows", String(bounds.maxY - bounds.minY + 1));
  const occupied = new Set(cells.map(([x, y]) => `${x}:${y}`));
  for (let y = bounds.maxY; y >= bounds.minY; y -= 1) {
    for (let x = bounds.minX; x <= bounds.maxX; x += 1) {
      const cell = document.createElement("span");
      cell.className = `mini-cell${occupied.has(`${x}:${y}`) ? " filled" : ""}`;
      grid.append(cell);
    }
  }
  container.replaceChildren(grid);
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
  const rows = definitions.map(([label, key, digits]) => {
    const row = document.createElement("span");
    const value = document.createElement("b");
    const term = document.createElement("small");
    value.textContent = formatMetric(metrics?.[key], digits);
    term.textContent = ` ${label}`;
    row.append(value, term);
    return row;
  });
  container.replaceChildren(...rows);
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
