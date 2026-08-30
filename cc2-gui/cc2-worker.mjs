import { createCc2WasmSession } from "../src-js/cc2-wasm-engine.mjs";

let session = null;
self.onmessage = async ({ data }) => {
  const { id, type, payload = {} } = data;
  try {
    if (type === "init") {
      const response = await fetch(new URL(payload.wasm, import.meta.url));
      if (!response.ok) throw new Error(`WASM fetch failed: ${response.status}`);
      let config = payload.config ?? null;
      if (payload.configUrl) {
        const configResponse = await fetch(new URL(payload.configUrl, import.meta.url));
        if (!configResponse.ok) throw new Error(`config fetch failed: ${configResponse.status}`);
        config = await configResponse.text();
      }
      session = await createCc2WasmSession({ ...payload, config, wasmBytes: await response.arrayBuffer() });
      self.postMessage({ id, ok: true });
    } else if (type === "suggest") {
      self.postMessage({ id, ok: true, value: await session.suggest(payload) });
    } else if (type === "close") {
      await session?.close();
      session = null;
      self.postMessage({ id, ok: true });
    } else throw new Error(`unknown worker request: ${type}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
