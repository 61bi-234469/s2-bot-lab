import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const WASM_TARGET = "wasm32-unknown-unknown";
export const WASM_ARTIFACT = `target/${WASM_TARGET}/release/s2_analysis_engine.wasm`;

/**
 * Builds the parity artifact. Cargo decides whether anything has to be
 * recompiled, so calling this before every run costs nothing when the artifact
 * is current and makes a stale `.wasm` impossible. Loading a checked-in binary
 * instead would let the WASM leg pass against Rust sources nobody has compiled.
 */
export function buildWasmArtifact() {
  const build = spawnSync("cargo", ["build", "--quiet", "--release", "--target", WASM_TARGET], {
    encoding: "utf8",
  });
  if (build.error) {
    throw new Error(`cargo is required for the WASM parity test: ${build.error.message}`);
  }
  if (build.status !== 0) {
    throw new Error(`cargo build --target ${WASM_TARGET} failed:\n${build.stderr}`);
  }
}

/**
 * Instantiates the artifact and returns the JSON request/response surface.
 *
 * The module is compiled without `wasm-bindgen`, so it imports nothing from the
 * host: every byte that crosses the boundary does so through `s2_alloc`,
 * `s2_invoke` and `s2_dealloc`. A host that had to supply imports could change
 * the answer, which is the opposite of what a parity artifact is for.
 */
export async function loadWasmEngine({ build = true } = {}) {
  if (build) buildWasmArtifact();

  const bytes = readFileSync(WASM_ARTIFACT);
  const module = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length > 0) {
    throw new Error(
      `the parity artifact must be self-contained, but it imports ${imports
        .map(({ module: from, name }) => `${from}.${name}`)
        .join(", ")}`,
    );
  }

  const instance = await WebAssembly.instantiate(module, {});
  const { memory, s2_alloc, s2_dealloc, s2_invoke } = instance.exports;
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  function invoke(request) {
    const payload = encoder.encode(JSON.stringify(request));
    const requestPointer = s2_alloc(payload.length);
    let responsePointer = 0;
    let responseLength = 0;
    try {
      // Every view is taken after the call that could have grown the memory:
      // growth detaches the previous ArrayBuffer.
      new Uint8Array(memory.buffer, requestPointer, payload.length).set(payload);
      responsePointer = s2_invoke(requestPointer, payload.length);
      responseLength = new DataView(memory.buffer).getUint32(responsePointer, true);
      const body = new Uint8Array(memory.buffer, responsePointer + 4, responseLength);
      return JSON.parse(decoder.decode(body));
    } finally {
      s2_dealloc(requestPointer, payload.length);
      if (responsePointer !== 0) s2_dealloc(responsePointer, 4 + responseLength);
    }
  }

  return {
    artifact: {
      path: WASM_ARTIFACT,
      bytes: bytes.length,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
    },
    invoke,
    /** Unwraps a response, turning a reported failure into a thrown error. */
    call(request) {
      const response = invoke(request);
      if (!response.ok) throw new Error(`${request.op}: ${response.error}`);
      return response.value;
    },
    /** Returns the error code of a request that must fail. */
    callError(request) {
      const response = invoke(request);
      if (response.ok) throw new Error(`${request.op} was expected to fail`);
      return response.error;
    },
  };
}

async function main() {
  const engine = await loadWasmEngine();
  process.stdout.write(`${JSON.stringify(engine.artifact, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
