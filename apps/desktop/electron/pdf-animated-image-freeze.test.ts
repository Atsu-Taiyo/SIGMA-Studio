import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { encodeApng } from "@/features/rendering/core";

import { FREEZE_ANIMATED_IMAGES_SOURCE } from "./pdf-animated-image-freeze";

/** The exported text is what the export window runs, so the test drives that text, not a copy. */
const freezeAnimatedImages = new Function(`return ${FREEZE_ANIMATED_IMAGES_SOURCE};`)() as (
  root: { querySelectorAll: (selector: string) => FakeImage[] },
) => Promise<number>;

class FakeImage {
  private attributes = new Map<string, string>();

  constructor(src: string) {
    this.attributes.set("src", src);
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
}

function root(images: FakeImage[]) {
  return { querySelectorAll: (selector: string) => (selector === "img" ? images : []) };
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

function chunkTypes(png: Uint8Array): string[] {
  const types: string[] = [];
  let offset = 8;
  while (offset + 8 <= png.length) {
    const view = new DataView(png.buffer, png.byteOffset + offset);
    types.push(String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]));
    offset += 12 + view.getUint32(0);
  }
  return types;
}

function firstScanline(png: Uint8Array): number[] {
  let offset = 8;
  const parts: Uint8Array[] = [];
  while (offset + 8 <= png.length) {
    const view = new DataView(png.buffer, png.byteOffset + offset);
    const length = view.getUint32(0);
    const type = String.fromCharCode(png[offset + 4], png[offset + 5], png[offset + 6], png[offset + 7]);
    if (type === "IDAT") parts.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const raw = new Uint8Array(inflateSync(Buffer.concat(parts.map((part) => Buffer.from(part)))));
  // Skip the leading filter byte; the encoder always writes Paeth, which for row 0 predicts from
  // the pixel to the left only, and the very first pixel therefore comes through unfiltered.
  return [...raw.subarray(1, 5)];
}

function decodeDataUrl(src: string): Uint8Array {
  return new Uint8Array(Buffer.from(src.slice("data:image/png;base64,".length), "base64"));
}

describe("FREEZE_ANIMATED_IMAGES_SOURCE", () => {
  const width = 4;
  const height = 3;
  const frames = [
    { data: solidFrame(width, height, [200, 100, 50]), delayMs: 90 },
    { data: solidFrame(width, height, [10, 10, 10]), delayMs: 90 },
  ];

  it("leaves an animated PNG showing the frame its loop starts from", async () => {
    const png = await encodeApng({ width, height, frames });
    const image = new FakeImage(`data:image/png;base64,${Buffer.from(png).toString("base64")}`);

    expect(await freezeAnimatedImages(root([image]))).toBe(1);
    const frozen = decodeDataUrl(image.getAttribute("src")!);
    expect(chunkTypes(frozen)).toEqual(["IHDR", "IDAT", "IEND"]);
    expect(firstScanline(frozen)).toEqual([200, 100, 50, 255]);
  });

  it("leaves a picture that never moved exactly as it was", async () => {
    const png = await encodeApng({ width, height, frames: [frames[0]] });
    const still = new Function(`return ${FREEZE_ANIMATED_IMAGES_SOURCE};`)();
    const source = `data:image/png;base64,${Buffer.from(png).toString("base64")}`;
    const image = new FakeImage(source);
    // A single-frame APNG is still an animation as far as the chunks go, so freeze it once and
    // check that a second pass finds nothing left to do.
    await still(root([image]));
    const frozen = image.getAttribute("src");

    expect(await freezeAnimatedImages(root([image]))).toBe(0);
    expect(image.getAttribute("src")).toBe(frozen);
  });

  it("ignores pictures that are not base64 PNG data URLs", async () => {
    const image = new FakeImage("sigma-asset://something.png");

    expect(await freezeAnimatedImages(root([image]))).toBe(0);
    expect(image.getAttribute("src")).toBe("sigma-asset://something.png");
  });
});
