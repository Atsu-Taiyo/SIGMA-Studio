/**
 * Animated PNG writer.
 *
 * The reason a moving 3D material is written as APNG and not as a GIF or a video: an APNG *is* a
 * PNG. Its `IDAT` holds the first frame as a plain image, so print, the SVG export and every
 * decoder that does not know APNG show that one picture, while the editor page and the viewer —
 * both `<img>` in Chromium — play the animation. One asset, one mime type, no new branch in the
 * render, save, or safety paths.
 *
 * `IDAT` is the animation's own first frame, not a separate poster: an `fcTL` precedes it, which
 * is what folds it into the loop. Everything that cannot animate therefore agrees on *which*
 * moment it shows — the one the animation starts from.
 */

/** Byte buffers a `Blob` accepts; the bare `Uint8Array` type also admits `SharedArrayBuffer`. */
type Bytes = Uint8Array<ArrayBuffer>;

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const BYTES_PER_PIXEL = 4;
/** `delay_num` is 16-bit and the denominator below fixes its unit at one millisecond. */
const DELAY_DENOMINATOR = 1_000;
const MAX_DELAY_MS = 0xffff;
const APNG_DISPOSE_OP_NONE = 0;
const APNG_BLEND_OP_SOURCE = 0;

export interface ApngAnimationFrame {
  /** RGBA bytes covering the whole canvas, `width * height * 4` long. */
  data: Bytes;
  /** How long this frame stays on screen. */
  delayMs: number;
}

export interface ApngEncodeOptions {
  width: number;
  height: number;
  /** At least one. The first is also the plain PNG a decoder without APNG support reads. */
  frames: ApngAnimationFrame[];
  /** How many times the animation runs. 0, the default, means forever. */
  playCount?: number;
}

export interface ApngRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Smallest rectangle outside which two full-canvas frames agree.
 *
 * Frames are stored with `dispose = none` and `blend = source`, so everything outside the returned
 * rectangle is inherited unchanged from the frame before. Identical frames report a single pixel:
 * APNG has no zero-sized frame, and one pixel is the cheapest legal way to spend a delay.
 */
export function apngChangedRect(
  previous: Bytes,
  next: Bytes,
  width: number,
  height: number,
): ApngRect {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * width * BYTES_PER_PIXEL;
    for (let x = 0; x < width; x += 1) {
      const index = rowStart + x * BYTES_PER_PIXEL;
      if (
        previous[index] === next[index] &&
        previous[index + 1] === next[index + 1] &&
        previous[index + 2] === next[index + 2] &&
        previous[index + 3] === next[index + 3]
      ) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { x: 0, y: 0, width: 1, height: 1 };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Copies one rectangle out of a full-canvas RGBA buffer. */
export function apngCropRgba(
  data: Bytes,
  width: number,
  rect: ApngRect,
): Bytes {
  const rowBytes = rect.width * BYTES_PER_PIXEL;
  const out = new Uint8Array(rowBytes * rect.height);
  for (let row = 0; row < rect.height; row += 1) {
    const source = ((rect.y + row) * width + rect.x) * BYTES_PER_PIXEL;
    out.set(data.subarray(source, source + rowBytes), row * rowBytes);
  }
  return out;
}

export async function encodeApng({
  width,
  height,
  frames,
  playCount = 0,
}: ApngEncodeOptions): Promise<Bytes> {
  const pixels = width * height * BYTES_PER_PIXEL;
  if (width <= 0 || height <= 0) throw new Error("Invalid APNG dimensions");
  if (frames.length === 0) throw new Error("APNG requires at least one frame");
  for (const frame of frames) {
    if (frame.data.length !== pixels) throw new Error("APNG frame size mismatch");
  }

  const [first, ...rest] = frames;
  const parts: Bytes[] = [
    PNG_SIGNATURE,
    chunk("IHDR", imageHeader(width, height)),
    chunk("acTL", animationControl(frames.length, playCount)),
    // The first frame covers the canvas and is written as the plain image; its `fcTL` sits ahead of
    // `IDAT`, which is what makes a player treat it as frame one rather than skip it.
    chunk("fcTL", frameControl(0, { x: 0, y: 0, width, height }, first.delayMs)),
    chunk("IDAT", await deflate(paethFilter(first.data, width, height))),
  ];

  let sequence = 1;
  let composited = first.data;
  for (const frame of rest) {
    const rect = apngChangedRect(composited, frame.data, width, height);
    const region = rect.width === width && rect.height === height && rect.x === 0 && rect.y === 0
      ? frame.data
      : apngCropRgba(frame.data, width, rect);
    parts.push(chunk("fcTL", frameControl(sequence, rect, frame.delayMs)));
    sequence += 1;
    const compressed = await deflate(paethFilter(region, rect.width, rect.height));
    const body: Bytes = new Uint8Array(4 + compressed.length);
    writeUint32(body, 0, sequence);
    body.set(compressed, 4);
    parts.push(chunk("fdAT", body));
    sequence += 1;
    composited = frame.data;
  }

  parts.push(chunk("IEND", new Uint8Array(0)));
  return concatenate(parts);
}

function imageHeader(width: number, height: number): Bytes {
  const body = new Uint8Array(13);
  writeUint32(body, 0, width);
  writeUint32(body, 4, height);
  body[8] = 8; // bit depth
  body[9] = 6; // colour type: truecolour with alpha
  body[10] = 0; // deflate
  body[11] = 0; // adaptive filtering
  body[12] = 0; // no interlace
  return body;
}

function animationControl(frameCount: number, playCount: number): Bytes {
  const body = new Uint8Array(8);
  writeUint32(body, 0, frameCount);
  writeUint32(body, 4, Math.max(0, Math.floor(playCount)));
  return body;
}

function frameControl(sequence: number, rect: ApngRect, delayMs: number): Bytes {
  const body = new Uint8Array(26);
  writeUint32(body, 0, sequence);
  writeUint32(body, 4, rect.width);
  writeUint32(body, 8, rect.height);
  writeUint32(body, 12, rect.x);
  writeUint32(body, 16, rect.y);
  const delay = Math.min(MAX_DELAY_MS, Math.max(1, Math.round(delayMs)));
  body[20] = (delay >> 8) & 0xff;
  body[21] = delay & 0xff;
  body[22] = (DELAY_DENOMINATOR >> 8) & 0xff;
  body[23] = DELAY_DENOMINATOR & 0xff;
  body[24] = APNG_DISPOSE_OP_NONE;
  body[25] = APNG_BLEND_OP_SOURCE;
  return body;
}

/**
 * One filter for every scanline instead of the usual per-row search.
 *
 * Paeth is the safe single choice for a shaded render, and picking per row would mean four extra
 * passes over every frame of the animation while the user waits for the material to settle.
 */
function paethFilter(rgba: Bytes, width: number, height: number): Bytes {
  const rowBytes = width * BYTES_PER_PIXEL;
  const out = new Uint8Array((rowBytes + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const source = y * rowBytes;
    const target = y * (rowBytes + 1);
    out[target] = 4;
    for (let index = 0; index < rowBytes; index += 1) {
      const left = index >= BYTES_PER_PIXEL ? rgba[source + index - BYTES_PER_PIXEL] : 0;
      const up = y > 0 ? rgba[source - rowBytes + index] : 0;
      const upLeft = y > 0 && index >= BYTES_PER_PIXEL ? rgba[source - rowBytes + index - BYTES_PER_PIXEL] : 0;
      out[target + 1 + index] = (rgba[source + index] - paethPredictor(left, up, upLeft)) & 0xff;
    }
  }
  return out;
}

function paethPredictor(left: number, up: number, upLeft: number): number {
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  if (distanceUp <= distanceUpLeft) return up;
  return upLeft;
}

/** PNG stores zlib streams, which is exactly what `CompressionStream("deflate")` produces. */
async function deflate(bytes: Bytes): Promise<Bytes> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function chunk(type: string, body: Bytes): Bytes {
  const out = new Uint8Array(12 + body.length);
  writeUint32(out, 0, body.length);
  for (let index = 0; index < 4; index += 1) out[4 + index] = type.charCodeAt(index);
  out.set(body, 8);
  writeUint32(out, 8 + body.length, crc32(out.subarray(4, 8 + body.length)));
  return out;
}

function writeUint32(target: Bytes, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
}

function concatenate(parts: Bytes[]): Bytes {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array<ArrayBufferLike>): number {
  if (!crcTable) {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let value = n;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
      }
      table[n] = value >>> 0;
    }
    crcTable = table;
  }
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
