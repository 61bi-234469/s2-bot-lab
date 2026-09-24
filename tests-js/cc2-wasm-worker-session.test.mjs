import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createGame, toS2GuiState } from "../cc2-gui/game.mjs";
import { guiStateToCanonical } from "../src-js/gui-state.mjs";
import { createCc2WasmSession } from "../src-js/cc2-wasm-engine.mjs";
import { createCc2WasmWorkerSession } from "../src-js/cc2-wasm-worker-session.mjs";
import { createPublicCompatProfile, createPublicCompatRequest } from "../src-js/public-compat-request.mjs";
import { firstResponseMismatch } from "../scripts/f14-response-comparator.mjs";

const wasmPath = resolve("bot/cold-clear-2-s2/target/wasm32-unknown-unknown/release/cold_clear_2_s2.wasm");

test("the worker F14 session decides and reranks like the in-process session without blocking the event loop",
  { skip: !existsSync(wasmPath), timeout: 120_000 }, async () => {
    const wasmBytes = readFileSync(wasmPath);
    const local = await createCc2WasmSession({ wasmBytes });
    const worker = await createCc2WasmWorkerSession({ wasmBytes });
    try {
      const profile = createPublicCompatProfile();
      for (const seed of [21, 22, 23]) {
        const request = createPublicCompatRequest(guiStateToCanonical(toS2GuiState(createGame(seed))), { requestId: `w${seed}` });
        request.execution = structuredClone(profile);
        const expected = await local.decideF14({ request, profile });
        // A 512-selection search takes tens of ms; the main thread keeps ticking.
        let ticks = 0;
        const timer = setInterval(() => { ticks++; }, 1);
        const actual = await worker.decideF14({ request, profile }).finally(() => clearInterval(timer));
        assert.equal(expected.status, "move");
        assert.equal(firstResponseMismatch(expected, actual), null);
        assert.ok(ticks > 0, "event loop was blocked during the worker search");

        const reranked = { ...request, selector: { ...request.selector, incoming: { pendingRows: 3, dueThisLockRows: 1 } } };
        assert.equal(firstResponseMismatch(await local.rerankF14({ request: reranked, profile }),
          await worker.rerankF14({ request: reranked, profile })), null);
      }
      // A refused rerank comes back as the same decision-shaped response.
      const refused = await worker.rerankF14({ request: { bad: true }, profile: null });
      assert.equal(refused.status, "error");
      assert.deepEqual(refused, await local.rerankF14({ request: { bad: true }, profile: null }));
    } finally {
      await local.close();
      await worker.close();
    }
    await assert.rejects(worker.decideF14({ request: {}, profile: null }), /closed/);
  });

test("a worker F14 session fails at creation on invalid WASM bytes", async () => {
  await assert.rejects(createCc2WasmWorkerSession({ wasmBytes: new Uint8Array([0, 1, 2, 3]) }));
});
