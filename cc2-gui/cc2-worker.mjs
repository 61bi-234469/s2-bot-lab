import { createCc2WasmSession, createCc2WasmThreadedSession } from "../src-js/cc2-wasm-engine.mjs";
import { threadedWasmSupported } from "../src-js/cc2-wasm-threads.mjs";
import { resolveGuiStaticSubmission as resolveQualifiedStaticCc2Submission } from "../src-js/gui-static-public-resolver.mjs";
import { resolveInputJob } from '../src-js/input-public-job.mjs';

let session = null;
let engine = null;
// Helper-thread workers of a threaded session (terminated with it).
let threadWorkers = [];

/** The threaded build when the page is cross-origin isolated and it loads; otherwise null (import-free build). */
async function createThreadedSessionOrNull(payload, config) {
  if (!payload.threadedWasm || !threadedWasmSupported(self)) return null;
  try {
    const response = await fetch(new URL(payload.threadedWasm, import.meta.url));
    if (!response.ok) return null;
    const version = new URL(import.meta.url).searchParams.get("v");
    const threadUrl = new URL("./cc2-wasm-thread.bundle.js", import.meta.url);
    if (version) threadUrl.searchParams.set("v", version);
    return await createCc2WasmThreadedSession({ ...payload, config, wasmBytes: await response.arrayBuffer(),
      startThread: (message) => {
        const worker = new Worker(threadUrl, { type: "module" });
        threadWorkers.push(worker);
        worker.postMessage(message);
      } });
  } catch (error) {
    for (const worker of threadWorkers) worker.terminate();
    threadWorkers = [];
    console.warn(`CC2 threaded WASM unavailable, using the single-thread build: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}
self.onmessage = async ({ data }) => {
  const { id, type, payload = {} } = data;
  try {
    if (type === "init" && payload.resolverOnly === true) {
      // INPUT plan resolution only (no engine): resolveInput needs no WASM.
      engine = payload.engine;
      self.postMessage({ id, ok: true });
    } else if (type === "init") {
      const response = await fetch(new URL(payload.wasm, import.meta.url));
      if (!response.ok) throw new Error(`WASM fetch failed: ${response.status}`);
      let config = payload.config ?? null;
      if (payload.configUrl) {
        const configResponse = await fetch(new URL(payload.configUrl, import.meta.url));
        if (!configResponse.ok) throw new Error(`config fetch failed: ${configResponse.status}`);
        config = await configResponse.text();
      }
      session = await createThreadedSessionOrNull(payload, config)
        ?? await createCc2WasmSession({ ...payload, config, wasmBytes: await response.arrayBuffer() });
      engine = payload.engine;
      self.postMessage({ id, ok: true, value: { threaded: session.threaded === true } });
    } else if (type === "suggest") {
      if (session === null) throw new Error("CC2 worker session is not initialized");
      self.postMessage({ id, ok: true, value: await session.suggest(payload) });
    } else if (type === "resolve") {
      if (session === null) throw new Error("CC2 worker session is not initialized");
      if (payload.type !== engine || payload.engine?.botType !== engine || payload.engine?.engineId !== engine) {
        throw new Error(`CC2 resolution engine identity mismatch for ${payload.type}`);
      }
      self.postMessage({ id, ok: true, value: resolveQualifiedStaticCc2Submission(payload) });
    } else if (type === "decideF14") {
      if (session === null) throw new Error("CC2 worker session is not initialized");
      if (payload.type !== engine || payload.engine?.botType !== engine || payload.engine?.engineId !== engine) {
        throw new Error(`CC2 F14 engine identity mismatch for ${payload.type}`);
      }
      self.postMessage({ id, ok: true, value: await session.decideF14({ request: payload.request, profile: payload.profile }) });
    } else if (type === "speculateInputF14") {
      if (session === null) throw new Error("CC2 worker session is not initialized");
      if (payload.type !== engine || payload.engine?.botType !== engine || payload.engine?.engineId !== engine) {
        throw new Error(`CC2 F14 engine identity mismatch for ${payload.type}`);
      }
      self.postMessage({ id, ok: true, value: await session.speculateInputF14({ request: payload.request, profile: payload.profile }) });
    } else if (type === "rerankF14") {
      if (session === null) throw new Error("CC2 worker session is not initialized");
      if (payload.type !== engine || payload.engine?.botType !== engine || payload.engine?.engineId !== engine) {
        throw new Error(`CC2 F14 engine identity mismatch for ${payload.type}`);
      }
      self.postMessage({ id, ok: true, value: await session.rerankF14({ request: payload.request, profile: payload.profile }) });
    } else if (type === 'resolveInput') {
      if (engine === null || payload.request?.type !== engine || payload.request.engine?.engineId !== engine) throw new Error('input resolution identity mismatch');
      self.postMessage({ id, ok: true, value: resolveInputJob(payload) });
    } else if (type === "close") {
      await session?.close();
      session = null;
      for (const worker of threadWorkers) worker.terminate();
      threadWorkers = [];
      engine = null;
      self.postMessage({ id, ok: true });
    } else throw new Error(`unknown worker request: ${type}`);
  } catch (error) {
    self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error),
      suggestionReceived: error?.suggestionReceived, moveInfo: error?.moveInfo });
  }
};
