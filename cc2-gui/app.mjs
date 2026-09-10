import { INPUT_BOT_PROFILES } from '/shared/input-bot-contract.mjs';
import {
  applyS2Transition,
  clearLabel,
  createGame,
  placementCells,
  toCc2State,
  toS2GuiState,
} from "./game.mjs";
import {
  advanceMatchPlaybackDeadline,
  createMatchClock,
  readMatchClock,
  setMatchClockRunning,
  synchronizeMatchClock,
} from "./match-clock.mjs";
import { calculatePlayerMetrics, formatGameClock } from "./player-metrics.mjs";
import {
  CONTROL_PREFERENCE_IDS,
  GUI_MODES,
  PREFERENCES_STORAGE_KEY,
  TOGGLE_PREFERENCE_IDS,
  emptyPreferences,
  sanitizePreferences,
} from "./preferences.mjs";
import {
  BOT_PARAMETER_DEFINITIONS,
  defaultBotParameters,
  fairComparisonBotParameters,
  normalizeBotParameters,
} from "/shared/bot-parameters.mjs";
import {
  canonicalPlacementToGuiMove,
  simpleAnalysisToVerification,
} from "./analysis-proposal.mjs";
import {
  CANDIDATE_COUNT_LIMIT,
  markCandidateSelection,
  moveIdentity,
  renderCandidateList,
  simpleAnalysisCandidateRows,
} from "./analysis-candidates.mjs";
import {
  HUMAN_ACTIONS,
  HUMAN_HANDLING_FIELDS,
  SDF_INFINITE,
  SDF_MAX,
  SDF_MIN,
  actionForCode,
  defaultHumanControls,
  describeHumanControls,
  formatKeyCode,
  humanHandling,
  sanitizeHumanControls,
} from "./human-controls.mjs";
import {
  addOverlayPiece,
  inputPieceOverlay,
  renderChainCounter,
  renderDetailMetrics,
  renderFieldRateStats,
  renderGarbageGauge,
  formatInputExecutionTooltip,
  renderMatchField,
  renderMini,
  renderNextList,
  shownB2b,
  shownCombo,
} from "./field-render.mjs";
import { initReplayView, setReplayActive } from "./replay-view.mjs";
import { MATCH_REPLAY_SCHEMA } from "/shared/replay-ir-validation.mjs";
import {
  createPieceRepeat,
  dropped,
  lockSubmission,
  pieceCells,
  rotated,
  shifted,
  shiftedToEnd,
  spawnPlacement,
} from "./human-play.mjs";
import {
  INPUT_PUMP_INTERVAL_MS,
  earliestPendingInputFrame,
  nextIdlePumpDueAt,
  selectPumpReservation,
} from "./input-pump-schedule.mjs";

const elements = Object.fromEntries([...document.querySelectorAll("[id]")].map((node) => [node.id, node]));
const BOT_SIDES = Object.freeze(["left", "right"]);
const INPUT_EXECUTION_PROFILE = "s2-input-execution/1";
const INPUT_MATCH_ENDPOINT = "/api/input-match";
const INPUT_SUPPORTED_TYPES = new Set(["human", ...Object.keys(INPUT_BOT_PROFILES)]);
const INPUT_ACTION_KEYS = Object.freeze({
  MoveLeft: "moveLeft",
  MoveRight: "moveRight",
  SoftDrop: "softDrop",
  HardDrop: "hardDrop",
  RotateLeft: "rotateCCW",
  RotateRight: "rotateCW",
  Rotate180: "rotate180",
  Hold: "hold",
});
// Headings for the `group` ids the parameter schema declares. The schema says
// which group a parameter belongs to; what that group is called, and the rule
// printed under it, are presentation and stay here.
const BOT_PARAMETER_GROUPS = Object.freeze({
  pace: Object.freeze({
    label: "PACING",
    note: "PPSをOFFにすると、SELECTIONまたはTHINK TIMEの探索が終了した時点で配置します。",
  }),
  budget: Object.freeze({
    label: "SEARCH BUDGET",
    note: "SELECTION と THINK TIME は併用でき、先に到達した方で探索を終了します。",
  }),
  input: Object.freeze({ label: "INPUT" }),
});
const SEARCH_BUDGET_VALIDATION_NOTE = "SELECTIONまたはTHINK TIMEを1つ以上ONにしてください。";
// B2B charging as resolved by the server from the ruleset the GUI runs under.
// Until /api/bots answers there is no rule to read, so no counter claims to be
// surge-ready; `false` is the ruleset's own value for charging being off.
let b2bCharging = false;
const botParameters = Object.fromEntries(BOT_SIDES.map((side) => [side, Object.fromEntries(
  Object.keys(BOT_PARAMETER_DEFINITIONS).map((botType) => [botType, { ...defaultBotParameters(botType) }]),
)]));
let botCapabilities = new Map(Object.entries(BOT_PARAMETER_DEFINITIONS));
let settingsSide = null;
let game = createGame();
let pendingMove = null;
let pendingVerification = null;
let pendingThinkElapsedMs = 0;
let gameMetricElapsedMs = 0;
let thinking = false;
let autoplay = false;
// Invalidates an in-flight analysis whenever RESET or a bot change replaces
// the position it was asked to evaluate.
let analysisGeneration = 0;
/* The proposer's ranked root placements for the position currently on screen,
   in the order it returned them. A placement only means anything against the
   field it was proposed for, so these are dropped whenever that field, or the
   proposer being asked about it, changes. */
let candidateRows = [];
/* The same-position S2 reference the list was built with, kept so adopting a
   candidate can re-score the comparison row against it instead of leaving the
   previous proposal's numbers up. */
let candidateReference = null;
let candidateElapsedMs = 0;
let candidatesLoading = false;
let matchRunning = false;
let matchAutoplay = false;
/* Only true while a start request is in flight, which is the one moment the
   single run button has nothing to toggle yet. */
let matchStarting = false;
let matchStartInFlight = null;
let humanMatchRestartInFlight = null;
let lastStartedMatchSeed = null;
let matchSeries = null;
let matchRoundStatus = "";
let matchRoundFinalization = null;
let matchSaveInFlight = false;
let matchClock = createMatchClock(performance.now());
/* Bumped by every start and every RESET, so a reply from a discarded session
   can be told apart from the one the arena currently shows. */
let matchGeneration = 0;
let lastRenderedMatchClock = "";
let lastRenderedMatchElapsedMs = 0;
let matchPlaybackDeadlineMs = 0;
let matchPlaybackElapsedMs = 0;
let matchComputeRatio = 1;
let matchComputeLimited = false;
const preferences = loadPreferences();
let mode = preferences.mode ?? "analysis";
let humanControls = preferences.humanControls ?? defaultHumanControls();
/* The block layout and kick table the server evaluates placements with. Fetched
   once, before the first match a human plays. */
let placementGeometry = null;
/* The live 1P piece. `null` whenever nobody is playing by hand, so every input
   path can be gated on one value. */
let human = null;
const pieceRepeat = createPieceRepeat();
let humanRenderRequested = false;
/* The opponent's next step in a match a human is playing: scheduled against the
   shared clock rather than chained off the previous reply, because the player's
   own locks advance that clock in between. */
let humanBotStepTimer = null;
/* Identifies the server session whose step is in flight. A new round advances
   matchGeneration, so an old request can neither block nor clear the new
   round's first step. */
let matchStepGeneration = null;
let lastMatchView = null;
let matchPaintView = null;
let matchPaintRequested = false;
/* The input-profile session owns the real Engine clock. The page clock only
   decides how far the next nonblocking pump may advance it; queued events keep
   their original intended frame until the server accepts them. */
let inputMatchState = null;
let inputEventSequence = 0;

applyStoredPreferences();
render();
initReplayView();
for (const name of GUI_MODES) {
  elements[`mode-tab-${name}`].addEventListener("click", () => selectMode(name));
  elements[`mode-tab-${name}`].addEventListener("keydown", handleModeTabKeydown);
}
renderMode();
for (const id of [...CONTROL_PREFERENCE_IDS, ...TOGGLE_PREFERENCE_IDS]) {
  elements[id].addEventListener("change", savePreferences);
}
elements["analysis-bot"].addEventListener("change", () => {
  clearAnalysisProposal();
  renderAnalysisEngineIdentity();
});
elements["think-button"].addEventListener("click", think);
elements["candidates-button"].addEventListener("click", toggleCandidates);
/* Changing the width while the list is open reloads it, because the number on
   the control and the number of rows on screen have to be the same claim. */
elements["candidate-count"].addEventListener("change", () => {
  if (!elements["candidate-panel"].hidden) loadCandidates();
});
elements["apply-button"].addEventListener("click", applyPending);
elements["auto-button"].addEventListener("click", toggleAutoplay);
elements["reset-button"].addEventListener("click", reset);
elements["match-run"].addEventListener("click", toggleMatchRun);
elements["match-step"].addEventListener("click", stepMatch);
elements["match-reset"].addEventListener("click", resetMatch);
elements["match-save-replay"].addEventListener("click", saveMatchExport);
elements["match-unlimited-turns"].addEventListener("change", syncMaxTurnsControl);
elements["match-random-seed"].addEventListener("change", () => syncRandomSeedControl());
/* One delegated listener rather than one per control: every setting in this row
   shows up on the disclosure's closed bar, so each of them has to refresh it. */
elements["match-settings"].addEventListener("input", () => renderExecutionScopeNotes());
elements["match-fair-comparison"].addEventListener("change", syncFairComparisonControls);
elements["match-ttrm-compatible"].addEventListener("change", () => {
  clampInputQueueDepths();
  syncHumanMatchControls();
  syncFairComparisonControls();
  renderMatchSaveButton();
  if (lastMatchView === null) renderEmptyMatchFields();
  // The generic toggle listener has already saved the checkbox. Save once more
  // so queue caps applied here are persisted in the same user action.
  savePreferences();
});
for (const side of BOT_SIDES) {
  elements[`${side}-bot`].addEventListener("change", () => {
    renderBotSettingsSummary(side);
    syncHumanMatchControls();
    syncFairComparisonControls();
  });
  elements[`${side}-bot-settings`].addEventListener("click", () => openBotSettings(side));
}
elements["bot-settings-form"].addEventListener("submit", saveBotSettings);
window.addEventListener("keydown", handleHumanKeyDown);
window.addEventListener("keyup", handleHumanKeyUp);
/* A key released while the page is in the background never reports its keyup,
   so every hold is dropped rather than repeating forever. Input taps are also
   discarded: a queued event must never be replayed after the user's focus or
   the local clock has moved on. */
window.addEventListener("blur", () => {
  pieceRepeat.endAll();
  clearInputEvents({ releaseHeld: true });
  requestInputPump(0);
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flushMatchPaint();
});
syncMaxTurnsControl();
syncRandomSeedControl();
syncHumanMatchControls();
syncFairComparisonControls();
/* The export buttons ship disabled in the markup, so their reason has to be
   filled in once before the first match rather than only on the next render. */
renderMatchSaveButton();
renderMatchRunButton();
renderEmptyMatchFields();
for (const side of BOT_SIDES) renderBotSettingsSummary(side);
renderAnalysisEngineIdentity();
loadBotCapabilities();
requestAnimationFrame(renderRealtimeMatchClock);
elements["think-ms"].addEventListener("input", () => {
  elements["think-value"].textContent = elements["think-ms"].value;
});

/* Preferences are a convenience, never a requirement: a browser that refuses
   storage (private mode, quota) or a document written by another build simply
   leaves the page on its markup defaults. */
function loadPreferences() {
  try {
    const stored = localStorage.getItem(PREFERENCES_STORAGE_KEY);
    return stored === null
      ? emptyPreferences()
      : sanitizePreferences(JSON.parse(stored), normalizeBotParameters, sanitizeHumanControls);
  } catch {
    return emptyPreferences();
  }
}

function savePreferences() {
  try {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify({
      mode,
      controls: Object.fromEntries(CONTROL_PREFERENCE_IDS.map((id) => [id, elements[id].value])),
      toggles: Object.fromEntries(TOGGLE_PREFERENCE_IDS.map((id) => [id, elements[id].checked])),
      botParameters,
      humanControls,
    }));
  } catch {
    // Nothing to recover: the session keeps running with unsaved settings.
  }
}

function applyStoredPreferences() {
  for (const id of CONTROL_PREFERENCE_IDS) applyStoredControl(id, preferences.controls[id]);
  for (const id of TOGGLE_PREFERENCE_IDS) {
    if (id in preferences.toggles) elements[id].checked = preferences.toggles[id];
  }
  for (const side of BOT_SIDES) {
    for (const [botType, values] of Object.entries(preferences.botParameters[side])) {
      if (botType in botParameters[side]) botParameters[side][botType] = { ...values };
    }
  }
  if (clampInputQueueDepths()) savePreferences();
  elements["think-value"].textContent = elements["think-ms"].value;
}

/* Input execution can expose current + 14 NEXT pieces. Persist the cap for
   every admitted bot on both sides so switching bots while input mode remains
   enabled cannot restore an invalid queue depth. */
function clampInputQueueDepths() {
  if (!inputModeSelected()) return false;
  let changed = false;
  for (const side of BOT_SIDES) for (const botType of Object.keys(INPUT_BOT_PROFILES)) {
    const values = botParameters[side][botType];
    if (values?.queueDepth <= 15) continue;
    botParameters[side][botType] = { ...values, queueDepth: 15 };
    changed = true;
  }
  return changed;
}

/* A stored value only wins when this build still offers it, so a removed bot or
   a narrowed numeric range leaves the control on its markup default instead of
   blanking it or restoring a value the match API would reject. */
function applyStoredControl(id, value) {
  if (value === undefined) return;
  const element = elements[id];
  if (element.tagName === "SELECT") {
    if (![...element.options].some((option) => option.value === value)) return;
  } else {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric < Number(element.min) || numeric > Number(element.max)) return;
  }
  element.value = value;
}

async function loadBotCapabilities() {
  let capabilities;
  try {
    const response = await fetch("/api/bots");
    capabilities = await response.json();
    if (!response.ok || !Array.isArray(capabilities.bots)) throw new Error("bot capability response is invalid");
  } catch (error) {
    capabilities = {
      bots: [{ id: "s2-simple", label: "S2 placement bot", available: true }],
    };
  }
  b2bCharging = capabilities.ruleset?.b2bCharging ?? false;
  if (capabilities.runtime?.mode === "static-wasm") {
    elements["think-ms"].disabled = false;
    elements["think-ms"].title = "ブラウザ版の探索時間は、端末やブラウザの状態によって結果が変わります";
  }
  const byId = new Map(capabilities.bots.map((bot) => {
    const fallback = BOT_PARAMETER_DEFINITIONS[bot.id];
    return [bot.id, {
      ...fallback,
      ...bot,
      parameters: bot.parameters ?? fallback?.parameters ?? [],
    }];
  }));
  botCapabilities = byId;
  for (const selectId of ["analysis-bot", "left-bot", "right-bot"]) {
    const select = elements[selectId];
    for (const option of select.options) {
      const bot = byId.get(option.value);
      if (!bot) continue;
      /* Whether the build has the bot at all is kept on the option, because the
         execution path also greys options and the two reasons must not
         overwrite each other. */
      option.dataset.unavailable = String(bot.available === false);
      option.dataset.reason = bot.reason ?? "";
      option.disabled = bot.available === false;
      option.textContent = bot.available === false ? `${bot.label} · unavailable` : bot.label;
      option.title = bot.reason ?? "";
    }
    if (select.selectedOptions[0]?.disabled) {
      select.value = [...select.options].find((option) => !option.disabled)?.value ?? "";
    }
  }
  syncInputBotOptions();
  const unavailable = [...byId.values()].filter((bot) => bot.available === false);
  if (unavailable.length > 0) {
    elements["match-bot-note"].textContent += `　現在使えないBot: ${unavailable.map((bot) => `${bot.label}（${bot.reason}）`).join("、")}`;
  }
  renderAnalysisEngineIdentity();
  for (const side of BOT_SIDES) renderBotSettingsSummary(side);
}

function openBotSettings(side) {
  if (inputHumanActive()) {
    clearInputEvents({ releaseHeld: true });
    requestInputPump(0);
  }
  const botType = elements[`${side}-bot`].value;
  const capability = botCapabilities.get(botType) ?? BOT_PARAMETER_DEFINITIONS[botType];
  const values = botParameters[side][botType];
  settingsSide = side;
  elements["bot-settings-side"].textContent = botType === "human" ? `${side.toUpperCase()} PLAYER` : `${side.toUpperCase()} BOT`;
  elements["bot-settings-title"].textContent = capability.label ?? botType;
  const fairNote = fairComparisonEnabled() && botType.startsWith("cc2-")
    ? " いまは FAIR COMPARISON がONのため、対局中は SELECTION 512・1 PPS に揃えられます。ここでの設定は上書きされず、OFFに戻すと元に戻ります。"
    : "";
  elements["bot-settings-description"].textContent = `${capability.description ?? ""}${fairNote}`;
  setBotSettingsValidation("");
  if (botType === "human") {
    elements["bot-settings-fields"].replaceChildren(...humanSettingsFields());
    elements["bot-settings-dialog"].showModal();
    return;
  }
  elements["bot-settings-fields"].replaceChildren(...botSettingsFields(capability, values));
  syncBotSettingsForm(capability);
  elements["bot-settings-dialog"].showModal();
}

/* A flat list of rows hid the two relationships that decide what the dialog
   actually does: which toggle owns which limit, and which rows are live right
   now. Each toggle therefore becomes a card holding its own limit, and every
   reason a control is locked is written next to it instead of into a `title`
   tooltip that never shows on touch and barely registers against this palette. */
function botSettingsFields(capability, values) {
  const dependents = new Map();
  for (const parameter of capability.parameters) {
    if (parameter.controlledBy === undefined) continue;
    dependents.set(parameter.controlledBy, [...dependents.get(parameter.controlledBy) ?? [], parameter]);
  }
  const nodes = [];
  for (const [groupId, parameters] of groupBotParameters(capability.parameters)) {
    const group = BOT_PARAMETER_GROUPS[groupId];
    if (group !== undefined) nodes.push(botSettingsHeading(group.label));
    if (groupId === "budget") nodes.push(searchBudgetSummaryElement());
    for (const parameter of parameters) {
      const children = dependents.get(parameter.key) ?? [];
      nodes.push(children.length === 0
        ? botParameterRow(parameter, values)
        : botParameterCard(parameter, children, values));
    }
    if (group?.note !== undefined) nodes.push(botSettingsNote(group.note));
  }
  return nodes;
}

/* Insertion order is the declared parameter order, so groups come out in the
   order the schema lists them. A bot whose parameters carry no group at all
   collapses to one unlabelled group and renders exactly as it did before. */
function groupBotParameters(parameters) {
  const groups = new Map();
  for (const parameter of parameters) {
    if (parameter.controlledBy !== undefined) continue;
    groups.set(parameter.group, [...groups.get(parameter.group) ?? [], parameter]);
  }
  return groups;
}

function botParameterCard(parameter, dependents, values) {
  const card = document.createElement("div");
  card.className = "bot-parameter-card";
  card.id = `bot-parameter-card-${parameter.key}`;
  card.append(botParameterRow(parameter, values, { describe: false, state: false }));
  for (const dependent of dependents) card.append(botParameterRow(dependent, values, { nested: true }));
  // Both of the toggle's own footnotes sit under the pair rather than inside its
  // row: in the old layout the description pushed a limit further from its own
  // toggle than from the next unrelated setting, and a lock note put there would
  // do the same thing again.
  if (parameter.description) card.append(botParameterDescription(parameter.description));
  card.append(botParameterStateElement(parameter, values));
  return card;
}

function botParameterRow(parameter, values, { nested = false, describe = true, state = true } = {}) {
  const row = document.createElement("div");
  row.className = "bot-parameter";
  row.dataset.control = parameter.type;
  if (nested) row.dataset.nested = "true";
  const label = document.createElement("label");
  const input = document.createElement("input");
  const control = document.createElement("div");
  control.className = "bot-parameter-control";
  input.id = `bot-parameter-${parameter.key}`;
  input.name = parameter.key;
  label.htmlFor = input.id;
  // Inside a card the toggle above already says SELECTION or THINK TIME, so the
  // limit only has to say that it is the limit.
  label.textContent = nested ? parameter.shortLabel ?? parameter.label : parameter.label;
  if (parameter.type === "boolean") {
    input.type = "checkbox";
    input.checked = values[parameter.key];
  } else {
    input.type = "number";
    input.min = parameter.minimum;
    input.max = parameter.maximum;
    if (parameter.key === "queueDepth" && inputModeSelected()) input.max = 15;
    input.step = parameter.step;
    input.value = values[parameter.key];
  }
  if (parameter.key === "pps" && ppsIsOverridden()) {
    input.value = effectivePps(values);
    input.disabled = true;
  }
  if (parameter.disabled === true) input.disabled = true;
  control.append(input);
  if (parameter.suffix) {
    const suffix = document.createElement("span");
    suffix.textContent = parameter.suffix;
    control.append(suffix);
  }
  row.append(label, control);
  if (describe && parameter.description) row.append(botParameterDescription(parameter.description));
  if (state) row.append(botParameterStateElement(parameter, values));
  return row;
}

function botParameterStateElement(parameter, values) {
  const state = document.createElement("small");
  state.className = "bot-parameter-state";
  state.id = `bot-parameter-state-${parameter.key}`;
  state.textContent = botParameterStateText(parameter, values);
  return state;
}

function botParameterStateText(parameter, values) {
  if (parameter.disabled === true) return parameter.disabledReason ?? "この実行環境では利用できません。";
  if (parameter.key === "pps" && ppsIsOverridden()) {
    return "FAIR COMPARISON が両Botを 1 PPS に固定しています。";
  }
  return "";
}

function botParameterDescription(text) {
  const description = document.createElement("small");
  description.className = "bot-parameter-description";
  description.textContent = text;
  return description;
}

function botSettingsHeading(text) {
  const heading = document.createElement("p");
  heading.className = "deck-label";
  heading.textContent = text;
  return heading;
}

function botSettingsNote(text) {
  const note = document.createElement("p");
  note.className = "bot-parameter-note";
  note.textContent = text;
  return note;
}

function searchBudgetSummaryElement() {
  const summary = document.createElement("p");
  summary.className = "bot-parameter-summary";
  summary.id = "bot-search-budget-summary";
  return summary;
}

function setBotParameterState(key, text) {
  const state = document.getElementById(`bot-parameter-state-${key}`);
  if (state !== null) state.textContent = text;
}

function syncBotSettingsForm(capability) {
  const form = elements["bot-settings-form"];
  const selection = form.elements.namedItem("selectionEnabled");
  const thinkTime = form.elements.namedItem("thinkTimeEnabled");
  const sync = () => {
    for (const parameter of capability.parameters) {
      if (!parameter.controlledBy) continue;
      const input = form.elements.namedItem(parameter.key);
      const controller = form.elements.namedItem(parameter.controlledBy);
      if (!(input instanceof HTMLInputElement) || !(controller instanceof HTMLInputElement)) continue;
      const fairPpsOverride = parameter.key === "pps" && fairComparisonEnabled();
      input.disabled = parameter.disabled === true || !controller.checked || fairPpsOverride;
      if (fairPpsOverride) input.value = 1;
      setBotParameterState(parameter.key, controlledLimitStateText(parameter, fairPpsOverride));
    }
    if (selection instanceof HTMLInputElement && thinkTime instanceof HTMLInputElement) {
      const validation = selection.checked || thinkTime.checked ? "" : SEARCH_BUDGET_VALIDATION_NOTE;
      setBotSettingsValidation(validation);
      renderSearchBudgetSummary(form, selection, thinkTime);
    }
  };
  for (const parameter of capability.parameters) {
    if (parameter.type !== "boolean") continue;
    form.elements.namedItem(parameter.key)?.addEventListener("change", sync);
  }
  sync();
}

/* A limit whose own toggle is off says nothing: the greyed-out field is already
   the explanation, and a line that appears and disappears with every toggle
   moves the rest of the card under the pointer. Only a lock the card cannot
   show by itself is spelled out. */
function controlledLimitStateText(parameter, fairPpsOverride) {
  if (parameter.disabled === true) return parameter.disabledReason ?? "この実行環境では利用できません。";
  if (fairPpsOverride) return "FAIR COMPARISON が両Botを 1 PPS に固定しています。";
  return "";
}

function setBotSettingsValidation(message) {
  const output = elements["bot-settings-validation"];
  output.textContent = message;
  output.hidden = message === "";
  const save = elements["bot-settings-save"];
  save.classList.toggle("is-invalid", message !== "");
  save.setAttribute("aria-disabled", String(message !== ""));
}

function renderSearchBudgetSummary(form, selection, thinkTime) {
  const summary = document.getElementById("bot-search-budget-summary");
  if (summary === null) return;
  const limits = [];
  if (selection.checked) limits.push(`${form.elements.namedItem("selectionLimit").value} selections`);
  if (thinkTime.checked) limits.push(`${form.elements.namedItem("thinkMs").value} ms`);
  summary.textContent = limits.length > 1
    ? `有効 > ${limits.join(" / ")}（先に到達した方で打ち切り）`
    : `有効 > ${limits[0] ?? "なし"}`;
}

/* The 1P settings are laid out like the `input` and `keys` tabs of the reference
   fork: the handling values first, then one rebindable row per action. A key row
   captures `KeyboardEvent.code`, so a binding follows the physical key rather
   than whatever the current keyboard layout prints on it. */
function humanSettingsFields() {
  const rows = HUMAN_HANDLING_FIELDS.map((field) => {
    const row = document.createElement("div");
    row.className = "bot-parameter";
    const label = document.createElement("label");
    const control = document.createElement("div");
    control.className = "bot-parameter-control";
    let input;
    if (field.type === "sdf") {
      input = document.createElement("select");
      for (const value of [...Array.from({ length: SDF_MAX - SDF_MIN + 1 }, (_, index) => String(SDF_MIN + index)), SDF_INFINITE]) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = value === SDF_INFINITE ? "∞" : value;
        input.append(option);
      }
      input.value = String(humanControls.handling[field.key]);
    } else if (field.type === "boolean") {
      input = document.createElement("input");
      input.type = "checkbox";
      input.checked = humanControls.handling[field.key] === true;
    } else {
      input = document.createElement("input");
      input.type = "number";
      input.min = field.minimum;
      input.max = field.maximum;
      input.step = field.step;
      input.value = humanControls.handling[field.key];
    }
    input.id = `human-handling-${field.key}`;
    input.name = `human-handling-${field.key}`;
    label.htmlFor = input.id;
    label.textContent = field.label;
    control.append(input);
    if (field.suffix) {
      const suffix = document.createElement("span");
      suffix.textContent = field.suffix;
      control.append(suffix);
    }
    row.append(label, control);
    if (field.description) {
      const description = document.createElement("small");
      description.className = "bot-parameter-description";
      description.textContent = field.description;
      row.append(description);
    }
    return row;
  });

  const heading = document.createElement("p");
  heading.className = "deck-label";
  heading.textContent = "KEY BINDINGS";
  rows.push(heading);

  for (const action of HUMAN_ACTIONS) {
    const row = document.createElement("div");
    row.className = "bot-parameter";
    const label = document.createElement("label");
    const control = document.createElement("div");
    control.className = "bot-parameter-control";
    const input = document.createElement("input");
    input.type = "text";
    input.readOnly = true;
    input.className = "key-binding";
    input.id = `human-key-${action.key}`;
    input.name = input.id;
    input.dataset.code = humanControls.keys[action.key];
    input.value = formatKeyCode(humanControls.keys[action.key]);
    input.addEventListener("keydown", captureKeyBinding);
    label.htmlFor = input.id;
    label.textContent = action.label;
    control.append(input);
    row.append(label, control);
    rows.push(row);
  }
  return rows;
}

/* A rebind consumes the key itself: the dialog's own Escape-to-close and the
   space that would activate the focused control must not fire while the field
   is waiting for the key it is about to be bound to. */
function captureKeyBinding(event) {
  event.preventDefault();
  event.stopPropagation();
  if (event.code === "") return;
  event.currentTarget.dataset.code = event.code;
  event.currentTarget.value = formatKeyCode(event.code);
}

function saveHumanSettings() {
  const form = elements["bot-settings-form"];
  if (!form.reportValidity()) return false;
  const handling = Object.fromEntries(HUMAN_HANDLING_FIELDS.map((field) => {
    const input = form.elements.namedItem(`human-handling-${field.key}`);
    if (field.type === "boolean") return [field.key, input.checked];
    if (field.type === "sdf") {
      return [field.key, input.value === SDF_INFINITE ? SDF_INFINITE : Number(input.value)];
    }
    return [field.key, Number(input.value)];
  }));
  const keys = Object.fromEntries(HUMAN_ACTIONS.map((action) => [
    action.key,
    form.elements.namedItem(`human-key-${action.key}`).dataset.code,
  ]));
  humanControls = sanitizeHumanControls({ handling, keys });
  return true;
}

function saveBotSettings(event) {
  if (event.submitter?.value !== "save" || settingsSide === null) return;
  event.preventDefault();
  const side = settingsSide;
  const botType = elements[`${side}-bot`].value;
  if (botType === "human") {
    if (!saveHumanSettings()) return;
    renderBotSettingsSummary(side);
    savePreferences();
    elements["bot-settings-dialog"].close("save");
    settingsSide = null;
    return;
  }
  const capability = botCapabilities.get(botType) ?? BOT_PARAMETER_DEFINITIONS[botType];
  const values = botParameters[side][botType];
  const form = elements["bot-settings-form"];
  if (!form.reportValidity()) return;
  const selection = form.elements.namedItem("selectionEnabled");
  const thinkTime = form.elements.namedItem("thinkTimeEnabled");
  if (selection instanceof HTMLInputElement && thinkTime instanceof HTMLInputElement
      && !selection.checked && !thinkTime.checked) {
    setBotSettingsValidation(SEARCH_BUDGET_VALIDATION_NOTE);
    return;
  }
  const candidate = Object.fromEntries(capability.parameters.map((parameter) => {
    const input = form.elements.namedItem(parameter.key);
    if (parameter.key === "pps" && ppsIsOverridden()) return [parameter.key, values[parameter.key]];
    return [parameter.key, parameter.type === "boolean" ? input.checked : Number(input.value)];
  }));
  try {
    botParameters[side][botType] = { ...normalizeBotParameters(botType, candidate) };
  } catch (error) {
    elements["bot-settings-description"].textContent = error instanceof Error ? error.message : String(error);
    return;
  }
  renderBotSettingsSummary(side);
  savePreferences();
  elements["bot-settings-dialog"].close("save");
  settingsSide = null;
}

function renderBotSettingsSummary(side) {
  const botType = elements[`${side}-bot`].value;
  const capability = botCapabilities.get(botType) ?? BOT_PARAMETER_DEFINITIONS[botType];
  const configuredValues = botParameters[side][botType];
  const values = fairComparisonEnabled()
    ? fairComparisonBotParameters(botType, configuredValues)
    : configuredValues;
  if (botType === "human") {
    elements[`${side}-bot-settings-summary`].textContent = describeHumanControls(humanControls);
    return;
  }
  elements[`${side}-bot-settings-summary`].textContent = capability.parameters.filter((parameter) => {
    // A limit whose toggle is off does not bound anything, and listing it beside
    // that OFF was the same contradiction the dialog used to show.
    if (parameter.controlledBy === undefined) return true;
    return values[parameter.controlledBy] === true
      || (parameter.key === "pps" && fairComparisonEnabled());
  }).map((parameter) => {
    const overriddenPps = parameter.key === "pps" && ppsIsOverridden();
    const value = overriddenPps ? effectivePps(values) : values[parameter.key];
    if (parameter.type === "boolean") return `${parameter.label} ${value ? "ON" : "OFF"}`;
    const source = fairComparisonEnabled() ? " (FAIR)" : "";
    return `${parameter.label} ${value}${parameter.suffix ? ` ${parameter.suffix}` : ""}${overriddenPps ? source : ""}`;
  }).join(" · ");
}

async function think() {
  if (thinking || candidatesLoading || game.toppedOut) return;
  const generation = analysisGeneration;
  const engine = elements["analysis-bot"].value;
  // Both proposers and the verifier receive clones of this one position. Never
  // read the mutable live game again after the first request has started.
  const cc2Snapshot = toCc2State(game);
  const s2Snapshot = toS2GuiState(game);
  thinking = true;
  pendingMove = null;
  pendingVerification = null;
  pendingThinkElapsedMs = 0;
  resetComparison();
  setStatus("thinking", "THINKING");
  renderAnalysisBusy();
  elements["apply-button"].disabled = true;
  try {
    const suggestionStartedAt = performance.now();
    const simpleRequest = requestSimpleAnalysis(s2Snapshot, 5);
    const suggestionRequest = engine === "s2-simple" ? null : requestSuggestion(engine, cc2Snapshot);
    const [s2, response] = await Promise.all([simpleRequest, suggestionRequest]);
    const body = response === null ? null : await response.json();
    if (generation !== analysisGeneration) return;
    if (response !== null && !response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
    const suggestionElapsedMs = Math.max(1, performance.now() - suggestionStartedAt);
    pendingThinkElapsedMs = suggestionElapsedMs;

    let verification;
    if (engine === "s2-simple") {
      verification = simpleAnalysisToVerification(s2);
      pendingMove = canonicalPlacementToGuiMove(
        s2.moves[0].placement,
        verification.transition.lockResult.spin,
      );
    } else {
      pendingMove = body.suggestion.moves[0];
      const verificationResponse = await fetch("/api/apply-s2", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          engine,
          state: s2Snapshot,
          move: pendingMove,
          moves: engine.startsWith("cc2-s2") ? body.suggestion.moves : undefined,
        }),
      });
      verification = await verificationResponse.json();
      if (generation !== analysisGeneration) return;
      if (!verificationResponse.ok) {
        throw new Error(verification.reasons?.join(", ") ?? verification.error ?? "S2 verification failed");
      }
      if (engine.startsWith("cc2-s2")) pendingMove = verification.move;
    }
    pendingVerification = verification;
    const comparisonResponse = await fetch("/api/compare-simple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseline: verification.comparison, challenger: s2 }),
    });
    const comparison = await comparisonResponse.json();
    if (generation !== analysisGeneration) return;
    if (!comparisonResponse.ok) throw new Error(comparison.error ?? "comparison refused");
    renderComparison(verification, comparison);

    const lock = verification.transition.lockResult;
    const attack = verification.transition.attackStages.outgoingBeforeCancel;
    const clear = clearLabel(lock.spin, lock.lines, lock.perfectClear) || "NO CLEAR";
    const cc2Diagnostic = engine === "s2-simple" ? "" : ` · CC2 label ${pendingMove.spin}`;
    if (engine === "s2-simple") {
      elements["engine-version"].textContent = "S2 placement bot · final-placement depth 1";
      elements["nodes-value"].textContent = compact(s2.generatedMoves);
      elements["nps-value"].textContent = "—";
    } else {
      const info = body.suggestion.move_info;
      elements["engine-version"].textContent = `${body.engine.label} · ${body.info.version} · ${body.engine.commit.slice(0, 7)}`;
      elements["nodes-value"].textContent = compact(info.nodes);
      elements["nps-value"].textContent = Number.isFinite(info.nps) ? compact(Math.round(info.nps)) : "—";
    }
    elements["suggestion-move"].textContent = formatMove(pendingMove);
    elements["suggestion-detail"].textContent = `S2: ${clear} · ${attack} attack${cc2Diagnostic}`;
    setStatus("ready", "SUGGESTED");
    elements["apply-button"].disabled = false;
    renderField();
    renderPlacingStrip();
    renderCandidateSelection();
    if (autoplay) setTimeout(applyPending, 180);
  } catch (error) {
    if (generation !== analysisGeneration) return;
    autoplay = false;
    elements["auto-button"].setAttribute("aria-pressed", "false");
    elements["suggestion-detail"].textContent = error instanceof Error ? error.message : String(error);
    setStatus("error", "ERROR");
  } finally {
    if (generation === analysisGeneration) {
      thinking = false;
      renderAnalysisBusy();
    }
  }
}

async function applyPending() {
  if (pendingMove === null || thinking) return;
  try {
    const body = pendingVerification;
    if (body === null) throw new Error("S2 verification is missing or stale");
    const transition = applyS2Transition(game, pendingMove, body);
    gameMetricElapsedMs += pendingThinkElapsedMs;
    // The board has moved on, so every candidate proposed against the previous
    // one is now about a position that no longer exists.
    clearCandidates();
    pendingMove = null;
    pendingVerification = null;
    pendingThinkElapsedMs = 0;
    elements["apply-button"].disabled = true;
    elements["suggestion-move"].textContent = "—";
    const lock = transition.lockResult;
    const clear = clearLabel(lock.spin, lock.lines, lock.perfectClear) || "NO CLEAR";
    elements["suggestion-detail"].textContent = game.toppedOut
      ? "TOP OUT"
      : `S2 Simulator: ${clear} · ${transition.attackStages.outgoingBeforeCancel} attack · B2B ${transition.chain.b2bAfter} · combo ${transition.chain.comboAfter} · ${transition.cancelResult.outgoingAfterCancel} garbage · score ${body.comparison.score.toFixed(2)} (${body.status})`;
    setStatus(game.toppedOut ? "error" : "idle", game.toppedOut ? "TOP OUT" : "READY");
    render();
    renderAnalysisBusy();
    if (autoplay && !game.toppedOut) setTimeout(think, 220);
  } catch (error) {
    autoplay = false;
    elements["suggestion-detail"].textContent = error instanceof Error ? error.message : String(error);
    setStatus("error", "DESYNC");
  }
}

function toggleAutoplay() {
  autoplay = !autoplay;
  elements["auto-button"].setAttribute("aria-pressed", String(autoplay));
  elements["auto-button"].textContent = autoplay ? "停止" : "自動再生";
  if (autoplay && !thinking) pendingMove === null ? think() : applyPending();
}

/* Switching modes hides a panel, so whichever loop the leaving mode was running
   is paused first: nothing advances while it is off screen. Both modes keep
   their state, and the pause is the same one the AUTO buttons perform. */
function selectMode(next) {
  if (!GUI_MODES.includes(next) || next === mode) return;
  if (mode === "analysis") stopAutoplay();
  else if (mode === "match") pauseMatchAutoplay();
  mode = next;
  renderMode();
  savePreferences();
}

function renderMode() {
  for (const name of GUI_MODES) {
    const selected = name === mode;
    const tab = elements[`mode-tab-${name}`];
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    elements[`mode-panel-${name}`].hidden = !selected;
  }
  // Replay playback owns its own clock, so it is told when it leaves the screen.
  setReplayActive(mode === "replay");
}

function handleModeTabKeydown(event) {
  const index = GUI_MODES.indexOf(mode);
  let next = null;
  if (event.key === "ArrowRight") next = GUI_MODES[(index + 1) % GUI_MODES.length];
  else if (event.key === "ArrowLeft") next = GUI_MODES[(index - 1 + GUI_MODES.length) % GUI_MODES.length];
  else if (event.key === "Home") next = GUI_MODES[0];
  else if (event.key === "End") next = GUI_MODES.at(-1);
  if (next === null) return;
  event.preventDefault();
  selectMode(next);
  elements[`mode-tab-${next}`].focus();
}

function stopAutoplay() {
  autoplay = false;
  elements["auto-button"].setAttribute("aria-pressed", "false");
  elements["auto-button"].textContent = "自動再生";
}

function reset() {
  gameMetricElapsedMs = 0;
  game = createGame();
  clearAnalysisProposal();
}

// Changing proposer must not change the position being compared. It only
// invalidates the old asynchronous reply and its preview; board, queue and
// HOLD remain available for the next bot to evaluate.
function clearAnalysisProposal() {
  analysisGeneration += 1;
  thinking = false;
  candidatesLoading = false;
  clearCandidates();
  stopAutoplay();
  pendingMove = null;
  pendingVerification = null;
  pendingThinkElapsedMs = 0;
  elements["suggestion-move"].textContent = "—";
  elements["suggestion-detail"].textContent = "「考える」で探索を開始";
  elements["nodes-value"].textContent = "—";
  elements["nps-value"].textContent = "—";
  resetComparison();
  elements["apply-button"].disabled = true;
  renderAnalysisBusy();
  setStatus("idle", "READY");
  render();
}

function renderAnalysisEngineIdentity() {
  const botType = elements["analysis-bot"].value;
  const capability = botCapabilities.get(botType);
  const label = capability?.label ?? elements["analysis-bot"].selectedOptions[0]?.textContent ?? botType;
  elements["suggestion-engine-label"].textContent = `${label.toUpperCase()} SUGGESTION`;
  elements["comparison-engine-label"].textContent = `${label.toUpperCase()} · S2 VERIFIED`;
}

/* 考える and 候補 ask the same proposer about the same position, so only one of
   them is in flight at a time and both buttons report that together. */
function renderAnalysisBusy() {
  const busy = thinking || candidatesLoading;
  elements["think-button"].disabled = busy || game.toppedOut;
  elements["candidates-button"].disabled = busy || game.toppedOut;
}

function toggleCandidates() {
  const open = !elements["candidate-panel"].hidden;
  /* An open panel whose list an apply, RESET or bot change invalidated is
     reloaded rather than closed: the button always answers "the candidates for
     the position on screen", and only closes a list that is showing one. */
  if (open && candidateRows.length === 0 && !candidatesLoading) {
    loadCandidates();
    return;
  }
  if (open) {
    elements["candidate-panel"].hidden = true;
    elements["candidates-button"].setAttribute("aria-pressed", "false");
    return;
  }
  elements["candidate-panel"].hidden = false;
  elements["candidates-button"].setAttribute("aria-pressed", "true");
  loadCandidates();
}

/* One proposer request for the ranked root list, then one canonical
   verification per candidate, all against the single snapshot taken here. A
   reply that arrives after RESET or a bot change describes a position the deck
   no longer shows, so it is discarded rather than rendered. */
async function loadCandidates() {
  if (thinking || candidatesLoading || game.toppedOut) return;
  const generation = analysisGeneration;
  const engine = elements["analysis-bot"].value;
  const count = candidateCount();
  const cc2Snapshot = toCc2State(game);
  const s2Snapshot = toS2GuiState(game);
  const board = game.board;
  const currentPiece = game.queue[0] ?? null;
  candidatesLoading = true;
  candidateRows = [];
  candidateReference = null;
  elements["candidate-list"].replaceChildren();
  elements["candidate-status"].textContent = "SEARCHING";
  renderAnalysisBusy();
  try {
    const startedAt = performance.now();
    const reference = await requestSimpleAnalysis(s2Snapshot, count);
    const rows = engine === "s2-simple"
      ? simpleAnalysisCandidateRows(reference, count)
      : await requestCc2CandidateRows(engine, cc2Snapshot, s2Snapshot, count);
    if (generation !== analysisGeneration) return;
    candidateElapsedMs = Math.max(1, performance.now() - startedAt);
    candidateReference = reference;
    candidateRows = rows;
    renderCandidateList(elements["candidate-list"], rows, {
      board,
      currentPiece,
      onSelect: selectCandidate,
    });
    renderCandidateSelection();
    const verified = rows.filter((row) => row.verification !== null).length;
    // What a proposer publishes is its own decision: the deterministic upstream
    // ports answer with the single move they play, so the list reports what was
    // asked for and what actually came back rather than only the row count.
    elements["candidate-status"].textContent =
      `TOP ${count} REQUESTED · ${rows.length} RETURNED · ${verified} VERIFIED`;
  } catch (error) {
    if (generation !== analysisGeneration) return;
    elements["candidate-status"].textContent = error instanceof Error ? error.message : String(error);
  } finally {
    if (generation === analysisGeneration) {
      candidatesLoading = false;
      renderAnalysisBusy();
    }
  }
}

async function requestCc2CandidateRows(engine, cc2State, s2State, count) {
  const response = await requestSuggestion(engine, cc2State);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
  return Promise.all(body.suggestion.moves.slice(0, count)
    .map((move) => verifyCandidate(engine, s2State, move)));
}

/* Each candidate is verified on its own, so a row reports what the Simulator
   says about that placement rather than about the one the engine went on to
   play. A witness the Simulator refuses is a fact about that one candidate: the
   row stays in the list carrying the refusal, and cannot be adopted. */
async function verifyCandidate(engine, state, move) {
  try {
    const response = await fetch("/api/apply-s2", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ engine, state, move }),
    });
    const verification = await response.json();
    if (!response.ok) {
      return { move, verification: null, reason: refusalOf(verification) ?? `HTTP ${response.status}` };
    }
    if (verification.transition?.legality?.legal !== true) {
      return { move, verification: null, reason: refusalOf(verification) ?? "no legal transition" };
    }
    // The S2 selectors answer with the move they witnessed, which is the one an
    // apply has to replay.
    return { move: verification.move ?? move, verification };
  } catch (error) {
    return { move, verification: null, reason: error instanceof Error ? error.message : String(error) };
  }
}

function refusalOf(body) {
  const reasons = Array.isArray(body?.reasons) && body.reasons.length > 0 ? body.reasons.join(", ") : null;
  return reasons ?? body?.error ?? body?.transition?.legality?.reason ?? null;
}

/* Adopting a candidate replaces the proposal the deck is holding, exactly as a
   search reply does: the field previews it and 提案を適用 commits it. Nothing on
   the board changes until then. */
async function selectCandidate(index) {
  const row = candidateRows[index];
  if (row === undefined || row.verification === null || thinking) return;
  const generation = analysisGeneration;
  stopAutoplay();
  pendingMove = row.move;
  pendingVerification = row.verification;
  // The list cost one search for the whole set, so whichever candidate is
  // adopted carries that search's time into the game clock.
  pendingThinkElapsedMs = candidateElapsedMs;
  const lock = row.verification.transition.lockResult;
  const clear = clearLabel(lock.spin, lock.lines, lock.perfectClear) || "NO CLEAR";
  const attack = row.verification.transition.attackStages.outgoingBeforeCancel;
  elements["suggestion-move"].textContent = formatMove(pendingMove);
  elements["suggestion-detail"].textContent = `候補 #${index + 1} · S2: ${clear} · ${attack} attack`;
  elements["apply-button"].disabled = false;
  setStatus("ready", "SUGGESTED");
  renderField();
  renderPlacingStrip();
  renderCandidateSelection();
  await scoreAdoptedCandidate(row.verification, generation);
}

/* The comparison row describes whichever placement the deck holds, so an
   adopted candidate is re-scored against the same-position S2 reference the
   list was built from. */
async function scoreAdoptedCandidate(verification, generation) {
  if (candidateReference === null) return;
  resetComparison();
  try {
    const response = await fetch("/api/compare-simple", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseline: verification.comparison, challenger: candidateReference }),
    });
    const comparison = await response.json();
    if (generation !== analysisGeneration) return;
    if (!response.ok) throw new Error(comparison.error ?? "comparison refused");
    renderComparison(verification, comparison);
  } catch (error) {
    if (generation !== analysisGeneration) return;
    elements["s2-score"].textContent = error instanceof Error ? error.message : String(error);
  }
}

function renderCandidateSelection() {
  const selected = pendingMove === null ? -1 : candidateRows.findIndex((row) =>
    row.verification !== null && moveIdentity(row.move) === moveIdentity(pendingMove));
  markCandidateSelection(elements["candidate-list"], selected);
}

function clearCandidates() {
  candidateRows = [];
  candidateReference = null;
  candidateElapsedMs = 0;
  elements["candidate-list"].replaceChildren();
  elements["candidate-status"].textContent = "NO LIST FOR THIS POSITION";
}

/* The control only offers widths this build supports, but a stored preference
   is still untrusted input, so the requested width is bounded here as well. */
function candidateCount() {
  const value = Number(elements["candidate-count"].value);
  return Number.isSafeInteger(value) && value >= 1 && value <= CANDIDATE_COUNT_LIMIT ? value : 5;
}

async function requestSimpleAnalysis(state, n) {
  const response = await fetch("/api/simple-s2", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ state, n }),
  });
  const analysis = await response.json();
  if (!response.ok || !Array.isArray(analysis.moves) || analysis.moves.length === 0) {
    throw new Error(analysis.error ?? "S2 simple placement analysis unavailable");
  }
  return analysis;
}

function requestSuggestion(engine, cc2State) {
  return fetch("/api/suggest", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      engine,
      parameters: {
        ...defaultBotParameters(engine),
        selectionEnabled: false,
        thinkTimeEnabled: true,
        thinkMs: Number(elements["think-ms"].value),
      },
      thinkMs: Number(elements["think-ms"].value),
      state: cc2State,
    }),
  });
}

async function startMatch(options = {}) {
  if (matchStartInFlight !== null) return matchStartInFlight;
  const operation = performStartMatch(options);
  matchStartInFlight = operation;
  try {
    return await operation;
  } finally {
    if (matchStartInFlight === operation) matchStartInFlight = null;
  }
}

async function performStartMatch({ excludedRandomSeed = null } = {}) {
  matchAutoplay = false;
  matchRunning = false;
  matchSeries = null;
  matchGeneration += 1;
  cancelInputPump();
  clearInputEvents();
  inputMatchState = null;
  cancelHumanMatchBotStep();
  stopHumanPlay();
  matchClock = createMatchClock(performance.now());
  matchRoundStatus = "";
  setMatchExportMessage(null, "");
  elements["match-step"].disabled = true;
  elements["match-reset"].disabled = false;
  elements["match-status"].textContent = "STARTING";
  try {
    matchSeries = createMatchSeries({ excludedRandomSeed });
    if (matchSeries.config.ttrmCompatible) assertInputMatchConfig(matchSeries.config);
    if (!matchSeries.config.ttrmCompatible && selectedHumanSide() !== null) {
      await ensurePlacementGeometry();
    }
    setMatchSettingsDisabled(true);
    renderMatchSummary();
    matchAutoplay = true;
    await beginSeriesGame();
  } catch (error) {
    elements["match-status"].textContent = `START FAILED · ${error instanceof Error ? error.message : String(error)}`;
    matchAutoplay = false;
    matchClock = setMatchClockRunning(matchClock, false, performance.now());
    matchSeries = null;
    setMatchSettingsDisabled(false);
    renderMatchRunButton();
  }
}

/* The run button stays inert while a start request is in flight: pausing and
   resuming across it would otherwise open a second session for one game. */
async function beginSeriesGame() {
  if (matchRoundFinalization !== null) return;
  matchStarting = true;
  renderMatchRunButton();
  try {
    await startSeriesGame();
  } finally {
    matchStarting = false;
    renderMatchRunButton();
  }
}

function selectedHumanSide() {
  return BOT_SIDES.find((side) => elements[`${side}-bot`].value === "human") ?? null;
}

function inputModeSelected() {
  return elements["match-ttrm-compatible"]?.checked === true;
}

function inputModeActive() {
  return matchSeries?.config?.ttrmCompatible === true;
}

function inputHumanActive() {
  return inputModeActive() && lastMatchView?.humanSide === "left" &&
    inputMatchState !== null && inputMatchState.generation === matchGeneration;
}

/* TTRM INPUT admits only the bots that carry a reviewed input-selector
   binding, and the person can only hold the left side. */
function inputBotAdmitted(side, botType) {
  return INPUT_SUPPORTED_TYPES.has(botType) && !(side === "right" && botType === "human");
}

function assertInputMatchConfig(config) {
  if (!inputBotAdmitted("left", config.left) || !inputBotAdmitted("right", config.right)) {
    throw new Error("TTRM INPUT requires registered input bots (You is allowed on the left)");
  }
}

/* The placement geometry is the contract between what the player moves on
   screen and what the server will accept, so a match cannot start by hand until
   it has been fetched. */
async function ensurePlacementGeometry() {
  if (placementGeometry !== null) return placementGeometry;
  const response = await fetch("/api/placement-geometry");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "placement geometry unavailable");
  placementGeometry = body;
  return placementGeometry;
}

function startHumanGame(view) {
  /* The button that started the match keeps focus, and Space is both its
     activation key and the default hard drop. Handing focus back to the page
     lets the deck's own buttons stay keyboard-reachable between matches. */
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  const player = view.bots.find((bot) => bot.id === view.humanSide);
  human = {
    side: view.humanSide,
    board: player.board,
    queue: [player.current, ...player.next],
    hold: player.hold,
    active: null,
    holdUsed: false,
    pending: false,
  };
  spawnHumanPiece();
}

/* Adopts the position the server confirmed after the player's own lock. Nothing
   else can move that board: incoming garbage is only tanked by the lock itself,
   so an opponent's step never invalidates the piece being moved. */
function adoptHumanView(view) {
  if (human === null) return;
  const player = view.bots.find((bot) => bot.id === human.side);
  human.board = player.board;
  human.queue = [player.current, ...player.next];
  human.hold = player.hold;
  human.pending = false;
  human.active = null;
  if (view.outcome.complete) requestHumanRender();
  else spawnHumanPiece();
}

function spawnHumanPiece() {
  const piece = human.queue[0] ?? null;
  human.holdUsed = false;
  human.active = piece === null ? null : spawnPlacement(placementGeometry, human.board, piece, false);
  if (human.active !== null) pieceRepeat.activateDasCut(humanHandling(humanControls).dcdFrames);
  requestHumanRender();
}

function humanCanAct() {
  return human !== null && human.active !== null && !human.pending && matchRunning && matchAutoplay;
}

function humanMoveBy(dx) {
  if (!humanCanAct()) return;
  const moved = shifted(placementGeometry, human.board, human.active, dx, 0);
  if (moved === null) return;
  human.active = moved;
  requestHumanRender();
}

function humanMoveToEnd(dx) {
  if (!humanCanAct()) return;
  const moved = shiftedToEnd(placementGeometry, human.board, human.active, dx);
  if (moved === human.active) return;
  human.active = moved;
  requestHumanRender();
}

function humanSoftDropStep() {
  if (!humanCanAct()) return;
  const moved = shifted(placementGeometry, human.board, human.active, 0, -1);
  if (moved === null) return;
  human.active = moved;
  requestHumanRender();
}

function humanSoftDropToFloor() {
  if (!humanCanAct()) return;
  const landed = dropped(placementGeometry, human.board, human.active);
  if (landed === human.active) return;
  human.active = landed;
  requestHumanRender();
}

function humanRotate(amount) {
  if (!humanCanAct()) return;
  const turned = rotated(placementGeometry, human.board, human.active, amount);
  if (turned === null) return;
  human.active = turned;
  pieceRepeat.cutDas(humanHandling(humanControls).dcdFrames);
  requestHumanRender();
}

/* One swap per piece, matching the canonical placement's single HOLD flag: a
   lock either came from the queue or from HOLD, and there is no way to express
   a second swap within the same placement. */
function humanHold() {
  if (!humanCanAct() || human.holdUsed) return;
  const current = human.queue[0];
  const incoming = human.hold ?? human.queue[1] ?? null;
  if (incoming === null) return;
  const placement = spawnPlacement(placementGeometry, human.board, incoming, true);
  if (placement === null) return;
  human.queue = human.hold === null
    ? human.queue.slice(1)
    : [incoming, ...human.queue.slice(1)];
  human.hold = current;
  human.active = placement;
  human.holdUsed = true;
  pieceRepeat.cutDas(humanHandling(humanControls).dcdFrames);
  requestHumanRender();
}

/* The player's lock frame is their own reading of the shared match clock. The
   server clamps it into the window that keeps that clock monotone, so this is a
   request rather than an assertion about when the lock happened. */
function currentHumanLockFrame() {
  return Math.max(0, Math.round(readMatchClock(matchClock, performance.now()) * 60 / 1000));
}

async function humanHardDrop() {
  if (inputHumanActive()) {
    enqueueInputTap("hardDrop");
    return;
  }
  if (!humanCanAct()) return;
  const landed = dropped(placementGeometry, human.board, human.active);
  human.active = landed;
  human.pending = true;
  requestHumanRender();
  const generation = matchGeneration;
  try {
    const response = await fetch("/api/match/human-lock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        placement: lockSubmission(landed),
        lockFrame: currentHumanLockFrame(),
      }),
    });
    const body = await response.json();
    // The opponent's step can top this board out first, in which case the game
    // is already over and this lock was never going to be played.
    if (!response.ok && body.error === "match-complete") return;
    if (!response.ok) throw new Error(body.error ?? "player lock rejected");
    if (generation !== matchGeneration) return;
    if (body.outcome.complete && !matchRunning) return;
    renderMatch(body);
    adoptHumanView(body);
    if (body.outcome.complete) finishSeriesGame(body);
  } catch (error) {
    if (generation === matchGeneration) handleMatchError(error);
  }
}

/* Coalesces the repaints produced by one input task. A microtask keeps the
   update ahead of the next timer task, avoids nested-timer clamping during
   auto-shift, and still runs while animation frames are suspended in a hidden
   tab. */
function requestHumanRender() {
  if (humanRenderRequested || human === null) return;
  humanRenderRequested = true;
  queueMicrotask(() => {
    humanRenderRequested = false;
    if (human !== null) renderHumanField();
  });
}

function renderHumanField() {
  if (human === null) return;
  const overlay = new Map();
  if (human.active !== null) {
    const piece = human.active.piece;
    if (humanHandling(humanControls).ghost) {
      const landing = pieceCells(placementGeometry, dropped(placementGeometry, human.board, human.active));
      addOverlayPiece(overlay, landing, piece, true);
    }
    addOverlayPiece(overlay, pieceCells(placementGeometry, human.active), piece, false);
  }
  renderMatchField(elements[`match-${human.side}-field`], human.board, [], overlay);
  renderMini(elements[`match-${human.side}-hold`], human.hold);
  renderNextList(elements[`match-${human.side}-next`], human.queue.slice(1, 6));
}

/* Hands the field back to the server view. Until the player stops, that side is
   drawn from the live piece state, so the last confirmed position has to be
   painted once by whoever ends the game. */
function stopHumanPlay(view = null) {
  pieceRepeat.endAll();
  const side = human?.side ?? null;
  human = null;
  if (side === null || view === null) return;
  const player = view.bots.find((bot) => bot.id === side);
  if (player === undefined) return;
  renderMatchField(elements[`match-${side}-field`], player.board, player.lastPlaced);
  renderMini(elements[`match-${side}-hold`], player.hold);
  renderNextList(elements[`match-${side}-next`], player.next.slice(0, 5));
}

/* Keyboard input belongs to the player only while their own match is running.
   Settings fields remain editable, but a configured game key never falls
   through to the browser (for example, Space must not scroll the page). */
function humanInputEnabled() {
  if (inputHumanActive() && !matchAutoplay) return false;
  return (inputHumanActive() || human !== null) && mode === "match" && matchRunning &&
    !elements["bot-settings-dialog"].open;
}

function isKeyboardEditingTarget(target) {
  return target instanceof Element && target.closest("input, select, textarea, [contenteditable='true']") !== null;
}

function handleHumanKeyDown(event) {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const action = actionForCode(humanControls, event.code);
  if (action === null) return;
  // Key-binding capture and numeric/text settings keep their native input
  // behavior. Everywhere else, reserve configured keys for the game only.
  if (isKeyboardEditingTarget(event.target)) return;
  event.preventDefault();
  if (action === "Reset") {
    if (event.repeat || mode !== "match" || selectedHumanSide() === null) return;
    requestHumanMatchRestart();
    return;
  }
  if (!humanInputEnabled()) return;
  if (event.repeat) return;
  const handling = humanHandling(humanControls);
  if (inputHumanActive()) {
    handleInputAction(action);
    return;
  }
  switch (action) {
    case "MoveLeft":
    case "MoveRight": {
      const direction = action === "MoveLeft" ? -1 : 1;
      pieceRepeat.startShift(action, {
        move: () => humanMoveBy(direction),
        moveToEnd: () => humanMoveToEnd(direction),
        dasFrames: handling.dasFrames,
        arrFrames: handling.arrFrames,
        softDropPriority: handling.softDropPriority,
      });
      return;
    }
    case "SoftDrop":
      pieceRepeat.startSoftDrop(
        action,
        handling.sdf === Infinity ? humanSoftDropToFloor : humanSoftDropStep,
        handling.sdf,
      );
      return;
    case "HardDrop":
      humanHardDrop();
      return;
    case "RotateLeft":
      humanRotate(-1);
      return;
    case "RotateRight":
      humanRotate(1);
      return;
    case "Rotate180":
      humanRotate(2);
      return;
    case "Hold":
      humanHold();
      return;
    default:
  }
}

function handleHumanKeyUp(event) {
  if (!inputHumanActive() && human === null) return;
  const action = actionForCode(humanControls, event.code);
  if (inputHumanActive()) {
    handleInputAction(action, "keyup");
  } else if (action !== null) pieceRepeat.end(action);
}

function handleInputAction(action, type = "keydown") {
  const key = INPUT_ACTION_KEYS[action];
  if (key === undefined) return;
  const wallFrame = readMatchClock(matchClock, performance.now()) * 60 / 1000;
  const frame = currentInputEventFrame();
  const subframe = Math.floor(wallFrame) === frame ? wallFrame - frame : 0;
  enqueueInputEvent(frame, type, key, subframe);
  requestInputPump(0);
}

function createMatchSeries({ excludedRandomSeed = null } = {}) {
  const ttrmCompatible = inputModeSelected();
  const fairComparison = ttrmCompatible ? false : fairComparisonEnabled();
  const leftType = elements["left-bot"].value;
  const rightType = elements["right-bot"].value;
  const leftParameters = { ...(fairComparison
    ? fairComparisonBotParameters(leftType, botParameters.left[leftType])
    : botParameters.left[leftType]) };
  const rightParameters = { ...(fairComparison
    ? fairComparisonBotParameters(rightType, botParameters.right[rightType])
    : botParameters.right[rightType]) };
  return {
    config: {
      left: leftType,
      right: rightType,
      leftParameters,
      rightParameters,
      fairComparison,
      ttrmCompatible,
      seed: elements["match-random-seed"].checked
        ? randomUint32Except(excludedRandomSeed)
        : readBoundedInteger("match-seed", 0, 0xffff_ffff),
      maxTurns: elements["match-unlimited-turns"].checked
        ? null
        : readBoundedInteger("match-max-turns", 1, 10_000),
      firstTo: readBoundedInteger("match-count", 1, 100),
      preLockPreview: elements["match-pre-lock-preview"].checked,
    },
    completed: 0,
    leftWins: 0,
    rightWins: 0,
    draws: 0,
    totalTurns: 0,
    rounds: [],
    replayMeta: null,
    currentSeed: null,
  };
}

async function startSeriesGame() {
  if (matchRoundFinalization !== null || matchSeries === null || matchSeriesWinner() !== null) return;
  // Every server session owns a generation. A previous round's late `/step`
  // reply is ignored without delaying this start or sharing its in-flight gate.
  const generation = ++matchGeneration;
  const gameNumber = matchSeries.completed + 1;
  const config = matchSeries.config;
  const inputMode = config.ttrmCompatible === true;
  const seed = (config.seed + matchSeries.completed) >>> 0;
  matchSeries.currentSeed = seed;
  lastStartedMatchSeed = seed;
  elements["match-status"].textContent = `GAME ${gameNumber} · FT${config.firstTo} · STARTING · SEED ${seed}`;
  const response = await fetch(inputMode ? `${INPUT_MATCH_ENDPOINT}/start` : "/api/match/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      left: config.left,
      right: config.right,
      leftParameters: config.leftParameters,
      rightParameters: config.rightParameters,
      fairComparison: config.fairComparison,
      ...(inputMode ? { ttrmCompatible: true, humanControls: structuredClone(humanControls) } : {}),
      seed,
      maxTurns: config.maxTurns,
      firstTo: config.firstTo,
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "match start failed");
  if (generation !== matchGeneration) return;
  if (matchSeries.replayMeta === null && body.replayMeta !== null && body.replayMeta !== undefined) {
    matchSeries.replayMeta = structuredClone(body.replayMeta);
  }
  matchClock = createMatchClock(performance.now());
  lastRenderedMatchClock = "";
  lastRenderedMatchElapsedMs = 0;
  matchPlaybackDeadlineMs = performance.now();
  matchPlaybackElapsedMs = body.metricElapsedMs;
  matchComputeRatio = 1;
  matchComputeLimited = false;
  matchRunning = true;
  if (inputMode) {
    inputMatchState = {
      sessionId: body.sessionId,
      generation,
      pending: [],
      heldKeys: new Set(),
      releaseOnResume: false,
      pumpTimer: null,
      pumpDueAt: null,
      pumpCatchUpStreak: 0,
      inFlight: false,
      inFlightTarget: null,
      pumpRequested: false,
    };
    inputEventSequence = 0;
    elements["match-step"].disabled = false;
  } else {
    elements["match-step"].disabled = body.humanSide !== null;
    if (body.humanSide !== null) startHumanGame(body);
  }
  renderMatch(body);
  matchClock = setMatchClockRunning(matchClock, matchAutoplay, performance.now());
  if (!matchAutoplay) return;
  if (inputMode) {
    requestInputPump(0);
    return;
  }
  // A match against a bot alone replays as fast as its playback deadline
  // allows. A match a human is playing runs on the shared clock instead, so the
  // opponent's first lock waits for the real time that lock frame stands for.
  if (human === null) setTimeout(stepMatch, 0);
  else scheduleHumanMatchBotStep(body);
}

function scheduleHumanMatchBotStep(view) {
  cancelHumanMatchBotStep();
  if (human === null || !matchRunning || !matchAutoplay) return;
  if (!Number.isFinite(view.nextStepFrames)) return;
  // Start thinking immediately. The handler holds an early answer until its
  // scheduled frame and records a late answer at its actual completion frame.
  humanBotStepTimer = setTimeout(stepMatch, 0);
}

function cancelHumanMatchBotStep() {
  if (humanBotStepTimer === null) return;
  clearTimeout(humanBotStepTimer);
  humanBotStepTimer = null;
}

function cancelInputPump() {
  if (inputMatchState?.pumpTimer !== null && inputMatchState?.pumpTimer !== undefined) {
    clearTimeout(inputMatchState.pumpTimer);
    inputMatchState.pumpTimer = null;
  }
  if (inputMatchState !== null) {
    inputMatchState.pumpRequested = false;
    inputMatchState.pumpDueAt = null;
    inputMatchState.pumpCatchUpStreak = 0;
  }
}

function clearInputEvents({ releaseHeld = false } = {}) {
  if (inputMatchState === null) return;
  inputMatchState.pending = [];
  inputMatchState.releaseOnResume = releaseHeld;
  if (!releaseHeld) inputMatchState.heldKeys.clear();
}

function currentInputEventFrame() {
  const serverFrame = lastMatchView?.clock?.logicalFrame;
  if (!Number.isSafeInteger(serverFrame)) return 0;
  if (!matchAutoplay) return serverFrame;
  return Math.max(serverFrame, inputMatchState?.inFlightTarget ?? 0,
    Math.floor(readMatchClock(matchClock, performance.now()) * 60 / 1000));
}

function enqueueInputEvent(frame, type, key, subframe = 0) {
  if (!inputHumanActive() || !Number.isSafeInteger(frame) || frame < 0) return;
  inputMatchState.pending.push({
    sequence: ++inputEventSequence,
    frame,
    type,
    data: { key, subframe },
  });
  inputMatchState.pending.sort((left, right) => left.frame - right.frame || left.data.subframe - right.data.subframe || left.sequence - right.sequence);
}

function inputTargetFrame(manual) {
  const current = lastMatchView?.clock?.logicalFrame;
  if (!Number.isSafeInteger(current)) return null;
  if (manual) return current + 1;
  const wallFrame = Math.floor(readMatchClock(matchClock, performance.now()) * 60 / 1000);
  const dueInput = inputMatchState?.pending.some(event => event.frame <= wallFrame) === true;
  const target = Math.min(current + 120, Math.max(current, wallFrame + (dueInput ? 1 : 0)));
  return target > current ? target : null;
}

function inputEventsBefore(target) {
  return (inputMatchState?.pending ?? []).filter((event) => event.frame < target);
}

function requestInputPump(delayMs = INPUT_PUMP_INTERVAL_MS) {
  if (!inputModeActive() || !matchRunning || !matchAutoplay || inputMatchState === null) return;
  if (inputMatchState.inFlight) {
    inputMatchState.pumpRequested = true;
    return;
  }
  const nowMs = performance.now();
  const dueAtMs = nowMs + Math.max(0, delayMs);
  const existingDueAtMs = Number.isFinite(inputMatchState.pumpDueAt) ? inputMatchState.pumpDueAt : null;
  const decision = selectPumpReservation({ nowMs, dueAtMs, existingDueAtMs });
  if (decision.action === "keep") return;
  if (inputMatchState.pumpTimer !== null) {
    clearTimeout(inputMatchState.pumpTimer);
    inputMatchState.pumpTimer = null;
  }
  inputMatchState.pumpDueAt = decision.dueAtMs;
  inputMatchState.pumpTimer = setTimeout(() => {
    inputMatchState.pumpTimer = null;
    inputMatchState.pumpDueAt = null;
    void stepInputMatch();
  }, Math.max(0, decision.dueAtMs - performance.now()));
}

function scheduleIdleInputPump() {
  if (!inputModeActive() || !matchRunning || !matchAutoplay || inputMatchState === null) return;
  if (inputMatchState.inFlight) {
    inputMatchState.pumpRequested = true;
    return;
  }
  const nowMs = performance.now();
  const elapsedMs = readMatchClock(matchClock, nowMs);
  const serverFrame = lastMatchView?.clock?.logicalFrame;
  if (!Number.isSafeInteger(serverFrame)) {
    requestInputPump(INPUT_PUMP_INTERVAL_MS);
    return;
  }
  const idle = nextIdlePumpDueAt({
    nowMs,
    elapsedMs,
    serverFrame,
    earliestPendingFrame: earliestPendingInputFrame(inputMatchState.pending),
    catchUpStreak: inputMatchState.pumpCatchUpStreak ?? 0,
  });
  inputMatchState.pumpCatchUpStreak = idle.catchUpStreak;
  requestInputPump(Math.max(0, idle.dueAtMs - nowMs));
}

async function stepInputMatch({ manual = false } = {}) {
  const state = inputMatchState;
  const generation = matchGeneration;
  if (!inputModeActive() || !matchRunning || state === null || state.generation !== generation) return;
  if (!matchAutoplay && !manual) return;
  if (state.inFlight) {
    state.pumpRequested = true;
    return;
  }
  const target = inputTargetFrame(manual);
  if (target === null) { scheduleIdleInputPump(); return; }
  queueInputReleases(state, lastMatchView.clock.logicalFrame);
  const sent = inputEventsBefore(target);
  const sentSequences = new Set(sent.map((event) => event.sequence));
  state.inFlight = true;
  state.inFlightTarget = target;
  state.pumpRequested = false;
  elements["match-step"].disabled = true;
  try {
    const response = await fetch(`${INPUT_MATCH_ENDPOINT}/step`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: state.sessionId,
        frame: target,
        inputs: sent.map(({ sequence: _sequence, ...event }) => event),
      }),
    });
    const body = await response.json();
    if (generation !== matchGeneration || inputMatchState !== state) return;
    if (!response.ok) throw new Error(body.error ?? "input match step failed");
    state.pending = state.pending.filter((event) => !sentSequences.has(event.sequence));
    recordAcceptedInputEvents(state, sent, body);
    renderMatch(body);
    if (manual) {
      matchClock = synchronizeMatchClock(matchClock, body.metricElapsedMs, performance.now());
      matchClock = setMatchClockRunning(matchClock, matchAutoplay, performance.now());
    }
    if (body.outcome?.complete) finishSeriesGame(body);
  } catch (error) {
    if (generation === matchGeneration && inputMatchState === state) handleMatchError(error);
  } finally {
    if (inputMatchState !== state) return;
    state.inFlight = false;
    state.inFlightTarget = null;
    if (generation !== matchGeneration) return;
    elements["match-step"].disabled = !matchRunning || matchAutoplay;
    state.pumpRequested = false;
    scheduleIdleInputPump();
  }
}

function recordAcceptedInputEvents(state, sent, body) {
  for (const event of sent) {
    if (event.type === "keydown") state.heldKeys.add(event.data.key);
    else state.heldKeys.delete(event.data.key);
  }
  queueInputReleases(state, body.clock?.logicalFrame);
}

function queueInputReleases(state, frame) {
  if (!state.releaseOnResume) return;
  if (!Number.isSafeInteger(frame)) return;
  state.releaseOnResume = false;
  for (const key of state.heldKeys) {
    enqueueInputEvent(frame, "keyup", key);
  }
}

async function stepMatch() {
  if (inputModeActive()) {
    return stepInputMatch({ manual: !matchAutoplay });
  }
  const generation = matchGeneration;
  if (!matchRunning || matchStepGeneration === generation) return;
  matchStepGeneration = generation;
  matchClock = setMatchClockRunning(matchClock, true, performance.now());
  elements["match-step"].disabled = true;
  // Once a bot-only match is known to be compute-limited, keep the measured
  // ratio visible while the next proposal is in flight. Otherwise the zero
  // delay retry replaces the warning with THINKING before it can be read.
  if (human === null && !matchComputeLimited) elements["match-status"].textContent = "THINKING";
  const stepStartedAtMs = performance.now();
  const previousMetricElapsedMs = matchPlaybackElapsedMs;
  try {
    const nowMs = performance.now();
    const lockFrame = human === null ? null : Math.floor(readMatchClock(matchClock, nowMs) * 60 / 1000);
    const response = await fetch("/api/match/step", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(lockFrame === null ? {} : { lockFrame }),
    });
    const body = await response.json();
    /* The player's own lock can finish the game while this step is on its way
       out. Whoever received that lock has already reported the result, so the
       step simply has nothing left to do. */
    if (!response.ok && body.error === "match-complete") return;
    if (!response.ok) throw new Error(body.error ?? "match step failed");
    /* RESET while this step was in flight: the reply belongs to a session the
       page no longer shows, so it must not repaint the cleared arena. */
    if (generation !== matchGeneration) return;
    if (body.outcome.complete && !matchRunning) return;
    if (human === null && Number.isFinite(body.metricElapsedMs)) {
      const wallMs = Math.max(0.001, performance.now() - stepStartedAtMs);
      const gameMs = Math.max(0, body.metricElapsedMs - previousMetricElapsedMs);
      matchComputeRatio = gameMs / wallMs;
      matchComputeLimited = gameMs + 16 < wallMs;
    } else {
      matchComputeRatio = 1;
      matchComputeLimited = false;
    }
    advanceCurrentMatchPlaybackDeadline(body);
    if (!await presentMatchCommit(body, generation)) return;
    if (body.outcome.complete) finishSeriesGame(body);
    else if (human !== null && matchAutoplay && matchRunning) scheduleHumanMatchBotStep(body);
  } catch (error) {
    if (generation === matchGeneration) handleMatchError(error);
  } finally {
    if (matchStepGeneration === generation) matchStepGeneration = null;
    if (generation === matchGeneration) {
      if (!matchAutoplay) matchClock = setMatchClockRunning(matchClock, false, performance.now());
      elements["match-step"].disabled = !matchRunning || human !== null;
      if (matchAutoplay && matchRunning && human === null) {
        setTimeout(stepMatch, currentMatchPlaybackDelay());
      }
    }
  }
}

async function finishSeriesGame(view) {
  // A player lock can finish the game while the opponent's scheduled proposal
  // is in flight. Both replies carry the same completed view, but only the
  // first one may count the game and begin or conclude the series.
  if (!matchRunning || matchRoundFinalization !== null) return;
  matchClock = setMatchClockRunning(matchClock, false, performance.now());
  matchRunning = false;
  cancelHumanMatchBotStep();
  if (inputModeActive()) {
    cancelInputPump();
    clearInputEvents();
  }
  stopHumanPlay(view);
  if (view.outcome.proposalResult?.status === "failure" ||
      view.outcome.reason === "proposal-failure") {
    matchAutoplay = false;
    setMatchSettingsDisabled(false);
    const code = view.outcome.proposalResult?.failure?.code ?? "proposal-failure";
    elements["match-status"].textContent = `SERIES STOPPED · ${code}`;
    renderMatchRunButton();
    renderMatchSaveButton();
    return;
  }
  if (matchSeries === null) return;
  const generation = matchGeneration;
  elements["match-status"].textContent = "SAVING ROUND";
  matchRoundFinalization = finalizeCurrentRound().then((round) => {
    if (round === null || generation !== matchGeneration || matchSeries === null) return;
    matchSeries.rounds.push({ ...round, index: matchSeries.rounds.length });
    matchSeries.completed += 1;
    matchSeries.totalTurns += view.turnNumber;
    if (view.outcome.winnerBotId === "left") matchSeries.leftWins += 1;
    else if (view.outcome.winnerBotId === "right") matchSeries.rightWins += 1;
    else matchSeries.draws += 1;
    const result = view.outcome.winnerBotId === null
      ? `DRAW (${view.outcome.reason})`
      : `${view.outcome.winnerBotId.toUpperCase()} WINS`;
    elements["match-status"].textContent = `GAME ${matchSeries.completed} · ${result} · TURN ${view.turnNumber}`;
    renderMatchSummary();
    if (matchSeriesWinner() !== null) {
      matchAutoplay = false;
      setMatchSettingsDisabled(false);
      renderMatchRunButton();
      return;
    }
    renderMatchRunButton();
    if (matchAutoplay) setTimeout(
      () => { if (matchAutoplay) beginSeriesGame().catch(handleMatchError); },
      0,
    );
  }).catch((error) => {
    if (generation === matchGeneration) handleMatchError(error);
  }).finally(() => {
    if (generation === matchGeneration) {
      matchRoundFinalization = null;
      renderMatchRunButton();
      renderMatchSaveButton();
    }
  });
  renderMatchRunButton();
  renderMatchSaveButton();
}

async function finalizeCurrentRound() {
  const input = inputModeActive();
  const sessionId = inputMatchState?.sessionId ?? lastMatchView?.sessionId ?? null;
  const path = input
    ? `${INPUT_MATCH_ENDPOINT}/round?sessionId=${encodeURIComponent(sessionId ?? "")}`
    : "/api/match/round";
  const response = await fetch(path);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "match round export failed");
  return body;
}

function advanceCurrentMatchPlaybackDeadline(view) {
  const config = matchSeries?.config;
  if (config === undefined || !Number.isFinite(view.metricElapsedMs)) return;
  matchPlaybackDeadlineMs = advanceMatchPlaybackDeadline({
    deadlineMs: matchPlaybackDeadlineMs,
    previousElapsedMs: matchPlaybackElapsedMs,
    elapsedMs: view.metricElapsedMs,
  });
  matchPlaybackElapsedMs = view.metricElapsedMs;
}

function currentMatchPlaybackDelay() {
  return matchSeries === null
    ? 100
    : Math.max(0, matchPlaybackDeadlineMs - performance.now());
}

/* The server has already committed this lock. This is presentation only: it
   paints the verified pre-lock board for a slice of the existing cadence, then
   restores the committed view without delaying the next scheduled request. */
async function presentMatchCommit(view, generation) {
  const durationMs = preLockPreviewDuration(view);
  if (durationMs <= 0) {
    renderMatch(view);
    return true;
  }
  renderMatchPreLockPreview(view);
  await new Promise((resolve) => setTimeout(resolve, durationMs));
  if (generation !== matchGeneration) return false;
  renderMatch(view);
  return true;
}

function preLockPreviewDuration(view) {
  const config = matchSeries?.config;
  const previewed = view.bots.filter((bot) => bot.preLockPreview !== null);
  if (human !== null) return 0;
  if (config?.preLockPreview !== true || previewed.length === 0) return 0;
  const fastestPps = Math.max(...previewed.map((bot) => config[`${bot.id}Parameters`].pps));
  const cadenceMs = 1000 / fastestPps;
  const desiredMs = Math.round(Math.max(80, Math.min(300, cadenceMs * 0.22)));
  // Consume only time already reserved for the next visual lock, so preview ON
  // and OFF retain the same game clock and request cadence.
  return Math.min(desiredMs, currentMatchPlaybackDelay());
}

function renderMatchPreLockPreview(view) {
  for (const bot of view.bots) {
    const preview = bot.preLockPreview;
    if (preview === null) continue;
    const move = canonicalPlacementToGuiMove(preview.placement);
    const overlay = new Map();
    addOverlayPiece(overlay, placementCells(move), move.location.type, true);
    renderMatchField(elements[`match-${bot.id}-field`], preview.board, [], overlay);
  }
}

function handleMatchError(error) {
  const completedInputSeries = inputModeActive() && (matchSeries?.rounds?.length ?? 0) > 0 ? matchSeries : null;
  const failedInputSession = inputMatchState?.sessionId;
  matchClock = setMatchClockRunning(matchClock, false, performance.now());
  matchAutoplay = false;
  matchRunning = false;
  matchStarting = false;
  matchSeries = completedInputSeries;
  if (matchSeries) matchSeries.failed = true;
  cancelHumanMatchBotStep();
  cancelInputPump();
  clearInputEvents();
  inputMatchState = null;
  if (failedInputSession) void fetch(`${INPUT_MATCH_ENDPOINT}/close`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: failedInputSession }),
  }).catch(() => {});
  stopHumanPlay(lastMatchView);
  elements["match-step"].disabled = true;
  elements["match-status"].textContent = error instanceof Error ? error.message : String(error);
  setMatchSettingsDisabled(false);
  renderMatchRunButton();
  renderMatchSaveButton();
}

/* Clears the arena and explicitly releases any retained bot runtime. In 1P,
   restartCurrentGame preserves the series so only its unfinished game is
   abandoned; RND may replace that game's seed before it is opened again. */
async function resetMatch({ restartCurrentGame = false, rerollRandomSeed = false } = {}) {
  if (matchRoundFinalization !== null) {
    elements["match-status"].textContent = "WAITING FOR ROUND SAVE";
    try {
      await matchRoundFinalization;
    } catch {
      return;
    }
  }
  const preservedSeries = restartCurrentGame ? matchSeries : null;
  if (rerollRandomSeed && preservedSeries !== null && elements["match-random-seed"].checked) {
    const previousSeed = preservedSeries.currentSeed ??
      ((preservedSeries.config.seed + preservedSeries.completed) >>> 0);
    const nextSeed = randomUint32Except(previousSeed);
    preservedSeries.config.seed = (nextSeed - preservedSeries.completed) >>> 0;
    if (preservedSeries.replayMeta?.match !== undefined) {
      preservedSeries.replayMeta.match.seed = preservedSeries.config.seed;
    }
  }
  pauseMatchAutoplay();
  const inputSessionId = inputMatchState?.sessionId ?? lastMatchView?.sessionId ?? null;
  matchRunning = false;
  matchStarting = restartCurrentGame;
  matchSeries = preservedSeries;
  matchRoundStatus = "";
  matchGeneration += 1;
  cancelHumanMatchBotStep();
  cancelInputPump();
  clearInputEvents();
  inputMatchState = null;
  stopHumanPlay();
  try {
    if (inputSessionId === null) {
      await fetch("/api/match/close", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
    } else {
      await fetch(`${INPUT_MATCH_ENDPOINT}/close`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionId: inputSessionId }),
      });
    }
  } catch {
    // RESET remains local even if an already-failed transport cannot close.
  }
  cancelMatchPaint();
  lastMatchView = null;
  matchClock = createMatchClock(performance.now());
  lastRenderedMatchClock = "";
  lastRenderedMatchElapsedMs = 0;
  matchPlaybackDeadlineMs = 0;
  matchPlaybackElapsedMs = 0;
  matchComputeRatio = 1;
  matchComputeLimited = false;
  paintMatchClock(performance.now());
  clearMatchArena();
  renderMatchSummary();
  renderMatchSaveButton();
  setMatchExportMessage(null, "");
  elements["match-status"].textContent = restartCurrentGame ? "RESTARTING" : "NOT STARTED";
  elements["match-step"].disabled = true;
  elements["match-reset"].disabled = !restartCurrentGame;
  setMatchSettingsDisabled(restartCurrentGame);
  renderMatchRunButton();
  if (restartCurrentGame && matchSeries === preservedSeries && preservedSeries !== null) {
    matchAutoplay = true;
    matchStarting = false;
    await beginSeriesGame();
  }
}

/* The configured 1P Reset key always starts play. During an active series it
   abandons only the unfinished game and retains completed scores; after the
   series ends it opens a fresh series. A random-seed restart rerolls the
   current game, while a manual seed keeps its deterministic queue. */
function requestHumanMatchRestart() {
  if (humanMatchRestartInFlight !== null) return;
  const operation = activateHumanMatchReset();
  humanMatchRestartInFlight = operation;
  operation.catch(handleMatchError).finally(() => {
    if (humanMatchRestartInFlight === operation) humanMatchRestartInFlight = null;
  });
}

async function activateHumanMatchReset() {
  if (matchStartInFlight !== null) await matchStartInFlight;
  if (matchRoundFinalization !== null) await matchRoundFinalization;
  if (!matchSeriesActive()) {
    const previousSeed = matchSeries?.currentSeed ?? lastStartedMatchSeed;
    await startMatch({
      excludedRandomSeed: elements["match-random-seed"].checked ? previousSeed : null,
    });
    return;
  }
  await resetMatch({ restartCurrentGame: true, rerollRandomSeed: true });
}

function clearMatchArena() {
  for (const side of BOT_SIDES) {
    elements[`match-${side}-name`].textContent = side.toUpperCase();
    elements[`match-${side}-stats`].textContent = "0 ATK · 0 LINES";
    elements[`match-${side}-score`].textContent = "—";
    renderClearInfo(`match-${side}`, 0, 0, "");
    renderGarbageGauge(elements[`match-${side}-gauge`], [], `${side} bot`);
    for (const id of ["field", "hold", "next", "metrics", "rate-left", "rate-right"]) {
      elements[`match-${side}-${id}`].replaceChildren();
    }
  }
  renderEmptyMatchFields();
}

function pauseMatchAutoplay() {
  if (!matchAutoplay) return;
  matchAutoplay = false;
  cancelHumanMatchBotStep();
  if (inputModeActive()) {
    cancelInputPump();
    clearInputEvents({ releaseHeld: true });
  }
  pieceRepeat.endAll();
  matchClock = setMatchClockRunning(matchClock, false, performance.now());
  renderMatchRunButton();
}

/* A series is over once either side reaches the configured FT score: the run
   button then goes back to offering a fresh START MATCH rather than a resume. */
function matchSeriesActive() {
  return matchSeries !== null && !matchSeries.failed && matchSeriesWinner() === null;
}

/* One button covers the whole match lifecycle: start, pause, resume. An
   in-flight step is left to finish; it simply does not schedule a successor. */
function toggleMatchRun() {
  if (matchStarting || matchRoundFinalization !== null) return;
  if (!matchSeriesActive()) {
    startMatch();
    return;
  }
  if (matchAutoplay) {
    pauseMatchAutoplay();
    renderMatchStatus();
    return;
  }
  matchAutoplay = true;
  matchPlaybackDeadlineMs = performance.now();
  matchClock = setMatchClockRunning(matchClock, true, performance.now());
  renderMatchRunButton();
  if (!matchRunning) {
    beginSeriesGame().catch(handleMatchError);
    return;
  }
  if (inputModeActive()) {
    requestInputPump(0);
    return;
  }
  if (human === null) stepMatch();
  else scheduleHumanMatchBotStep(lastMatchView);
}

/* The round line survives a pause: a trailing step still lands after the press,
   so PAUSED is a suffix on it rather than a message that step would overwrite. */
function renderMatchStatus() {
  const paused = matchSeriesActive() && !matchAutoplay && !matchStarting;
  const parts = [matchRoundStatus, paused ? "PAUSED" : ""].filter((part) => part !== "");
  elements["match-status"].textContent = parts.join(" · ");
}

function renderMatchRunButton() {
  const button = elements["match-run"];
  const active = matchSeriesActive();
  const state = !active ? "start" : matchAutoplay ? "running" : "paused";
  button.dataset.state = state;
  button.textContent = { start: "START MATCH", running: "PAUSE", paused: "RESUME" }[state];
  button.setAttribute("aria-pressed", String(state === "running"));
  button.disabled = matchStarting || matchRoundFinalization !== null;
}

function renderMatchSummary() {
  if (matchSeries === null) {
    elements["match-summary"].textContent = "NO SERIES RESULTS";
    renderMatchSaveButton();
    return;
  }
  const average = matchSeries.completed === 0 ? 0 : matchSeries.totalTurns / matchSeries.completed;
  elements["match-summary"].textContent = `FT${matchSeries.config.firstTo} · PLAYED ${matchSeries.completed} · LEFT ${matchSeries.leftWins} · RIGHT ${matchSeries.rightWins} · DRAW ${matchSeries.draws} · AVG ${average.toFixed(1)} TURNS`;
  renderMatchSaveButton();
}

/* The format is decided by the execution path the rounds were played on, not by
   the person saving them, so one button carries it. A started series answers for
   its own rounds even after the toggle moves again; before that the toggle is
   the only claim there is. */
function selectedExportFormat() {
  if (matchSeries !== null) return inputModeActive() ? "ttrm" : "json";
  return inputModeSelected() ? "ttrm" : "json";
}

function saveMatchExport() {
  return selectedExportFormat() === "ttrm" ? saveMatchTtrm() : saveMatchReplay();
}

/* The export spends most of its life disabled, and the reason is not visible on
   the button itself, so it rides along as a title rather than leaving a dead
   control unexplained. */
function renderMatchSaveButton() {
  const button = elements["match-save-replay"];
  const format = selectedExportFormat();
  button.dataset.format = format;
  button.textContent = format === "ttrm" ? "SAVE .ttrm" : "SAVE .json";
  const busy = matchSaveInFlight ? "保存中です"
    : matchRoundFinalization !== null ? "対局の記録をまとめています"
    : "";
  if (format === "ttrm") {
    const ready = (matchSeries?.rounds ?? []).some((round) => round.executedTtrm?.text);
    setMatchExportButton(button,
      busy !== "" ? busy
        : !ready ? "保存できる完了ラウンドがまだありません。TTRM INPUT はround終了後に保存できます"
        : "",
      "実際に消費した入力を検証済みの .ttrm として保存します");
    return;
  }
  const hasCurrent = matchRunning && (lastMatchView?.turnNumber ?? 0) > 0;
  const hasCompleted = (matchSeries?.rounds?.length ?? 0) > 0;
  setMatchExportButton(button,
    busy !== "" ? busy
      : !(hasCurrent || hasCompleted) ? "まだ保存できる手がありません。START MATCH で対局を進めてください"
      : "",
    "この対局の記録を .json ファイルで保存します");
}

function setMatchExportButton(button, blockedReason, enabledTitle) {
  button.disabled = blockedReason !== "";
  button.title = blockedReason !== "" ? blockedReason : enabledTitle;
}

/* Export results report next to the export buttons, not in match-status: that
   line carries the round state and renderMatchStatus overwrites it on the next
   step, which would silently erase the record of a save. */
function setMatchExportMessage(state, text) {
  const message = elements["match-export-message"];
  message.textContent = text;
  message.hidden = text === "";
  if (state === null) delete message.dataset.state;
  else message.dataset.state = state;
}

async function saveMatchReplay() {
  if (matchSaveInFlight || matchSeries === null) return;
  matchSaveInFlight = true;
  setMatchExportMessage(null, "EXPORTING .json …");
  renderMatchSaveButton();
  try {
    if (matchRoundFinalization !== null) await matchRoundFinalization;
    if (matchSeries === null) { setMatchExportMessage(null, ""); return; }
    const rounds = [...matchSeries.rounds];
    if (!inputModeActive() && matchRunning && (lastMatchView?.turnNumber ?? 0) > 0) {
      rounds.push({ ...(await finalizeCurrentRound()), index: rounds.length });
    }
    if (rounds.length === 0) { setMatchExportMessage(null, ""); return; }
    const meta = {
      gamemode: "s2-bot-match",
      ...(structuredClone(matchSeries.replayMeta ?? {})),
      origin: "s2-bot-match/1",
      version: 1,
      parseMs: 0,
    };
    const text = JSON.stringify({ $schema: MATCH_REPLAY_SCHEMA, meta, rounds }, null, 2);
    const seed = meta.match?.seed ?? matchSeries.config.seed;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const name = `s2-match-${seed}-${stamp}.json`;
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setMatchExportMessage("saved", `SAVED ${name} · ${rounds.length} ROUND(S)`);
  } catch (error) {
    // The export line is left holding "EXPORTING …" otherwise: handleMatchError
    // reports on the round status, which is not where the save was announced.
    setMatchExportMessage("failed", `EXPORT FAILED · ${error.message}`);
    handleMatchError(error);
  } finally {
    matchSaveInFlight = false;
    renderMatchSaveButton();
  }
}

function renderEmptyMatchFields() {
  for (const side of BOT_SIDES) {
    const field = elements[`match-${side}-field`];
    field.classList.toggle("input-spawn-field", inputModeSelected());
    const board = Array.from({ length: 40 }, () => Array(10).fill(null));
    renderMatchField(field, board, [], null, { rows: inputModeSelected() ? 23 : 20 });
  }
}

async function saveMatchTtrm() {
  if (matchSaveInFlight || matchSeries === null || !inputModeActive()) return;
  matchSaveInFlight = true;
  setMatchExportMessage(null, "EXPORTING .ttrm …");
  renderMatchSaveButton();
  try {
    if (matchRoundFinalization !== null) await matchRoundFinalization;
    if (matchSeries === null) return;
    const records = matchSeries.rounds
      .map((round) => round.executedTtrm)
      .filter((record) => record?.text);
    if (records.length === 0) throw new Error("a completed input round is required before saving .ttrm");
    const file = aggregateInputTtrm(records);
    const text = JSON.stringify(file, null, 2);
    const seed = matchSeries.replayMeta?.match?.seed ?? matchSeries.config.seed;
    const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
    const name = `s2-input-match-${seed}-${stamp}.ttrm`;
    const blob = new Blob([text], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    setMatchExportMessage("saved", `SAVED ${name} · ${records.length} ROUND(S)`);
  } catch (error) {
    // The export line is left holding "EXPORTING …" otherwise: handleMatchError
    // reports on the round status, which is not where the save was announced.
    setMatchExportMessage("failed", `EXPORT FAILED · ${error.message}`);
    handleMatchError(error);
  } finally {
    matchSaveInFlight = false;
    renderMatchSaveButton();
  }
}

function aggregateInputTtrm(records) {
  const files = records.map((record) => JSON.parse(record.text));
  const first = files[0];
  const users = new Map();
  const rounds = [];
  const provenance = [];
  for (const [index, file] of files.entries()) {
    for (const user of file.users ?? []) if (!users.has(user.id)) users.set(user.id, structuredClone(user));
    rounds.push(...(file.replay?.rounds ?? []).map((round) => structuredClone(round)));
    provenance.push(structuredClone(records[index].provenance ?? null));
  }
  const firstProvenance = provenance.find((value) => value !== null) ?? {};
  // The native TETR.IO match viewer reads this before it opens any round.
  const leaderboard = [...users.values()].map(({ id, username }, naturalorder) => {
    const played = rounds.flatMap(round => round.filter(player => player.id === id));
    const lifetime = played.reduce((sum, player) => sum + player.lifetime, 0);
    const stats = Object.fromEntries(['apm', 'pps', 'vsscore'].map(key => [key,
      lifetime === 0 ? 0 : played.reduce((sum, player) => sum + player.stats[key] * player.lifetime, 0) / lifetime,
    ]));
    return { id, username, active: true, naturalorder,
      wins: played.filter(player => player.active && player.alive).length, stats };
  });
  return {
    version: first.version,
    gamemode: first.gamemode ?? "league",
    users: [...users.values()],
    replay: { leaderboard, rounds },
    meta: {
      origin: firstProvenance.origin ?? "s2-bot-lab-generated",
      executionProfile: firstProvenance.profile ?? INPUT_EXECUTION_PROFILE,
      verification: firstProvenance.verification ?? null,
      releaseEvidence: firstProvenance.releaseEvidence === true,
      provenance,
    },
  };
}

function matchSeriesWinner() {
  if (matchSeries === null) return null;
  const { firstTo } = matchSeries.config;
  if (matchSeries.leftWins >= firstTo) return "left";
  if (matchSeries.rightWins >= firstTo) return "right";
  return null;
}

function setMatchSettingsDisabled(disabled) {
  for (const id of [
    "left-bot", "right-bot", "left-bot-settings", "right-bot-settings",
    "match-fair-comparison", "match-pre-lock-preview", "match-ttrm-compatible", "match-seed", "match-max-turns", "match-unlimited-turns", "match-count",
  ]) elements[id].disabled = disabled;
  elements["match-max-turns"].disabled = disabled || elements["match-unlimited-turns"].checked;
  syncRandomSeedControl(disabled);
  syncHumanMatchControls(disabled);
}

/* FAIR COMPARISON has no meaning once a person is playing one of the sides:
   it removes CPU contention between two timed searches by fixing both sides at
   1 PPS. Pin it off rather than silently ignoring it. */
function syncHumanMatchControls(matchSettingsDisabled = false) {
  const playing = selectedHumanSide() !== null;
  const inputMode = inputModeSelected() || (matchRunning && inputModeActive());
  if (playing || inputMode) {
    elements["match-fair-comparison"].checked = false;
  }
  elements["match-fair-comparison"].disabled = matchSettingsDisabled || playing || inputMode;
  elements["match-pre-lock-preview"].disabled = matchSettingsDisabled || inputMode;
  elements["match-pre-lock-preview"].title = inputMode ? "TTRM INPUTでは実ミノとゴーストを表示するため、PRE-LOCK PREVIEWは使いません" : "";
  elements["match-step"].title = inputMode
    ? "TTRM INPUT は固定の実入力プロファイルで1フレームずつ進みます"
    : playing
      ? "1P対戦では自分のハードドロップが手番を進めます"
      : "";
  syncInputBotOptions();
  renderExecutionScopeNotes();
}

/* A bot the selected execution path cannot run is greyed on the picker instead
   of staying selectable and being refused at START. The roster keeps its shape
   on both paths, so turning TTRM INPUT off brings the same names back, and a
   bot this build does not have at all stays unavailable either way. */
function syncInputBotOptions() {
  const inputMode = inputModeSelected() || (matchRunning && inputModeActive());
  for (const side of BOT_SIDES) {
    for (const option of elements[`${side}-bot`].options) {
      const unavailable = option.dataset.unavailable === "true";
      const inadmissible = inputMode && !inputBotAdmitted(side, option.value);
      option.disabled = unavailable || inadmissible;
      option.title = inadmissible && !unavailable
        ? "TTRM INPUT では使えません（実入力の対応Botではありません）"
        : option.dataset.reason ?? "";
    }
  }
}

/* Which execution path a setting belongs to used to be visible only as a greyed
   control, which reads as "not available yet" rather than "not part of this
   path". Each scoped group now states its path in words, and the legacy group
   keeps saying so while it is active rather than only once it is inert.

   The whole row ships closed behind one disclosure, so its bar also carries the
   values it is hiding: a folded row must not take its state with it, and the
   execution path is the one setting that decides what the export writes. */
function renderExecutionScopeNotes() {
  const inputMode = inputModeSelected() || (matchRunning && inputModeActive());
  const playing = selectedHumanSide() !== null;
  elements["match-execution-note"].textContent = inputMode
    ? "TTRM INPUT：実入力を60Hzで消費し、EXPORT は .ttrm を保存します。"
    : "従来モード：最終配置で進行し、EXPORT は .json を保存します。";
  elements["match-legacy-settings"].dataset.inactive = String(inputMode);
  elements["match-legacy-note"].textContent = inputMode
    ? "TTRM INPUT 中は使いません（実ミノとゴーストを表示し、FAIR COMPARISON も適用しません）。"
    : playing
      ? "You (1P) 参加中は FAIR COMPARISON を使いません。"
      : "TTRM INPUT では適用されません。";
  elements["match-settings-state"].textContent = matchSettingsStateText(inputMode);
}

/* The execution path leads because it decides what the export writes. The two
   legacy switches are named only while that path is the one being run: under
   TTRM INPUT they are not off, they are not part of the match at all, and
   printing "FAIR OFF" for them on the closed bar would claim otherwise. */
function matchSettingsStateText(inputMode) {
  const parts = [
    inputMode ? "TTRM INPUT · .ttrm" : "従来モード · .json",
    `SEED ${elements["match-random-seed"].checked ? "RND" : elements["match-seed"].value}`,
    `MAX ${elements["match-unlimited-turns"].checked ? "∞" : elements["match-max-turns"].value}`,
    `FT${elements["match-count"].value}`,
  ];
  if (inputMode) return parts.join(" · ");
  return [...parts, `FAIR ${onOff(elements["match-fair-comparison"])}`, `GHOST ${onOff(elements["match-pre-lock-preview"])}`].join(" · ");
}

function onOff(checkbox) {
  return checkbox.checked ? "ON" : "OFF";
}

function syncMaxTurnsControl() {
  elements["match-max-turns"].disabled = elements["match-unlimited-turns"].checked;
}

function syncRandomSeedControl(matchSettingsDisabled = false) {
  const random = elements["match-random-seed"].checked;
  elements["match-seed"].disabled = matchSettingsDisabled || random;
}

function fairComparisonEnabled() {
  return elements["match-fair-comparison"].checked;
}

function ppsIsOverridden() {
  return fairComparisonEnabled();
}

function effectivePps(parameters) {
  if (fairComparisonEnabled()) return 1;
  return parameters.pps;
}

function syncFairComparisonControls() {
  const ppsInput = elements["bot-settings-form"].elements.namedItem("pps");
  const ppsEnabled = elements["bot-settings-form"].elements.namedItem("ppsEnabled");
  if (ppsInput !== null) {
    ppsInput.disabled = ppsIsOverridden() || (ppsEnabled instanceof HTMLInputElement && !ppsEnabled.checked);
    if (fairComparisonEnabled()) ppsInput.value = 1;
  }
  for (const side of BOT_SIDES) renderBotSettingsSummary(side);
}

function botLabelFor(botType) {
  return botCapabilities.get(botType)?.label ?? botType;
}

function readBoundedInteger(id, minimum, maximum) {
  const value = Number(elements[id].value);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${id} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function randomUint32() {
  const values = new Uint32Array(1);
  if (globalThis.crypto?.getRandomValues) return globalThis.crypto.getRandomValues(values)[0];
  return Math.floor(Math.random() * 0x1_0000_0000) >>> 0;
}

function randomUint32Except(excluded) {
  const value = randomUint32();
  return Number.isSafeInteger(excluded) && value === excluded ? (value + 1) >>> 0 : value;
}

function acceptMatchView(view) {
  lastMatchView = view;
  /* A match a human is playing keeps one free-running clock from the moment it
     started: that clock is what their own lock frames are read from, so it must
     not be pulled back to the last confirmed lock or held at the opponent's
     next one. Bot-only matches stay on the step-by-step projection. */
  if (!(inputModeActive() || human !== null) && Number.isFinite(view.metricElapsedMs)) {
    const nextElapsedMs = Number.isFinite(view.nextStepFrames) && view.nextStepFrames > 0
      ? view.metricElapsedMs + view.nextStepFrames * 1000 / 60
      : view.metricElapsedMs;
    matchClock = synchronizeMatchClock(
      matchClock,
      view.metricElapsedMs,
      performance.now(),
      nextElapsedMs,
    );
  }
  matchRoundStatus = `ROUND ${view.turnNumber} · ${view.clock.logicalFrame}f${matchComputeLimited ? ` · COMPUTE LIMITED ${matchComputeRatio.toFixed(2)}×` : ""}`;
}

function cancelMatchPaint() {
  matchPaintView = null;
  matchPaintRequested = false;
}

function flushMatchPaint() {
  const view = matchPaintView;
  if (view === null) return;
  matchPaintView = null;
  paintMatchView(view);
}

function requestMatchPaint(view) {
  matchPaintView = view;
  if (typeof requestAnimationFrame !== "function" || document.hidden) {
    flushMatchPaint();
    return;
  }
  if (matchPaintRequested) return;
  matchPaintRequested = true;
  const generation = matchGeneration;
  requestAnimationFrame(() => {
    matchPaintRequested = false;
    if (generation !== matchGeneration) return;
    flushMatchPaint();
  });
}

function renderMatch(view) {
  acceptMatchView(view);
  requestMatchPaint(view);
}

function paintMatchView(view) {
  paintMatchClock(performance.now());
  renderMatchStatus();
  for (const bot of view.bots) {
    const side = bot.id;
    elements[`match-${side}-field`].classList.toggle("input-spawn-field", inputModeActive());
    const botLabel = botLabelFor(bot.type);
    elements[`match-${side}-name`].textContent = `${side.toUpperCase()} · ${botLabel}`;
    elements[`match-${side}-stats`].textContent = `${bot.stats.attack} ATK · ${bot.stats.garbageCancelled} CNL · ${bot.stats.garbageSent} SENT · ${bot.stats.garbageReceived} RECV`;
    elements[`match-${side}-stats`].title = bot.inputExecution && bot.type !== "human"
      ? formatInputExecutionTooltip(bot.inputExecution)
      : "";
    const clear = bot.lastClear;
    renderClearInfo(`match-${side}`, bot.b2b, bot.combo, clear === null
      ? ""
      : clearLabel(clear.spin, clear.lines, clear.perfectClear));
    elements[`match-${side}-score`].textContent = Number.isFinite(bot.score)
      ? `SCORE ${bot.score.toFixed(2)}`
      : "—";
    elements[`match-${side}-score`].title = inputModeActive() ? "TTRM INPUTでは配置評価点（SCORE）を表示しません" : "配置の評価点";
    // Input-profile rounds expose the referee's settled board and active cells
    // for both sides. The human's local placement overlay belongs only to the
    // legacy final-placement route.
    if (inputModeActive()) {
      renderInputMatchSide(bot);
    } else if (human === null || human.side !== side) {
      renderMatchField(elements[`match-${side}-field`], bot.board, bot.lastPlaced);
      renderMini(elements[`match-${side}-hold`], bot.hold);
      renderNextList(elements[`match-${side}-next`], bot.next.slice(0, 5));
    }
    renderGarbageGauge(elements[`match-${side}-gauge`], bot.garbage.packets, `${side} bot`);
    renderMatchMetrics(side, bot.metrics, bot.stats.turns);
  }
  renderMatchSaveButton();
}

function renderInputMatchSide(bot) {
  // Engine spawns at y=21..22. Include the buffer so HOLD/lock successors
  // appear immediately instead of remaining invisible until gravity lowers them.
  const overlay = inputPieceOverlay(bot.board, bot.activeCells, bot.current,
    bot.type !== "human" || humanHandling(humanControls).ghost);
  renderMatchField(elements[`match-${bot.id}-field`], bot.board, bot.lastPlaced, overlay, { rows: 23 });
  renderMini(elements[`match-${bot.id}-hold`], bot.hold);
  renderNextList(elements[`match-${bot.id}-next`], bot.next.slice(0, 5));
}

function renderRealtimeMatchClock(nowMs) {
  paintMatchClock(nowMs);
  requestAnimationFrame(renderRealtimeMatchClock);
}

function paintMatchClock(nowMs) {
  const elapsedMs = Math.max(lastRenderedMatchElapsedMs, readMatchClock(matchClock, nowMs));
  lastRenderedMatchElapsedMs = elapsedMs;
  const text = formatGameClock(elapsedMs / 1000);
  if (text === lastRenderedMatchClock) return;
  lastRenderedMatchClock = text;
  elements["match-left-clock"].textContent = text;
  elements["match-right-clock"].textContent = text;
}

// The placement count leads the field-edge column so the rate figures below it
// can be read against the number of pieces they were computed from.
function renderMatchMetrics(side, metrics, pieces) {
  renderFieldRateStats(elements[`match-${side}-rate-left`], { ...metrics, pieces }, [
    ["PCS", "pieces", 0],
    ["PPS", "pps", 2],
    ["APM", "apm", 2],
    ["APP", "app", 3],
  ]);
  renderFieldRateStats(elements[`match-${side}-rate-right`], metrics, [
    ["VS", "vs", 2],
    ["AREA", "area", 2],
  ]);

  renderDetailMetrics(elements[`match-${side}-metrics`], metrics);
}

function render() {
  renderField();
  renderPlacingStrip();
  renderGameMetrics();
  renderMini(elements["hold-piece"], game.hold);
  elements["next-pieces"].replaceChildren(...game.queue.slice(1, 6).map((piece) => {
    const item = document.createElement("div");
    item.className = "next-item";
    renderMini(item, piece);
    return item;
  }));
  elements["current-piece"].textContent = game.queue[0] ?? "—";
  elements["move-number"].textContent = String(game.pieces + 1).padStart(3, "0");
  elements["pieces-count"].textContent = game.pieces;
  elements["lines-count"].textContent = game.lines;
  renderClearInfo("hold", game.s2.b2b, game.combo, game.lastClear);
}

// B2B, REN and the latest clear name sit under the HOLD box, as in the
// `fumen-mobile-fork` replay screen. Both counters stay muted until the chain is
// live, so a running B2B or REN is what draws the eye.
function renderClearInfo(prefix, b2b, ren, clear) {
  const b2bNode = elements[`${prefix}-b2b`];
  renderChainCounter(b2bNode, "B2B", shownB2b(b2b), b2b > 0);
  b2bNode.dataset.surge = String(isSurgeReady(b2b));
  renderChainCounter(elements[`${prefix}-ren`], "COMBO", shownCombo(ren), ren > 1);
  elements[`${prefix}-clear`].textContent = clear;
}

// Breaking the chain now would release a Surge. calculateSurge() charges once
// the broken count is past the threshold, and the broken count is the canonical
// counter, so `b2b > at` is the engine's own `stats.b2b + 1 > charging.at`:
// with at = 4 the counter lights up at a shown B2B of 4.
function isSurgeReady(b2b) {
  return b2bCharging !== false && b2b > b2bCharging.at;
}

function renderGameMetrics() {
  const metrics = calculatePlayerMetrics({
    pieces: game.pieces,
    attack: game.attack,
    garbageCleared: game.garbageCleared,
    elapsedFrames: gameMetricElapsedMs * 60 / 1000,
  });
  elements["game-clock"].textContent = formatGameClock(metrics.seconds);
  renderFieldRateStats(elements["field-rate-left"], metrics, [
    ["PPS", "pps", 2],
    ["APM", "apm", 2],
    ["APP", "app", 3],
  ]);
  renderFieldRateStats(elements["field-rate-right"], metrics, [
    ["VS", "vs", 2],
    ["AREA", "area", 2],
  ]);
}

function renderField() {
  const overlay = new Map();
  if (pendingMove !== null) {
    addOverlayPiece(
      overlay,
      placementCells(pendingMove),
      pendingMove.location.type,
      true,
    );
  }
  renderMatchField(elements.field, game.board, game.lastPlaced, overlay);
}

// Names the mino the field is currently highlighting. CC2 may propose the HOLD
// piece, in which case the highlighted mino is not the CURRENT one, so where it
// came from is spelled out rather than left to be inferred from the colour.
function renderPlacingStrip() {
  if (pendingMove !== null) {
    const piece = pendingMove.location.type;
    elements["placing-label"].textContent = "配置中";
    elements["placing-piece"].textContent = piece === game.queue[0] ? piece : `${piece} ← HOLD`;
    return;
  }
  if (game.lastPlaced.length > 0 && game.lastPlacedPiece !== null) {
    elements["placing-label"].textContent = "最新";
    elements["placing-piece"].textContent = game.lastPlacedFromHold
      ? `${game.lastPlacedPiece} ← HOLD`
      : game.lastPlacedPiece;
    return;
  }
  elements["placing-label"].textContent = "配置中";
  elements["placing-piece"].textContent = "—";
}

function setStatus(state, text) {
  elements["engine-status"].dataset.state = state;
  elements["status-text"].textContent = text;
}

function formatMove(move) {
  const { type, orientation, x, y } = move.location;
  return `${type} · ${orientation.toUpperCase()} · (${x}, ${y})`;
}

function compact(value) {
  return Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 }).format(value);
}

function renderComparison(raw, comparison) {
  const best = comparison.challenger;
  const gap = comparison.scoreGap;
  elements["raw-score"].textContent = raw.comparison.score.toFixed(2);
  elements["raw-comparison-status"].textContent = raw.status;
  elements["s2-best-move"].textContent = formatCanonicalPlacement(best.placement);
  elements["s2-score"].textContent = `${best.score.toFixed(2)} · ${comparison.status}`;
  elements["score-gap"].textContent = `${gap >= 0 ? "+" : ""}${gap.toFixed(2)}`;
}

function renderUnavailableComparison(raw, s2) {
  elements["raw-score"].textContent = raw.comparison.score.toFixed(2);
  elements["raw-comparison-status"].textContent = raw.status;
  elements["s2-best-move"].textContent = "この局面では比較できません";
  elements["s2-score"].textContent = s2.degraded?.join(", ") ?? s2.status;
  elements["score-gap"].textContent = "—";
}

function resetComparison() {
  elements["raw-score"].textContent = "—";
  elements["raw-comparison-status"].textContent = "未評価";
  elements["s2-best-move"].textContent = "—";
  elements["s2-score"].textContent = "未評価";
  elements["score-gap"].textContent = "—";
}

function formatCanonicalPlacement(placement) {
  return `${placement.piece} · ${placement.rotation.toUpperCase()} · (${placement.x}, ${placement.y})`;
}
