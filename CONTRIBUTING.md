# Contributing

Keep the simulator's canonical transition path authoritative for line clears,
spin, attack, B2B, combo, cancellation, tanking, and garbage. Add or update
golden fixtures when changing those semantics, and run the focused tests before
the full suite.

Useful checks:

```powershell
npm test
npm run test:cs1
cargo test --all-targets
cargo fmt --check
cargo clippy --all-targets --all-features -- -D warnings
```

Please do not add native binaries, credentials, machine-specific paths, or
third-party source without its license notice.
