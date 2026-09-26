"use client";
import { applyEditorDocumentProjection } from "@/components/tiptap/document-projection";

const sessionProjectionEditors = new WeakSet<TiptapEditor>();
import { useDocumentSession, useDocumentWritable } from "./document-session-context";
import { SessionPresenceExtension, sessionPresenceKey } from "@/components/tiptap/session-presence";

import { acknowledgeTextFlowContent, expectTextFlowContent } from "./text-flow/measurement-revision";
import { getFragmentEditSession } from "./text-flow/fragment-edit-session";
import { indexTextFlowBlocksById } from "@/features/text-editing";
import  {
  BoxActionDialog,
  BoxActionDialogState,
  CodeBlockSettingsPopover,
  CodeBlockSettingsPopoverState,
  SlashCommandPopover,
  TextFormatContextMenu,
  TextFormatContextMenuState,
  clampNumber,
} from "./text-flow/command-popovers";


import { Extension, type Editor as TiptapEditor } from "@tiptap/core";
import Placeholder from "@tiptap/extension-placeholder";
import  {
  Fragment,
  type Mark as ProseMirrorMark,
  type Node as ProseMirrorModelNode,
} from "@tiptap/pm/model";
import  {
  NodeSelection,
  Plugin,
  PluginKey,
  Selection,
  TextSelection,
  type EditorState,
  type Selection as ProseMirrorSelection,
  type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { EditorContent, useEditor } from "@tiptap/react";
import  {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";

import { BoxSettingsDialog } from "@/components/editor/BoxSettingsDialog";
import  {
  caretAtTextblockEdgeLine,
  flushPendingCaret,
  focusCaretAddress,
  moveCaretHorizontally,
  moveCaretVertically,
  registerCaretSurface,
  requestCaret,
  updateCaretSurfaceFacets,
  type CaretSurfaceFacets,
} from "@/components/editor/text-flow/caret-router";
import { flushDeferredCaretScroll, getCaretSurfaceBand, getCaretZoomScale, scrollCaretIntoView } from "@/components/editor/text-flow/caret-scroll";
import { posAtClientPoint } from "@/components/editor/text-flow/pos-at-client-point";
import type { TextFlowChangeDecorationState } from "@/components/tiptap/change-decoration";
import  {
  EditGuardExtension,
  editGuardKey,
  getTextFlowEditGuardsSyncKey,
  type TextFlowEditGuard,
} from "@/components/tiptap/edit-guard-extension";
import { ExternalTextRangeHighlightExtension, getPlainTextBlockLength, getTextRangeForBlock } from "@/components/tiptap/external-text-range-highlight-extension";
import { requestInlineMathEdit, sliceTextForClipboard } from "@/components/tiptap/inline-math-extension";
// `refreshPageBreakGaps` (個別 dispatch) は使わない: 装飾の更新は 1 本の transaction に
// まとめてあるので、meta キー (`paginationGapKey`) だけを取る。
import { DEFAULT_FONT_FAMILY_VALUE } from "@/components/editor/editor-shell/constants";
import { startExpandedTextSelection } from "@/components/editor/expanded-text-selection";
import { getBlockSpaceAfterPreview, subscribeBlockSpaceAfterPreview } from "@/components/editor/text-flow/block-space-after-preview";
import { createSpaceAfterPreviewDecorations } from "@/components/editor/text-flow/space-after-preview-decorations";
import { CodeBlockActionExtension } from "@/components/tiptap/code-block-action-extension";
import { countDecorationBlockWalk } from "@/components/tiptap/decoration-walk-metrics";
import { nestedProblemLayoutKey } from "@/components/tiptap/nested-problem-extension";
import { useProblemNumbers } from "./text-flow/ProblemNumberingContext";
import { HeadingNumberingExtension, headingNumberingKey } from "@/components/tiptap/heading-numbering-extension";
import { PageBreakGapExtension, paginationGapKey, type PageBreakMarkerLayout } from "@/components/tiptap/page-break-gap-extension";
import { FormattingMarksExtension } from "@/components/tiptap/formatting-marks-extension";
import { findAncestorNodeDepth, isEmptyEditorTextBlock } from "@/components/tiptap/node-queries";
import {
  BoxBlockBodyExtension,
  BoxBlockExtension,
  BoxBlockTitleExtension,
  LayoutSectionExtension,
} from "@/components/tiptap/sigma-doc-container-extensions";
import { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
import { SigmaDocTextIdentity } from "@/components/tiptap/sigma-doc-text-identity";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import  {
  applyTextFormatCommand,
  dispatchTextFormatState,
  isTextFormatTargetNodeType,
  isValidTextFormatSelection,
  type TextFormatCommandOptions,
  type TextFormatSelectionRange,
  type TextFormatStateContext,
} from "@/components/tiptap/text-format-controller";
import { UrlDetectionExtension } from "@/components/tiptap/url-detection-extension";
import  {
  normalizeCodeBlockTheme,
  normalizeLineHeight,
  type BoxBlockChildBlock,
  type BoxBlockNode,
  type BoxFrameSpec,
  type CodeBlockTheme,
  type InlineNode,
  type SigmaCommentThread,
} from "@/features/document";
import { normalizeCodeLanguage } from "@/features/rendering/adapters";
import { useMathEnvironment } from "@/features/rendering/adapters/react";
import  {
  DEFAULT_CARET_AFFINITY,
  areTextFlowBlockIdSequencesEqual,
  bodyTextFlowBlockContainsId,
  clampCaretOffset,
  getCommentThreadsSyncKey,
  getLastTextFlowBlockId,
  getTextFlowBlockEditorLength,
  getTextFlowBlockIds,
  getTextFlowBlocksSyncKey,
  getTextFlowBreakGapSyncKey,
  getTextFlowColumnLayoutsSyncKey,
  getTextFlowFragmentLayoutsSyncKey,
  hasTextFlowBlockAttributeChange,
  hasTextFlowBlockKindChange,
  isRecord,
  normalizeCaretAddressPath,
  resolveManualTextPageBreakBlocks,
  shouldSyncExternalTextFlowContent,
  shouldSyncFocusedTextFlowContent,
  shouldUseDocumentNextBlockForPageBreak,
  textFlowBlockAttributeSignature,
  textFlowBlocksContainId,
  type CaretAddress,
  type CaretAddressKind,
  type CaretAffinity,
  type CaretBlockPathEntry,
  type ManualTextPageBreakSelection,
  type TextFlowBlock,
  type TextFlowBlockKind,
  type TextFlowSelectionBookmark,
  type TextPageBreakRequestDetail,
} from "@/features/text-editing";
import type { PageBreakMarkerKind } from "@/features/text-editing/model";
import  {
  cornerBoxReferenceHeightStyleVars,
  observeCornerBoxReferenceHeights,
  patchBoxFrame,
  setBoxStyle,
} from "@/lib/box-blocks";
import  {
  createTextFlowClipboardPayload,
  getLocalEditorClipboardPayload,
  readEditorClipboardPayload,
  writeEditorPayloadToSystemClipboard,
  writeTextSliceClipboardData,
} from "@/lib/editor-clipboard";
import { useAppLocale, useT } from "@/lib/i18n/react";
import { createId } from "@/lib/id";
import { countPerformanceEvent, measurePerformance } from "@/lib/performance";
import { applyRememberedBoxFrame, forgetRememberedBoxFrame, rememberBoxFramePatch } from "@/lib/remembered-box-style";
import { inlineNodesToTiptapNodes, tiptapNodesToInlineNodes, type TiptapDoc, type TiptapNode } from "@/lib/tiptap-adapter";
import { SELECT_BODY_WITH_SHAPES_EVENT, collectSelectedBlockIds, requestBodySelectionShapes } from "./text-flow/body-shape-selection";
import  {
  clearBoxFragmentSelection,
  clearBoxFragmentSelectionOnOutsideFocus,
  startBoxFragmentPointerSelection,
} from "./text-flow/box-fragment-selection";
import { beginTextFlowDocumentChange, publishTextFlowSelectionBookmark } from "./text-flow/caret-bookmark-events";
import {
  copyTextFlowSelection,
  cutTextFlowSelection,
  isLiteralPasteShortcut,
  pasteAcrossTextFlowSelection,
  pasteTextAndShapesFromClipboard,
  pasteTextFlowBlocksFromClipboard,
  TextFlowClipboardSession,
} from "./text-flow/clipboard-transactions";
import {
  deleteManualBreakSpanningSelection,
  resolveManualBreakBoundaryNavigation,
  transferManualBreakToPastedBlocksAtOwnerStart,
  transferManualBreakToPastedSliceAtOwnerStart,
} from "./text-flow/manual-break-transactions";
export {
  getTextBlockBoundaryInsertPosition,
  isLiteralPasteShortcut,
  textFlowBlocksForSelectionClipboard,
  writeTextFlowSelectionClipboard,
} from "./text-flow/clipboard-transactions";
export {
  consumeRejectedManualBreakPaste,
  deleteManualBreakSpanningSelection,
  pasteHasUsableContent,
  resolveManualBreakBoundaryNavigation,
  resolveManualBreakPasteContent,
  selectionCrossesManualBreak,
  transferManualBreakToPastedBlocksAtOwnerStart,
  transferManualBreakToPastedSliceAtOwnerStart,
} from "./text-flow/manual-break-transactions";
import { createTextFlowHistoryGroupingState, groupTextFlowTransaction } from "./text-flow/history-grouping";
import { pasteAsInlineContent } from "./text-flow/inline-block-paste";
import  {
  buildLargeTextPastePlan,
  commitLargeTextPastePlan,
  findLargeTextPasteBlockedBlockId,
  isLargeTextPasteSelectionAtTopLevel,
  largeLiteralTextPasteBlocks,
  largeTextPasteBlocks,
  localClipboardPayloadMatchesPlainText,
  shouldUseLargeTextPaste,
} from "./text-flow/large-text-paste";
import { getActiveSlashCommandQuery, handleSlashCommandQueryKeyDown, insertSlashCommandFromQuery } from "./text-flow/slash-command-controller";
import { filterSlashCommandCandidates, sameSlashCommandQuery, type ActiveSlashCommandQuery, type SlashCommandCandidate } from "./text-flow/slash-command-model";
import  {
  applyTextRunSpanFormatForEvent,
  beginTextRunSpanComposition,
  clearTextRunSpan,
  clearTextRunSpanOnOutsideFocus,
  collectTextRunSpanBlockIds,
  copyActiveTextRunSpan,
  getTextRunSpanCompositionHistoryGroup,
  getTextRunSpanToggleMarkStates,
  getTextRunSpanFontSize,
  handleTextRunSpanKeyDown,
  handleTextRunSpanTextInput,
  isMultiEditorTextRunSpan,
  selectEntireTextRun,
  startTextRunPointerSelection,
  subscribeTextRunSpan,
} from "./text-flow/text-run-span";
import { textFlowToTiptap, tiptapToTextFlow } from "./text-flow/tiptap-document-adapter";
import type  {
  TextFlowBoundaryDeleteRequest,
  TextFlowBoxFragmentSourceLayout,
  TextFlowColumnBlockLayout,
  TextFlowEditorProps,
} from "./text-flow/types";

export type { TextFlowChangeDecorationState } from "@/components/tiptap/change-decoration";
export {
isTextFlowBlock,
resolveManualTextPageBreakBlocks,
shouldSyncFocusedTextFlowContent,
shouldUseDocumentNextBlockForPageBreak
} from "@/features/text-editing";
export {
textFlowToTiptap,
tiptapToTextFlow
} from "./text-flow/tiptap-document-adapter";
export type {
ManualTextPageBreakResult,
ManualTextPageBreakSelection,
TextFlowBlock,
TextFlowBodyBlockCommandRequest,
TextFlowBoundaryDeleteRequest,
TextFlowBoxCommandRequest,
TextFlowBoxFragmentSourceLayout,
TextFlowChangeContext,
TextFlowColumnBlockLayout,
TextFlowEditorProps,TextFlowHeadingCommandRequest,TextFlowMaterialInsertRequest,
TextFlowProblemCommandRequest,TextFlowReplaceOptions,
TextPageBreakRequestDetail
} from "./text-flow/types";

const INSERT_INLINE_MATH_EVENT = "sigma-studio:insert-inline-math";
const FORMAT_TEXT_EVENT = "sigma-studio:format-text";
const TEXT_FORMAT_STATE_EVENT = "sigma-studio:text-format-state";
// Compatibility exports for integrations that previously read the Tiptap schema here.
export {
  BoxBlockBodyExtension,
  BoxBlockExtension,
  BoxBlockTitleExtension,
  LayoutSectionExtension,
} from "@/components/tiptap/sigma-doc-container-extensions";
export { SigmaDocTextAttrs } from "@/components/tiptap/sigma-doc-text-attributes";
export {
  SigmaDocTextIdentity,
  appendSigmaDocTextIdentityTransaction,
} from "@/components/tiptap/sigma-doc-text-identity";

export const REQUEST_TEXT_PAGE_BREAK_EVENT = "sigma-studio:request-text-page-break";
export const REQUEST_BOX_SETTINGS_EVENT = "sigma-studio:request-box-settings";
const selectedTextBlockKey = new PluginKey("selectedTextBlock");
const changeDecorationKey = new PluginKey("textFlowChangeDecoration");
const commentDecorationKey = new PluginKey("commentDecorations");
const columnFlowLayoutKey = new PluginKey("columnFlowLayout");
const spaceAfterPreviewKey = new PluginKey("spaceAfterPreview");
const SPACE_AFTER_REFRESH_KINDS: ReadonlySet<TextFlowDecorationRefreshKind> = new Set(["spaceAfter"]);
const DIRECT_CONTROL_SELECTOR = "input, textarea, select, button, math-field";
const TEXT_FLOW_EDITOR_SELECTOR = ".text-flow-editor";

/** Only the canonical surface may claim a document-level break command. */
export function shouldHandleTextPageBreakRequest(
  detail: Pick<TextPageBreakRequestDetail, "handled">,
  isReplicaSurface: boolean,
): boolean {
  return detail.handled !== true && !isReplicaSurface;
}
/** 本文ブロック候補が無いときに渡す不変配列 (毎回新しい `[]` を作ると useMemo が毎回外れる)。 */
const EMPTY_BLOCK_COMMAND_IDS: readonly string[] = [];
const BOX_ACTION_DIALOG_WIDTH = 188;
const BOX_ACTION_DIALOG_HEIGHT = 180;
const BOX_ACTION_DIALOG_MARGIN = 12;
const CODE_SETTINGS_POPOVER_WIDTH = 260;
const CODE_SETTINGS_POPOVER_HEIGHT = 214;
const CODE_SETTINGS_POPOVER_MARGIN = 12;
const EDITOR_CORNERBOX_SELECTOR = ".sigma-doc-box-block.box-frame--corner[data-box-style='cornerbox']";

interface BoxSettingsDialogState {
  boxId: string;
  styleId: string;
  frame?: BoxFrameSpec;
  title: InlineNode[];
  /** ⋯メニューの「タイトルを編集…」から開いたときだけ true。 */
  focusTitle: boolean;
}

interface SelectedTextBlockOptions {
  getSelectedId: () => string | null;
}

interface CommentDecorationOptions {
  getActiveThreadId: () => string | null;
  getBlockIds: () => string[];
  getHighlightedThreadId: () => string | null;
  getThreads: () => SigmaCommentThread[];
}

interface ColumnFlowLayoutOptions {
  getLayouts: () => Record<string, TextFlowColumnBlockLayout>;
  getBoxFragmentSourceLayouts: () => Record<string, TextFlowBoxFragmentSourceLayout>;
  getNodeDisplacements: () => Readonly<Record<string, { dx: number; dy: number }>> | undefined;
}

/**
 * このスレッドの装飾が、その編集器が持つブロックの上に出るか。
 *
 * 判定はコメント装飾の描画側と同じ: ブロック / 数式はそのブロック、範囲は両端のどちらかが
 * この編集器にあれば (順序表に片端しか無い範囲は描けないが、増減で見た目が変わりうる)。
 */
function commentThreadTouchesBlocks(thread: SigmaCommentThread, blockIds: ReadonlySet<string>): boolean {
  const anchor = thread.anchor;
  switch (anchor.type) {
    case "block":
    case "inlineMath":
      return blockIds.has(anchor.blockId);
    case "textRange":
      return blockIds.has(anchor.start.blockId) || blockIds.has(anchor.end.blockId);
    default:
      return false;
  }
}

const SelectedTextBlockExtension = Extension.create<SelectedTextBlockOptions>({
  name: "selectedTextBlock",

  addOptions() {
    return {
      getSelectedId: () => null,
    };
  },

  addProseMirrorPlugins() {
    const getSelectedId = () => this.options.getSelectedId();

    return [
      new Plugin({
        key: selectedTextBlockKey,
        props: {
          decorations: (state) => {
            const selectedId = getSelectedId();
            if (!selectedId) {
              return DecorationSet.empty;
            }

            const decorations: Decoration[] = [];
            state.doc.forEach((node, offset) => {
              if (node.attrs?.sigmaDocId !== selectedId) {
                return;
              }

              decorations.push(
                Decoration.node(offset, offset + node.nodeSize, {
                  class: "text-flow-selected-line",
                }),
              );
            });

            return decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

interface ChangeDecorationOptions {
  getState: () => TextFlowChangeDecorationState | null;
}

/** Renders host-supplied before/applying/after states as node decorations,
 * keyed by `sigmaDocId` exactly like `SelectedTextBlockExtension` above.
 * `removingIds`/`addedIds` take priority over the static `removedIds` so an
 * in-flight transition is not fought by its static before-state background. */
const ChangeDecorationExtension = Extension.create<ChangeDecorationOptions>({
  name: "textFlowChangeDecoration",

  addOptions() {
    return {
      getState: () => null,
    };
  },

  addProseMirrorPlugins() {
    const getState = () => this.options.getState();

    return [
      new Plugin({
        key: changeDecorationKey,
        props: {
          decorations: (state) => {
            const diffState = getState();
            if (!diffState) {
              return DecorationSet.empty;
            }

            const removedIds = diffState.removedIds;
            const removingIds = diffState.removingIds;
            const addedIds = diffState.addedIds;
            if (!removedIds?.length && !removingIds?.length && !addedIds?.length) {
              return DecorationSet.empty;
            }

            const decorations: Decoration[] = [];
            state.doc.forEach((node, offset) => {
              const id = node.attrs?.sigmaDocId;
              if (typeof id !== "string" || !id) {
                return;
              }

              const className = removingIds?.includes(id)
                ? "text-flow-change-removing"
                : addedIds?.includes(id)
                  ? "text-flow-change-added"
                  : removedIds?.includes(id)
                    ? "text-flow-change-before"
                    : null;
              if (!className) {
                return;
              }

              decorations.push(
                Decoration.node(offset, offset + node.nodeSize, { class: className }),
              );
            });

            return decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

const CommentDecorationExtension = Extension.create<CommentDecorationOptions>({
  name: "commentDecoration",

  addOptions() {
      return {
        getActiveThreadId: () => null,
        getBlockIds: () => [],
        getHighlightedThreadId: () => null,
        getThreads: () => [],
      };
  },

  addProseMirrorPlugins() {
    const getActiveThreadId = () => this.options.getActiveThreadId();
    const getBlockIds = () => this.options.getBlockIds();
    const getHighlightedThreadId = () => this.options.getHighlightedThreadId();
    const getThreads = () => this.options.getThreads();

    return [
      new Plugin({
        key: commentDecorationKey,
        props: {
          decorations: (state) => {
            const activeThreadId = getActiveThreadId();
            const highlightedThreadId = getHighlightedThreadId();
            const threads = getThreads().filter((thread) => (
              !thread.resolved ||
              thread.id === activeThreadId ||
              thread.id === highlightedThreadId
            ));
            if (threads.length === 0) {
              return DecorationSet.empty;
            }

            const decorations: Decoration[] = [];
            const blockIds = getBlockIds();
            const order = new Map(blockIds.map((id, index) => [id, index]));
            // コメントが 1 つも無ければ上で抜けている。ここへ来るのは「この編集器にコメントが
            // 掛かっている」ときだけなので、走査はブロック構造どまり (中身へは範囲装飾と
            // 数式アンカーの生成側が必要な分だけ降りる)。
            countDecorationBlockWalk();
            state.doc.descendants((node, pos) => {
              if (node.type.name !== "paragraph" && node.type.name !== "heading") {
                return !node.isTextblock && !node.isLeaf;
              }

              const blockId = typeof node.attrs.sigmaDocId === "string" ? node.attrs.sigmaDocId : "";
              if (!blockId) {
                return false;
              }

              const blockThreads = threads.filter((thread) => (
                thread.anchor.type === "block" && thread.anchor.blockId === blockId
              ));
              if (blockThreads.length > 0) {
                decorations.push(Decoration.node(pos, pos + node.nodeSize, commentDecorationAttrs(blockThreads, highlightedThreadId, "text-flow-commented-line")));
              }

              for (const thread of threads) {
                if (thread.anchor.type === "textRange") {
                  const range = getTextRangeForBlock(thread.anchor, blockId, order, getPlainTextBlockLength(node));
                  if (range) {
                    for (const decoration of createTextRangeDecorations(node, pos, range.from, range.to, thread, highlightedThreadId)) {
                      decorations.push(decoration);
                    }
                  }
                } else if (thread.anchor.type === "inlineMath") {
                  const mathInlineId = thread.anchor.mathInlineId;
                  node.descendants((child, childPos) => {
                    if (child.type.name !== "mathInline" || child.attrs.id !== mathInlineId) {
                      return;
                    }
                    const mathPos = pos + 1 + childPos;
                    decorations.push(Decoration.node(mathPos, mathPos + child.nodeSize, commentDecorationAttrs([thread], highlightedThreadId, "comment-inline-math-highlight")));
                  });
                }
              }
              return false;
            });

            return decorations.length ? DecorationSet.create(state.doc, decorations) : DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

const ColumnFlowLayoutExtension = Extension.create<ColumnFlowLayoutOptions>({
  name: "columnFlowLayout",

  addOptions() {
    return {
      getLayouts: () => ({}),
      getBoxFragmentSourceLayouts: () => ({}),
      getNodeDisplacements: () => undefined,
    };
  },

  addProseMirrorPlugins() {
    const getLayouts = () => this.options.getLayouts();
    const getBoxFragmentSourceLayouts = () => this.options.getBoxFragmentSourceLayouts();
    const getNodeDisplacements = () => this.options.getNodeDisplacements();

    return [
      new Plugin({
        key: columnFlowLayoutKey,
        props: {
          decorations: (state) => createColumnFlowLayoutDecorations(
            state.doc,
            getLayouts(),
            getBoxFragmentSourceLayouts(),
            getNodeDisplacements(),
          ),
        },
      }),
    ];
  },
});

export function createColumnFlowLayoutDecorations(
  doc: ProseMirrorModelNode,
  layouts: Record<string, TextFlowColumnBlockLayout>,
  boxFragmentSourceLayouts: Record<string, TextFlowBoxFragmentSourceLayout>,
  nodeDisplacements?: Readonly<Record<string, { dx: number; dy: number }>>,
): DecorationSet {
  const decorations: Decoration[] = [];
  // ページ割りの変位。値の無いブロックは直前のブロックの値を継ぐ。
  let inherited = { dx: 0, dy: 0 };

  doc.forEach((node, offset) => {
    const blockId = typeof node.attrs?.sigmaDocId === "string" ? node.attrs.sigmaDocId : "";
    const ownDisplacement = nodeDisplacements && blockId ? nodeDisplacements[blockId] : undefined;
    if (ownDisplacement) inherited = ownDisplacement;
    const displacement = nodeDisplacements && (inherited.dx !== 0 || inherited.dy !== 0) ? inherited : undefined;
    const positionable = node.type.name === "paragraph" || node.type.name === "heading" || node.type.name === "bulletList" || node.type.name === "orderedList" || node.type.name === "boxBlock" || node.type.name === "layoutSection" || node.type.name === "quote" || node.type.name === "codeBlock" || node.type.name === "divider";
    const layout = positionable && blockId ? layouts[blockId] : undefined;
    // Any block (not only a box) can be split into clipped fragments when it is
    // taller than a page/column, so the source clip applies whenever a fragment
    // source layout exists for this block.
    const fragmentSource = blockId ? boxFragmentSourceLayouts[blockId] : undefined;
    if (!layout && !fragmentSource && !displacement) {
      return;
    }

    const classes: string[] = [];
    const styles: string[] = [];
    const attributes: Record<string, string> = {};
    if (layout) {
      classes.push("text-flow-column-block");
      styles.push(
        "position:absolute",
        `left:${Math.round(layout.x)}px`,
        `top:${Math.round(layout.y)}px`,
        `width:${Math.round(layout.width)}px`,
      );
    }
    if (displacement) {
      styles.push(`translate:${displacement.dx}px ${displacement.dy}px`);
      attributes["data-flow-dx"] = String(displacement.dx);
      attributes["data-flow-dy"] = String(displacement.dy);
    }
    if (fragmentSource && fragmentSource.totalHeight > fragmentSource.visibleHeight + 0.5) {
      const hiddenBottom = Math.max(0, fragmentSource.totalHeight - fragmentSource.visibleHeight);
      classes.push("text-flow-box-fragment-source");
      styles.push(
        `--text-flow-box-fragment-visible-height:${fragmentSource.visibleHeight}px`,
        `--text-flow-box-fragment-hidden-bottom:${hiddenBottom}px`,
        ...styleVarsToInlineCss(cornerBoxReferenceHeightStyleVars(fragmentSource.totalHeight)),
        `clip-path:inset(0 0 ${hiddenBottom}px 0)`,
      );
      attributes["data-box-fragment-source-id"] = blockId;
    }

    decorations.push(
      Decoration.node(offset, offset + node.nodeSize, {
        ...(classes.length > 0 ? { class: classes.join(" ") } : {}),
        style: styles.join(";"),
        ...attributes,
      }),
    );
  });

  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/**
 * ドラッグ中のブロック下余白プレビュー。掴んだブロックの後続に「追従する」印を配るだけで、
 * 移動量そのものは紙面の親に書かれた custom property から読む ({@link createSpaceAfterPreviewDecorations})。
 *
 * **複製の面には載せない**。ページを跨いだ続きを描く複製は、正本と同じブロック id を持つ面を
 * もう 1 つ作る。印はモジュールのストアから id で配られるので、素通りさせると「掴んだ側とは
 * 別のページにあるクリップ窓の中身」まで一緒に平行移動する (追従集合は同じページのものしか
 * 選んでいないのに、id が一致するだけで届いてしまう)。
 */
const SpaceAfterPreviewExtension = Extension.create<{ isReplicaSurface: () => boolean }>({
  name: "spaceAfterPreview",

  addOptions() {
    return { isReplicaSurface: () => false };
  },

  addProseMirrorPlugins() {
    const isReplicaSurface = this.options.isReplicaSurface;
    return [
      new Plugin({
        key: spaceAfterPreviewKey,
        props: {
          decorations: (state) => (isReplicaSurface()
            ? DecorationSet.empty
            : createSpaceAfterPreviewDecorations(state.doc, getBlockSpaceAfterPreview())),
        },
      }),
    ];
  },
});

/** An orphaned/stale projection must not accept edits it cannot commit. */
const FragmentInputGuardExtension = Extension.create<{ canEdit: () => boolean }>({
  name: "fragmentInputGuard",
  addOptions: () => ({ canEdit: () => true }),
  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction: (transaction) => !transaction.docChanged
        || transaction.getMeta("preventUpdate") === true
        || this.options.canEdit(),
    })];
  },
});

function styleVarsToInlineCss(vars: Record<string, string>): string[] {
  return Object.entries(vars).map(([property, value]) => `${property}:${value}`);
}

function TextFlowEditorImpl({
  blocks,
  selectedId,
  mathFractionSizing,
  placeholder,
  showPlaceholder = true,
  singleBlock = false,
  historyRevision,
  breakGaps,
  paginationBeforeIds,
  paginationMarkerKind,
  paginationMarkerKinds,
  paginationMarkerLayouts,
  columnFlowBlockLayouts,
  nodeDisplacements,
  boxFragmentSourceLayouts,
  headingNumbers = {},
  boxFragmentReplicaId,
  boxFragmentReplicaIndex,
  syncFocusedContent = false,
  commentThreads = [],
  activeCommentThreadId = null,
  highlightedCommentThreadId = null,
  onCommentThreadSelect,
  onFocusChange,
  onSelect,
  onChange: onDocumentChange,
  onBoundaryDelete,
  materials = [],
  onMaterialInsert,
  enableSelectionFormatMenu = true,
  enableBoxCommands = true,
  boxCommandStyleIds,
  onBoxCommand,
  enableProblemCommands = false,
  onProblemCommand,
  onBodyBlockCommand,
  enableHeadingCommands = false,
  onHeadingCommand,
  formatTarget = "document",
  changeDecorationState,
  editPolicy,
  readOnlyBoxTitle = false,
  textRunGroupId,
  textRunOrder = 0,
  textRunUnitId,
  textRunScopeId,
  textRunScopeContainer,
  textRunPreserveEmpty = false,
}: TextFlowEditorProps) {
  const documentSession = useDocumentSession();
  const documentWritable = useDocumentWritable();
  const documentSessionRef = useRef(documentSession);
  useLayoutEffect(() => { documentSessionRef.current = documentSession; }, [documentSession]);
  const t = useT("editor");
  const locale = useAppLocale();
  countPerformanceEvent("TextFlowEditor.render");
  const mathEnvironment = useMathEnvironment();
  // ブロック ID の並びと内容キーは「値」で持つ。`blocks` は打鍵のたびに作り直される配列なので、
  // 識別子のまま memo/effect の deps に置くと打鍵 1 回で本文ユニット数だけ装飾更新の
  // transaction が飛ぶ (中身は 1 文字も変わっていない)。
  const previousIdsKey = useMemo(() => getTextFlowBlockIds(blocks).join("\u0000"), [blocks]);
  const previousIds = useMemo(
    () => getTextFlowBlockIds(blocks),
    // ID 列が同じなら同じ配列を使い回す (`blocks` は毎レンダー新しい配列なので識別子では判定できない)。
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [previousIdsKey],
  );
  const blocksSyncKey = useMemo(() => getTextFlowBlocksSyncKey(blocks), [blocks]);
  const previousIdsRef = useRef(previousIds);
  /**
   * この面が「ページを跨いだ続きを見せる複製」か。
   *
   * 装飾プラグインは render の外 (transaction のたび) に走るので ref で持つ。**useEditor より
   * 前に宣言する** — プラグインが最初の装飾をエディタ生成の途中で走らせるため。
   */
  const isBoxFragmentReplicaRef = useRef(boxFragmentReplicaId !== undefined);
  useLayoutEffect(() => {
    isBoxFragmentReplicaRef.current = boxFragmentReplicaId !== undefined;
  }, [boxFragmentReplicaId]);
  const blocksRef = useRef(blocks);
  const selectedIdRef = useRef(selectedId);
  /** この編集器が今どのブロックを「選択中の行」として描いているか (合図の要否判定に使う)。 */
  const ownedSelectedIdRef = useRef<string | null>(null);
  const changeDecorationStateRef = useRef(changeDecorationState);
  const onSelectRef = useRef(onSelect);
  const fragmentSessionRef = useRef<ReturnType<typeof getFragmentEditSession> | null>(null);
  const onChange = useCallback<TextFlowEditorProps["onChange"]>((ids, nextBlocks, activeId, context) => {
    if (boxFragmentReplicaId) {
      // The source flow is the only writer, including commands/cut/paste that
      // bypass onUpdate. It synchronizes its measurable DOM before saving.
      fragmentSessionRef.current?.dispatch({ blockId: boxFragmentReplicaId, blocks: nextBlocks, activeBlockId: activeId, context });
      return;
    }
    onDocumentChange(ids, nextBlocks, activeId, context);
  }, [boxFragmentReplicaId, onDocumentChange]);
  const onChangeRef = useRef(onChange);
  const onBoundaryDeleteRef = useRef(onBoundaryDelete);
  const onMaterialInsertRef = useRef(onMaterialInsert);
  const onBoxCommandRef = useRef(onBoxCommand);
  const onProblemCommandRef = useRef(onProblemCommand);
  const onBodyBlockCommandRef = useRef(onBodyBlockCommand);
  const onHeadingCommandRef = useRef(onHeadingCommand);
  const openCodeBlockSettingsRef = useRef<(codeBlockId: string, button: HTMLButtonElement) => void>(() => {});
  const codeBlockActionLabelRef = useRef(t("codeBlock.settings"));
  const slashCommandQueryRef = useRef<ActiveSlashCommandQuery | null>(null);
  /**
   * `useEditor` の中 (editorProps.handleKeyDown) からは `editor` をまだ参照できないので、
   * `/` から Tiptap のコマンドを呼ぶためにインスタンスを ref で持ち回る。
   */
  const tiptapEditorRef = useRef<TiptapEditor | null>(null);
  const editGuardsByBlockId = useMemo(() => {
    const guards = new Map<string, TextFlowEditGuard>();
    for (const guard of editPolicy?.guards ?? []) {
      guards.set(guard.blockId, guard);
    }
    if (editPolicy?.lockAll) {
      for (const blockId of previousIds) {
        guards.set(blockId, {
          ...editPolicy.lockAll,
          blockId,
          isPrimaryActionTarget: false,
        });
      }
    }
    return guards;
  }, [editPolicy, previousIds]);
  const editGuardsKey = useMemo(() => getTextFlowEditGuardsSyncKey(editGuardsByBlockId), [editGuardsByBlockId]);
  const editGuardsRef = useRef(editGuardsByBlockId);
  const [editGuardNotice, setEditGuardNotice] = useState<string | null>(null);
  const editGuardNoticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleEditGuardBlockedAttempt = useCallback((blockId: string) => {
    const guard = editGuardsRef.current.get(blockId);
    if (!guard) {
      return;
    }
    setEditGuardNotice(guard.blockedMessage);
    if (editGuardNoticeTimeoutRef.current) {
      clearTimeout(editGuardNoticeTimeoutRef.current);
    }
    editGuardNoticeTimeoutRef.current = setTimeout(() => setEditGuardNotice(null), 6000);
  }, []);
  const onEditGuardBlockedAttemptRef = useRef(handleEditGuardBlockedAttempt);
  const slashCommandCandidatesRef = useRef<SlashCommandCandidate[]>([]);
  const slashCommandActiveIndexRef = useRef(0);
  const lastTextSelectionRef = useRef<{ blockId: string; from: number; to: number } | null>(null);
  const selectionBeforeTransactionRef = useRef<TextFlowSelectionBookmark | null>(null);
  const verticalNavigationXRef = useRef<number | null>(null);
  const [clipboardSession] = useState(() => new TextFlowClipboardSession());
  const previousHistoryRevisionRef = useRef(historyRevision);
  /** Blocks key the history-restore layout effect has already pushed into the editor. */
  const syncedContentKeyRef = useRef<string | null>(null);
  /**
   * Blocks key the editor was created with — valid only until its content is first replaced.
   * It keeps the passive sync below from re-applying the very content Tiptap was just created
   * with (a duplicate `setContent` per unit on every open), and is dropped at the first real
   * update so a later round trip back to this exact content is never mistaken for "already in
   * the editor".
   */
  const mountContentKeyRef = useRef<string | null>(blocksSyncKey);
  /**
   * Pending cross-editor span replacement (registry onChange). The passive sync below must
   * apply it even when this editor is focused with unchanged block ids — the replacement was
   * assembled outside the editor, so "same ids" does not mean "already in the editor". Carries
   * the mutation's caret bookmark so the focused editor lands on it without waiting for the
   * scheduled restore.
   */
  const crossEditorSyncRef = useRef<{ selection: TextFlowSelectionBookmark | null; historyGroup?: string } | null>(null);
  const [historyGroupScope] = useState(() => createId("text_history"));
  const historyGroupingRef = useRef(createTextFlowHistoryGroupingState());
  // Tiptap reads `content` only while it creates an editor, and it creates one only when the
  // `useEditor` dependency list below changes. Converting on every render meant every keystroke
  // paid a full textFlowToTiptap() per unit for a value nothing reads. **This dependency list
  // must stay identical to the `useEditor` one below**: if the editor is recreated without
  // recomputing this, the new editor starts from the blocks of an older render.
  const initialContent = useMemo(
    () => textFlowToTiptap(blocks),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mathEnvironment, mathFractionSizing, readOnlyBoxTitle, showPlaceholder, singleBlock],
  );
  const breakGapsRef = useRef<Record<string, number>>(breakGaps ?? {});
  const paginationBeforeIdsRef = useRef<string[]>(paginationBeforeIds ?? []);
  // 区切りの**種別**を受け取り、表示文言はここで解決する
  // (文字列で受け取ると「段区切りかどうか」の判定が表示言語に依存してしまう)。
  const resolvedPaginationMarkerKind = paginationMarkerKind ?? "pageBreak";
  // プレースホルダ文言は ref 経由で言語に追従する。useEditor の deps に載せると
  // 言語切替のたびに本文ユニット数だけ Tiptap が破棄・再生成され、未マウントの
  // `editor.view.dom` アクセスが例外になる。
  const placeholderRef = useRef(placeholder ?? t("body.placeholder"));
  const paginationMarkerKindRef = useRef(resolvedPaginationMarkerKind);
  const paginationMarkerKindsRef = useRef<Record<string, PageBreakMarkerKind>>(paginationMarkerKinds ?? {});
  const markerLabelOf = useCallback(
    (kind: PageBreakMarkerKind) => (
      kind === "columnBreak" ? t("pagination.columnBreak") : t("pagination.pageBreak")
    ),
    [t],
  );
  const paginationMarkerLabelRef = useRef(markerLabelOf);
  const removeMarkerLabelOf = useCallback(
    (kind: PageBreakMarkerKind) => t("pagination.removeBreak", {
      replace: { kind: markerLabelOf(kind) },
    }),
    [markerLabelOf, t],
  );
  const removePaginationMarkerLabelRef = useRef(removeMarkerLabelOf);
  const removePaginationMarkerButtonLabelRef = useRef(t("pagination.removeBreakButton"));
  useEffect(() => {
    paginationMarkerLabelRef.current = markerLabelOf;
    removePaginationMarkerLabelRef.current = removeMarkerLabelOf;
    removePaginationMarkerButtonLabelRef.current = t("pagination.removeBreakButton");
  }, [markerLabelOf, removeMarkerLabelOf, t]);
  const paginationMarkerLayoutsRef = useRef<Record<string, PageBreakMarkerLayout>>(paginationMarkerLayouts ?? {});
  const columnFlowBlockLayoutsRef = useRef<Record<string, TextFlowColumnBlockLayout>>(columnFlowBlockLayouts ?? {});
  const nodeDisplacementsRef = useRef(nodeDisplacements);
  const problemNumbers = useProblemNumbers();
  const problemNumbersRef = useRef(problemNumbers);
  const getProblemNumbers = useCallback(() => problemNumbersRef.current, []);
  const headingNumbersRef = useRef<Readonly<Record<string, string>>>(headingNumbers);
  const boxFragmentSourceLayoutsRef = useRef<Record<string, TextFlowBoxFragmentSourceLayout>>(boxFragmentSourceLayouts ?? {});
  const commentThreadsRef = useRef(commentThreads);
  const activeCommentThreadIdRef = useRef(activeCommentThreadId);
  const highlightedCommentThreadIdRef = useRef(highlightedCommentThreadId);
  const getBreakGaps = useCallback(() => breakGapsRef.current, []);
  const getPageBreakBeforeIds = useCallback(() => paginationBeforeIdsRef.current, []);
  const getPageBreakMarkerKind = useCallback(() => paginationMarkerKindRef.current, []);
  const getPageBreakMarkerKinds = useCallback(() => paginationMarkerKindsRef.current, []);
  const getPageBreakMarkerLabel = useCallback(
    (kind: PageBreakMarkerKind) => paginationMarkerLabelRef.current(kind),
    [],
  );
  const getRemovePageBreakMarkerLabel = useCallback(
    (kind: PageBreakMarkerKind) => removePaginationMarkerLabelRef.current(kind),
    [],
  );
  const getRemovePageBreakMarkerButtonLabel = useCallback(
    () => removePaginationMarkerButtonLabelRef.current,
    [],
  );
  const removePageBreakMarker = useCallback((blockId: string) => {
    const detail: TextPageBreakRequestDetail = { blockId, enabled: false };
    window.dispatchEvent(new CustomEvent(REQUEST_TEXT_PAGE_BREAK_EVENT, { detail }));
  }, []);
  const getPageBreakMarkerLayouts = useCallback(() => paginationMarkerLayoutsRef.current, []);
  const getColumnFlowBlockLayouts = useCallback(() => columnFlowBlockLayoutsRef.current, []);
  const getNodeDisplacements = useCallback(() => nodeDisplacementsRef.current, []);
  const getHeadingNumbers = useCallback(() => headingNumbersRef.current, []);
  const getHeadingNumberLayoutKey = useCallback((blockId: string) => {
    const layout = columnFlowBlockLayoutsRef.current[blockId];
    return layout
      ? `${Math.round(layout.x)}:${Math.round(layout.y)}:${Math.round(layout.width)}`
      : "flow";
  }, []);
  const getBoxFragmentSourceLayouts = useCallback(() => boxFragmentSourceLayoutsRef.current, []);
  const [slashCommandQuery, setSlashCommandQuery] = useState<ActiveSlashCommandQuery | null>(null);
  const [slashCommandActiveIndex, setSlashCommandActiveIndex] = useState(0);
  const [boxActionDialog, setBoxActionDialog] = useState<BoxActionDialogState | null>(null);
  const [boxSettingsDialog, setBoxSettingsDialog] = useState<BoxSettingsDialogState | null>(null);
  const [codeBlockSettingsPopover, setCodeBlockSettingsPopover] = useState<CodeBlockSettingsPopoverState | null>(null);
  const [textFormatContextMenu, setTextFormatContextMenu] = useState<TextFormatContextMenuState | null>(null);
  const boxSettingsBlockExists = boxSettingsDialog
    ? findBoxBlockInTextFlowBlocks(blocks, boxSettingsDialog.boxId) !== null
    : false;
  const activeBoxSettingsDialog = boxSettingsBlockExists ? boxSettingsDialog : null;
  const activeCodeBlockSettingsPopover = codeBlockSettingsPopover
    && previousIds.includes(codeBlockSettingsPopover.codeBlockId)
    ? codeBlockSettingsPopover
    : null;
  const slashCommandBlockIds = singleBlock ? EMPTY_BLOCK_COMMAND_IDS : slashCommandQuery?.availableBlockCommandIds ?? EMPTY_BLOCK_COMMAND_IDS;
  const slashCommandCandidates = useMemo(
    () => filterSlashCommandCandidates(
      materials,
      slashCommandQuery?.query ?? "",
      enableBoxCommands && (slashCommandQuery?.canInsertBox ?? false),
      t,
      boxCommandStyleIds,
      enableProblemCommands,
      slashCommandBlockIds,
      enableHeadingCommands,
    ),
    [boxCommandStyleIds, enableBoxCommands, enableHeadingCommands, enableProblemCommands, materials, slashCommandBlockIds, slashCommandQuery?.canInsertBox, slashCommandQuery?.query, t],
  );
  const slashCommandMaxIndex = Math.max(0, slashCommandCandidates.length - 1);
  const clampedSlashCommandActiveIndex = Math.min(slashCommandActiveIndex, slashCommandMaxIndex);

  const openCodeBlockSettings = useCallback((codeBlockId: string, button: HTMLButtonElement) => {
    const codeBlock = button.closest<HTMLElement>(".print-code[data-sigma-doc-id]");
    if (!codeBlock || codeBlock.dataset.sigmaDocId !== codeBlockId) {
      return;
    }

    const rect = button.getBoundingClientRect();
    const maxLeft = Math.max(
      CODE_SETTINGS_POPOVER_MARGIN,
      window.innerWidth - CODE_SETTINGS_POPOVER_WIDTH - CODE_SETTINGS_POPOVER_MARGIN,
    );
    const maxTop = Math.max(
      CODE_SETTINGS_POPOVER_MARGIN,
      window.innerHeight - CODE_SETTINGS_POPOVER_HEIGHT - CODE_SETTINGS_POPOVER_MARGIN,
    );
    setCodeBlockSettingsPopover((current) => current?.codeBlockId === codeBlockId ? null : {
      codeBlockId,
      language: normalizeCodeLanguage(codeBlock.dataset.codeLanguage) ?? null,
      theme: normalizeCodeBlockTheme(codeBlock.dataset.codeTheme) ?? "light",
      left: clampNumber(rect.right - CODE_SETTINGS_POPOVER_WIDTH, CODE_SETTINGS_POPOVER_MARGIN, maxLeft),
      top: clampNumber(rect.bottom + 6, CODE_SETTINGS_POPOVER_MARGIN, maxTop),
    });
    selectedIdRef.current = codeBlockId;
    onSelectRef.current(codeBlockId);
  }, [setCodeBlockSettingsPopover]);

  useEffect(() => {
    openCodeBlockSettingsRef.current = openCodeBlockSettings;
  }, [openCodeBlockSettings]);

  useEffect(() => {
    codeBlockActionLabelRef.current = t("codeBlock.settings");
    placeholderRef.current = placeholder ?? t("body.placeholder");
  }, [placeholder, t]);

  useLayoutEffect(() => {
    previousIdsRef.current = previousIds;
    blocksRef.current = blocks;
  }, [blocks, previousIds]);

  useEffect(() => {
    if (!boxSettingsDialog || boxSettingsBlockExists) {
      return;
    }
    const timeoutId = window.setTimeout(() => setBoxSettingsDialog(null), 0);
    return () => window.clearTimeout(timeoutId);
  }, [boxSettingsBlockExists, boxSettingsDialog, setBoxSettingsDialog]);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  useLayoutEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    clearTextRunSpan();
  }, [historyRevision]);

  useEffect(() => {
    onBoundaryDeleteRef.current = onBoundaryDelete;
  }, [onBoundaryDelete]);

  useEffect(() => {
    onMaterialInsertRef.current = onMaterialInsert;
  }, [onMaterialInsert]);

  useEffect(() => {
    onBoxCommandRef.current = onBoxCommand;
  }, [onBoxCommand]);

  useEffect(() => {
    onProblemCommandRef.current = onProblemCommand;
    onHeadingCommandRef.current = onHeadingCommand;
  }, [onHeadingCommand, onProblemCommand]);

  useEffect(() => {
    onBodyBlockCommandRef.current = onBodyBlockCommand;
  }, [onBodyBlockCommand]);

  useEffect(() => {
    onEditGuardBlockedAttemptRef.current = handleEditGuardBlockedAttempt;
  }, [handleEditGuardBlockedAttempt]);

  useEffect(() => () => {
    if (editGuardNoticeTimeoutRef.current) {
      clearTimeout(editGuardNoticeTimeoutRef.current);
    }
  }, []);

  useEffect(() => {
    slashCommandQueryRef.current = slashCommandQuery;
  }, [slashCommandQuery]);

  useEffect(() => {
    slashCommandCandidatesRef.current = slashCommandCandidates;
    slashCommandActiveIndexRef.current = clampedSlashCommandActiveIndex;
  }, [clampedSlashCommandActiveIndex, slashCommandCandidates]);

	  useEffect(() => {
	    slashCommandActiveIndexRef.current = clampedSlashCommandActiveIndex;
	  }, [clampedSlashCommandActiveIndex]);

  const refreshInlineQueries = useCallback((activeEditor: TiptapEditor) => {
    const nextQuery = getActiveSlashCommandQuery(activeEditor.view);
    setSlashCommandQuery((current) => {
      if (sameSlashCommandQuery(current, nextQuery)) {
        return current;
      }
      setSlashCommandActiveIndex(0);
      return nextQuery;
    });
  }, [setSlashCommandActiveIndex, setSlashCommandQuery]);

  const editor = useEditor({
    editable: documentWritable,
    extensions: [
      // configure stores the callback; the plugin reads it only when rendering decorations.
      // eslint-disable-next-line react-hooks/refs
      SessionPresenceExtension.configure({ session: () => documentSessionRef.current }),
      // プレースホルダ文言は ref。言語切替でエディタを作り直さず、↵ の出し分けだけ追従する。
      // eslint-disable-next-line react-hooks/refs
      FormattingMarksExtension.configure({
        getPlaceholder: () => showPlaceholder ? placeholderRef.current : "",
      }),
      ...createRichTextEngineExtensions({
        blockExtensions: [
          SigmaDocTextAttrs,
          // configure stores this callback; the plugin reads it when applying transactions.
          // eslint-disable-next-line react-hooks/refs
          BoxBlockExtension.configure({ getProblemNumbers }),
          BoxBlockTitleExtension.configure({ readOnly: readOnlyBoxTitle }),
          BoxBlockBodyExtension.configure({ titleReadOnly: readOnlyBoxTitle }),
          LayoutSectionExtension,
          SigmaDocTextIdentity,
        ],
        bodyBlocks: true,
        listMarkerTypography: true,
        mathEnvironment,
        mathFractionSizing,
        orderedListMarkerStyles: true,
        searchHighlight: true,
      }),
      // プレースホルダ文言は ref。言語切替でエディタを作り直さず、装飾の再描画だけで追従する。
      // eslint-disable-next-line react-hooks/refs
      ...(showPlaceholder ? [Placeholder.configure({ placeholder: () => placeholderRef.current })] : []),
      // Widget は SigmaDoc/Tiptap の内容に混ざらず、右上の設定ボタンだけを編集面へ足す。
      // eslint-disable-next-line react-hooks/refs
      CodeBlockActionExtension.configure({
        onOpen: (codeBlockId, button) => openCodeBlockSettingsRef.current(codeBlockId, button),
        getLabel: () => codeBlockActionLabelRef.current,
      }),
      // getSelectedId is a stable callback read by the decoration plugin, not during render.
      // eslint-disable-next-line react-hooks/refs
      SelectedTextBlockExtension.configure({
        getSelectedId: () => {
          const id = selectedIdRef.current;
          return id && previousIdsRef.current.includes(id) ? id : null;
        },
      }),
      // getState is a stable callback read by the decoration plugin, not during render.
      // eslint-disable-next-line react-hooks/refs
      ChangeDecorationExtension.configure({
        getState: () => changeDecorationStateRef.current ?? null,
      }),
      // getBreakGaps is a stable callback that reads the latest gaps when the
      // decoration plugin runs (not during render).
      // eslint-disable-next-line react-hooks/refs
      PageBreakGapExtension.configure({
        getGaps: getBreakGaps,
        getNodeDisplacements,
        getBreakBeforeIds: getPageBreakBeforeIds,
        getBreakBeforeKind: getPageBreakMarkerKind,
        getBreakBeforeKinds: getPageBreakMarkerKinds,
        getBreakBeforeLabel: getPageBreakMarkerLabel,
        getRemoveBreakLabel: getRemovePageBreakMarkerLabel,
        getRemoveBreakButtonLabel: getRemovePageBreakMarkerButtonLabel,
        onRemoveBreak: removePageBreakMarker,
        isReplicaSurface: () => isBoxFragmentReplicaRef.current,
        getBreakBeforeMarkerLayouts: getPageBreakMarkerLayouts,
      }),
      // Column-flow positions are computed outside the editor and read by this
      // decoration plugin without changing the SigmaDoc/Tiptap document.
      // eslint-disable-next-line react-hooks/refs
      ColumnFlowLayoutExtension.configure({
        getLayouts: getColumnFlowBlockLayouts,
        getBoxFragmentSourceLayouts,
        getNodeDisplacements,
      }),
      // This callback runs at transaction time, after source ownership is registered.
      // eslint-disable-next-line react-hooks/refs
      FragmentInputGuardExtension.configure({
        canEdit: () => !isBoxFragmentReplicaRef.current
          || fragmentSessionRef.current?.hasOwner(blocksRef.current[0]?.id ?? "") === true,
      }),
      // 複製かどうかはこの面の一生を通じて変わらないので、プラグインからそのまま読む。
      // eslint-disable-next-line react-hooks/refs
      SpaceAfterPreviewExtension.configure({
        isReplicaSurface: () => isBoxFragmentReplicaRef.current,
      }),
      // These stable callbacks are read by the decoration plugin when it runs,
      // not during React render. Heading labels stay outside editable content.
      // eslint-disable-next-line react-hooks/refs
      HeadingNumberingExtension.configure({
        getNumbers: getHeadingNumbers,
        // The key includes the current column placement so ProseMirror cannot reuse a widget from
        // another segment when a multi-column layout is recalculated.
        getLayoutKey: getHeadingNumberLayoutKey,
      }),
      // These stable callbacks are read by the decoration plugin when it runs,
      // not during React render.
      // eslint-disable-next-line react-hooks/refs
      CommentDecorationExtension.configure({
        getActiveThreadId: () => activeCommentThreadIdRef.current,
        getBlockIds: () => previousIdsRef.current,
        getHighlightedThreadId: () => highlightedCommentThreadIdRef.current,
        getThreads: () => commentThreadsRef.current,
      }),
      ExternalTextRangeHighlightExtension,
      UrlDetectionExtension,
      // getGuards/onBlockedAttempt are stable ref-backed
      // callbacks read by the plugin when it runs (decorations) or a
      // transaction is dispatched (filterTransaction), not during render.
      // eslint-disable-next-line react-hooks/refs
      EditGuardExtension.configure({
        getGuards: () => editGuardsRef.current,
        onBlockedAttempt: (blockId) => onEditGuardBlockedAttemptRef.current(blockId),
      }),
    ],
    content: initialContent,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "text-flow-editor",
      },
      transformPasted: (slice, view) => transferManualBreakToPastedSliceAtOwnerStart(view.state, slice),
      // ProseMirror の既定のスクロール追従を止める。既定は `overflow` を見ずに全ての祖先へ
      // `scrollTop += moveY` を試みるので、断片の viewport を動かして「見えない場所へ
      // スクロールした状態」を作ってしまう。
      handleScrollToSelection: (view) => scrollCaretIntoView(view, () => {
        // この面が見せていない位置へキャレットが動いた (矢印・Home/End・クリック)。
        // 紙面を動かすのではなく、見せている面へ配り直す。PM の更新中なので次のフレームで。
        const address = getTextFlowCaretAddress(
          view.state.doc,
          view.state.selection.head,
          DEFAULT_CARET_AFFINITY,
        );
        if (address) {
          window.requestAnimationFrame(() => focusCaretAddress(address));
        }
      }),
      handleKeyDown: (view, event) => {
        if (handleTextRunSpanKeyDown(event, view.dom)) {
          return true;
        }

        if (isLiteralPasteShortcut(event)) {
          clipboardSession.requestLiteralPaste();
        }

        if (handleSlashCommandQueryKeyDown(
          view,
          event,
          slashCommandQueryRef,
          slashCommandCandidatesRef,
          slashCommandActiveIndexRef,
          setSlashCommandActiveIndex,
          onMaterialInsertRef,
          onBoxCommandRef,
          onProblemCommandRef,
          onBodyBlockCommandRef,
          tiptapEditorRef,
          onHeadingCommandRef,
          setSlashCommandQuery,
        )) {
          return true;
        }

        if (singleBlock && event.key === "Enter") {
          event.preventDefault();
          return true;
        }

        if (
          (event.key === "ArrowUp" || event.key === "ArrowDown")
          && !event.altKey
          && !event.ctrlKey
          && !event.metaKey
          && !event.shiftKey
          && !event.isComposing
          && view.state.selection.empty
        ) {
          const preferredX = verticalNavigationXRef.current
            ?? view.coordsAtPos(view.state.selection.head).left;
          verticalNavigationXRef.current = preferredX;
          // 行き先を**先回りして**決める。1 rAF 後に「位置が変わらなかったら隣へ」では、
          // 断片の複製はブロック全体の doc を持つのでネイティブ移動が必ず成功してしまい、
          // 見えない行へ入ったまま隣の面へ移らない。
          const direction = event.key === "ArrowUp" ? "up" : "down";
          if (moveCaretVertically(view.dom, direction, preferredX)) {
            event.preventDefault();
            return true;
          }
          // 段組みセクション (CSS multicol) の中では、テキストブロックの端を越える上下の
          // ネイティブ移動が信用できない (段を跨ぐ移動で DOM 選択だけ動いて ProseMirror の
          // 選択が古いまま残ることがある)。論理的な隣のテキストブロックへ自前で置き、行の中の
          // 横位置だけ preferredX で選び直す。
          const verticalJump = resolveLayoutSectionArrowJump(view, direction);
          if (verticalJump) {
            applyLayoutSectionArrowJump(view, verticalJump, preferredX);
            event.preventDefault();
            return true;
          }
        } else if (event.key !== "Shift") {
          verticalNavigationXRef.current = null;
        }

        if (
          (event.key === "ArrowLeft" || event.key === "ArrowRight")
          && !event.altKey
          && !event.ctrlKey
          && !event.metaKey
          && !event.shiftKey
          && !event.isComposing
          && view.state.selection.empty
        ) {
          const direction = event.key === "ArrowRight" ? "forward" : "backward";
          // 段組みセクション (CSS multicol) の外→中・中→外は、Chromium のネイティブ移動が
          // 渡れずキャレットが動かない。論理的な隣のテキストブロックへ自前で置く。
          const sectionJump = resolveLayoutSectionArrowJump(view, direction);
          if (sectionJump) {
            view.dispatch(view.state.tr.setSelection(sectionJump).scrollIntoView());
            event.preventDefault();
            return true;
          }
          // 断片境界・doc の端 (ユニット境界・複製の端) は面をまたぐのでルーターが解決する。
          if (moveCaretHorizontally(view.dom, direction)) {
            event.preventDefault();
            return true;
          }
        }

        const manualBreakNavigation = resolveManualBreakBoundaryNavigation(
          view.state,
          event.key === "Backspace" ? "backward" : event.key === "Delete" ? "forward" : null,
          blocksRef.current,
          event,
        );
        if (manualBreakNavigation) {
          view.dispatch(
            view.state.tr.setSelection(
              TextSelection.create(view.state.doc, manualBreakNavigation.position),
            ),
          );
          event.preventDefault();
          return true;
        }

        if (
          (event.key === "Backspace" || event.key === "Delete")
          && deleteManualBreakSpanningSelection(view)
        ) {
          event.preventDefault();
          return true;
        }

        const request = getBoundaryDeleteRequest(view.state, event, blocksRef.current);
        if (!request) {
          return false;
        }

        const handled = onBoundaryDeleteRef.current?.(request) ?? false;
        if (handled) {
          event.preventDefault();
        }
        return handled;
      },
      handleTextInput: (view, _from, _to, text) => (
        handleTextRunSpanTextInput(view.dom, text)
        || deleteManualBreakSpanningSelection(view, text)
      ),
      handleDOMEvents: {
        mousedown: () => {
          verticalNavigationXRef.current = null;
          return false;
        },
        compositionstart: (view) => {
          // 跨ぎ選択への IME 入力。合成テキストはこのエディタのネイティブ選択 (担当分) を
          // IME 自身が置換する (単一エディタと同じ経路 = セッションが切れない) ので、
          // ここでは他ユニットの担当分だけを削除して span を解除する。
          beginTextRunSpanComposition(view.dom);
          return false;
        },
        copy: (view, event) => copyTextFlowSelection(view, event, blocksRef.current),
        cut: (view, event) => cutTextFlowSelection(view, event, blocksRef.current),
      },
      handlePaste: (view, event, slice) => {
        // `view.pasteText()` も同じ handlePaste 群を再入する。literal paste の内側は
        // ProseMirror の plain-text parser と既定 replacement に任せ、Markdown/custom
        // payload 分岐へもう一度入れない。
        const pasteRequest = clipboardSession.beginPaste();
        if (!pasteRequest) {
          return false;
        }
        const { literalPasteRequested } = pasteRequest;
        if (pasteAcrossTextFlowSelection(view, event, slice, literalPasteRequested)) {
          return true;
        }
        // コード・箱のタイトルのように inline しか持てない入れ物への貼り付けは、貼るものを
        // 畳んでその中へ入れる (通常経路へ流すと入れ物が閉じて残りが外へ溢れる)。コードは
        // 書式も Markdown も持ち込まないので、literal paste との違いも無い。
        if (pasteAsInlineContent(view, event, slice)) {
          return true;
        }
        const payload = event.clipboardData ? readEditorClipboardPayload(event.clipboardData) : null;
        if (!literalPasteRequested && payload?.kind === "textAndShapes") {
          return pasteTextAndShapesFromClipboard(view, event, slice, payload);
        }
        // トップレベル本文だけの大量 plain-text paste は PM に数千ノードを dispatch しない。
        // ネストしたリスト・引用・囲み枠は native PM paste で入れ物を保つ。
        const plainText = event.clipboardData?.getData("text/plain") ?? "";
        const hasRichHtml = Boolean(event.clipboardData?.getData("text/html").trim());
        const localClipboardPayload = getLocalEditorClipboardPayload();
        if (
          textRunScopeId === "document"
          && !hasRichHtml
          && shouldUseLargeTextPaste(plainText)
          && isLargeTextPasteSelectionAtTopLevel(view.state)
          && (literalPasteRequested || (
            payload === null
            && !localClipboardPayloadMatchesPlainText(localClipboardPayload, plainText)
          ))
        ) {
          const plan = buildLargeTextPastePlan({
            state: view.state,
            previousBlocks: blocksRef.current,
            pastedBlocks: transferManualBreakToPastedBlocksAtOwnerStart(view.state, literalPasteRequested
              ? largeLiteralTextPasteBlocks(plainText, view.state.selection.$from.marks())
              : largeTextPasteBlocks(plainText, view.state.selection.$from.marks())),
            scopeId: textRunScopeId,
            unitId: textRunUnitId ?? previousIdsRef.current[0] ?? "document",
          });
          if (plan) {
            const blockedBlockId = findLargeTextPasteBlockedBlockId(
              plan,
              blocksRef.current,
              new Set(editGuardsRef.current.keys()),
            );
            if (blockedBlockId) {
              event.preventDefault();
              onEditGuardBlockedAttemptRef.current(blockedBlockId);
              return true;
            }
            event.preventDefault();
            const activeEditor = tiptapEditorRef.current;
            const beforeSelection = activeEditor
              ? getTextFlowSelectionBookmark(activeEditor, verticalNavigationXRef.current)
              : null;
            beginTextFlowDocumentChange(beforeSelection);
            crossEditorSyncRef.current = { selection: plan.selection ?? null };
            commitLargeTextPastePlan(
              plan,
              `${historyGroupScope}:large-paste:${createId("paste")}`,
              onChangeRef.current,
              (selection) => {
                // 跨ぎ選択置換と同じ caret router へ、commit と一緒に復元を予約する。
                // 挿入末尾が新規 unit の場合は今の面では解決できないが、予約は
                // registerCaretSurface が mount 時に消化する。React commit 直後の
                // microtask と次フレームでも再試行し、DOM focus と scrollIntoView を
                // ネイティブ paste 相当のタイミングで完了させる。
                requestCaret(selection);
                window.queueMicrotask(() => flushPendingCaret());
                window.requestAnimationFrame(() => flushPendingCaret());
              },
            );
            if (plan.focusBlockId) {
              selectedIdRef.current = plan.focusBlockId;
              onSelectRef.current(plan.focusBlockId);
            }
            return true;
          }
        }
        if (literalPasteRequested) {
          return clipboardSession.pasteLiteral(view, event);
        }
        return pasteTextFlowBlocksFromClipboard(view, event, slice, (blockId) => {
          selectedIdRef.current = blockId;
          onSelectRef.current(blockId);
        }, refreshSelectedTextBlock);
      },
    },
    // Toolbar state rides on onTransaction, not on selection/doc updates: toggling a
    // mark at a collapsed caret only sets storedMarks, which changes neither the
    // selection nor the doc, so B/I/U would otherwise stay stale until the next
    // keystroke. The isFocused guard keeps a background editor's programmatic
    // transactions from clobbering the focused editor's toolbar state.
    onTransaction: ({ editor: activeEditor, transaction }) => {
      if (transaction.docChanged) {
        const dom = readMountedEditorDom(activeEditor);
        if (dom) dom.dataset.flowMeasureRevision = String(Number(dom.dataset.flowMeasureRevision ?? 0) + 1);
        selectionBeforeTransactionRef.current = getTextFlowSelectionBookmarkBeforeTransaction(
          transaction,
          verticalNavigationXRef.current,
        );
      }
      if (activeEditor.isFocused) {
        dispatchDocumentTextFormatState(activeEditor);
      }
    },
    onSelectionUpdate: ({ editor: activeEditor }) => {
      refreshInlineQueries(activeEditor);
      const selectedBlockId = getSelectedTextBlockId(activeEditor);
      const selectionBookmark = getTextFlowSelectionBookmark(activeEditor, verticalNavigationXRef.current);
      if (selectionBookmark && activeEditor.isFocused) {
        publishTextFlowSelectionBookmark(selectionBookmark);
        documentSessionRef.current?.setSelection?.(selectionBookmark);
      }
      if (selectedBlockId) {
        selectedIdRef.current = selectedBlockId;
        onSelect(selectedBlockId);
        refreshSelectedTextBlock(activeEditor.view);
        const { from, to, empty } = activeEditor.state.selection;
        if (!empty) {
          lastTextSelectionRef.current = { blockId: selectedBlockId, from, to };
        }
      }
    },
    onFocus: ({ editor: activeEditor }) => {
      // 跨ぎ選択のグループ外エディタ (ヘッダー/フッター・box 継続 fragment・素材ダイアログ)
      // に焦点が移ったら span を解除する。残すと本文に選択帯が出たままになる。
      clearTextRunSpanOnOutsideFocus(activeEditor);
      clearBoxFragmentSelectionOnOutsideFocus(activeEditor);
      dispatchDocumentTextFormatState(activeEditor);
      refreshInlineQueries(activeEditor);
      const selectedBlockId = getSelectedTextBlockId(activeEditor);
      const selectionBookmark = getTextFlowSelectionBookmark(activeEditor, verticalNavigationXRef.current);
      if (selectionBookmark) {
        publishTextFlowSelectionBookmark(selectionBookmark);
        documentSessionRef.current?.setSelection?.(selectionBookmark);
      }
      if (selectedBlockId) {
        selectedIdRef.current = selectedBlockId;
        onSelect(selectedBlockId);
        refreshSelectedTextBlock(activeEditor.view);
      }
      onFocusChange?.(
        true,
        getEditorTextBlockIds(activeEditor),
        selectedBlockId ?? null,
        selectionBookmark,
      );
    },
    onBlur: ({ editor: activeEditor }) => {
      window.setTimeout(() => {
        if (!activeEditor.isDestroyed && !activeEditor.isFocused) {
          setSlashCommandQuery(null);
        }
      }, 120);
      onFocusChange?.(false, getEditorTextBlockIds(activeEditor));
    },
    onUpdate: ({ editor: activeEditor, transaction }) => measurePerformance("TextFlowEditor.onUpdate", () => {
      clearBoxFragmentSelection();
      // このエディタ自身の編集が始まった時点で、未消化の跨ぎ置換マークは古い (置換がこの
      // ユニットの内容を変えなかったときだけ残る)。放置すると、この編集の blocksSyncKey
      // 変化でタイピング途中の setContent + 古い選択復元が走り、キャレットが飛ぶ。
      //
      // ただし混在ペースト / 混在カットのコアレスキーだけは消す前に拾う。跨ぎ置換は
      // `onUpdate` を通らずに本文を書くので、再チャンクが起こすこの `onUpdate` に
      // キーが乗らないと、本文書き込みと 250ms 後の図形保存の**間に別エントリが挟まる**。
      const crossEditorClipboardGroup = crossEditorSyncRef.current?.historyGroup ?? null;
      crossEditorSyncRef.current = null;
      refreshInlineQueries(activeEditor);
      const nextBlocks = measurePerformance(
        "TextFlowEditor.tiptapToTextFlow",
        () => tiptapToTextFlow(activeEditor.getJSON() as TiptapDoc, blocksRef.current),
      );
      const normalizedBlocks = singleBlock ? nextBlocks.slice(0, 1) : nextBlocks;
      const measuredDom = readMountedEditorDom(activeEditor);
      if (measuredDom) acknowledgeTextFlowContent(measuredDom, getTextFlowBlocksSyncKey(normalizedBlocks));
      const activeBlockId = getSelectedTextBlockId(activeEditor) ?? getLastTextFlowBlockId(normalizedBlocks);
      const selectionBookmark = getTextFlowSelectionBookmark(activeEditor, verticalNavigationXRef.current);
      if (activeBlockId) {
        selectedIdRef.current = activeBlockId;
        onSelect(activeBlockId);
        refreshSelectedTextBlock(activeEditor.view);
      }
      const normalizedBlockIds = getTextFlowBlockIds(normalizedBlocks);
      onFocusChange?.(true, normalizedBlockIds, activeBlockId, selectionBookmark);
      beginTextFlowDocumentChange(selectionBeforeTransactionRef.current);
      const historyGrouping = groupTextFlowTransaction(historyGroupingRef.current, transaction);
      historyGroupingRef.current = historyGrouping.state;
      // 跨ぎ選択への IME 合成中は、compositionstart で流した他ユニット削除・compositionend
      // 後の境界結合と同じグループに載せる (undo 1 回で IME 置換全体が戻る)。
      const spanCompositionGroup = getTextRunSpanCompositionHistoryGroup(activeEditor);
      // 混在ペースト / 混在カットは、図形側と同じキーを強制する (undo 1 回で両方戻す)。
      // カットの判別子に PM 本体が付ける `uiEvent === "cut"` を使うのが肝 —— 切り取りの
      // 削除トランザクションだけを正確に掴める。
      const forcedClipboardGroup = clipboardSession.historyGroupFor(
        transaction,
        historyGrouping.group,
        crossEditorClipboardGroup,
      );
      onChange(previousIdsRef.current, normalizedBlocks, activeBlockId, {
        // 合成グループを先に見る。跨ぎ選択の IME 置換が混在操作と同じグルーピング区間で
        // 始まると、このユニットだけクリップボードのキーになって **1 回の IME 置換が
        // 2 エントリに割れる** (span の他ユニットは合成グループのまま)。合成のほうが強い括り。
        historyGroup: spanCompositionGroup
          ?? forcedClipboardGroup
          ?? `${historyGroupScope}:${historyGrouping.group}`,
        selection: selectionBookmark,
      });
      if (selectionBookmark) {
        publishTextFlowSelectionBookmark(selectionBookmark);
      }
      if (syncFocusedContent && !areTextFlowBlockIdSequencesEqual(normalizedBlockIds, previousIdsRef.current)) {
        const ownedBlocks = normalizedBlocks.filter((block) => getTextFlowBlockIds([block]).some((id) => previousIdsRef.current.includes(id)));
        setTextFlowContentPreservingSelection(
          activeEditor,
          ownedBlocks.length > 0 ? ownedBlocks : blocksRef.current,
        );
      }
    }),
  // A non-empty dependency list keeps Tiptap from calling editor.setOptions()
  // after every React render. That passive-effect update can remount React node
  // views while React is already committing an approved SigmaDoc, which is the
  // exact lifecycle race that left inline math visually stale until a tab
  // remount. Runtime callbacks still read Tiptap's latest options, while the
  // editor is recreated only when extension/editor-prop configuration changes.
  }, [mathEnvironment, mathFractionSizing, readOnlyBoxTitle, showPlaceholder, singleBlock]);

  useLayoutEffect(() => {
    if (!editor || !documentSession) return;
    sessionProjectionEditors.add(editor);
    return () => { sessionProjectionEditors.delete(editor); };
  }, [editor, documentSession]);

  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const canvas = readMountedEditorDom(editor)?.closest<HTMLElement>(".page-canvas");
    if (!canvas) return;
    const session = getFragmentEditSession(canvas);
    fragmentSessionRef.current = session;
    const unregister = boxFragmentReplicaId ? undefined : session.register({
      owns: (id) => blocksRef.current.some((block) => block.id === id),
      apply: ({ blockId, blocks: replacement, activeBlockId, context }) => {
        if (editor.isDestroyed) return;
        const liveBlocks = tiptapToTextFlow(editor.getJSON() as TiptapDoc, blocksRef.current);
        const index = liveBlocks.findIndex((block) => block.id === blockId);
        if (index < 0) return;
        const nextBlocks = [...liveBlocks];
        nextBlocks.splice(index, 1, ...replacement);
        setTextFlowContentPreservingSelection(editor, nextBlocks);
        onChangeRef.current(previousIdsRef.current, nextBlocks, activeBlockId, context);
      },
    });
    return () => {
      unregister?.();
      if (fragmentSessionRef.current === session) fragmentSessionRef.current = null;
    };
  }, [boxFragmentReplicaId, editor]);

  useEffect(() => {
    if (!editor) {
      return;
    }
    const label = t("codeBlock.settings");
    const dom = readMountedEditorDom(editor);
    if (!dom) {
      return;
    }
    dom.querySelectorAll<HTMLButtonElement>("[data-code-block-action-button='true']")
      .forEach((button) => {
        button.title = label;
        button.setAttribute("aria-label", label);
      });
  }, [editor, locale, t]);

  /**
   * 装飾の再描画合図をまとめる。
   *
   * 種類ごとに transaction を打つと、その回数だけ全プラグインの装飾が計算し直される。合図は
   * meta なので 1 本の transaction に何種類でも載る。2 系統あるのは意味が違うため:
   *
   * - **遅延** (`setTimeout(0)`): ProseMirror の update 中に dispatch しないための逃がし。
   *   コメント・選択行・編集ガードはこちら (元からこの形だった)。
   * - **同期**: 余白や段組みのように、この commit の DOM を親 (`PageCanvasEditor`) が
   *   そのまま測りにくる合図。1 tick でも遅れるとページ割りが古いまま測られる。
   */
  const pendingDeferredRefreshRef = useRef<Set<TextFlowDecorationRefreshKind>>(new Set());
  const pendingSyncRefreshRef = useRef<Set<TextFlowDecorationRefreshKind>>(new Set());
  const deferredRefreshTimeoutRef = useRef<number | null>(null);

  const scheduleDecorationRefresh = useCallback((kind: TextFlowDecorationRefreshKind) => {
    pendingDeferredRefreshRef.current.add(kind);
    if (deferredRefreshTimeoutRef.current !== null) {
      return;
    }
    deferredRefreshTimeoutRef.current = window.setTimeout(() => {
      deferredRefreshTimeoutRef.current = null;
      // 溜めた種類を捨てるのは「打てた」ときだけ。editor が作り直された tick に捨てると、
      // 合図が飛ばないまま消える (装飾が古いまま残る)。
      if (!editor || editor.isDestroyed) {
        return;
      }
      const kinds = pendingDeferredRefreshRef.current;
      pendingDeferredRefreshRef.current = new Set();
      dispatchTextFlowDecorationRefresh(editor.view, kinds);
    }, 0);
  }, [editor]);

  // `/` から Tiptap のコマンドを呼ぶための ref。`useEditor` の設定の中では `editor` を
  // まだ参照できないので、作られた後にここで持ち回りへ渡す。
  useEffect(() => {
    editor?.setEditable(documentWritable, false);
  }, [documentWritable, editor]);

  useEffect(() => {
    if (!editor || !documentSession?.subscribePresence) return;
    return documentSession.subscribePresence(() => {
      if (!editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta(sessionPresenceKey, true).setMeta("addToHistory", false));
    });
  }, [documentSession, editor]);

  useEffect(() => {
    tiptapEditorRef.current = editor ?? null;
    return () => {
      tiptapEditorRef.current = null;
    };
  }, [editor]);

  const requestSyncDecorationRefresh = useCallback((kind: TextFlowDecorationRefreshKind) => {
    pendingSyncRefreshRef.current.add(kind);
  }, []);

  useEffect(() => () => {
    if (deferredRefreshTimeoutRef.current !== null) {
      window.clearTimeout(deferredRefreshTimeoutRef.current);
      deferredRefreshTimeoutRef.current = null;
    }
  }, []);

  // 装飾プラグインは走るたびにこの ref から最新のスレッドを読むので、代入は毎レンダー行う。
  useEffect(() => {
    commentThreadsRef.current = commentThreads;
    activeCommentThreadIdRef.current = activeCommentThreadId;
    highlightedCommentThreadIdRef.current = highlightedCommentThreadId;
  });

  // 再描画の合図 (transaction) は、装飾の見た目が変わりうる時だけ。スレッド配列は文書が
  // 作り直されるたびに新しくなるので、識別子で判定すると打鍵ごとにユニット数だけ dispatch が出る。
  //
  // 鍵は**この編集器が描くコメントだけ**から作る。装飾はこの編集器が持つブロックに掛かるものしか
  // 描かないので、よそのブロックのスレッドが増減しても見た目は変わらない。開いている/強調中の
  // スレッドは画面全体で 1 つなので、素直に deps へ入れると全ユニットが合図を打つ。
  // (本文ユニットには親がユニット分だけを渡すが、問題エリアと段組みセクションには文書全体の
  //  一覧が渡るので、絞り込みはここで行う必要がある。)
  const ownCommentDecorationKey = useMemo(() => {
    const blockIds = new Set(previousIds);
    const ownThreads = commentThreads.filter((thread) => commentThreadTouchesBlocks(thread, blockIds));
    const ownThreadIds = new Set(ownThreads.map((thread) => thread.id));
    const active = activeCommentThreadId && ownThreadIds.has(activeCommentThreadId) ? activeCommentThreadId : "";
    const highlighted = highlightedCommentThreadId && ownThreadIds.has(highlightedCommentThreadId)
      ? highlightedCommentThreadId
      : "";
    return `${getCommentThreadsSyncKey(ownThreads)}\u0000${active}\u0000${highlighted}`;
  }, [activeCommentThreadId, commentThreads, highlightedCommentThreadId, previousIds]);

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    scheduleDecorationRefresh("comments");
  }, [editor, ownCommentDecorationKey, scheduleDecorationRefresh]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
    if (!editor || editor.isDestroyed) {
      return;
    }
    // 選択中の行の装飾は「その行がこの編集器にあるとき」だけ出る (`getSelectedId` と同じ判定)。
    // よその編集器で選択が動いただけなら、この編集器の見た目は変わらない = 合図も要らない。
    // 本文 1500 段落では矢印キー 1 回で 37 ユニット分の transaction が飛んでいた。
    const owned = selectedId && previousIds.includes(selectedId) ? selectedId : null;
    if (owned === ownedSelectedIdRef.current) {
      return;
    }
    ownedSelectedIdRef.current = owned;
    scheduleDecorationRefresh("selected");
  }, [editor, previousIds, scheduleDecorationRefresh, selectedId]);

  // 「本文と図形をまとめて選択」: キャレットを持っている編集器だけが応える。範囲が無ければ
  // まず全選択し、選択が覆ったブロック id をシェルへ返す (図形選択への変換はシェルの仕事)。
  //
  // 本文は改ページ・チャンク境界・問題エリア・段組ごとに別の Tiptap インスタンスなので、
  // この編集器の `selectAll` / `state.selection` だけを見ると「キャレットのあるページ分」
  // しか拾えない。全選択は跨ぎ選択 (⌘A と同じ経路) へ広げ、ブロック id も全ユニットから集める。
  useEffect(() => {
    const handleSelectWithShapes = () => {
      if (!editor || editor.isDestroyed || !editor.isFocused) {
        return;
      }
      const wholeDocument = editor.state.selection.empty;
      if (wholeDocument && !selectEntireTextRun(editor)) {
        // 分割の無い文書 (本文エディタが 1 つ) はこの編集器の全選択がそのまま文書全体。
        editor.commands.selectAll();
      }
      const blockIds = isMultiEditorTextRunSpan()
        ? collectTextRunSpanBlockIds()
        : collectSelectedBlockIds(editor.state);
      if (blockIds.length === 0) {
        return;
      }
      const source = readMountedEditorDom(editor);
      if (!source) {
        return;
      }
      requestBodySelectionShapes({ blockIds, source, wholeDocument });
    };

    window.addEventListener(SELECT_BODY_WITH_SHAPES_EVENT, handleSelectWithShapes);
    return () => window.removeEventListener(SELECT_BODY_WITH_SHAPES_EVENT, handleSelectWithShapes);
  }, [editor]);

  useEffect(() => {
    changeDecorationStateRef.current = changeDecorationState;
    if (editor && !editor.isDestroyed) {
      requestSyncDecorationRefresh("changes");
    }
  }, [changeDecorationState, editor, requestSyncDecorationRefresh]);

  // ガード表も同じ: 参照の更新は毎レンダー、再描画の合図はガードの中身が変わった時だけ。
  useEffect(() => {
    editGuardsRef.current = editGuardsByBlockId;
  });

  useEffect(() => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    scheduleDecorationRefresh("guards");
  }, [editGuardsKey, editor, scheduleDecorationRefresh]);

  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const root = readMountedEditorDom(editor);
    if (root) acknowledgeTextFlowContent(root, mountContentKeyRef.current ?? getTextFlowBlocksSyncKey(blocksRef.current));
  }, [editor]);

  /**
   * Undo/Redo swaps the content **synchronously, in the layout phase**.
   *
   * `PageCanvasEditor` reacts to a `historyRevision` change with a synchronous `recompute()` in
   * its own layout effect, so that the page never paints an un-paginated frame. React runs layout
   * effects child-first, so doing the swap here means that measurement sees the restored DOM.
   * While this ran on a `setTimeout(0)` the order was inverted: the parent measured the *pre-undo*
   * ProseMirror DOM and fed those heights into the box clip (`--text-flow-box-fragment-visible-height`)
   * and the fragment preview's `minHeight`, which is what made the frame swallow the body for a
   * frame or two.
   *
   * `blocks` is read directly from this render's props so the restore matches its revision.
   *
   * `setTextFlowContentPreservingSelection` uses `setContent(..., { emitUpdate: false })`, so this
   * cannot loop back through `onUpdate` → `onReplaceTextFlow` and push the undo result onto the
   * history as a fresh change.
   */
  useLayoutEffect(() => {
    if (!editor || previousHistoryRevisionRef.current === historyRevision) {
      return;
    }

    previousHistoryRevisionRef.current = historyRevision;
    historyGroupingRef.current = createTextFlowHistoryGroupingState();
    // 履歴復元はこの下で内容を丸ごと入れ直すので、未消化の跨ぎ置換マークはここで役目を
    // 終える。残すと復元後の最初の同期で古い選択復元が走る。
    crossEditorSyncRef.current = null;
    // クリップボードのコアレスキーも捨てる。一致条件は**一意でない sequence 番号**なので、
    // 残したまま undo でカウンタが 0 に戻ると、番号が同じ値まで登り直したところで
    // 無関係な編集が古い mixed_clipboard_history_* キーで刻印される。
    clipboardSession.resetHistory();
    if (!editor.isDestroyed) {
      setTextFlowContentPreservingSelection(editor, blocks);
      // Tell the passive sync below that this render's content is already in the editor, so it
      // does not apply the very same blocks a second time (once per unit, after paint).
      syncedContentKeyRef.current = blocksSyncKey;
    }
    // `blocks` is intentionally not a dependency: the restore is keyed on the revision, and the
    // blocks that belong to it are whatever this render was given.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocksSyncKey, editor, historyRevision]);

  // External source/projection updates must land before PageCanvas measures.
  // The active view and IME keep their selection/composition state; the source
  // owner is updated synchronously by FragmentEditSession on continuation input.
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    if ((!documentSession && editor.isFocused) || editor.view.composing || crossEditorSyncRef.current) {
      return;
    }
    if (!shouldSyncExternalTextFlowContent(
      syncedContentKeyRef.current,
      mountContentKeyRef.current,
      blocksSyncKey,
    )) {
      return;
    }
    if (documentSession) applySharedTextFlowProjection(editor, blocks);
    else setTextFlowContentPreservingSelection(editor, blocks);
    syncedContentKeyRef.current = blocksSyncKey;
    // `blocks` はこのレンダーが渡されたものを使い、同期対象のリビジョンを揃える。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocksSyncKey, editor, documentSession]);

  // Manual breaks split one editing surface into two. The old surface must
  // release blocks it no longer owns before the parent measures or the next
  // keystroke arrives; a passive timer leaves duplicate editable owners behind.
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed || editor.view.composing || crossEditorSyncRef.current) {
      return;
    }
    if (areTextFlowBlockIdSequencesEqual(getEditorTextBlockIds(editor), getTextFlowBlockIds(blocks))) {
      return;
    }
    setTextFlowContentPreservingSelection(editor, blocks);
    syncedContentKeyRef.current = blocksSyncKey;
    // The key includes all blocks assigned to this render's editing surface.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocksSyncKey, editor]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    // History restores are handled synchronously by the layout effect above, which also records
    // the key it applied — so this passive path only ever sees ordinary external updates, and
    // never re-applies content that is already in the editor (mount included).
    if (!shouldSyncExternalTextFlowContent(
      syncedContentKeyRef.current,
      mountContentKeyRef.current,
      blocksSyncKey,
    )) {
      return;
    }
    // 以降このエディタの内容はマウント時のものではない (下でこのレンダーの blocks を入れるか、
    // 入れないと決めた場合でも、そう判断できるのはこの 1 回だけ)。
    mountContentKeyRef.current = null;

    const crossEditorSync = crossEditorSyncRef.current;
    crossEditorSyncRef.current = null;
    const editorBlockIds = getEditorTextBlockIds(editor);
    const nextBlockIds = getTextFlowBlockIds(blocksRef.current);
    // ブロック id 列が同じでも段落種別が変わっていれば描き直す。段落スタイルの変更は id を
    // 動かさないので、これが無いと SigmaDoc だけ見出しになって紙面は `<p>` のまま残る。
    if (
      !crossEditorSync
      && editor.isFocused
      && areTextFlowBlockIdSequencesEqual(editorBlockIds, nextBlockIds)
      && !hasTextFlowBlockKindChange(getEditorTextBlockKinds(editor), blocksRef.current)
      && !hasTextFlowBlockAttributeChange(getEditorTextBlockAttributes(editor), blocksRef.current)
    ) {
      return;
    }

    // IME 合成中の setContent は合成セッションを切り、確定前の文字を失わせる (跨ぎ選択への
    // IME 入力で、他ユニットの削除が再チャンクを起こしこのエディタの担当ブロック列が変わる
    // 場合が典型)。合成が終わって PM が DOM 差分を取り込んだ後に同じ同期をやり直す。
    let compositionRetry: (() => void) | null = null;
    let retryTimeoutId: number | null = null;
    const applySync = (apply: () => void): void => {
      if (editor.view.composing) {
        compositionRetry = () => {
          retryTimeoutId = window.setTimeout(() => {
            if (!editor.isDestroyed && !editor.view.composing) {
              apply();
            }
          }, 0);
        };
        const root = readMountedEditorDom(editor);
        root?.addEventListener("compositionend", compositionRetry, { once: true });
        return;
      }
      apply();
    };

    if (editor.isFocused && (syncFocusedContent || crossEditorSync)) {
      applySync(() => {
        setTextFlowContentPreservingSelection(editor, blocksRef.current);
        if (crossEditorSync?.selection) {
          const restored = applyTextFlowSelectionBookmark(editor, crossEditorSync.selection);
          if (restored.applied) {
            focusTextFlowSurface(editor, restored.activeMarks);
          }
        }
      });
      return () => {
        if (compositionRetry) {
          readMountedEditorDom(editor)?.removeEventListener("compositionend", compositionRetry);
        }
        if (retryTimeoutId !== null) {
          window.clearTimeout(retryTimeoutId);
        }
      };
    }

    const timeoutId = window.setTimeout(() => {
      const shouldSyncFocusedEditor =
        editor.isFocused &&
        (shouldSyncFocusedTextFlowContent(getEditorTextBlockIds(editor), blocksRef.current)
          || hasTextFlowBlockKindChange(getEditorTextBlockKinds(editor), blocksRef.current)
          || hasTextFlowBlockAttributeChange(getEditorTextBlockAttributes(editor), blocksRef.current));
      if (!editor.isDestroyed && (!editor.isFocused || shouldSyncFocusedEditor)) {
        applySync(() => {
          setTextFlowContentPreservingSelection(editor, blocksRef.current);
          if (crossEditorSync?.selection) {
            const restored = applyTextFlowSelectionBookmark(editor, crossEditorSync.selection);
            if (restored.applied) {
              focusTextFlowSurface(editor, restored.activeMarks);
            }
          }
        });
      }
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
      if (compositionRetry) {
        readMountedEditorDom(editor)?.removeEventListener("compositionend", compositionRetry);
      }
      if (retryTimeoutId !== null) {
        window.clearTimeout(retryTimeoutId);
      }
    };
  }, [blocksSyncKey, editor, syncFocusedContent]);

  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const root = readMountedEditorDom(editor);
    if (root) expectTextFlowContent(root, blocksSyncKey);
  }, [blocksSyncKey, editor]);

  const breakGapsKey = useMemo(() => getTextFlowBreakGapSyncKey(breakGaps), [breakGaps]);
  const paginationBeforeIdsKey = useMemo(() => (paginationBeforeIds ?? []).join("\u0000"), [paginationBeforeIds]);
  const paginationMarkerKindsKey = useMemo(
    () => Object.entries(paginationMarkerKinds ?? {}).sort(([a], [b]) => a.localeCompare(b)).map(([id, kind]) => `${id}:${kind}`).join("\u0000"),
    [paginationMarkerKinds],
  );
  const paginationMarkerLayoutsKey = useMemo(() => getTextFlowColumnLayoutsSyncKey(paginationMarkerLayouts), [paginationMarkerLayouts]);
  useLayoutEffect(() => {
    breakGapsRef.current = breakGaps ?? {};
    paginationBeforeIdsRef.current = paginationBeforeIds ?? [];
    paginationMarkerKindRef.current = resolvedPaginationMarkerKind;
    paginationMarkerKindsRef.current = paginationMarkerKinds ?? {};
    paginationMarkerLayoutsRef.current = paginationMarkerLayouts ?? {};
    if (editor && !editor.isDestroyed) {
      // Page geometry and its DOM spacers must be committed before the same paint.
      // A passive refresh briefly paints the new text with the previous page gaps.
      dispatchTextFlowDecorationRefresh(editor.view, new Set(["gaps"]));
    }
    // `locale` を依存に入れるのは、言語を切り替えたときに印のラベルを描き直させるため。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, breakGapsKey, locale, paginationBeforeIdsKey, paginationMarkerKind, paginationMarkerKindsKey, paginationMarkerLayoutsKey]);

  const columnFlowBlockLayoutsKey = useMemo(() => getTextFlowColumnLayoutsSyncKey(columnFlowBlockLayouts), [columnFlowBlockLayouts]);
  const boxFragmentSourceLayoutsKey = useMemo(() => getTextFlowFragmentLayoutsSyncKey(boxFragmentSourceLayouts), [boxFragmentSourceLayouts]);
  useLayoutEffect(() => {
    problemNumbersRef.current = problemNumbers;
    if (editor && !editor.isDestroyed) {
      editor.view.dispatch(editor.state.tr.setMeta(nestedProblemLayoutKey, true).setMeta("addToHistory", false));
    }
  }, [editor, problemNumbers]);

  const headingNumbersKey = useMemo(
    () => Object.entries(headingNumbers).sort(([a], [b]) => a.localeCompare(b)).map(([id, number]) => `${id}:${number}`).join("\u0000"),
    [headingNumbers],
  );
  const nodeDisplacementsKey = useMemo(
    () => (nodeDisplacements ? Object.entries(nodeDisplacements).map(([id, value]) => `${id}:${value.dx}:${value.dy}`).join("|") : ""),
    [nodeDisplacements],
  );
  // ページ割りの変位・断片のクリップは、同じコミットのうちに描く。受け身の effect にすると
  // ユニットの外枠だけが先に動いて、中のブロックが 1 フレーム遅れる。
  useLayoutEffect(() => {
    columnFlowBlockLayoutsRef.current = columnFlowBlockLayouts ?? {};
    boxFragmentSourceLayoutsRef.current = boxFragmentSourceLayouts ?? {};
    nodeDisplacementsRef.current = nodeDisplacements;
    if (editor && !editor.isDestroyed) {
      dispatchTextFlowDecorationRefresh(editor.view, new Set(["columnFlow", "gaps"]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, columnFlowBlockLayoutsKey, boxFragmentSourceLayoutsKey, nodeDisplacementsKey]);
  useEffect(() => {
    headingNumbersRef.current = headingNumbers;
    if (editor && !editor.isDestroyed) {
      requestSyncDecorationRefresh("headingNumbers");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor, headingNumbersKey, requestSyncDecorationRefresh]);

  // ドラッグ中の下余白プレビュー。`requestSyncDecorationRefresh` は「この commit の最後に打つ」
  // 予約なので、React の外 (pointerdown / pointerup) から来るこの合図はその場で打つ。
  //
  // 合図が来るのは 1 ドラッグにつき 2 回だけ (掴んだ瞬間と離した瞬間)。移動量は custom
  // property で運ぶので、pointermove ごとにここへ来ることはない。
  //
  // それでも **印を付ける面だけ** に絞る。ストアは全 `TextFlowEditor` が共有するので、
  // 素通りさせると掴むたびに紙面上のすべてのエディタで装飾プラグインが走り直す。
  const drawsSpaceAfterPreviewRef = useRef(false);
  useEffect(() => subscribeBlockSpaceAfterPreview(() => {
    // 複製の面は印を描かない (装飾側で捨てる) ので、合図も要らない。
    if (!editor || editor.isDestroyed || isBoxFragmentReplicaRef.current) {
      return;
    }
    const followerIds = getBlockSpaceAfterPreview()?.followerBlockIds ?? [];
    const draws = followerIds.some((id) => previousIdsRef.current.includes(id));
    // 直前まで描いていた面は「外す」ために 1 回だけ打つ必要がある。
    if (!draws && !drawsSpaceAfterPreviewRef.current) {
      return;
    }
    drawsSpaceAfterPreviewRef.current = draws;
    dispatchTextFlowDecorationRefresh(editor.view, SPACE_AFTER_REFRESH_KINDS);
  }), [editor]);

  // この commit で要求された同期の合図を 1 本の transaction にまとめて打つ。上の effect が
  // それぞれ打つと、余白と段組みが同時に変わったとき (ページ割り確定の瞬間がまさにそれ) に
  // 2 本になる。deps 無しなのは「要求があった commit の最後」に必ず走らせるため。
  useEffect(() => {
    const kinds = pendingSyncRefreshRef.current;
    if (kinds.size === 0 || !editor || editor.isDestroyed) {
      return;
    }
    pendingSyncRefreshRef.current = new Set();
    dispatchTextFlowDecorationRefresh(editor.view, kinds);
    // 段組みの配置が今この dispatch で付いた。配置待ちで保留していたキャレット追従を
    // ここでやり直す (確定前の座標で動くと紙面が文書先頭へ飛ぶ — 保留の理由はそちら)。
    flushDeferredCaretScroll(editor.view);
  });

  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    const root = readMountedEditorDom(editor);
    if (!root) {
      return;
    }

    return observeCornerBoxReferenceHeights(root, EDITOR_CORNERBOX_SELECTOR);
  }, [editor]);

  const fragmentedBoxIdsKey = useMemo(() => [
    ...Object.keys(boxFragmentSourceLayouts ?? {}),
    ...(boxFragmentReplicaId ? [boxFragmentReplicaId] : []),
  ].sort().join("\u0000"), [boxFragmentReplicaId, boxFragmentSourceLayouts]);

  /**
   * 面の可変情報。**登録には混ぜない** — 混ぜると担当ブロック列が変わるたびに登録と解除が
   * 走り、その解除が跨ぎ選択と IME 合成の予約を消す (罠 1)。
   */
  const caretFacetsRef = useRef<CaretSurfaceFacets | null>(null);

  // 登録より **前** に宣言する: マウント時はこの effect が先に走り、下の登録 effect が
  // ここで組み立てたファセットをそのまま使う。
  //
  // `useLayoutEffect` なのは順序のため。React は子の layout effect を親より先に走らせるので、
  // 親 (`PageCanvasEditor`) が `setFragmentTables` を撃つ時点で、面のファセットは必ず今の
  // レンダーの値になっている。passive effect にすると 1 フレーム古い値で配送先が決まる。
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    const unitId = textRunUnitId ?? previousIds[0] ?? textRunGroupId ?? "";
    const boxIds = fragmentedBoxIdsKey ? fragmentedBoxIdsKey.split("\u0000") : [];
    const sourceLayouts = boxFragmentSourceLayouts ?? {};
    const facets: CaretSurfaceFacets = {
      boxIds,
      // 1 つのユニットに分割されたブロックが複数あることがある。面ごとに 1 つへ潰すと、
      // 別のブロックの表で断片番号を読んで無関係な面へ配送してしまう。
      fragmentBlockIdFor: (blockId) => resolveFragmentBlockId(
        blocksRef.current,
        sourceLayouts,
        boxFragmentReplicaId,
        blockId,
      ),
      // 文書順タプル。複製は [持ち主のユニットの順番, 断片番号] で、正本 [順番] の直後に並ぶ。
      // 順番を持たない面 (素材ダイアログ・ヘッダ/フッタ) は空配列にして行き先にしない。
      // 複製は `textRunGroupId` を持たない (跨ぎ選択のグループには入らない) ので、
      // グループの有無ではなく `boxFragmentReplicaId` で判定する。
      order: boxFragmentReplicaId
        ? [textRunOrder, boxFragmentReplicaIndex ?? 0]
        : (textRunGroupId ? [textRunOrder] : []),
      surface: boxFragmentReplicaId
        ? {
          kind: "fragmentReplica",
          blockId: boxFragmentReplicaId,
          fragmentIndex: boxFragmentReplicaIndex ?? 0,
        }
        : { kind: "unit", unitId },
      ownsBlock: (blockId) => blocksRef.current.some(
        (block) => bodyTextFlowBlockContainsId(block, blockId),
      ),
      addressAt: (position) => getTextFlowCaretAddress(
        editor.state.doc,
        position,
        DEFAULT_CARET_AFFINITY,
      ),
      posFor: (address) => getTextFlowSelectionPosition(editor, address),
      localYFor: (address, containerBlockId) => getTextFlowLocalY(editor, address, containerBlockId),
      caretLineAdvance: (containerBlockId, direction) => {
        try {
          const container = getTextFlowBlockElement(editor, containerBlockId);
          const scale = container
            ? getCaretZoomScale(container, container.getBoundingClientRect())
            : 1;
          const caret = editor.view.coordsAtPos(editor.state.selection.head);
          const fallback = (caret.bottom - caret.top) / scale;
          // ブロックの中の折り返しなら、次の行はキャレット矩形のすぐ下。
          if (!editor.view.endOfTextblock(direction)) {
            return fallback > 0 ? fallback : null;
          }
          // ブロックの端。次のブロックの先頭行を**実測**する (段落間の余白が入るので、
          // キャレット矩形の高さで代用すると断片の境界を跨いだ判定にならない)。
          const { $head } = editor.state.selection;
          const doc = editor.state.doc;
          if ($head.depth === 0) {
            return fallback > 0 ? fallback : null;
          }
          const boundary = direction === "down"
            ? $head.after($head.depth)
            : $head.before($head.depth);
          if (boundary < 0 || boundary > doc.content.size) {
            return fallback > 0 ? fallback : null;
          }
          const near = TextSelection.near(
            doc.resolve(boundary),
            direction === "down" ? 1 : -1,
          );
          if (near.$head.parent === $head.parent) {
            return fallback > 0 ? fallback : null;
          }
          const advance = Math.abs(
            editor.view.coordsAtPos(near.head).top - caret.top,
          ) / scale;
          // 隣のブロックが真下 (真上) に組まれていない構成 — 段組みの絶対配置や、間に
          // 分割ブロックを挟む場合 — では差が意味を持たない。行 4 つぶんを超えたら
          // measurement を信用せず矩形の高さへ戻す。
          const sane = advance > 0 && (fallback <= 0 || advance <= fallback * 4);
          return sane ? advance : (fallback > 0 ? fallback : null);
        } catch {
          return null;
        }
      },
      focusCaretAtLocalY: ({ containerBlockId, localY, preferredX }) => {
        const container = getTextFlowBlockElement(editor, containerBlockId);
        if (!container) {
          return false;
        }
        const rect = container.getBoundingClientRect();
        const clientY = rect.top + localY * getCaretZoomScale(container, rect);
        const placed = focusTextFlowCaretAtClientPoint(
          editor,
          preferredX,
          clientY,
          getCaretSurfaceBand(readMountedEditorDom(editor) ?? container, containerBlockId),
        );
        if (placed) {
          verticalNavigationXRef.current = preferredX;
          publishCaretMove(editor, preferredX);
        }
        return placed;
      },
      focusCaretAtEdge: (edge, preferredX) => {
        const root = readMountedEditorDom(editor);
        if (!root) {
          return false;
        }
        const band = getCaretSurfaceBand(root, null);
        const placed = focusTextFlowCaretAtClientPoint(
          editor,
          preferredX,
          edge === "top" ? band.top + 1 : band.bottom - 1,
          band,
        );
        if (placed) {
          verticalNavigationXRef.current = preferredX;
          publishCaretMove(editor, preferredX);
        }
        return placed;
      },
      focusCaretAfterBlock: (containerBlockId, direction, preferredX) => {
        // 行き先は**幾何ではなく doc 位置**で決める。分割ブロックはレイアウト上は全高を
        // 占めるので、矩形の下端の少し下を突くと箱の内側 (clip されて見えない場所) に
        // 当たってしまう。
        const placed = focusTextFlowCaretAfterBlock(editor, containerBlockId, direction, preferredX);
        if (placed) {
          if (preferredX !== null) {
            verticalNavigationXRef.current = preferredX;
          }
          publishCaretMove(editor, preferredX);
        }
        return placed;
      },
      docEdgeAddress: (edge) => {
        const doc = editor.state.doc;
        const selection = edge === "start" ? Selection.atStart(doc) : Selection.atEnd(doc);
        return getTextFlowCaretAddress(doc, selection.head, DEFAULT_CARET_AFFINITY);
      },
      adjacentTextblockAddress: (direction) => {
        try {
          const { $head } = editor.state.selection;
          const doc = editor.state.doc;
          if ($head.depth === 0) {
            return null;
          }
          const boundary = direction === "down"
            ? $head.after($head.depth)
            : $head.before($head.depth);
          if (boundary < 0 || boundary > doc.content.size) {
            return null;
          }
          // Selection.near can fall back to a NodeSelection around the box.
          // That is not an adjacent text line and must not trap its continuation.
          const near = Selection.findFrom(doc.resolve(boundary), direction === "down" ? 1 : -1, true);
          if (!near || near.$head.parent === $head.parent) {
            return null;
          }
          return getTextFlowCaretAddress(doc, near.head, DEFAULT_CARET_AFFINITY);
        } catch {
          return null;
        }
      },
      ensureCaretVisible: () => {
        if (!editor.isDestroyed) {
          scrollCaretIntoView(editor.view);
        }
      },
      applyCaret: (selection) => {
        if (editor.isDestroyed) {
          return false;
        }
        const restored = applyTextFlowSelectionBookmark(editor, selection);
        if (!restored.applied) {
          return false;
        }
        focusTextFlowSurface(editor, restored.activeMarks);
        selectedIdRef.current = selection.head.blockId;
        onSelectRef.current(selection.head.blockId);
        return true;
      },
      textRun: textRunGroupId
        ? {
          editor,
          groupId: textRunGroupId,
          unitId,
          order: textRunOrder,
          preserveEmpty: textRunPreserveEmpty,
          scopeId: textRunScopeId ?? unitId,
          ...(textRunScopeContainer ? { scopeContainer: textRunScopeContainer } : {}),
          getBlocks: () => blocksRef.current,
          // 跨ぎ選択の置換 (エディタの外で組み立てた変更) の印。焦点があるエディタの受動
          // 同期は「id が同じなら何もしない」ため、そのままでは古い内容へ次の入力が入る。
          // 次の同期で必ず流し込むよう印を付けておく (writer 以外の関与ユニットにも付く)。
          markCrossEditorSync: (selection, historyGroup) => {
            crossEditorSyncRef.current = { selection, historyGroup };
          },
          // キャレットの乗るユニットの即時同期 (受動同期の再適用は同内容なので冪等)。
          // ここはルーター経由にしない: 受動同期を待つと置換前の doc に次の打鍵が入る。
          applyCrossEditorSync: (nextBlocks, selection) => {
            if (editor.isDestroyed) {
              return;
            }
            setTextFlowContentPreservingSelection(editor, nextBlocks);
            if (selection) {
              const restored = applyTextFlowSelectionBookmark(editor, selection);
              if (restored.applied) {
                focusTextFlowSurface(editor, restored.activeMarks);
              }
            }
          },
          onChange: (changedIds, nextBlocks, activeBlockId, context) => {
            onChangeRef.current(changedIds, nextBlocks, activeBlockId, context);
          },
        }
        : null,
    };
    caretFacetsRef.current = facets;
    updateCaretSurfaceFacets(editor, facets);
  }, [
    boxFragmentReplicaId,
    boxFragmentReplicaIndex,
    boxFragmentSourceLayouts,
    editor,
    fragmentedBoxIdsKey,
    previousIds,
    textRunGroupId,
    textRunOrder,
    textRunPreserveEmpty,
    textRunScopeContainer,
    textRunScopeId,
    textRunUnitId,
  ]);

  /** 面の登録。**deps は `[editor]` だけ**にすること (上のコメント参照)。 */
  useLayoutEffect(() => {
    const facets = caretFacetsRef.current;
    if (!editor || editor.isDestroyed || !facets) {
      return;
    }
    return registerCaretSurface({ editor, ...facets });
  }, [editor]);

  // span の変化でツールバーの書式状態を配り直す。Shift+矢印での跨ぎ拡張は head 側の
  // (焦点ではない) エディタにしか transaction を流さないため、onTransaction の配信だけだと
  // 焦点エディタの担当分を最後に見た状態のまま止まり、トグルの向きと表示がずれる。
  useEffect(() => {
    if (!editor) {
      return;
    }
    return subscribeTextRunSpan(() => {
      if (!editor.isDestroyed && editor.isFocused) {
        dispatchDocumentTextFormatState(editor);
      }
    });
  }, [editor]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const requestTextPageBreak = (event: Event) => {
      const detail = event instanceof CustomEvent ? detailFromTextPageBreakEvent(event) : null;
      if (!detail || !shouldHandleTextPageBreakRequest(detail, isBoxFragmentReplicaRef.current)) {
        return;
      }

      const currentBlocks = tiptapToTextFlow(editor.getJSON() as TiptapDoc, blocksRef.current);
      const selection = getManualTextPageBreakSelection(editor, detail.blockId, currentBlocks);
      if (shouldUseDocumentNextBlockForPageBreak(currentBlocks, detail, selection)) {
        return;
      }
      const result = resolveManualTextPageBreakBlocks(
        currentBlocks,
        detail.blockId,
        detail.enabled,
        selection,
        { createId },
      );
      if (!result) {
        return;
      }

      detail.handled = true;
      detail.focusBlockId = result.focusBlockId;
      detail.focusPosition = result.focusPosition;
      if (result.blocks !== currentBlocks) {
        // A newly created break owner will mount in its own render unit. Do not
        // insert it into this old surface as well: its unchanged props may never
        // trigger a reconciliation, leaving two editable copies of the same id.
        const ownedBlocks = result.blocks.filter((block) => previousIdsRef.current.includes(block.id));
        setTextFlowContentPreservingSelection(editor, ownedBlocks);
      }
      onChange(previousIdsRef.current, result.blocks, result.focusBlockId);
    };

    window.addEventListener(REQUEST_TEXT_PAGE_BREAK_EVENT, requestTextPageBreak);
    return () => window.removeEventListener(REQUEST_TEXT_PAGE_BREAK_EVENT, requestTextPageBreak);
  }, [editor, onChange]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const insertInlineMath = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      const tex = typeof detail?.tex === "string" ? detail.tex : "";
      const shouldEdit = detail?.edit === true;
      const eventTarget = typeof detail?.target === "string" ? detail.target : "document";
      if (eventTarget !== formatTarget) {
        return;
      }

	      const handlesSelectedBlock = !!selectedId && textFlowBlocksContainId(blocks, selectedId);

      if ((!tex && !shouldEdit) || (!editor.isFocused && !handlesSelectedBlock)) {
        return;
      }

      const id = createId("m_inline");
      editor
        .chain()
        .focus()
        .insertMathInline({
          id,
          tex,
        })
        .run();

      if (shouldEdit) {
        requestInlineMathEdit(id);
      }
    };

    window.addEventListener(INSERT_INLINE_MATH_EVENT, insertInlineMath);
    return () => window.removeEventListener(INSERT_INLINE_MATH_EVENT, insertInlineMath);
  }, [blocks, editor, formatTarget, selectedId]);

  useEffect(() => {
    if (!editor) {
      return;
    }

    const formatText = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      const eventTarget = typeof detail?.target === "string" ? detail.target : "document";
      if (eventTarget !== formatTarget) {
        return;
      }
      // 跨ぎ選択への書式適用は span 経路で全ユニットの担当範囲へ配る (ネイティブ選択は
      // 焦点エディタの担当分にしか無いので、通常経路だと部分適用になる)。リスナーは
      // 全ユニットに付いているため、同じイベントにつき 1 回だけ適用される。
      if (isMultiEditorTextRunSpan()) {
        if (typeof detail?.command === "string") {
          applyTextRunSpanFormatForEvent(event, {
            command: detail.command,
            value: detail.value,
          });
        }
        return;
      }
      const handlesSelectedBlock = !!selectedId && textFlowBlocksContainId(blocks, selectedId);
      if ((!editor.isFocused && !handlesSelectedBlock) || !detail?.command) {
        return;
      }

      applyTextFormatCommand(editor, {
        command: detail.command as string,
        value: detail.value,
      }, resolveTextFlowFormatCommandOptions(
        editor,
        selectedId,
        lastTextSelectionRef.current,
      ));

      // 適用後にキャレットが入ったブロックを、イベント経由で呼び出し側へ返す。
      // ブロックの入れ物を作り替えるとこのエディタごと remount されることがあり、
      // 呼び出し側 (EditorShell) は「どこへ焦点を戻すか」をこれでしか知れない。
      if (detail && typeof detail === "object") {
        (detail as { focusBlockId?: string | null }).focusBlockId = getSelectedTextBlockId(editor);
      }
    };

    window.addEventListener(FORMAT_TEXT_EVENT, formatText);
    return () => window.removeEventListener(FORMAT_TEXT_EVENT, formatText);
  }, [blocks, editor, formatTarget, selectedId]);

  const selectSlashCommandCandidate = useCallback((candidate: SlashCommandCandidate) => {
    if (!editor || editor.isDestroyed) {
      return;
    }

    insertSlashCommandFromQuery(
      editor.view,
      candidate,
      slashCommandQueryRef,
      onMaterialInsertRef,
      onBoxCommandRef,
      onProblemCommandRef,
      onBodyBlockCommandRef,
      tiptapEditorRef,
      onHeadingCommandRef,
      setSlashCommandQuery,
    );
  }, [editor, setSlashCommandQuery]);

  const openBoxActionDialog = useCallback((button: HTMLElement) => {
    const box = button.closest<HTMLElement>(".sigma-doc-box-block[data-sigma-doc-id]");
    const boxId = box?.dataset.sigmaDocId;
    if (!boxId) {
      return;
    }

    const rect = button.getBoundingClientRect();
    const maxLeft = Math.max(
      BOX_ACTION_DIALOG_MARGIN,
      window.innerWidth - BOX_ACTION_DIALOG_WIDTH - BOX_ACTION_DIALOG_MARGIN,
    );
    const maxTop = Math.max(
      BOX_ACTION_DIALOG_MARGIN,
      window.innerHeight - BOX_ACTION_DIALOG_HEIGHT - BOX_ACTION_DIALOG_MARGIN,
    );
    setBoxActionDialog((current) => current?.boxId === boxId ? null : {
      boxId,
      left: clampNumber(rect.right - BOX_ACTION_DIALOG_WIDTH, BOX_ACTION_DIALOG_MARGIN, maxLeft),
      top: clampNumber(rect.bottom + 6, BOX_ACTION_DIALOG_MARGIN, maxTop),
    });
    selectedIdRef.current = boxId;
    onSelect(boxId);
  }, [onSelect, setBoxActionDialog]);

  const deleteBoxBlock = useCallback((boxId: string) => {
    if (!editor || editor.isDestroyed) {
      return;
    }

    const nextSelectedId = deleteBoxBlockFromEditor(editor, boxId);
    setBoxActionDialog(null);
    setBoxSettingsDialog(null);
    selectedIdRef.current = nextSelectedId;
    if (nextSelectedId) {
      onSelect(nextSelectedId);
    }
  }, [editor, onSelect, setBoxActionDialog, setBoxSettingsDialog]);

  const copyBoxBlock = useCallback((boxId: string) => {
    if (!editor || editor.isDestroyed) {
      return;
    }

    const currentBlocks = tiptapToTextFlow(editor.getJSON() as TiptapDoc, blocksRef.current);
    const box = findBoxBlockInTextFlowBlocks(currentBlocks, boxId);
    if (!box) {
      return;
    }

    void writeEditorPayloadToSystemClipboard(createTextFlowClipboardPayload([box]));
    setBoxActionDialog(null);
  }, [editor, setBoxActionDialog]);

  const openBoxSettingsDialog = useCallback((boxId: string, options: { focusTitle?: boolean } = {}) => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    setBoxActionDialog(null);
    // ページを跨いだ箱は複数の面に描かれるが、設定を持てるのは元の面だけ。複製面でも開くと
    // 同じ箱のダイアログが面の数だけ積み上がり、下の層は「開いた時点のタイトル」を抱えたまま
    // 残る (閉じると空欄のダイアログが顔を出す)。ここでは所有者へ回すだけにする。
    if (readOnlyBoxTitle) {
      window.dispatchEvent(new CustomEvent(REQUEST_BOX_SETTINGS_EVENT, {
        detail: { boxId, focusTitle: options.focusTitle === true },
      }));
      return;
    }
    const target = findBoxBlockNodeInDoc(editor.state.doc, boxId);
    const boxBlock = target ? boxSettingsBlockFromNode(target.node) : null;
    setBoxSettingsDialog(boxBlock && target ? {
      boxId: boxBlock.id,
      styleId: boxBlock.styleId,
      frame: boxBlock.frame,
      title: boxTitleFromNode(target.node),
      focusTitle: options.focusTitle === true,
    } : null);
  }, [editor, readOnlyBoxTitle, setBoxActionDialog, setBoxSettingsDialog]);

  useEffect(() => {
    const openSettings = (event: Event) => {
      // 複製面は所有者ではないので受け取らない (受け取ると上の再送と往復する)。
      if (readOnlyBoxTitle) {
        return;
      }
      const detail = event instanceof CustomEvent ? event.detail : null;
      const boxId = typeof detail?.boxId === "string" ? detail.boxId : null;
      if (boxId) {
        openBoxSettingsDialog(boxId, { focusTitle: detail?.focusTitle === true });
      }
    };
    window.addEventListener(REQUEST_BOX_SETTINGS_EVENT, openSettings);
    return () => window.removeEventListener(REQUEST_BOX_SETTINGS_EVENT, openSettings);
  }, [openBoxSettingsDialog, readOnlyBoxTitle]);

  const applyBoxSettings = useCallback((
    boxId: string,
    updater: (boxBlock: BoxBlockNode) => BoxBlockNode,
  ) => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    const target = findBoxBlockNodeInDoc(editor.state.doc, boxId);
    const boxBlock = target ? boxSettingsBlockFromNode(target.node) : null;
    if (!target || !boxBlock) {
      setBoxSettingsDialog(null);
      return;
    }

    const nextBoxBlock = updater(boxBlock);
    const transaction = editor.state.tr.setNodeMarkup(target.pos, undefined, {
      ...target.node.attrs,
      styleId: nextBoxBlock.styleId,
      frame: nextBoxBlock.frame ?? null,
    });
    editor.view.dispatch(transaction);
    setBoxSettingsDialog((current) => ({
      boxId: nextBoxBlock.id,
      styleId: nextBoxBlock.styleId,
      frame: nextBoxBlock.frame,
      title: current?.boxId === nextBoxBlock.id ? current.title : boxTitleFromNode(target.node),
      focusTitle: false,
    }));
  }, [editor, setBoxSettingsDialog]);

  /**
   * 設定ダイアログを閉じたあと、キャレットをその箱へ戻す。
   *
   * これを置かないと ModalFrame の復帰先が「開いた時にフォーカスしていた要素」= 既に消えている
   * ⋯ ダイアログのボタンになり、body 先頭の入力 (画面上端の教材タイトル) が全選択された状態で
   * 残る。タイトルを付け終えた直後の 1 打鍵が教材名の書き換えになるので、必ず引き取る。
   */
  const focusBoxAfterSettings = useCallback((boxId: string) => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    const target = findBoxBlockNodeInDoc(editor.state.doc, boxId);
    const titleNode = target?.node.firstChild;
    if (!target || titleNode?.type.name !== "boxBlockTitle") {
      return;
    }

    const selection = TextSelection.near(editor.state.doc.resolve(target.pos + titleNode.nodeSize), -1);
    editor.view.focus();
    editor.view.dispatch(editor.state.tr.setSelection(selection).scrollIntoView());
  }, [editor]);

  /**
   * ダイアログで打ったタイトルを箱へ書き戻す。
   *
   * 差し替えるのは `boxBlockTitle` の**中身だけ**で、ノード自体は残す。ノードごと入れ替えると
   * 1 打鍵ごとにタイトル領域の DOM (と中の数式ノードビュー) が作り直されてしまう。
   */
  const applyBoxTitle = useCallback((boxId: string, title: InlineNode[]) => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    const target = findBoxBlockNodeInDoc(editor.state.doc, boxId);
    const titleNode = target?.node.firstChild;
    if (!target || titleNode?.type.name !== "boxBlockTitle") {
      return;
    }

    const titleStart = target.pos + 1;
    const contentFrom = titleStart + 1;
    const contentTo = titleStart + titleNode.nodeSize - 1;
    const nextContent = Fragment.fromJSON(editor.state.schema, inlineNodesToTiptapNodes(title));
    editor.view.dispatch(editor.state.tr.replaceWith(contentFrom, contentTo, nextContent));
    setBoxSettingsDialog((current) => (
      current && current.boxId === boxId ? { ...current, title, focusTitle: false } : current
    ));
  }, [editor, setBoxSettingsDialog]);

  const applyCodeBlockSettings = useCallback((
    codeBlockId: string,
    patch: { language?: string | null; theme?: CodeBlockTheme },
  ) => {
    if (!editor || editor.isDestroyed) {
      return;
    }
    const target = findCodeBlockNodeInDoc(editor.state.doc, codeBlockId);
    if (!target) {
      setCodeBlockSettingsPopover(null);
      return;
    }

    const language = patch.language === undefined
      ? normalizeCodeLanguage(target.node.attrs.language) ?? null
      : normalizeCodeLanguage(patch.language) ?? null;
    const theme = patch.theme === undefined
      ? normalizeCodeBlockTheme(target.node.attrs.theme) ?? "light"
      : patch.theme;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(target.pos, undefined, {
      ...target.node.attrs,
      language,
      theme,
    }));
    setCodeBlockSettingsPopover((current) => current?.codeBlockId === codeBlockId
      ? { ...current, language, theme }
      : current);
  }, [editor, setCodeBlockSettingsPopover]);

  const closeCodeBlockSettings = useCallback(() => {
    setCodeBlockSettingsPopover((current) => {
      if (!current || !editor || editor.isDestroyed) {
        return null;
      }
      const { codeBlockId } = current;
      window.requestAnimationFrame(() => {
        const button = Array.from(readMountedEditorDom(editor)?.querySelectorAll<HTMLButtonElement>(
          "[data-code-block-action-button='true']",
        ) ?? []).find((candidate) => candidate.dataset.codeBlockId === codeBlockId);
        button?.focus({ preventScroll: true });
      });
      return null;
    });
  }, [editor, setCodeBlockSettingsPopover]);

  const applyContextTextFormat = useCallback((command: "fontFamily" | "lineHeight", value: string) => {
    window.dispatchEvent(new CustomEvent(FORMAT_TEXT_EVENT, {
      detail: { command, value, target: formatTarget },
    }));
  }, [formatTarget]);

  return (
    <div
      className={`text-flow-shell ${columnFlowBlockLayouts ? "column-flow-positioned" : ""}`}
      onCopy={(event) => {
        // ProseMirror のコピー処理はエディタ根の DOM に付いていて、React に委譲されたこの
        // ハンドラより先に走る。ここでは PM が書いた text/html には触らず、選択範囲の slice を
        // private MIME に添えるだけ。図形も選択されている混在コピーで、オーバーレイ側の window
        // ハンドラが同じイベント内からこれを拾って本文と図形を 1 つの payload にまとめる。
        //
        // 跨ぎ選択 (span) のコピーも同じ形: copyActiveTextRunSpan が payload と一緒に
        // 結合 slice を private MIME へ添えるので、stopPropagation せず window まで流し、
        // 図形が選択されていればオーバーレイ側が textAndShapes へまとめ直す。
        if (event.clipboardData && copyActiveTextRunSpan(event.clipboardData)) {
          event.preventDefault();
          return;
        }
        if (!editor || editor.state.selection.empty || !event.clipboardData) {
          return;
        }
        const slice = editor.state.selection.content();
        writeTextSliceClipboardData(event.clipboardData, slice.toJSON(), sliceTextForClipboard(slice));
      }}
      onMouseDownCapture={(event) => {
        if (event.button === 0 && getClosestBoxActionButton(event.target)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (
          !editor || !textRunGroupId || event.button !== 0 || event.defaultPrevented
          || event.metaKey || event.ctrlKey || event.altKey
          || isDirectControlTarget(event.target)
          || (event.target instanceof Element && event.target.closest("[contenteditable='false']"))
        ) {
          return;
        }
        // 本文の左ドラッグを PM のクリック判定より先に所有する。後段で始めると、
        // 連続クリックの preventDefault によって追跡が始まらず、押したままでも範囲が伸びない。
        verticalNavigationXRef.current = null;
        if (!startBoxFragmentPointerSelection(event, editor)) {
          startTextRunPointerSelection(event, editor, textRunGroupId);
        }
      }}
      onKeyDownCapture={(event) => {
        const button = getClosestBoxActionButton(event.target);
        if (button && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          event.stopPropagation();
          openBoxActionDialog(button);
        }
      }}
      onMouseDown={(event) => {
        event.stopPropagation();
        const commentThreadId = getClosestCommentThreadId(event.target);
        if (commentThreadId) {
          onCommentThreadSelect?.(commentThreadId);
        }
        const boxFragmentSelectionStarted = editor
          ? startBoxFragmentPointerSelection(event, editor)
          : false;
        const expandedSelectionStarted = !boxFragmentSelectionStarted && (textRunGroupId && editor
          ? startTextRunPointerSelection(event, editor, textRunGroupId)
          : startExpandedTextSelection(event, editor));
        const pointerSelection = !boxFragmentSelectionStarted && !expandedSelectionStarted && editor && !editor.isDestroyed
          ? getTextFlowPointerSelection(event, editor)
          : null;
        const blockId =
          getClosestTextFlowBlockId(event.target) ??
          (isInsideTextFlowEditor(event.target) ? pointerSelection?.blockId ?? null : null);
        if (blockId) {
          selectedIdRef.current = blockId;
          onSelect(blockId);
          if (editor && !editor.isDestroyed) {
            if (pointerSelection) {
              focusTextFlowEditorAtPosition(editor, pointerSelection.position);
            }
            refreshSelectedTextBlock(editor.view);
          }
        }
      }}
      onClick={(event) => {
        event.stopPropagation();
        const button = getClosestBoxActionButton(event.target);
        if (button) {
          event.preventDefault();
          openBoxActionDialog(button);
        }
      }}
      onContextMenu={(event) => {
        if (!enableSelectionFormatMenu) {
          return;
        }
        if (!editor || editor.isDestroyed || !isInsideTextFlowEditor(event.target)) {
          return;
        }

        const hasSelection = !editor.state.selection.empty;
        const boxId = getBoxBlockIdAtContext(editor, event.target);
        if (!hasSelection && !boxId) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        const selectedBlockId = getSelectedTextBlockId(editor);
        if (selectedBlockId && hasSelection) {
          const { from, to } = editor.state.selection;
          lastTextSelectionRef.current = { blockId: selectedBlockId, from, to };
          selectedIdRef.current = selectedBlockId;
          onSelect(selectedBlockId);
        }

        const styledTextAttrs = editor.getAttributes("styledText");
        const currentNodeAttrs = editor.state.selection.$from.parent.attrs;
        const currentFontFamily = typeof styledTextAttrs.fontFamily === "string" && styledTextAttrs.fontFamily.trim()
          ? styledTextAttrs.fontFamily
          : DEFAULT_FONT_FAMILY_VALUE;
        const currentLineHeight = normalizeLineHeight(currentNodeAttrs.lineHeight) ?? "1.75";
        const selectionRect = window.getSelection()?.rangeCount
          ? window.getSelection()?.getRangeAt(0).getBoundingClientRect()
          : null;
        const requestedLeft = Number.isFinite(event.clientX)
          ? event.clientX
          : selectionRect?.left ?? 12;
        const requestedTop = Number.isFinite(event.clientY)
          ? event.clientY
          : selectionRect?.bottom ?? 12;
        setTextFormatContextMenu({
          left: Math.max(12, requestedLeft),
          top: Math.max(12, requestedTop),
          fontFamily: currentFontFamily,
          lineHeight: currentLineHeight,
          hasSelection,
          boxId,
        });
      }}
    >
      <div className="text-flow-side-selection-gutter" aria-hidden="true" />
      <EditorContent editor={editor} className={boxFragmentReplicaId ? "text-flow-fragment-content" : undefined} />
      {editGuardNotice && (
        <p className="text-flow-edit-guard-notice" role="status" aria-live="polite">
          {editGuardNotice}
        </p>
      )}
	      <SlashCommandPopover
        query={slashCommandQuery}
        candidates={slashCommandCandidates}
        activeIndex={clampedSlashCommandActiveIndex}
        onHover={setSlashCommandActiveIndex}
	        onSelect={selectSlashCommandCandidate}
	      />
      <BoxActionDialog
        state={boxActionDialog}
        onClose={() => setBoxActionDialog(null)}
        onEditTitle={(boxId) => openBoxSettingsDialog(boxId, { focusTitle: true })}
        onSettings={openBoxSettingsDialog}
        onCopy={copyBoxBlock}
        onDelete={deleteBoxBlock}
      />
      {activeBoxSettingsDialog ? (
        <BoxSettingsDialog
          boxBlock={{
            id: activeBoxSettingsDialog.boxId,
            styleId: activeBoxSettingsDialog.styleId,
            frame: activeBoxSettingsDialog.frame,
          }}
          title={activeBoxSettingsDialog.title}
          mathFractionSizing={mathFractionSizing}
          autoFocusTitle={activeBoxSettingsDialog.focusTitle}
          onStyleChange={(styleId) => {
            // スタイルを選び直すのも「そのスタイルを手に入れる」操作。覚えている見た目があれば
            // 挿入と同じように載せる (でないと、記憶した色がスタイル切替のたびに剥がれる)。
            applyBoxSettings(activeBoxSettingsDialog.boxId, (boxBlock) => (
              applyRememberedBoxFrame(setBoxStyle(boxBlock, styleId))
            ));
          }}
          onFrameChange={(patch) => {
            applyBoxSettings(activeBoxSettingsDialog.boxId, (boxBlock) => patchBoxFrame(boxBlock, patch));
            rememberBoxFramePatch(activeBoxSettingsDialog.styleId, patch);
          }}
          onResetStyle={() => {
            forgetRememberedBoxFrame(activeBoxSettingsDialog.styleId);
            applyBoxSettings(activeBoxSettingsDialog.boxId, (boxBlock) => (
              setBoxStyle(boxBlock, activeBoxSettingsDialog.styleId)
            ));
          }}
          onTitleChange={(title) => applyBoxTitle(activeBoxSettingsDialog.boxId, title)}
          onClose={() => {
            const { boxId } = activeBoxSettingsDialog;
            setBoxSettingsDialog(null);
            // ModalFrame のフォーカス復帰はアンマウント時に走るので、その後で引き取る。
            window.setTimeout(() => focusBoxAfterSettings(boxId), 0);
          }}
        />
      ) : null}
      <CodeBlockSettingsPopover
        state={activeCodeBlockSettingsPopover}
        onClose={closeCodeBlockSettings}
        onLanguageChange={(language) => {
          if (activeCodeBlockSettingsPopover) {
            applyCodeBlockSettings(activeCodeBlockSettingsPopover.codeBlockId, { language });
          }
        }}
        onThemeChange={(theme) => {
          if (activeCodeBlockSettingsPopover) {
            applyCodeBlockSettings(activeCodeBlockSettingsPopover.codeBlockId, { theme });
          }
        }}
      />
      <TextFormatContextMenu
        state={textFormatContextMenu}
        onClose={() => setTextFormatContextMenu(null)}
        onBoxEditTitle={(boxId) => {
          setTextFormatContextMenu(null);
          openBoxSettingsDialog(boxId, { focusTitle: true });
        }}
        onBoxSettings={(boxId) => {
          setTextFormatContextMenu(null);
          openBoxSettingsDialog(boxId);
        }}
        onBoxCopy={(boxId) => {
          setTextFormatContextMenu(null);
          copyBoxBlock(boxId);
        }}
        onBoxDelete={(boxId) => {
          setTextFormatContextMenu(null);
          deleteBoxBlock(boxId);
        }}
        onFontFamilyChange={(fontFamily) => {
	          setTextFormatContextMenu((current) => current ? { ...current, fontFamily } : current);
	          applyContextTextFormat("fontFamily", fontFamily === DEFAULT_FONT_FAMILY_VALUE ? "" : fontFamily);
	        }}
	        onLineHeightChange={(lineHeight) => {
	          setTextFormatContextMenu((current) => current ? { ...current, lineHeight } : current);
	          applyContextTextFormat("lineHeight", lineHeight);
	        }}
	      />
	    </div>
	  );
	}

/**
 * 装飾の再描画合図。**1 まとめ = 1 transaction**。
 *
 * 種類ごとに transaction を打つと、1 回の変更で装飾プラグイン全部の走査が種類の数だけ回る
 * (打鍵で 2〜5 本、選択の移動でも本文ユニットの数だけ)。合図は meta なので 1 つの
 * transaction に何種類でも載る。
 */
export type TextFlowDecorationRefreshKind =
  | "changes"
  | "columnFlow"
  | "comments"
  | "gaps"
  | "headingNumbers"
  | "guards"
  | "selected"
  | "spaceAfter";

function dispatchTextFlowDecorationRefresh(
  view: EditorView | null | undefined,
  kinds: ReadonlySet<TextFlowDecorationRefreshKind>,
): void {
  if (!view || kinds.size === 0) {
    return;
  }
  const transaction = view.state.tr;
  const stamp = Date.now();
  if (kinds.has("changes")) {
    transaction.setMeta(changeDecorationKey, stamp);
  }
  if (kinds.has("columnFlow")) {
    transaction.setMeta(columnFlowLayoutKey, stamp);
  }
  if (kinds.has("spaceAfter")) {
    transaction.setMeta(spaceAfterPreviewKey, stamp);
  }
  if (kinds.has("comments")) {
    transaction.setMeta(commentDecorationKey, stamp);
  }
  if (kinds.has("gaps")) {
    transaction.setMeta(paginationGapKey, stamp);
  }
  if (kinds.has("headingNumbers")) {
    transaction.setMeta(headingNumberingKey, stamp);
  }
  if (kinds.has("guards")) {
    transaction.setMeta(editGuardKey, stamp);
  }
  if (kinds.has("selected")) {
    transaction.setMeta(selectedTextBlockKey, stamp);
  }
  countPerformanceEvent("TextFlowEditor.refreshDispatch");
  view.dispatch(transaction);
}

function getClosestCommentThreadId(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null;
  }

  const element = target.closest<HTMLElement>("[data-comment-thread-id]");
  return element?.dataset.commentThreadId ?? null;
}

function commentDecorationAttrs(
  threads: readonly SigmaCommentThread[],
  highlightedThreadId: string | null,
  baseClass: string,
): Record<string, string> {
  const threadIds = threads.map((thread) => thread.id);
  const highlighted = highlightedThreadId ? threadIds.includes(highlightedThreadId) : false;
  const className = [
    baseClass,
    highlighted ? "comment-highlight-active" : "",
    threadIds.length > 1 ? "comment-highlight-multiple" : "",
  ].filter(Boolean).join(" ");

  return {
    class: className,
    "data-comment-thread-id": highlighted && highlightedThreadId ? highlightedThreadId : threadIds[0] ?? "",
    "data-comment-thread-ids": threadIds.join(" "),
    "data-comment-count": String(threadIds.length),
  };
}

function createTextRangeDecorations(
  node: ProseMirrorModelNode,
  blockPos: number,
  fromOffset: number,
  toOffset: number,
  thread: SigmaCommentThread,
  activeThreadId: string | null,
): Decoration[] {
  if (toOffset <= fromOffset) {
    return [];
  }

  const decorations: Decoration[] = [];
  let cursor = 0;
  node.descendants((child, childPos) => {
    if (child.type.name !== "text" && child.type.name !== "mathInline") {
      return undefined;
    }

    const length = getPlainTextInlineLength(child);
    const inlineStart = cursor;
    const inlineEnd = cursor + length;
    cursor = inlineEnd;

    const overlapStart = Math.max(fromOffset, inlineStart);
    const overlapEnd = Math.min(toOffset, inlineEnd);
    if (overlapEnd <= overlapStart) {
      return undefined;
    }

    const absoluteStart = blockPos + 1 + childPos;
    if (child.type.name === "mathInline") {
      decorations.push(
        Decoration.node(
          absoluteStart,
          absoluteStart + child.nodeSize,
          commentDecorationAttrs([thread], activeThreadId, "comment-inline-math-highlight"),
        ),
      );
      return false;
    }

    decorations.push(
      Decoration.inline(
        absoluteStart + (overlapStart - inlineStart),
        absoluteStart + (overlapEnd - inlineStart),
        commentDecorationAttrs([thread], activeThreadId, "comment-text-highlight"),
      ),
    );

    return undefined;
  });

  return decorations;
}

function getPlainTextInlineLength(node: ProseMirrorModelNode): number {
  if (node.type.name === "mathInline") {
    const tex = typeof node.attrs.tex === "string" ? node.attrs.tex : "";
    return tex ? tex.length + 2 : 1;
  }

  const text = typeof node.text === "string" ? node.text : node.textContent;
  return text.length;
}

function detailFromTextPageBreakEvent(event: CustomEvent<unknown>): TextPageBreakRequestDetail | null {
  const detail = event.detail;
  if (!isRecord(detail) || typeof detail.blockId !== "string" || typeof detail.enabled !== "boolean") {
    return null;
  }
  return detail as unknown as TextPageBreakRequestDetail;
}

function getManualTextPageBreakSelection(
  editor: TiptapEditor,
  requestedBlockId: string,
  blocks: TextFlowBlock[],
): ManualTextPageBreakSelection | null {
  const selectedBlockId = getSelectedTextBlockId(editor);
  const blockById = indexTextFlowBlocksById(blocks);
  const blockIds = new Set(blockById.keys());
  if (!blockIds.has(requestedBlockId)) {
    return null;
  }

  if (selectedBlockId !== requestedBlockId || !blockIds.has(selectedBlockId)) {
    const requestedBlock = blockById.get(requestedBlockId);
    return requestedBlock
      ? { blockId: requestedBlockId, offset: getTextFlowBlockEditorLength(requestedBlock) }
      : null;
  }

  return {
    blockId: selectedBlockId,
    offset: editor.state.selection.$from.parentOffset,
  };
}

function getTextBlockRange(
  doc: ProseMirrorModelNode,
  selectedId: string | null,
): { from: number; to: number; nodeType: "paragraph" | "heading" | "boxBlockTitle" | "codeBlock" } | null {
  if (!selectedId) {
    return null;
  }

  let range: {
    from: number;
    to: number;
    nodeType: "paragraph" | "heading" | "boxBlockTitle" | "codeBlock";
  } | null = null;
  doc.descendants((node, pos, parent) => {
    const nodeType = node.type.name;
    if (
      range ||
      !isTextFormatTargetNodeType(nodeType)
    ) {
      return;
    }

    const nodeId = nodeType === "boxBlockTitle"
      ? parent?.attrs.sigmaDocId
      : node.attrs.sigmaDocId;
    if (nodeId === selectedId) {
      range = {
        from: pos + 1,
        to: Math.max(pos + 1, pos + node.nodeSize - 1),
        nodeType,
      };
    }
  });

  return range;
}

/**
 * 本文ツールバーへ書式状態を配信する。跨ぎ選択 (text-run-span) 中はトグル系マークを
 * span 全体で判定した値で上書きする — 焦点エディタの担当分だけを見た表示だと、
 * `applyTextRunSpanFormat` の「全範囲が付いているときだけ外す」判定と向きが割れて、
 * 「インジケータは太字 ON なのに押すと全体へ太字が追加される」矛盾が出る。
 */
function dispatchDocumentTextFormatState(activeEditor: TiptapEditor): void {
  dispatchTextFormatState(
    activeEditor,
    TEXT_FORMAT_STATE_EVENT,
    "document",
    resolveTextFormatStateContext(activeEditor.state),
    { state: activeEditor.state, view: activeEditor.view, documentFontFamily: DEFAULT_FONT_FAMILY_VALUE },
    { ...getTextRunSpanToggleMarkStates(activeEditor), ...getTextRunSpanFontSize(activeEditor) },
  );
}

export function resolveTextFormatStateContext(state: EditorState): TextFormatStateContext {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    const nodeType = node.type.name;
    if (nodeType === "boxBlockTitle") {
      for (let boxDepth = depth - 1; boxDepth > 0; boxDepth -= 1) {
        const boxNode = $from.node(boxDepth);
        if (boxNode.type.name === "boxBlock") {
          const blockId = typeof boxNode.attrs.sigmaDocId === "string"
            ? boxNode.attrs.sigmaDocId
            : null;
          return {
            enabled: Boolean(blockId),
            nodeType: "boxBlockTitle",
            blockId,
          };
        }
      }
    }

    if (nodeType === "codeBlock") {
      const blockId = typeof node.attrs.sigmaDocId === "string"
        ? node.attrs.sigmaDocId
        : null;
      return {
        enabled: Boolean(blockId),
        nodeType,
        blockId,
      };
    }

    if (nodeType === "paragraph" || nodeType === "heading") {
      let blockId = typeof node.attrs.sigmaDocId === "string"
        ? node.attrs.sigmaDocId
        : null;
      if (!blockId) {
        for (let listDepth = depth - 1; listDepth > 0; listDepth -= 1) {
          const listItem = $from.node(listDepth);
          if (listItem.type.name !== "listItem") {
            continue;
          }
          blockId = typeof listItem.attrs.sigmaDocId === "string"
            ? listItem.attrs.sigmaDocId
            : null;
          break;
        }
      }
      return {
        enabled: Boolean(blockId),
        nodeType,
        blockId,
      };
    }
  }

  return {
    enabled: false,
    nodeType: null,
    blockId: null,
  };
}

export function resolveTextFlowFormatCommandOptions(
  editor: TiptapEditor,
  selectedId: string | null,
  lastSelection: { blockId: string; from: number; to: number } | null,
): TextFormatCommandOptions {
  const currentSelection = editor.state.selection;
  let selection: TextFormatSelectionRange | null = null;
  if (
    !currentSelection.empty &&
    isValidTextFormatSelection(currentSelection, editor.state.doc.content.size)
  ) {
    selection = { from: currentSelection.from, to: currentSelection.to };
  } else if (!editor.isFocused) {
    // A focused editor still owns its collapsed caret. Paragraph attributes such as alignment can
    // update that text block directly, while inline commands use stored marks. Selecting the whole
    // block here would leave its text selected, so the next Enter would erase it. Only a blurred
    // editor needs the saved-selection / selected-block fallback below.
    if (
      lastSelection &&
      lastSelection.blockId === selectedId &&
      isValidTextFormatSelection(lastSelection, editor.state.doc.content.size)
    ) {
      selection = {
        from: lastSelection.from,
        to: lastSelection.to,
      };
    } else {
      const selectedRange = getTextBlockRange(editor.state.doc, selectedId);
      selection = selectedRange
        ? { from: selectedRange.from, to: selectedRange.to }
        : null;
    }
  }

  const range = getTextBlockRange(editor.state.doc, selectedId);
  const nodeType = range?.nodeType ?? editor.state.selection.$from.parent.type.name;
  return {
    selection,
    blockNodeType: nodeType === "heading" ? "heading" : "paragraph",
    allowBlockStyle: nodeType !== "boxBlockTitle",
    preserveSelectionForBlockAttributes: true,
  };
}

function findBoxBlockInTextFlowBlocks(blocks: TextFlowBlock[], boxId: string): BoxBlockNode | null {
  for (const block of blocks) {
    const found = findBoxBlockInTextFlowBlock(block, boxId);
    if (found) {
      return found;
    }
  }
  return null;
}

function findBoxBlockInTextFlowBlock(block: TextFlowBlock | BoxBlockChildBlock, boxId: string): BoxBlockNode | null {
  if (block.type === "boxBlock") {
    if (block.id === boxId) {
      return block;
    }
    return findBoxBlockInTextFlowBlocks(block.blocks, boxId);
  }

  if (block.type === "layoutSection") {
    return findBoxBlockInTextFlowBlocks(block.children, boxId);
  }

  return null;
}

function deleteBoxBlockFromEditor(editor: TiptapEditor, boxId: string): string | null {
  const { state, view } = editor;
  const target = findBoxBlockNodeInDoc(state.doc, boxId);
  if (!target) {
    return null;
  }

  let transaction = state.tr.delete(target.pos, target.pos + target.node.nodeSize);
  if (transaction.doc.childCount === 0) {
    const paragraph = state.schema.nodes.paragraph.create({
      sigmaDocId: createId("p"),
      sigmaDocType: "paragraph",
    });
    transaction = transaction.insert(0, paragraph);
  }

  const nextSelectedId = getFirstEditorTextBlockId(transaction.doc);
  try {
    const selectionPos = clampNumber(target.pos, 1, Math.max(1, transaction.doc.content.size));
    transaction = transaction.setSelection(TextSelection.near(transaction.doc.resolve(selectionPos), -1));
  } catch {
    // Keep the delete operation even if ProseMirror cannot place a nearby cursor.
  }

  view.dispatch(transaction.scrollIntoView());
  view.focus();
  return nextSelectedId;
}

function findBoxBlockNodeInDoc(doc: ProseMirrorModelNode, boxId: string): { node: ProseMirrorModelNode; pos: number } | null {
  let found: { node: ProseMirrorModelNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) {
      return false;
    }
    if (node.type.name === "boxBlock" && node.attrs.sigmaDocId === boxId) {
      found = { node, pos };
      return false;
    }
    return undefined;
  });
  return found;
}

function findCodeBlockNodeInDoc(
  doc: ProseMirrorModelNode,
  codeBlockId: string,
): { node: ProseMirrorModelNode; pos: number } | null {
  let found: { node: ProseMirrorModelNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) {
      return false;
    }
    if (node.type.name === "codeBlock" && node.attrs.sigmaDocId === codeBlockId) {
      found = { node, pos };
      return false;
    }
    return undefined;
  });
  return found;
}

function boxTitleFromNode(node: ProseMirrorModelNode): InlineNode[] {
  const titleNode = node.firstChild;
  if (titleNode?.type.name !== "boxBlockTitle") {
    return [];
  }

  const json = titleNode.toJSON() as { content?: TiptapNode[] };
  return tiptapNodesToInlineNodes(json.content ?? []);
}

function boxSettingsBlockFromNode(node: ProseMirrorModelNode): BoxBlockNode | null {
  const boxId = typeof node.attrs.sigmaDocId === "string" ? node.attrs.sigmaDocId : null;
  if (node.type.name !== "boxBlock" || !boxId) {
    return null;
  }
  return {
    type: "boxBlock",
    id: boxId,
    styleId: typeof node.attrs.styleId === "string" ? node.attrs.styleId : "fancybox",
    ...(isRecord(node.attrs.frame) ? { frame: node.attrs.frame as BoxFrameSpec } : {}),
    blocks: [],
  };
}

function getFirstEditorTextBlockId(doc: ProseMirrorModelNode): string | null {
  let id: string | null = null;
  doc.descendants((node) => {
    if (id) {
      return false;
    }
    if (!isEditorTextFlowBlockNode(node.type.name)) {
      return undefined;
    }
    const candidate = node.attrs.sigmaDocId;
    if (typeof candidate === "string") {
      id = candidate;
      return false;
    }
    return undefined;
  });
  return id;
}

/**
 * PM の doc から読んだ段落種別。`hasTextFlowBlockKindChange` が SigmaDoc 側と突き合わせる。
 * section も PM では level 1 の heading なので、SigmaDoc 側の "heading1" と自然に一致する。
 */
function getEditorTextBlockKinds(editor: TiptapEditor): Map<string, TextFlowBlockKind> {
  const kinds = new Map<string, TextFlowBlockKind>();

  editor.state.doc.descendants((node) => {
    const id = node.attrs.sigmaDocId;
    if (typeof id !== "string") {
      return;
    }
    if (node.type.name === "heading") {
      const level = Number(node.attrs.level ?? 1);
      kinds.set(id, `heading${level === 2 || level === 3 ? level : 1}` as TextFlowBlockKind);
      return;
    }
    // コードブロックは段落と id を共有したまま種別だけ変わるので、必ず突き合わせる。
    if (node.type.name === "codeBlock") {
      kinds.set(id, "codeBlock");
      return;
    }
    // リスト項目の先頭段落は SigmaDoc では listItem。突き合わせの対象にしない。
    if (node.type.name === "paragraph" && node.attrs.sigmaDocType !== "listItem") {
      kinds.set(id, "paragraph");
    }
  });

  return kinds;
}

/**
 * PM の doc から読んだ非構造属性の署名。`hasTextFlowBlockAttributeChange` が SigmaDoc 側と
 * 突き合わせる。**署名を作るのは SigmaDoc 側と同じ関数**なので、属性が増えてもここは変わらない。
 *
 * リスト項目の先頭段落は専用の非描画属性から署名を作る。通常の `spaceAfterPx`
 * を読むと、項目内部の辺ではなく段落下端の描画と混同する。
 */
export function getEditorTextBlockAttributes(editor: TiptapEditor): Map<string, string> {
  const attributes = new Map<string, string>();

  editor.state.doc.descendants((node) => {
    const id = node.attrs.sigmaDocId;
    if (typeof id !== "string") {
      return;
    }
    attributes.set(
      id,
      textFlowBlockAttributeSignature(
        node.attrs.sigmaDocType === "listItem"
          ? { spaceAfterPx: node.attrs.listItemSpaceAfterPx }
          : node.attrs,
      ),
    );
  });

  return attributes;
}

function getEditorTextBlockIds(editor: TiptapEditor): string[] {
  const ids: string[] = [];

  editor.state.doc.descendants((node) => {
    if (!isEditorTextFlowBlockNode(node.type.name)) {
      return;
    }

    const id = node.attrs.sigmaDocId;
    if (typeof id === "string") {
      ids.push(id);
    }
  });

  return ids;
}

function isEditorTextFlowBlockNode(nodeType: string): boolean {
  return nodeType === "paragraph"
    || nodeType === "heading"
    || nodeType === "bulletList"
    || nodeType === "orderedList"
    || nodeType === "boxBlock"
    || nodeType === "layoutSection"
    || nodeType === "quote"
    || nodeType === "codeBlock"
    || nodeType === "divider";
}

function refreshSelectedTextBlock(view: EditorView | null | undefined): void {
  if (!view) {
    return;
  }
  countPerformanceEvent("TextFlowEditor.refreshDispatch");
  view.dispatch(view.state.tr.setMeta(selectedTextBlockKey, Date.now()));
}

function getTextFlowPointerSelection(
  event: ReactMouseEvent<HTMLElement>,
  editor: TiptapEditor,
): { blockId: string | null; position: number } | null {
  if (
    event.button !== 0 ||
    event.detail > 1 ||
    event.defaultPrevented ||
    event.shiftKey ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey ||
    isDirectControlTarget(event.target)
  ) {
    return null;
  }

  const position = getTextFlowPositionAtClientPoint(editor, event.clientX, event.clientY);
  if (position === null) {
    return null;
  }

  return {
    blockId: getTextFlowBlockIdAtPosition(editor, position),
    position,
  };
}

function focusTextFlowEditorAtPosition(editor: TiptapEditor, position: number): void {
  const selectionPosition = clampNumber(position, 1, Math.max(1, editor.state.doc.content.size));
  try {
    const selection = TextSelection.near(editor.state.doc.resolve(selectionPosition), 1);
    editor.chain().focus().setTextSelection({ from: selection.from, to: selection.to }).run();
  } catch {
    editor.chain().focus().setTextSelection(selectionPosition).run();
  }
}

function isDirectControlTarget(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(DIRECT_CONTROL_SELECTOR));
}

function isInsideTextFlowEditor(target: EventTarget | null): boolean {
  return target instanceof Element && Boolean(target.closest(TEXT_FLOW_EDITOR_SELECTOR));
}

function getTextFlowPositionAtClientPoint(
  editor: TiptapEditor,
  clientX: number,
  clientY: number,
): number | null {
  const root = readMountedEditorDom(editor);
  if (!root) {
    return null;
  }
  return posAtClientPoint(editor.view, clientX, clientY);
}

function getTextFlowBlockIdAtPosition(editor: TiptapEditor, position: number): string | null {
  const doc = editor.state.doc;
  const resolvedPosition = doc.resolve(Math.max(0, Math.min(position, doc.content.size)));
  for (let depth = resolvedPosition.depth; depth >= 0; depth -= 1) {
    const id = resolvedPosition.node(depth).attrs.sigmaDocId;
    if (typeof id === "string" && id) {
      return id;
    }
  }

  return getTextFlowBlockIdFromAdjacentNode(resolvedPosition.nodeAfter) ??
    getTextFlowBlockIdFromAdjacentNode(resolvedPosition.nodeBefore);
}

function getTextFlowBlockIdFromAdjacentNode(node: ProseMirrorModelNode | null): string | null {
  const id = node?.attrs.sigmaDocId;
  return typeof id === "string" && id ? id : null;
}

/**
 * ProseMirror の位置を、**必ず葉ブロックを指す** `CaretAddress` へ写す。
 *
 * 規則そのもの (どこまで降りるか / offset をどう丸めるか) は `features/text-editing` の純関数
 * が持ち、ここは ProseMirror から素データを取り出すだけにする。
 */
function getTextFlowCaretAddress(
  doc: ProseMirrorModelNode,
  position: number,
  affinity: CaretAffinity,
): CaretAddress | null {
  const clampedPosition = Math.max(0, Math.min(position, doc.content.size));
  const resolvedPosition = doc.resolve(clampedPosition);
  const path: CaretBlockPathEntry[] = [];
  for (let depth = 0; depth <= resolvedPosition.depth; depth += 1) {
    const node = resolvedPosition.node(depth);
    path.push({
      blockId: getTextFlowBlockIdFromAdjacentNode(node),
      contentSize: node.content.size,
      contentStart: depth === 0 ? 0 : resolvedPosition.start(depth),
      isAtom: node.isAtom,
    });
  }
  // どの祖先も id を持たない = ブロックとブロックの隙間 (gap cursor・文書の端)。ここは
  // 「隣のブロックの端」でも「隣のブロックそのもの」でもないので、隣接ノードから作り出さない。
  // 区切り線などを丸ごと選んだ状態は `getTextFlowSelectionBookmark` が選択の種類から立てる。
  return normalizeCaretAddressPath(path, clampedPosition, affinity);
}

export function getTextFlowSelectionBookmark(
  editor: TiptapEditor,
  preferredX: number | null,
): TextFlowSelectionBookmark | null {
  const selection = editor.state.selection;
  // 区切り線 / 箱 / 段組みセクションを丸ごと選んでいる状態。位置からは「隙間」にしか見えない
  // ので、選択の種類を知っているここで `kind: "node"` を立てる。
  if (selection instanceof NodeSelection) {
    const blockId = getTextFlowBlockIdFromAdjacentNode(selection.node);
    if (blockId) {
      const address: CaretAddress = {
        affinity: DEFAULT_CARET_AFFINITY,
        blockId,
        kind: "node",
        offset: 0,
      };
      return { anchor: address, head: address, preferredX };
    }
  }
  const anchorAddress = getTextFlowCaretAddress(
    editor.state.doc,
    selection.anchor,
    DEFAULT_CARET_AFFINITY,
  );
  const headAddress = getTextFlowCaretAddress(
    editor.state.doc,
    selection.head,
    DEFAULT_CARET_AFFINITY,
  );
  return anchorAddress && headAddress
    ? { anchor: anchorAddress, head: headAddress, preferredX }
    : null;
}

function getTextFlowSelectionBookmarkBeforeTransaction(
  transaction: Transaction,
  preferredX: number | null,
): TextFlowSelectionBookmark | null {
  const invertedMapping = transaction.mapping.invert();
  const anchor = invertedMapping.map(transaction.selection.anchor, -1);
  const head = invertedMapping.map(transaction.selection.head, 1);
  // ±1 は写像の bias であって「境界のどちら側に属するか」ではない。ProseMirror は position に
  // affinity を持たないので、ここでも既定のままにする (発明しない)。
  const anchorAddress = getTextFlowCaretAddress(transaction.before, anchor, DEFAULT_CARET_AFFINITY);
  const headAddress = getTextFlowCaretAddress(transaction.before, head, DEFAULT_CARET_AFFINITY);
  return anchorAddress && headAddress
    ? { anchor: anchorAddress, head: headAddress, preferredX }
    : null;
}

function getTextFlowSelectionPosition(
  editor: TiptapEditor,
  address: CaretAddress,
): number | null {
  let position: number | null = null;
  editor.state.doc.descendants((node, nodePosition) => {
    if (node.attrs.sigmaDocId !== address.blockId) {
      return true;
    }
    // ノードを丸ごと選ぶときはノードの**手前**の位置。文字位置は内容の開始からの offset。
    position = address.kind === "node"
      ? nodePosition
      : nodePosition + 1 + clampCaretOffset(address.offset, node.content.size);
    return false;
  });
  return position;
}

export interface AppliedTextFlowSelection {
  applied: boolean;
  activeMarks: readonly ProseMirrorMark[] | null;
}

/**
 * ブックマークをこの面の選択として適用する。**DOM フォーカスは取らない。**
 *
 * ページを跨ぐブロックは正本と断片の複製の N+1 個の面に描かれ、どの面も同じ論理位置を復元
 * できる。フォーカスまで一緒に取ると、購読順 (= React ツリー順) の最後の面が必ず勝ち、
 * 見えていない断片がキャレットを攫う。「適用」と「フォーカス取得」を分け、可視判定を挟んで
 * `focusTextFlowSurface` を呼ぶのは 1 面だけにする。
 */
export function applyTextFlowSelectionBookmark(
  editor: TiptapEditor,
  selection: TextFlowSelectionBookmark,
): AppliedTextFlowSelection {
  // 書式は dispatch の前に読む (dispatch 後の storedMarks は既に落ちている)。
  const activeMarks = editor.state.selection.empty ? editor.state.storedMarks : null;
  const anchor = getTextFlowSelectionPosition(editor, selection.anchor);
  const head = getTextFlowSelectionPosition(editor, selection.head);
  if (anchor === null || head === null) {
    return { activeMarks: null, applied: false };
  }

  // 片側だけ `"node"` の bookmark (別経路で組まれた古い値) を NodeSelection に倒すと、
  // 選択範囲が黙って別物になる。両端が同じノードを指しているときだけノード選択にする。
  const isNodeSelection = selection.anchor.kind === "node"
    && selection.head.kind === "node"
    && selection.anchor.blockId === selection.head.blockId;
  const nextSelection = createTextFlowSelection(
    editor.state.doc,
    anchor,
    head,
    isNodeSelection ? "node" : "text",
  );
  if (!nextSelection) {
    return { activeMarks: null, applied: false };
  }
  const transaction = editor.state.tr.setSelection(nextSelection);
  if (activeMarks && transaction.selection.empty) {
    transaction.setStoredMarks(activeMarks);
  }
  editor.view.dispatch(transaction);
  return { activeMarks, applied: true };
}

/**
 * コンテナ id が混ざったブックマークなどで `TextSelection.create` は `RangeError` を投げる。
 * 例外のまま抜けると「フォーカスだけ動いて選択は元のまま」という最悪の状態が残るので、
 * 近傍のテキスト位置へ倒し、それも無理なら諦める。
 */
function createTextFlowSelection(
  doc: ProseMirrorModelNode,
  anchor: number,
  head: number,
  kind: CaretAddressKind,
): ProseMirrorSelection | null {
  if (kind === "node") {
    try {
      return NodeSelection.create(doc, head);
    } catch {
      // ノードが消えている / そこが選べない位置なら文字選択へ倒す。
    }
  }
  try {
    const selection = TextSelection.create(doc, anchor, head);
    // コンテナ id が混ざった bookmark は「箱のすぐ内側」など文字の無い位置を指す。
    // `TextSelection.create` はそれを例外にしないので、ここで葉に載っているか確かめる。
    if (selection.$head.parent.inlineContent && selection.$anchor.parent.inlineContent) {
      return selection;
    }
  } catch {
    // 位置そのものが解決できないときも下の近傍探索へ倒す。
  }
  try {
    return TextSelection.near(doc.resolve(head), 1);
  } catch {
    return null;
  }
}

/**
 * この面に DOM フォーカスを渡す。`view.focus()` は DOM 選択の同期を通じて storedMarks を
 * 落とすことがあるので、落ちていたら張り直す (Enter を跨いだ書式保持の番人)。
 */
export function focusTextFlowSurface(
  editor: TiptapEditor,
  activeMarks: readonly ProseMirrorMark[] | null,
): void {
  // `view.focus()` は内部で引数なしの `dom.focus()` を呼ぶ。先に同じ DOM を
  // preventScroll 付きでフォーカスし、ブラウザのネイティブスクロールを発生させない。
  // DOM 選択の同期は続く `view.focus()` に任せ、スクロール判定は下の専用経路だけが行う。
  editor.view.dom.focus({ preventScroll: true });
  editor.view.focus();
  if (
    activeMarks
    && editor.state.selection.empty
    && editor.state.storedMarks !== activeMarks
  ) {
    editor.view.dispatch(editor.state.tr.setStoredMarks(activeMarks));
  }
  // 配り直したキャレットは ProseMirror のスクロール追従を通らない (transaction に
  // `scrollIntoView` を立てていない)。焦点を取った面で必ず可視域へ入れる。既に見えていれば
  // 差分 0 で何も動かさないので、ユーザーのスクロール位置を奪わない。
  scrollCaretIntoView(editor.view);
}

/**
 * この面が見せているブロックの上端から、キャレットまでの縦位置 (拡大前の紙面 px)。
 *
 * 正本は `clip-path` で下を隠されているだけでレイアウト上は全高を占め、複製は
 * `translateY(-sourceOffsetY)` されている。どちらも「ブロックの矩形の上端との差」を取れば
 * 同じ値になるので、面の種類で分岐しない。
 */
function getTextFlowLocalY(
  editor: TiptapEditor,
  address: CaretAddress,
  containerBlockId: string | null,
): number | null {
  const position = getTextFlowSelectionPosition(editor, address);
  if (position === null) {
    return null;
  }
  // 断片の帯 (`sourceOffsetY`) は**分割されたブロック**の上端が原点。キャレットが載っている
  // 葉ブロックの上端から測ると、どの断片でもほぼ 0 になって宛先が決まらない。
  const blockElement = getTextFlowBlockElement(editor, containerBlockId ?? address.blockId);
  if (!blockElement) {
    return null;
  }
  let caretTop: number;
  try {
    caretTop = editor.view.coordsAtPos(position).top;
  } catch {
    return null;
  }
  const rect = blockElement.getBoundingClientRect();
  // 倍率は実寸との比で取る (`clip-path` は `offsetHeight` を変えないので純粋な表示倍率)。
  const scale = blockElement.offsetHeight > 0 ? rect.height / blockElement.offsetHeight : 1;
  const zoomScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
  return (caretTop - rect.top) / zoomScale;
}

function readMountedEditorDom(editor: TiptapEditor | null | undefined): HTMLElement | null {
  if (!editor || editor.isDestroyed) {
    return null;
  }
  try {
    const dom = editor.view.dom;
    return dom instanceof HTMLElement ? dom : null;
  } catch {
    return null;
  }
}

function getTextFlowBlockElement(editor: TiptapEditor, blockId: string): HTMLElement | null {
  const root = readMountedEditorDom(editor);
  if (!root) {
    return null;
  }
  const escaped = typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(blockId)
    : blockId.replace(/["\\]/g, "\\$&");
  return root.querySelector<HTMLElement>(`[data-sigma-doc-id="${escaped}"]`);
}

/** キャレットのブロックを含んでいる「分割されたブロック」の id。 */
function resolveFragmentBlockId(
  blocks: readonly TextFlowBlock[],
  sourceLayouts: Record<string, TextFlowBoxFragmentSourceLayout>,
  replicaBlockId: string | undefined,
  blockId: string,
): string | null {
  if (replicaBlockId) {
    const owns = blockId === replicaBlockId
      || blocks.some((block) => (
        block.id === replicaBlockId && bodyTextFlowBlockContainsId(block, blockId)
      ));
    return owns ? replicaBlockId : null;
  }
  const owner = blocks.find((block) => (
    block.id in sourceLayouts && bodyTextFlowBlockContainsId(block, blockId)
  ));
  return owner?.id ?? null;
}

/** 上下移動でキャレットが動いたことを、選択の購読者へ知らせる。 */
function publishCaretMove(editor: TiptapEditor, preferredX: number | null): void {
  const bookmark = getTextFlowSelectionBookmark(editor, preferredX);
  if (bookmark) {
    publishTextFlowSelectionBookmark(bookmark);
  }
}

/**
 * 段組みセクション (CSS multicol) が絡むテキストブロック境界の矢印移動の行き先。
 *
 * Chromium のネイティブキャレット移動は multicol の境界で信用できない:
 *
 * - 外→中・中→外の ← / → は渡れず、キャレットが動かない。
 * - 段を跨ぐ ↑ / ↓ は DOM 選択だけが動いて ProseMirror の選択が古いまま残ることがある。
 *
 * 行き先が論理的に決まる形 (テキストブロックの端 × 隣のテキストブロックがセクションの中か
 * 反対側) だけをここで解決し、セクションが絡まない境界は従来どおりネイティブに任せる。
 */
function resolveLayoutSectionArrowJump(
  view: EditorView,
  direction: "forward" | "backward" | "up" | "down",
): ProseMirrorSelection | null {
  const state = view.state;
  const { $head, empty } = state.selection;
  if (!empty || $head.depth === 0) {
    return null;
  }
  // 端の判定は方向で分ける。左右は論理オフセットで決まる (幾何を見ないので multicol でも
  // 揺れない)。上下は端の行かどうか — `endOfTextblock` は multicol の中で偽陰性を出すので
  // 幾何の補いが入った判定を使う。
  const atEdge = direction === "forward"
    ? $head.parentOffset === $head.parent.content.size
    : direction === "backward"
      ? $head.parentOffset === 0
      : caretAtTextblockEdgeLine(view, direction);
  if (!atEdge) {
    return null;
  }
  const forward = direction === "forward" || direction === "down";
  const doc = state.doc;
  const boundary = forward ? $head.after($head.depth) : $head.before($head.depth);
  if (boundary < 0 || boundary > doc.content.size) {
    return null;
  }
  const near = TextSelection.near(doc.resolve(boundary), forward ? 1 : -1);
  if (near.$head.parent === $head.parent) {
    return null;
  }
  const fromSection = layoutSectionAncestorPos($head);
  const toSection = layoutSectionAncestorPos(near.$head);
  if (direction === "forward" || direction === "backward") {
    // 左右はセクションの境界を渡るときだけ。中どうしはネイティブで足りる。
    return fromSection !== toSection ? near : null;
  }
  // 上下は「セクションの中」であれば介入する。ページ紙面のセクションは**ユニットとして**
  // 描かれ、その editor の doc に layoutSection ノードは無い (multicol はユニットの殻の
  // CSS)。doc の祖先では判定できないので、殻の DOM で判定する。
  if (fromSection === null && toSection === null
    && !view.dom.closest(".layout-section-paper-body")) {
    return null;
  }
  return near;
}

/**
 * セクション境界の上下ジャンプを適用する。行き先の**ブロック**は doc 位置で決まっているので、
 * その行の中の横位置だけ `preferredX` (画面 px) で選び直す — 上下移動の列を保つ。
 */
function applyLayoutSectionArrowJump(
  view: EditorView,
  jump: ProseMirrorSelection,
  preferredX: number,
): void {
  view.dispatch(view.state.tr.setSelection(jump).scrollIntoView());
  try {
    const top = view.coordsAtPos(view.state.selection.head).top;
    const refined = view.posAtCoords({ left: preferredX, top: top + 1 })?.pos;
    if (refined !== undefined) {
      const $refined = view.state.doc.resolve(refined);
      if ($refined.parent === view.state.selection.$head.parent) {
        view.dispatch(view.state.tr.setSelection(TextSelection.near($refined, 1)));
      }
    }
  } catch {
    // 横位置の微調整は失敗しても致命ではない。
  }
}

/** その位置を含む段組みセクションの doc 位置。セクションの外なら null。 */
function layoutSectionAncestorPos(position: ProseMirrorSelection["$head"]): number | null {
  for (let depth = position.depth; depth > 0; depth -= 1) {
    if (position.node(depth).type.name === "layoutSection") {
      return position.before(depth);
    }
  }
  return null;
}

/**
 * 分割されたブロックの直前 / 直後のブロックへキャレットを置く。行き先の**ブロック**は doc
 * 位置で決め、その行の中の横位置だけ `preferredX` で選ぶ。
 */
function focusTextFlowCaretAfterBlock(
  editor: TiptapEditor,
  containerBlockId: string,
  direction: "up" | "down",
  preferredX: number | null,
): boolean {
  let containerPosition: number | null = null;
  let containerSize = 0;
  editor.state.doc.descendants((node, nodePosition) => {
    if (containerPosition !== null) {
      return false;
    }
    if (node.attrs.sigmaDocId === containerBlockId) {
      containerPosition = nodePosition;
      containerSize = node.nodeSize;
      return false;
    }
    return true;
  });
  if (containerPosition === null) {
    return false;
  }
  const start: number = containerPosition;
  const end = start + containerSize;
  const boundary = direction === "down" ? end : start;
  try {
    const doc = editor.state.doc;
    if (boundary < 0 || boundary > doc.content.size) {
      return false;
    }
    const near = TextSelection.near(doc.resolve(boundary), direction === "down" ? 1 : -1);
    // 近傍探索がブロックの中へ戻ってしまったら、その向きに出口は無い。
    if (near.head > start && near.head < end) {
      return false;
    }
    editor.view.dispatch(editor.state.tr.setSelection(near));
    focusTextFlowSurface(editor, null);
    if (preferredX === null) {
      // 左右移動の出口。論理的な端 (直後の先頭 / 直前の末尾) がそのまま答えで、横位置は選ばない。
      return true;
    }
    // 行が決まったので、その行の中の横位置だけ `preferredX` で選び直す。
    try {
      const top = editor.view.coordsAtPos(editor.state.selection.head).top;
      const root = readMountedEditorDom(editor);
      if (!root) {
        return true;
      }
      const band = getCaretSurfaceBand(root, null);
      const left = clampNumber(preferredX, band.left + 1, band.right - 1);
      const refined = editor.view.posAtCoords({ left, top: top + 1 })?.pos;
      if (refined !== undefined && refined > start === refined > end) {
        editor.view.dispatch(
          editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(refined), 1)),
        );
      }
    } catch {
      // 横位置の微調整は失敗しても致命ではない。
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * 画面上の座標にいちばん近い位置へキャレットを置き、この面にフォーカスを取る。
 * `preferredX` は client px、`clientY` も client px。
 */
function focusTextFlowCaretAtClientPoint(
  editor: TiptapEditor,
  preferredX: number,
  clientY: number,
  band: { bottom: number; left: number; right: number; top: number },
): boolean {
  if (editor.isDestroyed || band.bottom - band.top < 2) {
    return false;
  }
  const left = clampNumber(preferredX, band.left + 1, band.right - 1);
  const top = clampNumber(clientY, band.top + 1, band.bottom - 1);
  const position = editor.view.posAtCoords({ left, top })?.pos;
  if (position === undefined) {
    return false;
  }
  try {
    const selection = TextSelection.near(editor.state.doc.resolve(position), 1);
    editor.view.dispatch(editor.state.tr.setSelection(selection));
  } catch {
    return false;
  }
  focusTextFlowSurface(editor, null);
  return true;
}

export function setTextFlowContentPreservingSelection(
  editor: TiptapEditor,
  blocks: TextFlowBlock[],
): void {
  if (sessionProjectionEditors.has(editor)) {
    applySharedTextFlowProjection(editor, blocks);
    return;
  }
  countPerformanceEvent("TextFlowEditor.fullProjectionReset");
  const selection = getTextFlowSelectionBookmark(editor, null);
  const wasFocused = editor.isFocused;
  const activeMarks = editor.state.selection.empty
    ? editor.state.storedMarks ?? (
      editor.state.selection.$from.parentOffset > 0
        ? editor.state.selection.$from.marks()
        : null
    )
    : null;
  editor.commands.setContent(textFlowToTiptap(blocks), { emitUpdate: false });
  const measuredDom = readMountedEditorDom(editor);
  if (measuredDom) acknowledgeTextFlowContent(measuredDom, getTextFlowBlocksSyncKey(blocks));
  if (selection) {
    const restored = applyTextFlowSelectionBookmark(editor, selection);
    if (restored.applied && wasFocused) {
      focusTextFlowSurface(editor, restored.activeMarks);
    }
  }
  if (activeMarks && editor.state.selection.empty) {
    editor.view.dispatch(editor.state.tr.setStoredMarks(activeMarks));
  }
}

/** Bind a logical CRDT projection to this view with mapped ProseMirror positions.
 * Continuations still dispatch through FragmentEditSession; they own no Y.Doc.
 */
export function applySharedTextFlowProjection(editor: TiptapEditor, blocks: TextFlowBlock[]): void {
  applyEditorDocumentProjection(editor, textFlowToTiptap(blocks));
  const dom = readMountedEditorDom(editor);
  if (dom) acknowledgeTextFlowContent(dom, getTextFlowBlocksSyncKey(blocks));
}

function getSelectedTextBlockId(editor: TiptapEditor): string | null {
  return getTextFlowBlockIdAtPosition(editor, editor.state.selection.from);
}

function getBoxBlockIdAtContext(editor: TiptapEditor, target: EventTarget | null): string | null {
  if (target instanceof Element) {
    const boxElement = target.closest<HTMLElement>('.sigma-doc-box-block[data-sigma-doc-id]');
    const boxId = boxElement?.dataset.sigmaDocId;
    if (boxId) {
      return boxId;
    }
  }

  const { $from } = editor.state.selection;
  const boxDepth = findAncestorNodeDepth($from, "boxBlock");
  if (boxDepth < 0) {
    return null;
  }

  const boxId = $from.node(boxDepth).attrs.sigmaDocId;
  return typeof boxId === "string" && boxId ? boxId : null;
}

function getClosestTextFlowBlockId(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) {
    return null;
  }

  const block = target.closest<HTMLElement>("[data-sigma-doc-id]");
  const id = block?.getAttribute("data-sigma-doc-id");
  return id || null;
}

function getClosestBoxActionButton(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) {
    return null;
  }

  return target.closest<HTMLElement>(".sigma-doc-box-action-button[data-box-action-button='true']");
}

function getBoundaryDeleteRequest(
  state: EditorState,
  event: KeyboardEvent,
  blocks: TextFlowBlock[],
): TextFlowBoundaryDeleteRequest | null {
  if (
    (event.key !== "Backspace" && event.key !== "Delete") ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.isComposing ||
    !state.selection.empty
  ) {
    return null;
  }

  const direction = event.key === "Backspace" ? "backward" : "forward";
  const { $from } = state.selection;
  const parent = $from.parent;
  if (parent.type.name !== "paragraph" && parent.type.name !== "heading") {
    return null;
  }

  const blockId = parent.attrs.sigmaDocId;
  if (typeof blockId !== "string") {
    return null;
  }

  const blockIndex = blocks.findIndex((block) => block.id === blockId);
  if (blockIndex < 0) {
    return null;
  }

  if (direction === "backward") {
    if (blockIndex > 0 || state.selection.from !== $from.start()) {
      return null;
    }
  } else if (blockIndex < blocks.length - 1 || state.selection.from !== $from.end()) {
    return null;
  }

  return {
    direction,
    blockId,
    emptyBlock: isEmptyEditorTextBlock(parent),
  };
}

/**
 * 本文ユニットは 1 文書あたり数十個あり、打鍵のたびに親から描き直される。ここで memo を
 * 効かせるために、props はユニット局所かつ参照安定にしてある (`TextFlowWithInlineContent`)。
 */
export const TextFlowEditor = memo(TextFlowEditorImpl);
