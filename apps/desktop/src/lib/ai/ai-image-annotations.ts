/**
 * AIチャットの添付画像に付ける注記 (画像の中の場所を指したコメント)。
 *
 * 座標は画像に対する割合 (左上 0、右下 1) で持つ。表示の大きさ・縮小・PNG化の解像度が
 * 変わっても同じ場所を指せるようにするため。点は `x`/`y`、範囲は左上 `x`/`y` と
 * `width`/`height` を持つ。印の描画 (入力欄・履歴・AIへ送る合成画像) は
 * `getAiImageAnnotationMarkLayout` の一つの幾何を共有する。
 *
 * React・DOM・AIの実行に依存しない。renderer・Electron main・MCPサーバーが同じ正規化と
 * プロンプト整形を使う。
 */
import type { Translate } from "@/lib/i18n";

export interface AiImageAnnotation {
  id: string;
  /** 点の位置、または範囲の左上。画像に対する割合 (0〜1)。 */
  x: number;
  y: number;
  /** 範囲のときだけ持つ。画像に対する割合 (0〜1)。 */
  width?: number;
  height?: number;
  comment: string;
}

export type AiImageAnnotationRegion = AiImageAnnotation & { width: number; height: number };

/** 1枚あたりの上限。プロンプトと画像が印で埋まらない数にする。 */
export const MAX_AI_IMAGE_ANNOTATIONS = 12;
export const MAX_AI_IMAGE_ANNOTATION_COMMENT_LENGTH = 500;
/** これより小さいドラッグは範囲ではなく点として扱う (画像に対する割合)。 */
export const MIN_AI_IMAGE_ANNOTATION_REGION_SIZE = 0.012;

/**
 * 印の色。アプリの選択色 (`--editor-selection-background` の元の青) と揃える。
 * 白黒の教材の線と見分けられるよう、印だけは色を持たせる。
 */
export const AI_IMAGE_ANNOTATION_COLOR = "#2563eb";

export function isAiImageAnnotationRegion(annotation: AiImageAnnotation): annotation is AiImageAnnotationRegion {
  return typeof annotation.width === "number"
    && typeof annotation.height === "number"
    && annotation.width > 0
    && annotation.height > 0;
}

export function hasAiImageAnnotations(
  value: { annotations?: readonly AiImageAnnotation[] | null } | null | undefined,
): boolean {
  return Boolean(value?.annotations && value.annotations.length > 0);
}

export function createAiImageAnnotationId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `note_${crypto.randomUUID()}`;
  }
  return `note_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function clampUnit(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * 保存・IPC・プロンプトの入口で使う正規化。座標を画像の内側へ収め、空のコメントと
 * 壊れた項目を落とし、件数と文字数を上限に揃える。履歴の古い形式や手で壊れたJSONでも
 * 例外を出さない。
 */
export function normalizeAiImageAnnotations(value: unknown): AiImageAnnotation[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const normalized: AiImageAnnotation[] = [];
  const seenIds = new Set<string>();
  for (const item of value) {
    if (normalized.length >= MAX_AI_IMAGE_ANNOTATIONS) {
      break;
    }
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const rawX = finiteNumber(record.x);
    const rawY = finiteNumber(record.y);
    const comment = typeof record.comment === "string"
      ? record.comment.trim().slice(0, MAX_AI_IMAGE_ANNOTATION_COMMENT_LENGTH)
      : "";
    if (rawX === null || rawY === null || comment.length === 0) {
      continue;
    }
    const rawId = typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
    const id = rawId && !seenIds.has(rawId) ? rawId : `note_${normalized.length + 1}`;
    seenIds.add(id);
    const x = clampUnit(rawX);
    const y = clampUnit(rawY);
    const rawWidth = finiteNumber(record.width);
    const rawHeight = finiteNumber(record.height);
    const width = rawWidth === null ? 0 : Math.min(clampUnit(rawWidth), 1 - x);
    const height = rawHeight === null ? 0 : Math.min(clampUnit(rawHeight), 1 - y);
    normalized.push(
      width >= MIN_AI_IMAGE_ANNOTATION_REGION_SIZE && height >= MIN_AI_IMAGE_ANNOTATION_REGION_SIZE
        ? { id, x, y, width, height, comment }
        : { id, x, y, comment },
    );
  }
  return normalized;
}

/**
 * ドラッグの始点と終点から注記の形を決める。どちら向きにドラッグしても左上基準の範囲にし、
 * 小さすぎる範囲は始点の点にする。
 */
export function createAiImageAnnotationShape(
  start: { x: number; y: number },
  end: { x: number; y: number },
): Pick<AiImageAnnotation, "x" | "y" | "width" | "height"> {
  const startX = clampUnit(start.x);
  const startY = clampUnit(start.y);
  const endX = clampUnit(end.x);
  const endY = clampUnit(end.y);
  const width = Math.abs(endX - startX);
  const height = Math.abs(endY - startY);
  if (width < MIN_AI_IMAGE_ANNOTATION_REGION_SIZE || height < MIN_AI_IMAGE_ANNOTATION_REGION_SIZE) {
    return { x: startX, y: startY };
  }
  return { x: Math.min(startX, endX), y: Math.min(startY, endY), width, height };
}

export interface AiImageAnnotationMarkLayout {
  /** 番号の丸の中心 (画像の座標系、px)。 */
  badgeCenter: { x: number; y: number };
  badgeRadius: number;
  /** 点のときの指し先 (px)。範囲のときは null。 */
  point: { x: number; y: number } | null;
  /** 点を囲む輪の半径 (px)。中は塗らず、指した所そのものは見えるままにする。範囲のときは 0。 */
  ringRadius: number;
  /** 範囲のときの矩形 (px)。点のときは null。 */
  rect: { x: number; y: number; width: number; height: number } | null;
}

/** 点を囲む輪の半径 (番号の丸の半径に対する倍率)。 */
const POINT_RING_SCALE = 0.8;

/**
 * 印の配置。点は中を塗らない輪で囲み、番号の丸を輪の右上に添える。範囲は枠で囲み、番号を
 * 左上の角の外へ置く。どちらも指した場所そのものは隠さない。画像の外へはみ出す分だけ内側へ戻す。
 * 入力欄・ダイアログ・履歴・合成画像が同じ配置を使う。
 */
export function getAiImageAnnotationMarkLayout(
  annotation: AiImageAnnotation,
  size: { width: number; height: number },
  badgeRadius: number,
): AiImageAnnotationMarkLayout {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  const radius = Math.max(1, Math.min(badgeRadius, width / 2, height / 2));
  const clampCenter = (center: { x: number; y: number }) => ({
    x: Math.min(width - radius, Math.max(radius, center.x)),
    y: Math.min(height - radius, Math.max(radius, center.y)),
  });
  if (isAiImageAnnotationRegion(annotation)) {
    const rect = {
      x: annotation.x * width,
      y: annotation.y * height,
      width: annotation.width * width,
      height: annotation.height * height,
    };
    return {
      badgeCenter: clampCenter({ x: rect.x + radius * 0.35, y: rect.y - radius * 0.95 }),
      badgeRadius: radius,
      point: null,
      ringRadius: 0,
      rect,
    };
  }
  const point = { x: annotation.x * width, y: annotation.y * height };
  const ringRadius = radius * POINT_RING_SCALE;
  // 輪の右上 (45°) に、丸の縁が輪に少し重なる距離で添える。
  const offset = (ringRadius + radius * 0.85) * Math.SQRT1_2;
  return {
    badgeCenter: clampCenter({ x: point.x + offset, y: point.y - offset }),
    badgeRadius: radius,
    point,
    ringRadius,
    rect: null,
  };
}

function toPercent(value: number): number {
  return Math.round(clampUnit(value) * 100);
}

export interface AiImageAnnotationPromptAttachment {
  name: string;
  annotations?: readonly AiImageAnnotation[] | null;
}

/**
 * 添付画像への注記をプロンプトの1節にする。注記が無ければ空文字。
 * 画像には同じ番号の印を描き込んで送るので、文章は番号・形・位置・コメントの対応表になる。
 */
export function formatAiImageAnnotationsForPrompt(
  attachments: readonly AiImageAnnotationPromptAttachment[] | undefined,
  t: Translate<"prompt">,
): string {
  if (!attachments || attachments.length === 0) {
    return "";
  }
  const imageSections = attachments.flatMap((attachment) => {
    const annotations = normalizeAiImageAnnotations(attachment.annotations);
    if (annotations.length === 0) {
      return [];
    }
    return [[
      t("turn.imageAnnotations.image", { replace: { name: attachment.name } }),
      ...annotations.map((annotation, index) => {
        const comment = annotation.comment.replace(/\s*\n\s*/g, " / ");
        if (isAiImageAnnotationRegion(annotation)) {
          return t("turn.imageAnnotations.region", { replace: {
            index: index + 1,
            left: toPercent(annotation.x),
            right: toPercent(annotation.x + annotation.width),
            top: toPercent(annotation.y),
            bottom: toPercent(annotation.y + annotation.height),
            comment,
          } });
        }
        return t("turn.imageAnnotations.point", { replace: {
          index: index + 1,
          x: toPercent(annotation.x),
          y: toPercent(annotation.y),
          comment,
        } });
      }),
    ].join("\n")];
  });
  if (imageSections.length === 0) {
    return "";
  }
  return [t("turn.imageAnnotations.intro"), ...imageSections].join("\n");
}
