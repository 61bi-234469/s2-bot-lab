import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputExecutionRound, completedInputRoundRecording } from '../src-js/input-execution-round.mjs';
import { buildExecutedInputTtrm } from '../src-js/replay/bot-match-ttrm-export.mjs';
import { parseTtrm } from '../src-js/replay/ttrm-parser.mjs';
import { buildReplayIR } from '../src-js/replay/ttrm-simulator.mjs';
import attackFixture from '../fixtures/input-execution/two-attacks.json' with { type: 'json' };
import { handicapColumnHeights, handicapGarbageCells } from '../src-js/gui-1p-handicap-garbage.mjs';

function completedRound() {
  const round = createInputExecutionRound({ seed: 42 });
  while (round.status === 'active' && round.frame < 30) round.tick({ left: [
    { frame: round.frame, type: 'keydown', data: { key: 'hardDrop', subframe: 0 } },
  ] });
  assert.equal(round.status, 'complete');
  return round;
}

test('owned completed input round exports consumed input without legacy placement provenance', () => {
  const round = completedRound();
  const before = completedInputRoundRecording(round);
  const output = buildExecutedInputTtrm(round);
  assert.deepEqual(buildExecutedInputTtrm(round), output);
  assert.deepEqual(completedInputRoundRecording(round), before);
  const file = parseTtrm(output.text);
  assert.deepEqual(file.meta, output.provenance);
  assert.equal(file.replay.rounds[0][0].replay.results.gameoverreason, 'topout');
  assert.equal(file.replay.rounds[0][1].replay.results.gameoverreason, 'winner');
  assert.equal(output.provenance.releaseEvidence, false);
  assert.equal(output.provenance.origin, 's2-bot-lab-generated');
  const ir = buildReplayIR(file);
  assert.equal(ir.meta.origin, 's2-bot-lab-generated');
  assert.equal(ir.rounds[0].status, 'ok');
  for (const player of ir.rounds[0].players) {
    assert.equal(player.verification.scope, 'pieces-lines-sent');
    assert.equal(player.verification.matched, true);
    assert.equal(player.canonicalLockVerification, null, 'import aggregates do not assert writer canonical validation');
  }
  const unknownOrigin = structuredClone(file);
  unknownOrigin.meta = { origin: 'unknown-origin', arbitrary: 'untrusted metadata' };
  const unknownIr = buildReplayIR(unknownOrigin);
  assert.equal(Object.hasOwn(unknownIr.meta, 'origin'), false);
  assert.equal(Object.hasOwn(unknownIr.meta, 'arbitrary'), false);
  for (const [index, player] of file.replay.rounds[0].entries()) {
    assert.deepEqual(player.replay.events.filter(event => event.type !== 'end'), before.players[index].events.map(event =>
      event.type === 'start' ? { ...event, data: {} } : event));
    assert.equal(player.replay.options.gameid, index + 1);
    assert.equal(Object.hasOwn(player.replay.options, 'allowharddrop'), false);
    assert.equal(player.replay.options.allow_harddrop, true);
    assert.equal(player.replay.options.username, player.username);
    assert.equal(player.active, true);
    assert.equal(player.lifetime, player.replay.frames / 60 * 1000);
    assert.deepEqual(player.replay.events.at(-1).data, { reason: player.replay.results.gameoverreason });
    for (const key of ['apm', 'pps', 'vsscore']) assert.ok(Number.isFinite(player.stats[key]));
    const entry = file.replay.leaderboard[index];
    assert.equal(entry.id, player.id);
    assert.equal(entry.wins, player.alive ? 1 : 0);
    assert.deepEqual(entry.stats, player.stats);
  }
  before.players[0].observed.locks.length = 0;
  assert.equal(completedInputRoundRecording(round).players[0].observed.locks.length, 13);
});

test('writer refuses forged, uncompleted and failed round owners', () => {
  const round = createInputExecutionRound({ seed: 42 });
  assert.throws(() => buildExecutedInputTtrm(round), /completed owned input round/);
  assert.throws(() => buildExecutedInputTtrm({ status: 'complete', players: [] }), /completed owned input round/);
  assert.throws(() => round.tick({ left: [{ frame: 1, type: 'keydown', data: { key: 'rotateCW', subframe: 0 } }] }), /current-frame/);
  assert.equal(round.status, 'invalid');
  assert.throws(() => buildExecutedInputTtrm(round), /completed owned input round/);
  assert.throws(() => round.tick(), /not active/);
});

test('bidirectional Engine IGE ids and acknowledgement survive network cancellation and replay', () => {
  for (const rightDelay of [0, 2]) {
    const round = createInputExecutionRound({ seed: attackFixture.seed });
    while (round.status === 'active' && round.frame < 140) {
      const frame = round.frame;
      const inputs = {};
      for (const [id, delay] of [['left', 0], ['right', rightDelay]]) {
        const name = attackFixture.inputs[frame - delay] ?? (id === 'left' && frame >= attackFixture.inputs.length + rightDelay ? 'hardDrop' : null);
        inputs[id] = name === null ? [] : ['keydown', 'keyup'].map(type => ({ frame, type, data: { key: name, subframe: 0 } }));
      }
      round.tick(inputs);
    }
    assert.equal(round.status, 'complete');
    const recording = completedInputRoundRecording(round);
    const incoming = recording.players.map(player => player.events.filter(event => event.type === 'ige' && event.data.type === 'interaction').map(event => event.data.data));
    for (const packets of incoming) assert.deepEqual(packets.map(packet => packet.iid), packets.map((_, index) => index + 1));
    if (rightDelay === 0) {
      assert.ok(incoming.every(packets => packets.length >= 2), JSON.stringify(incoming));
      assert.ok(incoming.flat().some(packet => packet.ackiid > 0));
      assert.ok(recording.players.every(player => player.observed.garbageEvents.filter(event => event.kind === 'receive').every(event => event.amount === 0)));
    } else {
      assert.equal(incoming[0].length, 0);
      assert.equal(incoming[1].length, 2);
      assert.equal(recording.players[1].observed.recordedStats.garbage.sent, 0);
      assert.equal(recording.players[1].observed.garbageEvents.filter(event => event.kind === 'cancel').reduce((sum, event) => sum + event.amount, 0), 2);
    }
    const exported = buildExecutedInputTtrm(round);
    const players = parseTtrm(exported.text).replay.rounds[0];
    assert.equal(players.length, 2);
    for (const player of players) {
      const iges = player.replay.events.filter(event => event.type === 'ige');
      // The native receiver drops duplicate envelope IDs, including undefined.
      assert.deepEqual(iges.map(event => event.data.id), iges.map((_, index) => index));
      const pending = new Map();
      for (const event of iges) {
        assert.equal(event.data.frame, event.frame);
        const { type, data } = event.data;
        if (type === 'interaction') {
          assert.ok(Number.isSafeInteger(data.cid) && data.cid > 0);
          assert.ok(!pending.has(data.cid), 'cid identifies one incoming attack');
          assert.ok(Number.isSafeInteger(data.frame) && data.frame < event.frame);
          assert.ok(Number.isFinite(data.x) && Number.isFinite(data.y), 'native beam coordinates');
          pending.set(data.cid, data);
        } else if (type === 'interaction_confirm') {
          assert.deepEqual(data, pending.get(data.cid), 'native confirmation finds the same pending attack');
        }
      }
    }
  }
});

test('one-way fixed input pressure rises and ends in observed top-out', () => {
  const round = createInputExecutionRound({ seed: attackFixture.seed });
  while (round.status === 'active' && round.frame < 300) {
    const frame = round.frame;
    const left = attackFixture.inputs[frame];
    const right = frame >= attackFixture.inputs.length + 25 && frame % 5 === 0 ? 'hardDrop' : null;
    const tap = key => key == null ? [] : ['keydown', 'keyup'].map(type => ({ frame, type, data: { key, subframe: 0 } }));
    round.tick({ left: tap(left), right: tap(right) });
  }
  assert.equal(round.status, 'complete');
  const file = parseTtrm(buildExecutedInputTtrm(round).text);
  const ir = buildReplayIR(file);
  const receiver = ir.rounds[0].players.find(player => player.id === 'right');
  assert.ok(receiver.garbageEvents.some(event => event.kind === 'tank' && event.amount > 0));
  assert.equal(file.replay.rounds[0][1].replay.results.gameoverreason, 'topout');
  assert.equal(file.replay.leaderboard[0].wins, 1);
});

/* The writer's own refusal, reached without the request handler. A handler that
   refuses first would otherwise hide a missing or regressed guard here, and the
   file this would produce cannot be replayed: the format carries no initial
   board, so a self-replay would start from an empty field. */
test('a round started from placed garbage is refused by the export itself', () => {
  const cells = handicapGarbageCells(handicapColumnHeights(4242));
  const round = createInputExecutionRound({ seed: 42, initialGarbageById: { left: cells } });
  while (round.status === 'active' && round.frame < 30) round.tick({ left: [
    { frame: round.frame, type: 'keydown', data: { key: 'hardDrop', subframe: 0 } },
  ] });
  assert.equal(round.status, 'complete');
  assert.equal(round.refereeInitialGarbageCells('left'), 28);
  assert.equal(round.refereeInitialGarbageCells('right'), 0);
  const owned = completedInputRoundRecording(round);
  assert.equal(owned.players[0].initialGarbageCellCount, 28);
  assert.throws(() => buildExecutedInputTtrm(round), (error) => {
    assert.equal(error.name, 'BotMatchTtrmError');
    assert.equal(error.stage, 'provenance');
    assert.match(error.message, /placed garbage cannot be exported/);
    return true;
  });
  // An ordinary round from the same seed still exports, so the guard is narrow.
  const plain = createInputExecutionRound({ seed: 42 });
  while (plain.status === 'active' && plain.frame < 30) plain.tick({ left: [
    { frame: plain.frame, type: 'keydown', data: { key: 'hardDrop', subframe: 0 } },
  ] });
  assert.equal(plain.status, 'complete');
  assert.ok(buildExecutedInputTtrm(plain).text.length > 0);
});
