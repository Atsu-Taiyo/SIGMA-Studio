import type { CSSProperties } from "react";

import {
  type TextFlowBoxFragmentSourceLayout,
} from "@/components/editor/TextFlowEditor";
import {
  isProblemAreaFlowEligible,
  type TextFlowColumnBlockLayout,
} from "@/features/rendering/core";
import {
  getTextFlowBlockIds,
  isTextFlowBlock,
  type TextFlowBlock,
} from "@/features/text-editing";
import {
  mmToPx,
  type PageMetrics,
  type LayoutSectionNode,
  type ProblemAreaColumnSpan,
  type ProblemAreaKind,
  type ProblemNode,
  type RichBlock,
  type SigmaBlock,
  type SigmaCommentThread,
  type HeadingNumberingConfig,
} from "@/features/document";
import { getProblemNumberMap } from "@/lib/problem-numbering";
import { getHeadingNumberMap } from "@/lib/heading-numbering";
import {
  chunkTextRun,
  type ChunkBoundaryState,
} from "./text-run-chunking";
import {
  cloneTextFlowBlock,
  emptyProblemAreaEditorBlockId,
  hasBreakBefore,
  isProblemFrameArea,
  PROBLEM_AREA_ORDER,
  problemAreaBlocksForEditor,
  problemAreaDraftKey,
  shouldShowProblemArea,
} from "./block-ops";
import type { FlowUnitLayout, RenderUnit } from "./types";

export function buildProblemAreaOwnerByBlockId(
  units: readonly RenderUnit[],
): Map<string, Extract<RenderUnit, { type: "problemArea" | "problemLayoutSection" }>> {
  const owners = new Map<string, Extract<RenderUnit, { type: "problemArea" | "problemLayoutSection" }>>();
  for (const unit of units) {
    if (unit.type !== "problemArea" && unit.type !== "problemLayoutSection") {
      continue;
    }
    if (unit.type === "problemLayoutSection") {
      owners.set(unit.section.id, unit);
    }
    if (unit.type === "problemArea" && unit.blocks.length === 0) {
      owners.set(emptyProblemAreaEditorBlockId(unit.problem.id, unit.area), unit);
    }
    for (const block of unit.blocks) {
      owners.set(block.id, unit);
    }
  }
  return owners;
}

/**
 * 本文を描画単位に切り分ける。
 *
 * `previousChunks` を渡すと、本文の連なりは**前回と同じ境界**で切り直される
 * (`text-run-chunking.ts`)。渡さない場合はこれまでどおり先頭から一定件数ごとに切る。
 * ユニット id の意味は変わらず「そのユニットの先頭ブロック id」で、`data-flow-unit-id` や
 * 適用済み gap の索引はそのまま使える。
 *
 * `pinnedChunkAnchors` はフォーカス中のユニット id (= 先頭ブロック id)。跨ぎ選択の IME
 * 合成が他ユニットの担当分を先に削除したとき、小チャンク併合がフォーカス中のエディタを
 * unmount / setContent しないよう、その境界だけ併合を見送る (`chunkTextRun`)。
 */
export function buildRenderUnits(
  content: SigmaBlock[],
  previousChunks: ChunkBoundaryState | null = null,
  pinnedChunkAnchors: ReadonlySet<string> | null = null,
  headingNumbering?: HeadingNumberingConfig,
): RenderUnit[] {
  const units: RenderUnit[] = [];
  let textRun: TextFlowBlock[] = [];
  const problemNumbers = getProblemNumberMap(content);
  const headingNumbers = getHeadingNumberMap(content, headingNumbering);

  const flushTextRun = () => {
    if (textRun.length === 0) {
      return;
    }

    for (const chunk of chunkTextRun(textRun, previousChunks, undefined, pinnedChunkAnchors)) {
      units.push({
        type: "textFlow",
        id: chunk[0].id,
        blocks: chunk,
        headingNumbers: pickHeadingNumbers(chunk, headingNumbers),
      });
    }
    textRun = [];
  };

  for (const block of content) {
    if (hasBreakBefore(block)) {
      flushTextRun();
    }

    if (isTextFlowBlock(block)) {
      textRun.push(block);
      continue;
    }

    flushTextRun();
    if (block.type === "layoutSection") {
      units.push({
        type: "layoutSection",
        id: block.id,
        section: block,
        blocks: block.children.map(cloneTextFlowBlock),
        headingNumbers: pickHeadingNumbers(block.children, headingNumbers),
      });
      continue;
    }

    if (block.type === "problem") {
      units.push(...problemToAreaUnits(block, undefined, problemNumbers.get(block.id)));
      continue;
    }
  }

  flushTextRun();
  return units;
}

function pickHeadingNumbers(
  blocks: readonly { id: string }[],
  numbers: ReadonlyMap<string, string>,
): Readonly<Record<string, string>> {
  const picked: Record<string, string> = {};
  for (const block of blocks) {
    const number = numbers.get(block.id);
    if (number) {
      picked[block.id] = number;
    }
  }
  return picked;
}

export function problemToAreaUnits(problem: ProblemNode, index?: number, problemNumber?: number): RenderUnit[] {
  const areas = PROBLEM_AREA_ORDER.filter((area) => shouldShowProblemArea(problem, area));
  const frameAreas = areas.filter(isProblemFrameArea);
  const firstFrameArea = frameAreas[0];
  const lastFrameArea = frameAreas.at(-1);

  const units: RenderUnit[] = [];
  areas.forEach((area, areaUnitIndex) => {
    const areaUnitsStart = units.length;
    const blocks = problemAreaBlocksForEditor(problem, area);
    const base = {
      problem,
      area,
      problemNumber,
      isFirstProblemArea: areaUnitIndex === 0,
      isLastProblemArea: areaUnitIndex === areas.length - 1,
      isFirstProblemFrameArea: area === firstFrameArea,
      isLastProblemFrameArea: area === lastFrameArea,
    };
    let textRun: TextFlowBlock[] = [];
    let subIndex = 0;
    let showedAreaSideNote = false;

    const flushTextRun = () => {
      if (textRun.length === 0) {
        return;
      }
      units.push({
        type: "problemArea",
        id: renderUnitId(problemAreaDraftKey(problem.id, area), (index ?? areaIndex(area)) * 100 + subIndex),
        ...base,
        isFirstProblemAreaUnit: subIndex === 0,
        problemAreaUnitCount: 0,
        blocks: textRun,
      });
      textRun = [];
      subIndex += 1;
      showedAreaSideNote = true;
    };

    for (const block of blocks) {
      if (block.type !== "layoutSection") {
        textRun.push(block);
        continue;
      }
      flushTextRun();
      units.push({
        type: "problemLayoutSection",
        id: block.id,
        ...base,
        isFirstProblemAreaUnit: subIndex === 0,
        problemAreaUnitCount: 0,
        section: block,
        blocks: block.children.map(cloneTextFlowBlock),
        headingNumbers: {},
        showAreaSideNote: !showedAreaSideNote,
      });
      subIndex += 1;
      showedAreaSideNote = true;
    }

    flushTextRun();
    const problemAreaUnitCount = units.length - areaUnitsStart;
    for (let unitIndex = areaUnitsStart; unitIndex < units.length; unitIndex += 1) {
      const unit = units[unitIndex];
      if (unit.type === "problemArea" || unit.type === "problemLayoutSection") {
        unit.problemAreaUnitCount = problemAreaUnitCount;
      }
    }
  });

  return units;
}

function areaIndex(area: ProblemAreaKind): number {
  return PROBLEM_AREA_ORDER.indexOf(area);
}

export function renderUnitId(blockId: string, index: number): string {
  return `${blockId}:${index}`;
}

/** 1段組で problem-level margin を消費できるのは、文書上の先頭エリアの先頭unitだけ。 */
export function getProblemAreaUnitGapKey(
  unit: Extract<RenderUnit, { type: "problemArea" | "problemLayoutSection" }>,
): string {
  return unit.type === "problemArea" && unit.isFirstProblemArea && unit.isFirstProblemAreaUnit
    ? unit.problem.id
    : unit.id;
}

/** 共有wrapperの無いlayout-section単体エリアだけ、1段組DOM自身が予約高を担う。 */
export function getSingleColumnProblemLayoutSectionMinHeightMm(
  unit: Extract<RenderUnit, { type: "layoutSection" | "problemLayoutSection" }>,
  isColumnFlow: boolean,
): number {
  return !isColumnFlow && unit.type === "problemLayoutSection" && unit.problemAreaUnitCount === 1
    ? unit.problem.areaLayout?.[unit.area]?.minHeightMm ?? 0
    : 0;
}

export function getFlowUnitStyle(
  unit: RenderUnit,
  isColumnFlow: boolean,
  unitLayouts: Record<string, FlowUnitLayout>,
  metrics: PageMetrics,
): CSSProperties | undefined {
  if (!isColumnFlow) {
    return undefined;
  }

  const layout = unitLayouts[unit.id];
  if (!layout) {
    return {
      ...getFlowLayoutStyle({
        x: metrics.margins.leftPx,
        y: metrics.margins.topPx,
        width: isFullSpanUnit(unit) ? metrics.content.widthPx : metrics.flow.columnWidthPx,
      }),
      visibility: "hidden",
    };
  }

  return {
    ...getFlowLayoutStyle(layout),
  };
}

export function getFlowLayoutStyle(layout: FlowUnitLayout): CSSProperties {
  return {
    left: `${layout.x}px`,
    top: `${layout.y}px`,
    width: `${layout.width}px`,
    ...(typeof layout.height === "number" ? { height: `${layout.height}px` } : {}),
  };
}

export function getProblemAreaSideNoteOffsetPx(
  unit: Extract<RenderUnit, { type: "problemArea" | "layoutSection" | "problemLayoutSection" }>,
  isColumnFlow: boolean,
  layouts: Record<string, FlowUnitLayout>,
  metrics: PageMetrics,
  blockLayouts?: Record<string, TextFlowColumnBlockLayout>,
): number | undefined {
  if (!isColumnFlow) {
    return undefined;
  }

  const layout = layouts[unit.id];
  if (!layout) {
    return undefined;
  }

  const firstBlockLayout = unit.type === "problemArea" && unit.blocks.length > 0
    ? blockLayouts?.[unit.blocks[0].id]
    : undefined;
  const referenceX = layout.x + (firstBlockLayout?.x ?? 0);

  return getPageColumnSideNoteOffsetPx(layout.x, referenceX, metrics);
}

/**
 * Positions a side note immediately before the outer page column containing
 * referenceX. The anchor may be inset from that column (for example by a box),
 * so the returned offset compensates for that inset instead of treating the
 * nested section itself as the page-column edge.
 */
export function getPageColumnSideNoteOffsetPx(
  anchorX: number,
  referenceX: number,
  metrics: PageMetrics,
): number {
  const columnStep = metrics.flow.columnWidthPx + metrics.flow.columnGapPx;
  const columnIndex = columnStep > 0
    ? Math.max(
        0,
        Math.min(
          metrics.flow.columnCount - 1,
          Math.round((referenceX - metrics.margins.leftPx) / columnStep),
        ),
      )
    : 0;

  if (columnIndex === 0) {
    return anchorX;
  }

  const columnLeft = metrics.margins.leftPx + columnIndex * columnStep;
  return anchorX - columnLeft + Math.max(0, metrics.flow.columnGapPx / 2);
}

export function getTextFlowColumnBlockLayouts(
  unit: Extract<RenderUnit, { type: "textFlow" }>,
  layouts: Record<string, TextFlowColumnBlockLayout>,
): Record<string, TextFlowColumnBlockLayout> | undefined {
  return pickTextFlowColumnBlockLayouts(unit.blocks, layouts);
}

export function pickTextFlowColumnBlockLayouts(
  blocks: TextFlowBlock[],
  layouts: Record<string, TextFlowColumnBlockLayout> | undefined,
): Record<string, TextFlowColumnBlockLayout> | undefined {
  if (!layouts) {
    return undefined;
  }

  const picked: Record<string, TextFlowColumnBlockLayout> = {};
  for (const block of blocks) {
    const layout = layouts[block.id];
    if (layout) {
      picked[block.id] = layout;
    }
  }

  return Object.keys(picked).length > 0 ? picked : undefined;
}

export function pickTextFlowBoxFragmentSourceLayouts(
  blocks: TextFlowBlock[],
  layouts: Record<string, TextFlowBoxFragmentSourceLayout> | undefined,
): Record<string, TextFlowBoxFragmentSourceLayout> | undefined {
  if (!layouts) {
    return undefined;
  }

  const picked: Record<string, TextFlowBoxFragmentSourceLayout> = {};
  for (const block of blocks) {
    const layout = layouts[block.id];
    if (layout) {
      picked[block.id] = layout;
    }
  }

  return Object.keys(picked).length > 0 ? picked : undefined;
}

export function isFullSpanUnit(unit: RenderUnit): boolean {
  return (unit.type === "problemArea" || unit.type === "problemLayoutSection") &&
    getProblemAreaColumnSpan(unit.problem, unit.area) === "full";
}

export function isProblemAreaColumnBlockFlowEligible(
  unit: Extract<RenderUnit, { type: "problemArea" }>,
  gapFreeHeightPx: number,
  segmentHeightPx: number,
): boolean {
  return isProblemAreaFlowEligible({
    isFullSpan: isFullSpanUnit(unit),
    isFramedArea: unit.problem.frame?.enabled === true && isProblemFrameArea(unit.area),
    blocks: unit.blocks,
    gapFreeHeightPx,
    segmentHeightPx,
  });
}

function getProblemAreaColumnSpan(problem: ProblemNode, area: ProblemAreaKind): ProblemAreaColumnSpan {
  return problem.areaLayout?.[area]?.columnSpan ?? "column";
}

export function getLayoutSectionColumnCount(section: LayoutSectionNode): number {
  const columnCount = section.layout.columnCount;
  return typeof columnCount === "number" && Number.isInteger(columnCount)
    ? Math.min(4, Math.max(1, columnCount))
    : 2;
}

export function getLayoutSectionColumnGapPx(
  section: LayoutSectionNode,
  fallbackGapMm: number,
  fallbackGapPx: number,
): number {
  const sectionGapMm = section.layout.columnGapMm;
  if (typeof sectionGapMm === "number" && Number.isFinite(sectionGapMm) && sectionGapMm >= 0) {
    return mmToPx(sectionGapMm);
  }
  return fallbackGapPx || mmToPx(fallbackGapMm);
}

export function getFirstUnitBlock(unit: RenderUnit): SigmaBlock | RichBlock {
  if (unit.type === "textFlow") {
    return unit.blocks[0];
  }

  if (unit.type === "problemArea") {
    return unit.area === "prompt" ? unit.problem : unit.blocks[0] ?? unit.problem;
  }

  if (unit.type === "layoutSection" || unit.type === "problemLayoutSection") {
    return unit.section;
  }

  return unit.block;
}

/** 前回と同じ中身のユニットは、前回のオブジェクトをそのまま返す。 */
export function reconcileRenderUnits(
  previous: readonly RenderUnit[],
  next: RenderUnit[],
): RenderUnit[] {
  if (previous.length === 0) {
    return next;
  }

  const previousById = new Map(previous.map((unit) => [unit.id, unit]));
  let previousTextByBlockId: Map<string, Extract<RenderUnit, { type: "textFlow" }>> | undefined;
  const nextIds = new Set(next.map((unit) => unit.id));
  // Reserve existing units' keys first, so a split never steals its neighbour's editor.
  const usedKeys = new Set(next.flatMap((unit) => {
    const before = previousById.get(unit.id);
    return unit.type === "textFlow" && before?.type === "textFlow" ? [before.renderKey ?? before.id] : [];
  }));
  return next.map((unit) => {
    const before = previousById.get(unit.id);
    if (before && isSameRenderUnit(before, unit)) return before;
    if (unit.type !== "textFlow") return unit;
    if (before?.type === "textFlow") {
      return before.renderKey ? { ...unit, renderKey: before.renderKey } : unit;
    }
    previousTextByBlockId ??= new Map(previous.flatMap((previousUnit) => previousUnit.type === "textFlow"
      ? previousUnit.blocks.map((block) => [block.id, previousUnit] as const) : []));
    const surviving = unit.blocks.map((block) => previousTextByBlockId!.get(block.id))
      .find((candidate) => candidate && !nextIds.has(candidate.id) && !usedKeys.has(candidate.renderKey ?? candidate.id));
    let key = surviving ? surviving.renderKey ?? surviving.id : unit.id;
    let suffix = 2;
    while (usedKeys.has(key)) key = `${unit.id}:render:${suffix++}`;
    usedKeys.add(key);
    return key === unit.id ? unit : { ...unit, renderKey: key };
  });
}

/**
 * 「描き直す必要が無い」= 同じ型・同じブロック列 (**識別子で**) ・同じ付随情報。
 *
 * SigmaDoc の更新は不変更新なので、触っていないブロックは前回と同じオブジェクトのまま来る。
 * 逆に言うと、ここで内容比較 (deep equal) をする必要はない — identity で足りるし、
 * 打鍵のたびに全ブロックを走査するコストも掛からない。
 */
function isSameRenderUnit(previous: RenderUnit, next: RenderUnit): boolean {
  if (previous === next) {
    return true;
  }
  if (previous.type !== next.type || previous.id !== next.id) {
    return false;
  }
  // **ブロック列を identity で比べてよいのは textFlow だけ**。問題エリアと段組みのブロックは
  // `cloneTextFlowBlock` で毎回作り直されるので、identity 比較は必ず false になる。代わりに
  // 「そのクローンの出所」(problem / section とエリア種別) が同じなら中身も同じ、と判断する。
  if (previous.type === "textFlow" && next.type === "textFlow") {
    return isSameBlockList(previous.blocks, next.blocks)
      && isSameHeadingNumbers(previous.headingNumbers, next.headingNumbers);
  }
  if (previous.type === "problemArea" && next.type === "problemArea") {
    return previous.problem === next.problem
      && previous.area === next.area
      // 問題番号は本文の並びから採番されるので、problem オブジェクトが同じでも変わりうる。
      && previous.problemNumber === next.problemNumber
      && previous.isFirstProblemArea === next.isFirstProblemArea
      && previous.isLastProblemArea === next.isLastProblemArea
      && previous.isFirstProblemAreaUnit === next.isFirstProblemAreaUnit
      && previous.problemAreaUnitCount === next.problemAreaUnitCount
      && previous.isFirstProblemFrameArea === next.isFirstProblemFrameArea
      && previous.isLastProblemFrameArea === next.isLastProblemFrameArea;
  }
  if (previous.type === "layoutSection" && next.type === "layoutSection") {
    return previous.section === next.section
      && isSameHeadingNumbers(previous.headingNumbers, next.headingNumbers);
  }
  if (previous.type === "problemLayoutSection" && next.type === "problemLayoutSection") {
    return previous.section === next.section
      && previous.problem === next.problem
      && previous.area === next.area
      && previous.problemNumber === next.problemNumber
      && previous.isFirstProblemArea === next.isFirstProblemArea
      && previous.isLastProblemArea === next.isLastProblemArea
      && previous.isFirstProblemAreaUnit === next.isFirstProblemAreaUnit
      && previous.problemAreaUnitCount === next.problemAreaUnitCount
      && previous.isFirstProblemFrameArea === next.isFirstProblemFrameArea
      && previous.isLastProblemFrameArea === next.isLastProblemFrameArea
      && previous.showAreaSideNote === next.showAreaSideNote
      && isSameHeadingNumbers(previous.headingNumbers, next.headingNumbers);
  }
  if (previous.type === "block" && next.type === "block") {
    return previous.block === next.block;
  }
  return false;
}

function isSameHeadingNumbers(
  previous: Readonly<Record<string, string>> = {},
  next: Readonly<Record<string, string>> = {},
): boolean {
  const previousEntries = Object.entries(previous);
  return previousEntries.length === Object.keys(next).length
    && previousEntries.every(([id, number]) => Object.hasOwn(next, id) && next[id] === number);
}

function isSameBlockList(previous: readonly TextFlowBlock[], next: readonly TextFlowBlock[]): boolean {
  return previous.length === next.length && previous.every((block, index) => block === next[index]);
}

/**
 * コメントの無いユニットが毎回同じ参照を受け取れるよう、空配列は 1 つだけ使う。
 * 全ユニットで共有する 1 個なので凍結しておく (誰かが push すると全ユニットに漏れる)。
 */
const EMPTY_UNIT_COMMENT_THREADS = Object.freeze([]) as unknown as SigmaCommentThread[];

/**
 * そのユニットが描くブロックの gap だけを渡す。
 *
 * ページ全体の gap を渡すと、別のページの改ページが 1mm 動いただけで全ユニットの props が
 * 変わり、memo が効かない。入れ子のブロック (箱の中身など) にも gap が付くので id は深く集める。
 */
export function pickUnitBreakGaps(
  blocks: TextFlowBlock[],
  gaps: Record<string, number> | undefined,
): Record<string, number> | undefined {
  if (!gaps) {
    return undefined;
  }

  const picked: Record<string, number> = {};
  for (const blockId of getTextFlowBlockIds(blocks)) {
    const gap = gaps[blockId];
    if (gap !== undefined) {
      picked[blockId] = gap;
    }
  }

  return Object.keys(picked).length > 0 ? picked : undefined;
}

/**
 * そのユニットに装飾が届きうるコメントだけを渡す。
 *
 * 装飾はブロックに紐づくアンカー (block / inlineMath / textRange) しか描けないので、それ以外の
 * スレッドを渡しても仕事は増えるだけ。範囲コメントは**両端を持つユニット**にだけ渡す —
 * 端が片方しか無いユニットは順序表から範囲を解決できず、渡しても何も描けない。
 */
export function pickUnitCommentThreads(
  blocks: TextFlowBlock[],
  threads: readonly SigmaCommentThread[],
): SigmaCommentThread[] {
  if (threads.length === 0) {
    return EMPTY_UNIT_COMMENT_THREADS;
  }

  const blockIds = new Set(getTextFlowBlockIds(blocks));
  const picked = threads.filter((thread) => {
    const anchor = thread.anchor;
    switch (anchor.type) {
      case "block":
      case "inlineMath":
        return blockIds.has(anchor.blockId);
      case "textRange":
        // 装飾側は順序表に**両端**が無いと範囲を解決できない (`getOrderedTextRange`)。
        return blockIds.has(anchor.start.blockId) && blockIds.has(anchor.end.blockId);
      default:
        return false;
    }
  });

  return picked.length > 0 ? picked : EMPTY_UNIT_COMMENT_THREADS;
}
