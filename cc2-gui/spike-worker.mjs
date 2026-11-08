// Web Worker entry of the spike WASM worker pool (src-js/spike-wasm-client.mjs) for rule RG on the page. The page
// starts it with webWorkerSpikePort(new URL("./spike-worker.bundle.js", import.meta.url)) for the GUI setting
// RG (EXPERIMENTAL) (cc2-gui/static-host.mjs createStaticRgSpikePool).
import { createSpikeWorkerHandler } from "../src-js/spike-wasm-client.mjs";

const handle = createSpikeWorkerHandler((message) => self.postMessage(message));
self.onmessage = ({ data }) => { handle(data); };
