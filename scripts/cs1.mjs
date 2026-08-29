import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
export { Cs1Error, canonicalize, evaluateCases } from "../src-js/cs1-core.mjs";
import { evaluateCases } from "../src-js/cs1-core.mjs";

function main() {
  const [mode, fixturePath] = process.argv.slice(2);
  if (!fixturePath || !["--check", "--emit"].includes(mode)) {
    throw new Error("usage: node scripts/cs1.mjs --check|--emit <fixture>");
  }
  const cases = JSON.parse(readFileSync(fixturePath, "utf8"));
  const actual = evaluateCases(cases);
  if (mode === "--emit") {
    process.stdout.write(JSON.stringify(actual));
    return;
  }
  const failures = actual.filter((result, index) => {
    const expected = cases[index];
    return expected.canonical !== result.canonical || expected.error !== result.error;
  });
  if (failures.length > 0) {
    process.stderr.write(`${JSON.stringify(failures, null, 2)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
