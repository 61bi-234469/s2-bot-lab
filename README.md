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

The bot selectors (single analysis and bot-vs-bot) offer these four bots plus two comparison entries,
the same set as TTRM INPUT, and You (1P) on the left; the local Node server offers the same list.
The first comparison entry is the previous INPUT champion route: CC2 candidates ranked by the earlier F14
amount-only selector, run on the current S2 engine. It is not a restoration of the earlier binary.
The current champion is the F14 core's gated leaf-conversion profile: it keeps the CC2 search's
rank order as its final order and only a root-rescue veto selects past rank 0.
Since 2026-09-26 its evaluation weights are SPSA-tuned (kappa=0.1164, H=8, eight weight overrides).
The second comparison entry, the previous gated champion (kappa=0.25, H=8, default weights), runs on
the same F14 core in single analysis, bot-vs-bot and TTRM INPUT.
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
