// Time-dependent rule values (SIM-003).
//
// Triangle advances the garbage multiplier and the garbage cap with
// `IncreaseTracker` (`engine/utils/increase/index.ts`): every engine frame it
// increments a frame counter, and once that counter exceeds `margin` it adds
// `increase / 60` to a running total. The closed form
// `base + max(0, frame - margin) * increase / 60` is the same number in exact
// arithmetic and a different one in IEEE-754. With the TETR.IO defaults
// (`increase: 0.008`, `margin: 10800`) the two disagree at frame 12300: the
// accumulator holds 1.199999999999978 where the closed form holds 1.2, so a raw
// attack of 5 floors to 5 instead of 6 — a whole garbage row.
//
// The Simulator therefore fixes **per-frame accumulation** as the definition of
// a time-dependent value, because that is what the engine that produces the
// replays we conform against actually computes. The closed form is not an
// accepted alternative implementation, and `comparison.mode: "exact"` in
// `S-FIXTURE/1` exists so this difference cannot be absorbed as tolerance.
//
// The fold is a pure function of the frame count, so no accumulator lives in
// canonical state: two states at the same frame under the same ruleset always
// resolve to the same value, and a cache key never has to include search
// history.

// Resuming the fold from a cached prefix replays the same additions in the same
// order, so the cache changes how long the value takes to compute and not what
// it is. Without it a search that evaluates late-game positions would redo tens
// of thousands of additions per placement.
const accumulators = new Map();

export function dynamicValue(spec, frame) {
  assertSpec(spec);
  if (!Number.isSafeInteger(frame) || frame < 0) {
    throw new Error("a time-dependent value needs a non-negative safe integer frame");
  }
  // `increase: 0` adds exactly zero on every frame past the margin, so the
  // accumulator can never leave `base`. Returning it directly keeps a static
  // rule value free of the frame requirement above being load-bearing.
  if (spec.increase === 0) return spec.base;

  const key = `${spec.base}:${spec.increase}:${spec.marginFrames}`;
  let cached = accumulators.get(key);
  if (!cached || cached.frame > frame) {
    cached = { frame: 0, value: spec.base };
    accumulators.set(key, cached);
  }

  let value = cached.value;
  for (let step = cached.frame + 1; step <= frame; step += 1) {
    if (step > spec.marginFrames) value += spec.increase / 60;
  }
  cached.frame = frame;
  cached.value = value;
  return value;
}

// The frame a time-dependent value is read at has to be an engine frame.
// `virtual-tank-only` frames advance only when a placement clears nothing, so
// they count lock events rather than elapsed time; feeding them to a per-frame
// accumulator would report a multiplier the round never had. A ruleset whose
// values do not move over time is unaffected, so Foundation fixtures keep
// working under either semantics.
export function resolveDynamicValue(spec, time) {
  assertSpec(spec);
  if (time?.fidelity !== "exact") {
    throw new Error("time-dependent rule values require exact canonical time state");
  }
  if (spec.increase !== 0 && time.frameSemantics !== "engine-frame") {
    throw new Error(
      `time-dependent rule values are not defined for frame semantics ${time.frameSemantics}`,
    );
  }
  return dynamicValue(spec, time.logicalFrame);
}

// The closed form is kept next to the accumulator on purpose: it is the
// alternative SIM-003 rejects, and tests use it to show the rejection is
// observable rather than theoretical. Nothing in the transition path calls it.
export function closedFormDynamicValue(spec, frame) {
  assertSpec(spec);
  return spec.base + Math.max(0, frame - spec.marginFrames) * (spec.increase / 60);
}

function assertSpec(spec) {
  if (!spec || typeof spec !== "object") {
    throw new Error("a time-dependent value needs a {base, increase, marginFrames} spec");
  }
  if (!Number.isFinite(spec.base) || spec.base < 0) {
    throw new Error("time-dependent base must be a finite non-negative number");
  }
  if (!Number.isFinite(spec.increase) || spec.increase < 0) {
    throw new Error("time-dependent increase must be a finite non-negative number");
  }
  if (!Number.isSafeInteger(spec.marginFrames) || spec.marginFrames < 0) {
    throw new Error("time-dependent margin must be a non-negative safe integer frame count");
  }
}
