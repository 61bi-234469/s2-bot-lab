import assert from "node:assert/strict";
import test from "node:test";

import { createStaticCc2Runtime } from "../cc2-gui/static-host.mjs";

test("static CC2 runtime sends suggest and resolve through one retained worker", async () => {
  const workers = [];
  const messages = [];
  const expectedResolution = { status: "degraded", transition: { legality: { legal: true } } };
  class FakeWorker {
    constructor() {
      this.terminated = false;
      workers.push(this);
    }
    postMessage(message) {
      messages.push(structuredClone(message));
      queueMicrotask(() => {
        const value = message.type === "suggest"
          ? { suggestion: { moves: [], move_info: {} }, peakMemoryBytes: 65536 }
          : message.type === "resolve" ? expectedResolution : undefined;
        this.onmessage({ data: { id: message.id, ok: true, value } });
      });
    }
    terminate() { this.terminated = true; }
  }

  const runtime = createStaticCc2Runtime({ WorkerType: FakeWorker, idleTimeoutMs: 60_000 });
  const input = { sessionKey: "left", engine: "cc2-raw", state: {}, selectionLimit: 512, thinkMs: null };
  await runtime.propose(input);
  await runtime.propose(input);
  const gui = { board: [], queue: ["T"] };
  const moves = [{ location: { type: "T", orientation: "north", x: 4, y: 0 }, spin: "none" }];
  const engine = { botType: "cc2-raw", engineId: "cc2-raw" };
  const resolved = await runtime.resolve({ sessionKey: "left", gui, moves, type: "cc2-raw", engine });
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, false);
  assert.deepEqual(resolved, expectedResolution);
  assert.deepEqual(messages.map(({ type }) => type), ["init", "suggest", "suggest", "resolve"]);
  assert.deepEqual(messages.at(-1).payload, { gui, moves, type: "cc2-raw", engine });

  await runtime.closeSessions({ sessionKeys: ["left"] });
  assert.equal(workers[0].terminated, true);
  assert.equal(messages.at(-1).type, "close");
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

test("static CC2 runtime rejects mismatched resolution identities without discarding the session", async () => {
  const workers = [];
  const messages = [];
  class FakeWorker {
    constructor() { this.terminated = false; workers.push(this); }
    postMessage(message) {
      messages.push(structuredClone(message));
      queueMicrotask(() => this.onmessage({ data: {
        id: message.id,
        ok: true,
        value: message.type === "suggest"
          ? { suggestion: { moves: [] } }
          : message.type === "resolve" ? { status: "degraded" } : undefined,
      } }));
    }
    terminate() { this.terminated = true; }
  }

  const runtime = createStaticCc2Runtime({ WorkerType: FakeWorker });
  await runtime.propose({ sessionKey: "right", engine: "cc2-raw", state: {}, selectionLimit: 512, thinkMs: null });
  const resolveInput = {
    sessionKey: "right",
    gui: {},
    moves: [],
    type: "cc2-raw",
    engine: { botType: "cc2-raw", engineId: "cc2-raw" },
  };

  await assert.rejects(
    runtime.resolve({
      ...resolveInput,
      type: "cc2-chouhy",
      engine: { botType: "cc2-chouhy", engineId: "cc2-chouhy" },
    }),
    /engine identity mismatch/,
  );
  await assert.rejects(
    runtime.resolve({
      ...resolveInput,
      engine: { botType: "cc2-raw", engineId: "cc2-chouhy" },
    }),
    /engine identity mismatch/,
  );
  assert.equal(workers[0].terminated, false);
  assert.deepEqual(messages.map(({ type }) => type), ["init", "suggest"]);

  assert.deepEqual(await runtime.resolve(resolveInput), { status: "degraded" });
  assert.equal(messages.at(-1).type, "resolve");
  await runtime.closeSessions();
});

test("static CC2 runtime discards a worker after resolution rejection and recreates it", async () => {
  const workers = [];
  class FakeWorker {
    constructor() {
      this.messages = [];
      this.terminated = false;
      workers.push(this);
    }
    postMessage(message) {
      this.messages.push(structuredClone(message));
      queueMicrotask(() => {
        const rejectedResolution = this === workers[0] && message.type === "resolve";
        this.onmessage({ data: rejectedResolution
          ? { id: message.id, ok: false, error: "resolution failed" }
          : {
              id: message.id,
              ok: true,
              value: message.type === "suggest" ? { suggestion: { moves: [] } } : undefined,
            } });
      });
    }
    terminate() { this.terminated = true; }
  }

  const runtime = createStaticCc2Runtime({ WorkerType: FakeWorker });
  const proposal = { sessionKey: "right", engine: "cc2-raw", state: {}, selectionLimit: 512, thinkMs: null };
  await runtime.propose(proposal);
  await assert.rejects(runtime.resolve({
    sessionKey: "right",
    gui: {},
    moves: [],
    type: "cc2-raw",
    engine: { botType: "cc2-raw", engineId: "cc2-raw" },
  }), /resolution failed/);
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(workers[0].messages.map(({ type }) => type), ["init", "suggest", "resolve", "close"]);

  await runtime.propose(proposal);
  assert.equal(workers.length, 2);
  assert.equal(workers[1].terminated, false);
  await runtime.closeSessions();
  assert.equal(workers[1].terminated, true);
});

test("closing a static CC2 session rejects its pending resolution", async () => {
  const workers = [];
  class FakeWorker {
    constructor() {
      this.messages = [];
      this.terminated = false;
      workers.push(this);
    }
    postMessage(message) {
      this.messages.push(structuredClone(message));
      if (message.type === "resolve" || message.type === "close") return;
      queueMicrotask(() => this.onmessage({ data: {
        id: message.id,
        ok: true,
        value: message.type === "suggest" ? { suggestion: { moves: [] } } : undefined,
      } }));
    }
    terminate() { this.terminated = true; }
  }

  const runtime = createStaticCc2Runtime({ WorkerType: FakeWorker });
  await runtime.propose({ sessionKey: "left", engine: "cc2-raw", state: {}, selectionLimit: 512, thinkMs: null });
  const pending = runtime.resolve({
    sessionKey: "left",
    gui: {},
    moves: [],
    type: "cc2-raw",
    engine: { botType: "cc2-raw", engineId: "cc2-raw" },
  });
  const rejection = assert.rejects(pending, /worker session is closed/);
  assert.equal(workers[0].messages.at(-1).type, "resolve");

  await runtime.closeSessions({ sessionKeys: ["left"] });
  await rejection;
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(workers[0].messages.map(({ type }) => type), ["init", "suggest", "resolve", "close"]);
});
