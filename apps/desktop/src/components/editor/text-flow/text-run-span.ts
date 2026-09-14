import type { Editor } from "@tiptap/core";
import { DOMSerializer, Fragment, Slice } from "@tiptap/pm/model";
import { AllSelection, TextSelection, type Selection } from "@tiptap/pm/state";
import type { MouseEvent as ReactMouseEvent } from "react";

import { getEditorSideAtClientPoint, startExpandedTextSelection } from "@/components/editor/expanded-text-selection";
import {
  isMultiEditorRunSelection,
  resolveRunEditorAtPoint,
  resolveRunSelectionRanges,
  type TextRunCaretPoint,
  type TextRunEditorRange,
} from "@/components/editor/page-canvas/text-run-selection";
import { readSelectionFontSize, type SelectionFontSize } from "@/components/tiptap/text-format-font-size";
import { applyTextFormatCommand } from "@/components/tiptap/text-format-controller";
import {
  createDocumentBlocksClipboardPayload,
  createTextFlowClipboardPayload,
  getEditorClipboardPlainText,
  isTextFlowClipboardBlock,
  writeEditorClipboardData,
  writeTextSliceClipboardData,
} from "@/lib/editor-clipboard";
import { PROBLEM_AREA_ORDER, type SigmaBlock } from "@/features/document";
import { posAtClientPoint } from "@/components/editor/text-flow/pos-at-client-point";
import { localColumnAtPoint } from "./local-column-dom";
import { createId } from "@/lib/id";
import { tiptapNodesToInlineNodes } from "@/lib/tiptap-adapter";
import {
  getTextFlowBlockEditorLength,
  getTextFlowBlockIds,
  type TextFlowBlock,
  type TextFlowSelectionBookmark,
  collapsedCaretBookmark,
  textCaretAddress,
} from "@/features/text-editing";

import { collectBlockIdsInRange } from "./body-shape-selection";
import {
  collectRangeEmptyLineRects,
  collectRangeLineEndFillRects,
  type SelectionHighlightRect,
} from "./selection-highlight-rects";
import {
  buildTextRunReplacementMutations,
  joinCompatibleTextBlocks,
  type TextRunReplacementMutation,
  type TextRunReplacementOptions,
  type TextRunReplacementSegment,
} from "./text-run-replacement";
import {
  wrapTextRunBlocksInContainers,
  type TextRunContainerEntry,
  type TextRunScopeContainer,
} from "./text-run-containers";
import { emptyTextFlowParagraph, sliceToTextFlowBlocks } from "./text-run-slice";
import { textFlowBlockToTiptapNode } from "./tiptap-document-adapter";
import {
  getTextRunSurface,
  getTextRunSurfaceByViewDom,
  getTextRunSurfaces,
  subscribeCaretSurfaceUnregister,
} from "./caret-router";
import type { TextFlowChangeContext } from "./types";
import {
  createDragAutoScroller,
  findDragAutoScrollScroller,
  getDragAutoScrollViewportBounds,
  panDragAutoScrollElement,
} from "../drag-auto-scroll";

const DRAG_SELECTION_THRESHOLD_PX = 2;
// 本文選択は文字を狙う操作なので、図形運搬の 1100px/s とは分ける。従来の最大
// 8px/frame を 60Hz 換算した 480px/s に留め、選択範囲が飛びすぎないようにする。
const TEXT_SELECTION_AUTO_SCROLL_MAX_SPEED_PX_PER_SEC = 480;

export interface TextRunEditorHandle {
  /**
   * 跨ぎ置換の書き込み結果を、React の受動同期を待たずこのユニットの PM doc へ即時反映
   * する (selection があればキャレットも置いて焦点を当てる)。受動同期だけだと、同期前に
   * 届いた次の打鍵が「置換前の選択が張られた古い doc」を編集してしまう。
   */
  applyCrossEditorSync: (
    nextBlocks: TextFlowBlock[],
    selection: TextFlowSelectionBookmark | null,
  ) => void;
  editor: Editor;
  getBlocks: () => TextFlowBlock[];
  groupId: string;
  /**
   * 跨ぎ置換 (エディタの外で組み立てた変更) がこのユニットに触れた印。焦点エディタの
   * 受動同期は「ブロック id 列が同じなら何もしない」ため、印が無いと id 列不変のまま
   * 内容だけ変わったユニットに旧内容が残る。
   */
  /**
   * 跨ぎ置換の印。`historyGroup` は混在ペースト / 混在カットのコアレスキーで、
   * 再チャンクが起こす後続の `onUpdate` にも同じキーを刻ませるために配る
   * (配らないと本文書き込みと図形保存の間に別エントリが挟まる)。
   */
  markCrossEditorSync: (selection: TextFlowSelectionBookmark | null, historyGroup?: string) => void;
  onChange: (
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    activeBlockId?: string | null,
    context?: TextFlowChangeContext,
  ) => void;
  order: number;
  preserveEmpty: boolean;
  /**
   * このユニットが「本文のどの入れ物の中身か」。段組セクションはユニットごとに別エディタで、
   * その doc には段落しか入っていない。コピーでセクションごと運ぶにはここから組み直す。
   */
  scopeContainer?: TextRunScopeContainer;
  scopeId: string;
  unitId: string;
}

export type { TextRunContainerFrame, TextRunScopeContainer } from "./text-run-containers";

export interface TextRunSpan {
  anchor: TextRunCaretPoint;
  groupId: string;
  head: TextRunCaretPoint;
}

const spanListeners = new Set<() => void>();
let activeSpan: TextRunSpan | null = null;

/** IME 合成後の境界結合の予約: 削除書き込み後のブロック列を前提に、結合先ブロックを指す。 */
interface SpanCompositionBoundaryJoin {
  /** 結合に関与する境界ブロック (選択始端の断片 / 終端の残余断片) の id。 */
  blockId: string;
  /** 境界ブロックを持つユニット (scope グループの writer)。 */
  unitId: string;
  /** 削除書き込み後のこのグループのブロック列 (境界結合の previousIds / nextBlocks の出典)。 */
  nextBlocks: TextFlowBlock[];
}

interface PendingSpanComposition {
  editor: Editor;
  groupId: string;
  /** compositionstart の他ユニット削除と同じグループ。合成挿入と境界結合も同じ鍵で記録し、undo 1 回で全体を戻す。 */
  historyGroup: string;
  /** 選択始端がブロック途中のとき、打鍵経路では始端断片と挿入が結合される (後方ドラッグ + IME)。 */
  leadingJoin: SpanCompositionBoundaryJoin | null;
  /** 選択終端がブロック途中のとき、打鍵経路では挿入と終端の残余断片が結合される (前方ドラッグ + IME)。 */
  trailingJoin: SpanCompositionBoundaryJoin | null;
}

let pendingSpanComposition: PendingSpanComposition | null = null;

/**
 * 面が本当に消えたときだけ、その面に掛かっていた跨ぎ選択と IME 合成の予約を捨てる。
 * 登録は `caret-router` が一手に持つので、担当ブロック列が変わっただけでは呼ばれない
 * (以前は打鍵のたびに再登録が走り、この後始末が跨ぎ選択を消していた)。
 */
subscribeCaretSurfaceUnregister((handle) => {
  const textRun = handle.textRun;
  if (!textRun) {
    return;
  }
  if (pendingSpanComposition?.editor === handle.editor) {
    pendingSpanComposition = null;
  }
  if (activeSpan?.anchor.unitId === textRun.unitId || activeSpan?.head.unitId === textRun.unitId) {
    clearTextRunSpan();
  }
});

export function getTextRunEditors(groupId: string): TextRunEditorHandle[] {
  return getTextRunSurfaces(groupId);
}

export { getFocusedCaretSurfaceUnitIds as getFocusedTextRunUnitIds } from "./caret-router";

export function getActiveTextRunSpan(): TextRunSpan | null {
  return activeSpan;
}

export function subscribeTextRunSpan(listener: () => void): () => void {
  spanListeners.add(listener);
  return () => {
    spanListeners.delete(listener);
  };
}

export function clearTextRunSpan(): void {
  setActiveTextRunSpan(null);
}

export function isMultiEditorTextRunSpan(): boolean {
  const span = activeSpan;
  if (!span) {
    return false;
  }
  return isMultiEditorRunSelection(rangesForSpan(span));
}

/**
 * keydown を経ずに handleTextInput へ届いたテキスト挿入 (絵文字パレット・音声入力・
 * Option+文字・ロック中に届いた IME 確定)。単一エディタと同じく、跨ぎ選択をその
 * テキストで置換する。置換が拒否されても (AI ロック等) イベントは飲み込む — PM 既定へ
 * 流すと焦点エディタの担当分だけが置換されてしまう。
 */
export function handleTextRunSpanTextInput(viewDom: HTMLElement, text: string): boolean {
  const span = activeSpan;
  if (!span || !isMultiEditorTextRunSpan()) {
    return false;
  }
  // 置換の対象になるのは span のグループに登録されたエディタだけ。未登録のエディタ
  // (ページ跨ぎ box の継続 fragment / ヘッダー・フッター / 素材ダイアログ) の入力まで
  // 飲み込むと、span が生きている間そのエディタに文字が入らなくなる。
  const handle = getTextRunSurfaceByViewDom(viewDom);
  if (handle?.groupId !== span.groupId) {
    return false;
  }
  if (text.length > 0) {
    replaceActiveTextRunSpan(buildSpanTypedTextInsertion(span, text));
  }
  return true;
}

/**
 * 跨ぎ選択をタイプ入力で置換するときの挿入段落。単一エディタの insertText は
 * `$from.marksAcross($to)` で削除範囲のマークを新しいテキストへ引き継ぐ (太字や赤字の
 * 選択に 1 文字打っても書式が保たれる) ため、span でも文書順先頭の断面から同じ規則で
 * マークを継ぐ。素の text ノードで組むと、同じ選択でもチャンク内なら書式が残り跨ぎなら
 * 消える、という境界可視の書式非一貫になる。
 */
function buildSpanTypedTextInsertion(span: TextRunSpan, text: string): TextFlowBlock[] {
  const paragraphId = emptyTextFlowParagraph().id;
  const plain: TextFlowBlock[] = [{
    type: "paragraph",
    id: paragraphId,
    children: [{ type: "text", text }],
  }];
  const range = rangesForSpan(span)[0];
  const handle = range
    ? handlesForSpan(span).find((candidate) => candidate.unitId === range.unitId)
    : undefined;
  if (!range || !handle) {
    return plain;
  }
  try {
    const doc = handle.editor.state.doc;
    const marks = doc.resolve(range.from).marksAcross(doc.resolve(range.to));
    if (!marks || marks.length === 0) {
      return plain;
    }
    const children = tiptapNodesToInlineNodes([
      { type: "text", text, marks: marks.map((mark) => mark.toJSON() as { type: string }) },
    ]);
    return children.length > 0
      ? [{ type: "paragraph", id: paragraphId, children }]
      : plain;
  } catch {
    return plain;
  }
}

/**
 * IME 合成の開始。compositionstart は preventDefault できず、合成テキストは必ず
 * 「合成開始時にネイティブ選択があった DOM」へ入るため、焦点エディタの doc / DOM には
 * 一切触らず (触ると IME セッションが切れる)、担当分の置換は単一エディタと同じ経路
 * (IME がネイティブ選択を合成テキストで置換 → PM の DOM 差分適用) に任せる。ここでは
 * 焦点エディタ以外のユニットが担う範囲だけを削除し、span を解除する。
 *
 * 境界の段落結合 (通常の打鍵が行う結合) は合成中には行えないため、compositionend 後に
 * `finishTextRunSpanComposition` が同じ historyGroup でやり直し、打鍵と同じ最終文書
 * (境界結合・空段落なし) に揃える。
 */
export function beginTextRunSpanComposition(viewDom: HTMLElement): void {
  const span = activeSpan;
  if (!span || !isMultiEditorTextRunSpan()) {
    return;
  }
  const handle = getTextRunSurfaceByViewDom(viewDom);
  if (handle?.groupId !== span.groupId) {
    return;
  }

  const runEditors = getTextRunEditors(span.groupId);
  const ranges = rangesForSpan(span);
  const focusedIndex = runEditors.findIndex((candidate) => candidate.unitId === handle.unitId);
  if (!ranges.some((range) => range.unitId === handle.unitId) || focusedIndex < 0) {
    // 合成先エディタが span の範囲外 (通常は起きない)。従来どおり全体を削除して、
    // 合成テキストは焦点エディタのキャレット位置へ入る。
    replaceActiveTextRunSpan([]);
    return;
  }

  const otherRanges = ranges.filter((range) => range.unitId !== handle.unitId);
  if (!canReplaceRanges(runEditors, otherRanges)) {
    // AI ロック等。span は保ち、確定テキストは handleTextRunSpanTextInput が飲み込む
    // (焦点エディタ自身のロックはそのエディタの filterTransaction が止める)。
    return;
  }

  // 合成エディタの選択は畳まない: そのネイティブ選択がまさに IME の置換対象。
  setActiveTextRunSpan(null, handle.unitId);
  const unitOrder = new Map(runEditors.map((candidate, index) => [candidate.unitId, index]));
  // 焦点ユニットを挟んで前後は不連続なので、束ね先 (scope 単位のグループ化) が焦点を
  // 跨がないよう別々の置換として流す。undo は合成挿入・境界結合も含めて 1 グループ
  // (`getTextRunSpanCompositionHistoryGroup` が焦点エディタの onUpdate に同じ鍵を配る)。
  const sides = [
    otherRanges.filter((range) => (unitOrder.get(range.unitId) ?? 0) < focusedIndex),
    otherRanges.filter((range) => (unitOrder.get(range.unitId) ?? 0) > focusedIndex),
  ];
  const historyGroup = createId("text_run_span_history");
  for (const sideHandle of runEditors) {
    if (sideHandle.unitId !== handle.unitId) {
      // キャレットは焦点エディタの合成位置が正。bookmark 復元で焦点を奪わないよう
      // selection は付けない。
      sideHandle.markCrossEditorSync(null);
    }
  }
  let leadingJoin: SpanCompositionBoundaryJoin | null = null;
  let trailingJoin: SpanCompositionBoundaryJoin | null = null;
  sides.forEach((side, sideIndex) => {
    if (side.length === 0) {
      return;
    }
    const segments = buildReplacementSegments(runEditors, side);
    const mutations = buildTextRunReplacementMutations(
      segments,
      [],
      emptyTextFlowParagraph,
      // 焦点ユニットは必ず本文を残す (合成テキストが入る) ので、空段落フォールバックは不要。
      { hasBlocksOutsideSpan: true },
    );
    // 打鍵経路なら結合される境界断片を覚えて compositionend 後に結合する。前側 (焦点より
    // 文書順で前) は選択始端の断片 = 先頭 mutation の末尾ブロック、後側は終端の残余断片 =
    // 末尾 mutation の先頭ブロック。
    if (sideIndex === 0) {
      const boundary = segments[0]?.startsInsideTextBlock === true
        ? mutations[0]?.nextBlocks.at(-1)
        : undefined;
      if (boundary && (boundary.type === "paragraph" || boundary.type === "heading") && mutations[0]) {
        leadingJoin = {
          blockId: boundary.id,
          unitId: mutations[0].unitId,
          nextBlocks: mutations[0].nextBlocks,
        };
      }
    } else {
      const lastMutation = mutations.at(-1);
      const boundary = segments.at(-1)?.endsInsideTextBlock === true
        ? lastMutation?.nextBlocks[0]
        : undefined;
      if (boundary && (boundary.type === "paragraph" || boundary.type === "heading") && lastMutation) {
        trailingJoin = {
          blockId: boundary.id,
          unitId: lastMutation.unitId,
          nextBlocks: lastMutation.nextBlocks,
        };
      }
    }
    for (const mutation of mutations) {
      const writer = runEditors.find((candidate) => candidate.unitId === mutation.unitId);
      writer?.onChange(mutation.previousIds, mutation.nextBlocks, undefined, {
        historyGroup,
        crossEditor: true,
      });
    }
  });

  const record: PendingSpanComposition = {
    editor: handle.editor,
    groupId: span.groupId,
    historyGroup,
    leadingJoin,
    trailingJoin,
  };
  pendingSpanComposition = record;
  const ownerWindow = viewDom.ownerDocument.defaultView ?? window;
  viewDom.addEventListener("compositionend", () => {
    // 既存の同期リトライと同じタイミング: PM が合成の DOM 差分を transaction として
    // 取り込んだ後 (compositionend の次のマクロタスク) に境界結合をやり直す。
    ownerWindow.setTimeout(() => finishTextRunSpanComposition(record), 0);
  }, { once: true });
}

/**
 * 跨ぎ選択への IME 合成中に、焦点エディタの合成 transaction を compositionstart の
 * 他ユニット削除・compositionend 後の境界結合と同じ undo グループへ載せるための鍵。
 * 別グループに割れると、Cmd+Z 1 回で「合成消滅 + 他チャンク削除のまま」の中間状態が出る。
 */
export function getTextRunSpanCompositionHistoryGroup(editor: Editor): string | null {
  return pendingSpanComposition?.editor === editor ? pendingSpanComposition.historyGroup : null;
}

/**
 * IME 合成の終了処理: 打鍵の置換なら行われていた境界の段落結合をやり直す。合成中は焦点
 * エディタの doc に触れない契約 (`beginTextRunSpanComposition`) のため、合成テキストが
 * PM に取り込まれた後のここで、選択始端/終端の断片を合成段落と結合して打鍵と同じ最終
 * 文書にする。書き込みは合成と同じ historyGroup — undo 1 回で IME 置換全体が戻る。
 */
function finishTextRunSpanComposition(record: PendingSpanComposition): void {
  if (pendingSpanComposition !== record) {
    return;
  }
  pendingSpanComposition = null;
  const editor = record.editor;
  if (editor.isDestroyed || editor.view.composing) {
    return;
  }
  const focusedHandle = getTextRunSurface(editor);
  if (!focusedHandle || focusedHandle.groupId !== record.groupId) {
    return;
  }
  // span の anchor は必ず選択の端なので、前側・後側の結合予約が同時に立つことはない
  // (両側が断片になるのは Cmd+A だが、そのときは両端ともブロック境界で予約されない)。
  const join = record.trailingJoin ?? record.leadingJoin;
  if (!join) {
    return;
  }
  const runEditors = getTextRunEditors(record.groupId);
  const sideHandle = runEditors.find((candidate) => candidate.unitId === join.unitId);
  if (!sideHandle || sideHandle.editor.isDestroyed) {
    return;
  }

  const doc = editor.state.doc;
  const focusedBlocks = sliceToTextFlowBlocks(doc.slice(0, doc.content.size), focusedHandle.getBlocks());
  const composed = record.trailingJoin ? focusedBlocks.at(-1) : focusedBlocks[0];
  const boundary = record.trailingJoin ? join.nextBlocks[0] : join.nextBlocks.at(-1);
  if (!composed || boundary?.id !== join.blockId) {
    return;
  }

  const focusedPreviousIds = getTextFlowBlockIds(focusedBlocks);
  const sidePreviousIds = getTextFlowBlockIds(join.nextBlocks);
  let writes: Array<{
    handle: TextRunEditorHandle;
    previousIds: string[];
    nextBlocks: TextFlowBlock[];
    selection?: TextFlowSelectionBookmark;
  }>;
  if (record.trailingJoin) {
    // 前方の選択 + IME: 合成段落 (焦点ユニット末尾) に終端の残余断片を結合する。
    // キャレットは合成テキスト末尾 = 結合前の合成段落の長さ。
    const joined = joinCompatibleTextBlocks(composed, boundary);
    if (!joined) {
      return;
    }
    const caret = textCaretAddress(joined.id, getTextFlowBlockEditorLength(composed));
    writes = [
      {
        handle: focusedHandle,
        previousIds: focusedPreviousIds,
        nextBlocks: [...focusedBlocks.slice(0, -1), joined],
        selection: collapsedCaretBookmark(caret),
      },
      { handle: sideHandle, previousIds: sidePreviousIds, nextBlocks: join.nextBlocks.slice(1) },
    ];
  } else {
    // 後方の選択 + IME: 選択始端の断片 (前側ユニット末尾) に合成段落を結合する。id は
    // 打鍵経路と同じく先行側が残り、キャレットは合成テキスト末尾 (断片の長さ + 焦点
    // エディタのキャレット offset) に置く。
    const joined = joinCompatibleTextBlocks(boundary, composed);
    if (!joined) {
      return;
    }
    const head = editor.state.selection.head;
    const resolvedHead = doc.resolve(clamp(head, 0, doc.content.size));
    const composedOffset = resolvedHead.parent.isTextblock
      ? resolvedHead.parentOffset
      : getTextFlowBlockEditorLength(composed);
    const caret = textCaretAddress(
      joined.id,
      getTextFlowBlockEditorLength(boundary) + composedOffset,
    );
    writes = [
      {
        handle: sideHandle,
        previousIds: sidePreviousIds,
        nextBlocks: [...join.nextBlocks.slice(0, -1), joined],
        selection: collapsedCaretBookmark(caret),
      },
      { handle: focusedHandle, previousIds: focusedPreviousIds, nextBlocks: focusedBlocks.slice(1) },
    ];
  }

  // 跨ぎ置換と同じ規約: グループ全体へ印を付け、キャレットの乗るユニットは即時同期する。
  const selectionByUnitId = new Map(writes.map((write) => [write.handle.unitId, write.selection ?? null]));
  for (const groupHandle of runEditors) {
    groupHandle.markCrossEditorSync(selectionByUnitId.get(groupHandle.unitId) ?? null);
  }
  for (const write of writes) {
    write.handle.onChange(write.previousIds, write.nextBlocks, write.selection?.head.blockId, {
      historyGroup: record.historyGroup,
      selection: write.selection,
      crossEditor: true,
    });
  }
  const caretWrite = writes.find((write) => write.selection);
  if (caretWrite?.selection) {
    caretWrite.handle.applyCrossEditorSync(caretWrite.nextBlocks, caretWrite.selection);
  }
}

/**
 * span のグループ外のエディタに焦点が移ったら span を解除する。残すと選択帯が出たまま、
 * そのエディタへの文字入力を span 側の handleTextInput が飲み込み続ける。
 */
export function clearTextRunSpanOnOutsideFocus(editor: Editor): void {
  const span = activeSpan;
  if (span && getTextRunSurface(editor)?.groupId !== span.groupId) {
    clearTextRunSpan();
  }
}

/**
 * ページ余白などエディタ群の外への pointerdown による跨ぎ選択の解除。単一エディタの
 * 「余白クリックで選択解除」に合わせる。クリックでフォーカスは body へ移るため、DOM
 * フォーカスの有無に依らず全ユニットの状態選択を畳む — 残すと帯が出たまま Escape も
 * 文字入力もエディタへ届かず、本文を再クリックするまで操作不能になる。
 */
export function clearTextRunSpanOnOutsidePointerDown(): void {
  const span = activeSpan;
  if (!span) {
    return;
  }
  const runEditors = getTextRunEditors(span.groupId);
  clearTextRunSpan();
  for (const handle of runEditors) {
    const editor = handle.editor;
    if (!editor.isDestroyed && !editor.state.selection.empty) {
      const head = editor.state.selection.head;
      setNativeEditorRange(editor, head, head);
    }
  }
}

/** Route blank grid space to the editor belonging to the clicked column. */
export function startLocalColumnPointerSelection(event: ReactMouseEvent<HTMLElement>): boolean {
  if (!(event.target instanceof Element)
    || event.target.closest("[contenteditable='true'], button, input, textarea, select, math-field")) return false;
  const grid = event.currentTarget;
  const column = localColumnAtPoint(grid, event.clientX);
  if (!column) return false;
  const editors = [...column.querySelectorAll<HTMLElement>(".text-flow-editor")]
    .map(dom => getTextRunSurfaceByViewDom(dom))
    .filter((handle): handle is TextRunEditorHandle => handle !== null);
  const handle = editorAtPoint(editors, event.clientX, event.clientY);
  if (!handle) return false;
  const handled = startTextRunPointerSelection(event, handle.editor, handle.groupId);
  if (handled) event.stopPropagation();
  return handled;
}

export function startTextRunPointerSelection(
  event: ReactMouseEvent<HTMLElement>,
  editor: Editor,
  groupId: string,
): boolean {
  if (
    editor.isDestroyed || event.button !== 0 || event.defaultPrevented
    || event.metaKey || event.ctrlKey || event.altKey
    || (event.target instanceof Element && event.target.closest("input, textarea, select, button, math-field"))
  ) {
    return false;
  }
  // 編集面が一つでも、本文の左ドラッグは同じ追跡処理が担当する。
  const runEditors = getTextRunEditors(groupId);
  const handle = getTextRunSurface(editor);
  if (!handle) {
    return startExpandedTextSelection(event, editor);
  }

  const startPos = posInEditor(editor, event.clientX, event.clientY);
  if (startPos === null) {
    return startExpandedTextSelection(event, editor);
  }

  const shiftAnchor = event.shiftKey ? getPointerSelectionAnchor(handle) : null;
  const initialRange = shiftAnchor
    ? { from: startPos, to: startPos }
    : getClickSelectionRange(editor, startPos, event.detail);
  event.preventDefault();
  // preventDefault でブラウザ既定のフォーカス移動を止めたので自前で当てる。Tiptap の
  // focus コマンドは実際の view.focus() を requestAnimationFrame へ遅延するため、クリック
  // 直後 (次フレーム前) のキー入力が body へ落ちる — 同期の view.focus() で当てる。
  focusEditorViewNow(editor);
  if (!shiftAnchor) {
    setNativeEditorRange(editor, initialRange.from, initialRange.to);
    clearTextRunSpan();
  }

  const startPoint = { x: event.clientX, y: event.clientY };
  const clickDetail = event.detail;
  const gutterSide = !shiftAnchor && clickDetail <= 1
    ? getEditorSideAtClientPoint(editor, startPoint)
    : null;
  let clickAnchor: TextRunCaretPoint | null = gutterSide ? null : {
    unitId: handle.unitId,
    pos: initialRange.from,
  };
  const ownerWindow = editor.view.dom.ownerDocument.defaultView ?? window;

  const updateSelection = (clientX: number, clientY: number) => {
    const target = editorAtPoint(runEditors, clientX, clientY) ?? handle;
    // 余白からのドラッグは、本文へ入った行の端を起点にする。単一編集面の
    // startExpandedTextSelection と同じ規約を、編集面をまたぐ本文にも適用する。
    if (!clickAnchor) {
      const rect = target.editor.view.dom.getBoundingClientRect();
      if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
        return;
      }
      const edgePos = posInEditor(target.editor, gutterSide === "left" ? rect.left + 1 : rect.right - 1, clientY);
      if (edgePos === null) return;
      clickAnchor = { unitId: target.unitId, pos: edgePos };
    }
    const pos = posInEditor(target.editor, clientX, clientY);
    if (pos === null) {
      return;
    }
    const extendsBackward = isExpandedClickDragBackward(runEditors, handle, target, initialRange, pos);
    const anchor = shiftAnchor
      ?? resolveExpandedClickAnchor(handle, initialRange, extendsBackward, clickAnchor);
    // ダブル/トリプルクリックからのドラッグは head も mousedown と同じ粒度 (単語/段落) の
    // 境界へ吸着させる。編集面の分割や文書の長さによって選択の粒度を変えない。
    const headPos = shiftAnchor ? pos : resolveClickDragSelectionHead({
      detail: clickDetail,
      extendsBackward,
      initialRange,
      pos,
      posRange: getClickSelectionRange(target.editor, pos, clickDetail),
    });
    applySpan(groupId, anchor, { unitId: target.unitId, pos: headPos }, target);
  };

  // preventDefault でネイティブ選択を全面代替しているため、ビューポート端へのドラッグで
  // 画面が流れるネイティブの自動スクロールも自前で行う。mousemove はポインタが止まると
  // 来ないので、端の帯にいる間は rAF で回し続ける。
  const scrollContainer = findDragAutoScrollScroller(editor.view.dom);
  const autoScroller = scrollContainer
    ? createDragAutoScroller({
        ownerWindow,
        getViewportBounds: () => getDragAutoScrollViewportBounds(scrollContainer, ownerWindow),
        panBy: (_dx, dy) => panDragAutoScrollElement(scrollContainer, 0, dy),
        onPan: updateSelection,
        maxSpeedPxPerSec: TEXT_SELECTION_AUTO_SCROLL_MAX_SPEED_PX_PER_SEC,
        horizontal: false,
      })
    : null;

  let dragging = false;
  const handleMouseMove = (moveEvent: MouseEvent) => {
    dragging ||= hasDragged(startPoint, moveEvent.clientX, moveEvent.clientY);
    if (!dragging) {
      return;
    }
    moveEvent.preventDefault();
    updateSelection(moveEvent.clientX, moveEvent.clientY);
    autoScroller?.update(moveEvent.clientX, moveEvent.clientY);
  };

  const handleMouseUp = (upEvent: MouseEvent) => {
    if (dragging || hasDragged(startPoint, upEvent.clientX, upEvent.clientY) || shiftAnchor) {
      updateSelection(upEvent.clientX, upEvent.clientY);
      // span 確定。焦点エディタのネイティブ DOM 選択を担当範囲へ合わせる (ドラッグ中の
      // dispatch は PM が DOM 選択へ同期しないため、放置すると IME 置換の対象が
      // アンカー位置の collapsed 選択になる)。
      syncFocusedEditorDomSelectionToSpan();
    }
    autoScroller?.stop();
    ownerWindow.removeEventListener("mousemove", handleMouseMove);
  };

  ownerWindow.addEventListener("mousemove", handleMouseMove);
  ownerWindow.addEventListener("mouseup", handleMouseUp, { once: true });
  return true;
}

export function selectEntireTextRun(editor: Editor): boolean {
  const handle = getTextRunSurface(editor);
  if (!handle) {
    return false;
  }
  const runEditors = getTextRunEditors(handle.groupId);
  if (runEditors.length <= 1) {
    clearTextRunSpan();
    return false;
  }

  const first = runEditors[0];
  const last = runEditors[runEditors.length - 1];
  applySpan(
    handle.groupId,
    { unitId: first.unitId, pos: 0 },
    { unitId: last.unitId, pos: last.editor.state.doc.content.size },
    handle,
  );
  return true;
}

export interface TextRunSpanPaintModel {
  /** 各ユニットの担当範囲から組んだ DOM Range 群。CSS Custom Highlight に登録する。 */
  ranges: Range[];
  /**
   * Highlight が描かない部分の補完矩形: 空行 (テキストを持たない <br>) の「選択された
   * 改行」の印と、行末の塗り (ブロック末尾の改行タブ・折返しで畳まれた空白)。
   */
  emptyLineRects: SelectionHighlightRect[];
}

/**
 * 跨ぎ選択の描画モデル。テキストは CSS Custom Highlight API (`::highlight(text-run-span)`)
 * に登録した live Range をブラウザがグリフの背後へ描く (スクロール・再レイアウトの追従は
 * 不要)。空行と行末 (改行タブ・折返し空白) だけは Highlight が何も描かないため、従来の
 * 矩形オーバーレイが印を補完する。
 */
export function getTextRunSpanPaintModel(): TextRunSpanPaintModel {
  const span = activeSpan;
  const model: TextRunSpanPaintModel = { ranges: [], emptyLineRects: [] };
  if (!span) {
    return model;
  }

  const ranges = rangesForSpan(span);
  ranges.forEach((range, index) => {
    const handle = handlesForSpan(span).find((candidate) => candidate.unitId === range.unitId);
    const domRange = handle ? getEditorDomRange(handle.editor, range.from, range.to) : null;
    if (!domRange) {
      return;
    }
    model.ranges.push(domRange);
    model.emptyLineRects.push(
      ...collectRangeEmptyLineRects(domRange).filter((rect) => rect.width > 0 && rect.height > 0),
      // 最後のユニット以外は、担当範囲の終端の先 (次のユニット) にも選択が続いている。
      ...collectRangeLineEndFillRects(domRange, { continuesBeyondRange: index < ranges.length - 1 })
        .filter((rect) => rect.width > 0 && rect.height > 0),
    );
  });
  return model;
}

/**
 * 跨ぎ選択が覆っているブロック id を文書順で。図形を足す側 (シェル) が使う。
 *
 * PM の `state.selection` はユニット 1 つ分しか指さないので、改ページやチャンク境界を跨いだ
 * 選択では「キャレットのあるページのブロック」しか出てこない。ここは全ユニットの担当範囲
 * から集める。
 */
export function collectTextRunSpanBlockIds(): string[] {
  const span = activeSpan;
  if (!span) {
    return [];
  }

  const runEditors = handlesForSpan(span);
  const blockIds: string[] = [];
  for (const range of rangesForSpan(span)) {
    const handle = runEditors.find((candidate) => candidate.unitId === range.unitId);
    if (handle) {
      blockIds.push(...collectBlockIdsInRange(handle.editor.state, range.from, range.to));
    }
  }
  return [...new Set(blockIds)];
}

export function copyActiveTextRunSpan(dataTransfer: DataTransfer): boolean {
  const span = activeSpan;
  if (!span || !isMultiEditorTextRunSpan()) {
    return false;
  }

  const blocks = selectedBlocksForSpan(span);
  if (blocks.length === 0) {
    return false;
  }

  // 問題のように PM のスキーマに無いブロックが混ざったら、本文ブロックの payload では
  // 運べない (貼り付けが PM の doc へ入れ直す経路なので構造ごと落ちる)。文書ブロックの
  // payload へ切り替えて、貼り付けは SigmaDoc へ直接入れる経路 (EditorShell) が受ける。
  const payload = blocks.every(isTextFlowClipboardBlock)
    ? createTextFlowClipboardPayload(blocks)
    : createDocumentBlocksClipboardPayload(blocks);
  const referenceEditor = handlesForSpan(span)[0]?.editor;
  // text/html と混在コピーの slice は「見えているテキスト」なので、入れ物は解いて渡す。
  // 外部アプリ (Word / Gmail) への貼り付けと図形との混在コピーは今までどおり動く。
  const slice = referenceEditor
    ? textFlowBlocksToSlice(referenceEditor, blocks.flatMap(toSliceTextFlowBlocks))
    : null;
  writeEditorClipboardData(dataTransfer, payload, {
    // text/html には可視 HTML を入れる。空の payload div だけだと、HTML を優先する
    // 外部アプリ (Word / Gmail 等) への貼り付けが空になる。
    html: referenceEditor && slice ? serializeSliceToHtml(referenceEditor, slice) : undefined,
  });
  if (slice) {
    // 図形との混在コピー: overlay の window copy ハンドラが同じ copy イベント内でこの
    // slice を拾い、本文+図形を 1 つの payload (textAndShapes) へまとめ直す (単一
    // エディタの shell onCopy と同じ役割)。ブロック id は原本のまま入れる — 図形の
    // アンカー読み替え (コピー元 id → 貼り付け先 id) がこの id を鍵にする。
    writeTextSliceClipboardData(dataTransfer, slice.toJSON(), getEditorClipboardPlainText(payload));
  }
  return true;
}

/** span の選択ブロックを、コピー系 (HTML 直列化 / 混在コピーの slice) が使う PM slice へ。 */
function textFlowBlocksToSlice(editor: Editor, blocks: readonly TextFlowBlock[]): Slice | null {
  const nodes = blocks
    .map((block) => {
      try {
        return editor.state.schema.nodeFromJSON(textFlowBlockToTiptapNode(block));
      } catch {
        return null;
      }
    })
    .filter((node): node is NonNullable<typeof node> => node !== null);
  if (nodes.length === 0) {
    return null;
  }
  return new Slice(Fragment.fromArray(nodes), 0, 0);
}

function serializeSliceToHtml(editor: Editor, slice: Slice): string {
  const ownerDocument = editor.view.dom.ownerDocument;
  const container = ownerDocument.createElement("div");
  container.appendChild(
    DOMSerializer.fromSchema(editor.state.schema).serializeFragment(slice.content, { document: ownerDocument }),
  );
  return container.innerHTML;
}

export function replaceActiveTextRunSpan(
  insertion: TextFlowBlock[],
  options?: Pick<TextRunReplacementOptions, "splitAtBoundary"> & {
    /**
     * 呼び出し側が鋳造した undo のコアレスキー。混在ペースト / 混在カットは図形側の保存と
     * 同じキーを共有して 1 エントリに畳む (`clipboard-history-group.ts`)。
     */
    historyGroup?: string;
  },
): TextRunReplacementMutation[] | null {
  const span = activeSpan;
  if (!span || !isMultiEditorTextRunSpan()) {
    return null;
  }

  const runEditors = getTextRunEditors(span.groupId);
  const ranges = rangesForSpan(span);
  if (!canReplaceRanges(runEditors, ranges)) {
    return null;
  }

  const segments = buildReplacementSegments(runEditors, ranges);
  const spannedUnitIds = new Set(segments.map((segment) => segment.unitId));
  const mutations = buildTextRunReplacementMutations(segments, insertion, emptyTextFlowParagraph, {
    ...options,
    hasBlocksOutsideSpan: runEditors.some(
      (handle) => !spannedUnitIds.has(handle.unitId) && handle.getBlocks().length > 0,
    ),
  });
  if (mutations.length === 0) {
    return null;
  }

  clearTextRunSpan();
  const historyGroup = options?.historyGroup ?? createId("text_run_span_history");
  // 書き込みは scope ごとに先頭ユニットの onChange 1 本へ束ねられるが、内容が変わり得る
  // のは span に関与した全エディタ (再チャンクで span 外のユニットも動く)。writer だけに
  // 印を付けると、id 列が不変のまま内容だけ変わった焦点ユニットが受動同期をすり抜け、
  // 次の打鍵で削除済みテキストが復活する。グループ全体へ印を付ける。
  const mutationsByUnitId = new Map(mutations.map((mutation) => [mutation.unitId, mutation]));
  for (const handle of runEditors) {
    handle.markCrossEditorSync(mutationsByUnitId.get(handle.unitId)?.selection ?? null, options?.historyGroup);
  }
  for (const mutation of mutations) {
    const writer = runEditors.find((candidate) => candidate.unitId === mutation.unitId);
    writer?.onChange(mutation.previousIds, mutation.nextBlocks, mutation.focusBlockId, {
      historyGroup,
      selection: mutation.selection,
      crossEditor: true,
    });
  }
  // キャレットの乗るエディタだけは、受動同期 (React 経由・最速でも次の effect) を待たずに
  // 今すぐ置換後の doc とキャレットにする。待つと、同期前に届いた次の打鍵が「置換前の
  // 選択が張られた古い doc」を編集し、その onChange は存在しない previousIds を指して
  // ホストに捨てられる (= 2 文字目が消える)。
  const caretMutation = mutations.find((mutation) => mutation.selection);
  if (caretMutation) {
    const caretHandle = runEditors.find((candidate) => candidate.unitId === caretMutation.unitId);
    caretHandle?.applyCrossEditorSync(caretMutation.nextBlocks, caretMutation.selection ?? null);
  }
  return mutations;
}

/** 各エディタの担当範囲を、置換列 (buildTextRunReplacementMutations の入力) へ変換する。 */
function buildReplacementSegments(
  runEditors: readonly TextRunEditorHandle[],
  ranges: readonly TextRunEditorRange[],
): TextRunReplacementSegment[] {
  return ranges.flatMap((range) => {
    const handle = runEditors.find((candidate) => candidate.unitId === range.unitId);
    if (!handle) {
      return [];
    }
    const doc = handle.editor.state.doc;
    const from = doc.resolve(range.from);
    const to = doc.resolve(range.to);
    // PM round trip は pagination ヒントを持たないので、残余ブロックへは現在のブロック
    // から id で引き継ぐ (通常の onUpdate と同じ経路)。
    const previousBlocks = handle.getBlocks();
    return [{
      unitId: handle.unitId,
      previousIds: getTextFlowBlockIds(previousBlocks),
      previousBlocks,
      before: sliceToTextFlowBlocks(doc.slice(0, range.from), previousBlocks),
      after: sliceToTextFlowBlocks(doc.slice(range.to, doc.content.size), previousBlocks),
      startsInsideTextBlock: isInsideTextBlock(from),
      endsInsideTextBlock: isInsideTextBlock(to),
      preserveEmpty: handle.preserveEmpty,
      scopeId: handle.scopeId,
      // 段の中に段組は入れられない: いちばん内側の入れ物が段組なら、その中へは置けない。
      acceptsLayoutSection: handle.scopeContainer?.at(-1)?.kind !== "layoutSection",
    }];
  });
}

/**
 * 端点がテキストブロックの断面を作るか。doc.slice はテキストブロック内の端点で必ずその
 * ブロックの断片を残し、先頭 (offset 0) / 末尾ちょうどでは **空の断片** になる。ここで
 * 先頭・末尾を除外すると空断片が元 id のまま結合されずに生き残り、単一エディタなら結合
 * される場面 (段落先頭からの選択削除など) で空段落が残る。境界ちょうどの端点も断面として
 * 扱い、結合ロジックに空断片を畳ませる。
 */
function isInsideTextBlock(position: ReturnType<Editor["state"]["doc"]["resolve"]>): boolean {
  return position.parent.isTextblock;
}

export function handleTextRunSpanKeyDown(event: KeyboardEvent, viewDom: HTMLElement): boolean {
  const handle = getTextRunSurfaceByViewDom(viewDom);
  if (!handle) {
    return false;
  }

  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "a") {
    if (selectEntireTextRun(handle.editor)) {
      event.preventDefault();
      return true;
    }
    return false;
  }

  if (event.shiftKey && !event.altKey && isTextRunExtensionKey(event.key)) {
    const nextHead = resolveKeyboardExtensionHead(handle, event);
    if (nextHead) {
      const anchor = activeSpan?.anchor ?? {
        unitId: handle.unitId,
        pos: handle.editor.state.selection.anchor,
      };
      event.preventDefault();
      const headHandle = getTextRunEditors(handle.groupId)
        .find((candidate) => candidate.unitId === nextHead.unitId) ?? handle;
      applySpan(handle.groupId, anchor, nextHead, headHandle);
      return true;
    }
  }

  const span = activeSpan;
  if (!span || !isMultiEditorTextRunSpan()) {
    return false;
  }

  // キャレットを動かして選択を保たないキー (修飾付きナビゲーションを含む) は跨ぎ選択の
  // 解除。ブラウザ既定に流すと焦点エディタの選択だけが動き、span が残ったままの次の
  // 入力が旧選択全体を置換として横取りされてしまう。
  if (!event.isComposing) {
    const collapsePoint = resolveTextRunSpanCollapsePoint(rangesForSpan(span), event.key, event);
    if (collapsePoint) {
      event.preventDefault();
      clearTextRunSpan();
      const target = getTextRunEditors(span.groupId)
        .find((candidate) => candidate.unitId === collapsePoint.unitId);
      if (target) {
        // 次のキーがこのエディタへ届くよう同期でフォーカスする (commands.focus は rAF 遅延)。
        focusEditorViewNow(target.editor);
        setNativeEditorRange(target.editor, collapsePoint.pos, collapsePoint.pos);
      }
      return true;
    }
  }

  if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === "c") {
    return false;
  }

  if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === "x") {
    return false;
  }

  // 書式ショートカット (Cmd/Ctrl+B/I/U) は PM keymap へ流すと焦点エディタの担当分にしか
  // 効かない (ネイティブ選択は焦点エディタにしか張っていない) ので、span 経路で全ユニット
  // の担当範囲へ配って適用する。選択は保つ。
  if (
    (event.metaKey || event.ctrlKey)
    && !event.altKey
    && !event.shiftKey
    && ["b", "i", "u"].includes(event.key.toLowerCase())
  ) {
    event.preventDefault();
    const command = event.key.toLowerCase() === "b"
      ? "bold"
      : event.key.toLowerCase() === "i" ? "italic" : "underline";
    applyTextRunSpanFormat({ command });
    return true;
  }

  if (event.key === "Escape") {
    // 解除だけでは焦点エディタのネイティブ範囲 (担当分) が青く残る。矢印キー経路と
    // 同じく span の head へキャレットを畳む。
    const headPoint = span.head;
    clearTextRunSpan();
    const target = getTextRunEditors(span.groupId)
      .find((candidate) => candidate.unitId === headPoint.unitId);
    if (target) {
      focusEditorViewNow(target.editor);
      setNativeEditorRange(target.editor, headPoint.pos, headPoint.pos);
    }
    return true;
  }

  // 削除・入力系は置換が拒否されても (AI ロック等で canReplaceRanges が false) イベントを
  // 飲み込む。PM 既定へ流すと preventDefault 済みでも keymap が動き、焦点エディタの
  // 担当分だけが削除・置換されてしまう。span は保持し、blocked フィードバックは
  // canReplaceRanges が踏む EditGuard の filterTransaction から出る。
  if (event.key === "Backspace" || event.key === "Delete" || event.key === "Enter") {
    event.preventDefault();
    // IME 合成中の Enter/Backspace は合成の確定・修正であり span への操作ではない
    // (span が合成中も生きているのはロックで置換できなかったときだけ)。
    if (!event.isComposing) {
      // Enter は deleteSelection + splitBlock 相当: 境界の段落断片を結合しない。
      replaceActiveTextRunSpan([], event.key === "Enter" ? { splitAtBoundary: true } : undefined);
    }
    return true;
  }

  if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing) {
    event.preventDefault();
    replaceActiveTextRunSpan(buildSpanTypedTextInsertion(span, event.key));
    return true;
  }

  return false;
}

export interface TextRunSpanFormatRequest {
  command: string;
  value?: unknown;
}

/** span 全体で一括判定するトグル系マーク (部分適用でユニットごとに向きが割れないように)。 */
const SPAN_TOGGLE_MARK_COMMANDS: Record<string, string> = {
  bold: "bold",
  italic: "italic",
  underline: "underline",
  boxed: "boxed",
};

/**
 * 跨ぎ選択への書式適用。各エディタの担当範囲へ同じコマンドを配って適用し、選択 (span と
 * 各エディタのネイティブ範囲) は保つ。トグル系マークは「全範囲が付いているときだけ外す」
 * を span 全体で一度だけ判定する — ユニットごとに toggle すると、片方だけ太字の選択で
 * 向きが割れる。
 *
 * 制約: 各エディタの変更はそれぞれの onUpdate 経路を通るため、undo はユニット単位に
 * 分かれる (跨ぎ削除・置換のような 1 グループにはならない)。
 */
export function applyTextRunSpanFormat(request: TextRunSpanFormatRequest): boolean {
  const span = activeSpan;
  if (!span || !isMultiEditorTextRunSpan()) {
    return false;
  }

  const runEditors = getTextRunEditors(span.groupId);
  const ranges = rangesForSpan(span);
  // 削除系と同じ all-or-nothing: ロックされた範囲が混じる場合は部分適用せず飲み込む
  // (blocked フィードバックは canReplaceRanges が踏む EditGuard の filterTransaction から出る)。
  if (!canReplaceRanges(runEditors, ranges)) {
    return true;
  }

  const targets = ranges.flatMap((range) => {
    const handle = runEditors.find((candidate) => candidate.unitId === range.unitId);
    return handle ? [{ handle, range }] : [];
  });
  if (targets.length === 0) {
    return false;
  }

  const toggleMark = SPAN_TOGGLE_MARK_COMMANDS[request.command];
  if (toggleMark) {
    const add = !targets.every(({ handle, range }) => (
      rangeFullyMarked(handle.editor, range.from, range.to, toggleMark)
    ));
    for (const { handle, range } of targets) {
      const selection = { from: range.from, to: range.to };
      const chain = handle.editor.chain().setTextSelection(selection);
      (add ? chain.setMark(toggleMark) : chain.unsetMark(toggleMark))
        .setTextSelection(selection)
        .run();
    }
  } else {
    for (const { handle, range } of targets) {
      const parentName = blockContextNodeName(handle.editor, range.from);
      applyTextFormatCommand(handle.editor, { command: request.command, value: request.value }, {
        selection: { from: range.from, to: range.to },
        blockNodeType: parentName === "heading" ? "heading" : "paragraph",
        allowBlockStyle: parentName !== "boxBlockTitle",
        preserveSelectionForBlockAttributes: true,
        // focus() は各エディタへ順に焦点を移してスクロールまで起こす。span の書式適用は
        // 選択を動かさないのが約束なので、どのエディタにも焦点を当てない。
        focusEditor: false,
      });
    }
  }

  // 太字化などで文字幅が変わり選択帯の矩形がずれるため、オーバーレイに再計測を促す。
  notifySpanListeners();
  return true;
}

/**
 * FORMAT_TEXT_EVENT 経由の書式適用。リスナーは全 TextFlowEditor に付いていて同じイベント
 * が複数回届くため、イベント単位で最初の 1 回だけ適用する (トグルが往復しないように)。
 */
const appliedSpanFormatEvents = new WeakSet<Event>();

export function applyTextRunSpanFormatForEvent(event: Event, request: TextRunSpanFormatRequest): boolean {
  if (!isMultiEditorTextRunSpan()) {
    return false;
  }
  if (appliedSpanFormatEvents.has(event)) {
    return true;
  }
  appliedSpanFormatEvents.add(event);
  return applyTextRunSpanFormat(request);
}

export interface TextRunSpanToggleMarkStates {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  boxed: boolean;
}

/**
 * ツールバー表示用: span 全体で見たトグル系マークの状態。`applyTextRunSpanFormat` の
 * add/remove 判定 (全範囲が付いているときだけ外す) と同じ規則で判定する。焦点エディタの
 * 担当分だけから作った表示は「太字 ON なのに押すと全体へ追加される」向きの矛盾を生むため、
 * 跨ぎ選択中の書式状態配信はこの値でトグル系を上書きする。span が無い / このエディタが
 * span のグループ外のときは null (通常の焦点エディタ判定のまま)。
 */
export function getTextRunSpanToggleMarkStates(editor: Editor): TextRunSpanToggleMarkStates | null {
  const span = activeSpan;
  if (!span || !isMultiEditorTextRunSpan() || getTextRunSurface(editor)?.groupId !== span.groupId) {
    return null;
  }
  const runEditors = getTextRunEditors(span.groupId);
  const targets = rangesForSpan(span).flatMap((range) => {
    const handle = runEditors.find((candidate) => candidate.unitId === range.unitId);
    return handle ? [{ handle, range }] : [];
  });
  if (targets.length === 0) {
    return null;
  }
  const fullyMarked = (markName: string) => targets.every(({ handle, range }) => (
    rangeFullyMarked(handle.editor, range.from, range.to, markName)
  ));
  return {
    bold: fullyMarked("bold"),
    italic: fullyMarked("italic"),
    underline: fullyMarked("underline"),
    boxed: fullyMarked("boxed"),
  };
}

/** Resolve sizes across the same surfaces that receive a span formatting command. */
export function getTextRunSpanFontSize(editor: Editor): SelectionFontSize | null {
  const span = activeSpan;
  if (!span || !isMultiEditorTextRunSpan() || getTextRunSurface(editor)?.groupId !== span.groupId) return null;
  const editors = getTextRunEditors(span.groupId);
  let fontSize: number | null = null;
  let fontSizeMixed = false;
  for (const range of rangesForSpan(span)) {
    const handle = editors.find((candidate) => candidate.unitId === range.unitId);
    if (!handle) continue;
    const current = readSelectionFontSize(handle.editor.view, range);
    if (current.fontSize === null) continue;
    if (fontSize !== null && Math.abs(fontSize - current.fontSize) > 0.001) fontSizeMixed = true;
    fontSize ??= current.fontSize;
    fontSizeMixed ||= current.fontSizeMixed;
    if (fontSizeMixed) break;
  }
  return { fontSize, fontSizeMixed };
}

/** 範囲内の全インライン葉 (テキスト・数式などのアトム) が指定マークを持つか。 */
function rangeFullyMarked(editor: Editor, from: number, to: number, markName: string): boolean {
  const markType = editor.state.schema.marks[markName];
  if (!markType) {
    return false;
  }
  let sawInline = false;
  let fully = true;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (!fully) {
      return false;
    }
    if (!node.isInline) {
      return true;
    }
    if (node.isText || node.isLeaf) {
      sawInline = true;
      if (!markType.isInSet(node.marks)) {
        fully = false;
      }
    }
    return false;
  });
  return sawInline && fully;
}

/** 範囲先頭のブロック文脈 (heading / boxBlockTitle 判定) を持つノード名。 */
function blockContextNodeName(editor: Editor, pos: number): string {
  const size = editor.state.doc.content.size;
  const resolved = editor.state.doc.resolve(clamp(pos, 0, size));
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const name = resolved.node(depth).type.name;
    if (name === "heading" || name === "paragraph" || name === "boxBlockTitle") {
      return name;
    }
  }
  return resolved.parent.type.name;
}

/**
 * キャレットを動かして選択を保たないナビゲーションキーで跨ぎ選択を畳む位置。通常の
 * エディタ挙動に合わせて、後方系 (左/上/Home/PageUp) は選択の文書順先頭側、前方系
 * (右/下/End/PageDown/Tab) は末尾側へキャレットを置く。Shift 付きは選択の拡張なので
 * 畳まない (Tab だけは Shift 付きでも選択を保たないため畳む)。
 */
export function resolveTextRunSpanCollapsePoint(
  ranges: readonly TextRunEditorRange[],
  key: string,
  modifiers?: { shiftKey?: boolean },
): TextRunCaretPoint | null {
  const first = ranges[0];
  const last = ranges.at(-1);
  if (!first || !last) {
    return null;
  }
  if (key === "Tab") {
    return modifiers?.shiftKey === true
      ? { unitId: first.unitId, pos: first.from }
      : { unitId: last.unitId, pos: last.to };
  }
  if (modifiers?.shiftKey === true) {
    return null;
  }
  if (key === "ArrowLeft" || key === "ArrowUp" || key === "Home" || key === "PageUp") {
    return { unitId: first.unitId, pos: first.from };
  }
  if (key === "ArrowRight" || key === "ArrowDown" || key === "End" || key === "PageDown") {
    return { unitId: last.unitId, pos: last.to };
  }
  return null;
}

function selectedBlocksForSpan(span: TextRunSpan): SigmaBlock[] {
  const entries: TextRunContainerEntry[] = [];
  const runEditors = handlesForSpan(span);
  for (const range of rangesForSpan(span)) {
    const handle = runEditors.find((candidate) => candidate.unitId === range.unitId);
    if (!handle) {
      continue;
    }
    // `previousBlocks` を渡すのは pagination (改ページ / 改段 / keep 系) のため。PM の
    // スキーマはそれを持たないので、渡さないと選択範囲のブロックから改ページが落ちる。
    let selected = sliceToTextFlowBlocks(
      handle.editor.state.doc.slice(range.from, range.to),
      handle.getBlocks(),
    );
    if (entries.length === 0 && selected[0]?.pagination?.break === true) {
      const first = selected[0];
      const pagination = { ...(first.pagination ?? {}) };
      delete pagination.break;
      selected = [{
        ...first,
        pagination: Object.keys(pagination).length > 0 ? pagination : undefined,
      }, ...selected.slice(1)];
    }
    if (selected.length === 0) {
      continue;
    }
    // 段組セクション・問題エリアのユニットは中身のブロックしか持たない。ここで包み直さないと、
    // コピー先には入れ物の解けた段落の列だけが並ぶ。
    entries.push({ blocks: selected, containers: handle.scopeContainer });
  }
  return wrapTextRunBlocksInContainers(entries);
}

/**
 * PM の slice へ載せるための平坦化。入れ物 (段組・問題) の中身だけを本文ブロックとして返す。
 * 構造は payload 側が運ぶので、ここは「見えているテキストの並び」だけを担う。
 */
function toSliceTextFlowBlocks(block: SigmaBlock): TextFlowBlock[] {
  if (isTextFlowClipboardBlock(block)) {
    return [block];
  }
  if (block.type === "problem") {
    return PROBLEM_AREA_ORDER.flatMap((area) => block[area]);
  }
  return [];
}

function rangesForSpan(span: TextRunSpan): TextRunEditorRange[] {
  const editors = handlesForSpan(span);
  return resolveRunSelectionRanges(
    editors.map((handle) => ({
      unitId: handle.unitId,
      docSize: handle.editor.state.doc.content.size,
    })),
    span.anchor,
    span.head,
  );
}

function handlesForSpan(span: TextRunSpan): TextRunEditorHandle[] {
  return getTextRunEditors(span.groupId);
}

function canReplaceRanges(
  editors: readonly TextRunEditorHandle[],
  ranges: readonly TextRunEditorRange[],
): boolean {
  return ranges.every((range) => {
    const handle = editors.find((candidate) => candidate.unitId === range.unitId);
    if (!handle) {
      return false;
    }
    try {
      const transaction = handle.editor.state.tr.delete(range.from, range.to);
      return handle.editor.state.plugins.every((plugin) => (
        plugin.spec.filterTransaction?.(transaction, handle.editor.state) !== false
      ));
    } catch {
      return false;
    }
  });
}

function getPointerSelectionAnchor(handle: TextRunEditorHandle): TextRunCaretPoint {
  if (activeSpan?.groupId === handle.groupId) {
    return activeSpan.anchor;
  }
  const focused = getTextRunEditors(handle.groupId)
    .find((candidate) => candidate.editor.isFocused);
  return {
    unitId: focused?.unitId ?? handle.unitId,
    pos: focused?.editor.state.selection.anchor ?? handle.editor.state.selection.anchor,
  };
}

function getClickSelectionRange(
  editor: Editor,
  pos: number,
  detail: number,
): { from: number; to: number } {
  if (detail <= 1) {
    return { from: pos, to: pos };
  }
  const size = editor.state.doc.content.size;
  const resolved = editor.state.doc.resolve(clamp(pos, 0, size));
  if (detail >= 3) {
    return {
      from: resolved.start(resolved.depth),
      to: resolved.end(resolved.depth),
    };
  }

  const parentText = resolved.parent.textBetween(0, resolved.parent.content.size, "\n", "\ufffc");
  const { from: fromOffset, to: toOffset } = resolveDoubleClickTextRange(
    parentText,
    Math.min(resolved.parentOffset, parentText.length),
  );
  const parentStart = resolved.start(resolved.depth);
  return { from: parentStart + fromOffset, to: parentStart + toOffset };
}

interface IntlTextSegment {
  index: number;
  isWordLike?: boolean;
  segment: string;
}

/**
 * ダブルクリック位置を UTF-16 の途中で切らない単語または書記素範囲へ広げる。
 * ProseMirror の text position と Intl.Segmenter の index はどちらも UTF-16 offset。
 */
export function resolveDoubleClickTextRange(
  text: string,
  offset: number,
): { from: number; to: number } {
  const clampedOffset = clamp(offset, 0, text.length);
  if (text.length === 0) {
    return { from: clampedOffset, to: clampedOffset };
  }

  const wordSegments = segmentText(text, "word");
  const word = segmentForDoubleClick(wordSegments, clampedOffset, true);
  if (word?.isWordLike) {
    return { from: word.index, to: word.index + word.segment.length };
  }

  const grapheme = segmentForDoubleClick(segmentText(text, "grapheme"), clampedOffset, false);
  return grapheme
    ? { from: grapheme.index, to: grapheme.index + grapheme.segment.length }
    : { from: clampedOffset, to: clampedOffset };
}

function segmentText(text: string, granularity: "word" | "grapheme"): IntlTextSegment[] {
  const segmenterCtor = (Intl as { Segmenter?: new (
    locale: string,
    options: { granularity: "word" | "grapheme" },
  ) => { segment(input: string): Iterable<IntlTextSegment> } }).Segmenter;
  if (typeof segmenterCtor !== "function") {
    return fallbackGraphemeSegments(text);
  }
  return Array.from(new segmenterCtor("ja", { granularity }).segment(text));
}

function segmentForDoubleClick(
  segments: readonly IntlTextSegment[],
  offset: number,
  preferWordAtBoundary: boolean,
): IntlTextSegment | null {
  const currentIndex = segments.findIndex((segment) => (
    segment.index <= offset && offset < segment.index + segment.segment.length
  ));
  const current = currentIndex >= 0 ? segments[currentIndex] : segments.at(-1);
  if (!current) {
    return null;
  }
  if (preferWordAtBoundary && current.index === offset && !current.isWordLike) {
    const previous = segments[currentIndex - 1];
    if (previous?.isWordLike && previous.index + previous.segment.length === offset) {
      return previous;
    }
  }
  return current;
}

function fallbackGraphemeSegments(text: string): IntlTextSegment[] {
  const segments: IntlTextSegment[] = [];
  for (let index = 0; index < text.length;) {
    const start = index;
    let segment = String.fromCodePoint(text.codePointAt(index)!);
    index += segment.length;
    while (index < text.length) {
      const next = String.fromCodePoint(text.codePointAt(index)!);
      const joinsPrevious = next === "\u200d"
        || segment.endsWith("\u200d")
        || /\p{M}/u.test(next)
        || isEmojiModifier(next)
        || (isRegionalIndicator(segment) && isRegionalIndicator(next));
      if (!joinsPrevious) {
        break;
      }
      segment += next;
      index += next.length;
    }
    segments.push({ index: start, segment });
  }
  return segments;
}

function isEmojiModifier(character: string): boolean {
  const codePoint = character.codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

function isRegionalIndicator(text: string): boolean {
  const codePoints = Array.from(text);
  if (codePoints.length !== 1) {
    return false;
  }
  const codePoint = codePoints[0].codePointAt(0);
  return codePoint !== undefined && codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

/**
 * ダブル/トリプルクリック起点のドラッグが文書順で後方 (mousedown の初期範囲より前) へ
 * 向いているか。anchor の据え方 (`resolveExpandedClickAnchor`) と head の粒度吸着
 * (`resolveClickDragSelectionHead`) が同じ向き判定を共有する。
 */
function isExpandedClickDragBackward(
  editors: readonly TextRunEditorHandle[],
  origin: TextRunEditorHandle,
  target: TextRunEditorHandle,
  initialRange: { from: number; to: number },
  targetPos: number,
): boolean {
  const originIndex = editors.indexOf(origin);
  const targetIndex = editors.indexOf(target);
  return targetIndex < originIndex
    || (targetIndex === originIndex && targetPos < initialRange.from);
}

function resolveExpandedClickAnchor(
  origin: TextRunEditorHandle,
  initialRange: { from: number; to: number },
  extendsBackward: boolean,
  fallback: TextRunCaretPoint,
): TextRunCaretPoint {
  if (initialRange.from === initialRange.to) {
    return fallback;
  }
  return {
    unitId: origin.unitId,
    pos: extendsBackward ? initialRange.to : initialRange.from,
  };
}

export interface TextRunClickDragHeadContext {
  /** mousedown のクリック回数 (event.detail)。1 以下は通常ドラッグ = 生の位置のまま。 */
  detail: number;
  /** ドラッグ方向が文書順で後方か (`isExpandedClickDragBackward` = anchor 側と同じ判定)。 */
  extendsBackward: boolean;
  /** mousedown 時の初期範囲 (単語/段落)。 */
  initialRange: { from: number; to: number };
  /** ドラッグ先の生の位置。 */
  pos: number;
  /** ドラッグ先の位置を mousedown と同じ粒度で広げた範囲 (`getClickSelectionRange` の結果)。 */
  posRange: { from: number; to: number };
}

/**
 * ダブル/トリプルクリックから続くドラッグの head 位置。前方への拡張は粒度範囲の末尾、
 * 後方は先頭へ吸着させる (アンカー側の単語/段落は `resolveExpandedClickAnchor` が丸ごと
 * 保つ)。ダブルクリックで空の範囲しか取れなかったとき (空行など) は通常ドラッグと同じく
 * 生の位置。
 */
export function resolveClickDragSelectionHead(context: TextRunClickDragHeadContext): number {
  if (context.detail <= 1 || context.initialRange.from === context.initialRange.to) {
    return context.pos;
  }
  return context.extendsBackward ? context.posRange.from : context.posRange.to;
}

function isTextRunExtensionKey(key: string): boolean {
  return key === "ArrowLeft"
    || key === "ArrowRight"
    || key === "ArrowUp"
    || key === "ArrowDown"
    || key === "Home"
    || key === "End";
}

function resolveKeyboardExtensionHead(
  eventHandle: TextRunEditorHandle,
  event: KeyboardEvent,
): TextRunCaretPoint | null {
  const editors = getTextRunEditors(eventHandle.groupId);
  const currentPoint = activeSpan?.groupId === eventHandle.groupId
    ? activeSpan.head
    : { unitId: eventHandle.unitId, pos: eventHandle.editor.state.selection.head };
  const currentIndex = editors.findIndex((candidate) => candidate.unitId === currentPoint.unitId);
  const current = editors[currentIndex];
  if (!current) {
    return null;
  }
  const size = current.editor.state.doc.content.size;
  const active = activeSpan?.groupId === eventHandle.groupId;
  const mod = event.metaKey || event.ctrlKey;

  if (mod && event.key === "ArrowUp") {
    return active || currentIndex > 0 || currentPoint.pos > 0
      ? { unitId: editors[0].unitId, pos: 0 }
      : null;
  }
  if (mod && event.key === "ArrowDown") {
    const last = editors.at(-1)!;
    return active || currentIndex < editors.length - 1 || currentPoint.pos < size
      ? { unitId: last.unitId, pos: last.editor.state.doc.content.size }
      : null;
  }

  const backward = event.key === "ArrowLeft" || event.key === "Home";
  const forward = event.key === "ArrowRight" || event.key === "End";
  if (backward || forward) {
    const lineBoundaryKey = event.key === "Home" || event.key === "End" || mod;
    const target = resolveHorizontalExtensionTarget({
      active,
      backward,
      lineBoundaryKey,
      pos: currentPoint.pos,
      lineStart: findLineBoundaryPosition(current.editor, currentPoint.pos, -1),
      lineEnd: findLineBoundaryPosition(current.editor, currentPoint.pos, 1),
      firstSelectablePos: firstSelectablePosition(current.editor),
      lastSelectablePos: lastSelectablePosition(current.editor),
    });
    if (!target) {
      return null;
    }
    if (target.kind === "within") {
      return { unitId: current.unitId, pos: target.pos };
    }
    if (target.kind === "adjacent") {
      const adjacent = editors[currentIndex + (backward ? -1 : 1)];
      if (!adjacent) {
        return null;
      }
      // 隣接エディタの生端 (0 / content.size) は選択可能位置と限らず、resolveRunSelectionRanges
      // で空レンジになって span ごと破棄される。必ず最初/最後の選択可能位置で入る。
      const entry = backward
        ? lastSelectablePosition(adjacent.editor)
        : firstSelectablePosition(adjacent.editor);
      return {
        unitId: adjacent.unitId,
        pos: lineBoundaryKey
          ? findLineBoundaryPosition(adjacent.editor, entry, backward ? -1 : 1)
          : entry,
      };
    }
    if (event.key === "ArrowLeft" && currentPoint.pos > 0) {
      return { unitId: current.unitId, pos: previousSelectablePosition(current.editor, currentPoint.pos) };
    }
    if (event.key === "ArrowRight" && currentPoint.pos < size) {
      return { unitId: current.unitId, pos: nextSelectablePosition(current.editor, currentPoint.pos) };
    }
    return null;
  }

  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
    return resolveVerticalExtensionHead(editors, currentIndex, currentPoint, event.key === "ArrowUp" ? -1 : 1, active);
  }
  return null;
}

export interface TextRunHorizontalExtensionContext {
  /** span が既に有効か。無効なら「ユニット端にいるときだけ」隣へ渡って選択を開始する。 */
  active: boolean;
  backward: boolean;
  /** Home/End または修飾付き (行頭・行末へ跳ぶキー) か。 */
  lineBoundaryKey: boolean;
  pos: number;
  /** 現在位置から見た行頭 / 行末 (findLineBoundaryPosition の結果)。 */
  lineStart: number;
  lineEnd: number;
  /** ユニット内の最初 / 最後の選択可能位置。チャンク端が list や boxBlock でも境界を表す。 */
  firstSelectablePos: number;
  lastSelectablePos: number;
}

export type TextRunHorizontalExtensionTarget =
  | { kind: "adjacent" }
  | { kind: "step" }
  | { kind: "within"; pos: number }
  | null;

/**
 * Shift+←/→/Home/End (と修飾付き) の水平拡張が「ユニット内のどこへ」「1 文字ずつ」
 * 「隣のエディタへ」のどれに向かうかの判定。DOM 計測 (行境界・選択可能位置) は呼び出し
 * 側が済ませ、ここは判定だけを持つ。
 */
export function resolveHorizontalExtensionTarget(
  context: TextRunHorizontalExtensionContext,
): TextRunHorizontalExtensionTarget {
  const { active, backward, lineBoundaryKey, pos } = context;
  if (lineBoundaryKey) {
    const lineBoundary = backward ? context.lineStart : context.lineEnd;
    if (lineBoundary !== pos) {
      return active ? { kind: "within", pos: lineBoundary } : null;
    }
    // 既に行境界にいる。ユニット端の行のときだけ隣へ渡る。チャンク中程の行末で
    // Shift+End を押しても、残り全ブロック + 次チャンクの行までは跳ばない。
    const atUnitEdgeLine = backward
      ? pos <= context.firstSelectablePos
      : pos >= context.lastSelectablePos;
    return atUnitEdgeLine ? { kind: "adjacent" } : null;
  }

  // 段落以外 (list / boxBlock) で始まる・終わるチャンクは端の選択可能位置が 1 / size-1
  // より内側にある。生の doc 端ではなく選択可能位置との比較で境界を判定する。
  const atBoundary = backward
    ? pos <= context.firstSelectablePos
    : pos >= context.lastSelectablePos;
  if (!active && !atBoundary) {
    return null;
  }
  return atBoundary ? { kind: "adjacent" } : { kind: "step" };
}

function resolveVerticalExtensionHead(
  editors: readonly TextRunEditorHandle[],
  currentIndex: number,
  point: TextRunCaretPoint,
  direction: -1 | 1,
  active: boolean,
): TextRunCaretPoint | null {
  const current = editors[currentIndex];
  const rect = current.editor.view.dom.getBoundingClientRect();
  const size = current.editor.state.doc.content.size;
  const boundedPos = clamp(point.pos, 0, size);
  try {
    const coords = current.editor.view.coordsAtPos(boundedPos);
    const lineHeight = Math.max(coords.bottom - coords.top, 16);
    const y = direction < 0 ? coords.top - lineHeight / 2 : coords.bottom + lineHeight / 2;
    if (y >= rect.top && y <= rect.bottom) {
      const local = current.editor.view.posAtCoords({ left: coords.left, top: y })?.pos;
      if (local !== undefined && local !== point.pos) {
        return active ? { unitId: current.unitId, pos: local } : null;
      }
      if (!active) {
        return null;
      }
    }
    const adjacent = editors[currentIndex + direction];
    if (!adjacent) {
      return null;
    }
    const adjacentRect = adjacent.editor.view.dom.getBoundingClientRect();
    const target = adjacent.editor.view.posAtCoords({
      left: clamp(coords.left, adjacentRect.left + 1, adjacentRect.right - 1),
      top: direction < 0 ? adjacentRect.bottom - 1 : adjacentRect.top + 1,
    })?.pos;
    return {
      unitId: adjacent.unitId,
      pos: target ?? (direction < 0
        ? lastSelectablePosition(adjacent.editor)
        : firstSelectablePosition(adjacent.editor)),
    };
  } catch {
    return null;
  }
}

function firstSelectablePosition(editor: Editor): number {
  try {
    return TextSelection.near(editor.state.doc.resolve(0), 1).head;
  } catch {
    return 0;
  }
}

function lastSelectablePosition(editor: Editor): number {
  const size = editor.state.doc.content.size;
  try {
    return TextSelection.near(editor.state.doc.resolve(size), -1).head;
  } catch {
    return size;
  }
}

function previousSelectablePosition(editor: Editor, pos: number): number {
  try {
    return TextSelection.near(editor.state.doc.resolve(Math.max(0, pos - 1)), -1).head;
  } catch {
    return Math.max(0, pos - 1);
  }
}

function nextSelectablePosition(editor: Editor, pos: number): number {
  const size = editor.state.doc.content.size;
  try {
    return TextSelection.near(editor.state.doc.resolve(Math.min(size, pos + 1)), 1).head;
  } catch {
    return Math.min(size, pos + 1);
  }
}

function findLineBoundaryPosition(editor: Editor, pos: number, direction: -1 | 1): number {
  const size = editor.state.doc.content.size;
  let current = clamp(pos, 0, size);
  let currentTop: number;
  try {
    currentTop = editor.view.coordsAtPos(current).top;
  } catch {
    return current;
  }

  for (let step = 0; step <= size; step += 1) {
    const next = direction < 0
      ? previousSelectablePosition(editor, current)
      : nextSelectablePosition(editor, current);
    if (next === current || (direction < 0 ? next > current : next < current)) {
      break;
    }
    try {
      const nextTop = editor.view.coordsAtPos(next).top;
      if (Math.abs(nextTop - currentTop) > 2) {
        break;
      }
    } catch {
      break;
    }
    current = next;
  }
  return current;
}

function applySpan(
  groupId: string,
  anchor: TextRunCaretPoint,
  head: TextRunCaretPoint,
  focused: TextRunEditorHandle,
): void {
  const runEditors = getTextRunEditors(groupId);
  const ranges = resolveRunSelectionRanges(
    runEditors.map((handle) => ({
      unitId: handle.unitId,
      docSize: handle.editor.state.doc.content.size,
    })),
    anchor,
    head,
  );
  if (!isMultiEditorRunSelection(ranges)) {
    clearTextRunSpan();
    const range = ranges[0];
    const directional = anchor.unitId === focused.unitId && head.unitId === focused.unitId;
    // 開始位置まで戻した空の選択も反映する。ranges は空になるため、範囲がある場合
    // だけ更新すると、それまでの選択が残り次の入力で意図しない本文を置換してしまう。
    const localRange = directional
      ? { from: anchor.pos, to: head.pos }
      : range?.unitId === focused.unitId ? range : null;
    if (localRange) {
      // 単一エディタへ畳まれた span は anchor 据え置き・head のみ移動。正規化済みの
      // from/to を渡すと Cmd/Ctrl+Shift+↑ のような後方拡張で anchor が動いてしまう。
      const applied = setNativeEditorRange(
        focused.editor,
        localRange.from,
        localRange.to,
      );
      // 状態選択だけでは足りない: PM は mousedown 中の dispatch を DOM 選択へ同期せず
      // (mouseup の遅延同期も実測では戻らない)、span も無いので Highlight も描かない。
      // 放置すると multi-unit 文書で単一ユニットに収まるドラッグ選択が完全に不可視のまま
      // 状態選択にだけ残り、次の打鍵が見えない範囲を置換してしまう。跨ぎ span の mouseup
      // 同期と同じく、焦点エディタのネイティブ DOM 選択もここで張って ::selection に描かせる。
      if (applied) {
        syncEditorDomSelectionToState(focused.editor);
      }
    }
    return;
  }

  setActiveTextRunSpan({ groupId, anchor, head });
  // 各ユニットの担当範囲を PM の状態選択としても張る (anchor/head の向きは保つ)。これが
  //   1. 数式アトムの `text-selected` 装飾の出典 — Highlight はテキストしか描かないので、
  //      アトムの選択背景は状態選択由来の装飾が補完する (焦点の無いユニットにも要る)。
  //   2. IME 合成の前提 — PM は compositionstart で状態選択を DOM 選択へ強制再同期する
  //      (endComposition の forceUpdate)。ドラッグ中の dispatch は DOM 選択へ同期されない
  //      ため、状態選択が担当範囲を指していないと合成がアンカー位置に入る。
  // 範囲から外れたユニットは装飾が残らないよう畳む。
  const backward = isSpanBackward(runEditors, anchor, head);
  for (const handle of runEditors) {
    const range = ranges.find((candidate) => candidate.unitId === handle.unitId);
    handle.editor.view.dom.toggleAttribute("data-text-run-span", range !== undefined);
    if (!range) {
      collapseSpanEditorSelection(handle);
      continue;
    }
    const target = backward
      ? { anchor: range.to, head: range.from }
      : { anchor: range.from, head: range.to };
    // 比較は clamp 済みの選択オブジェクトで行う。生の from/to は選択可能位置に丸められる
    // (TextSelection.between) ため、数値比較だと一致せず mousemove のたびに同値の
    // dispatch が全ユニットへ流れてしまう。
    const nextSelection = buildEditorRangeSelection(handle.editor, target.anchor, target.head);
    if (nextSelection && !nextSelection.eq(handle.editor.state.selection)) {
      handle.editor.view.dispatch(handle.editor.state.tr.setSelection(nextSelection));
    }
  }
}

/** span の head が文書順で anchor より前 (後方への拡張) か。 */
function isSpanBackward(
  editors: readonly TextRunEditorHandle[],
  anchor: TextRunCaretPoint,
  head: TextRunCaretPoint,
): boolean {
  const anchorIndex = editors.findIndex((candidate) => candidate.unitId === anchor.unitId);
  const headIndex = editors.findIndex((candidate) => candidate.unitId === head.unitId);
  return headIndex < anchorIndex || (headIndex === anchorIndex && head.pos < anchor.pos);
}

/**
 * span から外れたユニットの状態選択を畳む。残すと数式アトムの `text-selected` 装飾が
 * 消えず、再フォーカス時の PM の DOM 選択同期も古い範囲を復活させる。DOM フォーカスを
 * 持つエディタは畳まない — IME がネイティブ選択を置換する契約 (`beginTextRunSpanComposition`)
 * が崩れるし、キャレットの置き直しは各解除経路が自分で行う。
 */
function collapseSpanEditorSelection(handle: TextRunEditorHandle): void {
  const editor = handle.editor;
  if (editor.isDestroyed || editor.view.hasFocus() || editor.state.selection.empty) {
    return;
  }
  const head = editor.state.selection.head;
  setNativeEditorRange(editor, head, head);
}

/**
 * ドラッグで作った span の、焦点エディタのネイティブ DOM 選択を担当範囲と一致させる。
 * PM は mousedown 中の dispatch を DOM 選択へ同期せず、mouseup の最終 dispatch も選択が
 * 不変なら何もしない (実測: DOM 選択はアンカー位置に collapsed のまま)。IME はネイティブ
 * 選択を置換するため、ここで合わせておかないと跨ぎドラッグ→日本語入力で焦点チャンクの
 * 選択分が残り、合成テキストがアンカー位置に入る。
 */
function syncFocusedEditorDomSelectionToSpan(): void {
  const span = activeSpan;
  if (!span || !isMultiEditorTextRunSpan()) {
    return;
  }
  const runEditors = getTextRunEditors(span.groupId);
  const focused = runEditors.find((candidate) => candidate.editor.view.hasFocus());
  const range = focused
    ? rangesForSpan(span).find((candidate) => candidate.unitId === focused.unitId)
    : undefined;
  if (!focused || !range) {
    return;
  }
  const backward = isSpanBackward(runEditors, span.anchor, span.head);
  const target = backward
    ? { anchor: range.to, head: range.from }
    : { anchor: range.from, head: range.to };
  setEditorDomSelection(focused.editor, target.anchor, target.head);
}

/**
 * エディタの現在の状態選択をネイティブ DOM 選択へ写す。DOM フォーカスが無い (Chromium は
 * 非フォーカスの contenteditable の ::selection を描かないので写す意味が無い) / IME 合成中
 * (DOM 選択を動かすと合成セッションが切れる) は触らない。
 */
function syncEditorDomSelectionToState(editor: Editor): void {
  if (editor.isDestroyed || !editor.view.hasFocus() || editor.view.composing) {
    return;
  }
  setEditorDomSelection(editor, editor.state.selection.anchor, editor.state.selection.head);
}

/**
 * エディタへ同期でフォーカスを当てる。Tiptap の focus コマンドは実際の view.focus() を
 * requestAnimationFrame へ遅延するため、クリック→即キー入力 (実測: 読み込み直後の
 * クリック + Cmd+A) が次フレーム前に届くと body へ落ちる。span の経路はクリックの
 * mousedown を preventDefault してブラウザ既定のフォーカスも止めているので、ここで
 * 同期に当てる。
 */
function focusEditorViewNow(editor: Editor): void {
  if (!editor.isDestroyed && !editor.view.hasFocus()) {
    editor.view.focus();
  }
}

function setEditorDomSelection(editor: Editor, anchor: number, head: number): void {
  try {
    const view = editor.view;
    const domAnchor = view.domAtPos(anchor);
    const domHead = view.domAtPos(head);
    view.dom.ownerDocument.getSelection()?.setBaseAndExtent(
      domAnchor.node,
      domAnchor.offset,
      domHead.node,
      domHead.offset,
    );
  } catch {
    // DOM 選択として置けない範囲は諦める (状態選択は張ってある)。
  }
}

/**
 * `preserveSelectionUnitId` は選択を畳まず残すユニット。IME 合成の解除
 * (`beginTextRunSpanComposition`) は合成エディタのネイティブ選択がそのまま IME の置換
 * 対象なので、DOM フォーカスの有無 (テスト DOM では立たない) に依らず明示的に守る。
 */
function setActiveTextRunSpan(next: TextRunSpan | null, preserveSelectionUnitId?: string): void {
  const previousGroupId = activeSpan?.groupId;
  activeSpan = next;
  if (previousGroupId && (!next || next.groupId !== previousGroupId)) {
    for (const handle of getTextRunEditors(previousGroupId)) {
      handle.editor.view.dom.removeAttribute("data-text-run-span");
      // applySpan が張った担当範囲の状態選択を畳む (焦点エディタ以外)。残すと数式アトムの
      // `text-selected` 装飾と、再フォーカス時の DOM 選択同期が古い範囲を見せてしまう。
      if (handle.unitId !== preserveSelectionUnitId) {
        collapseSpanEditorSelection(handle);
      }
    }
  }
  notifySpanListeners();
}

function notifySpanListeners(): void {
  spanListeners.forEach((listener) => listener());
}

function setNativeEditorRange(editor: Editor, anchor: number, head: number): boolean {
  const selection = buildEditorRangeSelection(editor, anchor, head);
  if (!selection) {
    return false;
  }
  editor.view.dispatch(editor.state.tr.setSelection(selection));
  return true;
}

/**
 * anchor/head から PM の選択を組む。範囲がテキスト選択として置けないときは null
 * (ネイティブ側を触らない。Highlight が覆う)。
 */
function buildEditorRangeSelection(
  editor: Editor,
  anchor: number,
  head: number,
): Selection | null {
  const size = editor.state.doc.content.size;
  const nextAnchor = Math.min(Math.max(anchor, 0), size);
  const nextHead = Math.min(Math.max(head, 0), size);
  try {
    // AllSelection は前方の全選択 (Cmd+A) だけ。anchor が末尾側の後方全選択に使うと
    // anchor が 0 へ飛ぶので、TextSelection.between で anchor/head の役割を保つ。
    return nextAnchor <= 0 && nextHead >= size
      ? new AllSelection(editor.state.doc)
      : TextSelection.between(editor.state.doc.resolve(nextAnchor), editor.state.doc.resolve(nextHead));
  } catch {
    return null;
  }
}

function editorAtPoint(
  runEditors: readonly TextRunEditorHandle[],
  x: number,
  y: number,
): TextRunEditorHandle | null {
  const unitId = resolveRunEditorAtPoint(
    runEditors.map((handle) => ({
      unitId: handle.unitId,
      rect: handle.editor.view.dom.getBoundingClientRect(),
    })),
    x,
    y,
  );
  return runEditors.find((handle) => handle.unitId === unitId) ?? null;
}

function posInEditor(editor: Editor, clientX: number, clientY: number): number | null {
  return posAtClientPoint(editor.view, clientX, clientY);
}

function getEditorDomRange(editor: Editor, from: number, to: number): Range | null {
  if (to <= from) {
    return null;
  }
  try {
    const start = editor.view.domAtPos(from);
    const end = editor.view.domAtPos(to);
    const range = editor.view.dom.ownerDocument.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    return range;
  } catch {
    return null;
  }
}

function hasDragged(start: { x: number; y: number }, x: number, y: number): boolean {
  return Math.abs(x - start.x) > DRAG_SELECTION_THRESHOLD_PX
    || Math.abs(y - start.y) > DRAG_SELECTION_THRESHOLD_PX;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return min;
  }
  return Math.min(Math.max(value, min), max);
}
