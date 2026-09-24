import { spawn } from "node:child_process";

const POWERSHELL_SAMPLER = (property) => [
  "$ErrorActionPreference='Stop'",
  "while (($line = [Console]::In.ReadLine()) -ne $null) {",
  "  if ($line -eq 'quit') { break }",
  "  $parts = $line -split \"`t\", 2",
  `  try { $value = (Get-Process -Id ([int]$parts[1]) -ErrorAction Stop).${property}; [Console]::Out.WriteLine($parts[0] + "\`t" + $value) }`,
  "  catch { [Console]::Out.WriteLine($parts[0] + \"`tnull\") }",
  "}",
].join("\n");

export function createProcessMemorySampler({
  timeoutMs = 2_000,
  metric = "peak-working-set",
  spawnProcess = spawn,
  platform = process.platform,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("sampler timeoutMs must be positive");
  const property = {
    "peak-working-set": "PeakWorkingSet64",
    "working-set": "WorkingSet64",
  }[metric];
  if (property === undefined) throw new Error("sampler metric must be peak-working-set or working-set");
  if (typeof spawnProcess !== "function") throw new Error("sampler spawnProcess must be a function");
  if (platform !== "win32") {
    return Object.freeze({ sample: async () => null, close: async () => {} });
  }

  const child = spawnProcess(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SAMPLER(property)],
    { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  );
  child.stdout.setEncoding("utf8");
  let buffer = "";
  let sequence = 0;
  let closed = false;
  const pending = new Map();
  let childExited = false;
  let childSpawned = false;
  let resolveChildExit;
  const childExit = new Promise((resolve) => { resolveChildExit = resolve; });

  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      const separator = line.indexOf("\t");
      if (separator < 0) continue;
      const id = line.slice(0, separator);
      const request = pending.get(id);
      if (request === undefined) continue;
      pending.delete(id);
      clearTimeout(request.timer);
      const value = Number(line.slice(separator + 1));
      request.resolve(Number.isSafeInteger(value) && value >= 0 ? value : null);
    }
  });
  const failPending = () => {
    closed = true;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.resolve(null);
    }
    pending.clear();
  };
  const observeChildExit = () => {
    childExited = true;
    failPending();
    resolveChildExit();
  };
  child.once("spawn", () => { childSpawned = true; });
  child.on("error", () => {
    if (!childSpawned) {
      // No process was created, so there is no owned child whose exit could be
      // observed. This is the only error that can certify terminal ownership.
      observeChildExit();
      return;
    }
    // ChildProcess also emits `error` when a kill request fails.  That is not
    // proof that a successfully spawned process exited; disable sampling but
    // keep close() waiting for the real exit event.
    failPending();
  });
  child.once("exit", observeChildExit);

  return Object.freeze({
    pid:child.pid,
    hasExited(){return childExited;},
    sample(pid) {
      if (closed || !Number.isSafeInteger(pid) || pid <= 0) return Promise.resolve(null);
      const id = String(++sequence);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(null);
        }, timeoutMs);
        pending.set(id, { resolve, timer });
        child.stdin.write(`${id}\t${pid}\n`, (error) => {
          if (error === null || error === undefined) return;
          const request = pending.get(id);
          if (request === undefined) return;
          pending.delete(id);
          clearTimeout(timer);
          resolve(null);
        });
      });
    },
    async close() {
      if (childExited) return;
      closed = true;
      try { child.stdin.end("quit\n"); } catch { child.kill(); }
      if (!await waitForSamplerExit(childExit, () => childExited, timeoutMs)) {
        try { child.kill(); } catch { /* exit wait below fails closed */ }
        if (!await waitForSamplerExit(childExit, () => childExited, timeoutMs)) {
          throw new Error(`process memory sampler did not exit within ${timeoutMs} ms after termination`);
        }
      }
      failPending();
    },
    terminate() {
      if (closed) return;
      closed = true;
      child.kill();
      failPending();
    },
  });
}

async function waitForSamplerExit(childExit, isExited, timeoutMs) {
  if (isExited()) return true;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const exited = childExit.then(() => true);
  const result = await Promise.race([exited, timeout]);
  if (timer !== null) clearTimeout(timer);
  return result;
}
