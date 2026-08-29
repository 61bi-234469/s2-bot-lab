# Cold Clear 2 S2 candidate generator

This crate is a reviewed copy of MinusKelvin's Cold Clear 2 at commit
`ed8b19327b6bd1410ddd873d8611485bd45d8fae`. It preserves the upstream search
and TBP interface, but returns a bounded ranked root-candidate set (16 by
default) instead of only the top placement. The parent project validates and
reranks those candidates with its canonical TETR.IO Season 2 Simulator.

Build from the repository root with:

```powershell
npm run build:bot:s2-cc2
```

This crate alone is not the full S2 bot. The S2-specific decision policy lives
in `src-js/cc2-s2-hybrid.mjs`, keeping upstream search provenance separate from
the authoritative S2 rules implementation.

Training and reproducibility runs may use
`--search-selection-limit=<positive integer>` and `--search-seed=<u64>`. In
that mode `suggest` waits for the exact selection count, and `move_info`
includes parallel `candidate_values` for the returned ranked placements.
Interactive runs omit the selection limit and retain ordinary time-triggered
TBP suggestions.

## Technical Features

- Column-major bitboards
- Multithreaded search
- Transposition-aware game tree
- MCTS-inspired tree expansion

## License

Cold Clear 2 is licensed under either [Apache License Version 2.0](LICENSE-APACHE)
or [MIT License](LICENSE-MIT), at your option.
