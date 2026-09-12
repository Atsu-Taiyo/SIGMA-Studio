"use client";

import { FileText, Globe, Package, Search } from "lucide-react";

import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import type { DesktopAiSourceReference } from "@/types/desktop";

// Phase 1: Agentic RAG。1件の参照から表示ラベルを決める。
// document: title (MCPサーバーが提案作成時に補完する想定) が無ければ fileId にフォールバック。
// material: name が無ければ materialId にフォールバック。
// web: ホスト名 (無効なURLなら生のURL文字列にフォールバック)。
// webSearch: 検索語。URLが取得できないケースなので開くリンクにはしない。
function sourceReferenceLabel(reference: DesktopAiSourceReference, t: Translate<"ai">): string {
  if (reference.type === "document") {
    return reference.title?.trim() || reference.fileId;
  }
  if (reference.type === "material") {
    return reference.name?.trim() || reference.materialId;
  }
  if (reference.type === "webSearch") {
    return t("source.webSearch", { replace: { query: reference.query } });
  }
  try {
    return new URL(reference.url).hostname || reference.url;
  } catch {
    return reference.url;
  }
}

function sourceReferenceTooltip(reference: DesktopAiSourceReference, t: Translate<"ai">): string {
  if (reference.type === "document") {
    return reference.blockId ? `${reference.fileId} (${reference.blockId})` : reference.fileId;
  }
  if (reference.type === "material") {
    return reference.materialId;
  }
  if (reference.type === "webSearch") {
    return t("source.webSearchQuery", { replace: { query: reference.query } });
  }
  return reference.url;
}

function sourceReferenceKey(reference: DesktopAiSourceReference, index: number): string {
  if (reference.type === "document") return `document:${reference.fileId}:${index}`;
  if (reference.type === "material") return `material:${reference.materialId}:${index}`;
  if (reference.type === "webSearch") return `webSearch:${reference.query}:${index}`;
  return `web:${reference.url}:${index}`;
}

export interface AiSourceReferenceOpenDocumentParams {
  fileId: string;
  blockId?: string;
  title?: string;
}

/** Compact horizontal row of source-reference chips for one proposal group / assistant
 * turn's `sourceReferences` (Phase 1: Agentic RAG). Document chips open the
 * referenced file in the workspace when `onOpenDocument` is provided; web chips
 * open externally via the desktop bridge. Shared between the inline proposal
 * preview card and the chat sidebar's per-turn citation row. */
export function AiSourceReferenceChips({
  sourceReferences,
  className,
  onOpenDocument,
}: {
  sourceReferences: DesktopAiSourceReference[];
  className?: string;
  onOpenDocument?: (params: AiSourceReferenceOpenDocumentParams) => void;
}) {
  const t = useT("ai");
  if (sourceReferences.length === 0) {
    return null;
  }

  return (
    <div className={["ai-source-ref-row", className].filter(Boolean).join(" ")} aria-label={t("source.title")}>
      <span className="ai-source-ref-caption">{t("source.title")}</span>
      {sourceReferences.map((reference, index) => (
        <AiSourceReferenceChip
          key={sourceReferenceKey(reference, index)}
          reference={reference}
          onOpenDocument={onOpenDocument}
        />
      ))}
    </div>
  );
}

function AiSourceReferenceChip({
  reference,
  onOpenDocument,
}: {
  reference: DesktopAiSourceReference;
  onOpenDocument?: (params: AiSourceReferenceOpenDocumentParams) => void;
}) {
  const t = useT("ai");
  const label = sourceReferenceLabel(reference, t);
  const tooltip = sourceReferenceTooltip(reference, t);

  if (reference.type === "document" && onOpenDocument) {
    return (
      <button
        type="button"
        className="ai-source-ref-chip ai-source-ref-chip--document"
        title={tooltip}
        onClick={() => {
          onOpenDocument({
            fileId: reference.fileId,
            blockId: reference.blockId,
            title: reference.title,
          });
        }}
      >
        <FileText size={11} aria-hidden="true" />
        <span>{label}</span>
      </button>
    );
  }

  if (reference.type === "web") {
    return (
      <button
        type="button"
        className="ai-source-ref-chip ai-source-ref-chip--web"
        title={reference.url}
        onClick={() => {
          void getDesktopBridge()?.shell.openExternal(reference.url);
        }}
      >
        <Globe size={11} aria-hidden="true" />
        <span>{label}</span>
      </button>
    );
  }

  // webSearch はURLを持たないので、開けそうに見えるボタンにはしない (嘘の導線を作らない)。
  return (
    <span className="ai-source-ref-chip" title={tooltip}>
      {reference.type === "document" ? (
        <FileText size={11} aria-hidden="true" />
      ) : reference.type === "webSearch" ? (
        <Search size={11} aria-hidden="true" />
      ) : (
        <Package size={11} aria-hidden="true" />
      )}
      <span>{label}</span>
    </span>
  );
}
