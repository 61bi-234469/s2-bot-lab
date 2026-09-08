import test from 'node:test';
import assert from 'node:assert/strict';
import targets from '../fixtures/input-execution/spin-targets.json' with { type: 'json' };
import { INPUT_DECISION_REQUEST_ID, inputDecisionFingerprint } from '../src-js/input-decision-request.mjs';
import { isInputBotType } from '../src-js/input-bot-contract.mjs';
import { amountOnlyDecisionFingerprint, isAdr062QualifiedStaticType } from '../src-js/s2-amount-only-decision-request.mjs';
import { resolveQualifiedInputSubmission } from '../src-js/s2-input-public-resolver.mjs';

test('input admission does not widen legacy qualification or change legacy fingerprints', () => {
  const { request } = targets.cases[0];
  assert.equal(inputDecisionFingerprint(request), amountOnlyDecisionFingerprint(request));
  for (const type of ['cc2-raw', 'cc2-chouhy']) {
    assert.equal(isInputBotType(type), true);
    assert.equal(isAdr062QualifiedStaticType(type), false);
    const value = { ...request, id: INPUT_DECISION_REQUEST_ID, type, engine: { botType: type, engineId: type } };
    assert.doesNotThrow(() => inputDecisionFingerprint(value));
    assert.throws(() => amountOnlyDecisionFingerprint(value));
    assert.throws(() => inputDecisionFingerprint({ ...value, engine: { ...value.engine, engineId: 'cc2-s2-f14' } }), /identity/);
    assert.throws(() => inputDecisionFingerprint({ ...value, packets: [] }), /keys/);
  }
  assert.equal(isInputBotType('cc2-s2-future'), false);
  assert.equal(isInputBotType('toString'), false);
});

test('raw and chouhy retain proposal order rather than adopting F14 ranking', () => {
  const source = targets.cases[0];
  for (const type of ['cc2-raw', 'cc2-chouhy']) {
    const request = { ...source.request, id: INPUT_DECISION_REQUEST_ID, type, engine: { botType: type, engineId: type } };
    const result = resolveQualifiedInputSubmission(request, source.movement, { maxNodes: 2, maxTimeMs: 1000 });
    assert.deepEqual(result.attempts.map(attempt => attempt.cc2Rank), [0, 1]);
    assert.equal(result.attempts[0].adoptionRank, 0);
  }
});
