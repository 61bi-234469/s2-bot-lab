# instant deterministic bare-WASM patch

Source: `instant` 0.1.13, https://github.com/sebcrozet/instant

This copy retains the upstream BSD-3-Clause license. Its only maintained change
is the no-feature bare-WASM `now()` fallback: it returns `0.0` instead of
importing `env.now`. CC2's single-threaded fixed-selection driver does not use
timed parking; native builds retain the upstream clock implementation. This
patch therefore removes a host import without changing native search behavior.
