import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { applySuggestion, createGame, toCc2State } from "../cc2-gui/game.mjs";
import { createCc2Session } from "../src-js/cc2-bridge.mjs";
import { createCc2WasmSession } from "../src-js/cc2-wasm-engine.mjs";

const required = process.env.CC2_PARITY_REQUIRED === "1";
const seed = "5994928009864282113";
const limit = 512;
const alignedPath = resolve("fixtures/tuning/cc2-s2-spin-value-aligned.json");
const cases = [
  { id: "s2-default", crate: "cold-clear-2-s2", expectedName: "Cold Clear 2 S2" },
  { id: "s2-aligned", crate: "cold-clear-2-s2", expectedName: "Cold Clear 2 S2", config: alignedPath },
  { id: "upstream", crate: "cold-clear-2-upstream", expectedName: "Cold Clear 2" },
  { id: "chouhy", crate: "cold-clear-2-chouhy", expectedName: "Cold Clear 2" },
];

for (const spec of cases) test(`native/WASM deterministic parity: ${spec.id} x 20 ply`, async (t) => {
  const executable = process.env.CC2_PARITY_TARGET_ROOT
    ? resolve(process.env.CC2_PARITY_TARGET_ROOT, spec.crate, "release", `${spec.crate}${process.platform === "win32" ? ".exe" : ""}`)
    : resolve("bot", spec.crate, "target", "release", `${spec.crate}${process.platform === "win32" ? ".exe" : ""}`);
  const wasmPath = resolve("bot", spec.crate, "target", "wasm32-unknown-unknown", "release", `${spec.crate.replaceAll("-", "_")}.wasm`);
  if (!existsSync(executable) || !existsSync(wasmPath)) {
    if (required) assert.fail(`required parity artifacts missing: ${executable}, ${wasmPath}`);
    t.skip("native and WASM release artifacts are not built");
    return;
  }
  const config = spec.config ? await readFile(spec.config, "utf8") : null;
  const native = await createCc2Session({ binary: executable, binaryArguments: spec.config ? ["--config", spec.config] : [], expectedName: spec.expectedName, selectionLimit: limit, searchSeed: seed });
  const wasm = await createCc2WasmSession({ wasmBytes: await readFile(wasmPath), config, selectionLimit: String(limit), searchSeed: seed });
  const game = createGame(0x5a17_2026);
  try {
    for (let ply = 0; ply < 20; ply += 1) {
      const state = toCc2State(game);
      const [nativeResult, wasmResult] = await Promise.all([native.suggest({ state }), wasm.suggest({ state })]);
      assert.deepEqual(wasmResult.suggestion.moves, nativeResult.suggestion.moves, `${spec.id} moves at ply ${ply}`);
      assert.equal(wasmResult.suggestion.move_info.selections, nativeResult.suggestion.move_info.selections, `${spec.id} selections at ply ${ply}`);
      if (spec.crate === "cold-clear-2-s2") assert.deepEqual(
        wasmResult.suggestion.move_info.candidate_values.map(Math.fround),
        nativeResult.suggestion.move_info.candidate_values.map(Math.fround),
        `${spec.id} candidate f32 bits at ply ${ply}`,
      );
      applySuggestion(game, nativeResult.suggestion.moves[0]);
    }
  } finally {
    await Promise.allSettled([native.close(), wasm.close()]);
  }
});
