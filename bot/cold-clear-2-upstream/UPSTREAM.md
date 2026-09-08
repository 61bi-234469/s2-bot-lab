# Upstream provenance

- Source: https://github.com/MinusKelvin/cold-clear-2
- Commit: `ed8b19327b6bd1410ddd873d8611485bd45d8fae`
- Tree: `890ecb508790e17431ad36f0c1f1396f250abdbf`
- Retrieved: 2026-08-30 from the preserved Git object pack

Maintained changes include the opt-in `Start.input_candidates` protocol field:
when true, suggestions return up to 16 existing ranked root candidates for the
consumed-input adapter. Absent/false preserves the legacy response. Search,
evaluation and kick rules are unchanged; the input owner verifies reachability
and may consume a later native-ranked candidate within its existing budget.

Other maintained changes are limited to deterministic seeded selection, exact selection budgets and telemetry, stable move
ordering, fixed build identity, native CLI overrides, target-specific `rand`, and the single-threaded JSON WASM ABI.
No S2 evaluator weights or S2 candidate-reranker behavior are included.
