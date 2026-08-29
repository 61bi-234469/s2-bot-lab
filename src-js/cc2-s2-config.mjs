import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export function loadS2Config(file) {
  const path = resolve(file);
  if (!existsSync(path)) throw new Error(`S2 config not found: ${path}`);
  return Object.freeze({
    path,
    sha256: `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
  });
}

export function s2ConfigArguments(config) {
  return config === null ? [] : ["--config", config.path];
}
