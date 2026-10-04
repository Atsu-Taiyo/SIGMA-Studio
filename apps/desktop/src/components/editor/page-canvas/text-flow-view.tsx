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
import type { CSSProperties,ReactElement } from "react";
import { createContext,useContext,useEffect,useMemo,useRef,useState } from "react";
import { hasBreakBefore } from "./block-ops";
import type { PageCanvasInlineContent } from "./editor-extension";
import { FlowExtensionReplicaContext } from "./flow-extension-replica";
import { getFlowDisplacementProps,getNodeDisplacementsKey,pickUnitNodeDisplacements } from "./flow-presentation";
import {
  FLOW_EXTENSION_NODE_ATTRIBUTE,
  FLOW_EXTENSION_REPLICA_ATTRIBUTE,
  FLOW_MEASURE_REVISION_ATTRIBUTE,
} from "./flow-probe";
import { getFlowExtensionNodeId,splitTextFlowBlocksByInlineContent } from "./inline-content-composition";
import {
  pickTextFlowBoxFragmentSourceLayouts,
  pickTextFlowColumnBlockLayouts,
  pickUnitBreakGaps,
  pickUnitCommentThreads,
} from "./render-units";
import type { EditorBoxBlockFragmentLayout } from "./types";

/**
 * フロー内の拡張ノードの配置 (ページ割りの答え)。紙面がフローの外側で配り、拡張ノードだけが読む
 * (編集面は自分のブロックの分だけを props で受け取るので、ここが変わっても描き直されない)。
 */
export interface FlowExtensionLayout {
  /** 拡張ノード id → ユニットからの相対の変位。 */
  nodeDisplacements: Readonly<Record<string, FlowDisplacement>>;
  /** ページ・段の境目で切れた拡張ノードの、正本に見せる帯。 */
  fragmentSources: Readonly<Record<string, TextFlowBoxFragmentSourceLayout>>;
}

const EMPTY_FLOW_EXTENSION_LAYOUT: FlowExtensionLayout = { nodeDisplacements: {}, fragmentSources: {} };

export const FlowExtensionLayoutContext = createContext<FlowExtensionLayout>(EMPTY_FLOW_EXTENSION_LAYOUT);

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

  // 差し込みの有無で木の形を変えない: 編集面は常に同じ並びの中に置き、先頭の範囲は差し込みが
  // 現れても同じ key のまま (`splitTextFlowBlocksByInlineContent`)。差し込みの直前の面が作り直されると、
  // 取り消し履歴・選択・IME 入力が失われる。範囲が 1 つのときは、このユニットの値を同じ参照で配る。
  const whole = parts.length === 1;
  const lastBlocksIndex = parts.reduce((last, part, index) => (part.type === "blocks" ? index : last), -1);
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
            paginationBeforeIds={whole
              ? stablePaginationBeforeIds
              : paginationBeforeIds?.filter((id) => part.blocks.some((block) => bodyTextFlowBlockContainsId(block, id)))}
            paginationMarkerKind={paginationMarkerKind}
            paginationMarkerKinds={whole ? stablePaginationMarkerKinds : paginationMarkerKinds}
            paginationMarkerLayouts={whole
              ? stablePaginationMarkerLayouts
              : pickTextFlowColumnBlockLayouts(part.blocks, paginationMarkerLayouts)}
            leadingManualBreak={leadingManualBreak && index === 0}
            trailingManualBreak={trailingManualBreak && index === lastBlocksIndex}
            onManualBreakCommand={onManualBreakCommand}
            columnFlowBlockLayouts={whole
              ? stableColumnFlowBlockLayouts
              : pickTextFlowColumnBlockLayouts(part.blocks, columnFlowBlockLayouts)}
            boxFragmentSourceLayouts={whole
              ? stableBoxFragmentSourceLayouts
              : pickTextFlowBoxFragmentSourceLayouts(part.blocks, boxFragmentSourceLayouts)}
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
            textRunUnitId={`${textRunUnitId ?? part.blocks[0]?.id ?? textRunGroupId ?? part.key}:${index}`}
            textRunScopeId={textRunScopeId}
            textRunScopeContainer={textRunScopeContainer}
            textRunPreserveEmpty={textRunPreserveEmpty}
          />
        ) : (
          <InlineContentStack
            key={part.key}
            items={part.items}
            fallbackDisplacement={precedingBlockDisplacement(parts, index, stableNodeDisplacements)}
          />
        ),
      )}
    </>
  );
}

/**
 * まだ配置の無い差し込みが継ぐ変位: 直前のブロックの値。ブロックはページ・段へずらして描かれるので、
 * 現れた直後の差し込みだけ自然配置のままだと別のページに描かれ、ずらした本文と重なる。
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

/**
 * 本文の間に挟む差し込み (AI の提案など) を、フロー内の拡張ノードとして描く。
 *
 * 差し込み 1 つが拡張ノード 1 つ (`data-flow-extension-node-id`)。ページ割りは本文と同じく自然配置で
 * 測って行の間で切る (`flow-probe.ts`)。描くときはページ割りが**その拡張ノード自身に**与えた変位で
 * ずらし、同じ量を `data-flow-dx/dy` に書く (計測はそれを差し引く。書かないと、ずらしを二重に数える)。
 * 配置の無い拡張ノード (現れた直後) は直前の値を継ぐ。ページの境目で切れたら、正本は最初の帯だけを
 * 見せ (clip-path は寸法を変えない)、続きは `FlowExtensionFragmentPreview` が次のページに描く。
 */
export function InlineContentStack({
  items,
  fallbackDisplacement,
}: {
  items: readonly PageCanvasInlineContent[];
  fallbackDisplacement?: FlowDisplacement;
}) {
  const layout = useContext(FlowExtensionLayoutContext);
  const nodes: ReactElement[] = [];
  let inherited = fallbackDisplacement;
  for (const item of items) {
    const nodeId = getFlowExtensionNodeId(item.key);
    const displacement = layout.nodeDisplacements[nodeId] ?? inherited;
    inherited = displacement;
    nodes.push(
      <FlowExtensionNode
        key={item.key}
        nodeId={nodeId}
        item={item}
        displacement={displacement}
        fragmentSource={layout.fragmentSources[nodeId]}
      />,
    );
  }
  return <>{nodes}</>;
}

function FlowExtensionNode({
  nodeId,
  item,
  displacement,
  fragmentSource,
}: {
  nodeId: string;
  item: PageCanvasInlineContent;
  displacement: FlowDisplacement | undefined;
  fragmentSource: TextFlowBoxFragmentSourceLayout | undefined;
}) {
  const { style, attributes } = getFlowDisplacementProps(displacement);
  // 見せる帯は上端からの高さで決める (CSS が clip-path にする。box fragment と同じ)。隠す量で切ると、
  // 中身が伸びてからページ割りが追いつくまでの間、伸びた分だけ帯が下へ伸びてページ下端をはみ出す。
  const split = !!fragmentSource && fragmentSource.totalHeight > fragmentSource.visibleHeight + 0.5;
  return (
    <div
      className="page-flow-extension-node"
      {...{
        [FLOW_EXTENSION_NODE_ATTRIBUTE]: nodeId,
        [FLOW_MEASURE_REVISION_ATTRIBUTE]: item.measureRevision,
      }}
      data-flow-extension-fragment-source={split ? "" : undefined}
      {...attributes}
      style={split
        ? { ...style, "--flow-extension-visible-height": `${fragmentSource.visibleHeight}px` } as CSSProperties
        : style}
    >
      {item.content}
    </div>
  );
}

/**
 * ページ・段の境目で切れた拡張ノードの続き。同じ `content` をもう一度描き、次のページの帯で切る。
 * 操作は最初の帯 (正本) にだけ置く前提なので、続きは `inert` で触れず、支援技術にも読ませない。
 * 中身には `useIsFlowExtensionReplica()` で複製であることを知らせる。
 * 正本の id (`data-flow-extension-node-id`) は持たない — 計測も e2e も正本だけを拾う。
 */
export function FlowExtensionFragmentPreview({
  item,
  fragment,
}: {
  item: PageCanvasInlineContent;
  fragment: EditorBoxBlockFragmentLayout;
}) {
  return (
    <div
      className="page-flow-extension-fragment"
      {...{ [FLOW_EXTENSION_REPLICA_ATTRIBUTE]: fragment.blockId }}
      data-flow-extension-fragment-index={fragment.fragmentIndex}
      inert
      aria-hidden="true"
      style={{
        left: `${fragment.x}px`,
        top: `${fragment.y}px`,
        width: `${fragment.width}px`,
        height: `${fragment.height}px`,
      }}
    >
      <div
        className="page-flow-extension-fragment-content"
        style={{ position: "relative", top: `${-fragment.sourceOffsetY}px`, width: `${fragment.width}px` }}
      >
        <FlowExtensionReplicaContext.Provider value>
          {item.content}
        </FlowExtensionReplicaContext.Provider>
      </div>
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
