// Node worker_threads entry for the spike WASM worker pool (src-js/spike-wasm-client.mjs); the page uses a Web Worker
// entry with the same handler. Used by scripts/rg-wasm/ checks and timings.
import { parentPort } from "node:worker_threads";
import { createSpikeWorkerHandler } from "../../src-js/spike-wasm-client.mjs";

const handle = createSpikeWorkerHandler((message) => parentPort.postMessage(message));
parentPort.on("message", (data) => { handle(data); });
