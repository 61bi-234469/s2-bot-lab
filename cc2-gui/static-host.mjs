import { createGuiRequestHandlers } from "../src-js/gui-request-handlers.mjs";

let installed = false;

/** Install the Pages transport before the GUI performs its first capability request. */
export function installStaticTransport() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  const wasmAvailable = typeof Worker === "function" && typeof WebAssembly === "object";
  const handlers = createGuiRequestHandlers({ proposeCc2: wasmAvailable ? proposeCc2 : null });
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

async function proposeCc2({ engine, state }) {
  if (typeof Worker !== "function" || typeof WebAssembly !== "object") throw new Error("CC2 WASM is unavailable in this browser");
  const wasm = engine === "cc2-raw" ? "./cold_clear_2_upstream.wasm" : engine === "cc2-chouhy" ? "./cold_clear_2_chouhy.wasm" : "./cold_clear_2_s2.wasm";
  const workerUrl = new URL("./cc2-worker.bundle.js", import.meta.url);
  workerUrl.searchParams.set("v", globalThis.__CC2_WORKER_VERSION__ ?? "dev");
  const worker = new Worker(workerUrl, { type: "module" });
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
  try {
    const configUrl = engine === "cc2-s2-champion"
      ? "./cc2-s2-spawn-integrity-substrate-v2.json"
      : engine === "cc2-s2" || !engine.startsWith("cc2-s2")
        ? null
        : "./cc2-s2-spin-value-aligned.json";
    await request("init", { wasm, configUrl, selectionLimit: "512", searchSeed: "5994928009864282113" });
    return await request("suggest", { state });
  } finally {
    try {
      if (workerFailure === null) await request("close", {});
    } finally {
      worker.terminate();
    }
  }
}
