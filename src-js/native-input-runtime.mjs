import { Worker } from 'node:worker_threads';
import { createCc2Session } from './cc2-bridge.mjs';
import { s2ConfigArguments } from './cc2-s2-config.mjs';

/** Native proposal processes plus one public-only resolution worker per side.
 * A bot that decides through the F14 core (the champion) gets its decision
 * session from `f14SessionFor` instead of a CC2 proposal process. */
export function createNativeInputRuntime({ engineFor, f14SessionFor = null }) {
  const sessions = new Map();
  function openEntry(sessionKey, key, createBot) {
    const worker = new Worker(new URL('./input-resolution-worker.mjs', import.meta.url));
    const pending = new Map();
    const entry = { worker, pending, nextId: 0, closed: false, bot: null, ...key };
    sessions.set(sessionKey, entry);
    const fail = error => {
      entry.workerFailure = error;
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };
    worker.on('message', data => {
      const waiter = pending.get(data.id);
      if (!waiter) return;
      pending.delete(data.id);
      data.error ? waiter.reject(new Error(data.error)) : waiter.resolve(data.value);
    });
    worker.on('error', fail);
    worker.on('exit', () => fail(new Error('input resolution worker closed')));
    entry.initializing = createBot().then(async bot => {
      entry.bot = bot;
      if (entry.closed) { await bot.close(); throw new Error('input session replaced'); }
      return bot;
    });
    return entry;
  }
  return {
    async propose({ sessionKey, engine, state, selectionLimit, thinkMs }) {
      const inputCandidates = state?.input_candidates === true;
      if (inputCandidates && !['cc2-raw', 'cc2-chouhy'].includes(engine)) throw new Error('input candidate prefix engine mismatch');
      let entry = sessions.get(sessionKey);
      if (entry && (entry.engine !== engine || entry.f14 || entry.selectionLimit !== selectionLimit || entry.inputCandidates !== inputCandidates)) {
        throw new Error('input session engine or selection budget mismatch');
      }
      if (!entry) {
        const definition = engineFor(engine);
        entry = openEntry(sessionKey, { engine, selectionLimit, inputCandidates, f14: false }, () => createCc2Session({
          binary: definition.binary, binaryArguments: s2ConfigArguments(definition.config ?? null),
          expectedName: definition.protocolName, selectionLimit, searchSeed: '5994928009864282113' }));
      }
      const bot = await entry.initializing;
      return bot.suggest({ state, thinkMs: thinkMs ?? 50, timeLimitEnabled: thinkMs !== null });
    },
    async decideF14({ sessionKey, type, engine, request, profile }) {
      if (f14SessionFor === null) throw new Error('F14 INPUT decision is unavailable');
      if (engine?.botType !== type || engine?.engineId !== type) throw new Error(`CC2 F14 engine identity mismatch for ${type}`);
      let entry = sessions.get(sessionKey);
      if (entry && (entry.engine !== type || !entry.f14)) throw new Error('input session engine or selection budget mismatch');
      if (!entry) entry = openEntry(sessionKey, { engine: type, selectionLimit: null, inputCandidates: false, f14: true },
        () => f14SessionFor(type));
      const session = await entry.initializing;
      return session.decideF14({ request, profile });
    },
    async rerankF14({ sessionKey, type, engine, request, profile }) {
      if (f14SessionFor === null) throw new Error('F14 INPUT rerank is unavailable');
      if (engine?.botType !== type || engine?.engineId !== type) throw new Error(`CC2 F14 engine identity mismatch for ${type}`);
      const entry = sessions.get(sessionKey);
      if (!entry || entry.closed) throw new Error('F14 INPUT rerank is unavailable: session not initialized');
      if (entry.engine !== type || !entry.f14) throw new Error('input session engine or selection budget mismatch');
      const session = await entry.initializing;
      if (sessions.get(sessionKey) !== entry || entry.closed) throw new Error('input session replaced');
      return session.rerankF14({ request, profile });
    },
    /** Searches a predicted next request on the live F14 session; the core
     * retains the result for a later rerankF14 of the real request. */
    async speculateF14({ sessionKey, type, engine, request, profile }) {
      if (engine?.botType !== type || engine?.engineId !== type) throw new Error(`CC2 F14 engine identity mismatch for ${type}`);
      const entry = sessions.get(sessionKey);
      if (!entry || entry.closed || entry.engine !== type || !entry.f14) throw new Error('F14 INPUT speculation is unavailable');
      const session = await entry.initializing;
      if (sessions.get(sessionKey) !== entry || entry.closed) throw new Error('input session replaced');
      return session.decideF14({ request, profile });
    },
    resolveInput(payload) {
      const entry = sessions.get(payload.request.sessionKey);
      if (!entry || entry.closed) return Promise.reject(new Error('input session replaced'));
      if (entry.engine !== payload.request.type || payload.request.engine?.engineId !== entry.engine) {
        return Promise.reject(new Error('input session engine identity mismatch'));
      }
      if (entry.workerFailure) return Promise.reject(entry.workerFailure);
      return new Promise((resolve, reject) => {
        const id = ++entry.nextId;
        entry.pending.set(id, { resolve, reject });
        entry.worker.postMessage({ id, payload });
      });
    },
    async closeSessions({ sessionKeys = [...sessions.keys()] } = {}) {
      await Promise.all(sessionKeys.map(async key => {
        const entry = sessions.get(key);
        if (!entry) return;
        sessions.delete(key);
        entry.closed = true;
        for (const waiter of entry.pending.values()) waiter.reject(new Error('input session replaced'));
        entry.pending.clear();
        await Promise.allSettled([entry.worker.terminate(), entry.bot?.close()]);
      }));
    },
  };
}
