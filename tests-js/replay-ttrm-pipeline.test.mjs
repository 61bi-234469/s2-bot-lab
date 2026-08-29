import assert from "node:assert/strict";
import test from "node:test";

import { convertEngineBoard } from "../src-js/replay/board-converter.mjs";
import { buildEngineConfig } from "../src-js/replay/engine-config.mjs";
import { FIELD_CELLS, PIECE, minoToPiece, pieceName } from "../src-js/replay/pieces.mjs";
import { MAX_TTRM_TEXT_LENGTH, TtrmError, parseTtrm } from "../src-js/replay/ttrm-parser.mjs";
import { DEFAULT_TTRM_OPTIONS, resolveTtrmOptions } from "../src-js/replay/ttrm-options.mjs";
import { buildReplayIR, simulatePlayerRound } from "../src-js/replay/ttrm-simulator.mjs";

function playerRound(id, overrides = {}) {
  return {
    id,
    username: id,
    alive: true,
    replay: {
      frames: 90,
      events: [{ frame: 0, type: "start" }],
      options: { seed: 4242, username: id },
      results: {
        stats: { piecesplaced: 0, lines: 0, garbage: { sent: 0, received: 0, attack: 0, cleared: 0 } },
        gameoverreason: "winner",
      },
      ...overrides,
    },
  };
}

function ttrmText(rounds, overrides = {}) {
  return JSON.stringify({
    version: 1,
    gamemode: "league",
    ts: "2026-08-15T00:00:00.000Z",
    users: [{ id: "alpha", username: "alpha" }, { id: "bravo", username: "bravo" }],
    replay: { rounds },
    ...overrides,
  });
}

test("a wrapped export is unwrapped to the level that owns the rounds", () => {
  const inner = JSON.parse(ttrmText([[playerRound("alpha"), playerRound("bravo")]]));
  const file = parseTtrm(JSON.stringify({ replay: { replay: inner } }));
  assert.equal(file.replay.rounds.length, 1);
  assert.equal(file.replay.rounds[0][0].id, "alpha");
});

test("only the verified multiplayer format is accepted", () => {
  const cases = [
    [JSON.stringify({ version: 2, replay: { rounds: [[playerRound("alpha")]] } }), "version"],
    [JSON.stringify({ version: 1, replay: { rounds: [] } }), "structure"],
    [JSON.stringify({ version: 1, replay: { rounds: [[]] } }), "structure"],
    [JSON.stringify({ rounds: [] }), "structure"],
    ["{ not json", "json"],
  ];
  for (const [text, stage] of cases) {
    assert.throws(() => parseTtrm(text), (error) => error instanceof TtrmError && error.stage === stage, text);
  }
});

test("a replay whose events or frame counts are unusable is refused before any engine runs", () => {
  const missingResults = playerRound("alpha");
  delete missingResults.replay.results;
  const badFrames = playerRound("alpha", { frames: -1 });
  const badEvent = playerRound("alpha", { events: [{ type: "keydown" }] });
  for (const player of [missingResults, badFrames, badEvent]) {
    assert.throws(
      () => parseTtrm(ttrmText([[player]])),
      (error) => error instanceof TtrmError && error.stage === "structure",
    );
  }
});

test("a file past the accepted size is refused without being parsed", () => {
  assert.throws(
    () => parseTtrm("x".repeat(MAX_TTRM_TEXT_LENGTH + 1)),
    (error) => error instanceof TtrmError && error.stage === "size",
  );
});

test("options merge default, end event and replay options in that order", () => {
  const { options, warnings } = resolveTtrmOptions({
    options: { garbagecap: 12, seed: 7 },
    events: [{ frame: 30, type: "end", data: { options: { garbagecap: 8, kickset: "SRS" } } }],
  });
  assert.equal(options.garbagecap, 12, "replay options win over the end event");
  assert.equal(options.kickset, "SRS", "the end event still wins over the measured default");
  assert.equal(options.spinbonuses, DEFAULT_TTRM_OPTIONS.spinbonuses);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /garbagecap/);
});

test("the engine config keeps the fields Triangle 4.2.7 requires", () => {
  const config = buildEngineConfig(DEFAULT_TTRM_OPTIONS, [2]);
  assert.equal(config.options.stock, 0);
  assert.equal(config.misc.stride, false);
  assert.deepEqual(config.misc.allowed.undo, false);
  assert.deepEqual(config.misc.allowed.retry, false);
  assert.deepEqual(config.multiplayer, { opponents: [2], passthrough: "zero" });
  assert.equal(config.board.buffer, 20);
});

test("the board window keeps the bottom 23 rows and reports what it clipped", () => {
  const tile = (mino) => ({ mino, connections: 0 });
  const state = Array.from({ length: 40 }, () => Array(10).fill(null));
  state[0][3] = tile("t");
  state[22][9] = tile("gb");
  state[24][0] = tile("i");
  const board = convertEngineBoard(state);
  assert.equal(board.field.length, FIELD_CELLS);
  assert.equal(board.field[3], PIECE.T);
  assert.equal(board.field[22 * 10 + 9], PIECE.GRAY, "garbage and unknown minos are gray");
  assert.equal(board.sourceHeight, 25);
  assert.equal(board.clippedRowCount, 2);
});

test("mino symbols and cell codes round-trip through the shared vocabulary", () => {
  assert.equal(minoToPiece("t"), PIECE.T);
  assert.equal(minoToPiece("bomb"), PIECE.GRAY);
  assert.equal(pieceName(PIECE.GRAY), "G");
  assert.equal(pieceName(PIECE.EMPTY), null);
});

test("a player round replays through the pinned engine into a verified ReplayIR", () => {
  const player = simulatePlayerRound(playerRound("alpha"));
  assert.equal(player.verification.matched, true);
  assert.equal(player.locks.length, 0, "this scenario records no placement");
  assert.equal(player.terminal.frame, 90, "the engine keeps ticking to replay.frames");
  assert.equal(player.initial.frame, 0);
  assert.ok(player.initial.next.length > 0, "the opening queue is read before the first tick");
  assert.equal(player.initial.hold, null);
  assert.equal(player.initial.field.length, FIELD_CELLS);
  // The visual timeline is the playback source: it must open on frame 0 for
  // every channel so a cursor at the start has something to show.
  for (const channel of ["active", "boards", "queues", "garbage"]) {
    assert.equal(player.visual[channel][0].frame, 0, channel);
  }
  assert.equal(player.resolvedOptions.seed, 4242);
  assert.deepEqual(player.optionWarnings, []);
});

test("the whole file becomes rounds carrying both players and the recorded result", () => {
  const file = parseTtrm(ttrmText([[playerRound("alpha"), playerRound("bravo")]]));
  const ir = buildReplayIR(file);
  assert.equal(ir.rounds.length, 1);
  const round = ir.rounds[0];
  assert.equal(round.status, "ok");
  assert.equal(round.players.length, 2);
  assert.equal(round.endFrame, 90);
  assert.equal(round.result.winnerId, "alpha", "the first recorded winner is the round winner");
  assert.deepEqual(ir.meta.users.map((user) => user.id), ["alpha", "bravo"]);
  assert.equal(ir.meta.gamemode, "league");
  assert.ok(Number.isInteger(ir.meta.parseMs));
});

test("a round the engine cannot reproduce is reported instead of played", () => {
  const disagreeing = playerRound("alpha");
  disagreeing.replay.results.stats.piecesplaced = 3;
  const ir = buildReplayIR(parseTtrm(ttrmText([[disagreeing]])));
  assert.equal(ir.rounds[0].status, "failed");
  assert.equal(ir.rounds[0].failure.stage, "verify");
  assert.match(ir.rounds[0].failure.message, /pieces 0\/3/);

  const unsupportedBoard = playerRound("alpha");
  unsupportedBoard.replay.options.boardwidth = 12;
  const refused = buildReplayIR(parseTtrm(ttrmText([[unsupportedBoard]])));
  assert.equal(refused.rounds[0].status, "failed");
  assert.equal(refused.rounds[0].failure.stage, "validate");
  assert.deepEqual(refused.rounds[0].players, []);
});
