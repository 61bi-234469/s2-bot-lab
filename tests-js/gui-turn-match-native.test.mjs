import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";

import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { guiStateToCanonical } from "../src-js/gui-state.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";
import { TURN_MATCH_ID } from "../src-js/gui-turn-match.mjs";

/* `npm start` serves the native local server, which owns its own legacy match
   handlers. Reading its source would not prove which side is allowed to move,
   so this exercises the real endpoints. `You (1P)` against the S2 placement bot
   needs no CC2 binary, so the canary runs everywhere the suite runs. */
async function withNativeServer(run) {
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));

  const server = spawn(process.execPath, ["scripts/cc2-gui-server.mjs", `--port=${port}`],
    { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = once(server, "exit");
  let output = "";
  server.stdout.on("data", (chunk) => { output += chunk; });
  server.stderr.on("data", (chunk) => { output += chunk; });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the GUI server did not start:\n${output}`)), 30_000);
      const check = () => { if (output.includes("CC2 GUI:")) { clearTimeout(timer); resolve(); } };
      server.stdout.on("data", check);
      server.once("exit", () => { clearTimeout(timer); reject(new Error(`the GUI server exited:\n${output}`)); });
      check();
    });
    await run(async (path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, body === undefined ? {} : {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() };
    });
  } finally {
    server.kill();
    await exited;
  }
}

const SEED = 909_091;

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

async function startTurnMatch(call, order) {
  const started = await call("/api/match/start", {
    left: "human", right: "s2-simple", seed: SEED, maxTurns: null, firstTo: 1,
    turnMatch: { enabled: true, order },
  });
  assert.equal(started.status, 200, JSON.stringify(started.body));
  assert.deepEqual(started.body.turnMatch, { id: TURN_MATCH_ID, enabled: true, order });
  assert.equal(started.body.pacing.authority, "turn");
  assert.equal(started.body.pacing.declaredPpsByBotId, null);
  return started.body;
}

test("the native local server plays a 1P turn match in every order", { timeout: 120_000 }, async () => {
  await withNativeServer(async (call) => {
    const humanFirst = await startTurnMatch(call, "human-first");
    assert.equal(humanFirst.mode, "alternating");
    assert.deepEqual(humanFirst.dueBotIds, ["left"]);
    const earlyStep = await call("/api/match/step", {});
    assert.equal(earlyStep.status, 409);
    assert.equal(earlyStep.body.error, "human-lock-required");
    const played = await call("/api/match/human-lock", { placement: humanPlacement(humanFirst) });
    assert.equal(played.status, 200, JSON.stringify(played.body));
    assert.deepEqual(played.body.dueBotIds, ["right"]);
    assert.equal(played.body.bots.find((bot) => bot.id === "left").stats.turns, 1);
    assert.equal(played.body.bots.find((bot) => bot.id === "right").stats.turns, 0);
    const answered = await call("/api/match/step", {});
    assert.equal(answered.status, 200, JSON.stringify(answered.body));
    assert.equal(answered.body.turnNumber, 2);
    assert.equal(answered.body.bots.find((bot) => bot.id === "right").stats.turns, 1);
    // One turn advances the shared clock by one turn, whatever the browser
    // believed the wall time to be.
    assert.equal(answered.body.clock.logicalFrame, 2 * answered.body.clock.framesPerTurn);

    const botFirst = await startTurnMatch(call, "bot-first");
    assert.deepEqual(botFirst.dueBotIds, ["right"]);
    const early = await call("/api/match/human-lock", { placement: humanPlacement(botFirst) });
    assert.equal(early.status, 409);
    assert.equal(early.body.error, "not-your-turn");
    const opened = await call("/api/match/step", {});
    assert.equal(opened.status, 200, JSON.stringify(opened.body));
    assert.equal(opened.body.bots.find((bot) => bot.id === "left").stats.turns, 0);
    assert.deepEqual(opened.body.dueBotIds, ["left"]);
    const replied = await call("/api/match/human-lock", { placement: humanPlacement(opened.body) });
    assert.equal(replied.status, 200, JSON.stringify(replied.body));
    assert.equal(replied.body.bots.find((bot) => bot.id === "left").stats.turns, 1);

    const together = await startTurnMatch(call, "simultaneous");
    assert.equal(together.mode, "simultaneous");
    assert.deepEqual([...together.dueBotIds].sort(), ["left", "right"]);
    const halfTurn = await call("/api/match/step", {});
    assert.equal(halfTurn.status, 409);
    assert.equal(halfTurn.body.error, "human-lock-required");
    const wholeTurn = await call("/api/match/human-lock", { placement: humanPlacement(together) });
    assert.equal(wholeTurn.status, 200, JSON.stringify(wholeTurn.body));
    assert.equal(wholeTurn.body.turnNumber, 1);
    for (const bot of wholeTurn.body.bots) {
      assert.equal(bot.stats.turns, 1, `${bot.id} played its half of the turn`);
    }

    // An illegal placement is refused without advancing the turn it was for.
    const refused = await call("/api/match/human-lock", {
      placement: { ...humanPlacement(wholeTurn.body), y: 39 },
    });
    assert.equal(refused.status, 422, JSON.stringify(refused.body));
    const unchanged = await call("/api/match/human-lock", { placement: humanPlacement(wholeTurn.body) });
    assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body));
    assert.equal(unchanged.body.turnNumber, 2);
  });
});

test("the native local server keeps a bot-versus-bot round paced", { timeout: 60_000 }, async () => {
  await withNativeServer(async (call) => {
    const started = await call("/api/match/start", {
      left: "s2-simple", right: "s2-simple", seed: SEED, maxTurns: null, firstTo: 1,
      turnMatch: { enabled: true, order: "bot-first" },
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.turnMatch.enabled, false, "no 1P side is nobody to take a turn against");
    assert.equal(started.body.mode, "paced");
    assert.equal(started.body.pacing.authority, "synthetic");
  });
});
