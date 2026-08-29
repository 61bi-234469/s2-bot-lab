import { createGuiRequestHandlers } from "../src-js/gui-request-handlers.mjs";

let installed = false;

/** Install the Pages transport before the GUI performs its first capability request. */
export function installStaticTransport() {
  if (installed || typeof window === "undefined") return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);
  const handlers = createGuiRequestHandlers();
  window.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url, window.location.href);
    if (!url.pathname.startsWith("/api/")) return nativeFetch(input, init);
    const body = request.method === "GET" || request.method === "HEAD" ? null : await request.text();
    let parsed = body;
    if (request.headers.get("content-type")?.includes("application/json")) parsed = JSON.parse(body);
    const result = await handlers.handle({ method: request.method, path: url.pathname, body: parsed });
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });
  };
}
