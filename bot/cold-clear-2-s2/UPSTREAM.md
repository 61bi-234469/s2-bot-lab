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
   of this crate. That authoritative policy is implemented in
   `src-js/cc2-s2-hybrid.mjs` and the shared Simulator.
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

## Build

```powershell
npm run build:bot:s2-cc2
```

The generated `target/` directory is ignored. Binary SHA-256 values should be
recorded independently from the source identity when distributing a build.
