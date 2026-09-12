import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import vm from "node:vm";

import { GUI_MODES } from "../cc2-gui/preferences.mjs";

const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
const markup = read("../cc2-gui/index.html");
const replayView = read("../cc2-gui/replay-view.mjs");
const app = read("../cc2-gui/app.mjs");
const server = read("../scripts/cc2-gui-server.mjs");
const pagesBuild = read("../scripts/build-pages.mjs");

const ids = new Set([...markup.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));

test("replay summary distinguishes generated inputs, legacy records, and aggregate import checks", () => {
  const context = vm.createContext({ fileName: "", ir: { meta: { gamemode: "league" } }, killerGarbageOf: () => undefined });
  vm.runInContext(replayView.match(/function summaryText\([\s\S]*?^}/m)[0], context);
  const player = { id: "left", username: "left", locks: [], terminal: { reason: "top-out" },
    optionWarnings: [], verification: { scope: "pieces-lines-sent" } };
  const round = { players: [player], result: { winnerId: null } };
  assert.match(context.summaryText(round, player), /REPLAY · league/);
  context.ir.meta.origin = "s2-bot-lab-generated";
  const generated = context.summaryText(round, player);
  assert.match(generated, /BOT LAB GENERATED · INPUT REPLAY/);
  assert.match(generated, /IMPORT CHECK: PIECES \/ LINES \/ SENT ONLY/);
  assert.doesNotMatch(generated, /league|NO INPUT LOG/);
  context.ir.meta.origin = "s2-bot-match/1";
  assert.match(context.summaryText(round, player), /SYNTHETIC CLOCK · NO INPUT LOG/);
});

test("every mode has both a tab and a panel", () => {
  for (const mode of GUI_MODES) {
    assert.ok(ids.has(`mode-tab-${mode}`), `mode-tab-${mode}`);
    assert.ok(ids.has(`mode-panel-${mode}`), `mode-panel-${mode}`);
  }
});

test("match and replay fields stay inside their own tab panel", () => {
  // Track div ancestry: an extra closing div after the settings disclosure
  // used to push the match fields outside the panel, above every replay.
  const ancestors = [];
  const fields = [];
  for (const [tag] of markup.matchAll(/<\/?div\b[^>]*>/g)) {
    if (tag.startsWith("</")) {
      assert.ok(ancestors.length > 0, "unmatched closing div");
      ancestors.pop();
      continue;
    }
    const id = tag.match(/\bid="([^"]+)"/)?.[1] ?? null;
    if (/^(match|replay)-(left|right)-field$/.test(id)) {
      const mode = id.split("-")[0];
      assert.ok(ancestors.includes(`mode-panel-${mode}`), `${id} escaped its tab`);
      fields.push(id);
    }
    ancestors.push(id);
  }
  assert.equal(ancestors.length, 0, "unclosed div");
  assert.equal(fields.length, 4, "one field pair per tab");
});

test("one replay importer routes by file contents, regardless of extension", async () => {
  const adopted = [];
  const requests = [];
  const record = { $schema: "match-record" };
  const inputReplay = { replay: { rounds: [] } };
  const context = vm.createContext({
    importId: 0, MAX_REPLAY_BYTES: 32 * 1024 * 1024,
    pausePlayback() {}, setStatus() {},
    validateReplayIRDocument(value) { assert.equal(value.$schema, record.$schema); },
    adopt(value, name) { adopted.push({ value, name }); },
    fail(id, stage, message) { assert.fail(`${stage}: ${message}`); },
    async fetch(url, options) {
      requests.push({ url, options });
      return { ok: true, async json() { return { ir: inputReplay }; } };
    },
  });
  vm.runInContext(replayView.match(/async function importFile\([\s\S]*?^}/m)[0], context);
  await context.importFile({ name: "match.ttrm", size: 100, async text() { return JSON.stringify(record); } });
  assert.equal(requests.length, 0, "match records are validated locally");
  assert.equal(adopted[0].value.$schema, record.$schema);
  await context.importFile({ name: "inputs.json", size: 100, async text() { return JSON.stringify(inputReplay); } });
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/replay/import");
  assert.equal(requests[0].options.body, JSON.stringify(inputReplay));
  assert.equal(adopted[1].value, inputReplay, "converted inputs use the same viewer");
});

test("the replay view only reaches for elements the page actually has", () => {
  const literal = [...replayView.matchAll(/elements\["([^"]+)"\]/g)].map((match) => match[1]);
  // Both fields are addressed through the same template, so the side is the
  // only part that varies.
  const templated = [...replayView.matchAll(/elements\[`replay-\$\{side\}-([a-z-]+)`\]/g)]
    .flatMap((match) => [`replay-left-${match[1]}`, `replay-right-${match[1]}`]);
  const looked = new Set([...literal, ...templated]);
  assert.ok(looked.size > 20, "the replay panel is expected to drive many elements");
  for (const id of looked) assert.ok(ids.has(id), `index.html is missing #${id}`);
});

test("the browser entry modules import only shared files published by both targets", () => {
  const table = server.slice(server.indexOf("const SHARED_MODULES"), server.indexOf("const runId"));
  const shared = new Map([...table.matchAll(/\["(\/shared\/[^"]+)", "([^"]+)"\]/g)]
    .map((match) => [match[1], match[2]]));
  assert.ok(shared.size >= 4, "the shared module table should not have collapsed");

  const imported = [app, replayView]
    .flatMap((source) => [...source.matchAll(/from ["'](\/shared\/[^"']+)["']/g)]
      .map((match) => match[1]));
  assert.ok(imported.length > 0);
  for (const url of imported) {
    assert.ok(pagesBuild.includes('["' + url + '"'), "the Pages build does not publish " + url);
  }
  for (const url of imported) assert.ok(shared.has(url), `the server does not serve ${url}`);

  // A shared module's own relative imports are resolved by the browser against
  // its /shared/ URL, so each one has to be another published entry.
  for (const [url, file] of shared) {
    const source = read(`../cc2-gui/${file}`);
    for (const [, specifier] of source.matchAll(/from "\.\/([^"]+)"/g)) {
      assert.ok(shared.has(`/shared/${specifier}`), `${url} imports unpublished ./${specifier}`);
    }
  }
});

test("the replay panel is served by an import endpoint that refuses oversized files", () => {
  assert.match(server, /request\.url === "\/api\/replay\/import"/);
  assert.match(server, /readText\(request, MAX_TTRM_TEXT_LENGTH\)/);
  assert.match(replayView, /fetch\("\/api\/replay\/import"/);
});

test("replay garbage gauge keeps serialized unconfirmed packets transparent", () => {
  const context = vm.createContext({});
  vm.runInContext(replayView.match(/function gaugePacketsAt\([\s\S]*?^}/m)[0], context);
  const packets = context.gaugePacketsAt(
    { snapshot: { queue: [{ amount: 4, frame: 12 }, { amount: 2, frame: null }] } },
    { pending: [{ remaining: 4 }, { remaining: 2 }] },
    { resolvedOptions: { garbagespeed: 3 } },
    15,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(packets)), [
    { amount: 4, ready: true },
    { amount: 2, ready: false },
  ]);
});

test("a proposal failure stops autoplay before the series can score a draw", () => {
  const finish = app.slice(app.indexOf("async function finishSeriesGame"), app.indexOf("async function finalizeCurrentRound"));
  const failure = finish.indexOf('proposalResult?.status === "failure"');
  const score = finish.indexOf("matchSeries.completed += 1");
  assert.ok(failure >= 0, "finishSeriesGame must recognize a canonical proposal failure");
  assert.ok(score > failure, "the fail-closed branch must precede series scoring");
  assert.match(finish.slice(failure, score), /matchAutoplay = false/);
  assert.match(finish.slice(failure, score), /return;/);
});

test("the replay turn readout identifies whose turn it counts", () => {
  assert.match(
    replayView,
    /replay-turn"\]\.textContent = `\$\{self\.username\} · TURN \$\{Math\.min\(selfIndex, self\.locks\.length\)\}/,
  );
});

test("local legacy routes use the shared Raw/chouhy public resolver admission", () => {
  // A F14-only import rejects Raw/chouhy at START, before any proposal runs.
  assert.match(server, /createGuiStaticDecisionRequest as createS2AmountOnlyDecisionRequest/);
  assert.match(server, /isGuiStaticType as isAdr062QualifiedStaticType/);
  assert.match(server, /import \{ resolveGuiStaticSubmission as resolveQualifiedStaticCc2Submission \} from "\.\.\/src-js\/gui-static-public-resolver\.mjs"/);
});

test("the local match server fingerprints CC2 S2 selector submissions", () => {
  const resolveProposal = server.slice(
    server.indexOf("function resolveProposal"),
    server.indexOf("function commitHumanLock"),
  );
  assert.match(server, /import \{[\s\S]*attachS2SubmissionFingerprint,[\s\S]*\} from "\.\.\/src-js\/s2-f12-amount-only-post-tank-solvency-rescue-selector\.mjs";/);
  assert.match(
    resolveProposal,
    /attachS2SubmissionFingerprint\(bot\.id, bot\.state, result\)/,
    "F14 and development-champion results omit comparison.positionFingerprint, so the production caller must attach it",
  );
});

test("a new series game cannot be blocked or cleared by the preceding bot step", () => {
  const startSeriesGame = app.slice(
    app.indexOf("async function startSeriesGame"),
    app.indexOf("function scheduleHumanMatchBotStep"),
  );
  assert.match(startSeriesGame, /const generation = \+\+matchGeneration/);
  assert.doesNotMatch(startSeriesGame, /await matchStep/);

  const stepMatch = app.slice(
    app.indexOf("async function stepMatch"),
    app.indexOf("async function finishSeriesGame"),
  );
  assert.match(stepMatch, /matchStepGeneration === generation/);
  assert.match(stepMatch, /matchStepGeneration = generation/);
  assert.match(stepMatch, /finally \{[\s\S]*if \(matchStepGeneration === generation\) matchStepGeneration = null/);
});

test("the 1P Reset key always restarts play without changing the GUI buttons", () => {
  assert.match(app, /elements\["match-reset"\]\.addEventListener\("click", resetMatch\)/);
  const keydown = app.slice(
    app.indexOf("function handleHumanKeyDown"),
    app.indexOf("function handleHumanKeyUp"),
  );
  const resetKey = keydown.indexOf('if (action === "Reset")');
  const liveInputGate = keydown.indexOf("if (!humanInputEnabled()) return");
  assert.ok(resetKey >= 0 && resetKey < liveInputGate, "Reset must work before the live player exists");
  assert.match(keydown, /selectedHumanSide\(\) === null/);
  assert.match(keydown, /requestHumanMatchRestart\(\)/);

  const requestRestart = app.slice(
    app.indexOf("function requestHumanMatchRestart"),
    app.indexOf("async function activateHumanMatchReset"),
  );
  assert.match(requestRestart, /humanMatchRestartInFlight !== null && !matchCountingDown\(\)/);

  const activate = app.slice(
    app.indexOf("async function activateHumanMatchReset"),
    app.indexOf("function clearMatchArena"),
  );
  assert.match(activate, /if \(matchCountingDown\(\)\)[\s\S]*await resetMatch\(\);[\s\S]*await interruptedStart;[\s\S]*await startMatch\(\{ excludedRandomSeed:/);
  assert.match(activate, /if \(matchStartInFlight !== null\) await matchStartInFlight/);
  assert.match(activate, /if \(matchRoundFinalization !== null\) await matchRoundFinalization/);
  assert.match(activate, /!matchSeriesActive\(\)[\s\S]*await startMatch\(\{/);
  assert.match(activate, /matchSeries\?\.currentSeed \?\? lastStartedMatchSeed/);
  assert.match(activate, /excludedRandomSeed:[\s\S]*match-random-seed/);
  assert.match(activate, /await resetMatch\(\{ restartCurrentGame: true, rerollRandomSeed: true \}\)/);

  const reset = app.slice(
    app.indexOf("async function resetMatch"),
    app.indexOf("async function activateHumanMatchReset"),
  );
  assert.match(reset, /const preservedSeries = restartCurrentGame \? matchSeries : null/);
  assert.match(reset, /rerollRandomSeed && preservedSeries !== null/);
  assert.match(reset, /randomUint32Except\(previousSeed\)/);
  assert.match(reset, /matchSeries = preservedSeries/);
  assert.match(reset, /await fetch\("\/api\/match\/close"/);
  assert.match(reset, /await beginSeriesGame\(\)/);
  assert.doesNotMatch(reset, /matchSeries\.completed \+=/);
});

test("human input rendering uses one guarded microtask", () => {
  const request = app.slice(
    app.indexOf("function requestHumanRender"),
    app.indexOf("function renderHumanField"),
  );
  assert.match(request, /if \(humanRenderRequested \|\| human === null\) return;/);
  assert.match(request, /humanRenderRequested = true;[\s\S]*queueMicrotask\(\(\) => \{/);
  assert.match(request, /queueMicrotask\(\(\) => \{[\s\S]*humanRenderRequested = false;[\s\S]*if \(human !== null\) renderHumanField\(\);/);
  assert.doesNotMatch(request, /setTimeout|requestAnimationFrame/);
});

test("the deck exports through one button whose format follows the execution path", () => {
  const exportGroup = markup.slice(markup.indexOf('class="match-exports"'), markup.indexOf('id="match-export-message"'));
  assert.equal([...exportGroup.matchAll(/<button /g)].length, 1, "EXPORT must offer exactly one save button");
  assert.ok(ids.has("match-save-replay"));
  assert.ok(!ids.has("match-save-ttrm"), "a second format-specific export button must not come back");
  assert.match(app, /elements\["match-save-replay"\]\.addEventListener\("click", saveMatchExport\)/);

  const format = app.slice(app.indexOf("function selectedExportFormat"), app.indexOf("/* The export spends"));
  // A started series answers for its own rounds: moving the toggle afterwards
  // must not relabel or re-route rounds that were played on the other path.
  assert.match(format, /if \(matchSeries !== null\) return inputModeActive\(\) \? "ttrm" : "json";/);
  assert.match(format, /return inputModeSelected\(\) \? "ttrm" : "json";/);
  assert.match(format, /selectedExportFormat\(\) === "ttrm" \? saveMatchTtrm\(\) : saveMatchReplay\(\)/);

  // A failed save has to report on the line that announced it: handleMatchError
  // writes the round status, which would leave "EXPORTING …" standing.
  assert.equal([...app.matchAll(/setMatchExportMessage\("failed"/g)].length, 2, "both save paths must report their own failure");
});

test("each match setting group names the execution path it belongs to", () => {
  const settings = markup.slice(markup.indexOf('class="match-settings"'), markup.indexOf('class="match-outcome"'));
  assert.deepEqual([...settings.matchAll(/data-scope="([a-z]+)"/g)].map((match) => match[1]), ["execution", "legacy", "both", "both"]);
  for (const id of ["match-execution-note", "match-legacy-note", "match-legacy-settings",
    "match-stall-lock-note", "match-stall-lock-settings"]) assert.ok(ids.has(id), id);

  const notes = app.slice(app.indexOf("function renderExecutionScopeNotes"), app.indexOf("function syncMaxTurnsControl"));
  assert.match(notes, /elements\["match-legacy-settings"\]\.dataset\.inactive = String\(inputMode\)/);
  // With no You (1P) side there is no piece for the deadline to take, so the
  // otherwise shared group states that reason in both execution modes.
  assert.match(notes, /elements\["match-stall-lock-settings"\]\.dataset\.inactive = String\(!playing\)/);
  // The scope has to be stated while the group is still usable, so no branch of
  // either note may fall back to an empty string.
  assert.doesNotMatch(notes, /: ""/);
});

test("the settings row opens and closes as one, and its bar keeps the values", () => {
  const tag = markup.match(/<details class="match-settings-disclosure"[^>]*>/);
  assert.ok(tag !== null, "the settings row is one disclosure");
  assert.doesNotMatch(tag[0], /\sopen[\s>]/, "the row ships closed");
  const inside = markup.slice(markup.indexOf('class="match-settings-disclosure"'), markup.indexOf('class="match-outcome"'));
  assert.equal([...inside.matchAll(/<details/g)].length, 0, "the groups inside must not open one by one");
  assert.ok(ids.has("match-settings-state"));

  const notes = app.slice(app.indexOf("function renderExecutionScopeNotes"), app.indexOf("function onOff"));
  assert.match(notes, /elements\["match-settings-state"\]\.textContent = matchSettingsStateText\(inputMode\)/);
  assert.match(notes, /if \(inputMode\) return \[\.\.\.parts, `STALL \$\{stall\}`\]\.join/);
  // A closed row must not take its state with it, so every control refreshes it.
  assert.match(app, /elements\["match-settings"\]\.addEventListener\("input", \(\) => renderExecutionScopeNotes\(\)\)/);
});
