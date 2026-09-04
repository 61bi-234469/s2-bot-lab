/**
 * Creates a FIFO mutation boundary for one live match session. Work may do
 * asynchronous preparation before entering this queue, but snapshot reads,
 * transition resolution, commit, recording, and view creation belong inside.
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
