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

export function createProcessMemorySampler({ timeoutMs = 2_000, metric = "peak-working-set" } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("sampler timeoutMs must be positive");
  const property = {
    "peak-working-set": "PeakWorkingSet64",
    "working-set": "WorkingSet64",
  }[metric];
  if (property === undefined) throw new Error("sampler metric must be peak-working-set or working-set");
  if (process.platform !== "win32") {
    return Object.freeze({ sample: async () => null, close: async () => {} });
  }

  const child = spawn(
    "powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", POWERSHELL_SAMPLER(property)],
    { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
  );
  child.stdout.setEncoding("utf8");
  let buffer = "";
  let sequence = 0;
  let closed = false;
  const pending = new Map();

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
  child.once("error", failPending);
  child.once("exit", failPending);

  return Object.freeze({
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
      if (closed) return;
      closed = true;
      child.stdin.end("quit\n");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill();
          resolve();
        }, timeoutMs);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
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
