"use client";

import { useCallback, useRef, useState } from "react";

import type { SigmaDocument } from "@/features/document";
import type { AiEditReference } from "@/lib/ai/ai-edit-reference";
import type { AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";

import {
  addAiPinnedReferencePreview,
  planAiPinnedReferenceAddition,
  reconcileAiPinnedReferenceTextRanges,
  removeAiPinnedReferenceByKey,
  removeAiPinnedReferencePreview,
  type AiPinnedReferenceAddResult,
} from "../model/pinned-reference-model";

export interface AiPinnedReferencesController {
  references: AiEditReference[];
  previews: Map<string, AiEditShapeOnlyPreview>;
  clear: () => void;
  pin: (
    reference: AiEditReference,
    preview?: AiEditShapeOnlyPreview,
  ) => AiPinnedReferenceAddResult;
  remove: (referenceKey: string) => void;
  reconcileTextRanges: (
    document: SigmaDocument,
    currentReferences?: AiEditReference[],
  ) => void;
}

/**
 * AI固有のpin参照コレクションを所有する。referencesRefを同期正本にすることで、
 * 同じイベント内に連続してpinされてもReact stateの反映待ちで追加判定を取りこぼさない。
 */
export function useAiPinnedReferences(): AiPinnedReferencesController {
  const [references, setReferences] = useState<AiEditReference[]>([]);
  const referencesRef = useRef<AiEditReference[]>([]);
  const [previews, setPreviews] = useState<Map<string, AiEditShapeOnlyPreview>>(
    () => new Map(),
  );
  const textRangeSignaturesRef = useRef(new Map<string, string>());

  const clear = useCallback(() => {
    referencesRef.current = [];
    setReferences((current) => current.length === 0 ? current : []);
    setPreviews((current) => current.size === 0 ? current : new Map());
    textRangeSignaturesRef.current.clear();
  }, []);

  const pin = useCallback((
    reference: AiEditReference,
    preview?: AiEditShapeOnlyPreview,
  ): AiPinnedReferenceAddResult => {
    const result = planAiPinnedReferenceAddition(referencesRef.current, reference);
    if (result.outcome === "added") {
      referencesRef.current = result.references;
      setReferences(result.references);
    }
    if (preview && result.outcome === "added") {
      setPreviews((current) => (
        addAiPinnedReferencePreview(current, result.referenceKey, preview)
      ));
    }
    return result;
  }, []);

  const remove = useCallback((referenceKey: string) => {
    textRangeSignaturesRef.current.delete(referenceKey);
    const nextReferences = removeAiPinnedReferenceByKey(
      referencesRef.current,
      referenceKey,
    );
    referencesRef.current = nextReferences;
    setReferences(nextReferences);
    setPreviews((current) => removeAiPinnedReferencePreview(current, referenceKey));
  }, []);

  const reconcileTextRanges = useCallback((
    document: SigmaDocument,
    currentReferences = referencesRef.current,
  ) => {
    const result = reconcileAiPinnedReferenceTextRanges(
      currentReferences,
      textRangeSignaturesRef.current,
      document,
    );
    textRangeSignaturesRef.current = result.signatures;
    if (result.changed) {
      referencesRef.current = result.references;
      setReferences(result.references);
    }
  }, []);

  return {
    references,
    previews,
    clear,
    pin,
    remove,
    reconcileTextRanges,
  };
}
