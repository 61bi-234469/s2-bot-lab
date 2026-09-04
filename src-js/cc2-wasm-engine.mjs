const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function createCc2WasmSession({ wasmBytes, config = null, selectionLimit, searchSeed }) {
  if (!(wasmBytes instanceof ArrayBuffer) && !ArrayBuffer.isView(wasmBytes)) throw new TypeError("wasmBytes is required");
  const normalizedSelectionLimit = normalizeSelectionLimit(selectionLimit);
  const module = await WebAssembly.compile(wasmBytes);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) throw new Error(`CC2 WASM must be import-free; found ${imports.length}`);
  const { exports } = await WebAssembly.instantiate(module, {});
  for (const name of ["memory", "cc2_alloc", "cc2_invoke", "cc2_dealloc"]) {
    if (!(name in exports)) throw new Error(`CC2 WASM export missing: ${name}`);
  }
  let closed = false;

  function invoke(request) {
    if (closed) throw new Error("CC2 WASM session is closed");
    const input = encoder.encode(JSON.stringify(request));
    const inputPointer = exports.cc2_alloc(input.length);
    new Uint8Array(exports.memory.buffer, inputPointer, input.length).set(input);
    let outputPointer;
    try {
      outputPointer = exports.cc2_invoke(inputPointer, input.length);
    } finally {
      exports.cc2_dealloc(inputPointer, input.length);
    }
    const header = new DataView(exports.memory.buffer, outputPointer, 4);
    const length = header.getUint32(0, true);
    try {
      const response = JSON.parse(decoder.decode(new Uint8Array(exports.memory.buffer, outputPointer + 4, length)));
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
      if (!Array.isArray(suggestion?.moves) || suggestion.moves.length === 0) throw new Error("CC2 returned no suggested move");
      return { suggestion, peakMemoryBytes: exports.memory.buffer.byteLength };
    },
    async close() {
      if (!closed) invoke({ op: "stop" });
      closed = true;
    },
  });
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
