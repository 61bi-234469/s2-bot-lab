# parking_lot_core WASI-threads patch

Source: `parking_lot_core` 0.8.5 (the version `parking_lot` 0.11 resolves to in `bot/cold-clear-2-s2/Cargo.lock`),
https://github.com/Amanieu/parking_lot. This copy keeps the upstream MIT / Apache-2.0 licenses.

Its only change: on `target_os = "wasi"` the thread parker is `src/thread_parker/wasi_std.rs`, built on
`std::thread::park` / `Thread::unpark`. Upstream's atomics parker for wasm needs the crate's `nightly` feature
(`core::arch::wasm32::memory_atomic_wait32` is unstable), and on stable Rust the fallback parker panics
("Parking not supported on this platform") the first time a helper thread has to wait.

It is applied only by `scripts/build-wasm-threads.mjs` (the `wasm32-wasip1-threads` build, through cargo's
`--config` patch); `bot/cold-clear-2-s2/Cargo.toml` and `Cargo.lock` do not reference it, so native and
`wasm32-unknown-unknown` builds keep the registry crate.
