import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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
const result = await build({
  entryPoints: [resolve(repo, "cc2-gui/app.mjs")],
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: resolve(site, "app.bundle.js"),
  metafile: true,
  minify: true,
  plugins: [{
    name: "pages-browser-boundary",
    setup(buildApi) {
      buildApi.onResolve({ filter: /.*/ }, (args) => {
        if (shared.has(args.path)) return { path: shared.get(args.path) };
        if (forbidden.test(args.path)) {
          throw new Error(`browser bundle cannot resolve Node dependency ${args.path} from ${args.importer}`);
        }
        return undefined;
      });
    },
  }],
});

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
await writeFile(resolve(site, "index.html"), index);
await cp(resolve(repo, "cc2-gui/styles.css"), resolve(site, "styles.css"));
await writeFile(resolve(site, "THIRD_PARTY_LICENSES.txt"), `${licenses}\n\nBundled package inputs (generated):\n${[...nodeModulePackages].sort().map((name) => `- ${name}`).join("\n")}\n`);
console.log(JSON.stringify({ site, nodeModulePackages: [...nodeModulePackages].sort() }));
