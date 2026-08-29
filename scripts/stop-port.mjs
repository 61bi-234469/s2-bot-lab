import { execFileSync } from "node:child_process";

const portArgument = process.argv.find((argument) => argument.startsWith("--port="));
const port = Number(portArgument?.slice("--port=".length) ?? 4173);

if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
  throw new Error("port must be an integer from 1 to 65535");
}

if (process.platform !== "win32") {
  console.log(`Port cleanup is only needed on Windows; continuing on ${process.platform}.`);
  process.exit(0);
}

const netstat = execFileSync("netstat", ["-ano", "-p", "tcp"], { encoding: "utf8" });
const escapedPort = String(port).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const listenerPattern = new RegExp(`^\\s*TCP\\s+\\S+:${escapedPort}\\s+\\S+\\s+LISTENING\\s+(\\d+)\\s*$`, "i");
const processIds = new Set();

for (const line of netstat.split(/\r?\n/)) {
  const match = line.match(listenerPattern);
  if (match !== null) processIds.add(Number(match[1]));
}

for (const processId of processIds) {
  if (processId === process.pid) continue;
  try {
    process.kill(processId);
    console.log(`Stopped process ${processId} listening on port ${port}.`);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}
