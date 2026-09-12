/**
 * Turning a page into paper: every animated picture is pinned to the frame it starts from.
 *
 * A moving 3D material is stored as an animated PNG (see `apng.ts`). On screen that is the point;
 * on paper it is not, because a print renders whichever frame the loop happens to be showing at
 * that instant — a different moment of the same material on every export, and a different one
 * again on the next page. Dropping the animation chunks leaves a plain PNG of the first frame,
 * which is exactly what the SVG export and every other still consumer already show.
 *
 * The source is a string because it is evaluated inside the export window by the main process,
 * which cannot reach this module at run time. It is the only copy: the test drives this same text.
 */
export const FREEZE_ANIMATED_IMAGES_SOURCE = `(async (root) => {
  const prefix = "data:image/png;base64,";
  const decode = (base64) => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  };
  const encode = (bytes) => {
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  };
  const frozen = [];
  for (const image of Array.from(root.querySelectorAll("img"))) {
    const source = image.getAttribute("src") || "";
    if (source.slice(0, prefix.length) !== prefix) continue;
    const bytes = decode(source.slice(prefix.length));
    const kept = [];
    let animated = false;
    let total = 8;
    let offset = 8;
    while (offset + 8 <= bytes.length) {
      const length = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      if (type === "acTL" || type === "fcTL" || type === "fdAT") animated = true;
      else {
        kept.push(offset);
        kept.push(12 + length);
        total += 12 + length;
      }
      offset += 12 + length;
    }
    if (!animated) continue;
    const still = new Uint8Array(total);
    still.set(bytes.subarray(0, 8), 0);
    let cursor = 8;
    for (let index = 0; index < kept.length; index += 2) {
      still.set(bytes.subarray(kept[index], kept[index] + kept[index + 1]), cursor);
      cursor += kept[index + 1];
    }
    image.setAttribute("src", prefix + encode(still));
    frozen.push(image);
  }
  // The swapped picture has to be decoded before the page is printed, or it prints as a gap.
  await Promise.all(frozen.map((image) => (
    typeof image.decode === "function" ? image.decode().catch(() => undefined) : undefined
  )));
  return frozen.length;
})`;
