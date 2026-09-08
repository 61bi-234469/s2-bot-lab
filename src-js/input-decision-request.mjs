import { assertS2AmountOnlyDecisionRequest } from './s2-amount-only-decision-request.mjs';
import { assertAmountOnlyDecisionPayload } from './input-decision-payload.mjs';
import { inputBotProfile } from './input-bot-contract.mjs';
import { canonicalize } from '../scripts/cs1.mjs';
import { sha256Hex } from './sha256.mjs';

export const INPUT_DECISION_REQUEST_ID = 'cc2-input-decision-request/1';

export function assertInputDecisionRequest(request) {
  // Preserve existing F14 callers and their fingerprints.
  if (request?.id !== INPUT_DECISION_REQUEST_ID) return assertS2AmountOnlyDecisionRequest(request);
  inputBotProfile(request.type);
  assertAmountOnlyDecisionPayload(request);
  if (request.engine.engineId !== request.type) throw new Error('input decision engine identity mismatch');
}

export function inputDecisionFingerprint(request) {
  assertInputDecisionRequest(request);
  const { sessionKey: _sessionKey, ...fingerprinted } = request;
  return `${request.id}:sha256:${sha256Hex(canonicalize(fingerprinted))}`;
}
