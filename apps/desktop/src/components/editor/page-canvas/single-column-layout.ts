import { blockSpaceAfterPx, type PageMetrics, type SigmaBlock } from "@/features/document";
import { computeProblemAreaColumnFlow, getFlowBlockStartHeight } from "@/features/rendering/core";
import { boxBlockTitleText, boxFragmentMinStartHeightPx, resolveBoxFrame } from "@/lib/box-blocks";
import { collectBlocksById } from "@/lib/document-tree";
import { getProblemFrameChromePaddingPx } from "@/lib/problem-frame";

import type { TextFlowBoxFragmentSourceLayout } from "../text-flow/types";
import { buildAppliedGapIndex, readAppliedGapPx, readInnerSpacerHeightPx, type AppliedGapIndex, type AppliedGapItem } from "./applied-gaps";
import { emptyProblemAreaEditorBlockId, isProblemFrameArea } from "./block-ops";
import {
  createSingleColumnBoxFragments,
  getBlockFragmentBreakOffsetsFromMeasured,
  getBoxFragmentBreakOffsetsFromMeasuredBox,
  getBoxManualBreakOffsetsFromMeasuredBox,
  getPageCountForBottom,
  getPageIndexForY,
  isFlowBlockFragmentable,
} from "./column-layout";
import type { FlowMeasurement } from "./incremental-layout";
import { roundEditorBoxBlockFragmentLayout } from "./layout-measure";
import { decidePagination, type PaginationCursorMove, type PaginationItem, type PaginationPlacement } from "./pagination-decisions";
import { collectProblemAreaColumnInputs, type ProblemAreaColumnInput } from "./problem-area-flow";
import { collectProblemAreaPaginationItems, type AtomicProblemAreaItem, type ReservedProblemAreaEndItem } from "./problem-area-pagination";
import { buildProblemAreaOwnerByBlockId, getProblemAreaUnitGapKey } from "./render-units";
import type { EditorBoxBlockFragmentLayout, ProblemAreaColumnLayout, ProblemAreaFrameFragmentLayout, RenderUnit } from "./types";

interface SingleColumnLayoutInput {
  content: SigmaBlock[];
  flow: HTMLElement;
  units: RenderUnit[];
  metrics: PageMetrics;
  pageHeightPx: number;
  pageStride: number;
  zoomFactor: number;
  marginTopPx: number;
  contentHeightPx: number;
  reserveSpaceGaps: Record<string, number>;
  measurement: FlowMeasurement;
  measuredAppliedGaps: AppliedGapIndex | null;
}

interface SingleColumnLayouts {
  gaps: Record<string, number>;
  pageCount: number;
  boxBlockFragmentLayouts: Record<string, EditorBoxBlockFragmentLayout[]>;
  boxFragmentSourceLayouts: Record<string, TextFlowBoxFragmentSourceLayout>;
  frameFragmentLayouts: Record<string, ProblemAreaFrameFragmentLayout[]>;
  areaLayouts: Record<string, ProblemAreaColumnLayout>;
}

type WalkItem =
  | { kind: "block"; id: string; measuredTop: number; height: number }
  | { kind: "atomicProblemArea"; area: AtomicProblemAreaItem; measuredTop: number }
  | { kind: "reservedAreaEnd"; boundary: ReservedProblemAreaEndItem; measuredTop: number }
  | { kind: "area"; area: ProblemAreaColumnInput; measuredTop: number };

/**
 * 1 段本文の実測から、現在 DOM に適用されている gap を除いた配置入力を作る。
 * ページ割りの凍結判定はこの計測の後、配置計算の前にコントローラーが行う。
 */
export function measureSingleColumnLayoutInput(input: SingleColumnLayoutInput) {
  const { content, flow, units, metrics, zoomFactor, marginTopPx, contentHeightPx, reserveSpaceGaps, measurement, measuredAppliedGaps } = input;
  const { ordered, extents } = measurement;
  // Recursive (not just top-level) so manual page-break hints on blocks nested inside a
  // problem area / layoutSection are honored here too — those render their own editor, so
  // `ordered`/`walkItems` already include them as flow units.
  const blockById = collectBlocksById(content);
  const flowRect = flow.getBoundingClientRect();
  // 適用済み gap とフローユニット要素を 1 パスで索引化する。walk する項目ごとに
  // querySelector していたのが打鍵ごとの rAF recompute を数十 ms にしていた本体。
  const appliedGaps = measuredAppliedGaps ?? buildAppliedGapIndex(flow);

  // Problem areas whose internal columns may continue across a page break are
  // paginated atomically: their inner blocks are flowed col→col→next-page by an
  // absolute layout, so the gap-spacer treats the whole area as one item.
  const columnAreas = collectProblemAreaColumnInputs(
    appliedGaps.unitElementByUnitId,
    flowRect,
    units,
    extents,
    zoomFactor,
    metrics.flow.columnGapPx,
    metrics.flow.columnGapMm,
  );
  const columnOwnedBlockIds = new Set<string>();
  for (const area of columnAreas) {
    columnOwnedBlockIds.add(area.sectionBlockId);
    for (const id of area.blockIds) {
      columnOwnedBlockIds.add(id);
    }
  }

  // Atomicity belongs to an area, not to the whole problem. The frame exists only on
  // prompt; hints/solution must otherwise return to the ordinary block walk so a long
  // answer can cross pages. A one-page minHeight reservation is also kept with its area,
  // because that blank space exists only on the section DOM, not on its paragraphs.
  const problemAreaPaginationItems = collectProblemAreaPaginationItems(
    appliedGaps,
    flowRect,
    units,
    zoomFactor,
    contentHeightPx,
  );
  const atomicProblemAreas = problemAreaPaginationItems.atomicItems;
  const splitFrameEndSpaceByBlockId = new Map<string, number>();
  for (const frameUnit of problemAreaPaginationItems.splitFrameUnits) {
    const unit = units.find((candidate) => candidate.id === frameUnit.unitId);
    if (unit?.type !== "problemArea") {
      continue;
    }
    const endSpacePx = getProblemFrameChromePaddingPx(unit.problem.frame?.styleId).y;
    for (const blockId of frameUnit.blockIds) {
      splitFrameEndSpaceByBlockId.set(blockId, endSpacePx);
    }
  }
  const atomicOwnedIds = new Set<string>();
  for (const area of atomicProblemAreas) {
    for (const id of area.ownedBlockIds) {
      atomicOwnedIds.add(id);
    }
  }
  const problemAreaUnitById = new Map(units.flatMap((unit) => (
    unit.type === "problemArea" || unit.type === "problemLayoutSection"
      ? [[unit.id, unit] as const]
      : []
  )));
  const problemAreaOwnerByBlockId = buildProblemAreaOwnerByBlockId(units);

  const walkItems: WalkItem[] = [];
  for (const area of atomicProblemAreas) {
    walkItems.push({ kind: "atomicProblemArea", area, measuredTop: area.top });
  }
  for (const boundary of problemAreaPaginationItems.reservedAreaEnds) {
    walkItems.push({ kind: "reservedAreaEnd", boundary, measuredTop: boundary.top });
  }
  for (const block of ordered) {
    if (columnOwnedBlockIds.has(block.id) || atomicOwnedIds.has(block.id)) {
      continue;
    }
    walkItems.push({ kind: "block", id: block.id, measuredTop: block.top, height: extents.get(block.id)?.height ?? 0 });
  }
  for (const area of columnAreas) {
    if (atomicOwnedIds.has(area.sectionBlockId)) {
      continue;
    }
    walkItems.push({ kind: "area", area, measuredTop: area.sectionTop });
  }
  walkItems.sort((a, b) => {
    const byTop = a.measuredTop - b.measuredTop;
    if (Math.abs(byTop) > 0.5) {
      return byTop;
    }
    // エリア末尾と直後ブロックは同じ top になり得る。先に仮想境界を通し、予約高が
    // 通過したページ間 gap を後続ブロックの実在キャリアへ積む。
    return a.kind === "reservedAreaEnd" ? -1 : b.kind === "reservedAreaEnd" ? 1 : byTop;
  });

  // Natural (gap-independent) offsets relative to the content area top. Each
  // item's gap is keyed by its block id, or — for a column area — its unit id.
  let cumApplied = 0;
  let cumReserve = 0;
  const naturalItems = walkItems.map((item) => {
    const gapKey = walkItemGapKey(item, problemAreaOwnerByBlockId);
    // Read back what the DOM ACTUALLY carries above this item, not what the previous
    // pass asked for.
    //
    // `topNat` is meant to be the gap-free position, obtained by subtracting the
    // already-applied gaps out of the measured top. Taking those from the state map
    // assumed the DOM had caught up with it — but a recompute can land between the
    // state update and React committing it, and then the two disagree. `topNat` stops
    // being gap-free, the page-fit tests inherit the previous pass's answer, and the
    // document ends up with more than one self-consistent layout: two mounts of the
    // same engine settled on different ones (2px apart, or a whole page when a manual
    // break was skipped as "already first on the page").
    //
    // The rendered spacer or margin cannot disagree with the measurement it is being
    // subtracted from, so this converges regardless of when the pass runs.
    if (item.kind !== "reservedAreaEnd") {
      cumApplied += readAppliedGapPx(
        appliedGaps,
        appliedGapItem(item, problemAreaOwnerByBlockId),
      );
    }
    cumReserve += reserveSpaceGaps[gapKey] ?? 0;
    return {
      item,
      gapKey,
      // Remove the previous render's full margin and add the current
      // shape-height-derived reserve gap. This keeps reflow stable even
      // when a reserved figure's persisted h changes between measures.
      topNat: item.measuredTop
        - marginTopPx
        - cumApplied
        + cumReserve
        + (item.kind === "reservedAreaEnd" ? item.boundary.naturalTopAdjustmentPx : 0),
    };
  });

  return {
    ...input,
    appliedGaps,
    blockById,
    flowRect,
    naturalItems,
    problemAreaOwnerByBlockId,
    problemAreaPaginationItems,
    problemAreaUnitById,
    splitFrameEndSpaceByBlockId,
  };
}

/**
 * 本文・問題エリア・枠の配置を同じページ割りパスで計算する。
 * 入れ子の段組と枠の DOM 実測を含む。React の状態採用や再計測の制御は持たない。
 */
export function computeSingleColumnLayouts(
  input: ReturnType<typeof measureSingleColumnLayoutInput>,
): SingleColumnLayouts {
  const {
    appliedGaps, blockById, contentHeightPx, flowRect, marginTopPx, measurement,
    metrics, naturalItems, pageHeightPx, pageStride, problemAreaOwnerByBlockId,
    problemAreaPaginationItems, problemAreaUnitById, reserveSpaceGaps,
    splitFrameEndSpaceByBlockId, zoomFactor,
  } = input;
  const { rects: blockCanvasRects } = measurement;
  const nextBoxBlockFragmentLayouts: SingleColumnLayouts["boxBlockFragmentLayouts"] = {};
  const nextBoxFragmentSourceLayouts: SingleColumnLayouts["boxFragmentSourceLayouts"] = {};
  const nextFrameFragmentLayouts: SingleColumnLayouts["frameFragmentLayouts"] = {};
  const nextAreaLayouts: SingleColumnLayouts["areaLayouts"] = {};
  let maxAreaBottom = 0;
  let maxBoxFragmentBottom = 0;

  // 判定は `page-canvas/pagination-decisions.ts` の純関数へ。DOM の実測 (フラグメント
  // 分割・段組フロー) だけをフックで返し、ページカーソルの扱いは 1 か所に集約する。
  const walkItemByPaginationItem = new Map<PaginationItem, WalkItem>();
  const paginationItems = naturalItems.map(({ item, gapKey, topNat }, itemIndex): PaginationItem => {
    let paginationItem: PaginationItem;
    if (item.kind === "atomicProblemArea") {
      paginationItem = {
        kind: "atomicProblemArea",
        gapKey,
        topNat,
        height: item.area.height,
        reservedHeightDeficitPx: item.area.reservedHeightDeficitPx,
        forceBreakBefore: item.area.forceBreakBefore,
      };
    } else if (item.kind === "reservedAreaEnd") {
      paginationItem = { kind: "reservedAreaEnd", gapKey, topNat, height: 0 };
    } else if (item.kind === "area") {
      const firstBlock = item.area.blockHeights[0];
      const firstBlockHeight = firstBlock?.height ?? 0;
      const firstBlockFragmentable = isFlowBlockFragmentable(
        firstBlock?.type ? { type: firstBlock.type } : undefined,
        Math.max(0, firstBlockHeight - (firstBlock?.trailingSpacePx ?? 0)),
        contentHeightPx,
        firstBlock?.breakOffsets,
      );
      paginationItem = {
        kind: "area",
        gapKey,
        topNat,
        height: 0,
        contentOffset: item.area.contentOffset,
        firstBlockHeight,
        firstBlockFragmentable,
        firstBlockMinStartHeightPx: firstBlock?.type === "boxBlock"
          ? firstBlock.minStartHeightPx ?? 0
          : firstBlock?.breakOffsets?.[0] ?? 0,
      };
    } else {
      const block = blockById.get(item.id);
      // ListItemNode (from collectBlocksById's recursion into list items) has no pagination
      // field of its own — break hints only ever live on the containing list/paragraph/etc.
      const blockPageBreak = block && block.type !== "listItem" ? block.pagination : undefined;
      const isBox = block?.type === "boxBlock" && item.height > 0;
      // 実測 height にはブロック下余白 (padding) が入っている。ページに「収まるか」は
      // 本文だけで決めたい (余白で溢れたら送るのは次のブロック) ので、判定用の高さから
      // 余白を除く。ピクセル分割の要否も同じ高さで決める — 余白のせいで分割可能扱いに
      // なると、収まる本文がフラグメントに切られる。
      const trailingSpacePx = block ? blockSpaceAfterPx(block) : 0;
      const fitHeight = Math.max(0, item.height - trailingSpacePx);
      const fragmentEndSpacePx = splitFrameEndSpaceByBlockId.get(item.id) ?? 0;
      const isFragmentable = isFlowBlockFragmentable(
        block,
        fitHeight,
        contentHeightPx,
        getBlockFragmentBreakOffsetsFromMeasured(blockCanvasRects.get(item.id)),
      )
        || fitHeight + fragmentEndSpacePx > contentHeightPx + 0.5;
      const nextNaturalItem = naturalItems[itemIndex + 1]?.item;
      const nextBlock = nextNaturalItem?.kind === "block"
        ? blockById.get(nextNaturalItem.id)
        : undefined;
      const currentProblemArea = problemAreaOwnerByBlockId.get(item.id);
      const nextProblemArea = nextNaturalItem?.kind === "atomicProblemArea"
        ? problemAreaUnitById.get(nextNaturalItem.area.firstUnitId)
        : nextNaturalItem?.kind === "area"
          ? problemAreaUnitById.get(nextNaturalItem.area.unitId)
          : nextNaturalItem?.kind === "block"
            ? problemAreaOwnerByBlockId.get(nextNaturalItem.id)
            : undefined;
      const nextProblemAreaStartsWithBreak = nextNaturalItem?.kind === "area"
        ? nextNaturalItem.area.blockHeights[0]?.break === true
        : nextNaturalItem?.kind === "atomicProblemArea"
          ? nextNaturalItem.area.forceBreakBefore
        : nextNaturalItem?.kind === "block"
          ? nextBlock?.type !== "listItem" && nextBlock?.pagination?.break === true
          : false;
      const isImplicitLeadKeep = currentProblemArea?.area === "lead"
        && nextProblemArea?.problem.id === currentProblemArea.problem.id
        && nextProblemArea.area !== "lead"
        && !nextProblemAreaStartsWithBreak;
      const implicitLeadUnitId = isImplicitLeadKeep ? currentProblemArea?.id : undefined;
      const implicitLeadUnitElement = implicitLeadUnitId
        ? appliedGaps.unitElementByUnitId.get(implicitLeadUnitId)
        : undefined;
      // The keep starts at the lead unit, whose number marker and padding sit outside
      // the child block. Use the gap-free unit measurement so a short prompt cannot
      // leave only the problem number behind at the foot of the previous page.
      const implicitLeadUnitHeightPx = implicitLeadUnitId && implicitLeadUnitElement
        ? Math.max(
          0,
          implicitLeadUnitElement.getBoundingClientRect().height / zoomFactor
            - readInnerSpacerHeightPx(appliedGaps, implicitLeadUnitId),
        )
        : item.height;
      const nextProblemAreaFrameChromePx = isImplicitLeadKeep
        && nextNaturalItem?.kind !== "atomicProblemArea"
        && nextProblemArea.problem.frame?.enabled === true
        && isProblemFrameArea(nextProblemArea.area)
        ? getProblemFrameChromePaddingPx(nextProblemArea.problem.frame?.styleId).y * 2
        : 0;
      const implicitLeadKeepWithNextHeightPx = isImplicitLeadKeep
        ? implicitLeadUnitHeightPx + (
          nextNaturalItem?.kind === "atomicProblemArea"
            ? nextNaturalItem.area.height
            : nextNaturalItem?.kind === "area"
              ? Math.max(
                0,
                (nextNaturalItem.area.blockHeights[0]?.height ?? 0)
                  - (nextNaturalItem.area.blockHeights[0]?.trailingSpacePx ?? 0),
              )
                + nextProblemAreaFrameChromePx
              : nextNaturalItem?.kind === "block" && nextBlock && nextBlock.type !== "listItem"
                ? getFlowBlockStartHeight(
                  nextBlock,
                  Math.max(0, nextNaturalItem.height - blockSpaceAfterPx(nextBlock)),
                  contentHeightPx,
                  getBlockFragmentBreakOffsetsFromMeasured(blockCanvasRects.get(nextNaturalItem.id)),
                ) + nextProblemAreaFrameChromePx
                : 0
        )
        : 0;
      const explicitKeepWithNextHeightPx = blockPageBreak?.keepWithNext === true
        && nextNaturalItem?.kind === "block"
        && nextBlock?.type !== "listItem"
        && nextBlock?.pagination?.break !== true
        ? item.height + Math.max(0, nextNaturalItem.height - (nextBlock ? blockSpaceAfterPx(nextBlock) : 0))
        : 0;
      const keepWithNextHeightPx = Math.max(
        explicitKeepWithNextHeightPx,
        implicitLeadKeepWithNextHeightPx,
      );
      const measuredLineBreakOffsets = !isBox && isFragmentable
        ? getBlockFragmentBreakOffsetsFromMeasured(blockCanvasRects.get(item.id))
        : undefined;
      paginationItem = {
        kind: isFragmentable ? "fragmentableBlock" : "block",
        gapKey,
        topNat,
        height: item.height,
        ...(trailingSpacePx > 0 ? { trailingSpacePx } : {}),
        ...(fragmentEndSpacePx > 0 ? { fragmentEndSpacePx } : {}),
        forceBreakBefore: blockPageBreak?.break === true,
        ...(keepWithNextHeightPx > 0 ? { keepWithNextHeightPx } : {}),
        ...(blockPageBreak?.keepTogether === true ? { keepTogether: true } : {}),
        ...(isFragmentable
          ? {
            minStartHeightPx: isBox && block
              ? boxFragmentMinStartHeightPx(
                resolveBoxFrame(block),
                boxBlockTitleText(block).length > 0,
              )
              : measuredLineBreakOffsets?.[0] ?? 0,
          }
          : {}),
      };
    }
    walkItemByPaginationItem.set(paginationItem, item);
    return paginationItem;
  });

  const placeFragments = (
    blockId: string,
    height: number,
    actualTop: number,
    breakOffsets: number[] | undefined,
    placement: PaginationPlacement,
    topNat: number,
    fragmentEndSpacePx = 0,
    forcedBreakOffsets?: readonly number[],
  ): PaginationCursorMove | undefined => {
    const measured = blockCanvasRects.get(blockId);
    const fragments = createSingleColumnBoxFragments({
      blockId,
      height,
      metrics,
      pageHeightPx,
      pageStride,
      sourceTop: actualTop,
      width: measured?.width ?? metrics.content.widthPx,
      x: measured?.left ?? metrics.margins.leftPx,
      breakOffsets,
      forcedBreakOffsets,
      fragmentEndSpacePx,
    });
    if (fragments.length <= 1) {
      return undefined;
    }
    const firstFragment = fragments[0];
    const lastFragment = fragments[fragments.length - 1];
    nextBoxFragmentSourceLayouts[blockId] = {
      visibleHeight: firstFragment.height,
      origin: { x: firstFragment.x, y: firstFragment.y, width: firstFragment.width },
      totalHeight: height,
    };
    nextBoxBlockFragmentLayouts[blockId] = fragments.slice(1).map(roundEditorBoxBlockFragmentLayout);
    const lastBottom = lastFragment.y + lastFragment.height;
    maxBoxFragmentBottom = Math.max(maxBoxFragmentBottom, lastBottom);
    return {
      pageIndex: Math.max(placement.pageIndex, getPageIndexForY(lastFragment.y, pageStride)),
      pageStartNatural: topNat + lastFragment.sourceOffsetY,
      pendingGap: Math.max(0, lastBottom - (actualTop + height)),
    };
  };

  const splitFrameBlockVisuals = new Map<string, EditorBoxBlockFragmentLayout[]>();

  const paginationResult = decidePagination(
    paginationItems,
    { contentHeightPx, pageStride },
    reserveSpaceGaps,
    {
      onPlaced: (paginationItem, placement) => {
        const item = walkItemByPaginationItem.get(paginationItem);
        if (!item) {
          return undefined;
        }
        const topNat = paginationItem.topNat;
        const actualTop = marginTopPx + topNat + placement.cumGapPrev;

        if (item.kind === "block") {
          const block = blockById.get(item.id);
          if (!block) {
            return undefined;
          }
          if (block.type === "boxBlock" && item.height > 0) {
            const measured = blockCanvasRects.get(item.id);
            const move = placeFragments(
              item.id,
              item.height,
              actualTop,
              getBoxFragmentBreakOffsetsFromMeasuredBox(block, measured, blockCanvasRects),
              placement,
              topNat,
              paginationItem.fragmentEndSpacePx,
              getBoxManualBreakOffsetsFromMeasuredBox(block, measured, blockCanvasRects),
            );
            const source = nextBoxFragmentSourceLayouts[item.id];
            splitFrameBlockVisuals.set(item.id, source
              ? [{
                blockId: item.id,
                fragmentIndex: 0,
                sourceOffsetY: 0,
                height: source.visibleHeight,
                x: measured?.left ?? metrics.margins.leftPx,
                y: actualTop,
                width: measured?.width ?? metrics.content.widthPx,
                totalHeight: item.height,
              }, ...(nextBoxBlockFragmentLayouts[item.id] ?? [])]
              : [{
                blockId: item.id,
                fragmentIndex: 0,
                sourceOffsetY: 0,
                height: item.height,
                x: measured?.left ?? metrics.margins.leftPx,
                y: actualTop,
                width: measured?.width ?? metrics.content.widthPx,
                totalHeight: item.height,
              }]);
            return move;
          }
          // 本文が現在ページの残りを超えたら、実測した行境界で分割する。
          // 末尾余白だけの超過は分割せず、後続ブロックを送る。
          if (
            paginationItem.height - (paginationItem.trailingSpacePx ?? 0)
              + (paginationItem.fragmentEndSpacePx ?? 0)
            > contentHeightPx - (actualTop - marginTopPx - placement.pageIndex * pageStride) + 0.5
            && paginationItem.kind === "fragmentableBlock"
          ) {
            const measured = blockCanvasRects.get(item.id);
            const move = placeFragments(
              item.id,
              item.height,
              actualTop,
              getBlockFragmentBreakOffsetsFromMeasured(measured),
              placement,
              topNat,
              paginationItem.fragmentEndSpacePx,
            );
            const source = nextBoxFragmentSourceLayouts[item.id];
            splitFrameBlockVisuals.set(item.id, source
              ? [{
                blockId: item.id,
                fragmentIndex: 0,
                sourceOffsetY: 0,
                height: source.visibleHeight,
                x: measured?.left ?? metrics.margins.leftPx,
                y: actualTop,
                width: measured?.width ?? metrics.content.widthPx,
                totalHeight: item.height,
              }, ...(nextBoxBlockFragmentLayouts[item.id] ?? [])]
              : []);
            return move;
          }
          if (splitFrameEndSpaceByBlockId.has(item.id)) {
            const measured = blockCanvasRects.get(item.id);
            splitFrameBlockVisuals.set(item.id, [{
              blockId: item.id,
              fragmentIndex: 0,
              sourceOffsetY: 0,
              height: item.height,
              x: measured?.left ?? metrics.margins.leftPx,
              y: actualTop,
              width: measured?.width ?? metrics.content.widthPx,
              totalHeight: item.height,
            }]);
          }
          return undefined;
        }

        if (item.kind !== "area") {
          return undefined;
        }

        const area = item.area;
        const flowResult = computeProblemAreaColumnFlow(
          area.blockHeights,
          area.columnCount,
          area.columnWidthPx,
          area.columnGapPx,
          placement.availableFirst,
          contentHeightPx,
          pageStride,
        );
        if (flowResult.mode !== "flow") {
          return undefined;
        }
        nextAreaLayouts[area.unitId] = {
          blockLayouts: flowResult.blockLayouts,
          markerLayouts: flowResult.markerLayouts,
          totalHeightPx: flowResult.totalHeightPx,
          columnWidthPx: area.columnWidthPx,
          columnGapPx: area.columnGapPx,
        };
        const shellPaginatedTop = topNat + area.contentOffset + marginTopPx + placement.cumGapPrev;
        for (const block of area.blockHeights) {
          const fragments = flowResult.fragmentLayouts[block.id];
          if (!fragments || fragments.length <= 1) {
            continue;
          }
          const absoluteFragments = fragments.map((fragment) => roundEditorBoxBlockFragmentLayout({
            blockId: block.id,
            fragmentIndex: fragment.fragmentIndex,
            sourceOffsetY: fragment.sourceOffsetY,
            height: fragment.height,
            x: area.contentLeft + fragment.x,
            y: shellPaginatedTop + fragment.y,
            width: fragment.width,
            totalHeight: block.height,
          }));
          const firstFragment = absoluteFragments[0];
          const lastFragment = absoluteFragments[absoluteFragments.length - 1];
          nextBoxFragmentSourceLayouts[block.id] = {
            visibleHeight: firstFragment.height,
            origin: { x: firstFragment.x, y: firstFragment.y, width: firstFragment.width },
            totalHeight: block.height,
          };
          nextBoxBlockFragmentLayouts[block.id] = absoluteFragments.slice(1);
          maxBoxFragmentBottom = Math.max(maxBoxFragmentBottom, lastFragment.y + lastFragment.height);
        }
        maxAreaBottom = Math.max(maxAreaBottom, shellPaginatedTop + flowResult.totalHeightPx);
        // The shell height already spans the inter-page gaps, so the cumulative
        // margin gap is unchanged; only the page cursor advances.
        return {
          pageIndex: placement.pageIndex + flowResult.segments - 1,
          pageStartNatural: placement.pageStartNatural + (flowResult.segments - 1) * pageStride,
        };
      },
    },
  );

  for (const frameUnit of problemAreaPaginationItems.splitFrameUnits) {
    const unitElement = appliedGaps.unitElementByUnitId.get(frameUnit.unitId);
    if (!unitElement) {
      continue;
    }
    const unitRect = unitElement.getBoundingClientRect();
    const unitLeft = (unitRect.left - flowRect.left) / zoomFactor;
    const unitTop = (unitRect.top - flowRect.top) / zoomFactor;
    const byPage = new Map<number, EditorBoxBlockFragmentLayout[]>();
    for (const blockId of frameUnit.blockIds) {
      for (const visual of splitFrameBlockVisuals.get(blockId) ?? []) {
        const page = getPageIndexForY(visual.y, pageStride);
        const existing = byPage.get(page);
        if (existing) {
          existing.push(visual);
        } else {
          byPage.set(page, [visual]);
        }
      }
    }
    const fragments = [...byPage.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, visuals]) => {
        const left = Math.min(...visuals.map((visual) => visual.x));
        const top = Math.min(...visuals.map((visual) => visual.y));
        const right = Math.max(...visuals.map((visual) => visual.x + visual.width));
        const bottom = Math.max(...visuals.map((visual) => visual.y + visual.height));
        return {
          x: left - unitLeft,
          y: top - unitTop,
          width: right - left,
          height: Math.max(1, bottom - top),
        };
      });
    if (fragments.length > 1) {
      nextFrameFragmentLayouts[frameUnit.unitId] = fragments;
    }
  }

  return {
    gaps: paginationResult.gaps,
    pageCount: Math.max(
      paginationResult.pageCount,
      getPageCountForBottom(Math.max(maxAreaBottom, maxBoxFragmentBottom), pageHeightPx, pageStride),
    ),
    boxBlockFragmentLayouts: nextBoxBlockFragmentLayouts,
    boxFragmentSourceLayouts: nextBoxFragmentSourceLayouts,
    frameFragmentLayouts: nextFrameFragmentLayouts,
    areaLayouts: nextAreaLayouts,
  };
}

/**
 * どこから「今そこに描かれている gap」を引くか。
 *
 * ブロックの gap は ProseMirror の spacer widget、エリアの gap はフローユニットの margin。
 * どちらも layout state ではなく DOM から読む — 引き算する計測値と必ず整合させるため
 * (`applied-gaps.ts` 冒頭のコメント参照)。
 */
function appliedGapItem(item:
  | { kind: "block"; id: string }
  | { kind: "atomicProblemArea"; area: AtomicProblemAreaItem }
  | { kind: "area"; area: ProblemAreaColumnInput },
  problemAreaOwnerByBlockId: ReadonlyMap<
    string,
    Extract<RenderUnit, { type: "problemArea" | "problemLayoutSection" }>
  >,
): AppliedGapItem {
  if (item.kind === "block") {
    return getBlockPaginationGapCarrier(item.id, problemAreaOwnerByBlockId).appliedGapItem;
  }
  return {
    kind: "unit",
    unitId: item.kind === "atomicProblemArea" ? item.area.firstUnitId : item.area.unitId,
  };
}

function walkItemGapKey(item:
  | { kind: "block"; id: string }
  | { kind: "atomicProblemArea"; area: AtomicProblemAreaItem }
  | { kind: "reservedAreaEnd"; boundary: ReservedProblemAreaEndItem }
  | { kind: "area"; area: ProblemAreaColumnInput },
  problemAreaOwnerByBlockId: ReadonlyMap<
    string,
    Extract<RenderUnit, { type: "problemArea" | "problemLayoutSection" }>
  >,
): string {
  if (item.kind === "block") {
    return getBlockPaginationGapCarrier(item.id, problemAreaOwnerByBlockId).gapKey;
  }
  if (item.kind === "reservedAreaEnd") {
    return item.boundary.gapKey;
  }
  return item.kind === "atomicProblemArea" ? item.area.gapKey : item.area.unitId;
}

/**
 * A break before the first block in a problem's first area must move the area's
 * outer chrome too. In particular, the problem number lives outside TextFlowEditor,
 * so a block spacer would leave it behind on the previous page. Keep the gap key
 * and the DOM read-back carrier as one decision so they cannot diverge between
 * pagination passes.
 */
export function getBlockPaginationGapCarrier(
  blockId: string,
  problemAreaOwnerByBlockId: ReadonlyMap<
    string,
    Extract<RenderUnit, { type: "problemArea" | "problemLayoutSection" }>
  >,
): { gapKey: string; appliedGapItem: AppliedGapItem } {
  const owner = problemAreaOwnerByBlockId.get(blockId);
  const firstBlockId = owner?.type === "problemArea"
    ? owner.blocks[0]?.id ?? emptyProblemAreaEditorBlockId(owner.problem.id, owner.area)
    : null;
  if (
    owner?.type === "problemArea"
    && owner.isFirstProblemArea
    && owner.isFirstProblemAreaUnit
    && blockId === firstBlockId
  ) {
    return {
      gapKey: getProblemAreaUnitGapKey(owner),
      appliedGapItem: { kind: "unit", unitId: owner.id },
    };
  }
  return {
    gapKey: blockId,
    appliedGapItem: { kind: "block", id: blockId },
  };
}
