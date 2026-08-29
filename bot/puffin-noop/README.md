# puffin no-op WASM facade

CC2 profiling macros are intentionally disabled in the public fixed-selection
WASM build. Native targets continue to use upstream `puffin`; this tiny
repository-owned facade exposes only the two no-op macros referenced by CC2.
