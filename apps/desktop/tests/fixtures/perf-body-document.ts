/**
 * Body-heavy perf fixture: a single-column A4 document whose cost is dominated by paragraphs and
 * inline math, matching the real 1596-block / 1277-math document the perf diagnosis was run on.
 *
 * Generated, never captured: no third-party content is embedded, and the generator is a pure
 * function so `createPerfBodyDocument()` twice gives byte-identical JSON.
 */
import { perfParagraph } from "./perf-fixture-content";
import type { ParagraphNode, SigmaDocument } from "@/types/sigma-doc";

export const PERF_BODY_PARAGRAPH_COUNT = 1500;
/** Every 10th paragraph is empty — the blank lines that real teaching material is full of. */
export const PERF_BODY_EMPTY_PARAGRAPH_COUNT = PERF_BODY_PARAGRAPH_COUNT / 10;
export const PERF_BODY_MATH_PARAGRAPH_COUNT = 1200;
/** One `mathInline` per math paragraph. */
export const PERF_BODY_MATH_NODE_COUNT = PERF_BODY_MATH_PARAGRAPH_COUNT;
export const PERF_BODY_BLOCK_ID_PREFIX = "perf_body_p_";

/**
 * 段落数を指定できるのは、**打鍵コストが文書の長さにどれだけ比例するか**を測るため
 * (5 / 20 / 50 ページ相当の 3 サイズ)。既定は本番相当の 1,500 段落で、引数なしの呼び出しは
 * 従来どおりバイト単位で同じ JSON を返す。
 */
export function createPerfBodyDocument(
  { paragraphs = PERF_BODY_PARAGRAPH_COUNT }: { paragraphs?: number } = {},
): SigmaDocument {
  return {
    version: "2.0",
    docId: paragraphs === PERF_BODY_PARAGRAPH_COUNT ? "doc_perf_body" : `doc_perf_body_${paragraphs}`,
    metadata: { title: "性能計測用 本文型フィクスチャ" },
    content: createBodyParagraphs(paragraphs),
    outputProfiles: {
      student: { showSolutions: false, showHints: false },
      teacher: { showSolutions: true, showHints: true },
      answerBook: { onlySolutions: true, includeAnswers: true },
    },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 14, right: 16, bottom: 14, left: 16 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 10 },
    },
  };
}

function createBodyParagraphs(count: number): ParagraphNode[] {
  const paragraphs: ParagraphNode[] = [];
  // `nonEmptyOrdinal` (not the raw index) drives the math decision so the counts are exact:
  // 1500 - 150 empty = 1350 non-empty, of which every 9th carries no math = 1200 math paragraphs.
  let nonEmptyOrdinal = 0;
  for (let index = 0; index < count; index += 1) {
    const empty = index % 10 === 9;
    const math = !empty && nonEmptyOrdinal % 9 !== 8;
    if (!empty) {
      nonEmptyOrdinal += 1;
    }
    paragraphs.push(perfParagraph(`${PERF_BODY_BLOCK_ID_PREFIX}${index}`, index, {
      empty,
      math,
      boxed: !empty && index % 50 === 25,
    }));
  }
  return paragraphs;
}
