import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createCc2WasmSession } from '../src-js/cc2-wasm-engine.mjs';
import { resolve } from 'node:path';
import { createNativeInputRuntime } from '../src-js/native-input-runtime.mjs';
import { createInputExecutionRound } from '../src-js/input-execution-round.mjs';
import { decisionStateToSyntheticGui } from '../src-js/s2-amount-only-decision-state.mjs';
import { guiStateToCc2NativeStart } from '../src-js/cc2-s2-native-start.mjs';
import { createCc2Session } from '../src-js/cc2-bridge.mjs';
import iFallback from '../fixtures/input-execution/chouhy-i-kick-order-fallback.json' with { type: 'json' };

for (const family of ['upstream', 'chouhy']) test(`input-only prefix preserves top choice and backend determinism: ${family}`, async t => {
  const binary = resolve(`bot/cold-clear-2-${family}/target/release/cold-clear-2-${family}${process.platform === 'win32' ? '.exe' : ''}`);
  const wasmPath = resolve(`bot/cold-clear-2-${family}/target/wasm32-unknown-unknown/release/cold_clear_2_${family}.wasm`);
  if (!existsSync(binary) || !existsSync(wasmPath)) return t.skip('native/WASM artifacts unavailable');
  const native = await createCc2Session({ binary, expectedName: 'Cold Clear 2', selectionLimit: 512, searchSeed: '5994928009864282113' });
  const wasm = await createCc2WasmSession({ wasmBytes: await readFile(wasmPath), selectionLimit: 512, searchSeed: '5994928009864282113' });
  const { decision } = structuredClone(createInputExecutionRound({ seed: 42 }).publicState('left'));
  decision.board.cells = iFallback.board.padEnd(400, '_');
  decision.pieces = structuredClone(iFallback.pieces);
  const state = guiStateToCc2NativeStart(decisionStateToSyntheticGui(decision));
  try {
    const original = (await native.suggest({ state, timeLimitEnabled: false })).suggestion;
    assert.equal(original.moves.length, 1);
    for (const input_candidates of [false, true]) {
      const enabled = { ...state, input_candidates };
      const a = (await native.suggest({ state: enabled, timeLimitEnabled: false })).suggestion;
      const b = (await wasm.suggest({ state: enabled })).suggestion;
      // Broader root ranks expose backend ordering differences. Preserve each
      // backend's own ranking; do not change evaluation to manufacture parity.
      assert.deepEqual(a.moves[0], b.moves[0]);
      assert.equal(a.moves.length, input_candidates ? 16 : 1);
      assert.equal(b.moves.length, a.moves.length);
      assert.deepEqual((await native.suggest({ state: enabled, timeLimitEnabled: false })).suggestion.moves, a.moves);
      assert.deepEqual((await wasm.suggest({ state: enabled })).suggestion.moves, b.moves);
      assert.deepEqual(a.moves[0], original.moves[0], 'original native preference is unchanged');
      assert.equal(a.move_info.nodes, original.move_info.nodes, 'only response breadth changes');
      assert.equal(new Set(a.moves.map(move => JSON.stringify(move))).size, a.moves.length);
      if (family === 'chouhy' && input_candidates) {
        assert.deepEqual(a.moves.slice(0, 2), iFallback.moves);
        assert.deepEqual(b.moves.slice(0, 2), iFallback.moves);
      }
    }
  } finally { await native.close(); await wasm.close(); }
});

for (const [family, engine] of [['s2', 'cc2-s2-champion'], ['upstream', 'cc2-raw'], ['chouhy', 'cc2-chouhy']])
test(`reconstructed high spawn board returns searched-empty evidence in native and WASM: ${family}`, async t => {
  const binary = resolve(`bot/cold-clear-2-${family}/target/release/cold-clear-2-${family}${process.platform === 'win32' ? '.exe' : ''}`);
  const wasmPath = resolve(`bot/cold-clear-2-${family}/target/wasm32-unknown-unknown/release/cold_clear_2_${family}.wasm`);
  if (!existsSync(binary) || !existsSync(wasmPath)) return t.skip('native/WASM S2 artifacts unavailable');
  const config = resolve('fixtures/tuning/cc2-s2-spawn-integrity-substrate-v2.json');
  const runtime = createNativeInputRuntime({ engineFor: () => ({ binary, config: family === 's2' ? { path: config } : null, protocolName: family === 's2' ? 'Cold Clear 2 S2' : 'Cold Clear 2' }) });
  const wasm = await createCc2WasmSession({ wasmBytes: await readFile(wasmPath), config: family === 's2' ? await readFile(config, 'utf8') : null,
    selectionLimit: 512, searchSeed: '5994928009864282113' });
  const { decision } = structuredClone(createInputExecutionRound({ seed: 42 }).publicState('left'));
  // Visible board + five NEXT reconstructed from the stopped GUI, not an exact match replay.
  decision.board.cells = ['__________', '__________', '_Z_SS_____', 'ZZSS___L__', 'ZLLJJLLL__',
    ...Array(6).fill('GGG_GGGGGG'), ...Array(6).fill('GG_GGGGGGG'), ...Array(6).fill('G_GGGGGGGG')].reverse().join('') + '_'.repeat(170);
  decision.pieces = { current: 'L', hold: 'I', known: ['O', 'I', 'T', 'S', 'Z'], holdAvailable: true };
  const state = guiStateToCc2NativeStart(decisionStateToSyntheticGui(decision));
  const verify = error => {
    assert.equal(error.message, 'CC2 returned no suggested move');
    assert.equal(error.suggestionReceived, true);
    assert.equal(error.moveInfo.selections, 512);
    assert.equal(error.moveInfo.nodes, 0);
    assert.deepEqual(error.moveInfo.candidate_values, family === 's2' ? [] : undefined);
    return true;
  };
  try {
    await assert.rejects(runtime.propose({ sessionKey: 'empty/right', engine, state, selectionLimit: 512, thinkMs: null }), verify);
    await assert.rejects(wasm.suggest({ state }), verify);
  } finally { await runtime.closeSessions(); await wasm.close(); }
});

test('native input session rejects a different backend or selection budget before reuse', async t => {
  const binary = resolve(`bot/cold-clear-2-upstream/target/release/cold-clear-2-upstream${process.platform === 'win32' ? '.exe' : ''}`);
  if (!existsSync(binary)) return t.skip('native upstream artifact unavailable');
  const runtime = createNativeInputRuntime({ engineFor: () => ({ binary, protocolName: 'Cold Clear 2' }) });
  const { decision } = createInputExecutionRound({ seed: 42 }).publicState('left');
  const input = { sessionKey: 'native-contract/right', engine: 'cc2-raw', selectionLimit: 16, thinkMs: null,
    state: guiStateToCc2NativeStart(decisionStateToSyntheticGui(decision)) };
  try {
    await runtime.propose(input);
    await assert.rejects(runtime.propose({ ...input, engine: 'cc2-chouhy' }), /mismatch/);
    await assert.rejects(runtime.propose({ ...input, selectionLimit: 32 }), /mismatch/);
    await assert.rejects(runtime.propose({ ...input, state: { ...input.state, input_candidates: true } }), /mismatch/);
    await assert.rejects(runtime.resolveInput({ request: { sessionKey: input.sessionKey, type: 'cc2-chouhy',
      engine: { engineId: 'cc2-chouhy' } } }), /identity mismatch/);
    assert.ok((await runtime.propose(input)).suggestion.moves.length > 0);
  } finally { await runtime.closeSessions(); }
});
