// The spike WASM worker pool on Node worker_threads (scripts/rg-wasm/ checks and timings).
import { Worker } from "node:worker_threads";
import { createSpikeWorkerPool } from "../../src-js/spike-wasm-client.mjs";

const entry = new URL("./node-spike-worker.mjs", import.meta.url);

export function createNodeSpikePool({ wasm, workers = 3, timeoutMs } = {}) {
  return createSpikeWorkerPool({ wasm, workers, ...(timeoutMs ? { timeoutMs } : {}), startWorker: () => {
    const w = new Worker(entry);
    return { postMessage: (m) => w.postMessage(m), onMessage: (cb) => w.on("message", cb),
      onError: (cb) => w.on("error", cb), terminate: () => { w.terminate(); } };
  } });
}
