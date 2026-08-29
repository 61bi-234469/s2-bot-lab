/** Runs one proposal per due bot, concurrently for normal matches and in a
 * stable order when direct CPU contention must be avoided. */
export async function runBotProposals(bots, propose, { serial = false } = {}) {
  if (!Array.isArray(bots)) throw new Error("bots must be an array");
  if (typeof propose !== "function") throw new Error("propose must be a function");
  if (typeof serial !== "boolean") throw new Error("serial must be a boolean");
  if (!serial) return Promise.all(bots.map(propose));

  const results = [];
  for (const bot of bots) results.push(await propose(bot));
  return results;
}
