import { parentPort, workerData } from "node:worker_threads";

import { createArenaPhaseWorker } from "./arena-phase-scheduler.mjs";
import { requestCc2Suggestion } from "./cc2-bridge.mjs";
import { playCc2HeadlessGame } from "./cc2-headless-game.mjs";
import { createArenaProtocol } from "./headless-arena.mjs";
import { createProcessMemorySampler } from "./process-memory-sampler.mjs";

const sampler = createProcessMemorySampler();
const phaseScheduler = createArenaPhaseWorker(
  workerData.phaseBuffer,
  workerData.workerIndex,
  workerData.workerCount,
  (message) => parentPort.postMessage(message),
);
let active = false;

parentPort.on("message", async (message) => {
  if (message?.type === "cc2-grant") {
    phaseScheduler.handle(message);
    return;
  }
  if (message?.type === "close") {
    if (active) {
      parentPort.postMessage({ type: "close-refused", error: "arena worker is active" });
      return;
    }
    phaseScheduler.close();
    await sampler.close();
    parentPort.postMessage({ type: "closed" });
    parentPort.close();
    return;
  }
  if (message?.type !== "play" || !Number.isSafeInteger(message.taskId) || message.taskId < 1) {
    parentPort.postMessage({
      type: "result",
      taskId: message?.taskId ?? null,
      ok: false,
      error: "arena worker received an invalid task",
    });
    return;
  }
  if (active) {
    parentPort.postMessage({
      type: "result",
      taskId: message.taskId,
      ok: false,
      error: "arena worker received concurrent tasks",
    });
    return;
  }
  active = true;
  try {
    const protocol = createArenaProtocol(message.protocol);
    const result = await playCc2HeadlessGame(message.descriptor, protocol, {
      engines: message.engines,
      phaseScheduler,
      requestSuggestion: (request) => requestCc2Suggestion({
        ...request,
        samplePeakMemory: sampler.sample,
      }),
    });
    parentPort.postMessage({ type: "result", taskId: message.taskId, ok: true, result });
  } catch (error) {
    parentPort.postMessage({
      type: "result",
      taskId: message.taskId,
      ok: false,
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  } finally {
    active = false;
  }
});
