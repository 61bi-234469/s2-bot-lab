/* MULTITHREAD on the static (Pages) GUI needs a cross-origin isolated page. Isolation comes from coi-sw.js, which is
   registered only after the user agrees to one reload; users who never turn MULTITHREAD on get no service worker.
   The local GUI server runs the engines itself, so it never needs this. */
const RELOAD_FLAG = "s2-bot-lab.isolation-reload";

/** "isolated" | "not-needed" (local server) | "reload-needed" | "reload-failed" | "unsupported" */
export function multithreadIsolationState() {
  if (globalThis.crossOriginIsolated === true) return "isolated";
  if (globalThis.__CC2_STATIC_HOST__ !== true) return "not-needed";
  if (!globalThis.isSecureContext || !("serviceWorker" in navigator) || typeof WebAssembly !== "object") return "unsupported";
  try { if (sessionStorage.getItem(RELOAD_FLAG) === "1") return "reload-failed"; } catch { /* storage blocked: no loop guard needed */ }
  return "reload-needed";
}

/** Registers coi-sw.js, waits until it controls the page, then reloads once (guarded against a reload loop). */
export async function enableIsolationAndReload() {
  const registration = await navigator.serviceWorker.register("./coi-sw.js", { scope: "./" });
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise((resolve) => {
      navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true });
      setTimeout(resolve, 3000);
    });
  }
  try { sessionStorage.setItem(RELOAD_FLAG, "1"); } catch { /* ignore */ }
  void registration;
  location.reload();
}

/** After a reload that produced isolation, the guard is cleared so a later session can reload again if needed. */
export function clearIsolationReloadGuard() {
  if (globalThis.crossOriginIsolated !== true) return;
  try { sessionStorage.removeItem(RELOAD_FLAG); } catch { /* ignore */ }
}
