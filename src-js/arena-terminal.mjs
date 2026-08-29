export const HEADLESS_ARENA_TERMINAL_POLICY = "spawn-blockout-topoutisclear-false-loss/1";
export const HEADLESS_ARENA_LOCKOUT_POLICY = "nolockout-true-spawn-blockout-only/1";

/**
 * Binds the Engine's spawn-blockout fact to the observed room terminal option.
 * This arena supports only the reviewed `topoutisclear: false` identity.
 */
export function classifyArenaSpawnBlockouts({ topOutIsClear, blockedBotIds, botIds }) {
  if (topOutIsClear !== false) {
    throw new Error("headless arena supports only topoutisclear=false");
  }
  if (!Array.isArray(botIds) || botIds.length !== 2 || new Set(botIds).size !== 2) {
    throw new Error("headless arena terminal policy requires two distinct bots");
  }
  if (!Array.isArray(blockedBotIds) || blockedBotIds.some((id) => !botIds.includes(id)) ||
      new Set(blockedBotIds).size !== blockedBotIds.length) {
    throw new Error("headless arena blockout identities are invalid");
  }
  const blocked = new Set(blockedBotIds);
  return Object.freeze(botIds.map((id) => Object.freeze({ id, toppedOut: blocked.has(id) })));
}
