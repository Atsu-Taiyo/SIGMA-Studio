/**
 * 添付画像の注記を、AIへ送る画像そのものへ描き込む (renderer 専用。canvas を使う)。
 *
 * 文章の座標だけでは、モデルは画像の中の場所を取り違えやすい。入力欄・履歴で見せている
 * 番号付きの印と同じものを画素として描き込み、プロンプトの対応表 (`formatAiImageAnnotationsForPrompt`)
 * と番号で結ぶ。会話履歴には元の画像と注記をそのまま残し、描き込みはIPCへ渡す直前の1回だけにする
 * (再送しても印が二重にならない)。
 */
import {
  AI_IMAGE_ANNOTATION_COLOR,
  getAiImageAnnotationMarkLayout,
  hasAiImageAnnotations,
  normalizeAiImageAnnotations,
  type AiImageAnnotation,
} from "./ai-image-annotations";
import type { AiEditAttachment } from "./sigma-doc-agent-tools";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const tPrompt = createCurrentLocaleTranslator("prompt");

/**
 * 1回の依頼でモデルへ渡る画像の上限 (Electron main の MAX_CODEX_IMAGE_ATTACHMENTS /
 * MAX_CLAUDE_IMAGE_ATTACHMENTS / MAX_GEMINI_FILE_ATTACHMENTS と同じ)。印なしの元画像は、
 * この枠に空きがあるときだけ添える (利用者が付けた画像を押し出さない)。
 */
const MAX_AI_IMAGE_INPUTS = 4;

const REGION_FILL = "rgba(37, 99, 235, 0.10)";
const HALO_COLOR = "#ffffff";

/** 画像の長辺に対する番号の丸の大きさ。小さな画像でも読める下限と、大きな画像で邪魔にならない上限を持つ。 */
export function resolveAiImageAnnotationBadgeRadius(size: { width: number; height: number }): number {
  const longestSide = Math.max(size.width, size.height);
  return Math.min(36, Math.max(10, Math.round(longestSide * 0.017)));
}

/** 注記の印を描く。入力欄・履歴のDOMの印と同じ配置 (`getAiImageAnnotationMarkLayout`) を使う。 */
export function paintAiImageAnnotations(
  context: CanvasRenderingContext2D,
  annotations: readonly AiImageAnnotation[],
  size: { width: number; height: number },
): void {
  const radius = resolveAiImageAnnotationBadgeRadius(size);
  const lineWidth = Math.max(2, Math.round(radius * 0.18));
  const haloWidth = Math.max(1, Math.round(lineWidth * 0.75));
  annotations.forEach((annotation, index) => {
    const layout = getAiImageAnnotationMarkLayout(annotation, size, radius);
    context.save();
    if (layout.rect) {
      const { x, y, width, height } = layout.rect;
      context.fillStyle = REGION_FILL;
      context.fillRect(x, y, width, height);
      context.lineJoin = "round";
      context.strokeStyle = HALO_COLOR;
      context.lineWidth = lineWidth + haloWidth * 2;
      context.strokeRect(x, y, width, height);
      context.strokeStyle = AI_IMAGE_ANNOTATION_COLOR;
      context.lineWidth = lineWidth;
      context.strokeRect(x, y, width, height);
    }
    if (layout.point) {
      // 中を塗らない輪。白い縁取りの上に青を重ね、どんな地の色でも見えるようにする。
      context.beginPath();
      context.arc(layout.point.x, layout.point.y, layout.ringRadius, 0, Math.PI * 2);
      context.strokeStyle = HALO_COLOR;
      context.lineWidth = lineWidth + haloWidth * 2;
      context.stroke();
      context.strokeStyle = AI_IMAGE_ANNOTATION_COLOR;
      context.lineWidth = lineWidth;
      context.stroke();
    }
    const { badgeCenter, badgeRadius } = layout;
    context.beginPath();
    context.arc(badgeCenter.x, badgeCenter.y, badgeRadius + haloWidth, 0, Math.PI * 2);
    context.fillStyle = HALO_COLOR;
    context.fill();
    context.beginPath();
    context.arc(badgeCenter.x, badgeCenter.y, badgeRadius, 0, Math.PI * 2);
    context.fillStyle = AI_IMAGE_ANNOTATION_COLOR;
    context.fill();
    context.fillStyle = HALO_COLOR;
    context.font = `700 ${Math.round(badgeRadius * (index + 1 >= 10 ? 0.95 : 1.15))}px ui-sans-serif, system-ui, -apple-system, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(index + 1), badgeCenter.x, badgeCenter.y + badgeRadius * 0.06);
    context.restore();
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("annotated image could not be loaded"));
    image.src = src;
  });
}

function estimateDataUrlSize(dataUrl: string): number {
  const commaIndex = dataUrl.indexOf(",");
  return Math.floor((commaIndex >= 0 ? dataUrl.length - commaIndex - 1 : dataUrl.length) * 0.75);
}

async function drawAnnotatedImage(
  attachment: AiEditAttachment,
  annotations: readonly AiImageAnnotation[],
): Promise<Pick<AiEditAttachment, "dataUrl" | "mimeType" | "width" | "height" | "fileSize">> {
  const image = await loadImage(attachment.dataUrl);
  const width = image.naturalWidth || attachment.width || 1024;
  const height = image.naturalHeight || attachment.height || 1024;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("canvas is not available");
  }
  // JPEGで書き出すときに透過部分が黒くならないよう、白地を敷く。
  const mimeType = attachment.mimeType === "image/jpeg" ? "image/jpeg" : "image/png";
  if (mimeType === "image/jpeg") {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
  }
  context.drawImage(image, 0, 0, width, height);
  paintAiImageAnnotations(context, annotations, { width, height });
  const dataUrl = canvas.toDataURL(mimeType, 0.92);
  return { dataUrl, mimeType, width, height, fileSize: estimateDataUrlSize(dataUrl) };
}

/** 印なしの元画像の名前。拡張子の前に目印を付け、どの画像の元かが名前で分かるようにする。 */
function originalImageName(name: string): string {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return tPrompt("turn.imageAnnotations.originalName", { replace: { base, extension } });
}

interface RenderedAttachment {
  attachment: AiEditAttachment;
  /** 印を描き込めたときの、印なしの元画像。 */
  original: AiEditAttachment | null;
}

async function renderOne(attachment: AiEditAttachment): Promise<RenderedAttachment> {
  if (!hasAiImageAnnotations(attachment)) {
    return { attachment, original: null };
  }
  const annotations = normalizeAiImageAnnotations(attachment.annotations);
  if (annotations.length === 0) {
    const rest = { ...attachment };
    delete rest.annotations;
    return { attachment: rest, original: null };
  }
  if (!attachment.dataUrl.startsWith("data:image/")) {
    return { attachment: { ...attachment, annotations }, original: null };
  }
  try {
    const drawn = await drawAnnotatedImage(attachment, annotations);
    return {
      attachment: { ...attachment, ...drawn, annotations },
      original: {
        id: `${attachment.id}_unmarked`,
        name: originalImageName(attachment.name),
        mimeType: attachment.mimeType,
        dataUrl: attachment.dataUrl,
        ...(attachment.width ? { width: attachment.width } : {}),
        ...(attachment.height ? { height: attachment.height } : {}),
        ...(attachment.fileSize ? { fileSize: attachment.fileSize } : {}),
      },
    };
  } catch {
    return { attachment: { ...attachment, annotations }, original: null };
  }
}

/**
 * IPCへ渡す直前に、注記つきの画像だけを印入りの画像へ差し替える。注記は文章で渡すために残す。
 * 番号の丸が細かな文字に重なることがあるので、画像の枠に空きがあれば、印なしの元画像を
 * 直後に添える。描けなかった画像は元のまま送る (文章の対応表だけでも場所は伝わる)。
 */
export async function renderAnnotatedAttachmentsForAi(
  attachments: readonly AiEditAttachment[],
): Promise<AiEditAttachment[]> {
  const rendered = await Promise.all(attachments.map(renderOne));
  let spareImageSlots = MAX_AI_IMAGE_INPUTS - attachments.length;
  return rendered.flatMap(({ attachment, original }) => {
    if (original && spareImageSlots > 0) {
      spareImageSlots -= 1;
      return [attachment, original];
    }
    return [attachment];
  });
}
