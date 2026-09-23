export const F14_TIMING_KEYS = Object.freeze([
  "elapsed",
  "elapsedMs",
  "elapsedMillis",
  "elapsedNanos",
  "durationMs",
  "searchTimeMs",
  "timing",
]);

function isObject(value) {
  return value !== null && typeof value === "object";
}

export function firstResponseMismatch(left, right, { excludeDiagnostics = false, full = true } = {}) {
  const excluded = new Set(F14_TIMING_KEYS);
  if (excludeDiagnostics) excluded.add("diagnostics");

  function visit(a, b, path) {
    if (path.length > 0 && excluded.has(path[path.length - 1])) return null;
    if (Object.is(a, b)) return null;
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return path.join(".");
      for (let index = 0; index < a.length; index += 1) {
        const mismatch = visit(a[index], b[index], [...path, String(index)]);
        if (mismatch !== null) return mismatch;
      }
      return null;
    }
    if (isObject(a) || isObject(b)) {
      if (!isObject(a) || !isObject(b)) return path.join(".");
      const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])]
        .filter((key) => !excluded.has(key)).sort();
      for (const key of keys) {
        if (!Object.hasOwn(a, key) || !Object.hasOwn(b, key)) return [...path, key].join(".");
        const mismatch = visit(a[key], b[key], [...path, key]);
        if (mismatch !== null) return mismatch;
      }
      return null;
    }
    return path.join(".");
  }

  if (!full) {
    const select = (response) => ({
      status: response?.status,
      reason: response?.reason,
      selectedMove: response?.selectedMove,
      selectedIdentity: response?.selectedIdentity,
      selectedPlacement: response?.selectedPlacement,
      ranking: response?.ranking,
      search: {
        requestedSelections: response?.search?.requestedSelections,
        actualSelections: response?.search?.actualSelections,
      },
      diagnostics: response?.diagnostics,
    });
    return visit(select(left), select(right), []);
  }
  return visit(left, right, []);
}

export function excludedResponseKeys({ excludeDiagnostics = false } = {}) {
  return [...F14_TIMING_KEYS, ...(excludeDiagnostics ? ["diagnostics"] : [])];
}
