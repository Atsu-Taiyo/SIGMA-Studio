import type { PageLayout, SigmaBlock, SigmaDocument } from "../model";
import {
  boxBlockChildCharsPerLine,
  estimateBlockHeightPx,
  estimateBoxBlockTitleHeightPx,
  estimateListItemHeightPx,
  estimateProblemAreaHeightPx,
  getPageMetrics,
  PAGE_GAP_PX,
  paginateBlocksIntoColumns,
  PROBLEM_AREA_ORDER,
} from "./page-layout";

/**
 * `.text-flow-shell` の水平方向の実効オフセット。DOM計測 (measureBlockTops) が読む
 * ブロック矩形と推定値を一致させるために本文フロー系ブロックの left へ加算する。
 */
export const TEXT_FLOW_BLOCK_ANCHOR_LEFT_OFFSET_PX = 2;

/** 箇条書きの1段あたりのインデント目安 (ブラウザ既定の list padding 相当)。 */
const LIST_ITEM_INDENT_PX = 24;

/** `estimateBlockHeightPx` がリストブロックに足す前置き分。 */
const LIST_BLOCK_LEADING_PX = 12;

/**
 * ヘッドレスに推定した本文トップレベルブロックの連続キャンバス座標矩形。
 *
 * `features/drawing` の `MeasuredBlock` と構造的に互換で、`resolveShapePosition`
 * へそのまま渡せる。ただしこれは **推定値** であり、画面上の最終位置は常に
 * anchor から再計算される (`resolveShapeY = blockTop + anchor.dy`)。
 * 「見た目の真実」として使ってはならない。
 */
export interface EstimatedBlockRect {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

/**
 * DOM を使わずに本文ブロックの矩形を推定する。ページ送り・段組みは
 * `paginateBlocksIntoColumns` と同じ規則で、高さは `estimateBlockHeightPx` の概算。
 *
 * 用途は「どのブロックか / おおよそどこか」を決めることだけで、AI挿入の
 * anchor デルタ算出 (`dx = x - rect.left` / `dy = y - rect.top`) と、
 * 保存済み anchor の dx 補完に使う。
 *
 * **ネストしたブロックも必ず載せる。** アンカー解決の DOM 計測
 * (`measureBlockTops`) は `[data-sigma-doc-id]` を無差別に拾うため、問題エリアの
 * 子ブロックのように「DOM には出るが推定には無い」id があると、
 * `dx = x - (rect?.left ?? 0)` が絶対座標をそのままデルタとして残し、描画時に
 * ブロック原点が二重加算される (これが AI 挿入位置ズレの本体)。
 */
export function estimateBlockRects(document: SigmaDocument): Map<string, EstimatedBlockRect> {
  return estimateTopLevelBlockRects(document.content, document.pageLayout);
}

/** ページ設定を明示して推定する版。`estimateBlockRects` の実体。 */
export function estimateTopLevelBlockRects(
  content: SigmaBlock[],
  layout?: PageLayout,
): Map<string, EstimatedBlockRect> {
  const metrics = getPageMetrics(layout);
  const charsPerLine = Math.max(16, Math.round(metrics.flow.columnWidthPx / 12.3));
  const pageStride = metrics.page.heightPx + PAGE_GAP_PX;
  const rects = new Map<string, EstimatedBlockRect>();
  const pages = paginateBlocksIntoColumns(content, layout);

  for (const page of pages) {
    const pageTop = (page.number - 1) * pageStride;

    for (const column of page.columns) {
      const left = metrics.margins.leftPx +
        (column.number - 1) * (metrics.flow.columnWidthPx + metrics.flow.columnGapPx);
      let cursorY = 0;

      for (const block of column.blocks) {
        const height = estimateBlockHeightPx(block, charsPerLine);
        const blockLeft = left + (isTopLevelTextFlowBlock(block) ? TEXT_FLOW_BLOCK_ANCHOR_LEFT_OFFSET_PX : 0);
        const rect: EstimatedBlockRect = {
          id: block.id,
          left: blockLeft,
          top: pageTop + metrics.margins.topPx + cursorY,
          width: metrics.flow.columnWidthPx,
          height,
        };
        rects.set(block.id, rect);
        collectNestedBlockRects(block, rect, charsPerLine, rects);
        cursorY += height;
      }
    }
  }

  return rects;
}

/**
 * ネストしたブロック (問題エリアの子・枠内ブロック・局所段組みの子) の矩形を、
 * 親の推定矩形の中に積んで登録する。高さの規則は `estimateBlockHeightPx` と同一の
 * ものを共有し、二重定義を作らない。
 */
function collectNestedBlockRects(
  block: SigmaBlock,
  rect: EstimatedBlockRect,
  charsPerLine: number,
  rects: Map<string, EstimatedBlockRect>,
): void {
  if (block.type === "problem") {
    let cursorY = rect.top;
    for (const area of PROBLEM_AREA_ORDER) {
      const areaTop = cursorY;
      stackChildRects(block[area], rect.left, cursorY, rect.width, charsPerLine, rects);
      cursorY = areaTop + estimateProblemAreaHeightPx(block, area, charsPerLine);
    }
    return;
  }

  if (block.type === "boxBlock") {
    stackChildRects(
      block.blocks,
      rect.left,
      rect.top + (block.frame?.paddingPx?.top ?? 12) + estimateBoxBlockTitleHeightPx(block, charsPerLine),
      rect.width,
      boxBlockChildCharsPerLine(charsPerLine),
      rects,
    );
    return;
  }

  if (block.type === "list") {
    // 箇条書きは1ブロックだが、DOM では項目ごとに id が出るので図形はそこへ
    // 紐づく。項目の矩形が無いと `measureBlockTops` にある id が推定に無い状態
    // (このファイル冒頭の注意書きの通り) になる。
    stackListItemRects(block.items, rect, charsPerLine, 0, rects);
    return;
  }

  if (block.type === "layoutSection") {
    collectLayoutSectionChildRects(block, rect, charsPerLine, rects);
    return;
  }

  // 引用の中身も DOM には id が出る。載せておかないと、中のブロックへ図形を留めたとき
  // `dx = x - (rect?.left ?? 0)` が絶対座標をそのままデルタとして残す (このファイル冒頭の注意)。
  if (block.type === "quote") {
    stackChildRects(block.blocks, rect.left + 17, rect.top + 8, Math.max(1, rect.width - 17), Math.max(12, charsPerLine - 3), rects);
  }
}

/** 箇条書き項目 (と入れ子の子リスト項目) を、親リストの矩形の中に積む。 */
function stackListItemRects(
  items: Extract<SigmaBlock, { type: "list" }>["items"],
  rect: EstimatedBlockRect,
  charsPerLine: number,
  depth: number,
  rects: Map<string, EstimatedBlockRect>,
): number {
  const indent = LIST_ITEM_INDENT_PX * (depth + 1);
  // `estimateBlockHeightPx` がリストブロック全体に一度だけ足す前置き分。入れ子の
  // 子リストには足さない (高さ推定と同じ規則)。
  let cursorY = rect.top + (depth === 0 ? LIST_BLOCK_LEADING_PX : 0);

  for (const item of items) {
    const height = estimateListItemHeightPx(item, charsPerLine, depth);
    rects.set(item.id, {
      id: item.id,
      left: rect.left + indent,
      top: cursorY,
      width: Math.max(1, rect.width - indent),
      height,
    });
    cursorY += height;

    for (const nested of item.nested ?? []) {
      const nestedRect: EstimatedBlockRect = {
        id: nested.id,
        left: rect.left + indent,
        top: cursorY,
        width: Math.max(1, rect.width - indent),
        height: 0,
      };
      rects.set(nested.id, nestedRect);
      cursorY = stackListItemRects(nested.items, nestedRect, charsPerLine, depth + 1, rects);
      nestedRect.height = cursorY - nestedRect.top;
    }
  }

  return cursorY;
}

/**
 * 局所段組みの子ブロック。実レンダラと同じく「1段目を埋めたら次の段」で流すが、
 * 段の高さは推定合計を段数で割った目安で、段間は矩形幅の等分で近似する。
 */
function collectLayoutSectionChildRects(
  block: Extract<SigmaBlock, { type: "layoutSection" }>,
  rect: EstimatedBlockRect,
  charsPerLine: number,
  rects: Map<string, EstimatedBlockRect>,
): void {
  const columnCount = Number.isInteger(block.layout.columnCount)
    ? Math.min(4, Math.max(1, block.layout.columnCount))
    : 2;
  const columnCharsPerLine = Math.max(12, Math.floor(charsPerLine / columnCount));
  const columnWidth = rect.width / columnCount;
  const columnHeight = Math.max(
    1,
    sumChildHeights(block.children, columnCharsPerLine) / columnCount,
  );

  let columnIndex = 0;
  let cursorY = rect.top;
  for (const child of block.children) {
    const height = estimateBlockHeightPx(child, columnCharsPerLine);
    if (cursorY > rect.top && cursorY - rect.top + height > columnHeight && columnIndex < columnCount - 1) {
      columnIndex += 1;
      cursorY = rect.top;
    }
    const childRect: EstimatedBlockRect = {
      id: child.id,
      left: rect.left + columnIndex * columnWidth,
      top: cursorY,
      width: columnWidth,
      height,
    };
    rects.set(child.id, childRect);
    collectNestedBlockRects(child as SigmaBlock, childRect, columnCharsPerLine, rects);
    cursorY += height;
  }
}

function stackChildRects(
  children: readonly { id: string }[],
  left: number,
  top: number,
  width: number,
  charsPerLine: number,
  rects: Map<string, EstimatedBlockRect>,
): void {
  let cursorY = top;
  for (const child of children) {
    const height = estimateBlockHeightPx(child as SigmaBlock, charsPerLine);
    const childRect: EstimatedBlockRect = { id: child.id, left, top: cursorY, width, height };
    rects.set(child.id, childRect);
    collectNestedBlockRects(child as SigmaBlock, childRect, charsPerLine, rects);
    cursorY += height;
  }
}

function sumChildHeights(children: readonly { id: string }[], charsPerLine: number): number {
  return children.reduce((height, child) => height + estimateBlockHeightPx(child as SigmaBlock, charsPerLine), 0);
}

function isTopLevelTextFlowBlock(block: SigmaBlock): boolean {
  return block.type === "section"
    || block.type === "heading"
    || block.type === "paragraph"
    || block.type === "list"
    || block.type === "quote"
    || block.type === "codeBlock"
    || block.type === "divider"
    || block.type === "boxBlock";
}
