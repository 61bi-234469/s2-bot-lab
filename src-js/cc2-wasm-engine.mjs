import { instantiateThreadedWasm } from "./cc2-wasm-threads.mjs";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function createCc2WasmSession({ wasmBytes, config = null, selectionLimit, searchSeed }) {
  if (!(wasmBytes instanceof ArrayBuffer) && !ArrayBuffer.isView(wasmBytes)) throw new TypeError("wasmBytes is required");
  const normalizedSelectionLimit = normalizeSelectionLimit(selectionLimit);
  const module = await WebAssembly.compile(wasmBytes);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) throw new Error(`CC2 WASM must be import-free; found ${imports.length}`);
  const { exports } = await WebAssembly.instantiate(module, {});
  return createSessionOn({ module, imports, exports, memory: exports.memory, config, normalizedSelectionLimit, searchSeed });
}

/**
 * The same session on the threaded build (scripts/build-wasm-threads.mjs, host src-js/cc2-wasm-threads.mjs).
 * `startThread({ module, memory, tid, startArg })` starts one helper thread in a new worker. Responses are the same
 * as the import-free build's; only `search_threads` decides how many helpers the search uses.
 */
export async function createCc2WasmThreadedSession({ wasmBytes, startThread, config = null, selectionLimit, searchSeed }) {
  if (!(wasmBytes instanceof ArrayBuffer) && !ArrayBuffer.isView(wasmBytes)) throw new TypeError("wasmBytes is required");
  if (typeof startThread !== "function") throw new TypeError("startThread is required");
  const normalizedSelectionLimit = normalizeSelectionLimit(selectionLimit);
  const { module, memory, exports, threadsStarted } = await instantiateThreadedWasm({ wasmBytes, startThread });
  const session = createSessionOn({ module, imports: WebAssembly.Module.imports(module), exports, memory, config, normalizedSelectionLimit, searchSeed });
  return Object.freeze({ ...session, threaded: true, threadsStarted });
}

function createSessionOn({ module, imports, exports, memory, config, normalizedSelectionLimit, searchSeed }) {
  for (const name of ["cc2_alloc", "cc2_invoke", "cc2_dealloc"]) {
    if (!(name in exports)) throw new Error(`CC2 WASM export missing: ${name}`);
  }
  if (!(memory instanceof WebAssembly.Memory)) throw new Error("CC2 WASM export missing: memory");
  // TextDecoder rejects views of a SharedArrayBuffer (threaded build): copy those first.
  const shared = typeof SharedArrayBuffer === "function" && memory.buffer instanceof SharedArrayBuffer;
  let closed = false;

  function invoke(request) {
    if (closed) throw new Error("CC2 WASM session is closed");
    const input = encoder.encode(JSON.stringify(request));
    const inputPointer = exports.cc2_alloc(input.length);
    new Uint8Array(memory.buffer, inputPointer, input.length).set(input);
    let outputPointer;
    try {
      outputPointer = exports.cc2_invoke(inputPointer, input.length);
    } finally {
      exports.cc2_dealloc(inputPointer, input.length);
    }
    const header = new DataView(memory.buffer, outputPointer, 4);
    const length = header.getUint32(0, true);
    try {
      const bytes = new Uint8Array(memory.buffer, outputPointer + 4, length);
      const response = JSON.parse(decoder.decode(shared ? bytes.slice() : bytes));
      if (!response?.ok) throw new Error(`CC2 WASM request failed: ${response?.error ?? "unknown"}`);
      return response.value;
    } finally {
      exports.cc2_dealloc(outputPointer, length + 4);
    }
  }

  return Object.freeze({
    module,
    imports,
    async suggest({ state, thinkMs = null }) {
      const normalizedThinkMs = normalizeThinkMs(thinkMs);
      if (normalizedSelectionLimit === null && normalizedThinkMs === null) {
        throw new Error("SELECTION and THINK TIME cannot both be disabled");
      }
      invoke({
        op: "start",
        config,
        searchSelectionLimit: normalizedSelectionLimit === null ? null : String(normalizedSelectionLimit),
        searchSeed: String(searchSeed),
        state,
      });
      let suggestion;
      if (normalizedThinkMs === null) {
        suggestion = invoke({ op: "suggest" });
      } else {
        const deadline = performance.now() + normalizedThinkMs;
        let progress;
        // Always perform one small unit so a very short deadline can still
        // produce a legal candidate. The worker isolates this synchronous WASM
        // work from rendering and input handling on the browser main thread.
        do {
          progress = invoke({ op: "work", selections: 8 });
        } while (!progress.complete && performance.now() < deadline);
        suggestion = invoke({ op: "suggest_now" });
        suggestion.move_info = {
          ...suggestion.move_info,
          extra: progress.complete
            ? "selection budget complete before time limit"
            : `time budget complete (${normalizedThinkMs} ms)`,
        };
      }
      if (!Array.isArray(suggestion?.moves)) throw new Error("CC2 returned malformed suggestion");
      if (suggestion.moves.length === 0) {
        const error = new Error("CC2 returned no suggested move");
        error.suggestionReceived = true;
        error.moveInfo = suggestion.move_info ?? null;
        throw error;
      }
      return { suggestion, peakMemoryBytes: memory.buffer.byteLength };
    },
    async decideF14({ request, profile }) {
      return runF14Search({ request, profile, startOp: "f14_start" });
    },
    async speculateInputF14({ request, profile }) {
      return runF14Search({ request, profile, startOp: "f14_input_speculate_start" });
    },
    async rerankF14({ request, profile: _profile }) {
      const response = invoke({ op: "f14_rerank", request });
      return validateF14Response(response);
    },
    async close() {
      if (!closed) invoke({ op: "stop" });
      closed = true;
    },
  });

  function runF14Search({ request, profile, startOp }) {
      const startedAt = performance.now();
      const started = invoke({ op: startOp, profile, request });
      // Invalid admission is returned as the native-shaped decision response
      // from f14_start, so callers can preserve the native error contract.
      if (started?.type === "f14_decision") return started;
      // A time budget is clocked here, like CC2's THINK TIME: work until the
      // deadline, then rank what the search has (the WASM module has no clock).
      // The 8-selection unit bounds how far past the deadline one unit can run
      // (plus up to K - 1 draws under `search_batch_size` K, whose batches
      // follow the request's selection count, not the unit).
      // A selection budget has no deadline, so it takes larger units: the
      // search result is the same, and each unit is one JSON round trip.
      if (profile?.budget?.mode === "time") {
        let progress = invoke({ op: "work", selections: 8 });
        const deadline = startedAt + profile.budget.maxMillis;
        while (!progress.complete && performance.now() < deadline) progress = invoke({ op: "work", selections: 8 });
        const response = invoke({ op: progress.complete ? "f14_finish" : "f14_finish_early" });
        return validateF14Response(response);
      }
      let progress = invoke({ op: "work", selections: 64 });
      while (!progress.complete) progress = invoke({ op: "work", selections: 64 });
      const response = invoke({ op: progress.complete ? "f14_finish" : "f14_finish_early" });
      return validateF14Response(response);
  }
}

function validateF14Response(response) {
  if (response?.type !== "f14_decision") throw new Error("CC2 WASM returned malformed F14 decision");
  return response;
}

function normalizeSelectionLimit(value) {
  if (value === null || value === undefined) return null;
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || number < 1 || number > 10_000_000) {
    throw new Error("selectionLimit must be an integer from 1 to 10000000 or null");
  }
  return number;
}

function normalizeThinkMs(value) {
  if (value === null || value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 10 || value > 10_000) {
    throw new Error("thinkMs must be an integer from 10 to 10000 or null");
  }
  return value;
}
