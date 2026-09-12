import type { SigmaDocument } from "@/features/document";
import { createId } from "@/lib/id";

import mathTestDocument from "./initial-documents/math-test-calculator-questions.sigmadoc.json";
import sigmaStudioBasicsDocument from "./initial-documents/sigma-studio-basics.sigmadoc.json";

const INITIAL_BROWSER_DOCUMENTS = [
  sigmaStudioBasicsDocument,
  mathTestDocument,
] as const;

const LEGACY_MATH_TEST_TITLE = "Math Test – Calculator Questions";
const LEGACY_MATH_TEST_FIRST_BLOCK_ID = "p_91633144-59ac-4fae-9ce4-3ba48d128db9";

export const PINNED_BROWSER_DOCUMENT_TITLES = INITIAL_BROWSER_DOCUMENTS.map(
  (document) => document.metadata.title,
);

/**
 * ブラウザで常に開く固定教材を作る。import した JSON を直接返すと編集時に
 * モジュール共有値を汚すため、作成ごとに複製して新しい docId を割り当てる。
 */
export function createPinnedBrowserDocument(title: string, now: string): SigmaDocument {
  const source = INITIAL_BROWSER_DOCUMENTS.find((document) => document.metadata.title === title);
  if (!source) {
    throw new Error(`Unknown pinned browser document: ${title}`);
  }
  return {
    ...(structuredClone(source) as SigmaDocument),
    docId: createId("doc"),
    updatedAt: now,
  };
}

/** Sites で配布済みの旧固定教材だけを、新しい固定教材へ移行する。 */
export function isLegacyPinnedBrowserDocument(
  title: string,
  document: SigmaDocument,
): boolean {
  return title === LEGACY_MATH_TEST_TITLE
    && document.content[0]?.id === LEGACY_MATH_TEST_FIRST_BLOCK_ID;
}
