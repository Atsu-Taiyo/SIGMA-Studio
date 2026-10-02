"use client";
import { AtSign, File as FileIcon, FileText, Sparkles, X } from "lucide-react";
import { Shimmer } from "@/components/ui/Shimmer";
import { resolveAiResourceDisplayMetadata } from "@/lib/ai/ai-resource-display";
import type { AiEditAttachment, AiEditMentionedDocumentContext } from "@/lib/ai/sigma-doc-agent-tools";
import { useT } from "@/lib/i18n/react";
import type { DesktopAiResourceManifestEntry, DesktopDocumentMetadata } from "@/types/desktop";
import { isImageAttachment } from "../application/ai-chat-attachments";
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
}: {
  attachment: AiEditAttachment;
  onRemove: () => void;
}) {
  const t = useT("ai");
  if (!isImageAttachment(attachment)) {
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
        style={{ backgroundImage: `url("${attachment.dataUrl}")` }}
      />
      <span className="ai-chat-attachment-name">{attachment.name}</span>
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

