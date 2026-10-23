// One helper thread of the threaded S2 WASM (src-js/cc2-wasm-threads.mjs): started by cc2-worker.mjs with the
// session's module, shared memory, thread id and start argument; the thread then runs inside wasi_thread_start.
import { runWasiThread } from "../src-js/cc2-wasm-threads.mjs";

self.onmessage = ({ data }) => {
  self.onmessage = null;
  runWasiThread(data).catch((error) => console.error(`CC2 WASM thread ${data?.tid} failed: ${error instanceof Error ? error.message : error}`));
};
