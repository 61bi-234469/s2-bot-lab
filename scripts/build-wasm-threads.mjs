// Builds the threaded WASM of the S2 bot (wasm32-wasip1-threads, cargo feature `wasm-threads`).
//
// Unlike the import-free wasm32-unknown-unknown build, this module imports a shared memory, a few WASI preview1
// functions and `wasi.thread-spawn` (src-js/cc2-wasm-threads.mjs is its host). Three build settings are needed:
// +atomics,+bulk-memory,+mutable-globals; the libc reactor (crt1-reactor.o) with `_initialize` exported, which the
// host calls once on the main instance; and the parking_lot_core patch in bot/parking-lot-core-wasi (applied by
// cargo `--config` for this build only, so Cargo.toml and Cargo.lock stay on the registry crate).
//
//   node scripts/build-wasm-threads.mjs [--check]
//
// Output: bot/cold-clear-2-s2/target/wasi-threads/wasm32-wasip1-threads/release/cold_clear_2_s2.wasm
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const THREADED_WASM_TARGET = "wasm32-wasip1-threads";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crate = resolve(repo, "bot/cold-clear-2-s2");
export const THREADED_WASM_ARTIFACT = resolve(crate, "target/wasi-threads", THREADED_WASM_TARGET, "release/cold_clear_2_s2.wasm");
/** The imports the threaded module may have (anything else means the build drifted). */
export const THREADED_WASM_IMPORTS = Object.freeze([
  "env.memory", "wasi.thread-spawn",
  ...["clock_time_get", "environ_get", "environ_sizes_get", "fd_write", "proc_exit", "random_get", "sched_yield"].map((n) => `wasi_snapshot_preview1.${n}`),
]);

function sysroot() {
  const out = spawnSync("rustc", ["--print", "sysroot"], { cwd: crate, encoding: "utf8" });
  if (out.status !== 0) throw new Error(`rustc --print sysroot failed: ${out.stderr}`);
  return out.stdout.trim();
}

export function buildThreadedWasm() {
  const crt = resolve(sysroot(), "lib/rustlib", THREADED_WASM_TARGET, "lib/self-contained/crt1-reactor.o");
  if (!existsSync(crt)) throw new Error(`missing ${crt}: run rustup target add ${THREADED_WASM_TARGET}`);
  const lockPath = resolve(crate, "Cargo.lock");
  const lock = readFileSync(lockPath);
  const patch = resolve(repo, "bot/parking-lot-core-wasi").replaceAll("\\", "/");
  try {
    // No --offline: CI fetches the locked crates (set CARGO_NET_OFFLINE=true to build from the local cache only).
    const result = spawnSync("cargo", ["build", "--release", "--lib", "--target", THREADED_WASM_TARGET,
      "--features", "wasm-threads", "--target-dir", "target/wasi-threads",
      "--config", `patch.crates-io.parking_lot_core.path="${patch}"`], {
      cwd: crate, stdio: "inherit",
      env: { ...process.env, RUSTFLAGS: `-C target-feature=+atomics,+bulk-memory,+mutable-globals -C link-arg=${crt.replaceAll("\\", "/")} -C link-arg=--export=_initialize` },
    });
    if (result.status !== 0) throw new Error(`cargo build --target ${THREADED_WASM_TARGET} failed`);
  } finally {
    // The --config patch rewrites the lock file's parking_lot_core source; the committed lock stays as it was.
    writeFileSync(lockPath, lock);
  }
  return checkThreadedWasm();
}

export async function checkThreadedWasm() {
  const bytes = readFileSync(THREADED_WASM_ARTIFACT);
  const module = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(module).map((i) => `${i.module}.${i.name}`).sort();
  const unexpected = imports.filter((i) => !THREADED_WASM_IMPORTS.includes(i));
  if (unexpected.length) throw new Error(`threaded WASM has unexpected imports: ${unexpected.join(", ")}`);
  const exports = WebAssembly.Module.exports(module).map((e) => e.name);
  for (const name of ["cc2_alloc", "cc2_dealloc", "cc2_invoke", "wasi_thread_start", "_initialize"]) {
    if (!exports.includes(name)) throw new Error(`threaded WASM export missing: ${name}`);
  }
  if (bytes.toString("latin1").includes("Parking not supported on this platform")) {
    throw new Error("threaded WASM was built without the parking_lot_core WASI patch");
  }
  return { artifact: THREADED_WASM_ARTIFACT, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), imports };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = process.argv.includes("--check") ? await checkThreadedWasm() : await buildThreadedWasm();
  console.log(JSON.stringify(info));
}
