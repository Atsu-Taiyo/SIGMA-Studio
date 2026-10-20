import type { SigmaDocument } from "@/features/document";
import { createTranslator, DEFAULT_LOCALE, type Translate } from "@/lib/i18n";
import { collectOutline } from "@/lib/document-tree";

/** 字下げの段数の上限。見出しは 3 段、その下の問題でもう 1 段。 */
export const OUTLINE_NAVIGATION_MAX_DEPTH = 3;

export interface OutlineNavigationItem {
  /** 本文のブロック id。`document.getElementById` でそのまま飛べる。 */
  id: string;
  title: string;
  kind: "section" | "heading" | "problem";
  /** 字下げの段 (0 始まり)。教材で使われている最も大きい見出しを 0 とする。 */
  depth: number;
  /** 見出し番号 (`document.metadata.headingNumbering` が有効なときだけ)。 */
  number?: string;
}

export interface OutlineNavigationOptions {
  /** ブロック種別の表示名を引く翻訳関数。省略時は日本語。 */
  t?: Translate<"editor">;
  /** `getHeadingNumberMap` の結果。 */
  headingNumbers?: ReadonlyMap<string, string>;
}

/**
 * 画面のアウトライン (キャンバス左上の OutlineDock) に出す、見出し・節・問題の一覧。
 *
 * 範囲は `collectOutline(document, { includeLayoutHeadings: true })` と同じで、段組みの入れ物
 * そのもの (「2段組み」) だけ除く — 飛び先にしても本文の位置が分かるだけで、見出しではない。
 * `collectOutline` は AI / MCP も使うので戻り値の形は変えず、字下げに要る見出しの段はここで
 * 本文から引き直す。
 */
export function buildOutlineNavigation(
  document: SigmaDocument,
  options: OutlineNavigationOptions = {},
): OutlineNavigationItem[] {
  const t = options.t ?? createTranslator(DEFAULT_LOCALE, "editor");
  const entries = collectOutline(document, { t, includeLayoutHeadings: true });
  const levels = collectHeadingLevels(document);

  let shallowestLevel = 3;
  for (const entry of entries) {
    const level = levels.get(entry.id);
    if (level !== undefined && level < shallowestLevel) {
      shallowestLevel = level;
    }
  }

  const items: OutlineNavigationItem[] = [];
  // 直前の見出しの段。問題はその 1 段下に置く (見出しが無ければ左端)。
  let headingDepth = -1;
  for (const entry of entries) {
    if (entry.type === "problem") {
      items.push({
        id: entry.id,
        title: entry.title,
        kind: "problem",
        depth: Math.min(headingDepth + 1, OUTLINE_NAVIGATION_MAX_DEPTH),
      });
      continue;
    }
    if (entry.type !== "section" && entry.type !== "heading") {
      continue;
    }
    const depth = Math.max(0, (levels.get(entry.id) ?? 1) - shallowestLevel);
    headingDepth = depth;
    const number = options.headingNumbers?.get(entry.id);
    items.push({
      id: entry.id,
      title: entry.title,
      kind: entry.type,
      depth,
      ...(number ? { number } : {}),
    });
  }
  return items;
}

/** 節 (section) は H1 と同じ段として数える (見出し番号の振り方と同じ)。 */
function collectHeadingLevels(document: SigmaDocument): Map<string, 1 | 2 | 3> {
  const levels = new Map<string, 1 | 2 | 3>();
  for (const block of document.content) {
    if (block.type === "section") {
      levels.set(block.id, 1);
    } else if (block.type === "heading") {
      levels.set(block.id, block.level);
    } else if (block.type === "layoutSection") {
      for (const child of block.children) {
        if (child.type === "heading") {
          levels.set(child.id, child.level);
        }
      }
    }
  }
  return levels;
}
