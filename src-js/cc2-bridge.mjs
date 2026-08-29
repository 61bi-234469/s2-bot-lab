import { execFile, spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";

import { createProcessMemorySampler } from "./process-memory-sampler.mjs";

const execFileAsync = promisify(execFile);

export async function createCc2Session({
  binary,
  binaryArguments = [],
  expectedName = "Cold Clear 2",
  selectionLimit = null,
  searchSeed = null,
  suggestTimeoutMs = 30_000,
  spawnProcess = spawn,
}) {
  if (typeof binary !== "string" || binary === "") throw new Error("binary must be a non-empty string");
  if (!Array.isArray(binaryArguments) || !binaryArguments.every((value) => typeof value === "string")) {
    throw new Error("binaryArguments must be an array of strings");
  }
  assertSearchBudget(selectionLimit, searchSeed);
  if (!Number.isSafeInteger(suggestTimeoutMs) || suggestTimeoutMs < 1_000) {
    throw new Error("suggestTimeoutMs must be an integer of at least 1000");
  }
  const child = spawnProcess(binary, searchBudgetArguments(binaryArguments, selectionLimit, searchSeed), {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdoutBuffer = "";
  let stderr = "";
  let closed = false;
  let active = false;
  let started = false;
  const messages = [];
  const waiters = new Set();

  const settleWaiters = (error, message = null) => {
    for (const waiter of [...waiters]) {
      if (error === null && !waiter.predicate(message)) continue;
      waiters.delete(waiter);
      clearTimeout(waiter.timeout);
      if (error === null) waiter.resolve(message);
      else waiter.reject(error);
    }
  };
  const waitFor = (predicate, timeoutMs, label) => {
    const existing = messages.find(predicate);
    if (existing !== undefined) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timeout: null };
      waiter.timeout = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`CC2 session timed out waiting for ${label}`));
      }, timeoutMs);
      waiters.add(waiter);
    });
  };
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") continue;
      try {
        const message = JSON.parse(line);
        messages.push(message);
        settleWaiters(null, message);
      } catch (error) {
        settleWaiters(new Error(`CC2 session returned invalid JSON: ${error.message}`));
      }
    }
  });
  const spawned = new Promise((resolve, reject) => {
    child.once("spawn", resolve);
    child.once("error", reject);
  });
  child.once("exit", (code, signal) => {
    closed = true;
    settleWaiters(new Error(`CC2 session exited with code ${code}, signal ${signal}: ${stderr.trim()}`));
  });

  await spawned;
  const infoPromise = waitFor((message) => message.type === "info", 10_000, "info");
  const readyPromise = waitFor((message) => message.type === "ready", 10_000, "ready");
  write(child, { type: "rules" });
  const [info] = await Promise.all([infoPromise, readyPromise]);
  if (info.name !== expectedName) {
    child.kill();
    throw new Error(`CC2 session identity mismatch: expected ${expectedName}, received ${info.name}`);
  }

  return Object.freeze({
    pid: child.pid,
    selectionLimit,
    searchSeed,
    async suggest({ state, thinkMs = 500 }) {
      assertRequest(state, thinkMs, selectionLimit, searchSeed);
      if (closed) throw new Error("CC2 session is closed");
      if (active) throw new Error("CC2 session does not accept concurrent suggestions");
      active = true;
      const requestStartedAt = performance.now();
      try {
        if (started) write(child, { type: "stop" });
        write(child, { type: "start", ...state });
        started = true;
        // Any suggestion still in the backlog belongs to a previous request: a
        // consumed one is spliced out below, but an empty or late one is not,
        // and `waitFor` would hand it to this request instantly. A session that
        // once returned an empty suggestion must not fail every later request.
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          if (messages[index].type === "suggestion") messages.splice(index, 1);
        }
        // A fixed selection budget makes the bot block `suggest` until the exact
        // budget is spent, so the search size no longer depends on how long the
        // caller waits. Only a time-budgeted session has to sleep.
        if (selectionLimit === null) {
          await new Promise((resolve) => setTimeout(resolve, thinkMs));
        }
        const suggestionPromise = waitFor(
          (message) => message.type === "suggestion" && Array.isArray(message.moves),
          selectionLimit === null ? 10_000 : suggestTimeoutMs,
          "suggestion",
        );
        write(child, { type: "suggest" });
        const suggestion = await suggestionPromise;
        // A consumed suggestion must not satisfy the following request, so it
        // leaves the backlog before the empty-suggestion check can throw.
        const index = messages.indexOf(suggestion);
        if (index >= 0) messages.splice(index, 1);
        if (suggestion.moves.length === 0) {
          const error = new Error("CC2 returned no suggested move");
          error.requestToSuggestionMs = performance.now() - requestStartedAt;
          throw error;
        }
        const requestToSuggestionMs = performance.now() - requestStartedAt;
        return { info, suggestion, peakMemoryBytes: null, requestToSuggestionMs };
      } finally {
        // The bot searches continuously between `start` and `stop`, and its DAG
        // has no node limit, so a session that answered a request and then sat
        // idle kept expanding: measured at roughly 200 MB/s, reaching 22 GB in
        // under three minutes of silence. Every request re-starts from the full
        // position and this bridge never sends `play` or `new_piece`, so
        // stopping here discards nothing a later request would have reused.
        if (!closed && started) {
          write(child, { type: "stop" });
          started = false;
        }
        active = false;
      }
    },
    async close() {
      if (closed) return;
      write(child, { type: "quit" });
      child.stdin.end();
      await new Promise((resolve) => {
        const timeout = setTimeout(() => {
          child.kill();
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    },
    terminate() {
      if (!closed) child.kill();
    },
  });
}

export async function requestCc2Suggestion({
  binary,
  binaryArguments = [],
  state,
  thinkMs = 500,
  selectionLimit = null,
  searchSeed = null,
  samplePeakMemory = readPeakWorkingSetBytes,
  expectedName = "Cold Clear 2",
}) {
  assertRequest(state, thinkMs, selectionLimit, searchSeed);
  if (!Array.isArray(binaryArguments) || !binaryArguments.every((value) => typeof value === "string")) {
    throw new Error("binaryArguments must be an array of strings");
  }
  const messages = [];
  let stdoutBuffer = "";
  let stderr = "";
  let suggestTimer = null;
  let suggestion = null;
  let peakMemoryBytes = null;
  let memorySample = null;
  let requestToSuggestionMs = null;
  const requestStartedAt = performance.now();

  const processArguments = searchBudgetArguments(binaryArguments, selectionLimit, searchSeed);
  const child = spawn(binary, processArguments, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") continue;
      const message = JSON.parse(line);
      messages.push(message);
      if (message.type === "suggestion" && suggestion === null) {
        suggestion = message;
        requestToSuggestionMs = performance.now() - requestStartedAt;
        memorySample = Promise.resolve(samplePeakMemory(child.pid)).then((value) => {
          peakMemoryBytes = value;
        }).catch(() => {
          peakMemoryBytes = null;
        }).finally(() => {
          child.stdin.write(`${JSON.stringify({ type: "quit" })}\n`);
          child.stdin.end();
        });
      }
    }
  });

  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`CC2 did not return a suggestion within ${thinkMs + 10_000} ms`));
    }, thinkMs + 10_000);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("spawn", () => {
      write(child, { type: "rules" });
      write(child, { type: "start", ...state });
      suggestTimer = setTimeout(
        () => write(child, { type: "suggest" }),
        selectionLimit === null ? thinkMs : 0,
      );
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      if (suggestTimer !== null) clearTimeout(suggestTimer);
      resolve({ code, signal });
    });
  });

  const info = messages.find((message) => message.type === "info");
  const ready = messages.find((message) => message.type === "ready");
  if (exit.code !== 0 || exit.signal !== null) {
    throw new Error(`CC2 exited with code ${exit.code}, signal ${exit.signal}: ${stderr.trim()}`);
  }
  if (info?.name !== expectedName || ready === undefined) {
    throw new Error("CC2 did not complete the TBP handshake");
  }
  if (!Array.isArray(suggestion?.moves) || suggestion.moves.length === 0) {
    const error = new Error("CC2 returned no suggested move");
    error.requestToSuggestionMs = requestToSuggestionMs;
    throw error;
  }
  if (memorySample !== null) await memorySample;
  return { info, suggestion, peakMemoryBytes, requestToSuggestionMs };
}

async function readPeakWorkingSetBytes(pid) {
  if (process.platform !== "win32" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  const command = `(Get-Process -Id ${pid} -ErrorAction Stop).PeakWorkingSet64`;
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 5_000 },
  );
  const value = Number(stdout.trim());
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/**
 * Serves suggestions from reusable sessions instead of one process per move.
 *
 * This is only sound for a fixed selection budget. Under a wall-clock budget a
 * reused process reports roughly 30% fewer nodes than a cold one, because
 * releasing the previous position's DAG competes with the new search, so the
 * search effort would depend on process history. A selection budget stops after
 * an exact number of tree selections, which makes a reused session return the
 * same moves, node counts and cached values as a cold process.
 *
 * Peak working set is deliberately not reported: a long-lived process has no
 * per-move cold peak, and a session-wide peak would silently mean something
 * else. Callers that need the strength gate's memory evidence must keep using
 * `requestCc2Suggestion`.
 */
export async function createCc2SessionPool({
  binary,
  binaryArguments = [],
  expectedName = "Cold Clear 2",
  selectionLimit,
  searchSeed,
  size = 1,
  suggestTimeoutMs = 30_000,
  createSession = createCc2Session,
  memorySampleEveryRequests = 0,
  memoryLimitBytes = null,
  createMemorySampler = createProcessMemorySampler,
} = {}) {
  if (selectionLimit === null || selectionLimit === undefined) {
    throw new Error("a CC2 session pool requires a fixed selection budget");
  }
  assertSearchBudget(selectionLimit, searchSeed);
  if (!Number.isSafeInteger(size) || size < 1 || size > 64) {
    throw new Error("CC2 session pool size must be an integer from 1 to 64");
  }
  if (!Number.isSafeInteger(memorySampleEveryRequests) || memorySampleEveryRequests < 0 ||
      memorySampleEveryRequests > 1_000_000) {
    throw new Error("CC2 session memory sample interval must be an integer from 0 to 1000000");
  }
  if (memoryLimitBytes !== null && (!Number.isSafeInteger(memoryLimitBytes) || memoryLimitBytes < 1)) {
    throw new Error("CC2 session memory limit must be null or a positive safe integer");
  }
  if (memoryLimitBytes !== null && memorySampleEveryRequests === 0) {
    throw new Error("CC2 session memory limit requires a positive sample interval");
  }
  const settings = { binary, binaryArguments, expectedName, selectionLimit, searchSeed, suggestTimeoutMs };
  // `Promise.all` rejects on the first failure while the other sessions may
  // still resolve, so the pool collects every settled session and terminates
  // the survivors before rethrowing. A half-built pool must not leave processes
  // behind for the next run to compete with.
  const settled = await Promise.allSettled(
    Array.from({ length: size }, () => createSession({ ...settings })),
  );
  const failure = settled.find((entry) => entry.status === "rejected");
  if (failure !== undefined) {
    for (const entry of settled) {
      if (entry.status === "fulfilled") entry.value.terminate();
    }
    throw failure.reason;
  }
  const sessions = settled.map((entry) => entry.value);
  const idle = [...sessions];
  const waiting = [];
  const stats = { requests: 0, sessions: sessions.length };
  const memory = {
    samples: 0,
    unavailableSamples: 0,
    limitExceeded: false,
    currentPoolWorkingSetBytes: null,
    processPeakWorkingSetTotalBytes: null,
    sessionCurrentWorkingSetBytes: null,
    sessionPeakWorkingSetBytes: null,
  };
  // Once the pool is over its declared limit the working set does not fall back
  // on its own, so every later sample would fail the same way while the run
  // kept dispatching games against an oversized pool. Latch the breach instead:
  // the remaining requests fail immediately, the run reaches its report without
  // searching further, and the host stops being held at its memory ceiling.
  let limitExceeded = null;
  const samplers = memorySampleEveryRequests === 0 ? null : {
    current: createMemorySampler({ metric: "working-set" }),
    peak: createMemorySampler({ metric: "peak-working-set" }),
  };
  let closed = false;

  const acquire = () => {
    const ready = idle.pop();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise((resolve) => waiting.push(resolve));
  };
  const release = (session) => {
    const next = waiting.shift();
    if (next === undefined) idle.push(session);
    else next(session);
  };
  const readMemory = async () => {
    const [current, peak] = await Promise.all([
      Promise.all(sessions.map((session) => samplers.current.sample(session.pid))),
      Promise.all(sessions.map((session) => samplers.peak.sample(session.pid))),
    ]);
    memory.samples += 1;
    memory.currentPoolWorkingSetBytes = sumMemorySamples(current);
    memory.processPeakWorkingSetTotalBytes = sumMemorySamples(peak);
    memory.sessionCurrentWorkingSetBytes = current;
    memory.sessionPeakWorkingSetBytes = peak;
    if (memory.currentPoolWorkingSetBytes === null) memory.unavailableSamples += 1;
    return memory.currentPoolWorkingSetBytes;
  };
  const sampleMemory = async () => {
    if (samplers === null) return;
    let currentPoolWorkingSetBytes = await readMemory();
    // A sampler answers `null` for a timeout or a transient query failure just
    // as it does for a genuinely unobservable process. Enforcing a limit on the
    // first `null` would let one slow PowerShell round trip invalidate a run
    // that is nowhere near its limit, so an enforced sample is read once more
    // before it counts as unobservable.
    if (memoryLimitBytes !== null && currentPoolWorkingSetBytes === null) {
      currentPoolWorkingSetBytes = await readMemory();
    }
    if (memoryLimitBytes === null) return;
    if (currentPoolWorkingSetBytes === null) {
      throw new Error("CC2 session pool memory limit could not be checked");
    }
    if (currentPoolWorkingSetBytes > memoryLimitBytes) {
      memory.limitExceeded = true;
      limitExceeded = new Error(
        `CC2 session pool memory limit exceeded: ${currentPoolWorkingSetBytes} > ${memoryLimitBytes}`,
      );
      throw limitExceeded;
    }
  };

  return Object.freeze({
    pids() { return [...sessions.map((session) => session.pid)]; },
    async sampleMemory() {
      await sampleMemory();
    },
    async request(options = {}) {
      if (closed) throw new Error("CC2 session pool is closed");
      if (limitExceeded !== null) throw limitExceeded;
      assertPoolCompatible(options, settings);
      const session = await acquire();
      try {
        const response = await session.suggest({
          state: options.state,
          thinkMs: options.thinkMs ?? 500,
        });
        stats.requests += 1;
        if (samplers !== null && stats.requests % memorySampleEveryRequests === 0) await sampleMemory();
        return { ...response, peakMemoryBytes: null };
      } finally {
        release(session);
      }
    },
    evidence() {
      return Object.freeze({
        id: "reused-cc2-session-fixed-selection-budget/1",
        selectionLimit,
        searchSeed,
        ...stats,
        memory: {
          id: "cc2-session-working-set/1",
          enabled: samplers !== null,
          sampleEveryRequests: memorySampleEveryRequests,
          limitBytes: memoryLimitBytes,
          ...memory,
        },
      });
    },
    async close() {
      closed = true;
      await Promise.all(sessions.map((session) => session.close()));
      if (samplers !== null) await Promise.all([samplers.current.close(), samplers.peak.close()]);
    },
    // Synchronous last resort for signal handlers, where there is no time to
    // wait for a clean TBP `quit` round trip. Leaving resident CC2 processes
    // behind would silently compete with the next run for CPU.
    terminate() {
      closed = true;
      for (const session of sessions) session.terminate();
      samplers?.current.terminate?.();
      samplers?.peak.terminate?.();
    },
  });
}

function sumMemorySamples(samples) {
  if (!samples.every((value) => Number.isSafeInteger(value) && value >= 0)) return null;
  const total = samples.reduce((sum, value) => sum + value, 0);
  return Number.isSafeInteger(total) ? total : null;
}

// A session's binary, budget and identity are fixed when its process starts, so
// a request that disagrees with them fails instead of being served by a process
// that was configured differently.
function assertPoolCompatible(options, settings) {
  const mismatched = [
    ["binary", options.binary, settings.binary],
    ["expectedName", options.expectedName ?? "Cold Clear 2", settings.expectedName],
    ["selectionLimit", options.selectionLimit, settings.selectionLimit],
    ["searchSeed", options.searchSeed, settings.searchSeed],
  ].filter(([, requested, configured]) => requested !== undefined && requested !== configured);
  const requestedArguments = options.binaryArguments;
  if (requestedArguments !== undefined &&
      JSON.stringify(requestedArguments) !== JSON.stringify(settings.binaryArguments)) {
    mismatched.push(["binaryArguments", requestedArguments, settings.binaryArguments]);
  }
  if (mismatched.length > 0) {
    throw new Error(`CC2 session pool cannot serve a request with a different ${mismatched
      .map(([name]) => name).join(", ")}`);
  }
}

function searchBudgetArguments(binaryArguments, selectionLimit, searchSeed) {
  const processArguments = [...binaryArguments];
  if (selectionLimit !== null && selectionLimit !== undefined) {
    processArguments.push("--search-selection-limit", String(selectionLimit));
  }
  if (searchSeed !== null && searchSeed !== undefined) {
    processArguments.push("--search-seed", String(searchSeed));
  }
  return processArguments;
}

function write(child, message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function assertSearchBudget(selectionLimit, searchSeed) {
  if (selectionLimit !== null && (
    !Number.isSafeInteger(selectionLimit) || selectionLimit < 1 || selectionLimit > 10_000_000
  )) {
    throw new Error("selectionLimit must be null or an integer from 1 to 10000000");
  }
  if (searchSeed !== null && (
    !Number.isSafeInteger(searchSeed) || searchSeed < 0 || searchSeed > 0xffff_ffff
  )) {
    throw new Error("searchSeed must be null or a uint32 integer");
  }
}

function assertRequest(state, thinkMs, selectionLimit, searchSeed) {
  if (!Number.isSafeInteger(thinkMs) || thinkMs < 10 || thinkMs > 60_000) {
    throw new Error("thinkMs must be an integer from 10 to 60000");
  }
  assertSearchBudget(selectionLimit, searchSeed);
  if (!Array.isArray(state?.board) || state.board.length !== 40) {
    throw new Error("CC2 state requires 40 board rows");
  }
  if (!state.board.every((row) => Array.isArray(row) && row.length === 10)) {
    throw new Error("CC2 state requires 10 board columns");
  }
  if (!Array.isArray(state.queue) || state.queue.length === 0) {
    throw new Error("CC2 state requires a non-empty queue");
  }
}
