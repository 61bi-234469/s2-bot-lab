import assert from "node:assert/strict";
import test from "node:test";

import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { guiStateToCanonical } from "../src-js/cc2-s2-adapter.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";
import { createBotMatch, advanceBotMatch } from "../src-js/bot-match-controller.mjs";
import { fullStateKey } from "../src-js/state-keys.mjs";
import {
  createMatchRecording,
  recordMatchLocks,
} from "../src-js/replay/bot-match-recorder.mjs";
import { BotMatchTtrmError, buildBotMatchTtrm } from "../src-js/replay/bot-match-ttrm-export.mjs";
import { parseTtrm } from "../src-js/replay/ttrm-parser.mjs";

function makeRecording(ttrmCompatible = true, { turns = 2, allowHold = true } = {}) {
  const seed = 1506;
  const initial = structuredClone(toS2GuiState(createGame(seed, {
    queueModel: ttrmCompatible ? "triangle-7-bag" : "legacy-lcg",
  })));
  const initialState = guiStateToCanonical(initial);
  let match = createBotMatch({
    bots: [
      { id: "left", gameId: 1, state: initialState },
      { id: "right", gameId: 2, state: structuredClone(initialState) },
    ],
    mode: "paced",
    ppsByBotId: { left: 1, right: 1 },
  });
  const meta = {
    ts: "2026-08-15T00:00:00.000Z",
    match: { seed, ttrmCompatible, queueModel: ttrmCompatible ? "triangle-7-bag" : "legacy-lcg" },
    users: [{ id: "left", username: "LEFT" }, { id: "right", username: "RIGHT" }],
  };
  let recording = createMatchRecording({ match, meta });
  for (let turn = 0; turn < turns; turn += 1) {
    const submissions = match.bots.map((bot) => {
      const best = analyzeSimpleS2FinalPlacements(bot.state, { topN: 1, allowHold }).moves[0];
      return {
        botId: bot.id,
        result: { transition: best.transition, comparison: { positionFingerprint: fullStateKey(bot.state) } },
        move: best.placement,
      };
    });
    const before = match;
    match = advanceBotMatch(match, submissions);
    recording = recordMatchLocks(recording, before, match, submissions);
  }
  return { recording, match };
}

test("TTRM-compatible bot match exports only after Triangle self-verification", () => {
  const { recording } = makeRecording(true);
  const text = buildBotMatchTtrm(recording);
  const file = parseTtrm(text);
  assert.equal(file.version, 1);
  assert.equal(file.replay.rounds[0].length, 2);
  assert.ok(file.replay.rounds[0][0].replay.events.some((event) => event.type === "keydown"));
  assert.ok(file.replay.rounds[0][0].replay.events.some((event) => event.type === "end"));
});

test("legacy bot matches refuse a fake TTRM conversion", () => {
  const { recording } = makeRecording(false);
  assert.throws(
    () => buildBotMatchTtrm(recording),
    (error) => error instanceof BotMatchTtrmError && error.stage === "compatibility",
  );
});

test("TTRM-safe no-hold matches retain an input witness beyond the opening", () => {
  const { recording } = makeRecording(true, { turns: 8, allowHold: false });
  const text = buildBotMatchTtrm(recording);
  assert.equal(parseTtrm(text).replay.rounds[0][0].replay.results.stats.piecesplaced, 8);
});
