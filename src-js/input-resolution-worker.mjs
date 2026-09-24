import { parentPort } from 'node:worker_threads';
import { resolveInputJob } from './input-public-job.mjs';
parentPort.on('message', ({ id, payload }) => {
  try { parentPort.postMessage({ id, value: resolveInputJob(payload) }); }
  catch (error) { parentPort.postMessage({ id, error: error.message }); }
});
