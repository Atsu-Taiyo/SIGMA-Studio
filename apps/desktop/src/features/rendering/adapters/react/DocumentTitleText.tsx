"use client";

import { memo } from "react";

import type { InlineNode } from "@/features/document";
import { parseDocumentTitleInlineNodes } from "@/features/rendering/core";

import type { MathRenderEnvironment } from "@/lib/math-environment";

import { isMathTexRenderable } from "../math-html";

import { renderInlineContent } from "./InlineContent";
import { useMathEnvironment } from "./MathEnvironment";

export interface DocumentTitleTextProps {
  title: string;
  /**
   * 描くノード列。本文から導出したタイトルのように**元から構造がある**面はこれを渡す
   * (`resolveDocumentTitleContent(...).nodes`)。`$tex$` の文字列へ潰してから読み直すと、
   * 上限の切り出しが `$…$` の対を割り、本文の素の `$` が区切りに化けて生ソースが出る。
   * `null` は「数式は無いので素のテキストで描く」、省略は「従来どおり `title` をパースする」
   * (台帳の `WorkspaceFile.title` のように文字列しか持たない面)。
   *
   * 渡すときは `inlineNodesToPlainText(nodes) === title` を呼び出し側が保証すること。
   * `title` は読み上げ・ツールチップ・ファイル名へ回る素のテキストなので、食い違うと
   * 画面の文字と `title` / `aria-label` が別のことを言う。`resolveDocumentTitleContent`
   * はこの対を必ず一緒に返すので、そこから来た値をばらさずに使えば守られる。
   */
  nodes?: InlineNode[] | null;
}

/**
 * 教材タイトルの `$…$` を本文と同じ数式描画で描く。数式が無ければ素のテキストのまま返すので、
 * 数式を含まないタイトルは DOM が 1 文字も変わらない。
 *
 * `InlineContent` ではなく `renderInlineContent` を直接使う。`InlineContent` は囲み枠付き run の
 * 高さ合わせのために ResizeObserver + MutationObserver をインスタンスごとに張るが、タイトルの
 * 射影は text と mathInline しか作らないため囲み枠は存在し得ず、教材一覧のように何十個も
 * マウントされる面では純粋な再計測コストにしかならない。描画経路は同じ `buildInlineRichTextDom`
 * なので分岐にはならない。
 *
 * 呼び出し側は、読み上げ・ツールチップ・ファイル名など**素のテキストしか置けない面**に
 * 生の文字列を必ず残すこと (KaTeX は MathML を出さないので数式部分は読み上げられない)。
 *
 * 描画中の throw (= React がツリーごと捨てて画面が真っ白になる) と markup の無害化は
 * `renderMathHtml` が引き受けるので、ここに例外プローブや XSS ガードは持たない。
 * ただしタイトルには「リッチ表示の可視テキスト = 生の文字列」という固有の不変条件があり、
 * 数式として描けなかった tex は `$…$` を失った素の TeX として出てしまう。描ける保証が
 * 取れないときはタイトル全体を生の文字列へ倒す。
 */
export const DocumentTitleText = memo(function DocumentTitleText({
  title,
  nodes,
}: DocumentTitleTextProps) {
  const mathEnvironment = useMathEnvironment();
  const resolved = nodes === undefined ? parseDocumentTitleInlineNodes(title) : nodes;
  if (!resolved || !keepsTitleSourceText(resolved, mathEnvironment)) {
    return <>{title}</>;
  }

  return (
    <span className="rich-inline-content document-title-rich">
      {renderInlineContent(resolved, { keyPrefix: "doc-title" })}
    </span>
  );
});

function keepsTitleSourceText(
  nodes: readonly InlineNode[],
  environment: MathRenderEnvironment,
): boolean {
  return nodes.every((node) => node.type !== "mathInline" || isMathTexRenderable(node.tex, environment));
}
