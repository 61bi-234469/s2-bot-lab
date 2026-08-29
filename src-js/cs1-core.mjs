const MIN_NON_ZERO = 1e-12;
const MAX_ABS_EXCLUSIVE = 1e21;
const MAX_FRACTIONAL_DIGITS = 15;

export class Cs1Error extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "string") return quote(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const keys = Object.keys(value).sort(compareCodePoints);
    return `{${keys.map((key) => `${quote(key)}:${canonicalize(value[key])}`).join(",")}}`;
  }
  throw new Cs1Error("unsupported-type");
}

function compareCodePoints(left, right) {
  const a = Array.from(left, (character) => character.codePointAt(0));
  const b = Array.from(right, (character) => character.codePointAt(0));
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return a.length - b.length;
}

function quote(value) {
  let output = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (character === '"') output += '\\"';
    else if (character === "\\") output += "\\\\";
    else if (character === "\b") output += "\\b";
    else if (character === "\f") output += "\\f";
    else if (character === "\n") output += "\\n";
    else if (character === "\r") output += "\\r";
    else if (character === "\t") output += "\\t";
    else if (codePoint <= 0x1f) output += `\\u${codePoint.toString(16).padStart(4, "0")}`;
    else output += character;
  }
  return `${output}"`;
}

function formatNumber(value) {
  if (!Number.isFinite(value)) throw new Cs1Error("non-finite-number");
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
    throw new Cs1Error("unsafe-integer");
  }
  if (Object.is(value, -0) || value === 0) return "0";
  if (Math.abs(value) < MIN_NON_ZERO || Math.abs(value) >= MAX_ABS_EXCLUSIVE) {
    throw new Cs1Error("number-out-of-range");
  }
  const plain = exponentToPlain(value.toString());
  const fraction = plain.includes(".") ? plain.split(".")[1].replace(/0+$/, "") : "";
  if (fraction.length > MAX_FRACTIONAL_DIGITS) {
    throw new Cs1Error("too-many-fractional-digits");
  }
  return plain;
}

function exponentToPlain(input) {
  if (!/[eE]/.test(input)) return input;
  const [coefficient, exponentText] = input.toLowerCase().split("e");
  const exponent = Number(exponentText);
  const negative = coefficient.startsWith("-");
  const unsigned = coefficient.replace(/^-/, "");
  const digits = unsigned.replace(".", "");
  const decimalAt = (unsigned.includes(".") ? unsigned.indexOf(".") : unsigned.length) + exponent;
  let plain;
  if (decimalAt <= 0) plain = `0.${"0".repeat(-decimalAt)}${digits}`;
  else if (decimalAt >= digits.length) plain = `${digits}${"0".repeat(decimalAt - digits.length)}`;
  else plain = `${digits.slice(0, decimalAt)}.${digits.slice(decimalAt)}`;
  return negative ? `-${plain}` : plain;
}

export function evaluateCases(cases) {
  return cases.map(({ id, value }) => {
    try {
      return { id, ok: true, canonical: canonicalize(value) };
    } catch (error) {
      if (!(error instanceof Cs1Error)) throw error;
      return { id, ok: false, error: error.code };
    }
  });
}

