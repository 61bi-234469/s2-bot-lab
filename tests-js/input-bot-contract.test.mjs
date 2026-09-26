import test from 'node:test';
import assert from 'node:assert/strict';
import targets from '../fixtures/input-execution/spin-targets.json' with { type: 'json' };
import { INPUT_DECISION_REQUEST_ID, inputDecisionFingerprint } from '../src-js/input-decision-request.mjs';
import { isInputBotType } from '../src-js/input-bot-contract.mjs';
import { amountOnlyDecisionFingerprint, isAdr062QualifiedStaticType } from '../src-js/s2-amount-only-decision-request.mjs';
import { orderQualifiedInputCandidates, resolveQualifiedInputSubmission } from '../src-js/s2-input-public-resolver.mjs';
import { rankS2AmountOnlyPublicCandidates } from '../src-js/s2-amount-only-public-candidates.mjs';
import { QUALIFIED_STATIC_CC2_RESOLVER_POLICY } from '../src-js/s2-amount-only-public-resolver.mjs';

test('input admission keeps raw and chouhy outside the F14 final-placement resolver', () => {
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
  assert.equal(isInputBotType('cc2-s2-champion-legacy'), true);
  assert.equal(isAdr062QualifiedStaticType('cc2-s2-champion-legacy'), true);
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

test('former F14 rescue champion restores the legacy F14 selector on saved positions', () => {
  for (const { request } of targets.cases) {
    assert.deepEqual(orderQualifiedInputCandidates({ ...request, type: 'cc2-s2-champion-legacy' }),
      orderQualifiedInputCandidates({ ...request, type: 'cc2-s2-f14' }));
  }
});

test('decided INPUT orders preserve every legal projection without repeating policy evaluation', () => {
  const view = ({ cc2Rank, identity, move, placement, projection }) => ({ cc2Rank, identity, move, placement, projection });
  for (const { request } of targets.cases) {
    const legacy = rankS2AmountOnlyPublicCandidates(request.decision, request.moves,
      { ...QUALIFIED_STATIC_CC2_RESOLVER_POLICY, allowCompleteReturnedPrefix: true });
    const expected = [...legacy.candidates].sort((a, b) => a.cc2Rank - b.cc2Rank).map(view);
    for (const type of ['cc2-raw', 'cc2-chouhy', 'cc2-s2-champion']) {
      const actual = orderQualifiedInputCandidates({ ...request, type });
      assert.deepEqual(actual.candidates.map(view), expected);
      assert.equal(actual.first, actual.candidates[0]);
      for (const candidate of actual.candidates) {
        for (const key of ['conversion', 'features', 's2Score', 'solvency', 'selectionScore']) {
          assert.equal(Object.hasOwn(candidate, key), false, `${type} must not compute ${key}`);
        }
      }
    }
  }
});
