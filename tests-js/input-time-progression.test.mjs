import assert from 'node:assert/strict';
import test from 'node:test';
import S2_MANIFEST from '../rulesets/tetrio-s2-v19-beta-1-5-0-observed.json' with { type: 'json' };
import { buildEngineConfig, inputExecutionTimeProgression, inputExecutionOptions,
  INPUT_EXECUTION_PROFILE } from '../src-js/replay/engine-config.mjs';
import { RULESET_IDS, resolvePlacementRules, timeProgressionRulesetId } from '../src-js/ruleset-profiles.mjs';
import { evaluatePlacement } from '../src-js/triangle/placement-adapter.mjs';
import multiplierFixture from '../fixtures/golden/placement-dynamic-multiplier-accumulation.json' with { type: 'json' };
import { createInputExecutionRound } from '../src-js/input-execution-round.mjs';
import { createInputReplaySession } from '../src-js/replay/ttrm-simulator.mjs';
import { forecastInputBoundary, planInputTarget } from '../src-js/triangle/input-target-planner.mjs';
import { createGuiInputMatchHandlers } from '../src-js/gui-input-match.mjs';
import { buildExecutedInputTtrm } from '../src-js/replay/bot-match-ttrm-export.mjs';
import { parseTtrm } from '../src-js/replay/ttrm-parser.mjs';
import { buildReplayIR } from '../src-js/replay/ttrm-simulator.mjs';
import { dynamicValue } from '../src-js/dynamic-values.mjs';
import { INPUT_DECISION_REQUEST_ID } from '../src-js/input-decision-request.mjs';

const inputRound = options => ({ id: 'fixture', replay: {
  frames: 0, events: [], options, results: { stats: { garbage: { sent: 0 } } } } });

const completedRound = timeProgression => {
  const round = createInputExecutionRound({ seed: 42, timeProgression });
  while (round.status === 'active' && round.frame < 30) round.tick({ left: [
    { frame: round.frame, type: 'keydown', data: { key: 'hardDrop', subframe: 0 } },
  ] });
  assert.equal(round.status, 'complete');
  return round;
};

test('disabling time progression freezes gravity and the garbage multiplier and nothing else', () => {
  const canonical = inputExecutionOptions({ seed: 7 });
  const disabled = inputExecutionOptions({ seed: 7, timeProgression: false });
  // Every elapsed-time escalation this ruleset has: the other rising values are
  // already static, so the two keys below are the whole of its time progression.
  assert.ok(canonical.gincrease > 0, 'the observed S2 ruleset raises gravity over time');
  assert.ok(canonical.garbageincrease > 0, 'the observed S2 ruleset raises the garbage multiplier over time');
  assert.equal(canonical.garbagecapincrease, 0, 'the observed cap is already static');
  assert.equal(canonical.garbagecapmargin, 0);
  assert.equal(canonical.messiness_timeout, 0);
  assert.equal(canonical.survival_cap, 0);
  assert.equal(disabled.gincrease, 0);
  assert.equal(disabled.garbageincrease, 0);
  for (const key of Object.keys(canonical)) {
    if (['gincrease', 'garbageincrease'].includes(key)) continue;
    assert.deepEqual(disabled[key], canonical[key], `${key} must stay at its observed value`);
  }
  const config = buildEngineConfig(disabled, []);
  assert.deepEqual(config.gravity, { value: canonical.g, increase: 0, marginTime: canonical.gmargin });
  assert.deepEqual(config.garbage.multiplier,
    { value: canonical.garbagemultiplier, increase: 0, marginTime: canonical.garbagemargin });
  const late = (base, increase, marginFrames) => dynamicValue({ base, increase, marginFrames }, marginFrames + 6000);
  assert.equal(late(disabled.g, disabled.gincrease, disabled.gmargin), canonical.g);
  assert.equal(late(disabled.garbagemultiplier, disabled.garbageincrease, disabled.garbagemargin), canonical.garbagemultiplier);
  assert.ok(late(canonical.g, canonical.gincrease, canonical.gmargin) > canonical.g);
  assert.ok(late(canonical.garbagemultiplier, canonical.garbageincrease, canonical.garbagemargin) > canonical.garbagemultiplier);
  assert.equal(inputExecutionTimeProgression(canonical), true);
  assert.equal(inputExecutionTimeProgression(disabled), false);
  assert.throws(() => inputExecutionOptions({ seed: 7, timeProgression: 'off' }), /time progression must be boolean/);
  assert.throws(() => createInputExecutionRound({ seed: 7, timeProgression: null }), /time progression must be boolean/);
});

/* The referee compares every executed lock against the S2 Simulator, including
   the attack it produced. A fixed-rules round therefore has to be refereed
   under a ruleset whose multiplier is fixed too, and that is a different rule
   set, so it carries its own identity instead of the canonical S2 one. */
test('a fixed-rules round is refereed under its own ruleset identity', () => {
  assert.equal(timeProgressionRulesetId(true), RULESET_IDS.s2Observed);
  assert.equal(timeProgressionRulesetId(true), INPUT_EXECUTION_PROFILE.rulesetId);
  assert.equal(timeProgressionRulesetId(false), RULESET_IDS.s2ObservedStaticTime);
  assert.notEqual(RULESET_IDS.s2ObservedStaticTime, RULESET_IDS.s2Observed);
  const canonical = resolvePlacementRules(RULESET_IDS.s2Observed);
  const fixed = resolvePlacementRules(RULESET_IDS.s2ObservedStaticTime);
  assert.deepEqual(fixed.garbageMultiplier, { ...canonical.garbageMultiplier, increase: 0 });
  assert.ok(canonical.garbageMultiplier.increase > 0, 'the canonical S2 profile is left alone');
  for (const key of Object.keys(canonical)) {
    if (key === 'garbageMultiplier') continue;
    assert.deepEqual(fixed[key], canonical[key], `${key} must match the observed S2 profile`);
  }
});

test('the canonical input profile admits both time rules and no other rule value', () => {
  for (const timeProgression of [true, false]) {
    const options = inputExecutionOptions({ seed: 11, timeProgression });
    const session = createInputReplaySession(inputRound(options), { canonicalProfile: INPUT_EXECUTION_PROFILE.id });
    assert.equal(session.canonicalProfile, INPUT_EXECUTION_PROFILE.id);
  }
  for (const gravity of [{ gincrease: 0.01 }, { g: 0.5 }, { gmargin: 0 },
    { garbageincrease: 0.01 }, { garbagemargin: 0 }, { garbagemultiplier: 2 }]) {
    assert.throws(() => createInputReplaySession(
      inputRound({ ...inputExecutionOptions({ seed: 11 }), ...gravity }),
      { canonicalProfile: INPUT_EXECUTION_PROFILE.id }), /canonical input profile option mismatch/);
  }
});

test('the round publishes its time rule to the planners and refuses an invalid one', () => {
  assert.equal(createInputExecutionRound({ seed: 3 }).timeProgression, true);
  assert.equal(createInputExecutionRound({ seed: 3, timeProgression: false }).timeProgression, false);
  const round = createInputExecutionRound({ seed: 3 });
  const { decision, movement } = round.publicState('left');
  const request = { id: INPUT_DECISION_REQUEST_ID, sessionKey: 'fixture', decision, moves: [],
    type: 'cc2-s2-f14', engine: { botType: 'cc2-s2-f14', engineId: 'cc2-s2-f14' } };
  assert.throws(() => forecastInputBoundary(request, movement, 2, { timeProgression: 1 }), /time progression/);
  assert.throws(() => planInputTarget(request, movement, { placement: {} }, { timeProgression: 1 }), /time progression/);
});

test('a match started with time progression off records it and still exports .ttrm', async () => {
  const handlers = createGuiInputMatchHandlers({ runtime: {
    propose: async () => new Promise(() => {}), resolveInput: async () => assert.fail('no proposal is pending'),
    closeSessions: async () => {} } });
  const body = { left: 'human', right: 'cc2-s2-f14', seed: 42, maxTurns: null };
  const started = await handlers.handle({ method: 'POST', path: '/api/input-match/start',
    body: { ...body, timeProgression: false } });
  assert.equal(started.body.config.timeProgression, false);
  const canonical = await handlers.handle({ method: 'POST', path: '/api/input-match/start', body });
  assert.equal(canonical.body.config.timeProgression, true, 'the observed rule stays the default');
  const invalid = await handlers.handle({ method: 'POST', path: '/api/input-match/start',
    body: { ...body, timeProgression: 'off' } });
  assert.equal(invalid.status, 409);
  assert.match(invalid.body.error, /TIME PROGRESSION/);

  const file = parseTtrm(buildExecutedInputTtrm(completedRound(false)).text);
  for (const player of file.replay.rounds[0]) {
    assert.equal(player.replay.options.gincrease, 0);
    assert.equal(player.replay.options.garbageincrease, 0);
    assert.equal(player.replay.options.g, S2_MANIFEST.normalizedOptions.g);
    assert.equal(player.replay.options.gmargin, S2_MANIFEST.normalizedOptions.gmargin);
    assert.equal(player.replay.options.garbagemultiplier, S2_MANIFEST.normalizedOptions.garbagemultiplier);
    assert.equal(player.replay.options.garbagemargin, S2_MANIFEST.normalizedOptions.garbagemargin);
  }
  const ir = buildReplayIR(file);
  assert.equal(ir.rounds[0].status, 'ok');
  for (const player of ir.rounds[0].players) assert.equal(player.verification.matched, true);
});

/* The referee compares the Engine's own attack against the S2 Simulator's, so
   the two have to read the same multiplier spec. This is the coupling a
   fixed-rules round would break if only the Engine side were switched off: past
   the S2 margin the Simulator would expect a larger attack than the Engine
   produced and the round would be rejected as invalid execution. */
test('the referee Engine and the S2 Simulator read the same multiplier and cap under both time rules', () => {
  for (const timeProgression of [true, false]) {
    const config = buildEngineConfig(inputExecutionOptions({ seed: 5, timeProgression }), []);
    const rules = resolvePlacementRules(timeProgressionRulesetId(timeProgression));
    assert.deepEqual(config.garbage.multiplier,
      { value: rules.garbageMultiplier.base, increase: rules.garbageMultiplier.increase,
        marginTime: rules.garbageMultiplier.marginFrames });
    assert.deepEqual(
      { value: config.garbage.cap.value, increase: config.garbage.cap.increase, marginTime: config.garbage.cap.marginTime },
      { value: rules.garbageCap.base, increase: rules.garbageCap.increase, marginTime: rules.garbageCap.marginFrames });
  }
});

/* The same placement, long past the S2 garbage margin, under each ruleset: the
   fixed-rules one sends its unscaled attack while the canonical one still ramps. */
test('a late placement keeps its unscaled attack under the fixed-rules ruleset', () => {
  const { state, action } = multiplierFixture.input;
  assert.ok(state.time.logicalFrame > 10800, 'the fixture is past the S2 garbage margin');
  const under = rulesetId => evaluatePlacement({ ...state, rulesetId }, action.placement,
    resolvePlacementRules(rulesetId)).attackStages;
  const canonical = under(RULESET_IDS.s2Observed);
  const fixed = under(RULESET_IDS.s2ObservedStaticTime);
  assert.equal(fixed.raw, canonical.raw);
  assert.equal(fixed.afterMultiplier, fixed.raw);
  assert.ok(canonical.afterMultiplier > canonical.raw, 'the canonical S2 ruleset still ramps');
});
