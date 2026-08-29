import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Samples the aggregate resident set of the two CC2 executables. This is kept
 * separate from session-pool measurements: co-scheduled arms need a host-wide
 * observation that includes every CC2 process, not just the pool owned by one
 * runner.
 */
export function createCc2HostMemoryMonitor({ sampleEveryMs, sampleHost = sampleCc2HostMemory }) {
  if (!Number.isSafeInteger(sampleEveryMs) || sampleEveryMs < 1) {
    throw new Error("sampleEveryMs must be a positive integer");
  }
  const samples = [];
  let timer = null;
  let pending = Promise.resolve();

  const take = () => {
    pending = pending.then(async () => {
      try {
        const sample = await sampleHost();
        if (!Number.isSafeInteger(sample.workingSetBytes) || sample.workingSetBytes < 0 ||
            !Number.isSafeInteger(sample.processCount) || sample.processCount < 0) {
          throw new Error("invalid host memory sample");
        }
        samples.push({ at: new Date().toISOString(), ...sample });
      } catch (error) {
        samples.push({ at: new Date().toISOString(), error: String(error.message ?? error) });
      }
    });
    return pending;
  };

  return {
    async start() {
      await take();
      timer = setInterval(() => { void take(); }, sampleEveryMs);
      return samples.at(-1);
    },
    async stop({ ownedPids = [] } = {}) {
      if (timer !== null) clearInterval(timer);
      await take();
      return summarize(samples, sampleEveryMs, ownedPids);
    },
  };
}

export async function sampleCc2HostMemory() {
  const command = [
    "$names=@('cold-clear-2-s2','cold-clear-2')",
    "$items=@(Get-Process -Name $names -ErrorAction SilentlyContinue)",
    "$sum=($items | Measure-Object -Property WorkingSet64 -Sum).Sum",
    "if($null -eq $sum){$sum=0}",
    "@{workingSetBytes=[int64]$sum;processCount=@($items).Count;processIds=@($items.Id)}|ConvertTo-Json -Compress",
  ].join("; ");
  const { stdout } = await execFileAsync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command", command,
  ], { windowsHide: true, timeout: 5_000 });
  return JSON.parse(stdout);
}

// W1-1 showed that repeatedly creating PowerShell processes can occasionally
// yield an empty successful stdout under arena load. Keep one supervised
// sampler process for a run instead; a malformed or missing response remains
// a fail-closed sampling error.
export function createPersistentCc2HostMemorySampler() {
  let child = null;
  let pending = null;
  let buffered = "";
  let terminalError = null;
  const script = [
    "$ErrorActionPreference='Stop'",
    "$names=@('cold-clear-2-s2','cold-clear-2')",
    "while(($request=[Console]::In.ReadLine()) -ne $null){",
    "if($request -eq 'sample'){",
    "$items=@(Get-Process -Name $names -ErrorAction SilentlyContinue)",
    "$sum=($items | Measure-Object -Property WorkingSet64 -Sum).Sum",
    "if($null -eq $sum){$sum=0}",
    "@{workingSetBytes=[int64]$sum;processCount=@($items).Count;processIds=@($items.Id)}|ConvertTo-Json -Compress",
    "[Console]::Out.Flush()",
    "} elseif($request -eq 'stop'){break}",
    "}",
  ].join("; ");
  const fail = (error) => {
    const resolved = error instanceof Error ? error : new Error(String(error));
    terminalError ??= resolved;
    if (pending !== null) { pending.reject(resolved); pending = null; }
  };
  const consume = (line) => {
    if (line.trim() === "") return;
    if (pending === null) { fail(new Error(`unexpected host sampler output: ${line}`)); return; }
    try { pending.resolve(JSON.parse(line)); } catch (error) { pending.reject(error); }
    pending = null;
  };
  return {
    async start() {
      if (child !== null) throw new Error("host sampler already started");
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
      });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (data) => {
        buffered += data;
        const lines = buffered.split(/\r?\n/); buffered = lines.pop();
        for (const line of lines) consume(line);
      });
      child.on("error", fail);
      child.on("exit", (code) => { if (code !== 0) fail(new Error(`host sampler exited with ${code}`)); });
    },
    sample() {
      if (child === null) return Promise.reject(new Error("host sampler is not started"));
      if (terminalError !== null) return Promise.reject(terminalError);
      if (pending !== null) return Promise.reject(new Error("host sampler request already pending"));
      return new Promise((resolve, reject) => { pending = { resolve, reject }; child.stdin.write("sample\n"); });
    },
    async close() {
      if (child === null) return;
      child.stdin.end("stop\n");
      await Promise.race([once(child, "exit"), new Promise((resolve) => setTimeout(resolve, 5_000))]);
      if (child.exitCode === null) child.kill();
      child = null;
    },
  };
}

function summarize(samples, sampleEveryMs, ownedPids) {
  const valid = samples.filter((sample) => sample.error === undefined);
  const owned = new Set(ownedPids.filter((pid) => Number.isSafeInteger(pid) && pid > 0));
  const finalIds = new Set(valid.at(-1)?.processIds ?? []);
  const remainingOwned = [...owned].filter((pid) => finalIds.has(pid));
  return {
    enabled: true,
    sampleEveryMs,
    samples,
    peakWorkingSetBytes: valid.length === 0 ? null : Math.max(...valid.map((sample) => sample.workingSetBytes)),
    unavailableSamples: samples.filter((sample) => sample.error !== undefined).length,
    orphanProcesses: {
      // This run owns no session PID before pool creation. At shutdown only
      // PIDs created by this run count as orphans; co-scheduled peers remain
      // part of host RSS but must not invalidate each other's cleanup proof.
      before: 0,
      after: remainingOwned.length,
    },
    hostProcessCount: valid.at(-1)?.processCount ?? null,
    initialProcessCount: valid[0]?.processCount ?? null,
    ownedProcessPids: [...owned],
  };
}
