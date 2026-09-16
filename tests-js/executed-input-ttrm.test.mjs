import assert from 'node:assert/strict';
import test from 'node:test';
import { createInputExecutionRound, completedInputRoundRecording } from '../src-js/input-execution-round.mjs';
import { buildExecutedInputTtrm } from '../src-js/replay/bot-match-ttrm-export.mjs';
import { parseTtrm } from '../src-js/replay/ttrm-parser.mjs';
import attackFixture from '../fixtures/input-execution/two-attacks.json' with { type: 'json' };

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
  assert.equal(file.replay.rounds[0][0].replay.results.gameoverreason, 'topout');
  assert.equal(file.replay.rounds[0][1].replay.results.gameoverreason, 'winner');
  assert.equal(output.provenance.releaseEvidence, false);
  assert.equal(output.provenance.origin, 's2-bot-lab-generated');
  for (const [index, player] of file.replay.rounds[0].entries()) {
    const normalized = (event) => event.type === 'start' ? { ...event, data: event.data ?? {} } : event;
    assert.deepEqual(player.replay.events.filter(event => event.type !== 'end').map(normalized), before.players[index].events.map(normalized));
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
    assert.equal(parseTtrm(exported.text).replay.rounds[0].length, 2);
  }
});
