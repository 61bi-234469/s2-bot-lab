import { Worker } from 'node:worker_threads';

/** The F14 decision surface of createCc2WasmSession, run in a worker thread so
 * the synchronous WASM search never blocks the local server's event loop. */
export async function createCc2WasmWorkerSession({ wasmBytes }) {
  if (!(wasmBytes instanceof ArrayBuffer) && !ArrayBuffer.isView(wasmBytes)) throw new TypeError('wasmBytes is required');
  const worker = new Worker(new URL('./cc2-wasm-session-worker.mjs', import.meta.url), { workerData: { wasmBytes } });
  const pending = new Map();
  let nextId = 0;
  let failure = null;
  const fail = error => {
    failure ??= error;
    for (const waiter of pending.values()) waiter.reject(failure);
    pending.clear();
  };
  worker.on('message', ({ id, value, error }) => {
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    error === undefined ? waiter.resolve(value) : waiter.reject(new Error(error));
  });
  worker.on('error', fail);
  worker.on('exit', () => fail(new Error('CC2 WASM session is closed')));
  const call = (op, payload) => {
    if (failure) return Promise.reject(failure);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      worker.postMessage({ id, op, payload });
    });
  };
  try {
    await new Promise((resolve, reject) => pending.set(0, { resolve, reject }));
  } catch (error) {
    await worker.terminate();
    throw error;
  }
  let closing = null;
  return Object.freeze({
    decideF14: ({ request, profile }) => call('decideF14', { request, profile }),
    speculateInputF14: ({ request, profile }) => call('speculateInputF14', { request, profile }),
    rerankF14: ({ request, profile }) => call('rerankF14', { request, profile }),
    close() {
      closing ??= call('close').catch(() => {}).finally(() => worker.terminate());
      return closing.then(() => {});
    },
  });
}
