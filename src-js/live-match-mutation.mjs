/**
 * Creates a FIFO mutation boundary for one live match session. Work may do
 * asynchronous pure preparation before entering this queue. Snapshot capture
 * and final validation, any stale-snapshot retry, commit, recording, and view
 * creation belong inside. A validated optimistic result may be adopted there.
 */
export function createLiveMatchMutationQueue() {
  let tail = Promise.resolve();
  return Object.freeze({
    run(work) {
      if (typeof work !== "function") throw new Error("live match mutation must be a function");
      const result = tail.then(work, work);
      tail = result.then(() => undefined, () => undefined);
      return result;
    },
  });
}
