import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const toolingRepo = resolve(scriptDir, "..");
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.slice(2).split("=");
  return [key, rest.join("=")];
}));
const repo = resolve(args.get("repo") ?? toolingRepo);
const print0 = args.has("print0");
const defaultAuditDir = resolve(dirname(repo), `${basename(repo)}-release-audit`);
const out = resolve(args.get("out") ?? join(defaultAuditDir, "publication-manifest.json"));

const entryPoints = [
  "scripts/cc2-gui-server.mjs",
  "cc2-gui/app.mjs",
  "cc2-gui/static-host.mjs",
  "cc2-gui/static-entry.mjs",
  "cc2-gui/cc2-worker.mjs",
  "src-js/cc2-wasm-engine.mjs",
  "scripts/cs1.mjs",
  "scripts/wasm-engine.mjs",
  "scripts/build-pages.mjs",
  "scripts/publication-closure.mjs",
  "scripts/serve-site.mjs",
  "src-js/browser-crypto-shim.mjs",
  "scripts/benchmark-search.mjs",
  "scripts/stop-port.mjs",
];
const sharedBrowserModules = [
  "src-js/bot-parameters.mjs",
  "src-js/bot-match-options.mjs",
  "src-js/replay/pieces.mjs",
  "src-js/replay/replay-garbage.mjs",
  "src-js/replay/replay-timeline.mjs",
  "src-js/replay/replay-ir-validation.mjs",
];
const fixedAssets = [
  ".gitattributes",
  ".gitignore",
  ".github/workflows/pages.yml",
  "CONTRIBUTING.md",
  "Cargo.lock",
  "Cargo.toml",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_LICENSES.md",
  "fixtures/benchmark/search-v1.json",
  "fixtures/tuning/cc2-s2-initial-weight-grid.json",
  "fixtures/tuning/cc2-s2-spin-value-aligned.json",
  "package-lock.json",
  "package.json",
  "rulesets/tetrio-s2-v19-beta-1-5-0-observed.json",
  "rust-toolchain.toml",
  "third_party/fumen-mobile-fork/LICENSE.md",
  "third_party/triangle/LICENSE.md",
];
const allowedTrees = [
  "bot/cold-clear-2-s2/",
  "bot/cold-clear-2-upstream/",
  "bot/cold-clear-2-chouhy/",
  "bot/instant-wasm-safe/",
  "bot/puffin-noop/",
  "cc2-gui/",
  "fixtures/cross-runtime/",
  "fixtures/golden/",
  "schema/",
  "src/",
  "tests/",
];
const excludedPublicTests = new Set([
  // This test consumes an arena fixture; arena evidence is private-only.
  "tests-js/proposal-outcome.test.mjs",
]);
const forbiddenPath = /^(?:AGENTS(?:\.local)?\.md|CLAUDE\.md|docs\/|skills\/|\.claude\/|一時的\/|target\/|node_modules\/|research\/|third_party\/reference-clones\/|third_party\/mochbot-fusion\/|fixtures\/arena\/|fixtures\/compare\/|fixtures\/evidence\/)/i;
const forbiddenText = /fusion|LOCALAPPDATA|C:\\Users\\|C:\/Users\/|\/Users\/[^/]+\/|\/home\/[^/]+\/|AppData|OneDrive|docs\/|skills\/|一時的/i;
const textAuditExclusions = new Set(["scripts/publication-closure.mjs"]);
const importPattern = /(?:from\s*|import\s*\()\s*["']([^"']+)["']/g;

function git(cwd, ...gitArgs) {
  return execFileSync("git", ["-C", cwd, ...gitArgs], { encoding: "utf8" });
}

function normalizePath(path) {
  return path.replaceAll("\\", "/").normalize("NFC");
}

function repositoryPath(absolute) {
  const path = normalizePath(relative(repo, absolute));
  if (path === ".." || path.startsWith("../") || isAbsolute(path)) {
    throw new Error(`dependency escapes repository: ${absolute}`);
  }
  return path;
}

async function localImports(path) {
  const text = await readFile(join(repo, path), "utf8");
  const imports = [];
  for (const match of text.matchAll(importPattern)) {
    if (!match[1].startsWith(".")) continue;
    let dependency = repositoryPath(resolve(repo, dirname(path), match[1]));
    if (extname(dependency) === "") dependency += ".mjs";
    imports.push(dependency);
  }
  return imports;
}

async function moduleClosure(roots) {
  const closure = new Set();
  const queue = [...roots];
  while (queue.length > 0) {
    const path = normalizePath(queue.shift());
    if (closure.has(path)) continue;
    closure.add(path);
    try {
      await readFile(join(repo, path));
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const dependency of await localImports(path)) queue.push(dependency);
  }
  return closure;
}

const trackedPaths = git(repo, "ls-files", "-z").split("\0").filter(Boolean).map(normalizePath);
const tracked = new Set(trackedPaths);
const expected = await moduleClosure([...entryPoints, ...sharedBrowserModules]);
for (const path of fixedAssets) expected.add(path);
for (const path of trackedPaths) {
  if (allowedTrees.some((prefix) => path.startsWith(prefix))) expected.add(path);
}

for (const testPath of trackedPaths.filter((path) => path.startsWith("tests-js/") && path.endsWith(".test.mjs"))) {
  if (excludedPublicTests.has(testPath)) continue;
  const dependencies = await moduleClosure([testPath]);
  dependencies.delete(testPath);
  if ([...dependencies].every((path) => expected.has(path))) expected.add(testPath);
}

const expectedPaths = [...expected].sort();
const unexpectedPaths = trackedPaths.filter((path) => !expected.has(path)).sort();
const missingPaths = expectedPaths.filter((path) => !tracked.has(path));
const rejectedPaths = trackedPaths.filter((path) => forbiddenPath.test(path));
const textFindings = [];
for (const path of trackedPaths) {
  if (forbiddenPath.test(path) || textAuditExclusions.has(path)) continue;
  try {
    const text = await readFile(join(repo, path), "utf8");
    const withoutWebUrls = text.replaceAll(/https?:\/\/[^\s)`'"<>]+/g, "");
    if (forbiddenText.test(withoutWebUrls)) textFindings.push(path);
  } catch {
    // Exact-set validation still rejects an unapproved binary path.
  }
}

if (print0) {
  process.stdout.write(Buffer.from(`${expectedPaths.join("\0")}\0`, "utf8"));
} else {
  const result = {
    schema: "s2-bot-lab/publication-manifest/1",
    generatedAt: new Date().toISOString(),
    repository: repo,
    sourceCommit: git(repo, "rev-parse", "HEAD").trim(),
    treeOid: git(repo, "show", "-s", "--format=%T", "HEAD").trim(),
    toolingCommit: git(toolingRepo, "rev-parse", "HEAD").trim(),
    paths: expectedPaths,
    trackedFileCount: trackedPaths.length,
    unexpectedPaths,
    missingPaths,
    rejectedPaths,
    textFindings,
    pass: unexpectedPaths.length === 0 && missingPaths.length === 0 &&
      rejectedPaths.length === 0 && textFindings.length === 0,
  };
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(result));
  if (!result.pass) process.exitCode = 1;
}
