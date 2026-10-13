"use client";
import type { HTMLAttributes } from "react";
import {
  buildSelectedShapesAttachmentName,
  parseSelectedShapesAttachmentCount,
} from "@/lib/ai/ai-edit-attachment-names";
import { type AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";
import { type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import type { AiImageAnnotation } from "@/lib/ai/ai-image-annotations";
import type { DesktopAiEditChatAttachmentSummary } from "@/types/desktop";
import { AI_CHAT_IMAGE_FRAME_ASPECT_RATIO, AttachmentAnnotateButton } from "./AiChatComposerParts";
import { AiImageAnnotationMarks, AiImageAnnotationOverlay, useImageNaturalSize } from "./AiImageAnnotationMarks";

/**
 * 図形プレビューのSVGを文書へ描く、このファイルで唯一の出口。`preview.svg` を作るのは
 * `ai-edit-shape-preview.ts` のヘルパ (中身は `exportOverlaySvg` の戻り値) だけ。
 * 入力欄のチップ・履歴・「画像にコメント」の画面がここを通す (グラフや文字は紙面のCSSで描くので、
 * `<img>` ではなく文書の中に描く)。
 */
export function OverlayPreviewSvg({
  preview,
  ...props
}: { preview: AiEditShapeOnlyPreview } & Omit<HTMLAttributes<HTMLDivElement>, "children" | "dangerouslySetInnerHTML" | "role">) {
  return <div role="img" {...props} dangerouslySetInnerHTML={{ __html: preview.svg }} />;
}

export function ComposerOverlaySelectionPreview({
  preview,
  shapeCount,
  annotations = [],
  onAnnotate,
}: {
  preview: AiEditShapeOnlyPreview;
  shapeCount: number;
  /** 図形プレビューの中に付けたコメント。送信時に同じSVGから作るPNGへ描き込む。 */
  annotations?: readonly AiImageAnnotation[];
  onAnnotate?: () => void;
}) {
  const t = useT("ai");
  const label = buildSelectedShapesAttachmentName(shapeCount);
  const frameSize = resolveComposerOverlayPreviewFrameSize(preview);
  const svgBox = resolveComposerOverlayPreviewSvgBox(preview, frameSize);
  return (
    <figure
      className="ai-chat-attachment-preview ai-chat-overlay-preview"
      title={label}
      style={{ width: frameSize.width, minWidth: 0, maxWidth: "100%" }}
    >
      <OverlayPreviewSvg
        preview={preview}
        className="ai-chat-attachment-thumb ai-chat-overlay-preview-stage"
        aria-label={label}
        data-annotatable={onAnnotate ? "true" : undefined}
        style={{ height: frameSize.height, aspectRatio: "auto" }}
        onClick={onAnnotate}
      />
      {annotations.length > 0 ? (
        // SVGは枠の左に寄せ、縦は中央に置かれる (.ai-chat-overlay-preview-stage)。印はその実際の箱に重ねる。
        <span
          className="ai-chat-overlay-preview-marks"
          style={{ left: svgBox.left, top: svgBox.top, width: svgBox.width, height: svgBox.height }}
        >
          <AiImageAnnotationMarks annotations={annotations} badgeRadius={7} />
        </span>
      ) : null}
      <figcaption className="ai-chat-attachment-name ai-chat-shape-label-chip">
        {getOverlayShapeCaption(shapeCount, t)}
      </figcaption>
      {onAnnotate ? (
        <AttachmentAnnotateButton name={label} count={annotations.length} onClick={onAnnotate} />
      ) : null}
    </figure>
  );
}

/** 枠の中でSVGが実際に描かれる箱。縮小はするが拡大はしない (width/height: auto + max-*)。 */
function resolveComposerOverlayPreviewSvgBox(
  preview: AiEditShapeOnlyPreview,
  frameSize: { width: number; height: number },
): { left: number; top: number; width: number; height: number } {
  const safeWidth = Math.max(1, preview.width);
  const safeHeight = Math.max(1, preview.height);
  const scale = Math.min(1, frameSize.width / safeWidth, frameSize.height / safeHeight);
  const width = safeWidth * scale;
  const height = safeHeight * scale;
  return { left: 0, top: (frameSize.height - height) / 2, width, height };
}

function resolveComposerOverlayPreviewFrameSize(preview: AiEditShapeOnlyPreview): {
  width: number;
  height: number;
} {
  const maxWidth = 112;
  const maxHeight = 94;
  const safeWidth = Math.max(1, preview.width);
  const safeHeight = Math.max(1, preview.height);
  const scale = Math.min(maxWidth / safeWidth, maxHeight / safeHeight);
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale)),
  };
}

export function UserOverlaySelectionImage({
  preview,
  shapeCount,
}: {
  preview: AiEditShapeOnlyPreview;
  shapeCount: number;
}) {
  const t = useT("ai");
  const label = buildSelectedShapesAttachmentName(shapeCount);
  return (
    <figure className="ai-chat-user-attachment ai-chat-user-attachment--overlay" title={label}>
      <OverlayPreviewSvg
        preview={preview}
        className="ai-chat-user-attachment-image ai-chat-user-attachment-image--svg"
        aria-label={t("attachment.imageNamed", { replace: { name: label } })}
      />
      <figcaption className="ai-chat-shape-label-chip">{getOverlayShapeCaption(shapeCount, t)}</figcaption>
    </figure>
  );
}

export function UserAttachmentImage({ attachment }: { attachment: DesktopAiEditChatAttachmentSummary }) {
  const t = useT("ai");
  const dimensions = attachment.width && attachment.height
    ? `${attachment.width} x ${attachment.height}`
    : null;
  const title = [attachment.name, dimensions].filter(Boolean).join(" · ");
  const selectedShapeCount = parseSelectedShapesAttachmentCount(attachment.name);
  const caption = selectedShapeCount !== null
    ? getOverlayShapeCaption(selectedShapeCount, t)
    : attachment.name;
  const isOverlayPreview = selectedShapeCount !== null;
  const annotations = attachment.annotations ?? [];
  const naturalSize = useImageNaturalSize(
    annotations.length > 0 ? attachment.dataUrl : null,
    attachment.width,
    attachment.height,
  );

  const figure = (
    <figure
      className={`ai-chat-user-attachment${isOverlayPreview ? " ai-chat-user-attachment--overlay" : ""}`}
      title={title}
    >
      <span
        className="ai-chat-user-attachment-image"
        role="img"
        aria-label={t("attachment.imageNamed", { replace: { name: attachment.name } })}
        style={{ backgroundImage: `url("${attachment.dataUrl ?? ""}")` }}
      >
        <AiImageAnnotationOverlay
          annotations={annotations}
          naturalSize={naturalSize}
          containerAspectRatio={AI_CHAT_IMAGE_FRAME_ASPECT_RATIO}
          badgeRadius={8}
        />
      </span>
      <figcaption className={isOverlayPreview ? "ai-chat-shape-label-chip" : undefined}>{caption}</figcaption>
    </figure>
  );
  if (annotations.length === 0) {
    return figure;
  }
  // 画像に重ねた番号と同じ番号でコメントを並べる (送った内容を後から読み返せるように)。
  return (
    <div className="ai-chat-user-attachment-annotated">
      {figure}
      <ol
        className="ai-chat-user-annotations"
        aria-label={t("attachment.annotationCount", { replace: { count: annotations.length } })}
      >
        {annotations.map((annotation, index) => (
          <li key={annotation.id}>
            <span className="ai-chat-user-annotation-badge" aria-hidden="true">{index + 1}</span>
            <span className="ai-chat-user-annotation-text">{annotation.comment}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function getOverlayShapeCaption(shapeCount: number, t: Translate<"ai">): string {
  const safeShapeCount = Math.max(1, Math.trunc(shapeCount));
  return safeShapeCount === 1
    ? t("attachment.shapeOne")
    : t("attachment.shapeRange", { replace: { last: safeShapeCount } });
}

