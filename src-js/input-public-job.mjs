import { forecastInputBoundary } from './triangle/input-target-planner.mjs';
import { resolveCoreOrderedInputSubmission, resolveQualifiedInputSubmission } from './s2-input-public-resolver.mjs';

/** Worker entry accepts only the amount-only policy request and public movement. */
export function resolveInputJob({ request, movement, startFrame, timeProgression = true, naturalGravity = true, reuse = null,
  preferredWitness = null }) {
  let future;
  try { future = forecastInputBoundary(request, movement, startFrame, { timeProgression, naturalGravity }); }
  catch (error) {
    if (error.message === 'input forecast crosses a natural lock') return { status: 'stale', reason: 'natural-lock' };
    throw error;
  }
  const resolve = request.type === 'cc2-s2-champion'
    ? resolveCoreOrderedInputSubmission
    : resolveQualifiedInputSubmission;
  // The champion core reports its selected move's spin witness; the planner
  // reuses it instead of repeating the public reach search (planner input,
  // outside the fingerprinted request).
  const result = resolve(future.request, future.movement,
    { compactInputs: true, timeProgression, naturalGravity, reuse,
      ...(request.type === 'cc2-s2-champion' ? { preferredWitness } : {}) });
  return { ...result, boundary: { decision: future.request.decision, movement: future.movement } };
}
