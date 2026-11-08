// Host side of the spike-stress WASM (bot/cc2-spike-wasm). No Node imports: it runs on a page, in a Web Worker and
// in Node.
//   createSpikeWasmClient({ wasm })   one instance on this thread; request(line) answers "search" and "batch" lines
//                                     (the spike-stress JSON lines, without `us`).
//   createSpikeWorkerPool({ workers, startWorker })
//                                     "batch" lines spread over workers that do not share memory (no cross-origin
//                                     isolation needed): each worker searches one line at a time with a fresh table,
//                                     as the native "batch" does, and the replies come back in request order.
//   handleSpikeWorkerMessage          the worker side of the pool's messages; a worker entry only wires it up.
// Any failure (an "ok": false answer, a trap, a worker error) rejects the request and every later one: callers stop
// instead of falling back, as with the native client.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// BigInt columns are written as JSON numbers (all < 2^40, so exact), as the native client writes them.
export const encodeSpikeRequest = (request) => JSON.stringify(request, (k, v) => (typeof v === "bigint" ? Number(v) : v));

/** A compiled module from bytes or a module; the module must import nothing. */
export async function compileSpikeWasm(wasm) {
  const module = wasm instanceof WebAssembly.Module ? wasm : await WebAssembly.compile(wasm);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) throw new Error(`spike WASM must be import-free; found ${imports.length}`);
  return module;
}

/** The synchronous JSON surface of one instance: invoke(request) -> value, or throws. */
export async function instantiateSpikeWasm(wasm) {
  const { exports } = await WebAssembly.instantiate(await compileSpikeWasm(wasm), {});
  for (const name of ["spike_alloc", "spike_invoke", "spike_dealloc"]) if (typeof exports[name] !== "function") throw new Error(`spike WASM export missing: ${name}`);
  if (!(exports.memory instanceof WebAssembly.Memory)) throw new Error("spike WASM export missing: memory");
  const memory = exports.memory;
  return function invoke(request) {
    const input = encoder.encode(typeof request === "string" ? request : encodeSpikeRequest(request));
    const pointer = exports.spike_alloc(input.length);
    new Uint8Array(memory.buffer, pointer, input.length).set(input);
    let output;
    try { output = exports.spike_invoke(pointer, input.length); } finally { exports.spike_dealloc(pointer, input.length); }
    const length = new DataView(memory.buffer, output, 4).getUint32(0, true);
    let response;
    try { response = JSON.parse(decoder.decode(new Uint8Array(memory.buffer, output + 4, length))); }
    finally { exports.spike_dealloc(output, length + 4); }
    if (!response?.ok) throw new Error(`spike WASM request failed: ${response?.error ?? "unknown"}`);
    return response.value;
  };
}

/** One instance on this thread. `request` is async only to match the other clients; it runs synchronously. */
export async function createSpikeWasmClient({ wasm }) {
  const invoke = await instantiateSpikeWasm(wasm);
  let broken = null;
  return Object.freeze({
    async request(request) {
      if (broken !== null) throw broken;
      try {
        const reply = invoke(request);
        if (reply?.id !== request.id) throw new Error(`spike WASM reply id ${reply?.id} for request ${request.id}`);
        return reply;
      } catch (error) { broken = error; throw error; }
    },
    invoke,
    async close() {},
  });
}

/**
 * The worker side. `post(message)` sends to the pool. Messages: {type: "init", wasm} (bytes or a module), then
 * {type: "search", id, line}, answered {id, ok, value | error}; a line is searched as a one-line "batch" (own table).
 */
export function createSpikeWorkerHandler(post) {
  let invoke = null;
  return async function handleSpikeWorkerMessage(data) {
    const { type, id } = data ?? {};
    try {
      if (type === "init") { invoke = await instantiateSpikeWasm(data.wasm); post({ id, ok: true }); return; }
      if (type !== "search") throw new Error(`unknown spike worker message ${type}`);
      if (invoke === null) throw new Error("spike worker is not initialized");
      const reply = invoke({ id: `w-${id}`, mode: "batch", requests: [data.line] });
      post({ id, ok: true, value: reply.replies[0] });
    } catch (error) { post({ id, ok: false, error: error instanceof Error ? error.message : String(error) }); }
  };
}

/**
 * A pool of `workers` spike workers. `startWorker()` returns a port: { postMessage(message), onMessage(callback),
 * onError(callback), terminate() } (a Web Worker or a Node worker_threads Worker behind a small adapter).
 * request({mode: "batch", requests}) hands each line to the next free worker; request({mode: "search", ...}) is one
 * line. Lines go out already encoded (BigInt as numbers).
 */
export async function createSpikeWorkerPool({ wasm, workers = 3, startWorker, timeoutMs = 30_000 }) {
  if (!Number.isSafeInteger(workers) || workers < 1 || workers > 16) throw new Error("invalid spike worker count");
  if (typeof startWorker !== "function") throw new Error("startWorker is required");
  const module = await compileSpikeWasm(wasm);
  let broken = null, serial = 0;
  const ports = [], waiting = new Map();
  const fail = (error) => {
    if (broken === null) broken = error;
    for (const w of waiting.values()) { clearTimeout(w.timer); w.reject(broken); }
    waiting.clear();
    for (const p of ports) p.port.terminate();
  };
  const send = (slot, message) => new Promise((resolve, reject) => {
    if (broken !== null) { reject(broken); return; }
    const id = ++serial;
    const timer = setTimeout(() => fail(new Error(`spike worker request ${id} timed out after ${timeoutMs} ms`)), timeoutMs);
    waiting.set(id, { resolve, reject, timer });
    slot.port.postMessage({ ...message, id });
  });
  // A worker that cannot start terminates the ones already started.
  try {
    for (let k = 0; k < workers; k++) {
      const port = startWorker();
      const slot = { port, busy: false };
      ports.push(slot);
      port.onMessage((data) => {
        const w = waiting.get(data?.id);
        if (!w) return fail(new Error("spike worker sent an unrequested message"));
        waiting.delete(data.id); clearTimeout(w.timer);
        if (data.ok) w.resolve(data.value);
        else { const error = new Error(`spike worker: ${data.error}`); w.reject(error); fail(error); }
      });
      port.onError((error) => fail(error instanceof Error ? error : new Error(`spike worker error: ${error?.message ?? error}`)));
    }
  } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); throw broken; }
  try { await Promise.all(ports.map((slot) => send(slot, { type: "init", wasm: module }))); }
  catch (error) { fail(error); throw error; }

  async function searchLines(lines) {
    const replies = new Array(lines.length);
    let next = 0;
    const run = async (slot) => {
      while (next < lines.length) {
        const k = next++;
        replies[k] = await send(slot, { type: "search", line: JSON.parse(encodeSpikeRequest(lines[k])) });
      }
    };
    await Promise.all(ports.map(run));
    return replies;
  }
  return Object.freeze({
    workers,
    async request(request) {
      if (broken !== null) throw broken;
      if (request.mode === "batch") {
        const replies = await searchLines(request.requests);
        replies.forEach((r, k) => { if (r?.id !== request.requests[k].id) throw new Error("spike worker reply out of order"); });
        return { id: request.id, replies };
      }
      if ((request.mode ?? "search") !== "search") throw new Error(`spike pool takes search and batch requests, not ${request.mode}`);
      const [reply] = await searchLines([request]);
      return reply;
    },
    // Closing rejects every request still waiting (it never leaves one unsettled) and every later one.
    async close() { fail(new Error("spike worker pool closed")); ports.length = 0; },
  });
}

/** A pool port over a module Web Worker at `url` (cc2-gui/spike-worker.mjs, bundled), for createSpikeWorkerPool. */
export function webWorkerSpikePort(url, WorkerType = globalThis.Worker) {
  const worker = new WorkerType(url, { type: "module" });
  return { postMessage: (message) => worker.postMessage(message),
    onMessage: (callback) => worker.addEventListener("message", (event) => callback(event.data)),
    onError: (callback) => worker.addEventListener("error", (event) => callback(new Error(event?.message ?? "spike worker error"))),
    terminate: () => worker.terminate() };
}
