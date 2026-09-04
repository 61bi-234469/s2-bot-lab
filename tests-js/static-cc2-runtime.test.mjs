import assert from "node:assert/strict";
import test from "node:test";

import { createStaticCc2Runtime } from "../cc2-gui/static-host.mjs";

test("static CC2 runtime retains one worker per session key and closes it explicitly", async () => {
  const workers = [];
  class FakeWorker {
    constructor() {
      this.terminated = false;
      workers.push(this);
    }
    postMessage(message) {
      queueMicrotask(() => {
        const value = message.type === "suggest"
          ? { suggestion: { moves: [], move_info: {} }, peakMemoryBytes: 65536 }
          : undefined;
        this.onmessage({ data: { id: message.id, ok: true, value } });
      });
    }
    terminate() { this.terminated = true; }
  }

  const runtime = createStaticCc2Runtime({ WorkerType: FakeWorker, idleTimeoutMs: 60_000 });
  const input = { sessionKey: "left", engine: "cc2-raw", state: {}, selectionLimit: 512, thinkMs: null };
  await runtime.propose(input);
  await runtime.propose(input);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, false);

  await runtime.closeSessions({ sessionKeys: ["left"] });
  assert.equal(workers[0].terminated, true);
});

test("static CC2 runtime replaces a worker when its engine configuration changes", async () => {
  const workers = [];
  class FakeWorker {
    constructor() { this.terminated = false; workers.push(this); }
    postMessage(message) {
      queueMicrotask(() => this.onmessage({
        data: { id: message.id, ok: true, value: message.type === "suggest" ? { suggestion: { moves: [] } } : undefined },
      }));
    }
    terminate() { this.terminated = true; }
  }
  const runtime = createStaticCc2Runtime({ WorkerType: FakeWorker });
  await runtime.propose({ sessionKey: "right", engine: "cc2-raw", state: {}, selectionLimit: 512, thinkMs: null });
  await runtime.propose({ sessionKey: "right", engine: "cc2-chouhy", state: {}, selectionLimit: 512, thinkMs: null });
  assert.equal(workers.length, 2);
  assert.equal(workers[0].terminated, true);
  await runtime.closeSessions();
  assert.equal(workers[1].terminated, true);
});
