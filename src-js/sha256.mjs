import { sha256 } from "@noble/hashes/sha256.js";

const HEX = "0123456789abcdef";

export function sha256Hex(value) {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return Array.from(sha256(bytes), (byte) => `${HEX[byte >>> 4]}${HEX[byte & 0x0f]}`).join("");
}
