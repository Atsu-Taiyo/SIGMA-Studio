import { drawCroppedImageToCanvas } from "@/components/editor/overlay-canvas/image-crop";
import type { OverlayAsset, OverlayShape } from "@/components/editor/overlay-canvas/types";
import type { OverlaySelectionSummary } from "@/components/editor/page-overlay-types";
import { buildSelectedShapesAttachmentName } from "@/lib/ai/ai-edit-attachment-names";
import { type AiEditOverlaySelectionContext } from "@/lib/ai/ai-edit-reference";
import { buildShapesSvgPreview, type AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";
import type { AiEditAttachment } from "@/lib/ai/sigma-doc-agent-tools";
import { tAiNow } from "./ai-chat-translator";
export const MAX_AI_EDIT_ATTACHMENTS = 4;
export interface OverlayReferencePreview {
  referenceKey: string;
  preview: AiEditShapeOnlyPreview;
  shapeCount: number;
}

const OVERLAY_SELECTION_THUMBNAIL_MAX_DIMENSION_PX = 1024;
const OVERLAY_SELECTION_THUMBNAIL_PIXEL_RATIO = 2;

export async function createAttachmentsWithSelectedOverlayPreview({
  attachments,
  overlayPreviews,
  overlaySelection,
  activeReferenceKey,
}: {
  attachments: AiEditAttachment[];
  overlayPreviews: OverlayReferencePreview[];
  overlaySelection: OverlaySelectionSummary;
  activeReferenceKey: string | null;
}): Promise<AiEditAttachment[]> {
  const requestedPreviews = overlayPreviews.slice(0, MAX_AI_EDIT_ATTACHMENTS);
  const generatedPreviews: AiEditAttachment[] = [];
  for (const overlayPreview of requestedPreviews) {
    const attachment = await createAttachmentFromOverlayPreview(overlayPreview);
    if (attachment) {
      generatedPreviews.push(attachment);
    }
  }

  // SVGからPNGへの変換ができない古い/特殊な画像素材でも、従来どおりinline画像単体は
  // AIへ渡せるように残す。通常は上の複合プレビューが選択図形全体を表す。
  const activePreviewWasGenerated = activeReferenceKey !== null
    && generatedPreviews.some((attachment) => attachment.sourceReferenceKey === activeReferenceKey);
  // preview生成に失敗した予約枠はまずmanual添付へ返す。ユーザーが明示添付した画像を
  // rasterize失敗だけで静かに落とさず、残り枠があれば従来の選択画像fallbackを足す。
  const manualAttachments = attachments.slice(
    0,
    Math.max(0, MAX_AI_EDIT_ATTACHMENTS - generatedPreviews.length),
  );
  const selectedImageAttachments: AiEditAttachment[] = [];
  if (activeReferenceKey && !activePreviewWasGenerated) {
    const remainingOverlaySlots = MAX_AI_EDIT_ATTACHMENTS
      - generatedPreviews.length
      - manualAttachments.length;
    const imageShapes = overlaySelection.selectedShapes
      .filter((shape): shape is Extract<OverlayShape, { type: "image" }> => shape.type === "image")
      .slice(0, remainingOverlaySlots);
    for (const shape of imageShapes) {
      const asset = overlaySelection.selectedAssets[shape.props.assetId];
      if (!asset || !asset.props.src.startsWith("data:image/")) {
        continue;
      }
      const attachment = await createAttachmentFromSelectedImageShape(shape, asset, activeReferenceKey);
      if (attachment) {
        selectedImageAttachments.push(attachment);
      }
    }
  }

  return [...manualAttachments, ...generatedPreviews, ...selectedImageAttachments]
    .slice(0, MAX_AI_EDIT_ATTACHMENTS);
}

export function buildSelectedOverlayShapePreview(overlaySelection: OverlaySelectionSummary) {
  if (overlaySelection.selectedShapes.length === 0) {
    return null;
  }
  return buildShapesSvgPreview(overlaySelection.selectedShapes, overlaySelection.selectedAssets, {
    paddingPx: 10,
    minWidthPx: 48,
    minHeightPx: 48,
  });
}

export function buildStoredOverlaySelectionPreview(selection: AiEditOverlaySelectionContext) {
  // Historical turns created before selected-shape PNG attachments were added
  // still retain their native shape JSON. Re-render those native shapes so the
  // chat remains visually understandable. Image-shape pixels are intentionally
  // excluded because the persisted reference stores asset metadata, not src.
  const nativeShapes = selection.shapes.filter((shape) => shape.type !== "image");
  return buildShapesSvgPreview(nativeShapes, {}, {
    paddingPx: 10,
    minWidthPx: 48,
    minHeightPx: 48,
  });
}

async function createAttachmentFromOverlayPreview(
  overlayPreview: OverlayReferencePreview,
): Promise<AiEditAttachment | null> {
  const { preview, referenceKey, shapeCount } = overlayPreview;
  try {
    const longestSide = Math.max(preview.width, preview.height);
    const scale = Math.min(
      OVERLAY_SELECTION_THUMBNAIL_PIXEL_RATIO,
      OVERLAY_SELECTION_THUMBNAIL_MAX_DIMENSION_PX / Math.max(1, longestSide),
    );
    const width = Math.max(1, Math.round(preview.width * scale));
    const height = Math.max(1, Math.round(preview.height * scale));
    const image = await loadImageElement(toSvgDataUrl(preview.svg));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) {
      return null;
    }
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);

    const dataUrl = canvas.toDataURL("image/png");
    const logicalSelectionCount = Math.max(1, shapeCount);
    return {
      id: createAttachmentId(),
      name: `${buildSelectedShapesAttachmentName(logicalSelectionCount)}.png`,
      mimeType: "image/png",
      dataUrl,
      width,
      height,
      fileSize: estimateDataUrlSize(dataUrl),
      sourceReferenceKey: referenceKey,
    };
  } catch {
    return null;
  }
}

function toSvgDataUrl(svg: string): string {
  // data URLを使うと、foreignObjectを含むSVGをblob URL経由で描画した際にChromiumが
  // canvasをtaint扱いする問題を避けられる。最終的な会話履歴にはPNGだけを保存する。
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function hasSelectedOverlayImageAttachments(overlaySelection: OverlaySelectionSummary): boolean {
  return overlaySelection.selectedShapes.some((shape) => {
    if (shape.type !== "image") {
      return false;
    }
    const asset = overlaySelection.selectedAssets[shape.props.assetId];
    return Boolean(asset?.props.src.startsWith("data:image/"));
  });
}

async function createAttachmentFromSelectedImageShape(
  shape: Extract<OverlayShape, { type: "image" }>,
  asset: OverlayAsset,
  sourceReferenceKey?: string,
): Promise<AiEditAttachment | null> {
  try {
    const image = await loadImageElement(asset.props.src);
    const canvas = document.createElement("canvas");
    drawCroppedImageToCanvas(canvas, image, shape, asset);
    const dataUrl = canvas.toDataURL("image/png");
    return {
      id: createAttachmentId(),
      name: `${tAiNow("attachment.selectedImagePrefix")}${asset.props.name || shape.id}.png`,
      mimeType: "image/png",
      dataUrl,
      width: canvas.width,
      height: canvas.height,
      fileSize: estimateDataUrlSize(dataUrl),
      ...(sourceReferenceKey ? { sourceReferenceKey } : {}),
    };
  } catch {
    return null;
  }
}

function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(tAiNow("panel.imageLoadFailed")));
    image.src = src;
  });
}

function estimateDataUrlSize(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  return Math.floor(base64.length * 0.75);
}

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

export function isImageAttachment(
  attachment: { mimeType?: string | null; dataUrl?: string | null },
): boolean {
  return Boolean(
    attachment.mimeType?.startsWith("image/")
    || attachment.dataUrl?.startsWith("data:image/"),
  );
}

export function getClipboardImageFiles(clipboardData: DataTransfer): File[] {
  const itemFiles = Array.from(clipboardData.items)
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (itemFiles.length > 0) {
    return itemFiles;
  }

  return Array.from(clipboardData.files).filter(isImageFile);
}

export function createAttachmentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `media_${crypto.randomUUID()}`;
  }

  return `media_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function createAttachmentName(file: File, source: "file" | "paste"): string {
  const fileName = file.name.trim();
  if (source === "file" && fileName) {
    return fileName;
  }

  if (source === "paste" && fileName && !isGenericClipboardImageName(fileName)) {
    return fileName;
  }

  return `image_${createRandomHex(6)}.${getImageExtension(file.type)}`;
}

export async function createAiEditAttachmentFromFile(
  file: File,
  source: "file" | "paste",
  signal?: AbortSignal,
): Promise<AiEditAttachment> {
  const rawDataUrl = await readFileAsDataUrl(file, signal);
  const detectedMimeType = file.type || getDataUrlMimeType(rawDataUrl) || "application/octet-stream";
  // Some OS file pickers omit the MIME type for PDFs. Keep every provider's
  // data-URL parser on the same PDF path in that case.
  const mimeType = detectedMimeType === "application/octet-stream" && /\.pdf$/i.test(file.name)
    ? "application/pdf"
    : detectedMimeType;
  const dataUrl = mimeType !== detectedMimeType
    ? rawDataUrl.replace(/^data:[^;,]*/, `data:${mimeType}`)
    : rawDataUrl;
  const dimensions = isImageAttachment({ mimeType, dataUrl })
    ? await readImageDimensions(dataUrl, signal)
    : null;
  return {
    id: createAttachmentId(),
    name: createAttachmentName(file, source),
    mimeType,
    dataUrl,
    ...(dimensions?.width ? { width: dimensions.width } : {}),
    ...(dimensions?.height ? { height: dimensions.height } : {}),
    fileSize: file.size,
  };
}

function getDataUrlMimeType(dataUrl: string): string | null {
  const match = /^data:([^;,]+)/i.exec(dataUrl);
  return match?.[1] ?? null;
}

function isGenericClipboardImageName(fileName: string): boolean {
  return /^(image|screenshot|clipboard)(?:[-_\s]?\d+)?\.(png|jpe?g|webp|gif|svg)$/i.test(fileName);
}

function getImageExtension(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/svg+xml") return "svg";
  const match = /^image\/([a-z0-9.+-]+)$/i.exec(mimeType);
  return match?.[1]?.replace(/[^a-z0-9]/gi, "") || "png";
}

function createRandomHex(length: number): string {
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    const bytes = new Uint8Array(Math.ceil(length / 2));
    crypto.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, length);
  }

  return Math.random().toString(16).slice(2, 2 + length).padEnd(length, "0");
}

export function readFileAsDataUrl(file: File, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const reader = new FileReader();
    const cleanup = () => {
      reader.removeEventListener("load", onLoad);
      reader.removeEventListener("error", onError);
      reader.removeEventListener("abort", onAbort);
      signal?.removeEventListener("abort", onSignalAbort);
    };
    const onLoad = () => {
      cleanup();
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error(tAiNow("composer.fileReadFailed")));
      }
    };
    const onError = () => {
      cleanup();
      reject(reader.error ?? new Error(tAiNow("composer.fileReadFailed")));
    };
    const onAbort = () => {
      cleanup();
      reject(signal?.reason ?? new DOMException("File read aborted", "AbortError"));
    };
    const onSignalAbort = () => {
      reader.abort();
      onAbort();
    };
    reader.addEventListener("load", onLoad);
    reader.addEventListener("error", onError);
    reader.addEventListener("abort", onAbort);
    signal?.addEventListener("abort", onSignalAbort, { once: true });
    try {
      reader.readAsDataURL(file);
    } catch (error) {
      cleanup();
      reject(error);
    }
  });
}

export function readImageDimensions(src: string, signal?: AbortSignal): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const image = new Image();
    const cleanup = () => {
      image.onload = null;
      image.onerror = null;
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      cleanup();
      image.src = "";
      reject(signal?.reason);
    };
    image.onload = () => {
      cleanup();
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => {
      cleanup();
      resolve({ width: 0, height: 0 });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    image.src = src;
  });
}

// ゲート画面でもプロバイダを切り替えられるようにするトグル (片方が未接続でももう片方へ移れる)。
