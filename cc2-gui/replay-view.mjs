/**
 * `.ttrm` replay playback.
 *
 * The browser has no Triangle Engine, so a file is uploaded once and the server
 * answers with ReplayIR. Everything after that is derived here from the same
 * pure timeline and garbage modules Node uses, which is why scrubbing costs no
 * round trip: the cursor is a frame, and every panel is a function of it.
 *
 * The controls follow the `fumen-mobile-fork` replay screen: one timeline over
 * the shared frame axis with the tank/cancel marker band under it, play/pause,
 * turn stepping that lands just before the placement settles, and x0.25-x4.
 */

import { clearLabel } from "./game.mjs";
import {
  VISIBLE_ROWS,
  outerEdges,
  renderChainCounter,
  renderDetailMetrics,
  renderFieldRateStats,
  renderGarbageGauge,
  renderMatchField,
  renderMini,
  renderNextList,
  shownB2b,
  shownCombo,
} from "./field-render.mjs";
import { calculatePlayerMetrics } from "./player-metrics.mjs";
import { FIELD_HEIGHT, FIELD_WIDTH, pieceName } from "/shared/pieces.mjs";
import { validateReplayIRDocument } from "/shared/replay-ir-validation.mjs";
import { garbageViewAt, killerGarbageOf } from "/shared/replay-garbage.mjs";
import {
  clampPointIndex,
  formatFrameTime,
  indexAtFrame,
  lastPointIndex,
  preLockPointAt,
  statsAt,
  stopFrameAt,
  visualAtFrame,
} from "/shared/replay-timeline.mjs";

// Match ReplayIR deliberately retains board snapshots for each lock and can
// exceed a real .ttrm substantially. Keep the client-side safety cap, while
// allowing a full bot-match JSON such as a 20+ MB long round to be reopened.
const MAX_REPLAY_BYTES = 32 * 1024 * 1024;
/* The active piece and its gravity are shown at 60fps-equivalent resolution.
   The interval only decides how often the cursor is read; how far it moves
   comes from real elapsed time. */
const REPLAY_CLOCK_INTERVAL_MS = 16;
const MAX_TICK_MS = 250;
const elements = {};

let ir = null;
let fileName = "";
let roundIndex = 0;
let selfId = null;
/* The cursor is a fractional frame while playing, so a slow speed still moves
   between two whole frames instead of stalling. Everything that reads it floors
   it to the frame whose state is being displayed. */
let cursorFrame = 0;
let selfIndex = 0;
/* Set by turn stepping only. While it holds, the left side is shown at the
   moment just before its placement settles rather than at a settled point. */
let turnStop = false;
let playing = false;
let speed = 1;
let clockTimer = null;
let lastTickMs = 0;
let active = false;
/* Increments per import attempt: a reply for a file the user has already
   replaced must not overwrite the newer one. */
let importId = 0;
const lastRenderedIndex = { left: null, right: null };

export function initReplayView() {
  for (const node of document.querySelectorAll("[id^='replay-']")) elements[node.id] = node;
  elements["replay-file"].addEventListener("change", (event) => {
    const file = event.target.files?.[0] ?? null;
    if (file !== null) importFile(file);
  });
  elements["replay-clear"].addEventListener("click", clearReplay);
  elements["replay-round"].addEventListener("change", () => {
    selectRound(Number(elements["replay-round"].value));
  });
  elements["replay-self"].addEventListener("change", () => {
    selectSelf(elements["replay-self"].value);
  });
  elements["replay-swap"].addEventListener("click", () => {
    const opponent = opponentPlayer();
    if (opponent !== undefined) selectSelf(opponent.id);
  });
  elements["replay-seek"].addEventListener("input", () => {
    seekTo(Number(elements["replay-seek"].value));
  });
  elements["replay-play"].addEventListener("click", togglePlayback);
  elements["replay-first"].addEventListener("click", () => stepToPoint(0));
  elements["replay-last"].addEventListener("click", () => {
    const player = selfPlayer();
    if (player !== undefined) stepToPoint(lastPointIndex(player));
  });
  elements["replay-prev"].addEventListener("click", () => stepTurn(-1));
  elements["replay-next"].addEventListener("click", () => stepTurn(1));
  elements["replay-speed"].addEventListener("change", () => {
    speed = Number(elements["replay-speed"].value) || 1;
  });
  speed = Number(elements["replay-speed"].value) || 1;
  window.addEventListener("keydown", handleKeyDown);
  renderControls();
}

/** Called by the mode tabs: playback never runs while the panel is off screen. */
export function setReplayActive(next) {
  active = next;
  if (!active) pausePlayback();
}

function handleKeyDown(event) {
  if (!active || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.target instanceof Element &&
      event.target.closest("input, select, textarea, [contenteditable='true']") !== null) {
    return;
  }
  if (event.code === "Space") {
    event.preventDefault();
    togglePlayback();
  } else if (event.code === "ArrowLeft") {
    event.preventDefault();
    stepTurn(-1);
  } else if (event.code === "ArrowRight") {
    event.preventDefault();
    stepTurn(1);
  }
}

async function importFile(file) {
  const id = (importId += 1);
  pausePlayback();
  if (file.size > MAX_REPLAY_BYTES) {
    return fail(id, "size", `${Math.ceil(file.size / (1024 * 1024))}MB > 32MB`);
  }
  setStatus("PARSING", `${file.name} を解析中…`);
  let text;
  try {
    text = await file.text();
  } catch (error) {
    return fail(id, "read", error instanceof Error ? error.message : String(error));
  }

  // Bot-match exports are ReplayIR already. Inspect the content, rather than
  // the extension, so renamed files still take the direct safe path.
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // `.ttrm` is also JSON in the normal case; let the existing server parser
    // produce its established JSON-stage error for malformed input.
  }
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) &&
      Object.prototype.hasOwnProperty.call(parsed, "$schema")) {
    try {
      validateReplayIRDocument(parsed);
    } catch (error) {
      return fail(id, "schema", error instanceof Error ? error.message : String(error));
    }
    return adopt(parsed, file.name);
  }

  let response;
  let body;
  try {
    response = await fetch("/api/replay/import", {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8" },
      body: text,
    });
    body = await response.json();
  } catch (error) {
    return fail(id, "server", error instanceof Error ? error.message : String(error));
  }
  if (id !== importId) return undefined;
  if (!response.ok) return fail(id, body.stage ?? "server", body.message ?? "import failed");
  return adopt(body.ir, file.name);
}

function fail(id, stage, message) {
  if (id !== importId) return undefined;
  ir = null;
  setStatus("FAILED", `${stage}: ${message}`);
  elements["replay-summary"].textContent = `IMPORT FAILED · ${stage} · ${message}`;
  renderControls();
  return undefined;
}

function adopt(imported, name) {
  ir = imported;
  fileName = name;
  // A round the engine could not reproduce is still listed, but the first one
  // that verified is what the viewer opens on.
  const playable = ir.rounds.findIndex((round) => round.status === "ok");
  roundIndex = playable < 0 ? 0 : playable;
  selfId = defaultSelfId();
  cursorFrame = 0;
  selfIndex = 0;
  turnStop = false;
  fillSelectors();
  setStatus("READY", `${name} · ${ir.rounds.length} ROUNDS · ${ir.meta.parseMs}ms`);
  renderMarkers();
  render();
}

function defaultSelfId() {
  const round = currentRound();
  const users = ir?.meta.users ?? [];
  const inRound = users.find((user) => round?.players.some((player) => player.id === user.id));
  return inRound?.id ?? round?.players[0]?.id ?? null;
}

function clearReplay() {
  importId += 1;
  pausePlayback();
  ir = null;
  fileName = "";
  elements["replay-file"].value = "";
  elements["replay-summary"].textContent = "NO REPLAY LOADED";
  setStatus("IDLE", "NO FILE");
  renderControls();
}

function currentRound() {
  return ir?.rounds[roundIndex];
}

function selfPlayer() {
  return currentRound()?.players.find((player) => player.id === selfId);
}

function opponentPlayer() {
  return currentRound()?.players.find((player) => player.id !== selfId);
}

// The shared frame axis covers both sides: a player who topped out early still
// has an opponent whose replay keeps running.
function endFrame() {
  const round = currentRound();
  if (round === undefined) return 0;
  return Math.max(round.endFrame, ...round.players.map((player) => player.terminal.frame));
}

function playable() {
  return currentRound()?.status === "ok" && selfPlayer() !== undefined;
}

function selectRound(next) {
  if (ir === undefined || ir === null || !Number.isInteger(next) || ir.rounds[next] === undefined) return;
  pausePlayback();
  roundIndex = next;
  if (!currentRound().players.some((player) => player.id === selfId)) selfId = defaultSelfId();
  cursorFrame = 0;
  selfIndex = 0;
  turnStop = false;
  fillSelectors();
  renderMarkers();
  render();
}

function selectSelf(playerId) {
  const round = currentRound();
  if (round === undefined || !round.players.some((player) => player.id === playerId)) return;
  selfId = playerId;
  // The frame is the shared axis, so swapping sides keeps the moment in view.
  turnStop = false;
  selfIndex = selfPlayer() === undefined ? 0 : indexAtFrame(selfPlayer(), cursorFrame);
  fillSelectors();
  renderMarkers();
  render();
}

function fillSelectors() {
  const round = currentRound();
  elements["replay-round"].replaceChildren(...(ir?.rounds ?? []).map((entry, index) => {
    const option = document.createElement("option");
    const winner = entry.players.find((player) => player.id === entry.result.winnerId);
    option.value = String(index);
    option.textContent = entry.status === "ok"
      ? `ROUND ${index + 1}${winner === undefined ? "" : ` · ${winner.username} WIN`}`
      : `ROUND ${index + 1} · ${entry.failure?.stage ?? "failed"}`;
    option.selected = index === roundIndex;
    return option;
  }));
  elements["replay-self"].replaceChildren(...(round?.players ?? []).map((player) => {
    const option = document.createElement("option");
    option.value = player.id;
    option.textContent = player.username;
    option.selected = player.id === selfId;
    return option;
  }));
}

function setStatus(state, text) {
  elements["replay-status"].dataset.state = state;
  elements["replay-status"].textContent = text;
}

function renderControls() {
  const ready = playable();
  const player = selfPlayer();
  elements["replay-seek"].disabled = !ready;
  elements["replay-play"].disabled = !ready;
  elements["replay-first"].disabled = !ready || selfIndex <= 0;
  elements["replay-prev"].disabled = !ready || selfIndex <= 0;
  elements["replay-next"].disabled = !ready || player === undefined || selfIndex >= lastPointIndex(player);
  elements["replay-last"].disabled = elements["replay-next"].disabled;
  elements["replay-round"].disabled = ir === null;
  elements["replay-self"].disabled = ir === null;
  elements["replay-swap"].disabled = opponentPlayer() === undefined;
  elements["replay-clear"].disabled = ir === null;
  elements["replay-play"].textContent = playing ? "PAUSE" : "PLAY";
  elements["replay-play"].setAttribute("aria-pressed", String(playing));
}

function togglePlayback() {
  if (playing) return pausePlayback();
  if (!playable()) return undefined;
  // Pressing play at the very end restarts from the beginning.
  if (cursorFrame >= endFrame()) setCursor(0);
  playing = true;
  turnStop = false;
  lastTickMs = performance.now();
  clockTimer = setInterval(tick, REPLAY_CLOCK_INTERVAL_MS);
  renderControls();
  return undefined;
}

function pausePlayback() {
  if (clockTimer !== null) clearInterval(clockTimer);
  clockTimer = null;
  if (!playing) return;
  playing = false;
  renderControls();
}

/* Real elapsed time drives the cursor rather than the number of callbacks, so a
   late tick costs no replay time. One tick is capped at a quarter second: a
   background tab is throttled to whole seconds, and without the cap returning
   to the page would jump the replay forward by however long it was away. */
function tick() {
  if (!playing || !playable()) return pausePlayback();
  const now = performance.now();
  const elapsedMs = Math.min(MAX_TICK_MS, Math.max(0, now - lastTickMs));
  lastTickMs = now;
  const next = cursorFrame + elapsedMs / 1000 * 60 * speed;
  const end = endFrame();
  if (next >= end) {
    setCursor(end);
    return pausePlayback();
  }
  return setCursor(next);
}

function setCursor(frame) {
  const clamped = Math.min(endFrame(), Math.max(0, frame));
  cursorFrame = clamped;
  const player = selfPlayer();
  if (player !== undefined && !turnStop) selfIndex = indexAtFrame(player, clamped);
  render();
}

function seekTo(frame) {
  if (!playable() || !Number.isFinite(frame)) return;
  turnStop = false;
  setCursor(Math.round(frame));
}

/* Turn stepping is always based on the left player; the right one is followed
   by swapping sides. The index that was explicitly stepped to is kept rather
   than recomputed, so two locks sharing one frame cannot skip a turn. */
function stepTurn(step) {
  const player = selfPlayer();
  if (!playable() || player === undefined || step === 0) return;
  const target = selfIndex + (step > 0 ? 1 : -1);
  if (target < 0 || lastPointIndex(player) < target) return;
  stepToPoint(target);
}

function stepToPoint(index) {
  const player = selfPlayer();
  if (!playable() || player === undefined) return;
  pausePlayback();
  const target = clampPointIndex(player, index);
  selfIndex = target;
  turnStop = true;
  cursorFrame = Math.min(endFrame(), Math.max(0, stopFrameAt(player, target)));
  render();
}

function render() {
  const round = currentRound();
  renderControls();
  if (round === undefined) return;
  if (round.status !== "ok") {
    elements["replay-summary"].textContent =
      `ROUND ${roundIndex + 1} UNPLAYABLE · ${round.failure?.stage ?? "failed"} · ${round.failure?.message ?? ""}`;
    return;
  }
  const self = selfPlayer();
  const opponent = opponentPlayer();
  if (self === undefined) return;

  const end = endFrame();
  const frame = cursorFrame;
  elements["replay-seek"].max = String(Math.max(1, end));
  elements["replay-seek"].value = String(Math.round(frame));
  elements["replay-time-current"].textContent = formatFrameTime(frame);
  elements["replay-time-total"].textContent = formatFrameTime(end);
  elements["replay-turn"].textContent = `TURN ${Math.min(selfIndex, self.locks.length)} / ${self.locks.length}`;
  elements["replay-summary"].textContent = summaryText(round, self, opponent);

  // Only the stepped side is shown just before its placement settles: the
  // opponent has its own turn numbering and is followed on the frame axis.
  const preLock = turnStop ? preLockPointAt(self, selfIndex) : undefined;
  renderSide("left", self, preLock?.visual, preLock?.confirmedIndex, frame);
  if (opponent !== undefined) renderSide("right", opponent, undefined, undefined, frame);
}

function summaryText(round, self, opponent) {
  const parts = [`${fileName || "REPLAY"} · ${ir.meta.gamemode || "game"}`];
  if (ir.meta.origin === "s2-bot-match/1") {
    parts.push("SYNTHETIC CLOCK · NO INPUT LOG · NOT EVIDENCE");
  }
  const winner = round.players.find((player) => player.id === round.result.winnerId);
  parts.push(winner === undefined ? "NO WINNER RECORDED" : `WINNER ${winner.username}`);
  for (const player of [self, opponent]) {
    if (player === undefined) continue;
    const killer = killerGarbageOf(player);
    parts.push(`${player.username}: ${player.locks.length} PIECES · ${player.terminal.reason.toUpperCase()}`
      + (killer === undefined ? "" : ` · KILLED BY ${killer.amount} ROWS @ COL ${killer.column + 1}`));
  }
  if (self.optionWarnings.length > 0) parts.push(`OPTION WARNINGS ${self.optionWarnings.length}`);
  return parts.join(" | ");
}

function renderSide(side, player, visualOverride, confirmedIndex, frame) {
  const visual = visualOverride ?? visualAtFrame(player, frame);
  const index = confirmedIndex ?? indexAtFrame(player, frame);
  const stats = statsAt(player, index, Math.floor(frame));
  const garbage = garbageViewAt(player, Math.floor(frame));
  const lines = player.locks.slice(0, stats.placed).reduce((total, lock) => total + lock.clear.lines, 0);

  elements[`replay-${side}-name`].textContent = `${side.toUpperCase()} · ${player.username}`;
  elements[`replay-${side}-stats`].textContent =
    `${stats.attack} ATK · ${lines} LINES · ${stats.garbageCleared} DS · ☢ ${garbage.gauge} · ☢↓ ${stats.tanked}`;
  renderMatchField(
    elements[`replay-${side}-field`],
    boardFromField(visual.field),
    settledPlacement(player, index, visual.field),
    activeOverlay(visual.active),
  );
  renderMini(elements[`replay-${side}-hold`], pieceName(visual.hold));
  renderNextList(elements[`replay-${side}-next`], visual.next.slice(0, 5).map(pieceName));
  renderGarbageGauge(
    elements[`replay-${side}-gauge`],
    garbage.pending.map((parcel) => ({ amount: parcel.remaining })),
    `${side} player`,
  );
  // The engine's counters are one behind canonical state, which is what the
  // shared chain renderer expects, so both are raised by one here.
  const clear = stats.lastClear;
  renderChainCounter(elements[`replay-${side}-b2b`], "B2B", shownB2b((clear?.b2b ?? -1) + 1), (clear?.b2b ?? -1) >= 0);
  renderChainCounter(elements[`replay-${side}-ren`], "COMBO", shownCombo((clear?.ren ?? -1) + 1), (clear?.ren ?? -1) > 0);
  elements[`replay-${side}-clear`].textContent = clear === null
    ? ""
    : clearLabel(clear.spin, clear.lines, clear.perfectClear);

  // The rates are computed by the same module the live match uses, from the
  // cursor frame rather than the last settled lock, so time keeps passing while
  // a piece is still falling.
  const metrics = calculatePlayerMetrics({
    pieces: stats.placed,
    attack: stats.attack,
    garbageCleared: stats.garbageCleared,
    elapsedFrames: Math.floor(frame),
  });
  renderFieldRateStats(elements[`replay-${side}-rate-left`], { ...metrics, pieces: stats.placed }, [
    ["PCS", "pieces", 0],
    ["PPS", "pps", 2],
    ["APM", "apm", 2],
    ["APP", "app", 3],
  ]);
  renderFieldRateStats(elements[`replay-${side}-rate-right`], metrics, [
    ["VS", "vs", 2],
    ["AREA", "area", 2],
  ]);
  elements[`replay-${side}-score`].textContent = `PCS ${stats.placed} / ${player.locks.length}`;
  elements[`replay-${side}-clock`].textContent = formatFrameTime(frame);
  // The 17-row detail grid only changes when a placement settles, so it is not
  // rebuilt on every animation frame.
  if (lastRenderedIndex[side] !== index || visualOverride !== undefined) {
    renderDetailMetrics(elements[`replay-${side}-metrics`], metrics);
    lastRenderedIndex[side] = index;
  }
}

/** ReplayIR keeps a flat 10x23 field with y=0 at the bottom; the board shows 20. */
function boardFromField(field) {
  const rows = [];
  for (let y = 0; y < VISIBLE_ROWS; y += 1) {
    const row = [];
    for (let x = 0; x < FIELD_WIDTH; x += 1) {
      const cell = field[y * FIELD_WIDTH + x];
      row.push(cell ? pieceName(cell) : null);
    }
    rows.push(row);
  }
  return rows;
}

function activeOverlay(activePiece) {
  if (activePiece === undefined) return null;
  const piece = pieceName(activePiece.piece);
  const keys = new Set(activePiece.cells.map(([x, y]) => `${x}:${y}`));
  const overlay = new Map();
  for (const [x, y] of activePiece.cells) {
    overlay.set(`${x}:${y}`, { piece, ghost: false, edges: outerEdges(keys, x, y) });
  }
  return overlay;
}

/* The latest placement is highlighted only while its four cells are still
   exactly where they were placed. A clear, a tank or a later placement moves or
   consumes them, and highlighting whatever now sits there would name the wrong
   piece. */
function settledPlacement(player, index, field) {
  const lock = player.locks[index - 1];
  if (lock?.cells === undefined) return [];
  const intact = lock.cells.every(([x, y]) =>
    x >= 0 && x < FIELD_WIDTH && y >= 0 && y < FIELD_HEIGHT &&
    field[y * FIELD_WIDTH + x] === lock.piece);
  return intact ? lock.cells : [];
}

/* Tank and cancel marks over the shared frame axis, drawn for the left player.
   Receives are deliberately not drawn: an attack that was never resolved is not
   something that happened to the board. */
function renderMarkers() {
  const canvas = elements["replay-markers"];
  const context = canvas.getContext("2d");
  context.clearRect(0, 0, canvas.width, canvas.height);
  const player = selfPlayer();
  const end = endFrame();
  if (player === undefined || end <= 0) return;
  for (const event of player.garbageEvents) {
    if (event.kind !== "tank" && event.kind !== "cancel") continue;
    context.fillStyle = event.kind === "tank" ? "#e0525f" : "#3fbf7f";
    const x = Math.min(canvas.width - 2, Math.max(0, Math.round(event.frame / end * canvas.width)));
    context.fillRect(x, 0, 2, canvas.height);
  }
}
