# s2-bot-lab

ブラウザ内で動く S2 Simulator と bot GUI の公開スナップショットです。

## Hosted versions

- Stable (`main`): <https://61bi-234469.github.io/s2-bot-lab/>
- Development (`develop`): <https://61bi-234469.github.io/s2-bot-lab/preview/>

Each Pages deployment assembles both branches: the stable build occupies the site root and the
development build is published under `preview/`. The development URL is marked `noindex, nofollow`.

## What is included

- observed Season 2 ruleset simulator and canonical transition API
- browser-local bot-vs-bot and human-vs-bot play, including TTRM INPUT execution and `.ttrm` export
- `.ttrm` replay import and playback; uploaded files are processed locally
- deterministic browser-WASM Cold Clear 2: raw upstream, the chouhy fork, the S2 `F14` development
  snapshot, and the current S2 development champion (not release-qualified)

The bot selectors (single analysis and bot-vs-bot) offer the same seven bots as TTRM INPUT, plus You (1P)
on the left; the local Node server offers the same list. The two upstream ports come first, then the
project's bots from oldest to newest, keeping past champions. Names describe each design; only the
parenthesis marks the current champion. Each bot's SETTINGS panel opens with its origin, what was
tuned and why, and how it plays.

- Raw CC2 — MinusKelvin upstream (deterministic port)
- CC2 — chouhy fork b20a92b (deterministic port)
- CC2 S2 — F14 post-tank rescue: CC2 S2 candidates re-ranked by the F14 amount-only post-tank
  solvency rescue
- CC2 S2 — F14 rescue + 180° rotation (former champion): the same rescue with 180° rotation and
  spawn-buffer entry, reproduced on the current S2 engine (not a restoration of the earlier binary)
- CC2 S2 — F14 core re-rank (former champion): the same F14 re-rank and rescue moved into the
  search's Rust core (profile-B)
- CC2 S2 — gated leaf-conversion κ0.25 (former champion): the F14 core keeps the CC2 search's rank
  order and only a root-rescue veto selects past rank 0; leaf conversion kappa=0.25 applies only up
  to height 8, default weights
- CC2 S2 — SPSA-tuned gated leaf-conversion (current champion): the same design with SPSA-tuned
  kappa=0.1164 and eight evaluation weights; development-only, not release-qualified

The champion's defaults (512 selections, THINK TIME off, queue 14) are the champion itself;
SELECTION, THINK TIME and QUEUE DEPTH can be changed like the other bots.
The Pages build runs these Cold Clear 2 entries
in browser module workers. It bundles three
import-free WebAssembly engines and the matching S2 configurations, so the browser entries do not
require a native executable or the local Node server. WebAssembly and module-worker support are
required in the browser.

The S2-labeled entries are development snapshots for inspection and comparison. Their presence in
the demo is not release qualification or a strength claim. The public snapshot does not include
private experiment runners or evidence.

## Local development

```powershell
npm ci
npm start
```

Open <http://localhost:4173/>. The local Node server can also use native engines; provide paths through
`CC2_RAW_BINARY`, `CC2_CHOUHY_BINARY`, or `CC2_S2_BINARY`; no machine-specific
path is used as a fallback.

To build the Pages artifact locally:

```powershell
npm run build-pages
```

Search benchmark reports redact OS, CPU, memory, Node version, and architecture
by default. Pass `--include-environment` only when those host details are
intentionally part of a local report.

The generated `_site/` directory contains the browser bundle, the three WebAssembly engines, their
configuration, and a matching third-party notice file. The browser bundle has no Node built-in
dependency.

## Naming and compatibility

Human-facing names use `s2-bot-lab`. Internal schema IDs, fixture `$schema`
values, preference keys, and the Rust crate name remain unchanged because they
are part of the byte-level compatibility contract.

The root project code is provided under MIT. The bundled
`bot/cold-clear-2-s2` copy retains the upstream MIT/Apache-2.0 license files;
this public snapshot redistributes that copy under the selected MIT terms.
Third-party source and bundle notices are listed in
[`THIRD_PARTY_LICENSES.md`](THIRD_PARTY_LICENSES.md).

This project is an independent, unofficial implementation. It has no
affiliation, endorsement, sponsorship, or approval relationship with TETR.IO
or The Tetris Company. The observed ruleset profile is not an official
specification.
