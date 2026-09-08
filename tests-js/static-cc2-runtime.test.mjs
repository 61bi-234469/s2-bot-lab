import assert from "node:assert/strict";
import test from "node:test";

import { createStaticCc2Runtime } from "../cc2-gui/static-host.mjs";

test('static worker preserves searched-empty evidence for the input owner', async () => {
  const moveInfo = { selections: 512, nodes: 0, candidate_values: [], extra: 'searched' };
  class EmptyWorker {
    postMessage({ id, type }) {
      queueMicrotask(() => this.onmessage({ data: type === 'suggest'
        ? { id, ok: false, error: 'CC2 returned no suggested move', suggestionReceived: true, moveInfo }
        : { id, ok: true } }));
    }
    terminate() {}
  }
  const runtime = createStaticCc2Runtime({ WorkerType: EmptyWorker });
  try {
    await assert.rejects(runtime.propose({ sessionKey: 'empty/right', engine: 'cc2-s2-f14', state: {}, selectionLimit: 512, thinkMs: null }), error => {
      assert.equal(error.suggestionReceived, true);
      assert.deepEqual(error.moveInfo, moveInfo);
      return true;
    });
  } finally { await runtime.closeSessions(); }
});

test("input resolution waits for an initializing worker and propagates init failure", async () => {
  for (const fail of [false, true]) {
    let finish;
    const messages = [];
    class DeferredWorker {
      postMessage(message) {
        messages.push(message.type);
        const reply = () => this.onmessage({ data: { id: message.id, ok: !(fail && message.type === 'init'),
          error: 'initialization failed', value: message.type === 'resolveInput' ? { status: 'planned' } : {} } });
        if (message.type === 'init') finish = reply;
        else queueMicrotask(reply);
      }
      terminate() {}
    }
    const runtime = createStaticCc2Runtime({ WorkerType: DeferredWorker });
    const proposed = runtime.propose({ sessionKey: 'test', engine: 'cc2-s2-f14', state: {}, selectionLimit: 512, thinkMs: null });
    const resolved = runtime.resolveInput({ request: { sessionKey: 'test', type: 'cc2-s2-f14' } });
    const settled = Promise.allSettled([proposed, resolved]);
    assert.deepEqual(messages, ['init']);
    finish();
    const outcomes = await settled;
    assert.ok(outcomes.every(outcome => outcome.status === (fail ? 'rejected' : 'fulfilled')));
    if (!fail) assert.equal(outcomes[1].value.status, 'planned');
    else assert.ok(outcomes.every(outcome => /initialization failed/.test(outcome.reason.message)));
    await runtime.closeSessions();
  }
});
import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { guiStateToCanonical } from "../src-js/gui-state.mjs";
import { createS2AmountOnlyDecisionRequest } from "../src-js/s2-amount-only-decision-state.mjs";

test('reset during static worker initialization closes its late result', async () => {
  let worker;
  let initialization;
  class DelayedWorker {
    constructor() { worker = this; this.terminated = false; }
    postMessage(message) { if (message.type === 'init') initialization = message; }
    terminate() { this.terminated = true; }
  }
  const runtime = createStaticCc2Runtime({ WorkerType: DelayedWorker });
  const pending = runtime.propose({ sessionKey: 'input-old/right', engine: 'cc2-s2-f14', state: {}, selectionLimit: 512, thinkMs: null });
  const rejected = assert.rejects(pending, /replaced during initialization/);
  await runtime.closeSessions({ sessionKeys: ['input-old/right'] });
  worker.onmessage({ data: { id: initialization.id, ok: true } });
  await rejected;
  assert.equal(worker.terminated, true);
});

function qualifiedResolution(sessionKey) {
  return createS2AmountOnlyDecisionRequest({
    sessionKey,
    state: guiStateToCanonical(toS2GuiState(createGame(73001))),
    moves: [{}],
    type: "cc2-s2-champion",
    engine: { botType: "cc2-s2-champion", engineId: "cc2-s2-champion" },
  });
}

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
  const input = { sessionKey: "left", engine: "cc2-s2-champion", state: {}, selectionLimit: 512, thinkMs: null };
  await runtime.propose(input);
  await runtime.propose(input);
  const resolution = qualifiedResolution("left");
  const resolved = await runtime.resolve(resolution);
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, false);
  assert.deepEqual(resolved, expectedResolution);
  assert.deepEqual(messages.map(({ type }) => type), ["init", "suggest", "suggest", "resolve"]);
  assert.deepEqual(messages.at(-1).payload, resolution);

  await runtime.closeSessions({ sessionKeys: ["left"] });
  assert.equal(workers[0].terminated, true);
  assert.equal(messages.at(-1).type, "close");
});

test("static runtime forwards native-order Raw/chouhy requests to the worker", async () => {
  const messages = [];
  class FakeWorker {
    postMessage(message) {
      messages.push(message);
      queueMicrotask(() => this.onmessage({ data: { id: message.id, ok: true, value: {} } }));
    }
    terminate() {}
  }
  const runtime = createStaticCc2Runtime({ WorkerType: FakeWorker });
  try {
    for (const type of ["cc2-raw", "cc2-chouhy"]) {
      await runtime.propose({ sessionKey: type, engine: type, state: {}, selectionLimit: 512 });
      const request = { ...qualifiedResolution(type), id: "cc2-input-decision-request/1",
        type, engine: { botType: type, engineId: type } };
      await runtime.resolve(request);
      assert.deepEqual(messages.at(-1).payload, request);
    }
  } finally { await runtime.closeSessions(); }
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
  await runtime.propose({ sessionKey: "right", engine: "cc2-s2-champion", state: {}, selectionLimit: 512, thinkMs: null });
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
  await runtime.propose({ sessionKey: "right", engine: "cc2-s2-champion", state: {}, selectionLimit: 512, thinkMs: null });
  const resolveInput = qualifiedResolution("right");

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
      engine: { botType: "cc2-s2-champion", engineId: "cc2-chouhy" },
    }),
    /engine identity mismatch/,
  );
  assert.equal(workers[0].terminated, false);
  assert.deepEqual(messages.map(({ type }) => type), ["init", "suggest"]);

  assert.deepEqual(await runtime.resolve(resolveInput), { status: "degraded" });
  assert.equal(messages.at(-1).type, "resolve");
  await runtime.closeSessions();
});

test("static CC2 runtime rejects a forbidden resolve envelope before posting it", async () => {
  const messages = [];
  class FakeWorker {
    postMessage(message) {
      messages.push(structuredClone(message));
      queueMicrotask(() => this.onmessage({ data: {
        id: message.id, ok: true, value: message.type === "suggest" ? { suggestion: { moves: [] } } : undefined,
      } }));
    }
    terminate() {}
  }
  const runtime = createStaticCc2Runtime({ WorkerType: FakeWorker });
  await runtime.propose({ sessionKey: "left", engine: "cc2-s2-champion", state: {}, selectionLimit: 512, thinkMs: null });
  const invalid = structuredClone(qualifiedResolution("left"));
  invalid.decision.incoming.garbage = { packets: [{ packetId: 1 }] };
  await assert.rejects(runtime.resolve(invalid), /forbidden garbage/);
  assert.deepEqual(messages.map(({ type }) => type), ["init", "suggest"]);
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
  const proposal = { sessionKey: "right", engine: "cc2-s2-champion", state: {}, selectionLimit: 512, thinkMs: null };
  await runtime.propose(proposal);
  await assert.rejects(runtime.resolve(qualifiedResolution("right")), /resolution failed/);
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
  await runtime.propose({ sessionKey: "left", engine: "cc2-s2-champion", state: {}, selectionLimit: 512, thinkMs: null });
  const pending = runtime.resolve(qualifiedResolution("left"));
  const rejection = assert.rejects(pending, /worker session is closed/);
  assert.equal(workers[0].messages.at(-1).type, "resolve");

  await runtime.closeSessions({ sessionKeys: ["left"] });
  await rejection;
  assert.equal(workers[0].terminated, true);
  assert.deepEqual(workers[0].messages.map(({ type }) => type), ["init", "suggest", "resolve", "close"]);
});
