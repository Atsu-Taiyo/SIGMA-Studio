"use client";
import { PageColumnRules } from "@/features/rendering/adapters/react";

import { ProblemNumberingProvider } from "@/components/editor/text-flow/ProblemNumberingContext";

import {
  getMeasuredLineBreakOffsets,
  measureElementLineBoxes,
} from "@/components/editor/overlay-canvas/anchor";
import { PageRunningRegionView } from "@/components/editor/PageRunningRegionView";
import {
  buildProblemAreaPrintUnits,
  getPrintLayoutSectionColumnCount,
  PrintBlock,
  type PrintContentUnit,
  type PrintPaginatedColumn,
} from "@/components/print/print-static-blocks";
import {
  HeadingNumberingProvider,
} from "@/components/editor/text-flow/HeadingNumberingContext";
import { getSafeProblemAreaMinHeightPx, resolveFlowFragmentStep } from "@/features/rendering/core";
import {
  blockSpaceAfterPx,
  normalizeOverlaySnapshot,
  estimateBlockHeightPx,
  getPageMetrics,
  MM_TO_PX,
  PAGE_GAP_PX,
  type BoxBlockChildBlock,
  type SigmaBlock,
  type SigmaDocument,
  type OutputProfileName,
  type PageOverlay,
  type ProblemAreaBlock,
  type RichBlock,
} from "@/features/document";
import {
  getShapeBounds,
  resolveShapesPosition,
  type MeasuredBlock,
} from "@/features/drawing";
import { MathEnvironmentValueProvider } from "@/features/rendering/adapters/react";
import { exportOverlaySvg } from "@/features/rendering/adapters/svg";
import { createMathRenderEnvironment } from "@/lib/math-environment";
import { hasManualBreakInside, isProblemAreaFlowEligible } from "@/features/rendering/core";
import { getProblemNumberMap } from "@/lib/problem-numbering";
import { getHeadingNumberMap } from "@/lib/heading-numbering";
import { getPrintableDocument } from "@/lib/print-renderer";
import { useT } from "@/lib/i18n/react";
import {
  boxBlockTitleText,
  observeCornerBoxReferenceHeights,
  resolveBoxFrame,
} from "@/lib/box-blocks";
import {
  getPrintProblemFrameFragmentChromeHeightMm,
  type ProblemFrameFragmentRole,
} from "@/lib/problem-frame";
import { useCustomFonts } from "@/lib/use-custom-fonts";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";

const PRINT_CORNERBOX_SELECTOR = ".print-box-block.box-frame--corner[data-box-style='cornerbox']";
const OVERLAY_PAGE_EXTENT_EPSILON_PX = 12;
const MAX_PRINT_PAGES = 1_000;
const MAX_PRINT_SLICES_PER_BLOCK = 1_000;
const MAX_PRINT_SLICES_PER_PAGINATION = 10_000;

interface PrintFragmentBudget {
  remainingSlices: number;
}

export type { PrintContentUnit } from "@/components/print/print-static-blocks";

interface PrintPaginatedPage {
  id: string;
  number: number;
  blocks: PrintContentUnit[];
  columns: PrintPaginatedColumn[];
  estimatedContentHeightPx: number;
  oversizedBlockIds: string[];
}

interface PrintContentMeasurement {
  height: number;
  flowHeight: number;
  descendantRects: MeasuredBlock[];
  breakOffsets: number[];
}

interface PrintMeasurementState {
  key: string;
  pages: PrintPaginatedPage[];
  blockRects: Map<string, MeasuredBlock>;
}

interface PrintPreviewProps {
  document: SigmaDocument;
  profile: OutputProfileName;
  displayMode?: PrintPreviewDisplayMode;
}

export type PrintPreviewDisplayMode = "vertical" | "spread" | "grid";

interface PrintPreviewThumbnailProps {
  document: SigmaDocument;
  profile?: OutputProfileName;
  maxPages?: number | "all";
}

interface PrintPreviewPageNavigatorProps {
  document: SigmaDocument;
  profile?: OutputProfileName;
  activePageNumber: number;
  onPageSelect?: (pageNumber: number) => void;
  className?: string;
  style?: CSSProperties;
}

interface PrintPreviewPageFrameArgs {
  page: PrintPaginatedPage;
  totalPages: number;
  pageNode: ReactNode;
}

interface PrintPreviewSurfaceProps extends PrintPreviewProps {
  maxPages?: number;
  stackClassName?: string;
  renderPageFrame?: (args: PrintPreviewPageFrameArgs) => ReactNode;
}

export interface SigmaDocPrintSurfaceProps {
  document: SigmaDocument;
  displayMode?: PrintPreviewDisplayMode;
  includePrintPageStyle?: boolean;
  maxPages?: number;
  stackClassName?: string;
  renderPageFrame?: (args: PrintPreviewPageFrameArgs) => ReactNode;
}

export function PrintPreview(props: PrintPreviewProps) {
  useCustomFonts();
  return <PrintPreviewSurface {...props} />;
}

export function PrintPreviewThumbnail({ document, profile = "teacher", maxPages = 1 }: PrintPreviewThumbnailProps) {
  const resolvedMaxPages = maxPages === "all" ? undefined : maxPages;
  return (
    <div className="print-preview-thumbnail" data-print-preview-thumbnail="true">
      <PrintPreviewSurface
        document={document}
        profile={profile}
        displayMode="vertical"
        maxPages={resolvedMaxPages}
        stackClassName="print-page-thumbnail-stack"
      />
    </div>
  );
}

export function PrintPreviewPageNavigator({
  document,
  profile = "teacher",
  activePageNumber,
  onPageSelect,
  className,
  style,
}: PrintPreviewPageNavigatorProps) {
  const t = useT("print");
  const renderPageFrame = useCallback(({ page, totalPages, pageNode }: PrintPreviewPageFrameArgs) => {
    const selected = page.number === activePageNumber;
    const selectPage = () => onPageSelect?.(page.number);
    const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }

      event.preventDefault();
      selectPage();
    };

    return (
      <div
        key={page.id}
        className={`print-preview-page-nav-item ${selected ? "selected" : ""}`}
        role="listitem"
      >
        <div
          className="print-preview-page-nav-button"
          role="button"
          tabIndex={0}
          aria-current={selected ? "page" : undefined}
          aria-label={t("pagination.page", { page: page.number, total: totalPages })}
          onClick={selectPage}
          onKeyDown={handleKeyDown}
        >
          <div className="print-preview-page-nav-viewport" aria-hidden="true">
            <div className="print-preview-page-nav-scaler">
              {pageNode}
              <span className="print-preview-page-nav-paper-selection" />
            </div>
            <span className="print-preview-page-nav-label">-{page.number}-</span>
          </div>
        </div>
      </div>
    );
  }, [activePageNumber, onPageSelect, t]);

  return (
    <div
      className={["print-preview-page-navigator", className].filter(Boolean).join(" ")}
      data-print-page-navigator="true"
      role="list"
      aria-label={t("pagination.preview")}
      style={style}
    >
      <PrintPreviewSurface
        document={document}
        profile={profile}
        displayMode="vertical"
        stackClassName="print-page-nav-stack"
        renderPageFrame={renderPageFrame}
      />
    </div>
  );
}

function PrintPreviewSurface({
  document,
  profile,
  displayMode = "vertical",
  maxPages,
  stackClassName,
  renderPageFrame,
}: PrintPreviewSurfaceProps) {
  const t = useT("print");
  const printable = useMemo(() => getPrintableDocument(document, profile, t), [document, profile, t]);
  return (
    <SigmaDocPrintSurface
      document={printable}
      displayMode={displayMode}
      maxPages={maxPages}
      stackClassName={stackClassName}
      renderPageFrame={renderPageFrame}
    />
  );
}

/**
 * UI-free SigmaDoc page renderer shared by the desktop print preview and the
 * embeddable read-only viewer. The caller owns validation and any output-profile
 * projection; this component renders the supplied document as-is.
 */
export function SigmaDocPrintSurface({
  document: printable,
  displayMode = "vertical",
  includePrintPageStyle = true,
  maxPages,
  stackClassName,
  renderPageFrame,
}: SigmaDocPrintSurfaceProps) {
  const mathFractionSizing = printable.metadata.mathFractionSizing ?? "uniform";
  // 公開ビューア (`@sigma-studio/viewer`) はこのコンポーネントを直接 print surface に使うので、
  // Provider をここに置かないと publish 済み教材で前文マクロが一切効かない。
  // 図形 SVG の書き出しは React の外なので、同じ環境オブジェクトを明示的に渡す。
  const mathEnvironment = useMemo(
    () => createMathRenderEnvironment(printable.metadata.texPreamble, mathFractionSizing),
    [mathFractionSizing, printable.metadata.texPreamble],
  );
  const layout = printable.pageLayout!;
  const metrics = getPageMetrics(layout);
  const pageStride = metrics.page.heightPx + PAGE_GAP_PX;
  const printContent = useMemo(() => buildPrintContent(printable.content), [printable.content]);
  const problemNumbers = useMemo(() => getProblemNumberMap(printable.content), [printable.content]);
  const headingNumbers = useMemo(
    () => getHeadingNumberMap(printable.content, printable.metadata.headingNumbering),
    [printable.content, printable.metadata.headingNumbering],
  );
  const stackRef = useRef<HTMLElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const estimatedPrintContentHeights = useMemo(
    () => printContent.map((unit) => estimatePrintContentUnitHeight(unit, metrics.content.heightPx)),
    [metrics.content.heightPx, printContent],
  );
  const fallbackContentPages = useMemo(
    () => paginateMeasuredPrintBlocks(
      printContent,
      estimatedPrintContentHeights,
      estimatedPrintContentHeights,
      metrics.flow.columnCount,
      metrics.content.heightPx,
      0,
      new Map(),
      metrics.flow.columnGapMm,
    ),
    [estimatedPrintContentHeights, metrics.content.heightPx, metrics.flow.columnCount, metrics.flow.columnGapMm, printContent],
  );
  const contentKey = useMemo(() => JSON.stringify(printContent), [printContent]);
  const layoutKey = useMemo(() => JSON.stringify(layout), [layout]);
  const measurementKey = `${contentKey}\n${layoutKey}`;
  const emptyBlockRects = useMemo(() => new Map<string, MeasuredBlock>(), []);
  const [measurement, setMeasurement] = useState<PrintMeasurementState | null>(null);
  const [measurementRevision, setMeasurementRevision] = useState(0);
  const activeMeasurement = measurement?.key === measurementKey ? measurement : null;
  const contentPages = activeMeasurement?.pages ?? fallbackContentPages;
  const measuredBlockRects = activeMeasurement?.blockRects ?? emptyBlockRects;
  const resolvedOverlay = useMemo(
    () => resolvePrintOverlay(layout.overlay, measuredBlockRects),
    [layout.overlay, measuredBlockRects],
  );
  const pages = useMemo(
    () => extendPagesForOverlay(
      contentPages,
      resolvedOverlay,
      metrics.flow.columnCount,
      metrics.page.heightPx,
      pageStride,
    ),
    [contentPages, metrics.flow.columnCount, metrics.page.heightPx, pageStride, resolvedOverlay],
  );
  const renderedPages = typeof maxPages === "number"
    ? pages.slice(0, Math.max(1, maxPages))
    : pages;
  const pageStyle = {
    "--print-page-width": `${metrics.page.widthMm}mm`,
    "--print-page-height": `${metrics.page.heightMm}mm`,
    "--print-margin-top": `${metrics.margins.topPx}px`,
    "--print-margin-right": `${metrics.margins.rightPx}px`,
    "--print-margin-bottom": `${metrics.margins.bottomPx}px`,
    "--print-margin-left": `${metrics.margins.leftPx}px`,
    "--print-column-count": String(metrics.flow.columnCount),
    "--print-column-gap": `${metrics.flow.columnGapMm}mm`,
    "--print-measure-column-width": `${metrics.flow.columnWidthPx}px`,
    "--print-measure-content-width": `${metrics.content.widthPx}px`,
  } as CSSProperties;

  useLayoutEffect(() => {
    const stackRoot = stackRef.current;
    if (!stackRoot) {
      return;
    }

    return observeCornerBoxReferenceHeights(stackRoot, PRINT_CORNERBOX_SELECTOR);
  }, [contentKey, layoutKey]);

  useLayoutEffect(() => {
    const measureRoot = measureRef.current;
    if (!measureRoot) {
      return;
    }

    let active = true;
    let frameId: number | null = null;
    const requestMeasurement = () => {
      if (!active || frameId !== null) {
        return;
      }
      const schedule = typeof window !== "undefined" && typeof window.requestAnimationFrame === "function"
        ? window.requestAnimationFrame.bind(window)
        : (callback: FrameRequestCallback) => window.setTimeout(callback, 0);
      frameId = schedule(() => {
        frameId = null;
        if (active) {
          setMeasurementRevision((revision) => revision + 1);
        }
      });
    };

    const observer = typeof ResizeObserver === "function" ? new ResizeObserver(requestMeasurement) : null;
    observer?.observe(measureRoot);
    if (typeof document !== "undefined" && document.fonts) {
      void document.fonts.ready.then(requestMeasurement);
    }

    return () => {
      active = false;
      observer?.disconnect();
      if (frameId !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame?.(frameId);
        window.clearTimeout(frameId);
      }
    };
  }, [contentKey, layoutKey]);

  useLayoutEffect(() => {
    const measureRoot = measureRef.current;
    if (!measureRoot) {
      return;
    }

    const measurements = measurePrintContentUnits(measureRoot, printContent);
    const heights = measurements.map((measurement) => measurement.height);
    const flowHeights = measurements.map((measurement) => measurement.flowHeight);
    const nestedRects = measurements.map((measurement) => measurement.descendantRects);
    const measuredDescendantHeights = getMeasuredDescendantHeightMap(nestedRects);
    const measuredBlockBreakOffsets = new Map<string, number[]>();
    printContent.forEach((unit, index) => {
      const measurement = measurements[index];
      measuredBlockBreakOffsets.set(unit.id, measurement?.breakOffsets ?? []);
      for (const descendant of measurement?.descendantRects ?? []) {
        const offsets = getMeasuredLineBreakOffsets(descendant.lines ?? [], descendant.top)
          .filter((offset) => offset > 0.5 && offset < (descendant.height ?? 0) - 0.5);
        measuredBlockBreakOffsets.set(descendant.id, offsets);
      }
    });
    const nextPages = paginateMeasuredPrintBlocks(
      printContent,
      heights,
      flowHeights,
      metrics.flow.columnCount,
      metrics.content.heightPx,
      0,
      measuredDescendantHeights,
      metrics.flow.columnGapMm,
      measuredBlockBreakOffsets,
    );
    const nextBlockRects = getMeasuredPrintBlockRects(
      nextPages,
      printContent,
      heights,
      flowHeights,
      metrics.margins.topPx,
      metrics.margins.leftPx,
      metrics.flow.columnWidthPx,
      metrics.flow.columnGapPx,
      pageStride,
      0,
      nestedRects,
      measuredDescendantHeights,
    );

    setMeasurement((current) => (
      current?.key === measurementKey &&
      sameBlockRectMap(current.blockRects, nextBlockRects) &&
      samePrintPagination(current.pages, nextPages)
        ? current
        : { key: measurementKey, pages: nextPages, blockRects: nextBlockRects }
    ));
  }, [
    contentKey,
    layoutKey,
    measurementKey,
    measurementRevision,
    metrics.content.heightPx,
    metrics.flow.columnCount,
    metrics.flow.columnGapPx,
    metrics.flow.columnGapMm,
    metrics.flow.columnWidthPx,
    metrics.margins.leftPx,
    metrics.margins.topPx,
    pageStride,
    printContent,
  ]);

  return (
    <MathEnvironmentValueProvider environment={mathEnvironment}>
    <ProblemNumberingProvider numbers={problemNumbers}>
    <HeadingNumberingProvider numbers={headingNumbers}>
    <article
      ref={stackRef}
      className={["print-page-stack", `layout-${displayMode}`, stackClassName].filter(Boolean).join(" ")}
      data-print-preview-layout={displayMode}
      data-print-preview-max-pages={typeof maxPages === "number" ? String(maxPages) : undefined}
      data-print-preview-page-count={String(pages.length)}
      style={pageStyle}
    >
      {includePrintPageStyle ? (
        <style>{`@media print { @page { size: ${metrics.page.widthMm}mm ${metrics.page.heightMm}mm; margin: 0; } }`}</style>
      ) : null}
      {renderedPages.map((page) => {
        const backgroundSvg = resolvedOverlay?.overlaySnapshot
          ? exportOverlaySvg(resolvedOverlay.overlaySnapshot.shapes, resolvedOverlay.overlaySnapshot.assets, {
              width: metrics.page.widthPx,
              height: metrics.page.heightPx,
              offsetY: (page.number - 1) * pageStride,
            }, { mathEnvironment, stackLayer: "background", viewportPaddingPx: 0 })
          : undefined;
        const foregroundSvg = resolvedOverlay?.overlaySnapshot
          ? exportOverlaySvg(resolvedOverlay.overlaySnapshot.shapes, resolvedOverlay.overlaySnapshot.assets, {
              width: metrics.page.widthPx,
              height: metrics.page.heightPx,
              offsetY: (page.number - 1) * pageStride,
            }, { mathEnvironment, stackLayer: "foreground", viewportPaddingPx: 0 })
          : undefined;

        const pageNode = (
          <section
            key={page.id}
            className="print-a4-page"
            style={pageStyle}
          >
            <PageColumnRules metrics={metrics} />
            <PageRunningRegionView
              region={layout.header}
              kind="header"
              title={printable.metadata.title}
              pageNumber={page.number}
              totalPages={pages.length}
              metrics={metrics}
              mathFractionSizing={mathFractionSizing}
            />
            <PageRunningRegionView
              region={layout.footer}
              kind="footer"
              title={printable.metadata.title}
              pageNumber={page.number}
              totalPages={pages.length}
              metrics={metrics}
              mathFractionSizing={mathFractionSizing}
            />
            {backgroundSvg && (
              <div
                className="print-page-overlay-layer background"
                dangerouslySetInnerHTML={{ __html: backgroundSvg }}
              />
            )}
              <div className="print-page-content-layer">
                {getPageFullSpanBlocks(page).map((unit, index) => (
                  <div className="print-page-full-span-block" key={`${page.id}-full-${unit.id}-${index}`}>
                    <PrintBlock unit={unit} columnGapMm={metrics.flow.columnGapMm} mathFractionSizing={mathFractionSizing} />
                  </div>
                ))}
                <div className="print-page-columns">
                  {page.columns.map((column) => (
                    <div className="print-page-column" key={`${page.id}-${column.id}`}>
                    {getColumnFlowBlocks(column).map((unit, index) => (
                      <PrintBlock
                        key={`${unit.id}-${index}`}
                        unit={unit}
                        columnGapMm={metrics.flow.columnGapMm}
                        mathFractionSizing={mathFractionSizing}
                      />
                    ))}
                  </div>
                ))}
              </div>
            </div>
            {foregroundSvg && (
              <div
                className="print-page-overlay-layer foreground"
                dangerouslySetInnerHTML={{ __html: foregroundSvg }}
              />
            )}
          </section>
        );

        return renderPageFrame
          ? renderPageFrame({ page, totalPages: pages.length, pageNode })
          : pageNode;
      })}
      <div className="print-measure-layer" ref={measureRef} style={pageStyle} aria-hidden="true">
        <div className="print-measure-column">
          {printContent.map((unit, index) => (
            <div
              data-print-measure-index={index}
              key={`${unit.id}-${index}`}
              style={isFullSpanPrintUnit(unit) ? { width: "var(--print-measure-content-width)" } : undefined}
            >
              <PrintBlock unit={unit} columnGapMm={metrics.flow.columnGapMm} mathFractionSizing={mathFractionSizing} />
            </div>
          ))}
        </div>
      </div>
    </article>
    </HeadingNumberingProvider>
    </ProblemNumberingProvider>
    </MathEnvironmentValueProvider>
  );
}

export function buildPrintContent(content: SigmaBlock[]): PrintContentUnit[] {
  const problemNumbers = getProblemNumberMap(content);

  return content.flatMap((block): PrintContentUnit[] => {
    if (block.type !== "problem") {
      return [{
        type: "block",
        id: block.id,
        block,
        pagination: block.pagination,
      }];
    }

    return buildProblemAreaPrintUnits(block, problemNumbers.get(block.id));
  });
}

/** Delegates to the shared predicate in features/rendering/core; see isProblemAreaColumnBlockFlowEligible in page-canvas/render-units.ts for the editor mirror. */
function isFlowableProblemArea(
  unit: PrintContentUnit,
  gapFreeHeightPx: number,
  segmentHeightPx: number,
): boolean {
  return unit.type === "problemArea" && isProblemAreaFlowEligible({
    isFullSpan: unit.columnSpan === "full",
    isFramedArea: unit.hasFrame,
    blocks: unit.blocks,
    gapFreeHeightPx,
    segmentHeightPx,
  });
}

export function estimatePrintContentUnitHeight(unit: PrintContentUnit, contentHeightPx: number): number {
  if (unit.type === "block") {
    return estimateBlockHeightPx(unit.block);
  }

  if (unit.type === "boxFragment") {
    return unit.estimatedHeightPx;
  }

  if (unit.type === "layoutSectionFragment") {
    return unit.estimatedHeightPx;
  }

  if (unit.type === "blockSlice") {
    return unit.sliceHeight;
  }

  if (unit.type === "problemAreaFragment") {
    return unit.estimatedHeightPx;
  }

  return Math.max(
    unit.blocks.reduce((height, block) => height + estimateBlockHeightPx(block), 0),
    getSafeProblemAreaMinHeightPx(unit.minHeightMm ?? 0, contentHeightPx),
  );
}

/** Exported for `PrintPreview.test.tsx`: 紙面のページ割りを DOM 抜きで固定するため。 */
export function paginateMeasuredPrintBlocks(
  blocks: PrintContentUnit[],
  heights: number[],
  flowHeights: number[],
  columnCount: number,
  contentHeightPx: number,
  firstPageHeaderHeightPx: number,
  measuredDescendantHeights: Map<string, number>,
  defaultColumnGapMm: number,
  measuredBlockBreakOffsets: Map<string, number[]> = new Map(),
  sharedFragmentBudget?: PrintFragmentBudget,
): PrintPaginatedPage[] {
  const fragmentBudget = sharedFragmentBudget ?? { remainingSlices: MAX_PRINT_SLICES_PER_PAGINATION };
  const pages: PrintPaginatedPage[] = [];
  let pageNumber = 1;
  let columns = createEmptyPrintPage(pageNumber, columnCount).columns;
  let columnIndex = 0;
  let pageBudgetExhausted = false;

  const pageHasContent = () => columns.some((column) => column.blocks.length > 0);
  const pageHasColumnContent = () => columns.some((column) => column.blocks.some((block) => !isFullSpanPrintUnit(block)));
  const currentColumn = () => columns[columnIndex];
  const currentColumnHeight = () => Math.max(0, contentHeightPx - (pageNumber === 1 ? firstPageHeaderHeightPx : 0));
  const flushPage = (force = false) => {
    if (!force && !pageHasContent()) {
      return;
    }
    if (pages.length >= MAX_PRINT_PAGES - 1) {
      if (!pageBudgetExhausted) {
        pages.push({
          id: `page_${pageNumber}`,
          number: pageNumber,
          blocks: columns.flatMap((column) => column.blocks),
          columns,
          estimatedContentHeightPx: columns.reduce((height, column) => height + column.estimatedContentHeightPx, 0),
          oversizedBlockIds: columns.flatMap((column) => column.oversizedBlockIds),
        });
      }
      pageBudgetExhausted = true;
      return;
    }

    pages.push({
      id: `page_${pageNumber}`,
      number: pageNumber,
      blocks: columns.flatMap((column) => column.blocks),
      columns,
      estimatedContentHeightPx: columns.reduce((height, column) => height + column.estimatedContentHeightPx, 0),
      oversizedBlockIds: columns.flatMap((column) => column.oversizedBlockIds),
    });
    pageNumber += 1;
    columns = createEmptyPrintPage(pageNumber, columnCount).columns;
    columnIndex = 0;
  };
  const advanceColumn = () => {
    if (columnIndex < columnCount - 1) {
      columnIndex += 1;
      return;
    }

    flushPage();
    if (pageBudgetExhausted) {
      columnIndex = columnCount - 1;
    }
  };
  const advanceForExplicitBreak = () => {
    advanceColumn();
  };
  const columnHasFlowContent = (column: PrintPaginatedColumn) => column.blocks.some((unit) => !isFullSpanPrintUnit(unit));
  const pageContainsOnlyMatchingLead = (
    unit: Extract<PrintContentUnit, { type: "problemArea" }>,
  ) => {
    const placed = columns.flatMap((column) => column.blocks);
    return placed.length > 0 && placed.every((candidate) => (
      (candidate.type === "problemArea" || candidate.type === "problemAreaFragment")
      && candidate.area === "lead"
      && candidate.problemId === unit.problemId
    ));
  };
  const currentColumnRemainingHeight = () => Math.max(0, currentColumnHeight() - currentColumn().estimatedContentHeightPx);
  const placeFlowUnit = (unit: PrintContentUnit, height: number, flowHeight = height) => {
    const column = currentColumn();
    column.blocks.push(unit);
    column.estimatedContentHeightPx += Math.max(height, flowHeight);
    if (height > currentColumnHeight()) {
      column.oversizedBlockIds.push(unit.id);
    }
  };
  const keepWithNextIfPossible = (index: number) => {
    const unit = blocks[index];
    const next = blocks[index + 1];
    const isImplicitLeadKeep = unit.type === "problemArea"
      && unit.area === "lead"
      && next?.type === "problemArea"
      && next.problemId === unit.problemId
      && next.area !== "lead"
      && next.blocks[0]?.pagination?.break !== true;
    if (
      (unit.pagination?.keepWithNext !== true && !isImplicitLeadKeep)
      || !next
      || next.pagination?.break === true
      || isFullSpanPrintUnit(unit)
      || (isFullSpanPrintUnit(next) && !isImplicitLeadKeep)
    ) {
      return;
    }

    const currentHeight = Math.max(heights[index] || 0, flowHeights[index] ?? 0);
    const nextHeight = Math.max(heights[index + 1] || 0, flowHeights[index + 1] ?? 0);
    const nextTrailingSpacePx = next.type === "block" ? blockSpaceAfterPx(next.block) : 0;
    const firstNextProblemBlock = next.type === "problemArea" ? next.blocks[0] : undefined;
    const implicitLeadNextHeight = isImplicitLeadKeep && next.type === "problemArea"
      && firstNextProblemBlock
      && isFlowableProblemArea(next, nextHeight, contentHeightPx)
      ? Math.max(
        0,
        getMeasuredOrEstimatedBlockHeight(firstNextProblemBlock, measuredDescendantHeights)
          - blockSpaceAfterPx(firstNextProblemBlock),
      ) + (next.hasFrame
        ? getPrintProblemFrameFragmentChromeHeightMm(next.frameStyleId, "first") * MM_TO_PX
        : 0)
      : Math.max(0, nextHeight - nextTrailingSpacePx);
    const groupHeight = currentHeight + implicitLeadNextHeight;
    const nextColumnHeight = columnIndex < columnCount - 1 ? currentColumnHeight() : contentHeightPx;
    const shouldAdvanceShortFirstPage = pageNumber === 1
      && columnIndex === 0
      && !pageHasColumnContent()
      && currentColumnHeight() < contentHeightPx - 0.5
      && groupHeight > currentColumnHeight() + 0.5
      && groupHeight <= contentHeightPx + 0.5;
    if (shouldAdvanceShortFirstPage) {
      flushPage(true);
    } else if (
      columnHasFlowContent(currentColumn())
      && groupHeight > currentColumnRemainingHeight() + 0.5
      && groupHeight <= nextColumnHeight + 0.5
    ) {
      if (isFullSpanPrintUnit(next)) {
        flushPage();
      } else {
        advanceColumn();
      }
    }
  };
  const placeBreakableBox = (
    unit: Extract<PrintContentUnit, { type: "block" }>,
    totalHeight: number,
  ): boolean => {
    const boxBlock = unit.block;
    // Break the box whenever it does not fit the space remaining in the current
    // column (not only when it is taller than a whole column): a box flows like
    // body text, filling the rest of the current column/page and continuing,
    // open-edged, on the next.
    if (boxBlock.type !== "boxBlock" || boxBlock.blocks.length === 0) {
      return false;
    }

    if (totalHeight <= currentColumnRemainingHeight() + 0.5) {
      return false;
    }

    const nextColumnHeight = columnIndex < columnCount - 1 ? currentColumnHeight() : contentHeightPx;
    if (
      boxBlock.pagination?.keepTogether === true
      && columnHasFlowContent(currentColumn())
      && totalHeight <= nextColumnHeight + 0.5
    ) {
      advanceColumn();
      if (totalHeight <= currentColumnRemainingHeight() + 0.5) {
        return false;
      }
    }

    const fragments: Array<Extract<PrintContentUnit, { type: "boxFragment" }>> = [];
    const fragmentChromeHeight = estimatePrintBoxFragmentChromeHeight(boxBlock);
    const childHeights = boxBlock.blocks.map((child) => getMeasuredOrEstimatedBlockHeight(child, measuredDescendantHeights));
    let childIndex = 0;
    let fragmentIndex = 0;

    while (childIndex < boxBlock.blocks.length) {
      if (columnHasFlowContent(currentColumn()) && currentColumnRemainingHeight() < Math.min(72, currentColumnHeight() * 0.22)) {
        advanceColumn();
      }
      const nextChildHeight = childHeights[childIndex] ?? 0;
      if (
        columnHasFlowContent(currentColumn()) &&
        fragmentChromeHeight + nextChildHeight > currentColumnRemainingHeight() + 0.5 &&
        fragmentChromeHeight + nextChildHeight <= currentColumnHeight() + 0.5
      ) {
        advanceColumn();
      }

      const fragmentBlocks: BoxBlockChildBlock[] = [];
      let fragmentHeight = fragmentChromeHeight;

      while (childIndex < boxBlock.blocks.length) {
        const childHeight = childHeights[childIndex] ?? 0;
        const wouldFit = fragmentBlocks.length === 0 ||
          fragmentHeight + childHeight <= Math.max(fragmentChromeHeight + childHeight, currentColumnRemainingHeight() + 0.5);
        if (!wouldFit) {
          break;
        }

        fragmentBlocks.push(boxBlock.blocks[childIndex]);
        fragmentHeight += childHeight;
        childIndex += 1;

        if (fragmentHeight >= currentColumnRemainingHeight() - 0.5) {
          break;
        }
      }

      if (fragmentBlocks.length === 0) {
        fragmentBlocks.push(boxBlock.blocks[childIndex]);
        fragmentHeight += childHeights[childIndex] ?? 0;
        childIndex += 1;
      }

      const fragment: Extract<PrintContentUnit, { type: "boxFragment" }> = {
        type: "boxFragment",
        id: `${boxBlock.id}:fragment:${fragmentIndex}`,
        sourceId: boxBlock.id,
        block: boxBlock,
        blocks: fragmentBlocks,
        fragmentRole: "middle",
        estimatedHeightPx: fragmentHeight,
        totalHeight,
        includeTitle: fragmentIndex === 0,
        pagination: fragmentIndex === 0 ? unit.pagination : undefined,
      };
      fragments.push(fragment);
      placeFlowUnit(fragment, fragmentHeight);
      fragmentIndex += 1;

      if (childIndex < boxBlock.blocks.length) {
        advanceColumn();
      }
    }

    fragments.forEach((fragment, index) => {
      fragment.fragmentRole = fragments.length === 1
        ? "single"
        : index === 0
          ? "first"
          : index === fragments.length - 1
            ? "last"
            : "middle";
    });

    return true;
  };
  const placeOverTallBlock = (
    unit: Extract<PrintContentUnit, { type: "block" }>,
    totalHeight: number,
  ): void => {
    const breakOffsets = getBlockSliceBreakOffsets(
      unit.block,
      totalHeight,
      measuredDescendantHeights,
      measuredBlockBreakOffsets.get(unit.id),
    );
    const slices: Array<Extract<PrintContentUnit, { type: "blockSlice" }>> = [];
    let sliceTop = 0;
    let sliceIndex = 0;
    const sliceBudget = Math.min(MAX_PRINT_SLICES_PER_BLOCK, fragmentBudget.remainingSlices);
    if (sliceBudget <= 0) {
      placeFlowUnit(unit, totalHeight);
      return;
    }

    for (let guard = 0; sliceTop < totalHeight - 0.5 && guard < sliceBudget - 1; guard += 1) {
      // Don't start a slice on the last sliver of a column — continue on the next one.
      if (columnHasFlowContent(currentColumn()) && currentColumnRemainingHeight() < Math.min(48, currentColumnHeight() * 0.2)) {
        advanceColumn();
      }
      const available = Math.max(1, currentColumnRemainingHeight());
      const remaining = totalHeight - sliceTop;
      const step = resolveFlowFragmentStep({
        available,
        breakOffsets,
        fullSegmentHeight: currentColumnHeight(),
        remaining,
        sourceOffsetY: sliceTop,
      });
      if (step.advanceToNextSegment) {
        advanceColumn();
        continue;
      }
      const sliceHeight = step.height;

      const slice: Extract<PrintContentUnit, { type: "blockSlice" }> = {
        type: "blockSlice",
        id: `${unit.id}:slice:${sliceIndex}`,
        sourceId: unit.id,
        block: unit.block,
        sliceTop,
        sliceHeight,
        totalHeight,
        fragmentRole: "middle",
        pagination: sliceIndex === 0 ? unit.pagination : undefined,
      };
      slices.push(slice);
      fragmentBudget.remainingSlices -= 1;
      placeFlowUnit(slice, sliceHeight);
      sliceTop += sliceHeight;
      sliceIndex += 1;

      if (sliceTop < totalHeight - 0.5) {
        advanceColumn();
      }
    }

    if (sliceTop < totalHeight - 0.5) {
      const sliceHeight = totalHeight - sliceTop;
      const slice: Extract<PrintContentUnit, { type: "blockSlice" }> = {
        type: "blockSlice",
        id: `${unit.id}:slice:${sliceIndex}`,
        sourceId: unit.id,
        block: unit.block,
        sliceTop,
        sliceHeight,
        totalHeight,
        fragmentRole: "middle",
        pagination: sliceIndex === 0 ? unit.pagination : undefined,
      };
      slices.push(slice);
      fragmentBudget.remainingSlices -= 1;
      placeFlowUnit(slice, sliceHeight);
    }

    slices.forEach((slice, index) => {
      slice.fragmentRole = slices.length === 1
        ? "single"
        : index === 0
          ? "first"
          : index === slices.length - 1
            ? "last"
            : "middle";
    });

  };
  const createLayoutSectionFragments = (
    layoutSection: Extract<SigmaBlock, { type: "layoutSection" }>,
    totalHeight: number,
    pagination?: SigmaBlock["pagination"],
    availableFirstHeightPx = currentColumnRemainingHeight(),
    fragmentChromeHeightPx = 0,
  ): Array<Extract<PrintContentUnit, { type: "layoutSectionFragment" }>> | null => {
    const containsBoxBlock = layoutSection.children.some((child) => child.type === "boxBlock");
    const childBreak = hasManualBreakInside(layoutSection.children);
    const fullSectionContentHeightPx = Math.max(1, currentColumnHeight() - fragmentChromeHeightPx);
    if (!containsBoxBlock && !childBreak && totalHeight <= fullSectionContentHeightPx + 0.5) {
      return null;
    }

    const sectionColumnCount = getPrintLayoutSectionColumnCount(layoutSection.layout.columnCount);
    const layoutColumnGapMm = layoutSection.layout.columnGapMm ?? defaultColumnGapMm;
    const sectionUnits = layoutSection.children.map((child): PrintContentUnit => ({
      type: "block",
      id: child.id,
      block: child,
      pagination: child.pagination,
    }));
    const sectionHeights = layoutSection.children.map((child) => (
      getMeasuredOrEstimatedBlockHeight(child, measuredDescendantHeights, Math.max(12, Math.floor(54 / sectionColumnCount)))
    ));
    const sectionSegmentHeightPx = Math.max(1, contentHeightPx - fragmentChromeHeightPx);
    const availableSectionSegmentHeightPx = Math.max(
      0,
      Math.min(currentColumnHeight(), availableFirstHeightPx) - fragmentChromeHeightPx,
    );
    const firstSectionSegmentHeightPx = availableSectionSegmentHeightPx <= 0.5
      ? sectionSegmentHeightPx
      : availableSectionSegmentHeightPx;
    const sectionPages = paginateMeasuredPrintBlocks(
      sectionUnits,
      sectionHeights,
      sectionHeights,
      sectionColumnCount,
      sectionSegmentHeightPx,
      sectionSegmentHeightPx - firstSectionSegmentHeightPx,
      measuredDescendantHeights,
      layoutColumnGapMm,
      measuredBlockBreakOffsets,
      fragmentBudget,
    );
    const fragments = sectionPages.map((sectionPage, fragmentIndex): Extract<PrintContentUnit, { type: "layoutSectionFragment" }> => ({
      type: "layoutSectionFragment",
      id: `${layoutSection.id}:layout-fragment:${fragmentIndex}`,
      sourceId: layoutSection.id,
      block: layoutSection,
      columns: sectionPage.columns,
      fragmentRole: "middle",
      estimatedHeightPx: Math.max(
        32,
        ...sectionPage.columns.map((column) => column.estimatedContentHeightPx),
      ),
      columnGapMm: layoutColumnGapMm,
      pagination: fragmentIndex === 0 ? pagination : undefined,
    }));
    fragments.forEach((fragment, index) => {
      fragment.fragmentRole = fragments.length === 1
        ? "single"
        : index === 0 ? "first" : index === fragments.length - 1 ? "last" : "middle";
    });
    return fragments;
  };
  const placeFlowableProblemArea = (
    unit: Extract<PrintContentUnit, { type: "problemArea" }>,
    gapFreeHeightPx: number,
  ): boolean => {
    const safeMinHeightPx = getSafeProblemAreaMinHeightPx(unit.minHeightMm ?? 0, contentHeightPx);
    const hasReservationOnly = unit.blocks.length === 0 && safeMinHeightPx > 0;
    if ((!isFlowableProblemArea(unit, gapFreeHeightPx, contentHeightPx) && !hasReservationOnly) || (unit.blocks.length === 0 && !hasReservationOnly)) {
      return false;
    }

    // A full-span area has no "next column" to flow into — its only unit of
    // movement is a whole page, and every column must reserve the same height for
    // it (mirroring the atomic full-span placement above). A framed (non-full-span)
    // area behaves exactly like an ordinary flowable area otherwise.
    const isFullSpanFlow = unit.columnSpan === "full";
    const advanceAreaFlow = () => {
      if (isFullSpanFlow) {
        flushPage();
      } else {
        advanceColumn();
      }
    };

    const frameChromeHeightPxForRole = (role: ProblemFrameFragmentRole) => unit.hasFrame
      ? getPrintProblemFrameFragmentChromeHeightMm(unit.frameStyleId, role) * MM_TO_PX
      : 0;
    if (
      unit.isFirstProblemArea
      &&
      safeMinHeightPx > currentColumnRemainingHeight() + 0.5
      && safeMinHeightPx <= contentHeightPx + 0.5
    ) {
      advanceAreaFlow();
    }

    const fragments: Array<Extract<PrintContentUnit, { type: "problemAreaFragment" }>> = [];
    const fragmentColumns: PrintPaginatedColumn[] = [];
    let runBlocks: ProblemAreaBlock[] = [];
    let runContentHeight = 0;
    let emittedSliceContentBeforeFirstFragment = false;
    let lastPlacedContentIsAreaFragment = false;
    let occupiedAreaHeightPx = 0;

    const placeFragment = (
      fragmentBlocks: ProblemAreaBlock[],
      fragmentContentHeight: number,
      isLastFragment: boolean,
      layoutSectionFragment?: Extract<PrintContentUnit, { type: "layoutSectionFragment" }>,
      blockSlice?: Extract<PrintContentUnit, { type: "blockSlice" }>,
    ) => {
      const fragmentIndex = fragments.length;
      const fragmentRole: ProblemFrameFragmentRole = fragmentIndex === 0
        ? isLastFragment ? "single" : "first"
        : isLastFragment ? "last" : "middle";
      const fragmentHeight = fragmentContentHeight + frameChromeHeightPxForRole(fragmentRole);
      const fragment: Extract<PrintContentUnit, { type: "problemAreaFragment" }> = {
        type: "problemAreaFragment",
        id: `${unit.id}:area-fragment:${fragmentIndex}`,
        sourceId: unit.id,
        problemId: unit.problemId,
        area: unit.area,
        blocks: fragmentBlocks,
        layoutSectionFragment,
        blockSlice,
        fragmentRole,
        estimatedHeightPx: fragmentHeight,
        minHeightMm: undefined,
        problemNumber: unit.problemNumber,
        numberFontSize: unit.numberFontSize,
        hasFrame: unit.hasFrame,
        frameStyleId: unit.frameStyleId,
        columnSpan: unit.columnSpan,
        isFirstProblemArea: unit.isFirstProblemArea,
        isLastProblemArea: unit.isLastProblemArea,
        pagination: fragmentIndex === 0 ? unit.pagination : undefined,
      };
      fragments.push(fragment);
      lastPlacedContentIsAreaFragment = true;
      if (isFullSpanFlow) {
        if (pageHasColumnContent() && !pageContainsOnlyMatchingLead(unit)) {
          flushPage();
        }
        if (pageHasContent() && currentColumn().estimatedContentHeightPx + fragmentHeight > currentColumnHeight() + 0.5) {
          flushPage();
        }
        columns[0].blocks.push(fragment);
        for (const column of columns) {
          column.estimatedContentHeightPx += fragmentHeight;
        }
        fragmentColumns.push(columns[0]);
      } else {
        fragmentColumns.push(currentColumn());
        placeFlowUnit(fragment, fragmentHeight);
      }
      occupiedAreaHeightPx += fragmentHeight;
    };
    const flushRun = (isLastFragment = false) => {
      if (runBlocks.length === 0) {
        return;
      }

      placeFragment(runBlocks, runContentHeight, isLastFragment);
      runBlocks = [];
      runContentHeight = 0;
    };

    const placeFramedOverTallChild = (
      child: ProblemAreaBlock,
      childHeight: number,
      isLastAreaChild: boolean,
    ) => {
      const breakOffsets = getBlockSliceBreakOffsets(
        child,
        childHeight,
        measuredDescendantHeights,
        measuredBlockBreakOffsets.get(child.id),
      );
      let sliceTop = 0;
      let sliceIndex = 0;
      const sliceBudget = Math.min(MAX_PRINT_SLICES_PER_BLOCK, fragmentBudget.remainingSlices);
      if (sliceBudget <= 0) {
        placeFragment([child], childHeight, isLastAreaChild);
        return;
      }
      for (let guard = 0; sliceTop < childHeight - 0.5 && guard < sliceBudget - 1; guard += 1) {
        if (
          columnHasFlowContent(currentColumn())
          && currentColumnRemainingHeight() < Math.min(48, currentColumnHeight() * 0.2)
        ) {
          advanceAreaFlow();
        }
        const remaining = childHeight - sliceTop;
        const finalRole: ProblemFrameFragmentRole = fragments.length === 0 ? "single" : "last";
        const fitsAsLast = isLastAreaChild
          && remaining + frameChromeHeightPxForRole(finalRole) <= currentColumnRemainingHeight() + 0.5;
        const role: ProblemFrameFragmentRole = fitsAsLast
          ? finalRole
          : fragments.length === 0 ? "first" : "middle";
        const frameChromeHeightPx = frameChromeHeightPxForRole(role);
        const available = Math.max(1, currentColumnRemainingHeight() - frameChromeHeightPx);
        const step = resolveFlowFragmentStep({
          available,
          breakOffsets,
          fullSegmentHeight: Math.max(1, currentColumnHeight() - frameChromeHeightPx),
          remaining,
          sourceOffsetY: sliceTop,
        });
        if (step.advanceToNextSegment) {
          advanceAreaFlow();
          continue;
        }
        const slice: Extract<PrintContentUnit, { type: "blockSlice" }> = {
          type: "blockSlice",
          id: `${child.id}:slice:${sliceIndex}`,
          sourceId: child.id,
          block: child,
          sliceTop,
          sliceHeight: step.height,
          totalHeight: childHeight,
          fragmentRole: "middle",
          pagination: sliceIndex === 0 ? child.pagination : undefined,
        };
        const sliceIsLastFragment = fitsAsLast && step.height >= remaining - 0.5;
        placeFragment([], step.height, sliceIsLastFragment, undefined, slice);
        fragmentBudget.remainingSlices -= 1;
        sliceTop += step.height;
        sliceIndex += 1;
        if (sliceTop < childHeight - 0.5) {
          advanceAreaFlow();
        }
      }
      if (sliceTop < childHeight - 0.5) {
        const sliceHeight = childHeight - sliceTop;
        const slice: Extract<PrintContentUnit, { type: "blockSlice" }> = {
          type: "blockSlice",
          id: `${child.id}:slice:${sliceIndex}`,
          sourceId: child.id,
          block: child,
          sliceTop,
          sliceHeight,
          totalHeight: childHeight,
          fragmentRole: "middle",
          pagination: sliceIndex === 0 ? child.pagination : undefined,
        };
        placeFragment([], sliceHeight, isLastAreaChild, undefined, slice);
        fragmentBudget.remainingSlices -= 1;
      }
    };

    for (const [childIndex, child] of unit.blocks.entries()) {
      if (child.pagination?.break === true) {
        // "Is there content to break away from?" must count this area's own pending
        // run and already-emitted fragments, not just the shared column state: the
        // run has not reached the column yet, and a full-span fragment is
        // deliberately excluded from columnHasFlowContent (it is not "column flow"
        // content). Without those two, a break on the second block of an area that
        // starts a fresh column would emit two fragments into the SAME column —
        // drawing an open frame across a break that moved nothing.
        const hasContentBeforeBreak = fragments.length > 0
          || runBlocks.length > 0
          || (!isFullSpanFlow && (columnHasFlowContent(currentColumn()) || columnIndex > 0));
        flushRun();
        if (hasContentBeforeBreak) {
          advanceAreaFlow();
        }
      }

      const childHeight = getMeasuredOrEstimatedBlockHeight(child, measuredDescendantHeights);
      const childFitHeight = Math.max(0, childHeight - blockSpaceAfterPx(child));
      const nextChild = unit.blocks[childIndex + 1];
      const isLastAreaChild = childIndex === unit.blocks.length - 1;
      const keepWithNextHeight = child.pagination?.keepWithNext === true
        && nextChild
        && nextChild.pagination?.break !== true
        ? childHeight + Math.max(
          0,
          getMeasuredOrEstimatedBlockHeight(nextChild, measuredDescendantHeights) - blockSpaceAfterPx(nextChild),
        )
        : 0;
      const keepPairEndsArea = childIndex + 1 === unit.blocks.length - 1;
      const pendingChromeHeight = frameChromeHeightPxForRole(
        fragments.length === 0
          ? keepPairEndsArea ? "single" : "first"
          : keepPairEndsArea ? "last" : "middle",
      );
      const pendingHeight = runContentHeight + keepWithNextHeight + pendingChromeHeight;
      if (
        (columnHasFlowContent(currentColumn()) || runBlocks.length > 0)
        && keepWithNextHeight > 0
        && pendingHeight > currentColumnRemainingHeight() + 0.5
        && keepWithNextHeight + pendingChromeHeight <= contentHeightPx + 0.5
      ) {
        flushRun();
        advanceAreaFlow();
      }
      if (child.type === "layoutSection") {
        flushRun();
        const prospectiveRole: ProblemFrameFragmentRole = fragments.length === 0
          ? isLastAreaChild ? "single" : "first"
          : isLastAreaChild ? "last" : "middle";
        const frameChromeHeightPx = frameChromeHeightPxForRole(prospectiveRole);
        if (currentColumnRemainingHeight() <= 0.5) {
          advanceAreaFlow();
        }
        if (
          child.pagination?.keepTogether === true
          && columnHasFlowContent(currentColumn())
          && childHeight + frameChromeHeightPx > currentColumnRemainingHeight() + 0.5
          && childHeight + frameChromeHeightPx <= contentHeightPx + 0.5
        ) {
          advanceAreaFlow();
        }
        const sectionFragments = createLayoutSectionFragments(
          child,
          childHeight,
          child.pagination,
          currentColumnRemainingHeight(),
          frameChromeHeightPx,
        );
        if (sectionFragments) {
          sectionFragments.forEach((sectionFragment, sectionFragmentIndex) => {
            const isLastSectionFragment = isLastAreaChild && sectionFragmentIndex === sectionFragments.length - 1;
            const role: ProblemFrameFragmentRole = fragments.length === 0
              ? isLastSectionFragment ? "single" : "first"
              : isLastSectionFragment ? "last" : "middle";
            const sectionFragmentHeight = sectionFragment.estimatedHeightPx + frameChromeHeightPxForRole(role);
            if (
              columnHasFlowContent(currentColumn()) &&
              sectionFragmentHeight > currentColumnRemainingHeight() + 0.5
            ) {
              advanceAreaFlow();
            }
            placeFragment([], sectionFragment.estimatedHeightPx, isLastSectionFragment, sectionFragment);
            if (sectionFragmentIndex < sectionFragments.length - 1) {
              advanceAreaFlow();
            }
          });
        } else {
          const sectionFragmentHeight = childHeight + frameChromeHeightPx;
          if (
            sectionFragmentHeight > currentColumnRemainingHeight() + 0.5 &&
            sectionFragmentHeight <= contentHeightPx + 0.5
          ) {
            advanceAreaFlow();
          }
          placeFragment([child], childHeight, isLastAreaChild);
        }
        continue;
      }

      const prospectiveRole: ProblemFrameFragmentRole = fragments.length === 0
        ? isLastAreaChild ? "single" : "first"
        : isLastAreaChild ? "last" : "middle";
      const frameChromeHeightPx = frameChromeHeightPxForRole(prospectiveRole);
      const childExceedsFragmentCapacity = childHeight + frameChromeHeightPx > contentHeightPx + 0.5;
      if (childExceedsFragmentCapacity) {
        flushRun();
        if (unit.hasFrame) {
          placeFramedOverTallChild(child, childHeight, isLastAreaChild);
        } else if (childHeight > contentHeightPx + 0.5) {
          if (fragments.length === 0) {
            emittedSliceContentBeforeFirstFragment = true;
          }
          placeOverTallBlock({
            type: "block",
            id: child.id,
            block: child,
            pagination: child.pagination,
          }, childHeight);
          occupiedAreaHeightPx += childHeight;
          lastPlacedContentIsAreaFragment = false;
        } else {
          placeFragment([child], childHeight, isLastAreaChild);
        }
        continue;
      }

      const runRole: ProblemFrameFragmentRole = fragments.length === 0
        ? isLastAreaChild ? "single" : "first"
        : isLastAreaChild ? "last" : "middle";
      const runChromeHeightPx = frameChromeHeightPxForRole(runRole);
      const remainingAfterRun = Math.max(0, currentColumnRemainingHeight() - runContentHeight - runChromeHeightPx);
      if (
        (columnHasFlowContent(currentColumn()) || runBlocks.length > 0) &&
        childFitHeight > remainingAfterRun + 0.5 &&
        childHeight + runChromeHeightPx <= contentHeightPx + 0.5
      ) {
        flushRun();
        advanceAreaFlow();
      }

      runBlocks.push(child);
      runContentHeight += childHeight;

    }

    flushRun(true);

    // minHeight is an area-wide reservation. The actual occupied fragment height,
    // including each frame's chrome, consumes it; only the remainder flows after
    // the final content fragment, across as many columns/pages as needed.
    let trailingReservationPx = contentHeightPx > 0.5
      ? Math.max(0, safeMinHeightPx - occupiedAreaHeightPx)
      : 0;
    while (trailingReservationPx > 0.5) {
      const previousTrailingReservationPx = trailingReservationPx;
      if (currentColumnRemainingHeight() <= 0.5) {
        advanceAreaFlow();
        if (currentColumnRemainingHeight() <= 0.5) {
          break;
        }
      }
      const reservationChunk = Math.min(trailingReservationPx, currentColumnRemainingHeight());
      const lastFragment = fragments.at(-1);
      const lastFragmentColumn = fragmentColumns.at(-1);
      if (lastPlacedContentIsAreaFragment && lastFragment && lastFragmentColumn === currentColumn()) {
        lastFragment.estimatedHeightPx += reservationChunk;
        lastFragment.minHeightMm = lastFragment.estimatedHeightPx / MM_TO_PX;
        if (isFullSpanFlow) {
          for (const column of columns) {
            column.estimatedContentHeightPx += reservationChunk;
          }
        } else {
          currentColumn().estimatedContentHeightPx += reservationChunk;
        }
      } else {
        const isLastReservationFragment = trailingReservationPx <= reservationChunk + 0.5;
        const reservationRole: ProblemFrameFragmentRole = fragments.length === 0
          ? isLastReservationFragment ? "single" : "first"
          : isLastReservationFragment ? "last" : "middle";
        const reservationContentHeight = Math.max(
          0,
          reservationChunk - frameChromeHeightPxForRole(reservationRole),
        );
        placeFragment([], reservationContentHeight, isLastReservationFragment);
        const reservationFragment = fragments.at(-1);
        if (reservationFragment) {
          reservationFragment.minHeightMm = reservationFragment.estimatedHeightPx / MM_TO_PX;
        }
      }
      trailingReservationPx -= reservationChunk;
      if (trailingReservationPx >= previousTrailingReservationPx - 0.5) {
        break;
      }
      if (trailingReservationPx > 0.5) {
        advanceAreaFlow();
      }
    }

    fragments.forEach((fragment, index) => {
      fragment.fragmentRole = emittedSliceContentBeforeFirstFragment
        ? index === fragments.length - 1
          ? "last"
          : "middle"
        : fragments.length === 1
          ? "single"
          : index === 0
            ? "first"
            : index === fragments.length - 1
              ? "last"
              : "middle";
      if (fragment.blockSlice) {
        fragment.blockSlice.fragmentRole = fragment.fragmentRole;
      }
    });

    return true;
  };
  const placeBreakableLayoutSection = (
    unit: Extract<PrintContentUnit, { type: "block" }>,
    totalHeight: number,
  ): boolean => {
    const layoutSection = unit.block;
    if (layoutSection.type !== "layoutSection" || layoutSection.children.length === 0) {
      return false;
    }

    if (
      layoutSection.pagination?.keepTogether === true
      && columnHasFlowContent(currentColumn())
      && totalHeight > currentColumnRemainingHeight() + 0.5
      && totalHeight <= currentColumnHeight() + 0.5
    ) {
      advanceColumn();
      return false;
    }

    const fragments = createLayoutSectionFragments(
      layoutSection,
      totalHeight,
      unit.pagination,
      currentColumnRemainingHeight(),
    );
    if (!fragments) {
      return false;
    }
    fragments.forEach((fragment, index) => {
      if (
        columnHasFlowContent(currentColumn()) &&
        currentColumn().estimatedContentHeightPx + fragment.estimatedHeightPx > currentColumnHeight() + 0.5
      ) {
        advanceColumn();
      }

      placeFlowUnit(fragment, fragment.estimatedHeightPx);
      if (index < fragments.length - 1) {
        advanceColumn();
      }
    });

    return true;
  };

  blocks.forEach((block, index) => {
    const blockHeight = heights[index] || 0;
    const blockFlowHeight = flowHeights[index] ?? blockHeight;
    // 実測 (と推定) の高さにはブロック下余白 (padding) が入っている。**収まり判定からは除き、
    // カーソル前進には含める** — 本文フローの `PaginationItem.trailingSpacePx` と同じ規約。
    // ここを揃えないと、同じ文書でエディタ/PDF は 1 ページ目に残すブロックを、印刷プレビューと
    // 埋め込みビューアだけ次ページへ送る。
    const blockFitHeight = Math.max(
      0,
      blockHeight - (block.type === "block" ? blockSpaceAfterPx(block.block) : 0),
    );
    if (pageHasContent() && block.pagination?.break === true) {
      advanceForExplicitBreak();
    }

    keepWithNextIfPossible(index);
    // A flowable problem area (ordinary, or framed/full-span with a manual break
    // inside — see isFlowableProblemArea) is handled entirely by its own fragment
    // placer, including full-span fragments (placeFlowableProblemArea reserves
    // height across all columns for those). Only an ATOMIC full-span area falls
    // through to the whole-unit full-span placement below.
    if (block.type === "problemArea" && placeFlowableProblemArea(block, blockHeight)) {
      return;
    }

    if (isFullSpanPrintUnit(block)) {
      if (
        pageHasColumnContent()
        && !(block.type === "problemArea" && pageContainsOnlyMatchingLead(block))
      ) {
        flushPage();
      }

      if (pageHasContent() && currentColumn().estimatedContentHeightPx + blockFitHeight > currentColumnHeight()) {
        flushPage();
      }

      columns[0].blocks.push(block);
      for (const column of columns) {
        column.estimatedContentHeightPx += Math.max(blockHeight, blockFlowHeight);
        if (blockHeight > currentColumnHeight()) {
          column.oversizedBlockIds.push(block.id);
        }
      }

      return;
    }

    const isBreakableBox = block.type === "block"
      && block.block.type === "boxBlock"
      && block.block.blocks.length > 0;

    // Atomic content taller than a whole column cannot be split at a child boundary,
    // so it must be pixel-sliced: a standalone over-tall block, or a box whose own
    // child is taller than a column (which child-boundary splitting can't rescue).
    // Compare against the full column height (not the header-reduced first page) so a
    // block that fits a full column is moved, not sliced.
    const mustSlice = block.type === "block" && (
      block.block.type === "boxBlock"
        ? boxHasOverTallChild(block.block, contentHeightPx, measuredDescendantHeights)
        : block.block.type !== "layoutSection" && blockFitHeight > contentHeightPx + 0.5
    );

    if (isBreakableBox || mustSlice) {
      // Flows like body text: it fills the rest of the current column/page and
      // continues, open-edged, on the next. The placer advances columns itself, so
      // we must NOT push the whole block to a fresh page/column here — that would
      // waste the rest of this page.
    } else if (blockFitHeight > currentColumnHeight() + 0.5 && pageHasContent()) {
      flushPage();
    } else if (
      columnHasFlowContent(currentColumn()) &&
      currentColumn().estimatedContentHeightPx + blockFitHeight > currentColumnHeight()
    ) {
      advanceColumn();
    } else if (
      !columnHasFlowContent(currentColumn()) &&
      currentColumn().estimatedContentHeightPx > 0.5 &&
      currentColumn().estimatedContentHeightPx + blockFitHeight > currentColumnHeight()
    ) {
      flushPage();
    }

    if (mustSlice && block.type === "block") {
      placeOverTallBlock(block, blockHeight);
      return;
    }

    if (block.type === "block" && placeBreakableBox(block, blockHeight)) {
      return;
    }

    if (block.type === "block" && placeBreakableLayoutSection(block, blockHeight)) {
      return;
    }

    placeFlowUnit(block, blockHeight, blockFlowHeight);

  });

  flushPage();
  if (pageBudgetExhausted) {
    const lastPage = pages.at(-1);
    if (lastPage) {
      lastPage.blocks = lastPage.columns.flatMap((column) => column.blocks);
      lastPage.estimatedContentHeightPx = lastPage.columns.reduce(
        (height, column) => height + column.estimatedContentHeightPx,
        0,
      );
      lastPage.oversizedBlockIds = lastPage.columns.flatMap((column) => column.oversizedBlockIds);
    }
  }
  return pages.length > 0 ? pages : [createEmptyPrintPage(1, columnCount)];
}

function estimatePrintBoxFragmentChromeHeight(block: Extract<SigmaBlock, { type: "boxBlock" }>): number {
  const frame = resolveBoxFrame(block);
  const padding = frame.paddingPx ?? { top: 12, right: 14, bottom: 12, left: 14 };
  const title = boxBlockTitleText(block);
  const titleHeight = title ? 24 : 0;
  return padding.top + padding.bottom + titleHeight;
}

/**
 * True when a box has a single child too tall to ever fit a full column, so it
 * cannot be split cleanly at child boundaries — the whole box must be split
 * visually (pixel-sliced) instead.
 */
function boxHasOverTallChild(
  block: Extract<SigmaBlock, { type: "boxBlock" }>,
  columnHeightPx: number,
  measuredDescendantHeights: Map<string, number>,
): boolean {
  const chrome = estimatePrintBoxFragmentChromeHeight(block);
  return block.blocks.some(
    (child) => chrome + getMeasuredOrEstimatedBlockHeight(child, measuredDescendantHeights) > columnHeightPx + 0.5,
  );
}

/**
 * Break offsets (px from the block top) at which a visual slice can end without
 * cutting through structured content. Child-block bottoms remain valid box
 * boundaries; measured visual-line boundaries additionally cover one very long
 * child. This uses the same line-safe contract as the page canvas.
 */
function getBlockSliceBreakOffsets(
  block: SigmaBlock,
  totalHeight: number,
  measuredDescendantHeights: Map<string, number>,
  measuredBreakOffsets?: number[],
): number[] {
  if (block.type !== "boxBlock") {
    return measuredBreakOffsets ?? [];
  }
  const frame = resolveBoxFrame(block);
  const padding = frame.paddingPx ?? { top: 12, right: 14, bottom: 12, left: 14 };
  const title = boxBlockTitleText(block);
  let cursor = padding.top + (title ? 24 : 0);
  const offsets: number[] = [];
  for (const child of block.blocks) {
    cursor += getMeasuredOrEstimatedBlockHeight(child, measuredDescendantHeights);
    if (cursor > 0.5 && cursor < totalHeight - 0.5) {
      offsets.push(Math.round(cursor));
    }
  }
  return Array.from(new Set([...offsets, ...(measuredBreakOffsets ?? [])]))
    .filter((offset) => offset > 0.5 && offset < totalHeight - 0.5)
    .sort((left, right) => left - right);
}

function getMeasuredOrEstimatedBlockHeight(
  block: SigmaBlock | RichBlock,
  measuredDescendantHeights: Map<string, number>,
  charsPerLine?: number,
): number {
  return measuredDescendantHeights.get(block.id) ?? estimateBlockHeightPx(block, charsPerLine);
}

function getMeasuredDescendantHeightMap(nestedRects: MeasuredBlock[][]): Map<string, number> {
  const heights = new Map<string, number>();
  nestedRects.forEach((rects) => {
    rects.forEach((rect) => {
      heights.set(rect.id, rect.height ?? 0);
    });
  });
  return heights;
}

function getMeasuredPrintBlockRects(
  pages: PrintPaginatedPage[],
  blocks: PrintContentUnit[],
  heights: number[],
  flowHeights: number[],
  marginTopPx: number,
  marginLeftPx: number,
  columnWidthPx: number,
  columnGapPx: number,
  pageStridePx: number,
  firstPageHeaderHeightPx: number,
  nestedRects: MeasuredBlock[][],
  measuredDescendantHeights: Map<string, number>,
): Map<string, MeasuredBlock> {
  const heightById = new Map(blocks.map((block, index) => [block.id, heights[index] || 0]));
  const flowHeightById = new Map(blocks.map((block, index) => [block.id, flowHeights[index] ?? heights[index] ?? 0]));
  const nestedRectsById = new Map(blocks.map((block, index) => [block.id, nestedRects[index] ?? []]));
  const rects = new Map<string, MeasuredBlock>();

  for (const page of pages) {
    const pageTop = (page.number - 1) * pageStridePx;
    const headerOffset = page.number === 1 ? firstPageHeaderHeightPx : 0;
    let fullSpanCursorY = headerOffset;
    for (const block of getPageFullSpanBlocks(page)) {
      const height = getPrintContentUnitHeight(block, heightById, measuredDescendantHeights);
      const blockRect = {
        id: block.id,
        top: pageTop + marginTopPx + fullSpanCursorY,
        left: marginLeftPx,
        width: columnWidthPx * Math.max(1, page.columns.length) + columnGapPx * Math.max(0, page.columns.length - 1),
        height,
      };
      rects.set(block.id, blockRect);

      for (const nested of nestedRectsById.get(block.id) ?? []) {
        rects.set(nested.id, translateNestedMeasuredBlock(nested, blockRect.top, blockRect.left));
      }
      fullSpanCursorY += getPrintContentUnitFlowHeight(block, heightById, flowHeightById, measuredDescendantHeights);
    }

    for (const column of page.columns) {
      const left = marginLeftPx + (column.number - 1) * (columnWidthPx + columnGapPx);
      let cursorY = fullSpanCursorY;
      for (const block of getColumnFlowBlocks(column)) {
        const height = getPrintContentUnitHeight(block, heightById, measuredDescendantHeights);
        const blockRect = {
          id: block.id,
          top: pageTop + marginTopPx + cursorY,
          left,
          width: columnWidthPx,
          height,
        };
        rects.set(block.id, blockRect);
        // Anchor the source block (e.g. for overlays) to the top of its first slice.
        if (block.type === "blockSlice" && (block.fragmentRole === "first" || block.fragmentRole === "single")) {
          rects.set(block.sourceId, { ...blockRect, id: block.sourceId, height: block.totalHeight });
        }
        if (block.type === "problemAreaFragment") {
          const sourceNestedRects = nestedRectsById.get(block.sourceId) ?? [];
          if (block.fragmentRole === "first" || block.fragmentRole === "single") {
            const sourceHeight = heightById.get(block.sourceId) ?? blockRect.height;
            rects.set(block.sourceId, {
              ...blockRect,
              id: block.sourceId,
              height: sourceHeight,
            });
            if (block.isFirstProblemArea) {
              const measuredProblemAnchor = sourceNestedRects.find((nested) => nested.id === block.problemId);
              rects.set(block.problemId, {
                ...blockRect,
                id: block.problemId,
                height: measuredProblemAnchor?.height ?? sourceHeight,
              });
            }
          }

          const fragmentBlockIds = collectProblemAreaBlockSubtreeIds(block.blocks);
          const firstBlockRect = sourceNestedRects.find((nested) => nested.id === block.blocks[0]?.id);
          const firstBlockTop = firstBlockRect?.top ?? 0;
          const showsProblemNumber = block.area === "lead" &&
            typeof block.problemNumber === "number" &&
            (block.fragmentRole === "first" || block.fragmentRole === "single");
          const sourceLeftOrigin = showsProblemNumber ? 0 : firstBlockRect?.left ?? 0;
          for (const nested of sourceNestedRects) {
            if (!fragmentBlockIds.has(nested.id)) {
              continue;
            }
            rects.set(
              nested.id,
              translateNestedMeasuredBlock(
                nested,
                blockRect.top - firstBlockTop,
                blockRect.left,
                sourceLeftOrigin,
              ),
            );
          }
        } else {
          for (const nested of nestedRectsById.get(block.id) ?? []) {
            rects.set(nested.id, translateNestedMeasuredBlock(nested, blockRect.top, blockRect.left));
          }
        }
        cursorY += getPrintContentUnitFlowHeight(block, heightById, flowHeightById, measuredDescendantHeights);
      }
    }
  }

  return rects;
}

export function translateNestedMeasuredBlock(
  rect: MeasuredBlock,
  topOffset: number,
  leftOffset: number,
  sourceLeftOrigin = 0,
): MeasuredBlock {
  return {
    ...rect,
    top: topOffset + rect.top,
    left: leftOffset + (rect.left ?? 0) - sourceLeftOrigin,
    lines: rect.lines?.map((line) => ({
      ...line,
      top: topOffset + line.top,
      left: typeof line.left === "number"
        ? leftOffset + line.left - sourceLeftOrigin
        : line.left,
    })),
  };
}

function collectProblemAreaBlockSubtreeIds(blocks: ProblemAreaBlock[]): Set<string> {
  const ids = new Set<string>();

  const visitBlock = (block: SigmaBlock) => {
    ids.add(block.id);
    if (block.type === "list") {
      for (const item of block.items) {
        ids.add(item.id);
        item.nested?.forEach(visitBlock);
      }
      return;
    }

    if (block.type === "layoutSection") {
      block.children.forEach(visitBlock);
      return;
    }

    if (block.type === "boxBlock") {
      block.blocks.forEach(visitBlock);
      return;
    }

    if (block.type === "problem") {
      block.lead.forEach(visitBlock);
      block.prompt.forEach(visitBlock);
      block.hints.forEach(visitBlock);
      block.solution.forEach(visitBlock);
    }
  };

  blocks.forEach(visitBlock);
  return ids;
}

function getPrintContentUnitHeight(
  unit: PrintContentUnit,
  heightById: Map<string, number>,
  measuredDescendantHeights: Map<string, number>,
): number {
  if (
    unit.type === "boxFragment" ||
    unit.type === "layoutSectionFragment" ||
    unit.type === "problemAreaFragment"
  ) {
    return unit.estimatedHeightPx;
  }

  if (unit.type === "blockSlice") {
    return unit.sliceHeight;
  }

  return heightById.get(unit.id) ?? measuredDescendantHeights.get(unit.id) ?? 0;
}

function getPrintContentUnitFlowHeight(
  unit: PrintContentUnit,
  heightById: Map<string, number>,
  flowHeightById: Map<string, number>,
  measuredDescendantHeights: Map<string, number>,
): number {
  if (
    unit.type === "boxFragment" ||
    unit.type === "layoutSectionFragment" ||
    unit.type === "blockSlice" ||
    unit.type === "problemAreaFragment"
  ) {
    return getPrintContentUnitHeight(unit, heightById, measuredDescendantHeights);
  }

  return Math.max(
    getPrintContentUnitHeight(unit, heightById, measuredDescendantHeights),
    flowHeightById.get(unit.id) ?? 0,
  );
}

function measurePrintContentUnits(
  measureRoot: HTMLElement,
  units: PrintContentUnit[],
): PrintContentMeasurement[] {
  const entries = units.map((unit, index) => {
    const element = measureRoot.querySelector<HTMLElement>(`[data-print-measure-index="${index}"]`);
    if (!element) {
      return null;
    }

    const rect = element.getBoundingClientRect();
    return {
      element,
      height: rect.height,
      top: rect.top,
      descendantRects: getMeasuredPrintDescendantRects(element, unit.id),
      breakOffsets: getMeasuredPrintUnitBreakOffsets(element, unit),
    };
  });

  return entries.map((entry, index) => {
    if (!entry) {
      return { height: 0, flowHeight: 0, descendantRects: [], breakOffsets: [] };
    }

    const nextEntry = entries.slice(index + 1).find(
      (candidate): candidate is NonNullable<(typeof entries)[number]> => candidate !== null,
    );
    const flowHeight = nextEntry
      ? Math.max(entry.height, nextEntry.top - entry.top)
      : measureLastPrintUnitFlowHeight(entry.element, entry.height);
    return {
      height: entry.height,
      flowHeight,
      descendantRects: entry.descendantRects,
      breakOffsets: entry.breakOffsets,
    };
  });
}

/**
 * Every block may become an over-tall visual slice. Capture safe positions after
 * each rendered line, including wrapped lines, from the same measurement DOM used
 * for total height so print slices cannot cut through glyphs.
 */
function getMeasuredPrintUnitBreakOffsets(root: HTMLElement, unit: PrintContentUnit): number[] {
  if (unit.type !== "block") {
    return [];
  }
  const element = root.querySelector<HTMLElement>(
    `[data-sigma-doc-id="${CSS.escape(unit.block.id)}"]`,
  );
  if (!element) {
    return [];
  }
  const rect = element.getBoundingClientRect();
  const measuredElements = unit.block.type === "boxBlock"
    ? getLeafPrintBoxBlockElements(element)
    : [element];
  return getMeasuredLineBreakOffsets(
    measuredElements.flatMap((candidate) => measureElementLineBoxes(candidate, rect, 1, 1)),
  )
    .filter((offset) => offset > 0.5 && offset < rect.height - 0.5);
}

function getLeafPrintBoxBlockElements(box: HTMLElement): HTMLElement[] {
  const descendants = Array.from(box.querySelectorAll<HTMLElement>(
    ":scope > .print-box-body [data-sigma-doc-id]",
  ));
  return descendants.filter((candidate) =>
    !descendants.some((other) => other !== candidate && candidate.contains(other)),
  );
}

function measureLastPrintUnitFlowHeight(element: HTMLElement, height: number): number {
  const marginBottom = parseCssPixelValue(getComputedStyle(element).marginBottom);
  return height + marginBottom;
}

function parseCssPixelValue(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isFullSpanPrintUnit(unit: PrintContentUnit): boolean {
  return (unit.type === "problemArea" || unit.type === "problemAreaFragment") && unit.columnSpan === "full";
}

function getPageFullSpanBlocks(page: PrintPaginatedPage): PrintContentUnit[] {
  return page.columns[0]?.blocks.filter(isFullSpanPrintUnit) ?? [];
}

function getColumnFlowBlocks(column: PrintPaginatedColumn): PrintContentUnit[] {
  return column.blocks.filter((unit) => !isFullSpanPrintUnit(unit));
}

function getMeasuredPrintDescendantRects(root: HTMLElement, topLevelBlockId: string): MeasuredBlock[] {
  const rootRect = root.getBoundingClientRect();
  const seen = new Set<string>([topLevelBlockId]);
  const rects: MeasuredBlock[] = [];

  root.querySelectorAll<HTMLElement>("[data-sigma-doc-id]").forEach((element) => {
    const id = element.getAttribute("data-sigma-doc-id");
    if (!id || seen.has(id)) {
      return;
    }
    seen.add(id);
    const rect = element.getBoundingClientRect();
    rects.push({
      id,
      top: rect.top - rootRect.top,
      left: rect.left - rootRect.left,
      width: rect.width,
      height: rect.height,
      lines: measureElementLineBoxes(element, rootRect, 1, 1),
    });
  });

  return rects;
}

function resolvePrintOverlay(
  overlay: PageOverlay | undefined,
  blockRects: Map<string, MeasuredBlock>,
): PageOverlay | undefined {
  if (!overlay?.overlaySnapshot) {
    return overlay;
  }

  const snapshot = normalizeOverlaySnapshot(overlay.overlaySnapshot);
  const shapes = resolveShapesPosition(snapshot.shapes, blockRects);
  return {
    ...overlay,
    overlaySnapshot: {
      ...snapshot,
      shapes,
    },
  };
}

function extendPagesForOverlay(
  pages: PrintPaginatedPage[],
  overlay: PageOverlay | undefined,
  columnCount: number,
  pageHeightPx: number,
  pageStridePx: number,
): PrintPaginatedPage[] {
  const snapshot = overlay?.overlaySnapshot ? normalizeOverlaySnapshot(overlay.overlaySnapshot) : null;
  if (!snapshot) {
    return pages;
  }

  const maxShapeBottom = snapshot.shapes.reduce((bottom, shape) => {
    if (shape.hidden) {
      return bottom;
    }

    const bounds = getShapeBounds(shape);
    return Math.max(bottom, bounds.y + bounds.h);
  }, 0);
  const overlayPageCount = maxShapeBottom > pageHeightPx + OVERLAY_PAGE_EXTENT_EPSILON_PX
    ? Math.ceil((maxShapeBottom - pageHeightPx - OVERLAY_PAGE_EXTENT_EPSILON_PX) / pageStridePx) + 1
    : 1;

  if (overlayPageCount <= pages.length) {
    return pages;
  }

  return [
    ...pages,
    ...Array.from({ length: overlayPageCount - pages.length }, (_, index) => {
      const number = pages.length + index + 1;
      return createEmptyPrintPage(number, columnCount);
    }),
  ];
}

function createEmptyPrintPage(number: number, columnCount: number): PrintPaginatedPage {
  return {
    id: `page_${number}`,
    number,
    blocks: [],
    columns: Array.from({ length: Math.max(1, columnCount) }, (_, index) => ({
      id: `column_${index + 1}`,
      number: index + 1,
      blocks: [],
      estimatedContentHeightPx: 0,
      oversizedBlockIds: [],
    })),
    estimatedContentHeightPx: 0,
    oversizedBlockIds: [],
  };
}

function samePrintPagination(current: PrintPaginatedPage[] | null, next: PrintPaginatedPage[]): boolean {
  if (!current || current.length !== next.length) {
    return false;
  }

  return current.every((page, pageIndex) => {
    const nextPage = next[pageIndex];
    return (
      page.columns.length === nextPage.columns.length &&
      page.columns.every((column, columnIndex) => {
        const nextColumn = nextPage.columns[columnIndex];
        return (
          column.blocks.length === nextColumn.blocks.length &&
          column.blocks.every((block, blockIndex) => samePrintUnitPagination(block, nextColumn.blocks[blockIndex]))
        );
      })
    );
  });
}

function samePrintUnitPagination(current: PrintContentUnit, next: PrintContentUnit): boolean {
  if (current.id !== next.id || current.type !== next.type) {
    return false;
  }

  if (current.type === "boxFragment" && next.type === "boxFragment") {
    return (
      current.fragmentRole === next.fragmentRole &&
      Math.abs(current.estimatedHeightPx - next.estimatedHeightPx) < 0.5 &&
      Math.abs(current.totalHeight - next.totalHeight) < 0.5 &&
      current.blocks.length === next.blocks.length &&
      current.blocks.every((block, index) => block.id === next.blocks[index].id)
    );
  }

  if (current.type === "layoutSectionFragment" && next.type === "layoutSectionFragment") {
    return (
      current.fragmentRole === next.fragmentRole &&
      current.columns.length === next.columns.length &&
      current.columns.every((column, columnIndex) => {
        const nextColumn = next.columns[columnIndex];
        return (
          column.blocks.length === nextColumn.blocks.length &&
          column.blocks.every((block, blockIndex) => samePrintUnitPagination(block, nextColumn.blocks[blockIndex]))
        );
      })
    );
  }

  if (current.type === "blockSlice" && next.type === "blockSlice") {
    return (
      current.fragmentRole === next.fragmentRole &&
      Math.abs(current.sliceTop - next.sliceTop) < 0.5 &&
      Math.abs(current.sliceHeight - next.sliceHeight) < 0.5
    );
  }

  if (current.type === "problemAreaFragment" && next.type === "problemAreaFragment") {
    return (
      current.fragmentRole === next.fragmentRole &&
      Math.abs(current.estimatedHeightPx - next.estimatedHeightPx) < 0.5 &&
      current.blocks.length === next.blocks.length &&
      current.blocks.every((block, index) => block.id === next.blocks[index].id) &&
      (current.layoutSectionFragment === undefined) === (next.layoutSectionFragment === undefined) &&
      (!current.layoutSectionFragment || !next.layoutSectionFragment
        || samePrintUnitPagination(current.layoutSectionFragment, next.layoutSectionFragment)) &&
      (current.blockSlice === undefined) === (next.blockSlice === undefined) &&
      (!current.blockSlice || !next.blockSlice
        || samePrintUnitPagination(current.blockSlice, next.blockSlice))
    );
  }

  return true;
}

function sameBlockRectMap(current: Map<string, MeasuredBlock>, next: Map<string, MeasuredBlock>): boolean {
  if (current.size !== next.size) {
    return false;
  }

  for (const [id, rect] of next) {
    const currentRect = current.get(id);
    if (
      !currentRect ||
      Math.abs(currentRect.top - rect.top) > 0.5 ||
      Math.abs((currentRect.left ?? 0) - (rect.left ?? 0)) > 0.5 ||
      Math.abs((currentRect.width ?? 0) - (rect.width ?? 0)) > 0.5 ||
      Math.abs((currentRect.height ?? 0) - (rect.height ?? 0)) > 0.5
    ) {
      return false;
    }
  }

  return true;
}
