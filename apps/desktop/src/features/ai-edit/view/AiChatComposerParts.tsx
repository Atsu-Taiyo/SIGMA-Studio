"use client";
import { AtSign, File as FileIcon, FileText, MessageSquarePlus, MessageSquareText, Sparkles, X } from "lucide-react";
import { Shimmer } from "@/components/ui/Shimmer";
import { resolveAiResourceDisplayMetadata } from "@/lib/ai/ai-resource-display";
import type { AiEditAttachment, AiEditMentionedDocumentContext } from "@/lib/ai/sigma-doc-agent-tools";
import { useT } from "@/lib/i18n/react";
import type { DesktopAiResourceManifestEntry, DesktopDocumentMetadata } from "@/types/desktop";
import { isImageAttachment } from "../application/ai-chat-attachments";
import { AiImageAnnotationOverlay, useImageNaturalSize } from "./AiImageAnnotationMarks";

/** 入力欄・履歴の画像の枠 (`.ai-chat-attachment-thumb` / `.ai-chat-user-attachment-image`) の 幅/高さ。 */
export const AI_CHAT_IMAGE_FRAME_ASPECT_RATIO = 1.18;

/**
 * 画像の左上に置く「画像にコメント」ボタン。コメントがあれば件数を見せる。
 * 右上の × と同じ大きさ・面で、画像を開かなくても付けられることが分かるようにする。
 */
export function AttachmentAnnotateButton({
  name,
  count,
  onClick,
}: {
  name: string;
  count: number;
  onClick: () => void;
}) {
  const t = useT("ai");
  const label = count > 0
    ? `${t("attachment.annotateNamed", { replace: { name } })} (${t("attachment.annotationCount", { replace: { count } })})`
    : t("attachment.annotateNamed", { replace: { name } });
  return (
    <button
      type="button"
      className="ai-chat-attachment-annotate"
      data-has-annotations={count > 0 ? "true" : undefined}
      title={count > 0 ? t("attachment.annotationCount", { replace: { count } }) : t("attachment.annotate")}
      aria-label={label}
      onClick={onClick}
    >
      {count > 0 ? <MessageSquareText size={12} aria-hidden="true" /> : <MessageSquarePlus size={13} aria-hidden="true" />}
      {count > 0 ? <span>{count}</span> : null}
    </button>
  );
}
export function MentionedDocumentChip({
  item,
  onRemove,
}: {
  item: AiEditMentionedDocumentContext;
  onRemove: () => void;
}) {
  const t = useT("ai");
  return (
    <span className="ai-chat-chip" data-reference-kind="sigma-doc" title={item.documentPath || item.title}>
      <FileText size={12} />
      <span className="ai-chat-chip-label">{item.title}</span>
      <button
        type="button"
        className="ai-chat-chip-remove"
        title={t("composer.removeMention")}
        aria-label={t("composer.removeMention")}
        onClick={onRemove}
      >
        <X size={12} />
      </button>
    </span>
  );
}

export function AiResourceChip({ item, onRemove }: { item: DesktopAiResourceManifestEntry; onRemove: () => void }) {
  const t = useT("ai");
  const display = resolveAiResourceDisplayMetadata(item, t);
  return (
    <span className="ai-chat-chip" data-reference-kind="ai-resource" title={display.description || display.title}>
      <Sparkles size={12} />
      <span className="ai-chat-chip-label">{display.title}</span>
      <span className="ai-chat-chip-meta">{t("composer.skills")}</span>
      <button
        type="button"
        className="ai-chat-chip-remove"
        title={t("composer.removeResource")}
        aria-label={t("composer.removeResource")}
        onClick={onRemove}
      >
        <X size={12} />
      </button>
    </span>
  );
}

export function SigmaDocMentionPopover({
  candidates,
  loading,
  activeIndex,
  onHover,
  onSelect,
}: {
  candidates: DesktopDocumentMetadata[];
  loading: boolean;
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (candidate: DesktopDocumentMetadata) => void;
}) {
  const t = useT("ai");
  return (
    <div className="ai-chat-mention-popover" role="listbox" aria-label={t("composer.mentionCandidates")}>
      <div className="ai-chat-mention-title">
        <AtSign size={12} />
        <span>SigmaDoc</span>
      </div>
      {loading && candidates.length === 0 ? (
        <div className="ai-chat-mention-empty">
          <Shimmer>{t("composer.searching")}</Shimmer>
        </div>
      ) : candidates.length === 0 ? (
        <div className="ai-chat-mention-empty">{t("composer.noCandidates")}</div>
      ) : (
        candidates.map((candidate, index) => (
          <button
            key={candidate.fileId}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            className="ai-chat-mention-option"
            onMouseEnter={() => onHover(index)}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelect(candidate);
            }}
          >
            <FileText size={15} />
            <span className="ai-chat-mention-main">
              <span className="ai-chat-mention-name">{candidate.title}</span>
              <span className="ai-chat-mention-path">{candidate.documentPath}</span>
            </span>
            <span className="ai-chat-mention-revision">rev.{candidate.revision}</span>
          </button>
        ))
      )}
    </div>
  );
}

export function AiResourceSlashPopover({
  candidates,
  activeIndex,
  onHover,
  onSelect,
}: {
  candidates: DesktopAiResourceManifestEntry[];
  activeIndex: number;
  onHover: (index: number) => void;
  onSelect: (candidate: DesktopAiResourceManifestEntry) => void;
}) {
  const t = useT("ai");
  return (
    <div className="ai-chat-mention-popover" role="listbox" aria-label={t("composer.resourceCandidates")}>
      <div className="ai-chat-mention-title">
        <Sparkles size={12} />
        <span>{t("composer.resources")}</span>
      </div>
      {candidates.map((candidate, index) => (
        <button
          key={candidate.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          className="ai-chat-mention-option"
          onMouseEnter={() => onHover(index)}
          onMouseDown={(event) => {
            event.preventDefault();
            onSelect(candidate);
          }}
        >
          <Sparkles size={15} />
          <span className="ai-chat-mention-main">
            <span className="ai-chat-mention-name">{resolveAiResourceDisplayMetadata(candidate, t).title}</span>
            <span className="ai-chat-mention-path">{resolveAiResourceDisplayMetadata(candidate, t).description}</span>
          </span>
          <span className="ai-chat-mention-revision">{t("composer.skills")}</span>
        </button>
      ))}
    </div>
  );
}

export function AttachmentPreview({
  attachment,
  onRemove,
  onAnnotate,
}: {
  attachment: AiEditAttachment;
  onRemove: () => void;
  /** 画像の中の場所にコメントを付ける画面を開く。画像でない添付には出さない。 */
  onAnnotate?: () => void;
}) {
  const t = useT("ai");
  const imageAttachment = isImageAttachment(attachment);
  const naturalSize = useImageNaturalSize(
    imageAttachment && attachment.annotations?.length ? attachment.dataUrl : null,
    attachment.width,
    attachment.height,
  );
  if (!imageAttachment) {
    return (
      <span className="ai-chat-chip ai-chat-file-chip" data-reference-kind="attachment" title={attachment.name}>
        <FileIcon size={12} />
        <span className="ai-chat-chip-label">{attachment.name}</span>
        <button
          type="button"
          className="ai-chat-chip-remove"
          title={t("attachment.remove")}
          aria-label={t("attachment.remove")}
          onClick={onRemove}
        >
          <X size={12} />
        </button>
      </span>
    );
  }

  const dimensions = attachment.width && attachment.height
    ? `${attachment.width} x ${attachment.height}`
    : null;
  const title = [attachment.name, dimensions].filter(Boolean).join(" · ");

  return (
    <div className="ai-chat-attachment-preview" title={title}>
      <span
        className="ai-chat-attachment-thumb"
        role="img"
        aria-label={t("attachment.imageNamed", { replace: { name: attachment.name } })}
        data-annotatable={onAnnotate ? "true" : undefined}
        style={{ backgroundImage: `url("${attachment.dataUrl}")` }}
        onClick={onAnnotate}
      >
        <AiImageAnnotationOverlay
          annotations={attachment.annotations ?? []}
          naturalSize={naturalSize}
          containerAspectRatio={AI_CHAT_IMAGE_FRAME_ASPECT_RATIO}
          badgeRadius={7}
        />
      </span>
      <span className="ai-chat-attachment-name">{attachment.name}</span>
      {onAnnotate ? (
        <AttachmentAnnotateButton
          name={attachment.name}
          count={attachment.annotations?.length ?? 0}
          onClick={onAnnotate}
        />
      ) : null}
      <button
        type="button"
        className="ai-chat-attachment-remove"
        title={t("attachment.remove")}
        aria-label={t("attachment.remove")}
        onClick={onRemove}
      >
        <X size={13} />
      </button>
    </div>
  );
}

