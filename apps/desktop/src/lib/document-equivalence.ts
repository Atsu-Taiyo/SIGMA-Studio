import { pruneUnusedDocumentOverlayAssets, type SigmaDocument } from "@/features/document";
import { areStructurallyEqual } from "@/lib/structural-equality";

/**
 * 「教材の中身が変わったか」を判定するときに見る値。
 *
 * `updatedAt` のような保存のたびに動く記録用フィールドは **意図的に含めない**。保存経路は
 * `documentRef.current` そのものではなく `{...doc, updatedAt: now}` という別コピーを書き、その
 * コピーを `lastSaved`/`lastSynced` として覚える。`updatedAt` を内容差分として数えると
 * 「保存直後の文書が必ず変更済み」になり、3-wayマージが常にメタ競合で失敗していた。
 */
export function comparableDocumentValue(document: SigmaDocument): unknown {
  const canonical = pruneUnusedDocumentOverlayAssets(document);
  return {
    version: document.version,
    docId: document.docId,
    metadata: document.metadata,
    content: document.content,
    comments: document.comments,
    outputProfiles: document.outputProfiles,
    pageLayout: canonical.pageLayout,
  };
}

/** 内容として同じ教材か (キー順と `updatedAt` などの記録用フィールドは無視する)。 */
export function areSigmaDocumentsEquivalent(left: SigmaDocument, right: SigmaDocument): boolean {
  return areStructurallyEqual(comparableDocumentValue(left), comparableDocumentValue(right));
}
