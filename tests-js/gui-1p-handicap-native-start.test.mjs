import assert from "node:assert/strict";
import test from "node:test";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";

import {
  HANDICAP_GARBAGE_CELLS,
  HANDICAP_GARBAGE_ID,
  HANDICAP_MAX_COLUMN_HEIGHT,
  handicapColumnHeights,
} from "../src-js/gui-1p-handicap-garbage.mjs";

/* `npm start` serves the native local server, which owns its own legacy start
   handler. Reading its source would not prove which board it hands out, so this
   exercises the real endpoint. `You (1P)` against the S2 placement bot needs no
   CC2 binary, so the canary runs everywhere the suite runs. */
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

const stacked = (board) => board.flat().filter((cell) => cell === "G").length;
const occupied = (board) => board.flat().filter((cell) => cell !== null).length;
const columnHeights = (board) => Array.from({ length: 10 }, (_, x) =>
  board.reduce((total, row) => total + (row[x] === "G" ? 1 : 0), 0));

test("the native local server opens a 1P handicap round on the generated terrain", { timeout: 60_000 }, async () => {
  await withNativeServer(async (call) => {
    const seed = 909_090;
    const started = await call("/api/match/start", {
      left: "human", right: "s2-simple", seed, handicap: { enabled: true }, maxTurns: null, firstTo: 1,
    });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    assert.equal(started.body.humanSide, "left");
    const [left, right] = started.body.bots;
    assert.equal(stacked(left.board), HANDICAP_GARBAGE_CELLS);
    assert.equal(occupied(left.board), HANDICAP_GARBAGE_CELLS, "only garbage cells are placed");
    assert.equal(occupied(right.board), 0, "the bot side keeps an empty board");
    assert.equal(left.board.filter((row) => row.every((cell) => cell !== null)).length, 0,
      "a complete row would be cleared differently by the two execution paths");
    assert.ok(left.board[0].includes("G"), "the stack starts on the floor");
    assert.ok(Math.max(...columnHeights(left.board)) <= HANDICAP_MAX_COLUMN_HEIGHT);
    assert.equal(Math.min(...columnHeights(left.board)), 0);
    // The same generator as the shared module, from the same match seed.
    assert.deepEqual(columnHeights(left.board), [...handicapColumnHeights(seed)]);
    assert.equal(started.body.handicap.id, HANDICAP_GARBAGE_ID);
    assert.equal(started.body.handicap.seed, seed);
    assert.equal(started.body.replayMeta.match.handicap.enabled, true);
    assert.equal(started.body.replayMeta.match.handicap.seed, undefined,
      "the per-game terrain does not belong to the series meta");

    const round = await call("/api/match/round");
    assert.equal(round.status, 200, JSON.stringify(round.body));
    assert.equal(round.body.handicap.seed, seed);
    assert.deepEqual([...round.body.handicap.columnHeights], [...handicapColumnHeights(seed)]);
    const recorded = round.body.players.find((player) => player.id === "left").initial.field;
    assert.equal(recorded.filter((cell) => cell === 8).length, HANDICAP_GARBAGE_CELLS,
      "the recorded initial board is the board that was played");
  });
});

test("the native local server leaves an ordinary round empty and refuses a malformed handicap",
  { timeout: 60_000 }, async () => {
    await withNativeServer(async (call) => {
      const off = await call("/api/match/start", {
        left: "human", right: "s2-simple", seed: 11, handicap: { enabled: false },
      });
      assert.equal(off.status, 200, JSON.stringify(off.body));
      assert.equal(off.body.bots.every((bot) => occupied(bot.board) === 0), true);
      assert.equal(off.body.handicap.enabled, false);

      const absent = await call("/api/match/start", { left: "human", right: "s2-simple", seed: 11 });
      assert.equal(absent.status, 200, JSON.stringify(absent.body));
      assert.equal(absent.body.handicap.enabled, false);
      assert.equal((await call("/api/match/round")).body.handicap, null);

      // No 1P side is nothing to handicap, and must not block the start.
      const botsOnly = await call("/api/match/start", {
        left: "s2-simple", right: "s2-simple", seed: 11, handicap: { enabled: true },
      });
      assert.equal(botsOnly.status, 200, JSON.stringify(botsOnly.body));
      assert.equal(botsOnly.body.handicap.enabled, false);
      assert.equal(botsOnly.body.bots.every((bot) => occupied(bot.board) === 0), true);

      for (const handicap of [{ enabled: "yes" }, [], 28]) {
        const rejected = await call("/api/match/start", {
          left: "human", right: "s2-simple", seed: 11, handicap,
        });
        assert.equal(rejected.status, 400, JSON.stringify(rejected.body));
      }
    });
  });
