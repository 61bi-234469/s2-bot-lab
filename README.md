# s2-bot-lab

ブラウザ内で動く S2 Simulator と bot GUI の静止点スナップショットです。

Pages demo: <https://61bi-234469.github.io/s2-bot-lab/>

## What is included

- observed Season 2 ruleset simulator and canonical transition API
- `s2-simple` final-placement bot with optional HOLD
- browser-local bot-vs-bot and human-vs-bot play
- `.ttrm` replay import and playback; uploaded files are processed locally
- native Cold Clear 2 adapters for local development only

The Pages build is a static demo. The native Cold Clear 2 family requires the
local Node server and a locally supplied binary, so those entries are shown as
unavailable in the browser. The public snapshot does not include native
executables or private experiment runners.

## Local development

```powershell
npm ci
npm start
```

Open <http://localhost:4173/>. To use native engines, provide paths through
`CC2_RAW_BINARY`, `CC2_CHOUHY_BINARY`, or `CC2_S2_BINARY`; no machine-specific
path is used as a fallback.

To build the Pages artifact locally:

```powershell
npm run build-pages
```

Search benchmark reports redact OS, CPU, memory, Node version, and architecture
by default. Pass `--include-environment` only when those host details are
intentionally part of a local report.

The generated `_site/` directory contains the browser bundle and a matching
third-party notice file. The browser bundle has no Node built-in dependency.

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
