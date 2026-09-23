export function deepEqual(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  if (leftKeys.length !== rightKeys.length) return false;
  if (!leftKeys.every((key) => Object.hasOwn(right, key))) return false;
  return leftKeys.every((key) => deepEqual(left[key], right[key]));
}
