import {
  mathRenderEnvironmentCacheKey,
  type MathRenderEnvironment,
} from "@/lib/math-environment";
import { convertLatexToMarkupCached } from "@/lib/math-tex";

import { sanitizeMathMarkup } from "./math-markup";
import { escapeHtml } from "./rich-text-html";

/**
 * TeX から数式 markup を作る**唯一の出口**。React の `dangerouslySetInnerHTML`、Tiptap NodeView の
 * `element.innerHTML`、SVG `<foreignObject>` への文字列連結、publish 済みの `@sigma-studio/viewer` は
 * すべてここを通るので、無害化はここ 1 箇所で足りる (`architecture.test.ts` が唯一性を固定する)。
 *
 * `lib/math-tex.ts` の `convertLatexToMarkupCached` 側では無害化しない。
 * `adapters/math-metrics.ts` が MathLive の**生 markup** の `ML__strut` を正規表現で読んで
 * 数式の高さを決めており、そこにサニタイズを挟むと属性の順序や引用符の違いが
 * 図形テキストの箱サイズを無言で壊すため。計測は生 markup を読み続ける。
 *
 * `environment` (マクロ + 組版スタイル) に既定値は無い。省略できると「本文だけ前文マクロが効く」
 * 「ダイアログのプレビューだけ組版が違う」という取りこぼしがそのまま入り込む
 * (`architecture.test.ts` の門番が省略可能化を禁じている)。
 */
export function renderMathHtml(
  tex: string,
  environment: MathRenderEnvironment,
): string {
  // 打鍵ごとに文書中の全数式が引くキーなので `JSON.stringify` は使わない。
  const cacheKey = mathRenderEnvironmentCacheKey(environment, tex);
  const cached = sanitizedMarkupCache.get(cacheKey);
  if (cached !== undefined) {
    // 参照し直したものを末尾へ送る (Map は挿入順で反復するので、これで LRU になる)。
    // FIFO のままだと上限を超えた文書で「よく使う数式」から順に落ちて毎回作り直しになる。
    sanitizedMarkupCache.delete(cacheKey);
    sanitizedMarkupCache.set(cacheKey, cached);
    return cached;
  }

  const html = buildSanitizedMathHtml(tex, environment);
  if (sanitizedMarkupCache.size >= SANITIZED_MARKUP_CACHE_LIMIT) {
    const oldest = sanitizedMarkupCache.keys().next().value;
    if (oldest !== undefined) {
      sanitizedMarkupCache.delete(oldest);
    }
  }
  sanitizedMarkupCache.set(cacheKey, html);
  return html;
}

/**
 * その TeX が数式として描けたか。描けなかった場合の表示は素の TeX なので、
 * 「元の文字列を復元できないなら丸ごと生表示へ倒す」不変条件を持つ面 (教材タイトル) は
 * これを見て自分の側のフォールバックへ落とす。判定は上のキャッシュに乗るので追加の変換は走らない。
 */
export function isMathTexRenderable(
  tex: string,
  environment: MathRenderEnvironment,
): boolean {
  return !renderMathHtml(tex, environment).startsWith(UNRENDERED_MATH_PREFIX);
}

// 無害化は (TeX, 描画環境) ごとに 1 回だけ走らせる。`lib/math-tex.ts` の markup キャッシュと同形の LRU。
const sanitizedMarkupCache = new Map<string, string>();
const SANITIZED_MARKUP_CACHE_LIMIT = 5000;
const UNRENDERED_MATH_PREFIX = '<span data-math-unrendered="true">';

/**
 * `renderMathHtml` は決して throw しない。`validateLatex` を通る TeX でも markup 生成が
 * 例外を投げることがあり (`\href{javascript:…}` は "Invalid URL"、`\class{x" onmouseover=…}` は
 * "Invalid attribute value")、描画中の throw は React にツリーごと捨てられて画面が真っ白になる。
 *
 * フォールバックは素の TeX 表示。新しいクラス名は作らない (`document-surface.test.ts` が
 * `math-preview` 等の接頭辞を持つクラスの新設を禁じている) ので `data-` 属性だけで表現する。
 */
function buildSanitizedMathHtml(
  tex: string,
  environment: MathRenderEnvironment,
): string {
  try {
    const markup = convertLatexToMarkupCached(tex, environment);
    const sanitized = sanitizeMathMarkup(markup);
    if (sanitized.safe) {
      return sanitized.html;
    }
  } catch {
    // 下のフォールバックへ落ちる。
  }
  return `${UNRENDERED_MATH_PREFIX}${escapeHtml(tex)}</span>`;
}
