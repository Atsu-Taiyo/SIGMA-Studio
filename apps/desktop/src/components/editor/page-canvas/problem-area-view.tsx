"use client";
import { type TextRunScopeContainer } from "@/components/editor/text-flow/text-run-span";
import {
  type TextFlowBoxFragmentSourceLayout,
  type TextFlowChangeContext,
  type TextFlowMaterialInsertRequest,
} from "@/components/editor/TextFlowEditor";
import type { TextFlowChangeDecorationState } from "@/components/tiptap/change-decoration";
import {
  type ProblemAreaKind,
  type ProblemCustomFrame,
  type ProblemNode,
  type SigmaCommentThread,
} from "@/features/document";
import { getSafeProblemAreaMinHeightPx,type FlowDisplacement } from "@/features/rendering/core";
import {
  getNestedPageBreakBeforeIds,
  getNestedPageBreakBeforeKinds,
  getPageBreakBeforeIds,
  getProblemNumberFontSize,
  type ManualTextPageBreakSelection,
  type TextFlowBlock,
} from "@/features/text-editing";
import { getCommentThreadsForBlock } from "@/lib/comments";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import {
  getProblemCustomFrame,
  getProblemCustomFrameStyle,
  getProblemFrameChromePaddingPx,
  getProblemFrameStyleId,
  problemFrameClassName,
} from "@/lib/problem-frame";
import { formatProblemNumber } from "@/lib/problem-numbering";
import type { MaterialItem } from "@/types/material";
import { MoreHorizontal } from "lucide-react";
import type { CSSProperties,PointerEvent as ReactPointerEvent } from "react";
import { useCallback,useMemo } from "react";
import { resolvePageBreakMarkerKind } from "./block-context-menu";
import { hasBreakBefore,isProblemFrameArea } from "./block-ops";
import type { PageCanvasInlineContent } from "./editor-extension";
import { getFlowDisplacementProps,getVisualEndStyle } from "./flow-presentation";
import { FLOW_BREAK_BEFORE_ATTRIBUTE,FLOW_SPAN_ATTRIBUTE } from "./flow-probe";
import { BlockCommentBackground } from "./overlay-preview";
import { PageBreakMarker } from "./page-chrome";
import { isFullSpanUnit,pickTextFlowBoxFragmentSourceLayouts,type RenderUnitManualBreakEdges } from "./render-units";
import { InlineContentStack,precedingBlockDisplacement,TextFlowWithInlineContent } from "./text-flow-view";
import { type TextRunGroupAssignment } from "./text-run-groups";
import type { ProblemAreaFrameFragmentLayout,RenderUnit } from "./types";

export function ProblemAreaFlowUnit({
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
  boxFragmentSourceLayouts,
  frameFragments,
  layoutStyle,
  spaceAfterFollowerClass,
  draftMinHeightMm,
  pageContentHeightPx,
  onSelect,
  onChange,
  onRemoveBreak,
  onResizeStart,
  onActionMenuOpen,
  inlineContentByTargetId,
  afterInlineContent,
  commentThreads,
  activeCommentThreadId,
  highlightedCommentThreadId,
  onCommentThreadSelect,
  materials,
  onMaterialInsert,
  changeDecorationState,
}: {
  unit: Extract<RenderUnit, { type: "problemArea" }>;
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
  /** 予約空白が分かれたとき、その末尾 (ユニット上端からの相対 y)。 */
  visualEnd: number | undefined;
  sideNoteLabelY: number | undefined;
  boxFragmentSourceLayouts: Record<string, TextFlowBoxFragmentSourceLayout>;
  frameFragments: ProblemAreaFrameFragmentLayout[] | undefined;
  layoutStyle: CSSProperties | undefined;
  /** 下端つまみのドラッグ中、このユニットを殻ごと平行移動させる印 (該当しなければ空文字)。 */
  spaceAfterFollowerClass: string;
  draftMinHeightMm: number | undefined;
  pageContentHeightPx: number;
  onSelect: (blockId: string | null) => void;
  onChange: (
    problemId: string,
    area: ProblemAreaKind,
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    activeBlockId?: string | null,
    context?: TextFlowChangeContext,
  ) => void;
  onRemoveBreak?: (blockId: string) => void;
  onResizeStart: (
    problem: ProblemNode,
    area: ProblemAreaKind,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  onActionMenuOpen: (problemId: string, area: ProblemAreaKind, anchor: HTMLElement) => void;
  inlineContentByTargetId: ReadonlyMap<string, readonly PageCanvasInlineContent[]>;
  afterInlineContent: readonly PageCanvasInlineContent[];
  commentThreads: SigmaCommentThread[];
  activeCommentThreadId: string | null;
  highlightedCommentThreadId: string | null;
  onCommentThreadSelect?: (threadId: string) => void;
  materials: MaterialItem[];
  onMaterialInsert?: (request: TextFlowMaterialInsertRequest) => void;
  changeDecorationState?: TextFlowChangeDecorationState;
}) {
  const tEditor = useT("editor");
  const { problem, area } = unit;
  const selected = selectedId === problem.id || unit.blocks.some((block) => block.id === selectedId);
  const minHeightPx = getSafeProblemAreaMinHeightPx(
    draftMinHeightMm ?? problem.areaLayout?.[area]?.minHeightMm ?? 0,
    pageContentHeightPx,
  );
  const displacementProps = getFlowDisplacementProps(displacement);
  const hasFrame = problem.frame?.enabled === true && isProblemFrameArea(area);
  const frameStyleId = hasFrame ? getProblemFrameStyleId(problem) : undefined;
  const frameCustom = hasFrame ? getProblemCustomFrame(problem) : undefined;
  const frameCustomStyle = frameCustom ? getProblemCustomFrameStyle(frameCustom, "px") : undefined;
  const style = {
    ...layoutStyle,
    ...displacementProps.style,
    ...getVisualEndStyle(visualEnd, sideNoteLabelY),
    ...frameCustomStyle,
    minHeight: minHeightPx > 0 ? `${minHeightPx}px` : undefined,
  } as CSSProperties;
  const problemNumber = unit.problemNumber;
  const isFirstArea = unit.isFirstProblemArea;
  const showNumber = area === "lead" && typeof problemNumber === "number";
  const problemNumberStyle = showNumber ? { fontSize: `${getProblemNumberFontSize(problem)}pt` } : undefined;
  const frameClasses = hasFrame ? problemFrameClassName("with-frame", frameStyleId) : "";
  // A manual break can split a framed area into several page/column segments (see
  // isProblemAreaColumnBlockFlowEligible). When that happens, the border can no
  // longer be a single CSS box around the whole (now multi-segment) section — it
  // is drawn instead as one open-ended overlay piece per segment, reusing the
  // exact same with-frame/first-frame-area/last-frame-area CSS that already draws
  // a frame spanning multiple problem areas today.
  const splitFrameFragments = hasFrame && frameFragments && frameFragments.length > 1
    ? frameFragments
    : undefined;
  const breakBeforeArea = isFirstArea && hasBreakBefore(problem);
  const outerFirstFrameClass = hasFrame && unit.isFirstProblemFrameArea ? "first-frame-area" : "";
  const outerLastFrameClass = hasFrame && unit.isLastProblemFrameArea ? "last-frame-area" : "";
  const outerFrameClasses = splitFrameFragments ? `${frameClasses} frame-split` : frameClasses;
  // memo 済みの本文エディタへ渡るので、エリアごとのハンドラは identity を固定する。
  const handleAreaChange = useCallback((
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    activeBlockId?: string | null,
    context?: TextFlowChangeContext,
  ) => {
    onChange(problem.id, area, previousIds, nextBlocks, activeBlockId, context);
  }, [area, onChange, problem.id]);
  // 問題エリアのユニットはそのエリアの中身しか doc に持たない。跨ぎコピーが問題ごと運ぶ
  // には、どの問題のどのエリアの中身かをここから渡すしかない。
  const scopeContainer = useMemo<TextRunScopeContainer>(
    () => [{ kind: "problemArea" as const, id: problem.id, area, template: problem }],
    [area, problem],
  );

  return (
    <section
      id={isFirstArea ? problem.id : undefined}
      data-page-block={isFirstArea ? "" : undefined}
      data-problem-area={area}
      data-problem-id={problem.id}
      data-flow-unit-id={unit.id}
      {...displacementProps.attributes}
      {...{ [FLOW_BREAK_BEFORE_ATTRIBUTE]: breakBeforeArea ? "true" : undefined }}
      {...{ [FLOW_SPAN_ATTRIBUTE]: isColumnPage && isFullSpanUnit(unit) ? "full" : undefined }}
      data-problem-frame-style={frameStyleId}
      className={`problem-area-flow-unit ${selected ? "selected" : ""} ${outerFrameClasses} ${outerFirstFrameClass} ${outerLastFrameClass} ${spaceAfterFollowerClass}`}
      style={style}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(problem.id);
      }}
    >
      {splitFrameFragments && (
        <ProblemAreaFrameFragmentPieces
          fragments={splitFrameFragments}
          frameClasses={frameClasses}
          frameStyleId={frameStyleId}
          frameCustom={frameCustom}
          isFirstProblemFrameArea={unit.isFirstProblemFrameArea}
          isLastProblemFrameArea={unit.isLastProblemFrameArea}
        />
      )}
      {isFirstArea && (
        <BlockCommentBackground
          threads={getCommentThreadsForBlock(commentThreads, problem.id)}
          activeThreadId={highlightedCommentThreadId}
        />
      )}
      <button
        type="button"
        className="problem-action-button"
        aria-label={tEditor("pageCanvas.problemActions")}
        title={tEditor("pageCanvas.problemActions")}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onActionMenuOpen(problem.id, area, event.currentTarget);
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {area !== "lead" && (
        <div className="problem-area-side-note">
          <span>{problemAreaSideLabel(area, unit.problemNumber, tEditor)}</span>
        </div>
      )}
      {isFirstArea && hasBreakBefore(problem) && (
        <PageBreakMarker blockId={problem.id} onRemove={onRemoveBreak} displacement={markerDisplacements?.[unit.id]} />
      )}
      <div className={`problem-area-paper-content ${showNumber ? "with-number" : ""}`}>
        {showNumber && (
          <span className="problem-number-marker" aria-label={tEditor("pageCanvas.problemNumber", { replace: { number: problemNumber } })} style={problemNumberStyle}>
            {formatProblemNumber(problemNumber)}
          </span>
        )}
        <div
          className="problem-area-paper-body"
        >
          <TextFlowWithInlineContent
            blocks={unit.blocks}
            selectedId={selectedId}
            mathFractionSizing={mathFractionSizing}
            historyRevision={historyRevision}
            nodeDisplacements={nodeDisplacements}
            markerDisplacements={markerDisplacements}
            paginationBeforeIds={[
                      ...getPageBreakBeforeIds(unit.blocks),
                      ...getNestedPageBreakBeforeIds(unit.blocks),
                    ]}
            paginationMarkerKind={resolvePageBreakMarkerKind(isColumnPage)}
            paginationMarkerKinds={getNestedPageBreakBeforeKinds(unit.blocks, resolvePageBreakMarkerKind(isColumnPage))}
            leadingManualBreak={!!manualBreakEdges?.leading}
            trailingManualBreak={!!manualBreakEdges?.trailing}
            onManualBreakCommand={onManualBreakCommand}
            boxFragmentSourceLayouts={pickTextFlowBoxFragmentSourceLayouts(unit.blocks, boxFragmentSourceLayouts)}
            commentThreads={commentThreads}
            activeCommentThreadId={activeCommentThreadId}
            highlightedCommentThreadId={highlightedCommentThreadId}
            placeholder={area === "lead" ? "" : tEditor("body.inputPlaceholder")}
            showPlaceholder
            onSelect={onSelect}
            onCommentThreadSelect={onCommentThreadSelect}
            materials={materials}
            onMaterialInsert={onMaterialInsert}
            enableSelectionFormatMenu={false}
            enableBoxCommands
            onChange={handleAreaChange}
            inlineContentByTargetId={inlineContentByTargetId}
            changeDecorationState={changeDecorationState}
            textRunGroupId={textRunAssignment?.groupId}
            textRunOrder={textRunAssignment?.order}
            textRunUnitId={unit.id}
            textRunScopeId={`problem:${problem.id}:${area}`}
            textRunScopeContainer={scopeContainer}
            textRunPreserveEmpty
          />
        </div>
      </div>
      {afterInlineContent.length > 0 && (
        <InlineContentStack
          items={afterInlineContent}
          displacement={precedingBlockDisplacement([{ type: "blocks", blocks: unit.blocks }], 1, nodeDisplacements)}
        />
      )}
      {area !== "lead" && (
        <button
          type="button"
          className="problem-area-resize-handle"
          aria-label={tEditor("pageCanvas.areaHeight")}
          title={tEditor("pageCanvas.areaHeight")}
          onPointerDown={(event) => onResizeStart(problem, area, event)}
          onClick={(event) => event.stopPropagation()}
        />
      )}
    </section>
  );
}

/**
 * Decorative frame-border pieces for a framed problem area split by a manual
 * break: one open-ended piece per page/column segment the area's blocks landed
 * in. The real content is placed at bare (unpadded) coordinates by the
 * block-flow path (see `column-block-flowed` in globals.css), so these pieces
 * carry the usual with-frame padding themselves — outset from the tight content
 * rect they are given — to reproduce the same visual inset the CSS box model
 * gives the non-split case.
 */
export function ProblemAreaFrameFragmentPieces({
  fragments,
  frameClasses,
  frameStyleId,
  frameCustom,
  isFirstProblemFrameArea,
  isLastProblemFrameArea,
}: {
  fragments: ProblemAreaFrameFragmentLayout[];
  frameClasses: string;
  frameStyleId: string | undefined;
  frameCustom: ProblemCustomFrame | undefined;
  isFirstProblemFrameArea: boolean;
  isLastProblemFrameArea: boolean;
}) {
  const chromePadding = getProblemFrameChromePaddingPx(frameStyleId, frameCustom);
  const frameCustomStyle = frameCustom ? getProblemCustomFrameStyle(frameCustom, "px") as CSSProperties : undefined;
  return (
    <>
      {fragments.map((fragment, index) => {
        if (fragment.openTop !== undefined || fragment.openBottom !== undefined) {
          // 配置エンジンの枠片: 矩形は枠線込みの確定値。切れ目の辺だけ開く。
          return (
            <div
              key={`frame-piece-${index}`}
              aria-hidden="true"
              className={`problem-area-flow-unit ${frameClasses} ${fragment.openTop ? "" : "first-frame-area"} ${fragment.openBottom ? "" : "last-frame-area"}`}
              style={{
                position: "absolute",
                left: `${fragment.x}px`,
                top: `${fragment.y}px`,
                width: `${fragment.width}px`,
                height: `${fragment.height}px`,
                margin: 0,
                padding: 0,
                boxSizing: "border-box",
                pointerEvents: "none",
                ...frameCustomStyle,
              }}
            />
          );
        }
        const isFirstPiece = index === 0 && isFirstProblemFrameArea;
        const isLastPiece = index === fragments.length - 1 && isLastProblemFrameArea;
        // Mirrors the CSS: only the top edge is ever removed for a continuation
        // piece (`:not(.first-frame-area) { padding-top: 0 }`) — the bottom
        // padding is always kept, giving each piece breathing room before its
        // open (or closed) bottom edge.
        const topOutset = isFirstPiece ? chromePadding.y : 0;
        const bottomOutset = chromePadding.y;
        return (
          <div
            key={`frame-piece-${index}`}
            aria-hidden="true"
            className={`problem-area-flow-unit ${frameClasses} ${isFirstPiece ? "first-frame-area" : ""} ${isLastPiece ? "last-frame-area" : ""}`}
            style={{
              position: "absolute",
              left: `${fragment.x - chromePadding.x}px`,
              top: `${fragment.y - topOutset}px`,
              width: `${fragment.width + chromePadding.x * 2}px`,
              height: `${fragment.height + topOutset + bottomOutset}px`,
              margin: 0,
              pointerEvents: "none",
              ...frameCustomStyle,
            }}
          />
        );
      })}
    </>
  );
}

/** 区分の呼び名は `editor.block.problem*` が唯一の出典。ここはそれを引くだけ。 */
export function problemAreaLabel(area: ProblemAreaKind, t: Translate<"editor">): string {
  if (area === "lead") {
    return t("block.problemLead");
  }

  if (area === "hints") {
    return t("block.problemHints");
  }

  if (area === "solution") {
    return t("block.problemSolution");
  }

  return t("block.problemPrompt");
}

export function problemAreaSideLabel(
  area: ProblemAreaKind,
  problemNumber: number | undefined,
  t: Translate<"editor">,
): string {
  if (area === "prompt" && typeof problemNumber === "number") {
    return t("pageCanvas.areaPrompt", { replace: { number: problemNumber } });
  }

  return problemAreaLabel(area, t);
}
