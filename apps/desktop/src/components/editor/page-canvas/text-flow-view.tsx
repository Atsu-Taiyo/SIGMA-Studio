"use client";
import { useEditorExtensions } from "@/components/editor/editor-extension-context";
import { subscribeCaretSurfaceMount } from "@/components/editor/text-flow/caret-router";
import { type TextRunScopeContainer } from "@/components/editor/text-flow/text-run-span";
import {
  TextFlowEditor,
  type TextFlowBodyBlockCommandRequest,
  type TextFlowBoundaryDeleteRequest,
  type TextFlowBoxFragmentSourceLayout,
  type TextFlowChangeContext,
  type TextFlowHeadingCommandRequest,
  type TextFlowMaterialInsertRequest,
  type TextFlowProblemCommandRequest,
} from "@/components/editor/TextFlowEditor";
import type { TextFlowChangeDecorationState } from "@/components/tiptap/change-decoration";
import { estimateBlockHeightPx,type SigmaCommentThread } from "@/features/document";
import { type FlowDisplacement,type TextFlowColumnBlockLayout } from "@/features/rendering/core";
import {
  bodyTextFlowBlockContainsId,
  getCommentThreadsSyncKey,
  getNestedPageBreakBeforeIds,
  getNestedPageBreakBeforeKinds,
  getTextFlowBreakGapSyncKey,
  getTextFlowColumnLayoutsSyncKey,
  getTextFlowFragmentLayoutsSyncKey,
  type ManualTextPageBreakSelection,
  type PageBreakMarkerKind,
  type TextFlowBlock,
  type TextFlowSelectionBookmark,
} from "@/features/text-editing";
import { cornerBoxReferenceHeightStyleVars } from "@/lib/box-blocks";
import type { MaterialItem } from "@/types/material";
import type { CSSProperties } from "react";
import { Fragment,useEffect,useMemo,useRef,useState } from "react";
import { hasBreakBefore } from "./block-ops";
import type { PageCanvasInlineContent } from "./editor-extension";
import { getNodeDisplacementsKey,pickUnitNodeDisplacements } from "./flow-presentation";
import { splitTextFlowBlocksByInlineContent } from "./inline-content-composition";
import {
  pickTextFlowBoxFragmentSourceLayouts,
  pickTextFlowColumnBlockLayouts,
  pickUnitBreakGaps,
  pickUnitCommentThreads,
} from "./render-units";
import type { EditorBoxBlockFragmentLayout } from "./types";

/**
 * 最上位ブロックの手動改ページを付け外す編集か。描いている文書の区切りの集合 (`breakBeforeIds`) と
 * 比べるので、打鍵ごとに文書全体を歩かない。
 */
export function changesTopLevelManualBreaks(currentBreakIds: ReadonlySet<string>, nextBlocks: readonly TextFlowBlock[]): boolean {
  return nextBlocks.some((block) => currentBreakIds.has(block.id) !== hasBreakBefore(block));
}

/** 前回に無かったトップレベルブロック id を含むか (= 段組みで配置がまだ無いブロックが生まれる編集か)。 */
export function hasNewTopLevelBlockIds(previousIds: readonly string[], nextBlocks: readonly TextFlowBlock[]): boolean {
  const known = new Set(previousIds);
  return nextBlocks.some((block) => !known.has(block.id));
}

/**
 * 大量 paste の未 hydrate unit。40 個前後のブロックを 1 つの概算矩形として扱うので、
 * 初回ページ割りが触る DOM は「全段落」ではなく「unit 数」に留まる。
 */
export function DeferredLargePasteTextFlowUnit({
  blocks,
  onVisible,
  unitId,
}: {
  blocks: TextFlowBlock[];
  onVisible: (unitId: string) => void;
  unitId: string;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const estimatedHeight = useMemo(
    () => blocks.reduce((height, block) => height + estimateBlockHeightPx(block), 0),
    [blocks],
  );

  useEffect(() => {
    const element = elementRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onVisible(unitId);
        observer.disconnect();
      }
    }, { rootMargin: "100% 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onVisible, unitId]);

  return (
    <div
      ref={elementRef}
      id={unitId}
      data-page-block={unitId}
      data-sigma-doc-id={unitId}
      data-large-paste-deferred="true"
      aria-hidden="true"
      style={{
        height: `${Math.max(1, estimatedHeight)}px`,
      }}
    />
  );
}

export function TextFlowWithInlineContent({
  blocks,
  selectedId,
  mathFractionSizing,
  placeholder,
  showPlaceholder = true,
  singleBlock = false,
  historyRevision,
  breakGaps,
  nodeDisplacements,
  markerDisplacements,
  paginationBeforeIds,
  paginationMarkerKind,
  paginationMarkerKinds,
  paginationMarkerLayouts,
  leadingManualBreak = false,
  trailingManualBreak = false,
  onManualBreakCommand,
  columnFlowBlockLayouts,
  boxFragmentSourceLayouts,
  headingNumbers = {},
  syncFocusedContent = false,
  commentThreads,
  activeCommentThreadId,
  highlightedCommentThreadId,
  onFocusChange,
  onSelect,
  onCommentThreadSelect,
  onChange,
  onBoundaryDelete,
  materials,
  onMaterialInsert,
  enableSelectionFormatMenu = true,
  enableBoxCommands = true,
  enableProblemCommands = false,
  onProblemCommand,
  onBodyBlockCommand,
  onHeadingCommand,
  enableHeadingCommands = false,
  inlineContentByTargetId,
  changeDecorationState,
  textRunGroupId,
  textRunOrder,
  textRunUnitId,
  textRunScopeId,
  textRunScopeContainer,
  textRunPreserveEmpty = false,
}: {
  blocks: TextFlowBlock[];
  selectedId: string | null;
  mathFractionSizing: "uniform" | "texDefault";
  placeholder?: string;
  showPlaceholder?: boolean;
  singleBlock?: boolean;
  historyRevision: number;
  breakGaps?: Record<string, number>;
  /** 本文フローのブロック変位 (ユニットからの相対)。ここで自分のブロックの分だけを選ぶ。 */
  nodeDisplacements?: Readonly<Record<string, FlowDisplacement>>;
  /** 手動改ページの印の変位 (ブロック id → ユニットからの相対)。 */
  markerDisplacements?: Readonly<Record<string, FlowDisplacement>>;
  paginationBeforeIds?: string[];
  paginationMarkerKind?: PageBreakMarkerKind;
  paginationMarkerKinds?: Record<string, PageBreakMarkerKind>;
  paginationMarkerLayouts?: Record<string, TextFlowColumnBlockLayout>;
  /** この面の前 / 後ろに、面の外のブロック (問題・段組み・隣のユニット) が持つ手動改ページがある。 */
  leadingManualBreak?: boolean;
  trailingManualBreak?: boolean;
  onManualBreakCommand?: (selection: ManualTextPageBreakSelection) => boolean;
  columnFlowBlockLayouts?: Record<string, TextFlowColumnBlockLayout>;
  boxFragmentSourceLayouts?: Record<string, TextFlowBoxFragmentSourceLayout>;
  headingNumbers?: Readonly<Record<string, string>>;
  syncFocusedContent?: boolean;
  commentThreads: SigmaCommentThread[];
  activeCommentThreadId: string | null;
  highlightedCommentThreadId: string | null;
  onFocusChange?: (
    focused: boolean,
    blockIds: string[],
    activeBlockId?: string | null,
    selection?: TextFlowSelectionBookmark | null,
  ) => void;
  onSelect: (blockId: string | null) => void;
  onCommentThreadSelect?: (threadId: string) => void;
  onChange: (
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    activeBlockId?: string | null,
    context?: TextFlowChangeContext,
  ) => void;
  onBoundaryDelete?: (request: TextFlowBoundaryDeleteRequest) => boolean;
  materials: MaterialItem[];
  onMaterialInsert?: (request: TextFlowMaterialInsertRequest) => void;
  enableSelectionFormatMenu?: boolean;
  enableBoxCommands?: boolean;
  enableProblemCommands?: boolean;
  onProblemCommand?: (request: TextFlowProblemCommandRequest) => boolean;
  onBodyBlockCommand?: (request: TextFlowBodyBlockCommandRequest) => boolean;
  onHeadingCommand?: (request: TextFlowHeadingCommandRequest) => boolean;
  enableHeadingCommands?: boolean;
  inlineContentByTargetId: ReadonlyMap<string, readonly PageCanvasInlineContent[]>;
  changeDecorationState?: TextFlowChangeDecorationState;
  textRunGroupId?: string;
  textRunOrder?: number;
  textRunUnitId?: string;
  textRunScopeId?: string;
  textRunScopeContainer?: TextRunScopeContainer;
  textRunPreserveEmpty?: boolean;
}) {
  const { textFlowEditPolicy } = useEditorExtensions();
  const parts = useMemo(
    () => splitTextFlowBlocksByInlineContent(blocks, inlineContentByTargetId),
    [blocks, inlineContentByTargetId],
  );
  // ここがユニット局所化の関門。下の TextFlowEditor は memo なので、**このユニットに関係する
  // 分だけ**を、値が変わらない限り同じ参照で渡す。ページ全体の gap やコメント一覧をそのまま
  // 渡すと、他のページが 1mm 動いただけで全ユニットが描き直される。
  const unitBreakGaps = pickUnitBreakGaps(blocks, breakGaps);
  const unitBreakGapsKey = getTextFlowBreakGapSyncKey(unitBreakGaps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableBreakGaps = useMemo(() => unitBreakGaps, [unitBreakGapsKey]);
  const unitCommentThreads = pickUnitCommentThreads(blocks, commentThreads);
  const unitCommentThreadsKey = getCommentThreadsSyncKey(unitCommentThreads);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableCommentThreads = useMemo(() => unitCommentThreads, [unitCommentThreadsKey]);
  const paginationBeforeIdsKey = paginationBeforeIds === undefined ? null : paginationBeforeIds.join("\u0000");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stablePaginationBeforeIds = useMemo(() => paginationBeforeIds, [paginationBeforeIdsKey]);
  const paginationMarkerKindsKey = JSON.stringify(paginationMarkerKinds ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stablePaginationMarkerKinds = useMemo(() => paginationMarkerKinds, [paginationMarkerKindsKey]);
  const paginationMarkerLayoutsKey = getTextFlowColumnLayoutsSyncKey(paginationMarkerLayouts);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stablePaginationMarkerLayouts = useMemo(() => paginationMarkerLayouts, [paginationMarkerLayoutsKey]);
  const columnFlowBlockLayoutsKey = getTextFlowColumnLayoutsSyncKey(columnFlowBlockLayouts);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableColumnFlowBlockLayouts = useMemo(() => columnFlowBlockLayouts, [columnFlowBlockLayoutsKey]);
  const boxFragmentSourceLayoutsKey = getTextFlowFragmentLayoutsSyncKey(boxFragmentSourceLayouts);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableBoxFragmentSourceLayouts = useMemo(() => boxFragmentSourceLayouts, [boxFragmentSourceLayoutsKey]);
  const unitNodeDisplacements = pickUnitNodeDisplacements(blocks, nodeDisplacements, markerDisplacements);
  const unitNodeDisplacementsKey = getNodeDisplacementsKey(unitNodeDisplacements);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableNodeDisplacements = useMemo(() => unitNodeDisplacements, [unitNodeDisplacementsKey]);

  if (parts.length === 1 && parts[0].type === "blocks") {
    return (
      <TextFlowEditor
        blocks={blocks}
        selectedId={selectedId}
        mathFractionSizing={mathFractionSizing}
        placeholder={placeholder}
        showPlaceholder={showPlaceholder}
        singleBlock={singleBlock}
        historyRevision={historyRevision}
        breakGaps={stableBreakGaps}
        nodeDisplacements={stableNodeDisplacements}
        paginationBeforeIds={stablePaginationBeforeIds}
        paginationMarkerKind={paginationMarkerKind}
        paginationMarkerKinds={stablePaginationMarkerKinds}
        paginationMarkerLayouts={stablePaginationMarkerLayouts}
        leadingManualBreak={leadingManualBreak}
        trailingManualBreak={trailingManualBreak}
        onManualBreakCommand={onManualBreakCommand}
        columnFlowBlockLayouts={stableColumnFlowBlockLayouts}
        boxFragmentSourceLayouts={stableBoxFragmentSourceLayouts}
        headingNumbers={headingNumbers}
        syncFocusedContent={syncFocusedContent}
        commentThreads={stableCommentThreads}
        activeCommentThreadId={activeCommentThreadId}
        highlightedCommentThreadId={highlightedCommentThreadId}
        onCommentThreadSelect={onCommentThreadSelect}
        onFocusChange={onFocusChange}
        onSelect={onSelect}
        onChange={onChange}
        onBoundaryDelete={onBoundaryDelete}
        materials={materials}
        onMaterialInsert={onMaterialInsert}
        enableSelectionFormatMenu={enableSelectionFormatMenu}
        enableBoxCommands={enableBoxCommands}
        enableProblemCommands={enableProblemCommands}
        onProblemCommand={onProblemCommand}
        onBodyBlockCommand={onBodyBlockCommand}
        enableHeadingCommands={enableHeadingCommands}
        onHeadingCommand={onHeadingCommand}
        changeDecorationState={changeDecorationState}
        editPolicy={textFlowEditPolicy}
        textRunGroupId={textRunGroupId}
        textRunOrder={(textRunOrder ?? 0) * 1000}
        textRunUnitId={`${textRunUnitId ?? blocks[0]?.id ?? textRunGroupId}:0`}
        textRunScopeId={textRunScopeId}
        textRunScopeContainer={textRunScopeContainer}
        textRunPreserveEmpty={textRunPreserveEmpty}
      />
    );
  }

  return (
    <>
      {parts.map((part, index) =>
        part.type === "blocks" ? (
          <TextFlowEditor
            key={part.key}
            blocks={part.blocks}
            selectedId={selectedId}
            mathFractionSizing={mathFractionSizing}
            placeholder={placeholder}
            showPlaceholder={showPlaceholder}
            singleBlock={singleBlock}
            historyRevision={historyRevision}
            breakGaps={stableBreakGaps}
            nodeDisplacements={stableNodeDisplacements}
            paginationBeforeIds={paginationBeforeIds?.filter((id) => part.blocks.some((block) => bodyTextFlowBlockContainsId(block, id)))}
            paginationMarkerKind={paginationMarkerKind}
            paginationMarkerKinds={paginationMarkerKinds}
            paginationMarkerLayouts={pickTextFlowColumnBlockLayouts(part.blocks, paginationMarkerLayouts)}
            leadingManualBreak={leadingManualBreak && index === 0}
            trailingManualBreak={trailingManualBreak && index === parts.length - 1}
            onManualBreakCommand={onManualBreakCommand}
            columnFlowBlockLayouts={pickTextFlowColumnBlockLayouts(part.blocks, columnFlowBlockLayouts)}
            boxFragmentSourceLayouts={pickTextFlowBoxFragmentSourceLayouts(part.blocks, boxFragmentSourceLayouts)}
            headingNumbers={headingNumbers}
            syncFocusedContent={syncFocusedContent}
            commentThreads={stableCommentThreads}
            activeCommentThreadId={activeCommentThreadId}
            highlightedCommentThreadId={highlightedCommentThreadId}
            onCommentThreadSelect={onCommentThreadSelect}
            onFocusChange={onFocusChange}
            onSelect={onSelect}
            onChange={onChange}
            onBoundaryDelete={onBoundaryDelete}
            materials={materials}
            onMaterialInsert={onMaterialInsert}
            enableSelectionFormatMenu={enableSelectionFormatMenu}
            enableBoxCommands={enableBoxCommands}
            enableProblemCommands={enableProblemCommands}
            onProblemCommand={onProblemCommand}
            onBodyBlockCommand={onBodyBlockCommand}
            enableHeadingCommands={enableHeadingCommands}
            onHeadingCommand={onHeadingCommand}
            changeDecorationState={changeDecorationState}
            editPolicy={textFlowEditPolicy}
            textRunGroupId={textRunGroupId}
            textRunOrder={(textRunOrder ?? 0) * 1000 + index}
            textRunUnitId={`${textRunUnitId ?? part.key}:${index}`}
            textRunScopeId={textRunScopeId}
            textRunScopeContainer={textRunScopeContainer}
            textRunPreserveEmpty={textRunPreserveEmpty}
          />
        ) : (
          <InlineContentStack
            key={part.key}
            items={part.items}
            displacement={precedingBlockDisplacement(parts, index, stableNodeDisplacements)}
          />
        ),
      )}
    </>
  );
}

/**
 * 本文の間に挟む差し込み (AI の差分プレビューなど) は、直前のブロックと同じだけずらして描く。
 * ブロックはページ・段へずらして描かれるので、差し込みだけ自然配置のままだと別のページに
 * 描かれ、ずらした本文と重なる。値の無いブロックは前のブロックの値を継ぐ。
 */
export function precedingBlockDisplacement(
  parts: readonly ({ type: "blocks"; blocks: readonly TextFlowBlock[] } | { type: string })[],
  partIndex: number,
  nodeDisplacements: Readonly<Record<string, FlowDisplacement>> | undefined,
): FlowDisplacement | undefined {
  if (!nodeDisplacements) return undefined;
  for (let index = partIndex - 1; index >= 0; index -= 1) {
    const part = parts[index];
    if (part.type !== "blocks" || !("blocks" in part)) continue;
    for (let blockIndex = part.blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const displacement = nodeDisplacements[part.blocks[blockIndex].id];
      if (displacement) return displacement;
    }
  }
  return undefined;
}

export function InlineContentStack({
  items,
  displacement,
}: {
  items: readonly PageCanvasInlineContent[];
  displacement?: FlowDisplacement;
}) {
  // 包みは常に置く (変位の有無で木の形を変えると、差し込みの中身が作り直されて状態を失う)。
  return (
    <div
      className="text-flow-inline-content"
      style={displacement && (displacement.dx !== 0 || displacement.dy !== 0)
        ? { position: "relative", top: displacement.dy, left: displacement.dx }
        : undefined}
    >
      {items.map((item) => <Fragment key={item.key}>{item.content}</Fragment>)}
    </div>
  );
}

/** Replica projections have no SigmaDoc write capability. */
export function ignoreFragmentProjectionChange() {}

export function EditorBoxBlockFragmentPreview({
  textRunOrder,
  block,
  fragment,
  historyRevision,
  selectedId,
  onSelect,
  changeDecorationState,
  pagedRender,
  fragmentPageIndex,
  paginationMarkerKind,
}: {
  block: TextFlowBlock;
  fragment: EditorBoxBlockFragmentLayout;
  historyRevision: number;
  selectedId: string | null;
  onSelect: (blockId: string | null) => void;
  changeDecorationState?: TextFlowChangeDecorationState;
  pagedRender: boolean;
  fragmentPageIndex: number;
  paginationMarkerKind: PageBreakMarkerKind;
  /** この複製が続きを見せているブロックを持つユニットの文書順。 */
  textRunOrder?: number;
}) {
  const { textFlowEditPolicy } = useEditorExtensions();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(block.type !== "codeBlock");
  const shouldRenderContent = pagedRender || block.type !== "codeBlock" || isNearViewport;
  useEffect(() => {
    if (pagedRender || block.type !== "codeBlock" || isNearViewport) {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport || typeof IntersectionObserver !== "function") {
      setIsNearViewport(true);
      return;
    }
    // external canvas editors の viewport culling と同じ発想。ただし shape/store は持ち込まず、固定寸法の
    // continuation viewport は残したまま、重い ProseMirror の複製だけを画面近傍で生成する。
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setIsNearViewport(true);
      }
    }, { rootMargin: "1200px 0px" });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [block.type, isNearViewport, pagedRender]);
  // カリングされている複製へキャレットを配る必要が出たら、ルーターが「その複製を出して
  // ほしい」とだけ知らせてくる。出した瞬間に登録され、ルーターが予約を消化する。
  useEffect(() => subscribeCaretSurfaceMount((wanted) => {
    if (
      wanted.kind === "fragmentReplica"
      && wanted.blockId === fragment.blockId
      && wanted.fragmentIndex === fragment.fragmentIndex
    ) {
      setIsNearViewport(true);
    }
  }), [fragment.blockId, fragment.fragmentIndex]);
  const selected = selectedId === block.id
    || (block.type === "boxBlock" && bodyTextFlowBlockContainsId(block, selectedId));
  const viewportStyle: CSSProperties = {
    left: `${fragment.x}px`,
    top: `${fragment.y}px`,
    width: `${fragment.width}px`,
    height: `${fragment.height}px`,
  };
  // 続きの帯は相対配置で上へずらして viewport で切る。transform にするとブラウザ自身の
  // キャレット追従がずらす前の位置を見て、打鍵のたびに紙面を跳ばす。
  const editorStyle = {
    minHeight: `${fragment.totalHeight}px`,
    position: "relative",
    top: `${-fragment.sourceOffsetY}px`,
    ...cornerBoxReferenceHeightStyleVars(fragment.totalHeight),
  } as CSSProperties;

  return (
    <div
      ref={viewportRef}
      className={`editor-box-fragment-viewport ${selected ? "selected" : ""}`}
      data-box-source-id={fragment.blockId}
      data-box-fragment-index={fragment.fragmentIndex}
      data-paged-code-fragment={pagedRender && block.type === "codeBlock" ? "" : undefined}
      data-fragment-page-index={pagedRender && block.type === "codeBlock" ? fragmentPageIndex : undefined}
      style={viewportStyle}
      onClick={(event) => event.stopPropagation()}
    >
      {shouldRenderContent && (
        <div className="editor-box-fragment-editor" style={editorStyle}>
          {pagedRender && block.type === "codeBlock"
            ? null
            : (
              <TextFlowEditor
                blocks={[block]}
                selectedId={selectedId}
                historyRevision={historyRevision}
                showPlaceholder={false}
                paginationBeforeIds={getNestedPageBreakBeforeIds([block])}
                paginationMarkerKind={paginationMarkerKind}
                paginationMarkerKinds={getNestedPageBreakBeforeKinds([block], paginationMarkerKind)}
                syncFocusedContent
                onSelect={onSelect}
                // FragmentEditSession routes all edits to the source flow.
                onChange={ignoreFragmentProjectionChange}
                materials={[]}
                enableBoxCommands={false}
                readOnlyBoxTitle
                changeDecorationState={changeDecorationState}
                editPolicy={textFlowEditPolicy}
                boxFragmentReplicaId={fragment.blockId}
                boxFragmentReplicaIndex={fragment.fragmentIndex}
                textRunOrder={textRunOrder}
              />
            )}
        </div>
      )}
    </div>
  );
}
