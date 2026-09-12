import { findBlock } from "@/lib/document-tree";
import type {
  SigmaDocument,
  SigmaTextRangeCommentAnchor,
} from "@/features/document";
import {
  blockToStableReferenceText,
  getAiEditReferenceKey,
  MAX_AI_EDIT_REFERENCES,
  type AiEditReference,
} from "@/lib/ai/ai-edit-reference";
import type { AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";

export type AiPinnedReferenceAddOutcome = "added" | "duplicate" | "limit";

export interface AiPinnedReferenceAddResult {
  outcome: AiPinnedReferenceAddOutcome;
  referenceKey: string;
  references: AiEditReference[];
}

export interface AiPinnedTextRangeReconciliation {
  changed: boolean;
  references: AiEditReference[];
  signatures: Map<string, string>;
}

/**
 * 参照追加を純粋に判定する。上限到達時にも既存参照の再選択は duplicate として扱うため、
 * duplicate 判定を limit 判定より先に行う。
 */
export function planAiPinnedReferenceAddition(
  currentReferences: AiEditReference[],
  reference: AiEditReference,
  maxReferences = MAX_AI_EDIT_REFERENCES,
): AiPinnedReferenceAddResult {
  const referenceKey = getAiEditReferenceKey(reference);
  const isDuplicate = currentReferences.some(
    (item) => getAiEditReferenceKey(item) === referenceKey,
  );
  if (isDuplicate) {
    return {
      outcome: "duplicate",
      referenceKey,
      references: currentReferences,
    };
  }
  if (currentReferences.length >= maxReferences) {
    return {
      outcome: "limit",
      referenceKey,
      references: currentReferences,
    };
  }
  return {
    outcome: "added",
    referenceKey,
    references: [...currentReferences, reference],
  };
}

/**
 * 同じ参照キーへ後から届いたpreviewでは、pin時点の最初のsnapshotを置き換えない。
 */
export function addAiPinnedReferencePreview(
  currentPreviews: Map<string, AiEditShapeOnlyPreview>,
  referenceKey: string,
  preview: AiEditShapeOnlyPreview,
): Map<string, AiEditShapeOnlyPreview> {
  if (currentPreviews.has(referenceKey)) {
    return currentPreviews;
  }
  const nextPreviews = new Map(currentPreviews);
  nextPreviews.set(referenceKey, preview);
  return nextPreviews;
}

export function removeAiPinnedReferenceByKey(
  currentReferences: AiEditReference[],
  referenceKey: string,
): AiEditReference[] {
  return currentReferences.filter(
    (item) => getAiEditReferenceKey(item) !== referenceKey,
  );
}

export function removeAiPinnedReferencePreview(
  currentPreviews: Map<string, AiEditShapeOnlyPreview>,
  referenceKey: string,
): Map<string, AiEditShapeOnlyPreview> {
  if (!currentPreviews.has(referenceKey)) {
    return currentPreviews;
  }
  const nextPreviews = new Map(currentPreviews);
  nextPreviews.delete(referenceKey);
  return nextPreviews;
}

/**
 * pin時点のtextRangeが指す端点ブロックの内容を比較し、本文が変わった参照では
 * textRangeだけを失効させる。選択本文や数式、overlay snapshotはpin時点の情報として残す。
 */
export function reconcileAiPinnedReferenceTextRanges(
  currentReferences: AiEditReference[],
  currentSignatures: ReadonlyMap<string, string>,
  document: SigmaDocument,
): AiPinnedTextRangeReconciliation {
  if (currentReferences.length === 0) {
    return {
      changed: false,
      references: currentReferences,
      signatures: new Map(),
    };
  }

  let changed = false;
  const nextSignatures = new Map(currentSignatures);
  const nextReferences = currentReferences.map((item) => {
    if (item.kind !== "textSelection" || !item.textRange) {
      return item;
    }

    const referenceKey = getAiEditReferenceKey(item);
    const currentSignature = textRangeBlockSignature(document, item.textRange);
    const previousSignature = nextSignatures.get(referenceKey);
    if (previousSignature === undefined) {
      nextSignatures.set(referenceKey, currentSignature);
      return item;
    }
    if (previousSignature === currentSignature) {
      return item;
    }

    changed = true;
    nextSignatures.delete(referenceKey);
    return { ...item, textRange: undefined };
  });

  return {
    changed,
    references: changed ? nextReferences : currentReferences,
    signatures: nextSignatures,
  };
}

/**
 * textRangeのstart/endブロックについて、現在の内容を比較するための署名を作る。
 * 欠落ブロックには番兵値を使い、削除も本文変更として検出する。
 *
 * **必ず言語に依存しない `blockToStableReferenceText` を使う。** 表示用の
 * `blockToReferenceText` はラベルを訳すので、本文が 1 文字も変わっていなくても
 * UI 言語を切り替えた瞬間に署名が変わり、pin 参照が黙って無効化される。
 */
export function textRangeBlockSignature(
  document: SigmaDocument,
  textRange: SigmaTextRangeCommentAnchor,
): string {
  const startBlock = findBlock(document, textRange.start.blockId);
  const endBlock = textRange.end.blockId === textRange.start.blockId
    ? startBlock
    : findBlock(document, textRange.end.blockId);
  const startText = startBlock ? blockToStableReferenceText(startBlock) : "\u0000missing";
  const endText = endBlock ? blockToStableReferenceText(endBlock) : "\u0000missing";
  return `${startText}\u0001${endText}`;
}
