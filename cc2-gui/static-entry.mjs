import { installStaticTransport } from "./static-host.mjs";
installStaticTransport();
await import("./app.mjs");
