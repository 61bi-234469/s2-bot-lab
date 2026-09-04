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
  let childExited = false;
  let resolveChildExit;
  const childExit = new Promise((resolve) => {
    resolveChildExit = resolve;
  });
  let active = false;
  let started = false;
  let spawnObserved = false;
  const messages = [];
  const waiters = new Set();
  let fatalError = null;

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
        const error = new Error(`CC2 session timed out waiting for ${label}`);
        if (label === "suggestion") error.code = "CC2_SUGGESTION_TIMEOUT";
        reject(error);
      }, timeoutMs);
      waiters.add(waiter);
    });
  };
  const failSession = (error) => {
    if (fatalError !== null || childExited) return;
    fatalError = error;
    closed = true;
    abortChild(child);
    settleWaiters(error);
  };
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.on("error", (error) => {
    failSession(new Error(`CC2 session stdin failed: ${error.message}`));
  });
  child.stdout.on("error", (error) => {
    failSession(new Error(`CC2 session stdout failed: ${error.message}`));
  });
  child.stderr.on("error", (error) => {
    failSession(new Error(`CC2 session stderr failed: ${error.message}`));
  });
  child.stdout.on("data", (chunk) => {
    if (fatalError !== null) return;
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    const parsedMessages = [];
    for (const line of lines) {
      if (line === "") continue;
      try {
        const message = JSON.parse(line);
        if (message === null || typeof message !== "object" || Array.isArray(message)) {
          failSession(new Error("CC2 session returned a malformed protocol message"));
          return;
        }
        parsedMessages.push(message);
      } catch (error) {
        failSession(new Error(`CC2 session returned invalid JSON: ${error.message}`));
        return;
      }
    }
    // Parse the whole chunk before publishing any frame. If a valid response
    // is followed by a malformed frame in the same chunk, the valid response
    // must not race ahead of the protocol failure and make the request appear
    // successful while the session is being retired.
    for (const message of parsedMessages) {
      messages.push(message);
      settleWaiters(null, message);
    }
  });
  let rejectSpawned;
  const spawned = new Promise((resolve, reject) => {
    rejectSpawned = reject;
    child.once("spawn", () => {
      spawnObserved = true;
      resolve();
    });
    child.once("error", (error) => {
      if (!spawnObserved && !childExited) {
        childExited = true;
        closed = true;
        resolveChildExit({ code: null, signal: null, error });
      }
      reject(error);
    });
  });
  child.once("exit", (code, signal) => {
    childExited = true;
    closed = true;
    resolveChildExit({ code, signal });
    if (!spawnObserved) rejectSpawned(new Error("CC2 session exited before spawning"));
    settleWaiters(new Error(`CC2 session exited with code ${code}, signal ${signal}: ${stderr.trim()}`));
  });

  let info;
  try {
    await spawned;
    const infoPromise = waitFor((message) => message.type === "info", 10_000, "info");
    const readyPromise = waitFor((message) => message.type === "ready", 10_000, "ready");
    write(child, { type: "rules" });
    [info] = await Promise.all([infoPromise, readyPromise]);
    if (info.name !== expectedName) {
      throw new Error(`CC2 session identity mismatch: expected ${expectedName}, received ${info.name}`);
    }
  } catch (error) {
    const cleanupError = await terminateChildAndWait(child, childExit, () => childExited);
    if (cleanupError !== null) throw combineCleanupError(error, cleanupError);
    throw error;
  }

  return Object.freeze({
    pid: child.pid,
    selectionLimit,
    searchSeed,
    isClosed() { return closed; },
    async suggest({ state, thinkMs = 500, timeLimitEnabled = selectionLimit === null, signal = null }) {
      assertRequest(state, thinkMs, selectionLimit, searchSeed);
      if (typeof timeLimitEnabled !== "boolean") throw new Error("timeLimitEnabled must be a boolean");
      assertAbortSignal(signal);
      throwIfAborted(signal);
      if (closed) throw new Error("CC2 session is closed");
      if (active) throw new Error("CC2 session does not accept concurrent suggestions");
      active = true;
      const requestStartedAt = performance.now();
      const onAbort = () => abortChild(child);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) onAbort();
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
        // A time-limited request asks the reviewed forks for their best move at
        // the deadline. With a selection cap, the worker stops at that cap if
        // it arrives first and remains idle until this request is made.
        if (timeLimitEnabled) {
          await delayWithSignal(thinkMs, signal);
        }
        const suggestionPromise = waitFor(
          (message) => message.type === "suggestion" && Array.isArray(message.moves),
          selectionLimit === null ? 10_000 : suggestTimeoutMs,
          "suggestion",
        );
        write(child, { type: timeLimitEnabled && selectionLimit !== null ? "suggest_now" : "suggest" });
        const suggestion = await awaitWithSignal(suggestionPromise, signal);
        // A consumed suggestion must not satisfy the following request, so it
        // leaves the backlog before the empty-suggestion check can throw.
        const index = messages.indexOf(suggestion);
        if (index >= 0) messages.splice(index, 1);
        if (suggestion.moves.length === 0) {
          const error = new Error("CC2 returned no suggested move");
          error.requestToSuggestionMs = performance.now() - requestStartedAt;
          // An empty suggestion is an infrastructure fault, not a game outcome, and
          // `move_info` is the only evidence that says which branch produced it: an
          // inactive bot reports zero selections, a searched-but-unexpanded root does
          // not. Discarding it once cost a run its explanation.
          error.suggestionReceived = true;
          error.moveInfo = suggestion.move_info ?? null;
          throw error;
        }
        const requestToSuggestionMs = performance.now() - requestStartedAt;
        return { info, suggestion, peakMemoryBytes: null, requestToSuggestionMs };
      } catch (error) {
        if (signal?.aborted) {
          const reason = abortError(signal);
          abortChild(child);
          const cleanupError = await terminateChildAndWait(child, childExit, () => childExited);
          if (cleanupError !== null) throw combineCleanupError(reason, cleanupError);
          throw reason;
        }
        if (error?.code === "CC2_SUGGESTION_TIMEOUT") {
          closed = true;
          abortChild(child);
        }
        if (closed && !childExited) {
          const cleanupError = await terminateChildAndWait(child, childExit, () => childExited);
          if (cleanupError !== null) throw combineCleanupError(error, cleanupError);
        }
        throw error;
      } finally {
        // The bot searches continuously between `start` and `stop`, and its DAG
        // has no node limit, so a session that answered a request and then sat
        // idle kept expanding: measured at roughly 200 MB/s, reaching 22 GB in
        // under three minutes of silence. Every request re-starts from the full
        // position and this bridge never sends `play` or `new_piece`, so
        // stopping here discards nothing a later request would have reused.
        if (!closed && started) {
          try {
            write(child, { type: "stop" });
          } catch {
            // A concurrent abort or child exit owns the failure result.
          }
          started = false;
        }
        active = false;
        signal?.removeEventListener("abort", onAbort);
      }
    },
    async close() {
      if (!closed) {
        try {
          write(child, { type: "quit" });
          child.stdin.end();
        } catch {
          abortChild(child);
        }
      }
      const gracefulFailure = await waitForChildExit(childExit, () => childExited);
      if (gracefulFailure === null) return;
      const cleanupError = await terminateChildAndWait(child, childExit, () => childExited);
      if (cleanupError !== null) throw combineCleanupError(gracefulFailure, cleanupError);
      throw gracefulFailure;
    },
    terminate() {
      closed = true;
      if (!childExited) abortChild(child);
    },
    async terminateAndWait() {
      closed = true;
      const cleanupError = await terminateChildAndWait(child, childExit, () => childExited);
      if (cleanupError !== null) throw cleanupError;
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
  spawnProcess = spawn,
  signal = null,
  captureProtocolTrace = false,
}) {
  assertRequest(state, thinkMs, selectionLimit, searchSeed);
  if (!Array.isArray(binaryArguments) || !binaryArguments.every((value) => typeof value === "string")) {
    throw new Error("binaryArguments must be an array of strings");
  }
  assertAbortSignal(signal);
  throwIfAborted(signal);
  const messages = [];
  let stdoutBuffer = "";
  let stderr = "";
  let suggestTimer = null;
  let suggestion = null;
  let peakMemoryBytes = null;
  let memorySample = null;
  let requestToSuggestionMs = null;
  const requestStartedAt = performance.now();
  let spawnedAt = null;
  let spawnObserved = false;
  let childExited = false;
  const protocolTrace = {
    schema: "s2-analysis-engine/cc2-protocol-trace/1",
    sent: [],
    received: [],
    events: [],
  };
  const traceEvent = (kind, extra = {}) => {
    protocolTrace.events.push({
      kind,
      elapsedMs: performance.now() - requestStartedAt,
      ...extra,
    });
  };
  const traceSent = (message) => {
    protocolTrace.sent.push(structuredClone(message));
  };
  const snapshotTrace = () => structuredClone(protocolTrace);
  const attachTrace = (error) => {
    if (error !== null && typeof error === "object") error.protocolTrace = snapshotTrace();
    return error;
  };
  let resolveChildExit;
  const childExit = new Promise((resolve) => {
    resolveChildExit = resolve;
  });
  let resolveSpawned;
  let rejectSpawned;
  const spawned = new Promise((resolve, reject) => {
    resolveSpawned = resolve;
    rejectSpawned = reject;
  });
  let resolveHandshake;
  let rejectHandshake;
  let handshakeSettled = false;
  const handshake = new Promise((resolve, reject) => {
    resolveHandshake = resolve;
    rejectHandshake = reject;
  });
  // Abort or a spawn error can reject these phase promises before the async
  // controller reaches their corresponding await. Keep those internal
  // rejections observed while preserving the original error for the caller.
  void spawned.catch(() => {});
  void handshake.catch(() => {});
  let infoMessage = null;
  let readyMessage = null;

  const processArguments = searchBudgetArguments(binaryArguments, selectionLimit, searchSeed);
  const child = spawnProcess(binary, processArguments, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  // A forced termination can close stdin while no phase-specific write
  // waiter is installed. Keep that expected cleanup error from becoming an
  // unhandled stream exception.
  child.stdin.on("error", () => {});
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let streamFailure = null;
  let failRequest = null;
  const recordStreamFailure = (error) => {
    streamFailure = error;
    failRequest?.(error);
  };
  child.stdout.on("error", recordStreamFailure);
  child.stderr.on("error", recordStreamFailure);
  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line === "") continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        const protocolError = new Error(`CC2 returned invalid JSON: ${error.message}`);
        protocolError.cause = error;
        recordStreamFailure(protocolError);
        continue;
      }
      if (message === null || typeof message !== "object" || Array.isArray(message)) {
        recordStreamFailure(new Error("CC2 returned a malformed protocol message"));
        continue;
      }
      protocolTrace.received.push(structuredClone(message));
      messages.push(message);
      if (message.type === "info") infoMessage = message;
      if (message.type === "ready") readyMessage = message;
      if (!handshakeSettled && infoMessage !== null && readyMessage !== null) {
        handshakeSettled = true;
        traceEvent("handshake-complete");
        resolveHandshake();
      }
      if (message.type === "suggestion" && suggestion === null) {
        suggestion = message;
        requestToSuggestionMs = performance.now() - requestStartedAt;
        traceEvent("suggestion-received", { moveCount: message.moves?.length ?? null });
        memorySample = Promise.resolve().then(() => samplePeakMemory(child.pid)).then((value) => {
          peakMemoryBytes = value;
        }).catch(() => {
          peakMemoryBytes = null;
        }).finally(() => {
          try {
            const quit = { type: "quit" };
            traceSent(quit);
            child.stdin.write(`${JSON.stringify(quit)}\n`);
            child.stdin.end();
          } catch {
            // The request may have been aborted while memory sampling was in
            // flight. The owning catch path is responsible for proving exit.
          }
        });
      }
    }
  });

  const requestDeadlineAt = performance.now() + thinkMs + 10_000;
  let clearRequestTimeout = () => {};
  let rejectExit = () => {};
  const requestFailure = (error) => {
    clearRequestTimeout();
    if (suggestTimer !== null) {
      clearTimeout(suggestTimer);
      suggestTimer = null;
    }
    rejectSpawned(error);
    if (!handshakeSettled) {
      handshakeSettled = true;
      rejectHandshake(error);
    }
    rejectExit(error);
    abortChild(child);
  };

  const exit = new Promise((resolve, reject) => {
    rejectExit = reject;
    const timeout = setTimeout(() => {
      const error = new Error(`CC2 did not return a suggestion within ${thinkMs + 10_000} ms`);
      requestFailure(error);
    }, Math.max(1, requestDeadlineAt - performance.now()));
    clearRequestTimeout = () => clearTimeout(timeout);
    child.once("error", (error) => {
      clearTimeout(timeout);
      requestFailure(error);
      if (!spawnObserved) {
        childExited = true;
        resolveChildExit({ code: null, signal: null, error });
      }
    });
    child.once("spawn", () => {
      spawnObserved = true;
      spawnedAt = performance.now();
      traceEvent("spawn");
      resolveSpawned();
      try {
        const rules = { type: "rules" };
        traceSent(rules);
        write(child, rules);
      } catch (error) {
        requestFailure(error);
      }
    });
    child.once("exit", (code, signal) => {
      childExited = true;
      traceEvent("exit", { code, signal });
      clearTimeout(timeout);
      if (suggestTimer !== null) clearTimeout(suggestTimer);
      resolveChildExit({ code, signal });
      if (!spawnObserved) rejectSpawned(new Error("CC2 exited before spawning"));
      if (!handshakeSettled) {
        handshakeSettled = true;
        rejectHandshake(new Error("CC2 exited before completing the TBP handshake"));
      }
      resolve({ code, signal });
    });
  });
  failRequest = requestFailure;
  if (streamFailure !== null) requestFailure(streamFailure);
  const onAbort = () => requestFailure(abortError(signal));
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) requestFailure(abortError(signal));
  // The controller below awaits this promise after the handshake. Keep the
  // rejection handled while a child can fail during the earlier phases.
  void exit.catch(() => {});

  try {
    await spawned;
    await handshake;

    const info = infoMessage;
    const ready = readyMessage;
    if (info?.name !== expectedName || ready === null) {
      throw new Error("CC2 did not complete the TBP handshake");
    }

    const start = { type: "start", ...state };
    traceSent(start);
    await writeAndWait(child, start, {
      timeoutMs: Math.max(1, requestDeadlineAt - performance.now()),
      signal,
    });
    traceEvent("start-write-drained");
    const remainingThinkMs = selectionLimit === null
      ? Math.max(0, (spawnedAt + thinkMs) - performance.now())
      : 0;
    suggestTimer = setTimeout(() => {
      try {
        const suggest = { type: "suggest" };
        traceSent(suggest);
        write(child, suggest);
        traceEvent("suggest-written");
      } catch (error) {
        requestFailure(error);
      }
    }, remainingThinkMs);

    const exitResult = await exit;
    if (exitResult.code !== 0 || exitResult.signal !== null) {
      throw new Error(`CC2 exited with code ${exitResult.code}, signal ${exitResult.signal}: ${stderr.trim()}`);
    }
    if (!Array.isArray(suggestion?.moves) || suggestion.moves.length === 0) {
      const error = new Error("CC2 returned no suggested move");
      error.requestToSuggestionMs = requestToSuggestionMs;
      // The same message covers "no suggestion arrived" and "an empty one did".
      // Keep the message stable for `classifyProposalError`, and attach the
      // evidence that separates the two.
      error.suggestionReceived = suggestion !== null;
      error.moveInfo = suggestion?.move_info ?? null;
      throw error;
    }
    if (memorySample !== null) await awaitWithSignal(memorySample, signal);
    await childExit;
    if (streamFailure !== null) throw streamFailure;
    return {
      info,
      suggestion,
      peakMemoryBytes,
      requestToSuggestionMs,
      ...(captureProtocolTrace ? { protocolTrace: snapshotTrace() } : {}),
    };
  } catch (error) {
    const cleanupError = await terminateChildAndWait(child, childExit, () => childExited);
    if (cleanupError !== null) throw attachTrace(combineCleanupError(error, cleanupError));
    throw attachTrace(error);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
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
    const cleanup = await Promise.allSettled(settled
      .filter((entry) => entry.status === "fulfilled")
      .map(async (entry) => {
        const session = entry.value;
        if (typeof session.terminateAndWait === "function") {
          await session.terminateAndWait();
          return;
        }
        const termination = session.terminate?.();
        if (termination !== null && termination !== undefined && typeof termination.then === "function") {
          await termination;
        }
      }));
    const cleanupFailure = cleanup.find((entry) => entry.status === "rejected");
    if (cleanupFailure !== undefined) throw combineCleanupError(failure.reason, cleanupFailure.reason);
    throw failure.reason;
  }
  const sessions = settled.map((entry) => entry.value);
  const idle = [...sessions];
  const waiting = [];
  const retired = new Set();
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

  const acquire = (signal = null) => {
    assertAbortSignal(signal);
    throwIfAborted(signal);
    let ready;
    while ((ready = idle.pop()) !== undefined) {
      if (ready.isClosed?.() !== true) return Promise.resolve(ready);
      retire(ready);
    }
    if (retired.size === sessions.length) {
      return Promise.reject(new Error("CC2 session pool has no live sessions"));
    }
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject, signal, onAbort: null };
      const remove = () => {
        const index = waiting.indexOf(waiter);
        if (index >= 0) waiting.splice(index, 1);
        signal?.removeEventListener("abort", waiter.onAbort);
      };
      waiter.onAbort = () => {
        remove();
        reject(abortError(signal));
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      waiting.push(waiter);
      if (signal?.aborted) waiter.onAbort();
    });
  };
  const release = (session) => {
    if (retired.has(session)) {
      if (retired.size === sessions.length) {
        closed = true;
        rejectWaiting(new Error("CC2 session pool has no live sessions"));
      }
      return;
    }
    while (waiting.length > 0) {
      const next = waiting.shift();
      next.signal?.removeEventListener("abort", next.onAbort);
      if (next.signal?.aborted) {
        next.reject(abortError(next.signal));
        continue;
      }
      next.resolve(session);
      return;
    }
    idle.push(session);
  };
  const retire = (session) => {
    retired.add(session);
    const index = idle.indexOf(session);
    if (index >= 0) idle.splice(index, 1);
    if (retired.size === sessions.length) {
      closed = true;
      rejectWaiting(new Error("CC2 session pool has no live sessions"));
    }
  };
  const rejectWaiting = (error) => {
    while (waiting.length > 0) {
      const waiter = waiting.shift();
      waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
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
      const session = await acquire(options.signal ?? null);
      let reusable = true;
      try {
        const suggestOptions = {
          state: options.state,
          thinkMs: options.thinkMs ?? 500,
        };
        if (options.signal !== undefined) suggestOptions.signal = options.signal;
        const response = await session.suggest(suggestOptions);
        stats.requests += 1;
        if (samplers !== null && stats.requests % memorySampleEveryRequests === 0) {
          await awaitWithSignal(sampleMemory(), options.signal ?? null);
        }
        return { ...response, peakMemoryBytes: null };
      } catch (error) {
        if (session.isClosed?.() === true) {
          reusable = false;
          retire(session);
        }
        throw error;
      } finally {
        if (reusable) release(session);
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
      rejectWaiting(new Error("CC2 session pool is closing"));
      await Promise.all(sessions.map((session) => session.close()));
      if (samplers !== null) await Promise.all([samplers.current.close(), samplers.peak.close()]);
    },
    // Synchronous last resort for signal handlers, where there is no time to
    // wait for a clean TBP `quit` round trip. Leaving resident CC2 processes
    // behind would silently compete with the next run for CPU.
    terminate() {
      closed = true;
      rejectWaiting(new Error("CC2 session pool is terminated"));
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

function writeAndWait(child, message, { timeoutMs = 30_000, signal = null } = {}) {
  assertAbortSignal(signal);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1) {
    return Promise.reject(new Error("CC2 stdin write timeout must be a positive number"));
  }
  if (signal?.aborted) return Promise.reject(abortError(signal));
  const payload = `${JSON.stringify(message)}\n`;
  return new Promise((resolve, reject) => {
    let callbackDone = false;
    let drained = true;
    let writeReturned = false;
    let settled = false;
    let timeout = null;

    const cleanup = () => {
      child.stdin.removeListener("error", onError);
      child.stdin.removeListener("drain", onDrain);
      child.removeListener("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
      if (timeout !== null) clearTimeout(timeout);
    };
    const finish = () => {
      if (!settled && writeReturned && callbackDone && drained) {
        settled = true;
        cleanup();
        resolve();
      }
    };
    const onError = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onDrain = () => {
      drained = true;
      finish();
    };
    const onExit = (code, signal) => {
      onError(new Error(`CC2 child exited during stdin write with code ${code}, signal ${signal}`));
    };
    const onAbort = () => onError(abortError(signal));

    child.stdin.once("error", onError);
    child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => {
      onError(new Error(`CC2 stdin write timed out after ${Math.ceil(timeoutMs)} ms`));
    }, timeoutMs);
    try {
      const needsDrain = !child.stdin.write(payload, (error) => {
        if (error) {
          onError(error);
          return;
        }
        callbackDone = true;
        finish();
      });
      drained = !needsDrain;
      writeReturned = true;
      if (needsDrain) child.stdin.once("drain", onDrain);
      finish();
    } catch (error) {
      onError(error);
    }
  });
}

function abortChild(child) {
  try {
    child.stdin?.destroy?.();
  } catch {
    // The process termination below is still attempted.
  }
  try {
    child.kill();
  } catch {
    // A spawn failure can leave no killable process; the caller will still
    // fail closed if no exit event can be observed.
  }
}

async function terminateChildAndWait(child, childExit, isExited, timeoutMs = 2_000) {
  if (isExited()) return null;
  abortChild(child);
  if (isExited()) return null;
  let timeoutId = null;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(new Error(`CC2 child did not exit within ${timeoutMs} ms after termination`)), timeoutMs);
  });
  const result = await Promise.race([childExit.then(() => null), timeout]);
  if (timeoutId !== null) clearTimeout(timeoutId);
  return result;
}

async function waitForChildExit(childExit, isExited, timeoutMs = 2_000) {
  if (isExited()) return null;
  let timeoutId = null;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve(new Error(`CC2 child did not exit within ${timeoutMs} ms`)), timeoutMs);
  });
  const result = await Promise.race([childExit.then(() => null), timeout]);
  if (timeoutId !== null) clearTimeout(timeoutId);
  return result;
}

function combineCleanupError(original, cleanupError) {
  const originalMessage = original instanceof Error ? original.message : String(original);
  const error = new Error(`CC2 child cleanup failed after ${originalMessage}: ${cleanupError.message}`);
  error.name = "CC2CleanupError";
  error.cause = original;
  return error;
}

function awaitWithSignal(promise, signal) {
  if (signal === null) return promise;
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, error),
    );
  });
}

function delayWithSignal(timeoutMs, signal) {
  if (signal === null) return new Promise((resolve) => setTimeout(resolve, timeoutMs));
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, timeoutMs);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function assertAbortSignal(signal) {
  if (signal !== null && (typeof signal !== "object" ||
      typeof signal.aborted !== "boolean" ||
      typeof signal.addEventListener !== "function" ||
      typeof signal.removeEventListener !== "function")) {
    throw new Error("signal must be an AbortSignal or null");
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function abortError(signal) {
  if (signal?.reason !== undefined) return signal.reason;
  const error = new Error("CC2 request aborted");
  error.name = "AbortError";
  return error;
}

function assertSearchBudget(selectionLimit, searchSeed) {
  if (selectionLimit !== null && (
    !Number.isSafeInteger(selectionLimit) || selectionLimit < 1 || selectionLimit > 10_000_000
  )) {
    throw new Error("selectionLimit must be null or an integer from 1 to 10000000");
  }
  if (searchSeed !== null) {
    const validNumber = Number.isSafeInteger(searchSeed) && searchSeed >= 0;
    const validString = typeof searchSeed === "string" && /^(?:0|[1-9][0-9]*)$/.test(searchSeed) && BigInt(searchSeed) <= 0xffff_ffff_ffff_ffffn;
    if (!validNumber && !validString) throw new Error("searchSeed must be null or an unsigned 64-bit integer");
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
