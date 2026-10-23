// Host for the threaded S2 WASM (wasm32-wasip1-threads, scripts/build-wasm-threads.mjs): one shared memory, the WASI
// preview1 functions the module imports, and `wasi.thread-spawn`, which starts each helper thread in its own worker
// on the same module and memory. Works in browsers (Web Workers, needs cross-origin isolation for SharedArrayBuffer)
// and in Node (worker_threads). The search result does not depend on the number of threads.

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_INVAL = 28;

/** True where a shared WebAssembly memory can be created (browser: only when cross-origin isolated). */
export function threadedWasmSupported(scope = globalThis) {
  if (typeof SharedArrayBuffer !== "function" || typeof WebAssembly !== "object") return false;
  return scope.crossOriginIsolated !== false; // Node has no crossOriginIsolated; browsers report it.
}

/** The limits of the module's imported memory, read from the import section. */
export function importedMemoryLimits(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let p = 8;
  const u = () => { let r = 0, s = 0, x; do { x = b[p++]; r |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return r >>> 0; };
  const name = () => { const n = u(); p += n; };
  while (p < b.length) {
    const id = b[p++], size = u(), end = p + size;
    if (id === 2) {
      for (let i = 0, n = u(); i < n; i++) {
        name(); name();
        const kind = b[p++];
        if (kind === 0) u();
        else if (kind === 1) { p++; const f = b[p++]; u(); if (f & 1) u(); }
        else if (kind === 2) {
          const flags = b[p++], initial = u(), maximum = flags & 1 ? u() : undefined;
          return { initial, maximum, shared: (flags & 2) !== 0 };
        } else if (kind === 3) p += 2;
      }
    }
    p = end;
  }
  throw new Error("threaded WASM has no imported memory");
}

/** The module's imports bound to `memory`; `spawn(startArg)` returns a positive thread id or a negative error. */
export function wasiThreadsImports(memory, spawn) {
  const view = () => new DataView(memory.buffer);
  const pending = [];
  return {
    env: { memory },
    wasi: { "thread-spawn": spawn },
    wasi_snapshot_preview1: {
      random_get(ptr, len) {
        // getRandomValues rejects views of shared memory: fill a private buffer and copy.
        const tmp = new Uint8Array(len);
        for (let off = 0; off < len; off += 65536) globalThis.crypto.getRandomValues(tmp.subarray(off, Math.min(len, off + 65536)));
        new Uint8Array(memory.buffer, ptr, len).set(tmp);
        return ERRNO_SUCCESS;
      },
      sched_yield() { return ERRNO_SUCCESS; },
      clock_time_get(id, _precision, out) {
        const ms = id === 0 ? performance.timeOrigin + performance.now() : performance.now();
        view().setBigUint64(out, BigInt(Math.round(ms * 1e6)), true);
        return ERRNO_SUCCESS;
      },
      fd_write(fd, iovs, iovsLen, nwritten) {
        if (fd !== 1 && fd !== 2) return ERRNO_BADF;
        const v = view();
        let total = 0;
        for (let i = 0; i < iovsLen; i++) {
          const ptr = v.getUint32(iovs + i * 8, true), len = v.getUint32(iovs + i * 8 + 4, true);
          pending.push(new Uint8Array(memory.buffer, ptr, len).slice());
          total += len;
        }
        v.setUint32(nwritten, total, true);
        const text = new TextDecoder().decode(concat(pending));
        if (text.includes("\n")) { pending.length = 0; console.error(`[cc2 wasm] ${text.trimEnd()}`); }
        return ERRNO_SUCCESS;
      },
      environ_sizes_get(count, size) { const v = view(); v.setUint32(count, 0, true); v.setUint32(size, 0, true); return ERRNO_SUCCESS; },
      environ_get() { return ERRNO_SUCCESS; },
      proc_exit(code) { throw new Error(`cc2 wasm exited (${code})`); },
    },
  };
}

function concat(chunks) {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}

/**
 * Instantiates the threaded module on a new shared memory. `startThread({ module, memory, tid, startArg })` must
 * run `runWasiThread` with those values in a new worker; it may start later (the search never waits for a helper).
 */
export async function instantiateThreadedWasm({ wasmBytes, startThread }) {
  const limits = importedMemoryLimits(wasmBytes);
  if (!limits.shared) throw new Error("threaded WASM memory is not shared");
  const module = await WebAssembly.compile(wasmBytes);
  const memory = new WebAssembly.Memory({ initial: limits.initial, maximum: limits.maximum, shared: true });
  let nextTid = 1;
  const spawn = (startArg) => {
    const tid = nextTid++;
    try { startThread({ module, memory, tid, startArg }); } catch { return -ERRNO_INVAL; }
    return tid;
  };
  const instance = await WebAssembly.instantiate(module, wasiThreadsImports(memory, spawn));
  // Main thread only: libc thread pointer and constructors. Helper threads start through wasi_thread_start.
  instance.exports._initialize();
  return { module, memory, exports: instance.exports, threadsStarted: () => nextTid - 1 };
}

/** Body of a helper thread's worker: same module, same memory, then the thread runs inside wasi_thread_start. */
export async function runWasiThread({ module, memory, tid, startArg }) {
  const instance = await WebAssembly.instantiate(module, wasiThreadsImports(memory, () => -ERRNO_INVAL));
  instance.exports.wasi_thread_start(tid, startArg);
}
