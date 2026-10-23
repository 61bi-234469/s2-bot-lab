/* Cross-origin isolation for the static (Pages) GUI. GitHub Pages cannot send response headers, so this service
   worker re-issues same-origin responses with COOP / COEP / CORP. A page served through it is cross-origin isolated,
   which the threaded WASM (MULTITHREAD) needs. It is registered only when a user turns MULTITHREAD on
   (cc2-gui/isolation.mjs); it caches nothing and passes every other request through untouched. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (new URL(request.url).origin !== self.location.origin) return;
  if (request.cache === "only-if-cached" && request.mode !== "same-origin") return;
  event.respondWith(fetch(request).then((response) => {
    if (response.status === 0 || response.type === "opaque") return response;
    const headers = new Headers(response.headers);
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }));
});
