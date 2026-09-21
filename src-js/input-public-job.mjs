import { forecastInputBoundary } from './triangle/input-target-planner.mjs';
import { resolveQualifiedInputSubmission } from './s2-input-public-resolver.mjs';

/** Worker entry accepts only the amount-only policy request and public movement. */
export function resolveInputJob({ request, movement, startFrame, timeProgression = true, naturalGravity = true }) {
  let future;
  try { future = forecastInputBoundary(request, movement, startFrame, { timeProgression, naturalGravity }); }
  catch (error) {
    if (error.message === 'input forecast crosses a natural lock') return { status: 'stale', reason: 'natural-lock' };
    throw error;
  }
  const result = resolveQualifiedInputSubmission(future.request, future.movement,
    { compactInputs: true, timeProgression, naturalGravity });
  return { ...result, boundary: { decision: future.request.decision, movement: future.movement } };
}
