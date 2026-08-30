# Public repository rules

This repository is the reviewed public product tree for `s2-bot-lab`. It is downstream of the
active private staging repository. Keep this file concise and safe to publish.

## Repository role and source authority

- Shared simulator, bot, GUI, and build changes are authored and verified in the staging repository
  first, then synchronized here through the publication checks. Do not create a competing shared
  implementation only in this repository.
- Public-only README, contribution, workflow, and packaging changes may be made here when explicitly
  requested. They must not import private experiment plans, evidence, review records, or credentials.
- Use `develop` as the public integration branch. Do not create or target another branch, push, open a
  pull request, deploy, or publish unless the user explicitly requests that action.

## Product and evidence boundaries

- The public product is a reproducible browser implementation of the observed S2 rules and its bot
  interfaces. Internal strengthening work is useful only when it can be safely reduced to reviewed
  product code and public evidence.
- Browser CC2 variants are deterministic development snapshots for inspection and comparison. Their
  presence is not release qualification or a claim that one variant is stronger than another.
- The S2 Simulator is authoritative for line clears, spins, attack, B2B, combo, cancellation, tank,
  and garbage. Engine-provided spin labels are diagnostic only.
- Preserve internal schema IDs, fixture schema values, preference keys, and Rust crate names that are
  part of the compatibility contract. Do not mass-rename them for presentation consistency.
- Do not add native executables, secrets, host-specific paths, generated site output, private records,
  or unreviewed third-party source. Keep license and notice files aligned with distributed code.

## Working method

- Start with `README.md` for product scope, `CONTRIBUTING.md` for contributor checks, `package.json`
  for supported commands, and `THIRD_PARTY_LICENSES.md` for redistribution boundaries.
- Reuse existing simulator APIs, bot adapters, browser workers, build scripts, fixtures, and tests.
  Add a new path only when its behavior or safety boundary is genuinely different.
- Make the smallest complete change and protect a stated behavior, regression, or publication
  boundary. Do not expand a public-facing statement beyond the evidence present in this tree.
- Preserve unrelated user changes and establish whether a failure existed before the current edit.

## Verification

- Run the narrowest relevant checks first, then match the affected public coverage.
- Use `npm test` for the Node suite and `npm run test:cs1` for the compact simulator compatibility
  check. Run `npm run build-pages` when browser, worker, packaging, or public content changes.
- If Rust code changes, run the narrowest relevant Rust tests before broader checks.
- Treat build failures, missing artifacts, mismatched notices, and invalid fixtures as execution
  problems to fix, not as weak evidence to reinterpret.
