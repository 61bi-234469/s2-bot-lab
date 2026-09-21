import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { createGuiRequestHandlers } from "../src-js/gui-request-handlers.mjs";
import { guiStateToCanonical } from "../src-js/gui-state.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";
import {
  DEFAULT_TURN_MATCH_ORDER,
  TURN_MATCH_ID,
  TURN_MATCH_ORDERS,
  normalizeTurnMatch,
  turnMatchControllerOptions,
} from "../src-js/gui-turn-match.mjs";

const SEED = 1506;

function handlers() {
  return createGuiRequestHandlers({ now: () => 0, wait: async () => {} });
}

async function call(api, method, path, body = null) {
  return api.handle({ method, path, body });
}

async function ok(api, method, path, body = null) {
  const result = await call(api, method, path, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  return result.body;
}

async function startTurnMatch(api, order, extra = {}) {
  return ok(api, "POST", "/api/match/start", {
    left: "human", right: "s2-simple", seed: SEED,
    turnMatch: { enabled: true, order }, ...extra,
  });
}

/* A legal placement for the side the view shows. Only the board and the piece
   decide legality, so the scaffolding the probe needs for the unrelated S2
   fields comes from a fresh scenario rather than from the live session. */
function humanPlacement(view) {
  const player = view.bots.find((bot) => bot.id === view.humanSide);
  const scaffold = toS2GuiState(createGame(SEED));
  const probe = guiStateToCanonical({
    ...scaffold,
    board: player.board,
    queue: [player.current, ...player.next],
    hold: player.hold,
    combo: player.combo,
  });
  const best = analyzeSimpleS2FinalPlacements(probe, { topN: 1 }).moves[0];
  assert.ok(best, "the probe position has a legal final placement");
  return best.placement;
}

test("a turn match request is validated once and only applies with a 1P side", () => {
  assert.deepEqual(normalizeTurnMatch(null), { id: TURN_MATCH_ID, enabled: false, order: DEFAULT_TURN_MATCH_ORDER });
  assert.deepEqual(TURN_MATCH_ORDERS, ["simultaneous", "human-first", "bot-first"]);
  assert.equal(normalizeTurnMatch({ enabled: true, order: "bot-first" }, { humanSide: "left" }).enabled, true);
  assert.equal(normalizeTurnMatch({ enabled: true, order: "bot-first" }, { humanSide: null }).enabled, false,
    "no 1P side is nobody to take a turn against");
  assert.throws(() => normalizeTurnMatch({ enabled: true, order: "left-first" }, { humanSide: "left" }),
    /unsupported turn match order/);
  assert.throws(() => normalizeTurnMatch({ enabled: "yes" }, { humanSide: "left" }), /must be a boolean/);
  assert.throws(() => normalizeTurnMatch([], { humanSide: "left" }), /must be an object/);
});

test("each turn order names one controller schedule", () => {
  const options = (order) => turnMatchControllerOptions({ enabled: true, order }, "left");
  assert.deepEqual(options("simultaneous"), { mode: "simultaneous", startingBotId: "left" });
  assert.deepEqual(options("human-first"), { mode: "alternating", startingBotId: "left" });
  assert.deepEqual(options("bot-first"), { mode: "alternating", startingBotId: "right" });
  assert.equal(turnMatchControllerOptions({ enabled: false, order: "human-first" }, "left"), null);
  assert.throws(() => turnMatchControllerOptions({ enabled: true, order: "human-first" }, null), /requires a 1P side/);
});

test("1P first: the player owns the turn and the bot may not step before them", async () => {
  const api = handlers();
  const start = await startTurnMatch(api, "human-first");
  assert.equal(start.mode, "alternating");
  assert.deepEqual(start.dueBotIds, ["left"]);
  assert.equal(start.pacing.authority, "turn");
  assert.equal(start.pacing.declaredPpsByBotId, null, "a turn match declares no rate for either side");

  const early = await call(api, "POST", "/api/match/step", {});
  assert.equal(early.status, 409);
  assert.equal(early.body.error, "human-lock-required");

  const afterHuman = await ok(api, "POST", "/api/match/human-lock", { placement: humanPlacement(start) });
  assert.equal(afterHuman.turnNumber, 1);
  assert.deepEqual(afterHuman.dueBotIds, ["right"]);
  assert.equal(afterHuman.bots.find((bot) => bot.id === "left").stats.turns, 1);
  assert.equal(afterHuman.bots.find((bot) => bot.id === "right").stats.turns, 0);

  const afterBot = await ok(api, "POST", "/api/match/step", {});
  assert.equal(afterBot.turnNumber, 2);
  assert.deepEqual(afterBot.dueBotIds, ["left"]);
  assert.equal(afterBot.bots.find((bot) => bot.id === "right").stats.turns, 1);
});

test("bot first: the opponent takes the first turn and a player lock before it is refused", async () => {
  const api = handlers();
  const start = await startTurnMatch(api, "bot-first");
  assert.deepEqual(start.dueBotIds, ["right"]);

  const early = await call(api, "POST", "/api/match/human-lock", { placement: humanPlacement(start) });
  assert.equal(early.status, 409);
  assert.equal(early.body.error, "not-your-turn");

  const afterBot = await ok(api, "POST", "/api/match/step", {});
  assert.equal(afterBot.turnNumber, 1);
  assert.deepEqual(afterBot.dueBotIds, ["left"]);
  assert.equal(afterBot.bots.find((bot) => bot.id === "left").stats.turns, 0);

  const afterHuman = await ok(api, "POST", "/api/match/human-lock", { placement: humanPlacement(afterBot) });
  assert.equal(afterHuman.turnNumber, 2);
  assert.equal(afterHuman.bots.find((bot) => bot.id === "left").stats.turns, 1);
});

test("simultaneous: one turn commits both halves and cannot be stepped without the player's", async () => {
  const api = handlers();
  const start = await startTurnMatch(api, "simultaneous");
  assert.equal(start.mode, "simultaneous");
  assert.deepEqual([...start.dueBotIds].sort(), ["left", "right"]);

  const early = await call(api, "POST", "/api/match/step", {});
  assert.equal(early.status, 409);
  assert.equal(early.body.error, "human-lock-required");

  const afterTurn = await ok(api, "POST", "/api/match/human-lock", { placement: humanPlacement(start) });
  assert.equal(afterTurn.turnNumber, 1);
  for (const bot of afterTurn.bots) assert.equal(bot.stats.turns, 1, `${bot.id} played its half of the turn`);
  assert.deepEqual([...afterTurn.dueBotIds].sort(), ["left", "right"]);
});

test("a turn match keeps the clock on its own turn schedule rather than on wall time", async () => {
  const api = handlers();
  const start = await startTurnMatch(api, "human-first");
  assert.equal(start.clock.logicalFrame, 0);
  // The browser's wall frame is not what advances a turn: a lock frame far in
  // the future must not move the shared clock past one turn.
  const afterHuman = await ok(api, "POST", "/api/match/human-lock", {
    placement: humanPlacement(start), lockFrame: 99_999,
  });
  assert.equal(afterHuman.clock.logicalFrame, start.clock.framesPerTurn);
  assert.equal(afterHuman.metricElapsedMs, start.clock.framesPerTurn * 1000 / 60);
});

test("a turn match without a 1P side keeps the ordinary paced round", async () => {
  const api = handlers();
  const start = await ok(api, "POST", "/api/match/start", {
    left: "s2-simple", right: "s2-simple", seed: SEED, turnMatch: { enabled: true, order: "bot-first" },
  });
  assert.equal(start.turnMatch.enabled, false);
  assert.equal(start.mode, "paced");
  assert.equal(start.pacing.authority, "synthetic");
});

test("the round record states the turn rule the series was played under", async () => {
  const api = handlers();
  const start = await startTurnMatch(api, "human-first");
  assert.deepEqual(start.replayMeta.match.turnMatch, { id: TURN_MATCH_ID, enabled: true, order: "human-first" });
  assert.equal(start.replayMeta.match.declaredPpsByBotId, null);
});

/* The browser half of the rule, run as the shipped functions rather than as a
   copy of them: which side may drop a piece, when the opponent is asked to
   play, and what the closed settings bar claims the round will be. */
const source = readFileSync(new URL("../cc2-gui/app.mjs", import.meta.url), "utf8");
const markup = readFileSync(new URL("../cc2-gui/index.html", import.meta.url), "utf8");

function deck({ checked = true, order = "simultaneous", human = true, inputMode = false,
  series = null, dueBotIds = ["left", "right"], stallLock = true } = {}) {
  const checkbox = (value) => ({ checked: value, value: String(value), disabled: false });
  const elements = {
    "left-bot": { value: "human" },
    "left-bot-settings-summary": { textContent: "" },
    "match-turn-match": checkbox(checked),
    "match-turn-order": { value: order },
    "match-turn-note": { textContent: "" },
    "match-stall-lock": checkbox(stallLock),
    "match-stall-lock-penalty": { value: "penalty-line", disabled: false },
    "match-stall-lock-pps": { value: "2", disabled: false },
    "match-handicap-garbage": checkbox(false),
    "match-time-progression": checkbox(true),
    "match-settings-state": { textContent: "" },
    "match-fair-comparison": checkbox(false),
    "match-pre-lock-preview": checkbox(false),
    "match-random-seed": checkbox(true),
    "match-seed": { value: "1506" },
    "match-unlimited-turns": checkbox(true),
    "match-max-turns": { value: "500" },
    "match-count": { value: "1" },
  };
  const context = vm.createContext({
    elements,
    matchRunning: true,
    matchAutoplay: true,
    startCountdown: null,
    matchSeries: series ?? { config: { turnMatch: { enabled: checked && human, order } } },
    lastMatchView: { dueBotIds },
    human: human ? { side: "left", active: { piece: "T" }, pending: false } : null,
    humanBotStepTimer: null,
    stepped: 0,
    STALL_LOCK_PENALTIES: new Set(["forced-lock", "penalty-line"]),
    STALL_LOCK_PPS_BOUNDS: { minimum: 0.1, maximum: 20 },
    stepMatch() { context.stepped += 1; },
    setTimeout(callback) { callback(); return 1; },
    clearTimeout() {},
    selectedHumanSide: () => (human ? "left" : null),
    humanControls: {},
    botCapabilities: new Map(),
    BOT_PARAMETER_DEFINITIONS: { human: { parameters: [] } },
    botParameters: { left: { human: {} } },
    describeHumanControls: () => "DAS 10F",
    fairComparisonEnabled: () => false,
    inputModeSelected: () => inputMode,
    inputModeActive: () => inputMode,
    onOff: (control) => (control.checked ? "ON" : "OFF"),
    readBoundedNumber: (id) => Number(elements[id].value),
  });
  // Index slicing rather than a regular expression: the production function is
  // taken verbatim from its declaration to its closing brace.
  const declaration = (name) => {
    const at = source.indexOf(`function ${name}(`);
    assert.ok(at >= 0, `${name} not found in app.mjs`);
    return source.slice(at, source.indexOf("\n}\n", at) + 3);
  };
  for (const name of ["turnMatchSelected", "turnMatchSettings", "turnMatchActive", "humanTurnDue",
    "matchCountingDown", "humanCanAct", "stallLockSettings", "renderTurnMatchNote",
    "matchSettingsStateText", "renderBotSettingsSummary", "humanTurnMatchSummary",
    "humanHandicapSummary", "humanStallSummary", "cancelHumanMatchBotStep", "scheduleHumanMatchBotStep"]) {
    vm.runInContext(declaration(name), context);
  }
  return context;
}

test("the turn match setting applies to a 1P round on either execution path", () => {
  assert.deepEqual({ ...deck({ order: "bot-first" }).turnMatchSettings() }, { enabled: true, order: "bot-first" });
  assert.equal(deck({ inputMode: true }).turnMatchSettings().enabled, true,
    "TTRM INPUT switches its referee Engine's own gravity off for the round");
  assert.equal(deck({ human: false }).turnMatchSettings().enabled, false,
    "no 1P side is nobody to take a turn against");
  assert.equal(deck({ checked: false }).turnMatchSettings().enabled, false);
});

test("the left human picker summary carries its 1P rules", () => {
  const app = deck({ order: "human-first", stallLock: true });
  app.elements["match-handicap-garbage"].checked = true;
  app.renderBotSettingsSummary("left");
  assert.equal(app.elements["left-bot-settings-summary"].textContent,
    "DAS 10F · TURN 1P先行 · HANDI ON · STALL —");

  app.elements["match-turn-match"].checked = false;
  app.renderBotSettingsSummary("left");
  assert.equal(app.elements["left-bot-settings-summary"].textContent,
    "DAS 10F · TURN OFF · HANDI ON · STALL 2 PPS LINE");

  app.elements["match-handicap-garbage"].checked = false;
  app.elements["match-stall-lock"].checked = false;
  app.renderBotSettingsSummary("left");
  assert.equal(app.elements["left-bot-settings-summary"].textContent,
    "DAS 10F · TURN OFF · HANDI OFF · STALL OFF");
});

test("a turn match has no pace for the STALL PENALTY budget to measure", () => {
  assert.equal(deck({ checked: true, stallLock: true }).stallLockSettings().enabled, false);
  assert.equal(deck({ checked: false, stallLock: true }).stallLockSettings().enabled, true);
});

test("the settings bar leaves 1P rules to the human picker summary", () => {
  const playing = deck({ order: "bot-first" });
  playing.renderTurnMatchNote(false);
  assert.doesNotMatch(playing.matchSettingsStateText(false), /TURN|HANDI|STALL/);
  assert.match(playing.matchSettingsStateText(false), /FAIR OFF · GHOST OFF/);
  assert.match(playing.elements["match-turn-note"].textContent, /重力落下もありません/);
  assert.match(playing.elements["match-turn-note"].textContent, /\.json/, "the legacy route keeps its export");

  const botsOnly = deck({ human: false });
  botsOnly.renderTurnMatchNote(false);
  assert.doesNotMatch(botsOnly.matchSettingsStateText(false), /TURN|HANDI|STALL/);

  const off = deck({ checked: false });
  off.renderTurnMatchNote(false);
  assert.doesNotMatch(off.matchSettingsStateText(false), /TURN|HANDI|STALL/);

  // The input path carries the same rule and says what it costs that path.
  const inputMode = deck({ inputMode: true, order: "human-first" });
  inputMode.renderTurnMatchNote(true);
  assert.doesNotMatch(inputMode.matchSettingsStateText(true), /TURN|HANDI|STALL/);
  assert.match(inputMode.matchSettingsStateText(true), /TIME ON/);
  assert.match(inputMode.elements["match-turn-note"].textContent, /\.ttrm 保存対象外/);
  assert.match(inputMode.elements["match-turn-note"].textContent, /Engineの重力をOFF/);

  const inputSimultaneous = deck({ inputMode: true, order: "simultaneous" });
  inputSimultaneous.renderTurnMatchNote(true);
  assert.match(inputSimultaneous.elements["match-turn-note"].textContent, /手数差が1を超えない/);
  assert.match(inputSimultaneous.elements["match-turn-note"].textContent, /同一瞬間の確定ではありません/);

  const legacySimultaneous = deck({ order: "simultaneous" });
  legacySimultaneous.renderTurnMatchNote(false);
  assert.match(legacySimultaneous.elements["match-turn-note"].textContent, /両方を同時に確定/);
});

test("the player may only drop on their own turn, and the opponent steps on theirs", () => {
  const mine = deck({ order: "human-first", dueBotIds: ["left"] });
  assert.equal(mine.humanCanAct(), true);
  mine.scheduleHumanMatchBotStep({ dueBotIds: ["left"] });
  assert.equal(mine.stepped, 0, "the opponent waits for the turn to be handed over");

  const theirs = deck({ order: "human-first", dueBotIds: ["right"] });
  assert.equal(theirs.humanCanAct(), false);
  theirs.scheduleHumanMatchBotStep({ dueBotIds: ["right"] });
  assert.equal(theirs.stepped, 1);

  // A simultaneous turn is due from both sides: the person plays, and their
  // lock carries the whole turn rather than a step doing it.
  const together = deck({ order: "simultaneous", dueBotIds: ["left", "right"] });
  assert.equal(together.humanCanAct(), true);
  together.scheduleHumanMatchBotStep({ dueBotIds: ["left", "right"] });
  assert.equal(together.stepped, 0);

  // A round that is not a turn match keeps its standing opponent schedule.
  const realtime = deck({ checked: false, dueBotIds: ["right"],
    series: { config: { turnMatch: { enabled: false } } } });
  assert.equal(realtime.humanCanAct(), true);
  realtime.scheduleHumanMatchBotStep({ dueBotIds: ["right"], nextStepFrames: 60 });
  assert.equal(realtime.stepped, 1);
});

test("the turn order the markup offers is the one the rule module accepts", () => {
  const select = markup.slice(markup.indexOf('<select id="match-turn-order"'));
  const body = select.slice(0, select.indexOf("</select>"));
  assert.deepEqual([...body.matchAll(/<option value="([a-z-]+)"/g)].map((match) => match[1]),
    [...TURN_MATCH_ORDERS]);
  assert.doesNotMatch(body, /\sselected/, "the first option is the default");
  assert.equal(TURN_MATCH_ORDERS[0], DEFAULT_TURN_MATCH_ORDER);
});
