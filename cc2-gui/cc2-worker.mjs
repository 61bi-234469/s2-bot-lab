import { createCc2WasmSession } from "../src-js/cc2-wasm-engine.mjs";
import { resolveStaticCc2Submission } from "../src-js/static-cc2-proposal.mjs";

let session = null;
let engine = null;
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
      engine = payload.engine;
      self.postMessage({ id, ok: true });
    } else if (type === "suggest") {
      if (session === null) throw new Error("CC2 worker session is not initialized");
      self.postMessage({ id, ok: true, value: await session.suggest(payload) });
    } else if (type === "resolve") {
      if (session === null) throw new Error("CC2 worker session is not initialized");
      if (payload.type !== engine || payload.engine?.botType !== engine || payload.engine?.engineId !== engine) {
        throw new Error(`CC2 resolution engine identity mismatch for ${payload.type}`);
      }
      self.postMessage({ id, ok: true, value: resolveStaticCc2Submission(payload) });
    } else if (type === "close") {
      await session?.close();
      session = null;
      engine = null;
      self.postMessage({ id, ok: true });
    } else throw new Error(`unknown worker request: ${type}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
