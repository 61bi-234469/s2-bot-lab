/** Explicit admission table for consumed-input execution, shared by both hosts.
 * A new generation needs its own reviewed selector binding, not a name prefix.
 * This table does not qualify legacy final-placement execution.
 */
export const INPUT_BOT_CONTRACT_ID = 'cc2-input-bot-contract/1';
export const INPUT_BOT_PROFILES = Object.freeze(Object.fromEntries([
  ['cc2-raw', 'cc2-order/1'],
  ['cc2-chouhy', 'cc2-order/1'],
  ['cc2-s2-f14', 'f14-amount-only/1'],
  ['cc2-s2-champion', 'f14-amount-only/1'],
].map(([type, selector]) => [type, Object.freeze({ id: INPUT_BOT_CONTRACT_ID, type, selector })])));

export function isInputBotType(type) {
  return Object.hasOwn(INPUT_BOT_PROFILES, type);
}

export function inputBotProfile(type) {
  if (!isInputBotType(type)) throw new Error(`unsupported input bot ${type}`);
  return INPUT_BOT_PROFILES[type];
}
