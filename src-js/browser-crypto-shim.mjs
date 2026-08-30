import { sha256Hex } from "./sha256.mjs";

export function createHash(algorithm) {
  if (algorithm !== "sha256") throw new Error(`unsupported browser hash ${algorithm}`);
  let chunks = "";
  return {
    update(value) { chunks += typeof value === "string" ? value : new TextDecoder().decode(value); return this; },
    digest(encoding) { if (encoding !== "hex") throw new Error("browser hash supports hex only"); return sha256Hex(chunks); },
  };
}
