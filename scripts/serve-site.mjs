import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = resolve(process.argv.find((arg) => arg.startsWith("--root="))?.slice(7) ?? join(repo, "_site"));
const port = Number(process.argv.find((arg) => arg.startsWith("--port="))?.slice(7) ?? 4174);
if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`site directory not found: ${root}`);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("port must be an integer from 1 to 65535");

const types = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".wasm": "application/wasm" };
const server = createServer((request, response) => {
  const relative = decodeURIComponent((request.url ?? "/").split("?", 1)[0]);
  const candidate = resolve(root, `.${relative === "/" ? "/index.html" : relative}`);
  if (candidate !== root && !candidate.startsWith(`${root}\\`)) {
    response.writeHead(403).end("forbidden");
    return;
  }
  const indexCandidate = existsSync(candidate) && statSync(candidate).isDirectory() ? join(candidate, "index.html") : candidate;
  const file = existsSync(indexCandidate) && statSync(indexCandidate).isFile() ? indexCandidate : join(root, "index.html");
  const stream = createReadStream(file);
  stream.once("error", () => {
    if (response.headersSent) response.destroy();
    else response.writeHead(404).end("not found");
  });
  stream.once("open", () => {
    response.writeHead(200, { "cache-control": "no-store", "content-type": types[extname(file).toLowerCase()] ?? "application/octet-stream" });
    stream.pipe(response);
  });
});
server.listen(port, "127.0.0.1", () => console.log(`site preview: http://127.0.0.1:${port}/`));
