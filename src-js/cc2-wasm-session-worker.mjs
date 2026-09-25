import { parentPort, workerData } from 'node:worker_threads';
import { createCc2WasmSession } from './cc2-wasm-engine.mjs';

// One F14 WASM session per worker. Messages run in arrival order: each
// session call is synchronous WASM work once the session is ready.
const ready = createCc2WasmSession({ wasmBytes: workerData.wasmBytes });
ready.then(() => parentPort.postMessage({ id: 0 }), error => parentPort.postMessage({ id: 0, error: error?.message ?? String(error) }));
parentPort.on('message', async ({ id, op, payload }) => {
  try {
    const session = await ready;
    if (!['decideF14', 'speculateInputF14', 'rerankF14', 'close'].includes(op)) throw new Error(`unknown CC2 WASM worker op: ${op}`);
    parentPort.postMessage({ id, value: await session[op](payload) });
  } catch (error) {
    parentPort.postMessage({ id, error: error?.message ?? String(error) });
  }
});
