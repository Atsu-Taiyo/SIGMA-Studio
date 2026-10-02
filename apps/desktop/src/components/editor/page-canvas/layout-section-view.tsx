"use client";
import {
  startLocalColumnPointerSelection,
  type TextRunScopeContainer,
} from "@/components/editor/text-flow/text-run-span";
import {
  type TextFlowBoxFragmentSourceLayout,
  type TextFlowChangeContext,
  type TextFlowHeadingCommandRequest,
  type TextFlowMaterialInsertRequest,
} from "@/components/editor/TextFlowEditor";
import type { TextFlowChangeDecorationState } from "@/components/tiptap/change-decoration";
import { type ProblemAreaBlock,type SigmaBlock,type SigmaCommentThread } from "@/features/document";
import { createColumnRuleStyle } from "@/features/rendering/adapters";
import { ColumnRuleLines } from "@/features/rendering/adapters/react";
import {
  createIndependentColumnLayout,
  getSafeProblemAreaMinHeightPx,
  type FlowColumnRulePiece,
  type FlowDisplacement,
} from "@/features/rendering/core";
import {
  getLayoutSectionColumns,
  getLayoutSectionColumnWidths,
  getNestedPageBreakBeforeIds,
  getNestedPageBreakBeforeKinds,
  setLayoutSectionColumns,
  type ManualTextPageBreakSelection,
  type TextFlowBlock,
} from "@/features/text-editing";
import { useT } from "@/lib/i18n/react";
import type { MaterialItem } from "@/types/material";
import type { CSSProperties } from "react";
import { Fragment,useCallback,useEffect,useLayoutEffect,useMemo,useRef } from "react";
import { attachLayoutColumnResizeHandle } from "../layout-column-resize";
import { resolvePageBreakMarkerKind } from "./block-context-menu";
import { hasBreakBefore } from "./block-ops";
import type { PageCanvasInlineContent } from "./editor-extension";
import { getFlowDisplacementProps,getVisualEndStyle } from "./flow-presentation";
import { FLOW_BREAK_BEFORE_ATTRIBUTE,FLOW_SPAN_ATTRIBUTE } from "./flow-probe";
import { PageBreakMarker } from "./page-chrome";
import { problemAreaSideLabel } from "./problem-area-view";
import {
  getLayoutSectionColumnCount,
  getLayoutSectionColumnGapPx,
  getSingleColumnProblemLayoutSectionMinHeightMm,
  isFullSpanUnit,
  pickTextFlowBoxFragmentSourceLayouts,
  type RenderUnitManualBreakEdges,
} from "./render-units";
import { TextFlowWithInlineContent } from "./text-flow-view";
import { type TextRunGroupAssignment } from "./text-run-groups";
import type { ProblemAreaColumnLayout,RenderUnit } from "./types";

export function LayoutColumnResizeHandle({
  sectionId,
  dividerIndex,
  left,
  gap,
  label,
  hint,
  mergeLabel,
  piece,
  onCommit,
}: {
  sectionId: string;
  piece?: FlowColumnRulePiece;
  dividerIndex: number;
  left: string;
  /** 段間の幅 (CSS 長さ)。当たり判定は段間の全幅。 */
  gap: string;
  label: string;
  hint: string;
  mergeLabel: string;
  onCommit: (leftWidth: number, rightWidth: number) => void;
}) {
  const handleRef = useRef<HTMLButtonElement | null>(null);
  // ドラッグ・キーボードはイベント時に最新の値を読む (描画ごとに作り直されるコールバックを渡す)。
  const bindingRef = useRef({ dividerIndex, labels: { merge: mergeLabel }, onCommit });
  useLayoutEffect(() => {
    bindingRef.current = { dividerIndex, labels: { merge: mergeLabel }, onCommit };
  });
  useEffect(() => {
    const handle = handleRef.current;
    return handle ? attachLayoutColumnResizeHandle(handle, () => bindingRef.current) : undefined;
  }, []);
  return (
    <button
      ref={handleRef}
      type="button"
      className="layout-section-column-resize-handle"
      data-layout-section-id={sectionId}
      data-divider-index={dividerIndex}
      style={{ left: piece ? `calc(${left} + ${piece.x}px)` : left, "--layout-column-divider-gap": gap,
        ...(piece ? { top: piece.y, height: piece.height, bottom: "auto", minHeight: 0 } : {}) } as CSSProperties}
      aria-label={label}
      title={hint}
    />
  );
}

export function LayoutSectionFlowUnit({
  unit,
  manualBreakEdges,
  onManualBreakCommand,
  textRunAssignment,
  selectedId,
  mathFractionSizing,
  historyRevision,
  isColumnPage,
  displacement,
  nodeDisplacements,
  markerDisplacements,
  visualEnd,
  sideNoteLabelY,
  columnLayout,
  columnRulePieces,
  boxFragmentSourceLayouts,
  layoutStyle,
  spaceAfterFollowerClass,
  pageColumnGapPx,
  pageColumnGapMm,
  pageContentHeightPx,
  onSelect,
  onChange,
  onLayoutChange,
  onResizeColumns,
  onRemoveBreak,
  commentThreads,
  activeCommentThreadId,
  highlightedCommentThreadId,
  onCommentThreadSelect,
  materials,
  onMaterialInsert,
  onHeadingCommand,
  inlineContentByTargetId,
  changeDecorationState,
}: {
  unit: Extract<RenderUnit, { type: "layoutSection" | "problemLayoutSection" }>;
  manualBreakEdges?: RenderUnitManualBreakEdges;
  onManualBreakCommand?: (selection: ManualTextPageBreakSelection) => boolean;
  textRunAssignment?: TextRunGroupAssignment;
  selectedId: string | null;
  mathFractionSizing: "uniform" | "texDefault";
  historyRevision: number;
  isColumnPage: boolean;
  displacement: FlowDisplacement | undefined;
  nodeDisplacements: Readonly<Record<string, FlowDisplacement>> | undefined;
  markerDisplacements: Readonly<Record<string, FlowDisplacement>> | undefined;
  visualEnd: number | undefined;
  sideNoteLabelY: number | undefined;
  columnLayout: ProblemAreaColumnLayout | undefined;
  columnRulePieces?: readonly FlowColumnRulePiece[];
  boxFragmentSourceLayouts: Record<string, TextFlowBoxFragmentSourceLayout>;
  layoutStyle: CSSProperties | undefined;
  /** 下端つまみのドラッグ中、このユニットを殻ごと平行移動させる印 (該当しなければ空文字)。 */
  spaceAfterFollowerClass: string;
  pageColumnGapPx: number;
  pageColumnGapMm: number;
  pageContentHeightPx: number;
  onSelect: (blockId: string | null) => void;
  onChange: (
    sectionId: string,
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    activeBlockId?: string | null,
    context?: TextFlowChangeContext,
  ) => void;
  onLayoutChange: (sectionId: string, updater: (block: SigmaBlock | ProblemAreaBlock) => SigmaBlock | ProblemAreaBlock) => void;
  onResizeColumns?: (sectionId: string, dividerIndex: number, leftWidth: number, rightWidth: number) => void;
  onRemoveBreak?: (blockId: string) => void;
  commentThreads: SigmaCommentThread[];
  activeCommentThreadId: string | null;
  highlightedCommentThreadId: string | null;
  onCommentThreadSelect?: (threadId: string) => void;
  materials: MaterialItem[];
  onMaterialInsert?: (request: TextFlowMaterialInsertRequest) => void;
  onHeadingCommand?: (request: TextFlowHeadingCommandRequest) => boolean;
  inlineContentByTargetId: ReadonlyMap<string, readonly PageCanvasInlineContent[]>;
  changeDecorationState?: TextFlowChangeDecorationState;
}) {
  const tEditor = useT("editor");
  const selected = selectedId === unit.section.id || unit.blocks.some((block) => block.id === selectedId);
  const isProblemAreaSection = unit.type === "problemLayoutSection";
  const problemAreaMinHeightMm = getSingleColumnProblemLayoutSectionMinHeightMm(unit, false);
  // memo 済みの本文エディタへ渡るので identity を固定する。跨ぎコピーが段組セクションを
  // 組み直すのに使う (このユニットの doc には段落しか入っていない)。
  const sectionId = unit.section.id;
  const sectionLayout = unit.section.layout;
  // 問題エリアの中の段組は、段組の外側に問題エリアがある (外側 → 内側の順)。
  const problemFrameSource = unit.type === "problemLayoutSection" ? unit : null;
  const problemFrameProblem = problemFrameSource?.problem;
  const problemFrameArea = problemFrameSource?.area;
  const scopeContainer = useMemo<TextRunScopeContainer>(
    () => [
      ...(problemFrameProblem && problemFrameArea
        ? [{
            kind: "problemArea" as const,
            id: problemFrameProblem.id,
            area: problemFrameArea,
            template: problemFrameProblem,
          }]
        : []),
      { kind: "layoutSection" as const, id: sectionId, layout: sectionLayout },
    ],
    [problemFrameArea, problemFrameProblem, sectionId, sectionLayout],
  );
  const columnCount = getLayoutSectionColumnCount(unit.section);
  const columnGapPx = getLayoutSectionColumnGapPx(unit.section, pageColumnGapMm, pageColumnGapPx);
  const columnFlowActive = columnCount > 1 && columnLayout != null;
  const problemAreaMinHeightPx = getSafeProblemAreaMinHeightPx(
    problemAreaMinHeightMm,
    pageContentHeightPx,
  );
  const displacementProps = getFlowDisplacementProps(displacement);
  const style = {
    ...layoutStyle,
    ...displacementProps.style,
    ...getVisualEndStyle(visualEnd, sideNoteLabelY),
    minHeight: problemAreaMinHeightPx > 0 ? `${problemAreaMinHeightPx}px` : undefined,
  } as CSSProperties;
  const columnStyle = columnFlowActive
    ? ({
        "--layout-section-column-flow-height": `${columnLayout!.totalHeightPx}px`,
        "--layout-section-column-gap": `${columnLayout!.columnGapPx}px`,
      } as CSSProperties)
    : undefined;
  const blockById = useMemo(() => new Map(unit.blocks.map((block) => [block.id, block] as const)), [unit.blocks]);
  const columnBlocks = useMemo(() => getLayoutSectionColumns(unit.section).map((column) => (
    column.flatMap((block) => {
      const editable = blockById.get(block.id);
      return editable ? [editable] : [];
    })
  )), [blockById, unit.section]);
  const columnWidths = useMemo(
    () => getLayoutSectionColumnWidths(unit.section, columnBlocks.length),
    [columnBlocks.length, unit.section],
  );
  const columnPresentation = createIndependentColumnLayout(columnWidths, `${columnGapPx}px`);
  const independentColumnStyle = {
    ...createColumnRuleStyle(unit.section.layout.columnRule),
    gridTemplateColumns: columnPresentation.gridTemplateColumns,
    columnGap: columnPresentation.columnGap,
  };

  // memo 済みの本文エディタへ渡るので、段組みごとのハンドラは identity を固定する。
  const handleSectionChange = useCallback((
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    activeBlockId?: string | null,
    context?: TextFlowChangeContext,
  ) => {
    onChange(unit.section.id, previousIds, nextBlocks, activeBlockId, context);
  }, [onChange, unit.section.id]);

  return (
    <section
      id={unit.section.id}
      data-page-block=""
      data-sigma-doc-id={unit.section.id}
      data-sigma-doc-type="layoutSection"
      data-layout-section-id={unit.section.id}
      data-problem-area={isProblemAreaSection ? unit.area : undefined}
      data-problem-id={isProblemAreaSection ? unit.problem.id : undefined}
      data-flow-unit-id={unit.id}
      {...displacementProps.attributes}
      {...{ [FLOW_BREAK_BEFORE_ATTRIBUTE]: hasBreakBefore(unit.section) ? "true" : undefined }}
      {...{ [FLOW_SPAN_ATTRIBUTE]: isColumnPage && isFullSpanUnit(unit) ? "full" : undefined }}
      className={`layout-section-flow-unit ${selected ? "selected" : ""} ${isProblemAreaSection ? "in-problem-area" : ""} ${spaceAfterFollowerClass}`}
      style={style}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(unit.section.id);
      }}
    >
      {isProblemAreaSection && unit.showAreaSideNote && (
        <div className="problem-area-side-note">
          <span>{problemAreaSideLabel(unit.area, unit.problemNumber, tEditor)}</span>
        </div>
      )}
      <div className="layout-section-side-note">
        <span>{tEditor("block.columns", { replace: { columns: columnCount } })}</span>
      </div>
      {hasBreakBefore(unit.section) && (
        <PageBreakMarker blockId={unit.section.id} onRemove={onRemoveBreak} displacement={markerDisplacements?.[unit.id]} />
      )}
      <div
        className="layout-section-paper-body with-independent-layout-columns"
        style={columnStyle}
      >
        <div className="layout-section-independent-columns" style={independentColumnStyle} onMouseDownCapture={startLocalColumnPointerSelection}>
          <ColumnRuleLines rule={unit.section.layout.columnRule} dividers={columnPresentation.dividers} pieces={columnRulePieces} />
          {columnBlocks.map((blocks, columnIndex) => (
            <Fragment key={unit.section.layout.columnStartIds?.[columnIndex] ?? blocks[0]?.id ?? columnIndex}>
              <div className="layout-section-independent-column" data-layout-column-index={columnIndex}>
                <TextFlowWithInlineContent
                  blocks={blocks}
                  headingNumbers={unit.headingNumbers}
                  selectedId={selectedId}
                  mathFractionSizing={mathFractionSizing}
                  historyRevision={historyRevision}
                  breakGaps={undefined}
                  nodeDisplacements={nodeDisplacements}
                  markerDisplacements={markerDisplacements}
                  paginationBeforeIds={getNestedPageBreakBeforeIds(blocks)}
                  paginationMarkerKind={resolvePageBreakMarkerKind(columnCount > 1 || isColumnPage)}
                  paginationMarkerKinds={getNestedPageBreakBeforeKinds(blocks, resolvePageBreakMarkerKind(columnCount > 1 || isColumnPage))}
                  paginationMarkerLayouts={undefined}
                  leadingManualBreak={columnIndex === 0 && !!manualBreakEdges?.leading}
                  trailingManualBreak={columnIndex === columnBlocks.length - 1 && !!manualBreakEdges?.trailing}
                  // 独立した複数段の中は段の所属を columnStartIds が決めるので区切りを入れない
                  // (候補にも出さない)。1 段組の段組みの中は本文と同じ。
                  onManualBreakCommand={columnCount > 1 ? undefined : onManualBreakCommand}
                  columnFlowBlockLayouts={columnFlowActive ? columnLayout!.blockLayouts : undefined}
                  boxFragmentSourceLayouts={pickTextFlowBoxFragmentSourceLayouts(blocks, boxFragmentSourceLayouts)}
                  commentThreads={commentThreads}
                  activeCommentThreadId={activeCommentThreadId}
                  highlightedCommentThreadId={highlightedCommentThreadId}
                  placeholder={tEditor("body.inputPlaceholder")}
                  showPlaceholder
                  onSelect={onSelect}
                  onCommentThreadSelect={onCommentThreadSelect}
                  onChange={handleSectionChange}
                  materials={materials}
                  onMaterialInsert={onMaterialInsert}
                  enableSelectionFormatMenu={false}
                  enableBoxCommands
                  enableHeadingCommands={!isProblemAreaSection}
                  onHeadingCommand={onHeadingCommand}
                  inlineContentByTargetId={inlineContentByTargetId}
                  changeDecorationState={changeDecorationState}
                  textRunGroupId={textRunAssignment?.groupId}
                  textRunOrder={textRunAssignment ? textRunAssignment.order + columnIndex / columnCount : undefined}
                  textRunUnitId={`${unit.id}:column:${columnIndex}`}
                  textRunScopeId={`layout:${unit.section.id}`}
                  textRunScopeContainer={scopeContainer}
                  textRunPreserveEmpty
                />
              </div>
              {columnIndex < columnBlocks.length - 1 && (columnRulePieces ?? [undefined]).map((piece, pieceIndex) => (
                <LayoutColumnResizeHandle
                  key={pieceIndex}
                  piece={piece}
                  sectionId={unit.section.id}
                  dividerIndex={columnIndex}
                  left={columnPresentation.dividers[columnIndex].left}
                  gap={columnPresentation.columnGap}
                  label={tEditor("pageCanvas.resizeColumns", {
                    replace: { left: columnIndex + 1, right: columnIndex + 2 },
                  })}
                  hint={tEditor("pageCanvas.resizeColumnsHint")}
                  mergeLabel={tEditor("pageCanvas.mergeColumns")}
                  onCommit={(leftWidth, rightWidth) => {
                    if (onResizeColumns) {
                      onResizeColumns(unit.section.id, columnIndex, leftWidth, rightWidth);
                      return;
                    }
                    onLayoutChange(unit.section.id, (block) => {
                      if (block.type !== "layoutSection") return block;
                      const columns = getLayoutSectionColumns(block);
                      const widths = getLayoutSectionColumnWidths(block, columns.length);
                      if (!columns[columnIndex] || !columns[columnIndex + 1]) return block;
                      if (leftWidth <= 0 || rightWidth <= 0) {
                        const merged = [...columns[columnIndex], ...columns[columnIndex + 1]];
                        const nextColumns = [...columns.slice(0, columnIndex), merged, ...columns.slice(columnIndex + 2)];
                        const nextWidths = [...widths.slice(0, columnIndex), widths[columnIndex] + widths[columnIndex + 1], ...widths.slice(columnIndex + 2)];
                        return setLayoutSectionColumns(block, nextColumns, nextWidths);
                      }
                      const pairTotal = widths[columnIndex] + widths[columnIndex + 1];
                      const pixelTotal = leftWidth + rightWidth;
                      const nextWidths = [...widths];
                      nextWidths[columnIndex] = Math.round(pairTotal * leftWidth / pixelTotal);
                      nextWidths[columnIndex + 1] = pairTotal - nextWidths[columnIndex];
                      return setLayoutSectionColumns(block, columns, nextWidths);
                    });
                  }}
                />
              ))}
            </Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}
