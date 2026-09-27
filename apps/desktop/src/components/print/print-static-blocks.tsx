import { ColumnRuleLines } from "@/features/rendering/adapters/react";
import { createColumnRuleStyle } from "@/features/rendering/adapters";
import { Fragment, type CSSProperties } from "react";

import { PrintableRichBlock } from "@/components/print/PrintableRichBlock";
import { useProblemNumbers } from "@/components/editor/text-flow/ProblemNumberingContext";
import { useHeadingNumber } from "@/components/editor/text-flow/HeadingNumberingContext";
import {
  blockSpaceAfterStyleVars,
  PROBLEM_AREA_ORDER,
  type BoxBlockChildBlock,
  type PaginationHints,
  type ProblemAreaBlock,
  type ProblemAreaColumnSpan,
  type ProblemAreaKind,
  type SigmaBlock,
  type SigmaDocument,
} from "@/features/document";
import { renderInlineContent } from "@/features/rendering/adapters/react";
import { getProblemNumberFontSize, getLayoutSectionColumns, getLayoutSectionColumnWidths, migrateLegacyLayoutColumns } from "@/features/text-editing/model";
import { createIndependentColumnLayout } from "@/features/rendering/core";
import {
  boxBlockTitleText,
  boxFrameClassName,
  boxFrameDecorationAttributes,
  boxFrameStyleVars,
  cornerBoxReferenceHeightStyleVars,
  resolveBoxFrame,
} from "@/lib/box-blocks";
import { formatProblemNumber } from "@/lib/problem-numbering";
import {
  getProblemFrameStyleId,
  problemFrameClassName,
} from "@/lib/problem-frame";

export type PrintContentUnit =
  | {
      type: "block";
      id: string;
      block: SigmaBlock;
      pagination?: PaginationHints;
    }
  | {
      type: "boxFragment";
      id: string;
      sourceId: string;
      block: Extract<SigmaBlock, { type: "boxBlock" }>;
      blocks: BoxBlockChildBlock[];
      fragmentRole: "single" | "first" | "middle" | "last";
      estimatedHeightPx: number;
      totalHeight: number;
      includeTitle: boolean;
      pagination?: PaginationHints;
    }
  | {
      type: "layoutSectionFragment";
      id: string;
      sourceId: string;
      block: Extract<SigmaBlock, { type: "layoutSection" }>;
      columns: PrintPaginatedColumn[];
      fragmentRole: "single" | "first" | "middle" | "last";
      estimatedHeightPx: number;
      columnGapMm: number;
      pagination?: PaginationHints;
    }
  | {
      type: "blockSlice";
      id: string;
      sourceId: string;
      block: SigmaBlock;
      sliceTop: number;
      sliceHeight: number;
      totalHeight: number;
      fragmentRole: "single" | "first" | "middle" | "last";
      pagination?: PaginationHints;
    }
  | {
      type: "problemArea";
      id: string;
      problemId: string;
      area: ProblemAreaKind;
      blocks: ProblemAreaBlock[];
      minHeightMm?: number;
      problemNumber?: number;
      numberFontSize: number;
      hasFrame: boolean;
      frameStyleId?: string;
      isFirstProblemArea: boolean;
      isLastProblemArea: boolean;
      isFirstProblemFrameArea: boolean;
      isLastProblemFrameArea: boolean;
      columnSpan?: ProblemAreaColumnSpan;
      pagination?: PaginationHints;
    }
  | {
      type: "problemAreaFragment";
      id: string;
      sourceId: string;
      problemId: string;
      area: ProblemAreaKind;
      blocks: ProblemAreaBlock[];
      layoutSectionFragment?: Extract<PrintContentUnit, { type: "layoutSectionFragment" }>;
      blockSlice?: Extract<PrintContentUnit, { type: "blockSlice" }>;
      fragmentRole: "single" | "first" | "middle" | "last";
      estimatedHeightPx: number;
      minHeightMm?: number;
      problemNumber?: number;
      numberFontSize: number;
      hasFrame: boolean;
      frameStyleId?: string;
      columnSpan?: ProblemAreaColumnSpan;
      isFirstProblemArea: boolean;
      isLastProblemArea: boolean;
      pagination?: PaginationHints;
    };

export interface PrintPaginatedColumn {
  id: string;
  number: number;
  blocks: PrintContentUnit[];
  estimatedContentHeightPx: number;
  oversizedBlockIds: string[];
}

export function buildProblemAreaPrintUnits(
  problem: Extract<SigmaBlock, { type: "problem" }>,
  problemNumber?: number,
): Array<Extract<PrintContentUnit, { type: "problemArea" }>> {
  const areas = PROBLEM_AREA_ORDER
    .map((area) => ({
      area,
      blocks: problem[area],
      minHeightMm: problem.areaLayout?.[area]?.minHeightMm,
      columnSpan: problem.areaLayout?.[area]?.columnSpan,
    }))
    .filter(({ area, blocks, minHeightMm }) => (
      area === "lead"
        ? typeof problemNumber === "number" || blocks.length > 0 || Boolean(minHeightMm)
        : area === "prompt" || blocks.length > 0 || Boolean(minHeightMm)
    ));
  const frameAreas = areas.filter(({ area }) => isProblemFrameArea(area));
  const firstFrameArea = frameAreas[0]?.area;
  const lastFrameArea = frameAreas.at(-1)?.area;

  return areas.map((areaUnit, index) => ({
    type: "problemArea",
    id: `${problem.id}:${areaUnit.area}`,
    problemId: problem.id,
    area: areaUnit.area,
    blocks: areaUnit.blocks,
    minHeightMm: areaUnit.minHeightMm,
    problemNumber,
    numberFontSize: getProblemNumberFontSize(problem),
    hasFrame: problem.frame?.enabled === true && isProblemFrameArea(areaUnit.area),
    frameStyleId: problem.frame?.enabled === true && isProblemFrameArea(areaUnit.area)
      ? getProblemFrameStyleId(problem)
      : undefined,
    isFirstProblemArea: index === 0,
    isLastProblemArea: index === areas.length - 1,
    isFirstProblemFrameArea: areaUnit.area === firstFrameArea,
    isLastProblemFrameArea: areaUnit.area === lastFrameArea,
    columnSpan: areaUnit.columnSpan,
    pagination: paginationForProblemArea(problem.pagination, index),
  }));
}

/** 問題の改ページ指定は先頭エリアの前でだけ効く。 */
function paginationForProblemArea(
  pagination: PaginationHints | undefined,
  index: number,
): PaginationHints | undefined {
  return index === 0 && pagination?.break === true ? { break: true } : undefined;
}

function isProblemFrameArea(area: ProblemAreaKind): boolean {
  return area === "prompt";
}

export function PrintBlock({
  unit,
  columnGapMm,
  mathFractionSizing,
}: {
  unit: PrintContentUnit;
  columnGapMm: number;
  mathFractionSizing?: SigmaDocument["metadata"]["mathFractionSizing"];
}) {
  if (unit.type === "problemArea") {
    return <PrintProblemArea {...unit} columnGapMm={columnGapMm} mathFractionSizing={mathFractionSizing} />;
  }

  if (unit.type === "problemAreaFragment") {
    const isFirstFragment = unit.fragmentRole === "single" || unit.fragmentRole === "first";
    const isLastFragment = unit.fragmentRole === "single" || unit.fragmentRole === "last";
    return (
      <PrintProblemArea
        problemId={unit.problemId}
        area={unit.area}
        minHeightMm={unit.minHeightMm}
        problemNumber={unit.problemNumber}
        numberFontSize={unit.numberFontSize}
        hasFrame={unit.hasFrame}
        frameStyleId={unit.frameStyleId}
        isFirstProblemArea={unit.isFirstProblemArea}
        isFirstProblemFrameArea={unit.hasFrame && isFirstFragment}
        isLastProblemFrameArea={unit.hasFrame && isLastFragment}
        columnGapMm={columnGapMm}
        mathFractionSizing={mathFractionSizing}
        blocks={unit.blocks}
        layoutSectionFragment={unit.layoutSectionFragment}
        blockSlice={unit.blockSlice}
        fragmentRole={unit.fragmentRole}
        sourceId={unit.sourceId}
      />
    );
  }

  if (unit.type === "boxFragment") {
    return (
      <PrintBoxBlock
        block={unit.block}
        columnGapMm={columnGapMm}
        fragmentBlocks={unit.blocks}
        fragmentRole={unit.fragmentRole}
        includeTitle={unit.includeTitle}
        cornerReferenceHeightPx={unit.totalHeight}
        mathFractionSizing={mathFractionSizing}
      />
    );
  }

  if (unit.type === "layoutSectionFragment") {
    return <PrintLayoutSectionFragment unit={unit} mathFractionSizing={mathFractionSizing} />;
  }

  if (unit.type === "blockSlice") {
    return (
      <div
        className={`print-block-slice print-block-slice-${unit.fragmentRole}`}
        data-block-slice={unit.fragmentRole}
        data-block-source-id={unit.sourceId}
        style={{ height: `${Math.round(unit.sliceHeight * 100) / 100}px`, overflow: "hidden" }}
      >
        <div className="print-block-slice-inner" style={{ marginTop: `${-Math.round(unit.sliceTop * 100) / 100}px` }}>
          <PrintBlock
            unit={{ type: "block", id: unit.sourceId, block: unit.block }}
            columnGapMm={columnGapMm}
            mathFractionSizing={mathFractionSizing}
          />
        </div>
      </div>
    );
  }

  const { block } = unit;
  if (block.type === "section") {
    return <PrintSection block={block} />;
  }

  if (block.type === "heading" || block.type === "paragraph" || block.type === "list"
    || block.type === "divider" || block.type === "quote" || block.type === "codeBlock") {
    return <PrintableRichBlock block={block} mathFractionSizing={mathFractionSizing} />;
  }

  if (block.type === "boxBlock") {
    return <PrintBoxBlock block={block} columnGapMm={columnGapMm} mathFractionSizing={mathFractionSizing} />;
  }

  if (block.type === "layoutSection") {
    const columns = getLayoutSectionColumns(migrateLegacyLayoutColumns(block));
    const layoutColumnGapMm = block.layout.columnGapMm ?? columnGapMm;
    const presentation = createIndependentColumnLayout(getLayoutSectionColumnWidths(block, columns.length), `${layoutColumnGapMm}mm`);
    return (
      <section
        data-sigma-doc-id={block.id}
        className="print-layout-section print-independent-columns"
        style={{
          ...createColumnRuleStyle(block.layout.columnRule),
          position: "relative",
          display: "grid",
          gridTemplateColumns: presentation.gridTemplateColumns,
          columnGap: presentation.columnGap,
        } as CSSProperties}
      >
        <ColumnRuleLines rule={block.layout.columnRule} dividers={presentation.dividers} />
        {columns.map((column, index) => (
          <div key={column[0]?.id ?? index} className="print-layout-section-column" style={{ minWidth: 0 }}>
            {column.map(child => <PrintBlock
              key={child.id}
              unit={{ type: "block", id: child.id, block: child, pagination: child.pagination }}
              columnGapMm={layoutColumnGapMm}
              mathFractionSizing={mathFractionSizing}
            />)}
          </div>
        ))}
      </section>
    );
  }
}

function PrintSection({ block }: { block: Extract<SigmaBlock, { type: "section" }> }) {
  const headingNumber = useHeadingNumber(block.id);
  return (
    <h1
      data-sigma-doc-id={block.id}
      className="print-section"
      style={{
        textAlign: block.align ?? "left",
        lineHeight: block.lineHeight,
        ...blockSpaceAfterStyleVars(block),
      } as CSSProperties}
    >
      {headingNumber ? <span className="heading-number-prefix">{headingNumber} </span> : null}
      {block.title}
    </h1>
  );
}

export function PrintLayoutSectionFragment({
  unit,
  mathFractionSizing,
}: {
  unit: Extract<PrintContentUnit, { type: "layoutSectionFragment" }>;
  mathFractionSizing?: SigmaDocument["metadata"]["mathFractionSizing"];
}) {
  const columnCount = unit.columns.length;
  const presentation = createIndependentColumnLayout(getLayoutSectionColumnWidths(unit.block, columnCount), `${unit.columnGapMm}mm`);
  const style = {
    ...createColumnRuleStyle(unit.block.layout.columnRule),
    position: "relative",
    "--print-layout-section-column-count": String(columnCount),
    "--print-layout-section-column-gap": `${unit.columnGapMm}mm`,
    display: "grid",
    gridTemplateColumns: presentation.gridTemplateColumns,
    columnGap: presentation.columnGap,
  } as CSSProperties;

  return (
    <section
      data-sigma-doc-id={unit.fragmentRole === "single" || unit.fragmentRole === "first" ? unit.sourceId : undefined}
      data-layout-section-source-id={unit.sourceId}
      data-layout-section-fragment={unit.fragmentRole}
      className={`print-layout-section print-layout-section-fragment print-layout-section-fragment-${unit.fragmentRole}`}
      style={style}
    >
      <ColumnRuleLines rule={unit.block.layout.columnRule} dividers={presentation.dividers} />
      {unit.columns.map((column) => (
        <div key={`${unit.id}-${column.id}`} className="print-layout-section-column" style={{ minWidth: 0 }}>
          {column.blocks.filter((child) => !isFullSpanPrintUnit(child)).map((child, index) => (
            <PrintBlock
              key={`${child.id}-${index}`}
              unit={child}
              columnGapMm={unit.columnGapMm}
              mathFractionSizing={mathFractionSizing}
            />
          ))}
        </div>
      ))}
    </section>
  );
}

export function PrintBoxBlock({
  block,
  columnGapMm,
  mathFractionSizing,
  fragmentBlocks,
  fragmentRole,
  includeTitle = true,
  cornerReferenceHeightPx,
}: {
  block: Extract<SigmaBlock, { type: "boxBlock" }>;
  columnGapMm: number;
  mathFractionSizing?: SigmaDocument["metadata"]["mathFractionSizing"];
  fragmentBlocks?: BoxBlockChildBlock[];
  fragmentRole?: Extract<PrintContentUnit, { type: "boxFragment" }>["fragmentRole"];
  includeTitle?: boolean;
  cornerReferenceHeightPx?: number;
}) {
  const frame = resolveBoxFrame(block);
  const hasTitle = boxBlockTitleText(block).length > 0;
  const blocks = fragmentBlocks ?? block.blocks;
  const fragmentClass = fragmentRole ? ` print-box-fragment print-box-fragment-${fragmentRole}` : "";
  const style = {
    ...boxFrameStyleVars(frame),
    ...cornerBoxReferenceHeightStyleVars(cornerReferenceHeightPx),
  } as CSSProperties;
  return (
    <section
      data-sigma-doc-id={!fragmentRole || fragmentRole === "single" || fragmentRole === "first" ? block.id : undefined}
      data-box-source-id={fragmentRole ? block.id : undefined}
      data-box-fragment={fragmentRole}
      data-corner-reference-height={cornerReferenceHeightPx ? "explicit" : undefined}
      className={`${boxFrameClassName("print-box-block", frame, block.styleId)}${fragmentClass}`}
      data-box-style={block.styleId}
      {...boxFrameDecorationAttributes(frame)}
      style={style}
    >
      <span className="print-box-corner top-left" aria-hidden="true" />
      <span className="print-box-corner top-right" aria-hidden="true" />
      <span className="print-box-corner bottom-left" aria-hidden="true" />
      <span className="print-box-corner bottom-right" aria-hidden="true" />
      {includeTitle && hasTitle && (
        <div className="print-box-title">
          {renderInlineContent(block.title ?? [], { keyPrefix: `${block.id}-title`, mathFractionSizing })}
        </div>
      )}
      <div className="print-box-body">
        {blocks.map((child) => (
          <PrintBoxBlockChild
            key={child.id}
            block={child}
            columnGapMm={columnGapMm}
            mathFractionSizing={mathFractionSizing}
          />
        ))}
      </div>
    </section>
  );
}

export function PrintBoxBlockChild({
  block,
  columnGapMm,
  mathFractionSizing,
}: {
  block: BoxBlockChildBlock;
  columnGapMm: number;
  mathFractionSizing?: SigmaDocument["metadata"]["mathFractionSizing"];
}) {
  if (block.type === "problem") {
    return <PrintNestedProblem block={block} columnGapMm={columnGapMm} mathFractionSizing={mathFractionSizing} />;
  }
  if (block.type === "layoutSection" || block.type === "section" || block.type === "boxBlock") {
    return (
      <PrintBlock
        unit={{ type: "block", id: block.id, block, pagination: block.pagination }}
        columnGapMm={columnGapMm}
        mathFractionSizing={mathFractionSizing}
      />
    );
  }
  return <PrintableRichBlock block={block} mathFractionSizing={mathFractionSizing} />;
}

function PrintNestedProblem({ block, columnGapMm, mathFractionSizing }: {
  block: Extract<SigmaBlock, { type: "problem" }>;
  columnGapMm: number;
  mathFractionSizing?: SigmaDocument["metadata"]["mathFractionSizing"];
}) {
  const numbers = useProblemNumbers();
  return <>{buildProblemAreaPrintUnits(block, numbers.get(block.id)).map(unit => (
    <PrintBlock key={unit.id} unit={unit} columnGapMm={columnGapMm} mathFractionSizing={mathFractionSizing} />
  ))}</>;
}

export function PrintProblemArea({
  problemId,
  area,
  blocks,
  minHeightMm,
  problemNumber,
  numberFontSize,
  hasFrame,
  frameStyleId,
  isFirstProblemArea,
  isFirstProblemFrameArea,
  isLastProblemFrameArea,
  columnGapMm,
  mathFractionSizing,
  fragmentRole,
  sourceId,
  layoutSectionFragment,
  blockSlice,
}: {
  problemId: string;
  area: ProblemAreaKind;
  blocks: ProblemAreaBlock[];
  layoutSectionFragment?: Extract<PrintContentUnit, { type: "layoutSectionFragment" }>;
  blockSlice?: Extract<PrintContentUnit, { type: "blockSlice" }>;
  minHeightMm?: number;
  problemNumber?: number;
  numberFontSize: number;
  hasFrame: boolean;
  frameStyleId?: string;
  isFirstProblemArea: boolean;
  isFirstProblemFrameArea: boolean;
  isLastProblemFrameArea: boolean;
  columnGapMm: number;
  mathFractionSizing?: SigmaDocument["metadata"]["mathFractionSizing"];
  fragmentRole?: Extract<PrintContentUnit, { type: "problemAreaFragment" }>["fragmentRole"];
  sourceId?: string;
}) {
  const isFirstFragment = !fragmentRole || fragmentRole === "single" || fragmentRole === "first";
  const showNumber = area === "lead" && typeof problemNumber === "number" && isFirstFragment;
  if (blocks.length === 0 && !layoutSectionFragment && !blockSlice && !minHeightMm && !showNumber) return null;

  const showEmptyLeadPlaceholder = showNumber && blocks.length === 0;
  const frameClasses = hasFrame ? problemFrameClassName("print-problem-area with-frame", frameStyleId) : "print-problem-area";
  const fragmentClasses = fragmentRole ? ` print-problem-area-fragment print-problem-area-fragment-${fragmentRole}` : "";
  const reservationClass = blocks.length === 0 && !layoutSectionFragment && minHeightMm
    ? " print-problem-area-reservation-only"
    : "";

  return (
    <section
      className={`${frameClasses}${fragmentClasses}${reservationClass} ${hasFrame && isFirstProblemFrameArea ? "first-frame-area" : ""} ${hasFrame && isLastProblemFrameArea ? "last-frame-area" : ""}`}
      data-sigma-doc-id={isFirstProblemArea && isFirstFragment ? problemId : undefined}
      data-problem-area={area}
      data-problem-area-fragment={fragmentRole}
      data-problem-source-id={sourceId}
      data-problem-frame-style={hasFrame ? frameStyleId : undefined}
      style={minHeightMm ? { minHeight: `${minHeightMm}mm` } : undefined}
    >
      <div className={`print-problem-area-content ${showNumber ? "with-number" : ""}`}>
        {showNumber && <span className="print-problem-number" style={{ fontSize: `${numberFontSize}pt` }}>{formatProblemNumber(problemNumber)}</span>}
        <div className={`print-problem-area-body ${showEmptyLeadPlaceholder ? "empty-lead-placeholder" : ""}`}>
          {showEmptyLeadPlaceholder ? (
            <div className="print-empty-lead-shell" aria-hidden="true" />
          ) : (
            blockSlice ? (
              <PrintBlock
                unit={blockSlice}
                columnGapMm={columnGapMm}
                mathFractionSizing={mathFractionSizing}
              />
            ) : layoutSectionFragment ? (
              <PrintLayoutSectionFragment
                unit={layoutSectionFragment}
                mathFractionSizing={mathFractionSizing}
              />
            ) : blocks.map((child) => child.type === "layoutSection" || child.type === "boxBlock" ? (
              <PrintBlock
                key={child.id}
                unit={{ type: "block", id: child.id, block: child, pagination: child.pagination }}
                columnGapMm={columnGapMm}
                mathFractionSizing={mathFractionSizing}
              />
            ) : (
              <PrintableRichBlock key={child.id} block={child} mathFractionSizing={mathFractionSizing} />
            ))
          )}
        </div>
      </div>
    </section>
  );
}

export function getPrintLayoutSectionColumnCount(columnCount: number): number {
  return Number.isInteger(columnCount) ? Math.min(4, Math.max(1, columnCount)) : 2;
}

function isFullSpanPrintUnit(unit: PrintContentUnit): boolean {
  return (unit.type === "problemArea" || unit.type === "problemAreaFragment") && unit.columnSpan === "full";
}
