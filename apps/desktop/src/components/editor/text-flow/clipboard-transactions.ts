import { DOMSerializer, Fragment, Slice, type Node as ProseMirrorModelNode } from "@tiptap/pm/model";
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { sliceTextForClipboard } from "@/components/tiptap/inline-math-extension";
import { isEmptyEditorTextBlock } from "@/components/tiptap/node-queries";
import { caretAddressAtBlockEnd, type TextFlowBlock } from "@/features/text-editing";
import {
  cloneTextFlowBlocksForPaste,
  createTextFlowClipboardPayload,
  getLocalEditorClipboardPayload,
  markBodyTextCut,
  readEditorClipboardPayload,
  readTextSliceClipboardData,
  toOverlayShapesClipboardPayload,
  writeEditorClipboardData,
  writeTextSliceClipboardData,
  type EditorClipboardPayload,
} from "@/lib/editor-clipboard";

import { createMixedClipboardHistoryGroup, markBodyCutHistoryGroup, MIXED_CLIPBOARD_HISTORY_GROUP_META, peekBodyCutHistoryGroup } from "./clipboard-history-group";
import { finishCaretKeeperWindow, flushPendingCaret, getCaretSurfaceByViewDom, requestCaret, startCaretKeeperWindow } from "./caret-router";
import { localClipboardPayloadMatchesPlainText } from "./large-text-paste";
import { consumeRejectedManualBreakPaste, deleteManualBreakSpanningSelection, dispatchPreparedManualBreakPaste, dropLeadingPastedBreakAtContainerStart, resolveManualBreakPasteContent, selectionCrossesManualBreak, transferManualBreakToPastedBlocksAtOwnerStart, transferManualBreakToPastedSliceAtOwnerStart } from "./manual-break-transactions";
import { parsePastedMarkdown } from "./markdown-paste";
import { insertTextSliceWithFreshBlockIds, requestOverlayShapesPaste, resolveTextRunSpanAnchorBlockIdMap } from "./text-and-shapes-clipboard";
import { plainTextToTextFlowParagraphs, sliceToTextFlowBlocks } from "./text-run-slice";
import { copyActiveTextRunSpan, isMultiEditorTextRunSpan, replaceActiveTextRunSpan } from "./text-run-span";
import { textFlowBlockToTiptapNode } from "./tiptap-document-adapter";

const LITERAL_PASTE_SHORTCUT_WINDOW_MS = 1500;

/**
 * 1 編集面の clipboard 操作状態。literal paste の再入と、同じ undo 区間へ続く
 * transaction の履歴キーを所有する。文書・選択・React の状態は保持しない。
 */
export class TextFlowClipboardSession {
  private literalPasteRequestedAt = 0;
  private literalPasteInProgress = false;
  /**
   * 混在ペースト / 混在カットの強制コアレスキーと、それが属する本文グルーピング区間。
   *
   * 1 回のペーストは **2 つの transaction** を起こしうる (本体の挿入 + id 列が変わったときの
   * `setTextFlowContentPreservingSelection`)。最初の 1 つにだけキーを付けると 2 つ目が
   * 時間ベースのキーになり、履歴が 2 段積まれて ⌘Z 1 回では戻らない (実測)。
   * 「同じ操作か」は既に時間・隣接で判定されているので、その区間が続く限りキーも保つ。
   */
  private forcedClipboardHistoryGroup: { group: string; sequence: number } | null = null;

  requestLiteralPaste(): void {
    this.literalPasteRequestedAt = Date.now();
  }

  /** null の再入だけは PM の標準 plain-text parser へ委ねる。 */
  beginPaste(): { literalPasteRequested: boolean } | null {
    if (this.literalPasteInProgress) {
      return null;
    }
    const literalPasteRequested = Date.now() - this.literalPasteRequestedAt
      <= LITERAL_PASTE_SHORTCUT_WINDOW_MS;
    this.literalPasteRequestedAt = 0;
    return { literalPasteRequested };
  }

  pasteLiteral(view: EditorView, event: ClipboardEvent): boolean {
    const clipboardData = event.clipboardData;
    if (!clipboardData) {
      return false;
    }
    event.preventDefault();
    this.literalPasteInProgress = true;
    try {
      view.pasteText(clipboardData.getData("text/plain"));
    } finally {
      this.literalPasteInProgress = false;
    }
    return true;
  }

  historyGroupFor(transaction: Transaction, sequence: number, crossEditorClipboardGroup: string | null): string | null {
    const mintedClipboardGroup = crossEditorClipboardGroup
      ?? (transaction.getMeta("uiEvent") === "cut"
        ? peekBodyCutHistoryGroup()
        : (transaction.getMeta(MIXED_CLIPBOARD_HISTORY_GROUP_META) as string | undefined) ?? null);
    if (mintedClipboardGroup) {
      this.forcedClipboardHistoryGroup = {
        group: mintedClipboardGroup,
        sequence,
      };
    }
    // 同じ操作の後続 transaction にもキーを渡し、次の区間へは持ち越さない。
    const activeForcedClipboardGroup = this.forcedClipboardHistoryGroup;
    const forcedClipboardGroup = activeForcedClipboardGroup?.sequence === sequence
      ? activeForcedClipboardGroup.group
      : null;
    if (!forcedClipboardGroup) {
      this.forcedClipboardHistoryGroup = null;
    }
    return forcedClipboardGroup;
  }

  resetHistory(): void {
    this.forcedClipboardHistoryGroup = null;
  }
}

export function copyTextFlowSelection(view: EditorView, event: ClipboardEvent, previousBlocks: TextFlowBlock[]): boolean {
  if (event.clipboardData && copyActiveTextRunSpan(event.clipboardData)) {
    event.preventDefault();
    return true;
  }
  if (event.clipboardData && !view.state.selection.empty) {
    if (writeTextFlowSelectionClipboard(view, event.clipboardData, previousBlocks)) {
      event.preventDefault();
      return true;
    }
  }
  return false;
}

/** clipboard を書いてから切り取る。跨ぎ選択は overlay の実測後の task へ削除を送る。 */
export function cutTextFlowSelection(view: EditorView, event: ClipboardEvent, previousBlocks: TextFlowBlock[]): boolean {
  if (!event.clipboardData) {
    return false;
  }
  // 本文と図形をまとめて 1 つの undo エントリにするキー。図形側の保存は 250ms
  // 遅れて別の commitDocumentChange として届くので、同じキーを配って畳む
  // (clipboard-history-group.ts の宣言コメント参照)。
  const historyGroup = createMixedClipboardHistoryGroup();
  if (isMultiEditorTextRunSpan()) {
    if (!copyActiveTextRunSpan(event.clipboardData)) {
      return false;
    }
    event.preventDefault();
    const written = readTextSliceClipboardData(event.clipboardData);
    if (written) {
      markBodyTextCut(event, { ...written, historyGroup });
    }
    // 本文を消すのはイベントを抜けてから。overlay の window ハンドラは同じ
    // イベントの中で本文の矩形を測って図形のアンカーを引き直すので、先に
    // 本文が消えていると測り直しがずれる。マイクロタスクではリスナーの合間に
    // 走ってしまうので、イベント 1 つ分あとになるタイマーへ逃がす。
    // 跨ぎ経路は onUpdate を通らない (writer.onChange を直接呼ぶ) ので、キーは
    // 印ではなく引数で渡す。ここで印を置くと誰も読まずに次のカットへ持ち越す。
    window.setTimeout(() => replaceActiveTextRunSpan([], { historyGroup }), 0);
    return true;
  }
  if (view.state.selection.empty) {
    return false;
  }
  // PM 本体の cut はこの後で `clipboardData.clearData()` を呼ぶので、private MIME
  // ではなくモジュール側の印で overlay へ渡す (混在切り取りの本文側)。
  const slice = view.state.selection.content();
  const crossesManualBreak = selectionCrossesManualBreak(view.state);
  if (crossesManualBreak) {
    // この経路は native cut を止めて独自 transaction で構造を保つため、PM は
    // clipboard を書かない。copy と同じ直列化を削除前に完了させる。
    writeTextFlowSelectionClipboard(view, event.clipboardData, previousBlocks);
  }
  markBodyTextCut(event, {
    slice: slice.toJSON(),
    text: sliceTextForClipboard(slice),
    historyGroup,
  });
  // 単一エディタ経路は必ず PM 本体の cut が view.dispatch を続けるので、
  // 本文側は onUpdate でこの印を読む。
  markBodyCutHistoryGroup(historyGroup);
  if (crossesManualBreak && deleteManualBreakSpanningSelection(view, "", {
    historyGroup,
    uiEvent: "cut",
  })) {
    event.preventDefault();
    return true;
  }
  return false;
}

/**
 * 跨ぎ選択と改ページを含む選択はこの経路が所有する。拒否した貼付も true で消費し、
 * native paste へフォールスルーさせない。通常の単一編集面は false で呼び出し側へ返す。
 */
export function pasteAcrossTextFlowSelection(view: EditorView, event: ClipboardEvent, slice: Slice, literalPasteRequested: boolean): boolean {
  if (isMultiEditorTextRunSpan() && event.clipboardData) {
    // 置換が拒否されても (AI ロック等) イベントは飲み込む。PM 既定へ流すと焦点
    // エディタの担当分だけにペーストされてしまう。
    event.preventDefault();
    if (literalPasteRequested) {
      // literal paste (Cmd+Shift+V) も span をバイパスさせない: プレーンテキストを
      // 段落列にして span 置換として適用する (単一エディタの view.pasteText と同じ分割)。
      const literalText = event.clipboardData.getData("text/plain");
      if (literalText) {
        replaceActiveTextRunSpan(plainTextToTextFlowParagraphs(literalText));
      }
      return true;
    }
    const spanPayload = readEditorClipboardPayload(event.clipboardData);
    if (spanPayload?.kind === "textFlowBlocks") {
      replaceActiveTextRunSpan(cloneTextFlowBlocksForPaste(spanPayload.blocks));
      return true;
    }
    if (spanPayload?.kind === "textAndShapes") {
      pasteTextAndShapesIntoTextRunSpan(view, slice, spanPayload);
      return true;
    }
    // payload の無いプレーンテキストは単一エディタ経路 (pasteTextFlowBlocksFromClipboard)
    // と同じく Markdown として解釈してから貼る。跨ぎ選択だけ素通しだと、見えない
    // チャンク境界の有無で「# 見出し」「**太字**」の貼り付け結果が変わってしまう。
    const markdownBlocks = spanPayload
      ? null
      : parsePastedMarkdown(event.clipboardData.getData("text/plain"));
    if (markdownBlocks && markdownBlocks.length > 0) {
      replaceActiveTextRunSpan(markdownBlocks);
      return true;
    }
    const fallbackBlocks = sliceToTextFlowBlocks(slice);
    if (fallbackBlocks.length > 0) {
      replaceActiveTextRunSpan(fallbackBlocks);
    }
    // テキストの無いクリップボード (画像・ファイル等) は選択を保つ。単一エディタの
    // 貼り付けが何もしないのと同じで、選択だけ消える事故を防ぐ。
    return true;
  }
  const replacesManualBreakSelection = selectionCrossesManualBreak(view.state);
  if (replacesManualBreakSelection) {
    const replacement = resolveManualBreakPasteContent(
      view.state,
      event,
      slice,
      literalPasteRequested,
    );
    if (!replacement) {
      // 画像・ファイルだけ、不正 custom payload、現在の schema へ入らない構造では
      // 選択も文書も触らない。
      return consumeRejectedManualBreakPaste(event);
    }
    const outcome = dispatchPreparedManualBreakPaste(view, event, replacement);
    if (outcome.kind !== "applied") {
      return true;
    }
    const { mutation, historyGroup } = outcome;
    if (replacement.shapesPayload && historyGroup) {
      requestOverlayShapesPaste({
        payload: toOverlayShapesClipboardPayload(replacement.shapesPayload),
        anchorBlockIdMap: resolveTextRunSpanAnchorBlockIdMap(
          replacement.sourceBlocks,
          replacement.blocks,
          [mutation],
        ),
        historyGroup,
        source: view.dom,
      });
    }
    return true;
  }
  return false;
}

export function pasteTextFlowBlocksFromClipboard(
  view: EditorView,
  event: ClipboardEvent,
  parsedSlice: Slice,
  onSelect: (blockId: string) => void,
  refreshSelectedTextBlock: (view: EditorView) => void,
): boolean {
  const clipboardData = event.clipboardData;
  if (!clipboardData) {
    return false;
  }

  const clipboardPayload = readEditorClipboardPayload(clipboardData);
  let pastedBlocks: TextFlowBlock[];
  let preservePastedBlockStructure = false;
  if (clipboardPayload?.kind === "textFlowBlocks") {
    pastedBlocks = cloneTextFlowBlocksForPaste(clipboardPayload.blocks);
  } else if (clipboardPayload) {
    return false;
  } else {
    const plainText = clipboardData.getData("text/plain");
    const markdownBlocks = parsePastedMarkdown(plainText);
    if (markdownBlocks) {
      pastedBlocks = markdownBlocks;
      // 見出し・リスト等の明示的な Markdown は独立したブロックとして挿入する。
      preservePastedBlockStructure = markdownBlocks.some((block) => block.type !== "paragraph");
    } else {
      const localPayload = getLocalEditorClipboardPayload();
      if (
        localPayload?.kind !== "textFlowBlocks"
        || !localClipboardPayloadMatchesPlainText(localPayload, plainText)
      ) {
        return false;
      }
      pastedBlocks = cloneTextFlowBlocksForPaste(localPayload.blocks);
    }
  }
  if (pastedBlocks.length === 0) {
    return false;
  }
  const pasteInline = !preservePastedBlockStructure
    && pastedBlocks.length === 1
    && parsedSlice.content.childCount === 1
    && parsedSlice.content.firstChild?.isTextblock === true
    && parsedSlice.openStart > 0
    && parsedSlice.openEnd > 0
    // 選択済みの文字へ貼る場合も、同じ段落内なら文字として置換する。
    // 閉じた slice にすると、前後の本文から切り離された段落が増えてしまう。
    && view.state.selection.$from.sameParent(view.state.selection.$to)
    && view.state.selection.$from.parent.isTextblock;
  pastedBlocks = dropLeadingPastedBreakAtContainerStart(view.state, pastedBlocks);
  if (!pasteInline) {
    pastedBlocks = transferManualBreakToPastedBlocksAtOwnerStart(view.state, pastedBlocks);
  }

  const nodes = pastedBlocks
    .map((block) => {
      try {
        return view.state.schema.nodeFromJSON(textFlowBlockToTiptapNode(block));
      } catch {
        return null;
      }
    })
    .filter((node): node is ProseMirrorModelNode => Boolean(node));
  if (nodes.length === 0) {
    return false;
  }

  event.preventDefault();
  const slice = pasteInline
    ? new Slice(Fragment.fromArray(nodes), 1, 1)
    : new Slice(Fragment.fromArray(nodes), 0, 0);
  const nextSelectedId = pastedBlocks[pastedBlocks.length - 1]?.id;
  const caretAfterPaste = !pasteInline && getCaretSurfaceByViewDom(view.dom)
    ? caretAddressAtBlockEnd(pastedBlocks[pastedBlocks.length - 1])
    : null;
  const previousDocument = view.state.doc;
  try {
    const insertPos = pasteInline ? null : getTextBlockBoundaryInsertPosition(view.state);
    let transaction = insertPos === null
      ? view.state.tr.replaceSelection(slice)
      : view.state.tr.insert(insertPos, slice.content);
    if (!pasteInline && insertPos === null && nextSelectedId) {
      transaction = removeEmptyTextBlockAfterPastedBlock(transaction, nextSelectedId, previousDocument);
    }
    const selectionPos = insertPos === null
      ? transaction.selection.from
      : Math.min(insertPos + slice.content.size, transaction.doc.content.size);
    try {
      transaction = transaction.setSelection(TextSelection.near(transaction.doc.resolve(selectionPos), -1));
    } catch {
      // Keep the paste operation even if ProseMirror cannot place a nearby cursor.
    }
    view.dispatch(transaction.scrollIntoView());
    if (view.state.doc === previousDocument) {
      return true;
    }
  } catch {
    return true;
  }
  view.focus();

  const selectedId = pasteInline ? view.state.selection.$head.parent.attrs.sigmaDocId : nextSelectedId;
  if (selectedId) {
    onSelect(selectedId);
    refreshSelectedTextBlock(view);
  }
  if (caretAfterPaste) {
    // 空段落の置換などで編集面が作り直されても、続きは貼り付け末尾へ入力できるようにする。
    startCaretKeeperWindow();
    requestCaret({ anchor: caretAfterPaste, head: caretAfterPaste, preferredX: null });
    window.queueMicrotask(() => flushPendingCaret());
    window.requestAnimationFrame(() => {
      flushPendingCaret();
      finishCaretKeeperWindow();
    });
  }
  return true;
}

/** 先頭ブロックの break-before は選択の外。内部の区切りだけを payload に残す。 */
export function textFlowBlocksForSelectionClipboard(
  slice: Slice,
  previousBlocks: TextFlowBlock[],
): TextFlowBlock[] {
  const blocks = sliceToTextFlowBlocks(slice, previousBlocks);
  const first = blocks[0];
  if (!first || first.pagination?.break !== true) {
    return blocks;
  }
  const pagination = { ...(first.pagination ?? {}) };
  delete pagination.break;
  return [{
    ...first,
    pagination: Object.keys(pagination).length > 0 ? pagination : undefined,
  }, ...blocks.slice(1)];
}

export function writeTextFlowSelectionClipboard(
  view: EditorView,
  clipboardData: DataTransfer,
  previousBlocks: TextFlowBlock[],
): boolean {
  const slice = view.state.selection.content();
  const copiedBlocks = textFlowBlocksForSelectionClipboard(slice, previousBlocks);
  if (copiedBlocks.length === 0) {
    return false;
  }
  const container = view.dom.ownerDocument.createElement("div");
  container.appendChild(DOMSerializer.fromSchema(view.state.schema).serializeFragment(
    slice.content,
    { document: view.dom.ownerDocument },
  ));
  const text = sliceTextForClipboard(slice);
  writeEditorClipboardData(
    clipboardData,
    createTextFlowClipboardPayload(copiedBlocks),
    { html: container.innerHTML },
  );
  writeTextSliceClipboardData(clipboardData, slice.toJSON(), text);
  return true;
}

export function pasteTextAndShapesFromClipboard(
  view: EditorView,
  event: ClipboardEvent,
  fallbackSlice: Slice,
  payload: Extract<EditorClipboardPayload, { kind: "textAndShapes" }>,
): boolean {
  let textSlice: Slice | null = null;
  try {
    textSlice = Slice.fromJSON(view.state.schema, payload.text.slice);
  } catch {
    textSlice = fallbackSlice.size > 0 ? fallbackSlice : null;
  }
  if (!textSlice || textSlice.size === 0) {
    return false;
  }

  textSlice = transferManualBreakToPastedSliceAtOwnerStart(view.state, textSlice);
  const { transaction, anchorBlockIdMap } = insertTextSliceWithFreshBlockIds(view.state, textSlice);
  event.preventDefault();
  // 本文と図形を 1 つの undo エントリに畳むキー。本文の record が必ず先 (この dispatch は
  // 同期で onUpdate を呼ぶ) で、図形は 250ms 後に同じキーで届いて畳まれる。
  const historyGroup = createMixedClipboardHistoryGroup();
  view.dispatch(transaction
    .scrollIntoView()
    .setMeta("paste", true)
    .setMeta("uiEvent", "paste")
    .setMeta(MIXED_CLIPBOARD_HISTORY_GROUP_META, historyGroup));
  requestOverlayShapesPaste({
    payload: toOverlayShapesClipboardPayload(payload),
    anchorBlockIdMap,
    historyGroup,
    source: view.dom,
  });
  return true;
}

/**
 * 跨ぎ選択への本文+図形ペースト。テキストは span 置換で入れ、図形はコピー元ブロック id →
 * 置換後ブロック id の対応でアンカーを読み替えてオーバーレイ側に貼ってもらう
 * (単一エディタの pasteTextAndShapesFromClipboard と同じ流れ)。
 */
function pasteTextAndShapesIntoTextRunSpan(
  view: EditorView,
  fallbackSlice: Slice,
  payload: Extract<EditorClipboardPayload, { kind: "textAndShapes" }>,
): void {
  let textSlice: Slice;
  try {
    textSlice = Slice.fromJSON(view.state.schema, payload.text.slice);
  } catch {
    textSlice = fallbackSlice;
  }
  const sourceBlocks = sliceToTextFlowBlocks(textSlice);
  if (sourceBlocks.length === 0) {
    return;
  }
  const pastedBlocks = cloneTextFlowBlocksForPaste(sourceBlocks);
  const historyGroup = createMixedClipboardHistoryGroup();
  const mutations = replaceActiveTextRunSpan(pastedBlocks, { historyGroup });
  if (!mutations) {
    return;
  }
  requestOverlayShapesPaste({
    payload: toOverlayShapesClipboardPayload(payload),
    anchorBlockIdMap: resolveTextRunSpanAnchorBlockIdMap(sourceBlocks, pastedBlocks, mutations),
    historyGroup,
    source: view.dom,
  });
}

export function isLiteralPasteShortcut(
  event: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "key" | "metaKey" | "shiftKey">,
): boolean {
  return !event.altKey &&
    event.shiftKey &&
    (event.metaKey || event.ctrlKey) &&
    event.key.toLowerCase() === "v";
}

export function getTextBlockBoundaryInsertPosition(state: EditorState): number | null {
  const { selection } = state;
  if (!selection.empty) {
    return null;
  }

  const { $from } = selection;
  // 空段落はその場で置き換える。直前へ挿すと空行が残り、その段落を所有する
  // 旧編集面も貼り付け済みの本文を保持して、新しい編集面と二重に描画しうる。
  if ($from.parent.isTextblock && isEmptyEditorTextBlock($from.parent)) {
    return null;
  }
  if ($from.depth === 0) {
    return $from.pos;
  }

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name !== "paragraph" && node.type.name !== "heading") {
      continue;
    }

    const offset = $from.pos - $from.start(depth);
    if (offset === 0) {
      return $from.before(depth);
    }
    if (offset === node.content.size) {
      return $from.after(depth);
    }
    return null;
  }

  return null;
}

function removeEmptyTextBlockAfterPastedBlock(
  transaction: Transaction,
  blockId: string,
  previousDocument: ProseMirrorModelNode,
): Transaction {
  let deleteRange: { from: number; to: number } | null = null;
  transaction.doc.descendants((node, pos, parent, index) => {
    if (deleteRange || !parent || typeof index !== "number" || node.attrs.sigmaDocId !== blockId) {
      return undefined;
    }

    if (index >= parent.childCount - 1) {
      return false;
    }

    const next = parent.child(index + 1);
    if (next.type.name === "paragraph" && isEmptyEditorTextBlock(next)) {
      // 貼り付け前から存在した空行は消さない。除去対象はPMが挿入時に作った空段落だけ。
      let existedBeforePaste = false;
      previousDocument.descendants((previous) => {
        if (previous.attrs.sigmaDocId && previous.attrs.sigmaDocId === next.attrs.sigmaDocId) {
          existedBeforePaste = true;
        }
        return !existedBeforePaste;
      });
      if (existedBeforePaste) {
        return false;
      }
      const from = pos + node.nodeSize;
      deleteRange = { from, to: from + next.nodeSize };
    }
    return false;
  });

  const range = deleteRange as { from: number; to: number } | null;
  return range ? transaction.delete(range.from, range.to) : transaction;
}
