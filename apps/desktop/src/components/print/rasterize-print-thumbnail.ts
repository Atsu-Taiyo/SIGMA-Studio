export const WORKSPACE_PREVIEW_OUTPUT_WIDTH_PX = 360;

export function printThumbnailRasterSize(
  pageWidthPx: number,
  pageHeightPx: number,
  outputWidthPx = WORKSPACE_PREVIEW_OUTPUT_WIDTH_PX,
): { width: number; height: number; sourceWidth: number; sourceHeight: number } {
  const sourceWidth = Math.max(1, pageWidthPx);
  const sourceHeight = Math.max(1, pageHeightPx / 2);
  const scale = outputWidthPx / sourceWidth;
  return {
    width: Math.max(1, Math.round(outputWidthPx)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
    sourceWidth,
    sourceHeight,
  };
}

export async function rasterizePrintPageTopHalf(
  surface: HTMLElement,
  outputWidthPx = WORKSPACE_PREVIEW_OUTPUT_WIDTH_PX,
): Promise<string> {
  const page = surface.querySelector<HTMLElement>(".print-a4-page");
  if (!page) {
    throw new Error("print page missing");
  }
  const rect = page.getBoundingClientRect();
  const size = printThumbnailRasterSize(rect.width || page.offsetWidth, rect.height || page.offsetHeight, outputWidthPx);
  return rasterizeElementTopHalf(page, size);
}

async function rasterizeElementTopHalf(
  element: HTMLElement,
  size: { width: number; height: number; sourceWidth: number; sourceHeight: number },
): Promise<string> {
  const css = collectCssText();
  const serialized = new XMLSerializer().serializeToString(element);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.sourceWidth}" height="${size.sourceHeight}">`,
    `<foreignObject width="${size.sourceWidth}" height="${size.sourceHeight}">`,
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${size.sourceWidth}px;height:${size.sourceHeight}px;overflow:hidden;background:#ffffff">`,
    `<style>${css}</style>`,
    serialized,
    "</div></foreignObject></svg>",
  ].join("");
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = await loadImage(url);
    const canvas = document.createElement("canvas");
    canvas.width = size.width;
    canvas.height = size.height;
    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("canvas");
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, size.width, size.height);
    context.drawImage(
      image,
      0,
      0,
      size.sourceWidth,
      size.sourceHeight,
      0,
      0,
      size.width,
      size.height,
    );
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function collectCssText(): string {
  const parts: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        parts.push(rule.cssText);
      }
    } catch {
      /* skip unreadable sheets */
    }
  }
  return parts.join("\n");
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("preview raster failed"));
    image.src = url;
  });
}
