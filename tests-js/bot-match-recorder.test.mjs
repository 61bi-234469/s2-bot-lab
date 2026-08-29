import assert from "node:assert/strict";
import test from "node:test";

import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { guiStateToCanonical } from "../src-js/cc2-s2-adapter.mjs";
import { createBotMatch, advanceBotMatch } from "../src-js/bot-match-controller.mjs";
import { analyzeSimpleS2FinalPlacements } from "../src-js/simple-s2-bot.mjs";
import { fullStateKey } from "../src-js/state-keys.mjs";
import { clockForReplayLock } from "../src-js/replay-clock.mjs";
import {
  buildMatchReplay,
  createMatchRecording,
  finishMatchRecording,
  recordMatchLocks,
} from "../src-js/replay/bot-match-recorder.mjs";
import { validateReplayIRDocument } from "../src-js/replay/replay-ir-validation.mjs";
import { garbageViewAt } from "../src-js/replay/replay-garbage.mjs";
import { PIECE } from "../src-js/replay/pieces.mjs";
import { statsAt, visualAtFrame } from "../src-js/replay/replay-timeline.mjs";

function setup({ pendingGarbage = false } = {}) {
  const state = guiStateToCanonical(toS2GuiState(createGame(123)));
  const leftState = structuredClone(state);
  if (pendingGarbage) {
    leftState.garbage.packets = [{
      packetId: 9,
      sourceGameId: 2,
      amount: 4,
      holeSize: 1,
      arrivalFrame: 0,
      confirmed: true,
      order: 0,
    }];
  }
  const match = createBotMatch({
    bots: [
      { id: "left", gameId: 1, state: leftState },
      { id: "right", gameId: 2, state: structuredClone(state) },
    ],
    mode: "paced",
    ppsByBotId: { left: 1, right: 1 },
  });
  const submission = (botId, botState) => {
    const best = analyzeSimpleS2FinalPlacements(botState, { topN: 1 }).moves[0];
    return {
      botId,
      result: {
        transition: best.transition,
        comparison: {
          positionFingerprint: fullStateKey(botState),
          witness: { placement: best.placement },
        },
      },
    };
  };
  const submissions = [
    submission("left", leftState),
    submission("right", state),
  ];
  const after = advanceBotMatch(match, submissions);
  let recording = createMatchRecording({
    match,
    meta: { users: [{ id: "left", username: "LEFT" }, { id: "right", username: "RIGHT" }] },
  });
  recording = recordMatchLocks(recording, match, after, submissions);
  return { match, after, recording };
}

test("bot match recorder produces a replayable in-progress round", () => {
  const { after, recording } = setup();
  const round = finishMatchRecording(recording, {
    match: after,
    outcome: { complete: false, reason: "in-progress", winnerBotId: null },
  });
  const document = buildMatchReplay([round], {
    users: [{ id: "left", username: "LEFT" }, { id: "right", username: "RIGHT" }],
  });

  validateReplayIRDocument(document);
  assert.equal(document.$schema, "s2-analysis-engine/schema/match-replay/1");
  assert.equal(round.status, "ok");
  assert.equal(round.result.winnerId, null);
  assert.deepEqual(Object.values(round.result.reasons), ["in-progress", "in-progress"]);
  for (const player of round.players) {
    assert.equal(player.locks.length, 1);
    assert.equal(player.verification.matched, false);
    assert.equal(player.verification.reason, "synthetic-bot-match");
    assert.equal(player.locks[0].cells.length, 4);
    assert.equal(player.locks[0].fieldBefore.length, 230);
    assert.equal(player.locks[0].fieldAfter.length, 230);
    assert.equal(visualAtFrame(player, player.locks[0].frame).field.length, 230);
    assert.equal(statsAt(player, 1).placed, 1);
    assert.equal(garbageViewAt(player, player.locks[0].frame).gauge, player.locks[0].garbageGauge);
    assert.throws(
      () => clockForReplayLock(player, 0),
      (error) => error.code === "unverified-replay-ir",
    );
  }
});

test("completed recorder rounds copy the outcome into terminal and result", () => {
  const { after, recording } = setup();
  const round = finishMatchRecording(recording, {
    match: after,
    outcome: { complete: true, reason: "top-out", winnerBotId: "left" },
  });
  assert.equal(round.result.winnerId, "left");
  assert.equal(round.players.find((player) => player.id === "left").terminal.reason, "winner");
  assert.equal(round.players.find((player) => player.id === "right").terminal.reason, "top-out");
});

test("completed recorder rounds retain proposal classification provenance", () => {
  const { after, recording } = setup();
  const proposalResult = {
    status: "terminal",
    placement: null,
    terminal: { code: "no-legal-move" },
    failure: null,
    diagnostics: { message: "CC2 returned no suggested move", botId: "right" },
    latencyMs: 5.5,
  };
  const round = finishMatchRecording(recording, {
    match: after,
    outcome: {
      complete: true,
      reason: "no-suggested-move",
      winnerBotId: "left",
      proposalResult,
    },
  });
  assert.deepEqual(round.result.proposalResult, proposalResult);
});

test("garbage timeline and lock gauge stay consistent for synthetic matches", () => {
  const { after, recording } = setup({ pendingGarbage: true });
  const round = finishMatchRecording(recording, {
    match: after,
    outcome: { complete: false, reason: "in-progress", winnerBotId: null },
  });
  const player = round.players.find((candidate) => candidate.id === "left");
  assert.deepEqual(player.garbageEvents.slice(0, 2).map((event) => event.kind), ["receive", "confirm"]);
  const frames = new Set([0, player.terminal.frame, ...player.garbageEvents.map((event) => event.frame)]);
  for (const frame of frames) {
    const expectedGauge = player.garbageEvents
      .filter((event) => event.frame <= frame)
      .reduce((sum, event) => sum + (event.kind === "receive" ? event.amount : event.kind === "confirm" ? 0 : -event.amount), 0);
    assert.equal(garbageViewAt(player, frame).gauge, expectedGauge);
  }
  assert.equal(garbageViewAt(player, player.locks[0].frame).gauge, player.locks[0].garbageGauge);
});

test("browser ReplayIR validation rejects a missing player structure", () => {
  const { after, recording } = setup();
  const round = finishMatchRecording(recording, {
    match: after,
    outcome: { complete: false, reason: "in-progress", winnerBotId: null },
  });
  const document = buildMatchReplay([round]);
  document.rounds[0].players[0].terminal = null;
  assert.throws(() => validateReplayIRDocument(document), /terminal/);
});

test("browser ReplayIR validation accepts gray cells only on fields", () => {
  const { after, recording } = setup();
  const round = finishMatchRecording(recording, {
    match: after,
    outcome: { complete: false, reason: "in-progress", winnerBotId: null },
  });
  const document = buildMatchReplay([round]);
  document.rounds[0].players[0].locks[0].fieldAfter[0] = PIECE.GRAY;
  assert.doesNotThrow(() => validateReplayIRDocument(document));

  document.rounds[0].players[0].locks[0].next[0] = PIECE.GRAY;
  assert.throws(() => validateReplayIRDocument(document), /next is invalid/);
});
