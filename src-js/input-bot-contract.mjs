/** Explicit admission table for consumed-input execution, shared by both hosts.
 * A new generation needs its own reviewed selector binding, not a name prefix.
 * This table does not qualify legacy final-placement execution.
 */
export const INPUT_BOT_CONTRACT_ID = 'cc2-input-bot-contract/1';
export const INPUT_BOT_PROFILES = Object.freeze(Object.fromEntries([
  ['cc2-raw', 'cc2-order/1'],
  ['cc2-chouhy', 'cc2-order/1'],
  ['cc2-s2-f14', 'f14-amount-only/1'],
  // The champion's gated F14 core decides; INPUT only plans reachability.
  ['cc2-s2-champion', 'f14-core-order/1'],
  // The previous champion's gated profile on the same core (comparison).
  ['cc2-s2-champion-previous', 'f14-core-order/1'],
  // Comparison route used by the INPUT champion before its F14 core decided.
  ['cc2-s2-champion-legacy', 'f14-amount-only/1'],
].map(([type, selector]) => [type, Object.freeze({ id: INPUT_BOT_CONTRACT_ID, type, selector })])));

/** Deepest QUEUE DEPTH (current piece included) an INPUT bot may request: the
 * current piece plus the most NEXT the Triangle queue can hold (19). A deeper
 * request than the public queue offers at a spawn searches what is public.
 * Bound to `INPUT_EXECUTION_PROFILE.publicNextMaximum + 1` by the profile test. */
export const INPUT_QUEUE_DEPTH_MAXIMUM = 20;
/** Shallowest QUEUE DEPTH an INPUT bot may request: the current piece and one
 * NEXT. With the current piece alone a native CC2 INPUT search never answers and
 * the F14 core traps, so 1 is refused for every INPUT bot. */
export const INPUT_QUEUE_DEPTH_MINIMUM = 2;

export function isInputBotType(type) {
  return Object.hasOwn(INPUT_BOT_PROFILES, type);
}

export function inputBotProfile(type) {
  if (!isInputBotType(type)) throw new Error(`unsupported input bot ${type}`);
  return INPUT_BOT_PROFILES[type];
}
