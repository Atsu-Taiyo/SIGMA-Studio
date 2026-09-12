import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { apngChangedRect, apngCropRgba, encodeApng } from "./apng";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

interface ParsedChunk {
  type: string;
  body: Uint8Array;
  crcValid: boolean;
}

function parseChunks(png: Uint8Array): ParsedChunk[] {
  expect([...png.subarray(0, 8)]).toEqual(PNG_SIGNATURE);
  const chunks: ParsedChunk[] = [];
  let offset = 8;
  while (offset < png.length) {
    const view = new DataView(png.buffer, png.byteOffset + offset);
    const length = view.getUint32(0);
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
    const body = png.subarray(offset + 8, offset + 8 + length);
    const declared = view.getUint32(8 + length);
    chunks.push({
      type,
      body,
      crcValid: declared === crc32(png.subarray(offset + 4, offset + 8 + length)),
    });
    offset += 12 + length;
  }
  return chunks;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** Undoes the encoder's scanline filtering so a frame can be compared byte for byte. */
function unfilter(filtered: Uint8Array, width: number, height: number): Uint8Array {
  const rowBytes = width * 4;
  const out = new Uint8Array(rowBytes * height);
  for (let y = 0; y < height; y += 1) {
    const filter = filtered[y * (rowBytes + 1)];
    const source = y * (rowBytes + 1) + 1;
    const target = y * rowBytes;
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= 4 ? out[target + index - 4] : 0;
      const up = y > 0 ? out[target - rowBytes + index] : 0;
      const upLeft = y > 0 && index >= 4 ? out[target - rowBytes + index - 4] : 0;
      const raw = filtered[source + index];
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = (left + up) >> 1;
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      out[target + index] = (raw + predictor) & 0xff;
    }
  }
  return out;
}

function paeth(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  if (distanceUp <= distanceUpLeft) return up;
  return upLeft;
}

function inflate(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(inflateSync(Buffer.from(bytes)));
}

function solidFrame(width: number, height: number, rgb: [number, number, number]): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(width * height * 4);
  for (let index = 0; index < width * height; index += 1) {
    data[index * 4] = rgb[0];
    data[index * 4 + 1] = rgb[1];
    data[index * 4 + 2] = rgb[2];
    data[index * 4 + 3] = 255;
  }
  return data;
}

describe("apngChangedRect", () => {
  it("returns the tight box around the pixels that differ", () => {
    const width = 5;
    const height = 4;
    const previous = solidFrame(width, height, [10, 20, 30]);
    const next = solidFrame(width, height, [10, 20, 30]);
    for (const [x, y] of [[1, 1], [3, 2]] as const) {
      next[(y * width + x) * 4] = 99;
    }

    expect(apngChangedRect(previous, next, width, height)).toEqual({ x: 1, y: 1, width: 3, height: 2 });
  });

  it("spends a single pixel on a frame that repeats the one before it", () => {
    const frame = solidFrame(3, 3, [1, 2, 3]);

    expect(apngChangedRect(frame, solidFrame(3, 3, [1, 2, 3]), 3, 3))
      .toEqual({ x: 0, y: 0, width: 1, height: 1 });
  });
});

describe("apngCropRgba", () => {
  it("copies one rectangle out of a full-canvas buffer", () => {
    const width = 3;
    const data = solidFrame(width, 3, [0, 0, 0]);
    data[(1 * width + 2) * 4] = 42;

    const cropped = apngCropRgba(data, width, { x: 2, y: 1, width: 1, height: 1 });

    expect([...cropped]).toEqual([42, 0, 0, 255]);
  });
});

describe("encodeApng", () => {
  const width = 4;
  const height = 3;
  const frames = [
    { data: solidFrame(width, height, [200, 100, 50]), delayMs: 90 },
    { data: solidFrame(width, height, [10, 10, 10]), delayMs: 90 },
  ];

  it("writes the first frame as the plain image and the rest as the animation", async () => {
    const png = await encodeApng({ width, height, frames });
    const chunks = parseChunks(png);

    expect(chunks.every((chunk) => chunk.crcValid)).toBe(true);
    expect(chunks.map((chunk) => chunk.type)).toEqual([
      "IHDR", "acTL", "fcTL", "IDAT", "fcTL", "fdAT", "IEND",
    ]);
    // The `fcTL` ahead of `IDAT` is what folds the plain image into the loop as frame one.
    expect(chunks.findIndex((chunk) => chunk.type === "fcTL"))
      .toBeLessThan(chunks.findIndex((chunk) => chunk.type === "IDAT"));
  });

  it("decodes IDAT back to the first frame, so a still viewer sees where the loop starts", async () => {
    const png = await encodeApng({ width, height, frames });
    const idat = parseChunks(png).find((chunk) => chunk.type === "IDAT");

    expect(idat).toBeDefined();
    expect([...unfilter(inflate(idat!.body), width, height)]).toEqual([...frames[0].data]);
  });

  it("paints the whole canvas first and only the change afterwards", async () => {
    const width2 = 6;
    const height2 = 4;
    const base = solidFrame(width2, height2, [5, 5, 5]);
    const moved = solidFrame(width2, height2, [5, 5, 5]);
    moved[(2 * width2 + 4) * 4] = 200;
    const png = await encodeApng({
      width: width2,
      height: height2,
      frames: [{ data: base, delayMs: 40 }, { data: moved, delayMs: 40 }],
    });
    const controls = parseChunks(png)
      .filter((chunk) => chunk.type === "fcTL")
      .map((chunk) => {
        const view = new DataView(chunk.body.buffer, chunk.body.byteOffset);
        return {
          sequence: view.getUint32(0),
          width: view.getUint32(4),
          height: view.getUint32(8),
          x: view.getUint32(12),
          y: view.getUint32(16),
          delayNumerator: view.getUint16(20),
          delayDenominator: view.getUint16(22),
        };
      });

    expect(controls[0]).toMatchObject({
      sequence: 0, x: 0, y: 0, width: width2, height: height2, delayNumerator: 40, delayDenominator: 1_000,
    });
    expect(controls[1]).toMatchObject({ sequence: 1, x: 4, y: 2, width: 1, height: 1 });
  });

  it("counts every frame in acTL and loops forever by default", async () => {
    const png = await encodeApng({ width, height, frames });
    const actl = parseChunks(png).find((chunk) => chunk.type === "acTL");
    const view = new DataView(actl!.body.buffer, actl!.body.byteOffset);

    expect(view.getUint32(0)).toBe(2);
    expect(view.getUint32(4)).toBe(0);
  });

  it("decodes a later frame back to the pixels it was given", async () => {
    const png = await encodeApng({ width, height, frames });
    const fdat = parseChunks(png).find((chunk) => chunk.type === "fdAT");
    // `fdAT` carries a sequence number ahead of the compressed scanlines.
    const compressed = fdat!.body.subarray(4);

    expect([...unfilter(inflate(compressed), width, height)]).toEqual([...frames[1].data]);
  });

  it("refuses frames whose size disagrees with the canvas", async () => {
    await expect(encodeApng({
      width,
      height,
      frames: [{ data: solidFrame(2, 2, [0, 0, 0]), delayMs: 40 }],
    })).rejects.toThrow();
  });
});
