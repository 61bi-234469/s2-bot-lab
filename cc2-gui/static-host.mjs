import { createGuiRequestHandlers } from "../src-js/gui-request-handlers.mjs";

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
    const result = await handlers.handle({ method: request.method, path: url.pathname, body: parsed });
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
      let entry = sessions.get(sessionKey);
      if (entry !== undefined && (entry.engine !== engine || entry.selectionLimit !== selectionLimit)) {
        await closeEntry(sessionKey, entry);
        entry = undefined;
      }
      if (entry === undefined) {
        entry = {
          engine,
          selectionLimit,
          workerSession: await createWorkerSession({ WorkerType, engine, selectionLimit }),
          idleTimer: null,
        };
        sessions.set(sessionKey, entry);
      }
      scheduleIdleClose(sessionKey, entry);
      try {
        return await entry.workerSession.suggest({ state, thinkMs });
      } catch (error) {
        await closeEntry(sessionKey, entry);
        throw error;
      }
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
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    entry.idleTimer = setTimeout(() => { void closeEntry(sessionKey, entry); }, idleTimeoutMs);
  }

  async function closeEntry(sessionKey, entry) {
    if (sessions.get(sessionKey) !== entry) return;
    sessions.delete(sessionKey);
    if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
    await entry.workerSession.close();
  }
}

async function createWorkerSession({ WorkerType, engine, selectionLimit }) {
  const wasm = engine === "cc2-raw" ? "./cold_clear_2_upstream.wasm" : engine === "cc2-chouhy" ? "./cold_clear_2_chouhy.wasm" : "./cold_clear_2_s2.wasm";
  const workerUrl = new URL("./cc2-worker.bundle.js", import.meta.url);
  workerUrl.searchParams.set("v", globalThis.__CC2_WORKER_VERSION__ ?? "dev");
  const worker = new WorkerType(workerUrl, { type: "module" });
  let nextId = 1;
  let workerFailure = null;
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
    else waiter.reject(new Error(data.error));
  };
  worker.onerror = (event) => {
    event.preventDefault?.();
    failPending(new Error(event.message || "CC2 worker failed to start"));
  };
  worker.onmessageerror = () => failPending(new Error("CC2 worker returned an unreadable message"));
  const request = (type, payload) => new Promise((resolve, reject) => {
    if (workerFailure !== null) {
      reject(workerFailure);
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
    await request("init", { wasm, configUrl, selectionLimit, searchSeed: "5994928009864282113" });
  } catch (error) {
    worker.terminate();
    throw error;
  }
  return Object.freeze({
    suggest: ({ state, thinkMs }) => request("suggest", { state, thinkMs }),
    async close() {
      try {
        if (workerFailure === null) await request("close", {});
      } finally {
        worker.terminate();
      }
    },
  });
}
