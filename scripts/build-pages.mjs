import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { preparePagesIndex } from "../src-js/pages-index.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const site = resolve(repo, "_site");
const forbidden = /^(?:node:|fs$|path$|crypto$|child_process$|util$|url$)/;
const shared = new Map([
  ["/shared/bot-parameters.mjs", resolve(repo, "src-js/bot-parameters.mjs")],
  ["/shared/bot-match-options.mjs", resolve(repo, "src-js/bot-match-options.mjs")],
  ["/shared/pieces.mjs", resolve(repo, "src-js/replay/pieces.mjs")],
  ["/shared/replay-garbage.mjs", resolve(repo, "src-js/replay/replay-garbage.mjs")],
  ["/shared/replay-timeline.mjs", resolve(repo, "src-js/replay/replay-timeline.mjs")],
  ["/shared/replay-ir-validation.mjs", resolve(repo, "src-js/replay/replay-ir-validation.mjs")],
]);

await mkdir(site, { recursive: true });
const workerPath = resolve(site, "cc2-worker.bundle.js");
await build({
  entryPoints: [resolve(repo, "cc2-gui/cc2-worker.mjs")],
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: workerPath,
  minify: true,
  plugins: [{ name: "worker-browser-boundary", setup(buildApi) { buildApi.onResolve({ filter: /.*/ }, (args) => {
    if (args.path.replaceAll("\\", "/").endsWith("scripts/cs1.mjs")) {
      return { path: resolve(repo, "src-js/cs1-core.mjs") };
    }
    if (args.path === "node:crypto") return { path: resolve(repo, "src-js/browser-crypto-shim.mjs") };
    if (forbidden.test(args.path)) {
      throw new Error(`worker bundle cannot resolve Node dependency ${args.path} from ${args.importer}`);
    }
    return undefined;
  }); } }],
});
const workerVersion = createHash("sha256").update(await readFile(workerPath)).digest("hex").slice(0, 12);
const appPath = resolve(site, "app.bundle.js");
const result = await build({
  entryPoints: [resolve(repo, "cc2-gui/static-entry.mjs")],
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: appPath,
  metafile: true,
  minify: true,
  define: { "globalThis.__CC2_WORKER_VERSION__": JSON.stringify(workerVersion) },
  plugins: [{
    name: "pages-browser-boundary",
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (shared.has(args.path)) return { path: shared.get(args.path) };
        if (args.path.replaceAll("\\", "/").endsWith("scripts/cs1.mjs")) return { path: resolve(repo, "src-js/cs1-core.mjs") };
        if (args.path === "node:crypto") return { path: resolve(repo, "src-js/browser-crypto-shim.mjs") };
        if (forbidden.test(args.path)) {
          throw new Error(`browser bundle cannot resolve Node dependency ${args.path} from ${args.importer}`);
        }
        return undefined;
      });
    },
  }],
});
const appVersion = createHash("sha256").update(await readFile(appPath)).digest("hex").slice(0, 12);

const nodeModulePackages = new Set();
for (const input of Object.keys(result.metafile.inputs)) {
  const marker = "node_modules/";
  const index = input.lastIndexOf(marker);
  if (index < 0) continue;
  const rest = input.slice(index + marker.length).split("/");
  nodeModulePackages.add(rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0]);
}
const licenses = await readFile(resolve(repo, "THIRD_PARTY_LICENSES.md"), "utf8");
for (const packageName of nodeModulePackages) {
  if (!licenses.includes(packageName)) throw new Error(`missing third-party notice for bundled package ${packageName}`);
}
const index = await readFile(resolve(repo, "cc2-gui/index.html"), "utf8");
await writeFile(resolve(site, "index.html"), preparePagesIndex(index, appVersion));
await cp(resolve(repo, "cc2-gui/styles.css"), resolve(site, "styles.css"));
await cp(resolve(repo, "fixtures/tuning/cc2-s2-spin-value-aligned.json"), resolve(site, "cc2-s2-spin-value-aligned.json"));
await cp(resolve(repo, "fixtures/tuning/cc2-s2-spawn-integrity-substrate-v2.json"), resolve(site, "cc2-s2-spawn-integrity-substrate-v2.json"));
const wasmArtifacts = ["cold_clear_2_s2", "cold_clear_2_upstream", "cold_clear_2_chouhy"];
const wasm = [];
for (const name of wasmArtifacts) {
  const source = resolve(repo, "bot", name.replaceAll("_", "-"), "target/wasm32-unknown-unknown/release", `${name}.wasm`);
  const bytes = await readFile(source);
  const module = await WebAssembly.compile(bytes);
  const imports = WebAssembly.Module.imports(module);
  if (imports.length !== 0) throw new Error(`${name}.wasm has ${imports.length} imports`);
  await writeFile(resolve(site, `${name}.wasm`), bytes);
  wasm.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), imports: 0 });
}
await writeFile(resolve(site, "THIRD_PARTY_LICENSES.txt"), `${licenses}\n\nBundled package inputs (generated):\n${[...nodeModulePackages].sort().map((name) => `- ${name}`).join("\n")}\n`);
await writeFile(resolve(site, "wasm-manifest.json"), `${JSON.stringify(wasm, null, 2)}\n`);
console.log(JSON.stringify({ site, nodeModulePackages: [...nodeModulePackages].sort(), wasm }));
