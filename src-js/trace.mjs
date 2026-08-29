// Debug transition trace (SIM-006).
//
// A trace answers "which rule value did this transition actually read, and at
// which stage", which is what TEST-008 needs to tell a Simulator defect apart
// from a fixture defect. It must not change what the transition returns: the
// stage envelope in `expected` is hashed into every `S-FIXTURE/1`, so a result
// that carried debug fields under tracing would make the corpus depend on
// whether tracing was on.
//
// Two properties keep that true. A sink is only created by an explicit
// `traceTransition` call, so production calls pass nothing and every record
// site is a no-op; and every recorded detail is cloned, so the trace holds a
// snapshot rather than a reference into the state the transition goes on to
// build.

export function createTrace() {
  return { entries: [] };
}

export function record(trace, stage, detail) {
  if (!trace) return;
  trace.entries.push({ stage, detail: structuredClone(detail) });
}
