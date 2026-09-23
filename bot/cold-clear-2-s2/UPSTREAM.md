# Upstream provenance and local changes

## Source

- Repository: https://github.com/MinusKelvin/cold-clear-2
- Commit: `ed8b19327b6bd1410ddd873d8611485bd45d8fae`
- Retrieved: 2026-08-14
- Upstream license: `MIT OR Apache-2.0`
- License selected for this repository copy: MIT

The source was copied from a fixed external checkout. Its `.git` directory,
build artifacts, and unreviewed history were not copied.

## Reviewed local changes

1. Rename the crate and TBP identity to `cold-clear-2-s2` / `Cold Clear 2 S2`.
2. Pin the reported upstream base to `ed8b193` in `build.rs`.
3. Return up to `suggestion_count` ranked root candidates (default 16) so the
   parent S2 Simulator can validate and rerank them.
4. Add non-T rotation spin retention and the all-spin weight preset based on
   `chouhy/cold-clear-2@b20a92b0ed3230dd910d0674f7a09c552a34dd46`.
5. Keep the canonical S2 transition, cancellation, tanking and Surge logic out
   of this crate. The shared JavaScript Simulator remains authoritative; the
   crate's S2 components below use it as their reference.
6. Apply the repository's current `rustfmt` to the copied Rust files.
7. Sort the underground-lock tail of `find_moves` into a canonical order.
   `AHashMap` iteration order depends on a per-process random hasher seed, and
   the search selects children by index, so draining that map directly made a
   fixed selection budget non-reproducible on any position that has underground
   locks. Measured on six opening positions with three fresh processes each:
   before the change the suggestion repeated 6/6 at 512 and 2048 selections but
   only 2/6 at 8192 and 3/6 at 16384; after it, 6/6 at every budget. Positions
   without underground locks are unaffected, so the 512-selection development
   champion is unchanged (6/6 identical moves and cached values across the
   change). The deterministic ordering change is part of this public fork.
8. Optional TBP Start field `s2_incoming` `{ pending_rows, due_this_lock_rows }`
   behind config flag `enable_s2_amount_only_incoming`. This is an S2-lab
   amount-only extension, not an upstream TBP feature. Packet metadata, RNG,
   hole state and derived future-hole boards stay out of search state and the
   transposition key. Omitted/false flag preserves the upstream Start
   interpretation. Canonical S2 cancellation, tanking and garbage materialization
   remain in the JavaScript Simulator; native `advance` uses an amount model
   and does not insert unmaterialized garbage cells.
9. Optional move-generation and evaluation switches behind config flags that
   default to off: direct 180-degree rotation (`enable_direct_180`), entry from
   the spawn buffer (`enable_spawn_buffer_entry`), spawn-occupancy evaluation,
   real-board structural evaluation and non-mutating T-slot deduplication.
10. `f14_compat/`: a Rust port of the S2 lab's F14 amount-only selector
    (candidate ranking, conversion, solvency rescue, public reachability and
    root allocation) behind `--f14-compat-profile`, with a request/response
    envelope and an in-process driver used by the WASM entry points
    (`f14_start`, `work`, `f14_finish`, `f14_finish_early`). Its public
    profile also accepts a host-clocked time budget and a queue of up to 28
    pieces. Decisions are checked against the JavaScript reference selector.
11. `native_s2.rs`, `native_s2/`, `s2_core.rs`, `s2_eval.rs`, `s2_search.rs`,
    `s2_transport.rs`, `s2_audit.rs`, `dag/domain.rs` and `dag/finite*.rs`: an
    opt-in native S2 state/value route (`--native-profile`,
    `--integrated-profile`) that searches known-only S2 states with the CC2 DAG
    algorithms. It is development-only and not the default engine.
12. `bot/evaluation_features.rs`: deterministic board-feature helpers shared by
    the legacy and S2 paths; `src/bin/`: diagnostic binaries for move
    generation and the root search.
13. `wasm.rs`: import-free WebAssembly entry points for the browser build,
    including the F14 operations above.

## Build

```powershell
npm run build:bot:s2-cc2
```

The generated `target/` directory is ignored. Binary SHA-256 values should be
recorded independently from the source identity when distributing a build.
