import { Worker } from 'node:worker_threads';
import { createCc2Session } from './cc2-bridge.mjs';
import { s2ConfigArguments } from './cc2-s2-config.mjs';

/** Native proposal processes plus one public-only resolution worker per side. */
export function createNativeInputRuntime({ engineFor }) {
  const sessions = new Map();
  return {
    async propose({ sessionKey, engine, state, selectionLimit, thinkMs }) {
      const inputCandidates = state?.input_candidates === true;
      if (inputCandidates && !['cc2-raw', 'cc2-chouhy'].includes(engine)) throw new Error('input candidate prefix engine mismatch');
      let entry = sessions.get(sessionKey);
      if (entry && (entry.engine !== engine || entry.selectionLimit !== selectionLimit || entry.inputCandidates !== inputCandidates)) {
        throw new Error('input session engine or selection budget mismatch');
      }
      if (!entry) {
        const definition = engineFor(engine);
        const worker = new Worker(new URL('./input-resolution-worker.mjs', import.meta.url));
        const pending = new Map();
        entry = { worker, pending, nextId: 0, closed: false, bot: null, engine, selectionLimit, inputCandidates };
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
        entry.initializing = createCc2Session({ binary: definition.binary,
          binaryArguments: s2ConfigArguments(definition.config ?? null), expectedName: definition.protocolName,
          selectionLimit, searchSeed: '5994928009864282113' }).then(async bot => {
            entry.bot = bot;
            if (entry.closed) { await bot.close(); throw new Error('input session replaced'); }
            return bot;
          });
      }
      const bot = await entry.initializing;
      return bot.suggest({ state, thinkMs: thinkMs ?? 50, timeLimitEnabled: thinkMs !== null });
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
