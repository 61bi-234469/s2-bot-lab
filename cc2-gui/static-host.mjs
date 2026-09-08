import { createGuiRequestHandlers } from "../src-js/gui-request-handlers.mjs";
import { inputDecisionFingerprint as amountOnlyDecisionFingerprint } from "../src-js/input-decision-request.mjs";

let installed = false;

/** Install the Pages transport before the GUI performs its first capability request. */
export function installStaticTransport() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  const wasmAvailable = typeof Worker === "function" && typeof WebAssembly === "object";
  const cc2 = wasmAvailable ? createStaticCc2Runtime() : null;
  const handlers = createGuiRequestHandlers({ cc2 });
  window.addEventListener("pagehide", () => { void cc2?.closeSessions(); }, { once: true });
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url, window.location.href);
    if (!url.pathname.startsWith("/api/")) return nativeFetch(input, init);
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.text();
    let parsed = body;
    if (request.headers.get("content-type")?.includes("application/json")) parsed = JSON.parse(body);
    const result = await handlers.handle({ method: request.method,
      path: url.pathname.startsWith('/api/input-match/') ? url.pathname + url.search : url.pathname, body: parsed });
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  };
}

export function createStaticCc2Runtime({ WorkerType = globalThis.Worker, idleTimeoutMs = 60_000 } = {}) {
  if (typeof WorkerType !== "function" || typeof WebAssembly !== "object") throw new Error("CC2 WASM is unavailable in this browser");
  const sessions = new Map();

  return Object.freeze({
    async propose({ sessionKey, engine, state, selectionLimit, thinkMs }) {
      if (typeof sessionKey !== "string" || sessionKey.length === 0) throw new Error("CC2 sessionKey is required");
      const inputCandidates = state?.input_candidates === true;
      if (inputCandidates && !['cc2-raw', 'cc2-chouhy'].includes(engine)) throw new Error('input candidate prefix engine mismatch');
      let entry = sessions.get(sessionKey);
      if (entry !== undefined && entry.inputCandidates !== inputCandidates) throw new Error('input candidate prefix session mismatch');
      if (entry !== undefined && (entry.engine !== engine || entry.selectionLimit !== selectionLimit)) {
        await closeEntry(sessionKey, entry);
        entry = undefined;
      }
      if (entry === undefined) {
        entry = {
          engine,
          inputCandidates,
          selectionLimit,
          workerSession: null,
          idleTimer: null,
        };
        sessions.set(sessionKey, entry);
        const initialized = entry;
        entry.initializing = createWorkerSession({ WorkerType, engine, selectionLimit }).then(async workerSession => {
          initialized.workerSession = workerSession;
          if (sessions.get(sessionKey) !== initialized) {
            await workerSession.close();
            throw new Error('CC2 worker session was replaced during initialization');
          }
          return workerSession;
        });
        void entry.initializing.catch(() => {});
      }
      clearIdleClose(entry);
      try {
        await entry.initializing;
        const result = await entry.workerSession.suggest({ state, thinkMs });
        if (sessions.get(sessionKey) !== entry) throw new Error("CC2 worker session was replaced");
        scheduleIdleClose(sessionKey, entry);
        return result;
      } catch (error) {
        await closeEntry(sessionKey, entry);
        throw error;
      }
    },

    async resolve(request) {
      const { sessionKey, type, engine } = request ?? {};
      if (typeof sessionKey !== "string" || sessionKey.length === 0) throw new Error("CC2 sessionKey is required");
      const entry = sessions.get(sessionKey);
      if (entry === undefined) throw new Error(`CC2 session ${sessionKey} is not initialized`);
      if (entry.engine !== type || engine?.botType !== type || engine?.engineId !== type) {
        throw new Error(`CC2 resolution engine identity mismatch for ${type}`);
      }
      amountOnlyDecisionFingerprint(request);
      clearIdleClose(entry);
      try {
        if (entry.workerSession === null) await entry.initializing;
        const result = await entry.workerSession.resolve(request);
        if (sessions.get(sessionKey) !== entry) throw new Error("CC2 worker session was replaced");
        scheduleIdleClose(sessionKey, entry);
        return result;
      } catch (error) {
        await closeEntry(sessionKey, entry);
        throw error;
      }
    },

    async resolveInput(payload) {
      const entry = sessions.get(payload.request.sessionKey);
      if (!entry || entry.engine !== payload.request.type) throw new Error('input worker session mismatch');
      clearIdleClose(entry);
      try {
        if (entry.workerSession === null) await entry.initializing;
        const result = await entry.workerSession.resolveInput(payload);
        if (sessions.get(payload.request.sessionKey) !== entry) throw new Error('input worker session replaced');
        scheduleIdleClose(payload.request.sessionKey, entry);
        return result;
      } catch (error) { await closeEntry(payload.request.sessionKey, entry); throw error; }
    },

    async closeSessions({ sessionKeys = null } = {}) {
      const keys = sessionKeys === null ? [...sessions.keys()] : [...sessionKeys];
      await Promise.all(keys.map(async (key) => {
        const entry = sessions.get(key);
        if (entry !== undefined) await closeEntry(key, entry);
      }));
    },
  });

  function scheduleIdleClose(sessionKey, entry) {
    clearIdleClose(entry);
    entry.idleTimer = setTimeout(() => { void closeEntry(sessionKey, entry); }, idleTimeoutMs);
  }

  function clearIdleClose(entry) {
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  }

  async function closeEntry(sessionKey, entry) {
    if (sessions.get(sessionKey) !== entry) return;
    sessions.delete(sessionKey);
    clearIdleClose(entry);
    await entry.workerSession?.close();
  }
}

async function createWorkerSession({ WorkerType, engine, selectionLimit }) {
  const wasm = engine === "cc2-raw" ? "./cold_clear_2_upstream.wasm" : engine === "cc2-chouhy" ? "./cold_clear_2_chouhy.wasm" : "./cold_clear_2_s2.wasm";
  const workerUrl = new URL("./cc2-worker.bundle.js", import.meta.url);
  workerUrl.searchParams.set("v", globalThis.__CC2_WORKER_VERSION__ ?? "dev");
  const worker = new WorkerType(workerUrl, { type: "module" });
  let nextId = 1;
  let workerFailure = null;
  let closed = false;
  const pending = new Map();
  const failPending = (error) => {
    workerFailure = error;
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  };
  worker.onmessage = ({ data }) => {
    const waiter = pending.get(data.id);
    if (!waiter) return;
    pending.delete(data.id);
    if (data.ok) waiter.resolve(data.value);
    else waiter.reject(Object.assign(new Error(data.error), {
      suggestionReceived: data.suggestionReceived, moveInfo: data.moveInfo,
    }));
  };
  worker.onerror = (event) => {
    event.preventDefault?.();
    failPending(new Error(event.message || "CC2 worker failed to start"));
  };
  worker.onmessageerror = () => failPending(new Error("CC2 worker returned an unreadable message"));
  const request = (type, payload) => new Promise((resolve, reject) => {
    if (closed || workerFailure !== null) {
      reject(workerFailure ?? new Error("CC2 worker session is closed"));
      return;
    }
    const id = nextId++;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, payload });
  });
  const configUrl = engine === "cc2-s2-champion"
    ? "./cc2-s2-spawn-integrity-substrate-v2.json"
    : engine === "cc2-s2" || !engine.startsWith("cc2-s2")
      ? null
      : "./cc2-s2-spin-value-aligned.json";
  try {
    await request("init", { engine, wasm, configUrl, selectionLimit, searchSeed: "5994928009864282113" });
  } catch (error) {
    worker.terminate();
    throw error;
  }
  return Object.freeze({
    suggest: ({ state, thinkMs }) => request("suggest", { state, thinkMs }),
    resolve: (payload) => request("resolve", payload),
    resolveInput: (payload) => request('resolveInput', payload),
    async close() {
      if (closed) return;
      const canNotifyWorker = workerFailure === null;
      closed = true;
      failPending(new Error("CC2 worker session is closed"));
      if (canNotifyWorker) {
        try { worker.postMessage({ id: nextId++, type: "close", payload: {} }); }
        catch { /* Termination below is the authoritative cleanup. */ }
      }
      worker.terminate();
    },
  });
}
