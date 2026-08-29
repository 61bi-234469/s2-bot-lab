const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function createCc2WasmSession({ wasmBytes, config = null, selectionLimit, searchSeed }) {
  if (!(wasmBytes instanceof ArrayBuffer) && !ArrayBuffer.isView(wasmBytes)) throw new TypeError("wasmBytes is required");
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
    async suggest({ state }) {
      invoke({ op: "start", config, searchSelectionLimit: String(selectionLimit), searchSeed: String(searchSeed), state });
      const suggestion = invoke({ op: "suggest" });
      if (!Array.isArray(suggestion?.moves) || suggestion.moves.length === 0) throw new Error("CC2 returned no suggested move");
      return { suggestion, peakMemoryBytes: exports.memory.buffer.byteLength };
    },
    async close() {
      if (!closed) invoke({ op: "stop" });
      closed = true;
    },
  });
}
