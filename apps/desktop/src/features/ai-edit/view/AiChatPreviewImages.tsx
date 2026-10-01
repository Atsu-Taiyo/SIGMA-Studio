"use client";
import {
  buildSelectedShapesAttachmentName,
  parseSelectedShapesAttachmentCount,
} from "@/lib/ai/ai-edit-attachment-names";
import { type AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";
import { type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import type { DesktopAiEditChatAttachmentSummary } from "@/types/desktop";

export function ComposerOverlaySelectionPreview({
  preview,
  shapeCount,
}: {
  preview: AiEditShapeOnlyPreview;
  shapeCount: number;
}) {
  const t = useT("ai");
  const label = buildSelectedShapesAttachmentName(shapeCount);
  const frameSize = resolveComposerOverlayPreviewFrameSize(preview);
  return (
    <figure
      className="ai-chat-attachment-preview ai-chat-overlay-preview"
      title={label}
      style={{ width: frameSize.width, minWidth: 0, maxWidth: "100%" }}
    >
      <div
        className="ai-chat-attachment-thumb ai-chat-overlay-preview-stage"
        role="img"
        aria-label={label}
        style={{ height: frameSize.height, aspectRatio: "auto" }}
        dangerouslySetInnerHTML={{ __html: preview.svg }}
      />
      <figcaption className="ai-chat-attachment-name ai-chat-shape-label-chip">
        {getOverlayShapeCaption(shapeCount, t)}
      </figcaption>
    </figure>
  );
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
      <div
        className="ai-chat-user-attachment-image ai-chat-user-attachment-image--svg"
        role="img"
        aria-label={t("attachment.imageNamed", { replace: { name: label } })}
        dangerouslySetInnerHTML={{ __html: preview.svg }}
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

  return (
    <figure
      className={`ai-chat-user-attachment${isOverlayPreview ? " ai-chat-user-attachment--overlay" : ""}`}
      title={title}
    >
      <span
        className="ai-chat-user-attachment-image"
        role="img"
        aria-label={t("attachment.imageNamed", { replace: { name: attachment.name } })}
        style={{ backgroundImage: `url("${attachment.dataUrl ?? ""}")` }}
      />
      <figcaption className={isOverlayPreview ? "ai-chat-shape-label-chip" : undefined}>{caption}</figcaption>
    </figure>
  );
}

function getOverlayShapeCaption(shapeCount: number, t: Translate<"ai">): string {
  const safeShapeCount = Math.max(1, Math.trunc(shapeCount));
  return safeShapeCount === 1
    ? t("attachment.shapeOne")
    : t("attachment.shapeRange", { replace: { last: safeShapeCount } });
}

