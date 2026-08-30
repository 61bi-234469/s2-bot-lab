# Third-party licenses

The public snapshot is distributed under the root MIT license. The bundled
JavaScript dependencies below retain their own notices.

## Triangle.js / `@haelp/teto`

- Package: `@haelp/teto` 4.2.7
- Source commit: `70aa2ad4650346cb5df62a9b10d82a8384a45cc2`
- Source: https://github.com/halp1/triangle
- License: MIT
- Use: initial S2 Simulator implementation and canonical-state adapter

This project intentionally derives its initial Simulator behavior from Triangle Engine. Consequently, Triangle-derived cells are not eligible for differential conformance against Triangle itself. Golden, replay-result, and metamorphic evidence remain required according to the coverage matrix.

The complete license text is retained at `third_party/triangle/LICENSE.md`.

## `@noble/hashes`

- Package: `@noble/hashes` 1.8.0
- Source: https://github.com/paulmillr/noble-hashes
- License: MIT
- Use: synchronous browser SHA-256 implementation for cross-runtime state keys

## `chalk`

- Package: `chalk` (bundled only if retained by the Triangle dependency graph)
- License: MIT
- Use: transitive package input in the browser bundle when present; the Pages
  build fails if a bundled package is missing from this notice.

## `tetrio_report_app`

- Source commit: `f01de517ea77907822bb0730b57170851ea2d460`
- Source: https://github.com/61bi-234469/tetrio_report_app
- License: MIT, Copyright (c) 2026 61bi-234469
- Use: TetraStats-derived live metric formulas in `cc2-gui/player-metrics.mjs`

## `fumen-mobile-fork`

- Source commit: `a0e8e9b143cf2ad36cce53439296a9bd281dccc8`
- Source: https://github.com/61bi-234469/fumen-mobile-fork
- License: MIT, Copyright (c) 2018 knewjade
- Use: Bot-vs-Bot field-side placement of PPS/APM/APP and VS/Area readouts;
  `.ttrm` replay pipeline in `src-js/replay/`, ported from `src/lib/ttrm/`
  (`parser.ts`, `options.ts`, `engine_config.ts`, `board_converter.ts`,
  `simulator.ts`, `timeline.ts`, `garbage.ts`) and its replay transport layout

The port replaces the fork's own `@haelp/teto` checkout with this repository's
pinned 4.2.7 dependency and keeps the `PlayerRoundIR` shape, which is what
`src-js/replay-lock-conformance.mjs` already consumes. The complete license text
is retained at `third_party/fumen-mobile-fork/LICENSE.md`. The reference clone
itself stays outside tracked paths; `npm run verify:replay-clock` and
`npm run verify:replay-lock-conformance` are the checks that run against it.

## Cold Clear 2 / `bot/cold-clear-2-s2`

- Upstream: https://github.com/MinusKelvin/cold-clear-2
- Upstream commit: `ed8b19327b6bd1410ddd873d8611485bd45d8fae`
- Additional all-spin reference: https://github.com/chouhy/cold-clear-2 at `b20a92b0ed3230dd910d0674f7a09c552a34dd46`
- License choice for this copy: MIT
- Upstream copyright: Copyright (c) 2021 Mark Carlson
- Use: CC2 search DAG and move generator used as the candidate-generation half of the S2 hybrid bot

The complete upstream MIT and Apache-2.0 texts are retained in
`bot/cold-clear-2-s2/LICENSE-MIT` and `bot/cold-clear-2-s2/LICENSE-APACHE`.
`bot/cold-clear-2-s2/UPSTREAM.md` records the reviewed modifications and build
boundary. No reference clone or generated binary is tracked.

## Cold Clear 2 deterministic upstream and chouhy forks

- `bot/cold-clear-2-upstream`: MinusKelvin/cold-clear-2 at `ed8b19327b6bd1410ddd873d8611485bd45d8fae`
- `bot/cold-clear-2-chouhy`: chouhy/cold-clear-2 at `b20a92b0ed3230dd910d0674f7a09c552a34dd46`
- License choice: MIT, Copyright (c) 2021 Mark Carlson
- Use: import-free deterministic WASM and native parity references

Both copies retain `LICENSE-MIT`, `LICENSE-APACHE`, and an `UPSTREAM.md` with
the immutable source identity and deterministic-port patch inventory.

## `instant` 0.1.13 deterministic WASM patch

- Source: https://github.com/sebcrozet/instant
- License: BSD-3-Clause
- Use: transitive `parking_lot` clock implementation. On bare WASM only, its
  unused timed-parking clock returns a deterministic constant so CC2 has no
  host imports. Native behavior is unchanged.

The source and license are retained in `bot/instant-wasm-safe/`.
