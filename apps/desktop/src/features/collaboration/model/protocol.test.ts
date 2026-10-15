import { describe, expect, it } from "vitest";
import { fromBase64, toBase64 } from "./protocol";

function bytesOf(length: number, seed: number): Uint8Array {
  const bytes = new Uint8Array(length);
  let state = seed;
  for (let i = 0; i < length; i++) {
    state = (state * 1103515245 + 12345) >>> 0;
    bytes[i] = state >>> 24;
  }
  return bytes;
}

describe("collaboration base64 payloads", () => {
  it("decodes every byte value and length exactly as Node's decoder does", () => {
    const allBytes = Uint8Array.from({ length: 256 }, (_, i) => i);
    for (const bytes of [new Uint8Array(0), allBytes, ...[1, 2, 3, 8191, 8192, 8193, 100_003].map((length) => bytesOf(length, length))]) {
      const encoded = toBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
      const decoded = fromBase64(encoded, 1024 * 1024);
      expect(decoded).toBeInstanceOf(Uint8Array);
      expect(Buffer.from(decoded).equals(Buffer.from(bytes))).toBe(true);
    }
  });

  it("still refuses payloads over the limit and malformed text", () => {
    expect(() => fromBase64(toBase64(bytesOf(11, 1)), 10)).toThrow("PAYLOAD_LIMIT");
    expect(() => fromBase64("A".repeat(64), 10)).toThrow("PAYLOAD_LIMIT");
    expect(fromBase64(toBase64(bytesOf(10, 1)), 10)).toHaveLength(10);
    expect(() => fromBase64("not base64!")).toThrow();
  });
});
