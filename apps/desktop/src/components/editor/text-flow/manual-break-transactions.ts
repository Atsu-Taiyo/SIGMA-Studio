import { Fragment, Slice, type Node as ProseMirrorModelNode } from "@tiptap/pm/model";
import { TextSelection, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import {
  clampCaretOffset,
  getPageBreakBeforeIds as collectPageBreakBeforeIds,
  getNestedPageBreakBeforeIds,
  getTextFlowBlockIds,
  type TextFlowBlock,
} from "@/features/text-editing";
import { EDITOR_CLIPBOARD_MIME, cloneTextFlowBlocksForPaste, readEditorClipboardPayload, type EditorClipboardPayload } from "@/lib/editor-clipboard";
import { createId } from "@/lib/id";
import type { TiptapDoc } from "@/lib/tiptap-adapter";

import { createMixedClipboardHistoryGroup, MIXED_CLIPBOARD_HISTORY_GROUP_META } from "./clipboard-history-group";
import { parsePastedMarkdown } from "./markdown-paste";
import { buildTextRunReplacementMutations, type TextRunReplacementMutation } from "./text-run-replacement";
import { plainTextToTextFlowParagraphs, sliceToTextFlowBlocks } from "./text-run-slice";
import { textFlowBlockToTiptapNode, textFlowToTiptap, tiptapToTextFlow } from "./tiptap-document-adapter";

/** 準備済みの置換を受理できたときだけ、図形貼付へ渡せる mutation と履歴キーを返す。 */
export type ManualBreakPasteDispatchResult =
  | { kind: "rejected" }
  | { kind: "applied"; mutation: TextRunReplacementMutation; historyGroup: string | undefined };

/**
 * 内容を全て検証した後に native paste を止め、1 transaction で置換する。
 * PM の edit guard が拒否したときも、native 置換や図形だけの貼付へ戻らない。
 */
export function dispatchPreparedManualBreakPaste(
  view: EditorView,
  event: Pick<ClipboardEvent, "preventDefault">,
  replacement: ManualBreakPasteContent,
): ManualBreakPasteDispatchResult {
  const historyGroup = replacement.shapesPayload
    ? createMixedClipboardHistoryGroup()
    : undefined;
  event.preventDefault();
  const mutation = replaceManualBreakSpanningSelection(
    view,
    replacement.blocks,
    historyGroup ? { historyGroup, uiEvent: "paste" } : undefined,
  );
  if (!mutation) {
    return { kind: "rejected" };
  }
  return { kind: "applied", mutation, historyGroup };
}

export function dropLeadingPastedBreakAtContainerStart(
  state: EditorState,
  blocks: TextFlowBlock[],
): TextFlowBlock[] {
  const first = blocks[0];
  if (!first || first.pagination?.break !== true || !state.selection.empty) {
    return blocks;
  }
  const { $from } = state.selection;
  let textDepth = -1;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).isTextblock) {
      textDepth = depth;
      break;
    }
  }
  if (textDepth < 1 || $from.parentOffset !== 0 || $from.index(textDepth - 1) !== 0) {
    return blocks;
  }
  const pagination = { ...(first.pagination ?? {}) };
  delete pagination.break;
  return [{
    ...first,
    pagination: Object.keys(pagination).length > 0 ? pagination : undefined,
  }, ...blocks.slice(1)];
}

/**
 * break owner のテキスト先頭でブロック貼り付けを行うとき、先頭貼付ブロックへ break を
 * 明示する。PM 上の挿入位置は owner の直前だが、書き戻し adapter がこの印を読んで旧 owner
 * から break を外すため、SigmaDoc 上では貼付内容全体が区切りの後ろ側に残る。
 */
export function transferManualBreakToPastedBlocksAtOwnerStart(
  state: EditorState,
  blocks: TextFlowBlock[],
): TextFlowBlock[] {
  if (!isManualBreakOwnerTextStart(state) || blocks.length === 0) {
    return blocks;
  }
  const first = blocks[0];
  return [{
    ...first,
    pagination: { ...(first.pagination ?? {}), break: true },
  }, ...blocks.slice(1)];
}

export function transferManualBreakToPastedSliceAtOwnerStart(
  state: EditorState,
  slice: Slice,
): Slice {
  if (!isManualBreakOwnerTextStart(state) || slice.content.childCount === 0) {
    return slice;
  }
  const nodes: ProseMirrorModelNode[] = [];
  slice.content.forEach((node, _offset, index) => {
    if (index !== 0 || !node.isBlock) {
      nodes.push(node);
      return;
    }
    nodes.push(node.type.create(
      {
        ...node.attrs,
        pagination: { ...(node.attrs.pagination ?? {}), break: true },
      },
      node.content,
      node.marks,
    ));
  });
  return new Slice(Fragment.fromArray(nodes), slice.openStart, slice.openEnd);
}

function isManualBreakOwnerTextStart(state: EditorState): boolean {
  if (!state.selection.empty || state.selection.$from.parentOffset !== 0) {
    return false;
  }
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).attrs.pagination?.break === true) {
      return true;
    }
  }
  return false;
}

/**
 * 改ページ/改段を含む範囲を SigmaDoc ブロック列として置換する。両端の文字断片だけを残し、
 * 完全選択された中間ブロックは構造ごと削除する一方、break の最小所有構造は保持する。
 */
export function deleteManualBreakSpanningSelection(
  view: EditorView,
  insertion: string | readonly TextFlowBlock[] = "",
  metadata?: { historyGroup: string; uiEvent: "cut" | "paste" },
): boolean {
  return replaceManualBreakSpanningSelection(view, insertion, metadata) !== null;
}

function replaceManualBreakSpanningSelection(
  view: EditorView,
  insertion: string | readonly TextFlowBlock[],
  metadata?: { historyGroup: string; uiEvent: "cut" | "paste" },
): TextRunReplacementMutation | null {
  const { state } = view;
  const { selection } = state;
  if (selection.empty || !selectionCrossesManualBreak(state)) {
    return null;
  }

  const previousBlocks = tiptapToTextFlow(state.doc.toJSON() as TiptapDoc);
  const before = sliceToTextFlowBlocks(state.doc.slice(0, selection.from), previousBlocks);
  const after = sliceToTextFlowBlocks(
    state.doc.slice(selection.to, state.doc.content.size),
    previousBlocks,
  );
  const inserted = typeof insertion === "string"
    ? insertion
      ? [{ type: "paragraph" as const, id: createId("p"), children: [{ type: "text" as const, text: insertion }] }]
      : []
    : [...insertion];
  // 単一エディタの両端も span と同じ 2 セグメントとして扱う。入力は先行断片へ結合し、
  // break を持つ後続断片とは結合しない。
  const [replacement] = buildTextRunReplacementMutations([{
    unitId: "single-editor-leading",
    scopeId: "single-editor",
    previousIds: getTextFlowBlockIds(previousBlocks),
    previousBlocks,
    before,
    after: [],
    startsInsideTextBlock: true,
    preserveEmpty: true,
  }, {
    unitId: "single-editor-trailing",
    scopeId: "single-editor",
    previousIds: [],
    before: [],
    after,
    endsInsideTextBlock: true,
    preserveEmpty: true,
  }], inserted, () => ({ type: "paragraph", id: createId("p"), children: [] }));
  if (!replacement) {
    return null;
  }

  let replacementDoc: ProseMirrorModelNode;
  try {
    replacementDoc = state.schema.nodeFromJSON(textFlowToTiptap(replacement.nextBlocks));
  } catch {
    return null;
  }
  let transaction = state.tr.replaceWith(0, state.doc.content.size, replacementDoc.content);
  const caret = replacement.selection?.head;
  if (caret) {
    let caretPos: number | null = null;
    transaction.doc.descendants((node, pos) => {
      if (node.attrs.sigmaDocId === caret.blockId) {
        caretPos = pos + 1 + clampCaretOffset(caret.offset, node.content.size);
        return false;
      }
      return true;
    });
    if (caretPos !== null) {
      transaction = transaction.setSelection(TextSelection.create(transaction.doc, caretPos));
    }
  }
  if (metadata) {
    transaction = transaction
      .setMeta("uiEvent", metadata.uiEvent)
      .setMeta(MIXED_CLIPBOARD_HISTORY_GROUP_META, metadata.historyGroup);
  }
  const dispatched = transaction.scrollIntoView();
  view.dispatch(dispatched);
  // edit guard などの filterTransaction が拒否した場合は、挿入成功として後続処理
  // (特に図形貼付)へ進ませない。
  return view.state.doc.eq(dispatched.doc) ? replacement : null;
}

export interface ManualBreakPasteContent {
  blocks: TextFlowBlock[];
  shapesPayload?: Extract<EditorClipboardPayload, { kind: "textAndShapes" }>;
  sourceBlocks: TextFlowBlock[];
}

/**
 * 改ページ跨ぎ paste を dispatch 前に完全な SigmaDoc 挿入列へ正規化する。
 * ここで null なら削除 transaction も作らない。
 */
export function resolveManualBreakPasteContent(
  state: EditorState,
  event: ClipboardEvent,
  slice: Slice,
  literalPasteRequested: boolean,
): ManualBreakPasteContent | null {
  const clipboardData = event.clipboardData;
  let sourceBlocks: TextFlowBlock[] = [];
  let blocks: TextFlowBlock[] = [];
  let shapesPayload: Extract<EditorClipboardPayload, { kind: "textAndShapes" }> | undefined;

  if (literalPasteRequested) {
    const text = clipboardData?.getData("text/plain") ?? "";
    sourceBlocks = text ? plainTextToTextFlowParagraphs(text) : [];
    blocks = sourceBlocks;
  } else if (clipboardData) {
    const payload = readEditorClipboardPayload(clipboardData);
    if (payload?.kind === "textFlowBlocks") {
      sourceBlocks = payload.blocks;
      blocks = cloneTextFlowBlocksForPaste(payload.blocks);
    } else if (payload?.kind === "textAndShapes") {
      let textSlice: Slice | null = null;
      try {
        textSlice = Slice.fromJSON(state.schema, payload.text.slice);
      } catch {
        textSlice = slice.size > 0 ? slice : null;
      }
      sourceBlocks = textSlice ? sliceToTextFlowBlocks(textSlice) : [];
      blocks = cloneTextFlowBlocksForPaste(sourceBlocks);
      shapesPayload = payload;
    } else if (payload) {
      return null;
    } else {
      const html = clipboardData.getData("text/html");
      const hasRejectedSigmaPayload = Boolean(clipboardData.getData(EDITOR_CLIPBOARD_MIME))
        || html.includes("data-sigma-studio-clipboard");
      if (hasRejectedSigmaPayload) {
        return null;
      }
      // 通常の rich clipboard は PM が schema に合わせて parse 済みの slice を優先する。
      // plain text を先に Markdown 化すると、HTML 側の marks や block 構造が失われる。
      const richBlocks = html.trim() ? sliceToTextFlowBlocks(slice) : [];
      const markdownBlocks = richBlocks.length === 0
        ? parsePastedMarkdown(clipboardData.getData("text/plain"))
        : null;
      sourceBlocks = richBlocks.length > 0
        ? richBlocks
        : markdownBlocks && markdownBlocks.length > 0
          ? markdownBlocks
          : sliceToTextFlowBlocks(slice);
      blocks = cloneTextFlowBlocksForPaste(sourceBlocks);
    }
  } else {
    sourceBlocks = sliceToTextFlowBlocks(slice);
    blocks = cloneTextFlowBlocksForPaste(sourceBlocks);
  }

  if (blocks.length === 0 || !blocks.every((block) => {
    try {
      state.schema.nodeFromJSON(textFlowBlockToTiptapNode(block));
      return true;
    } catch {
      return false;
    }
  })) {
    return null;
  }
  return { blocks, shapesPayload, sourceBlocks };
}

/** 改ページ跨ぎ選択では native replacement へ決してフォールスルーさせない。 */
export function consumeRejectedManualBreakPaste(
  event: Pick<ClipboardEvent, "preventDefault">,
): true {
  event.preventDefault();
  return true;
}

export function pasteHasUsableContent(
  state: EditorState,
  event: ClipboardEvent,
  slice: Slice,
  literalPasteRequested: boolean,
): boolean {
  const clipboardData = event.clipboardData;
  if (literalPasteRequested) {
    return Boolean(clipboardData?.getData("text/plain"));
  }
  if (!clipboardData) {
    return slice.size > 0;
  }
  const payload = readEditorClipboardPayload(clipboardData);
  if (payload?.kind === "textFlowBlocks") {
    return payload.blocks.some((block) => {
      try {
        state.schema.nodeFromJSON(textFlowBlockToTiptapNode(block));
        return true;
      } catch {
        return false;
      }
    });
  }
  if (payload?.kind === "textAndShapes") {
    try {
      return Slice.fromJSON(state.schema, payload.text.slice).size > 0 || slice.size > 0;
    } catch {
      return slice.size > 0;
    }
  }
  if (payload) {
    return slice.size > 0;
  }
  if (clipboardData.getData("text/plain")) {
    return true;
  }
  return slice.size > 0;
}

export function selectionCrossesManualBreak(state: EditorState): boolean {
  const { selection } = state;
  if (selection.empty) {
    return false;
  }
  let crosses = false;
  state.doc.descendants((node, pos) => {
    if (node.attrs.pagination?.break !== true) {
      return !node.isTextblock && !node.isLeaf;
    }
    const first = TextSelection.findFrom(
      state.doc.resolve(Math.min(state.doc.content.size, pos + 1)),
      1,
      true,
    );
    if (first && selection.from < first.from && first.from <= selection.to) {
      crosses = true;
    }
    return false;
  });
  return crosses;
}

export function resolveManualBreakBoundaryNavigation(
  state: EditorState,
  direction: "backward" | "forward" | null,
  blocks: TextFlowBlock[],
  event?: Pick<KeyboardEvent, "altKey" | "ctrlKey" | "metaKey" | "isComposing" | "shiftKey">,
): { blockId: string; position: number } | null {
  if (
    !direction
    || event?.shiftKey
    || event?.isComposing
    || !state.selection.empty
  ) {
    return null;
  }

  const breakIds = new Set([
    ...collectPageBreakBeforeIds(blocks),
    ...getNestedPageBreakBeforeIds(blocks),
  ]);
  if (breakIds.size === 0) {
    return null;
  }

  const { $from } = state.selection;
  const parent = $from.parent;
  if (!parent.isTextblock
    || state.selection.from !== (direction === "backward" ? $from.start() : $from.end())) {
    return null;
  }

  if (direction === "backward") {
    const owner = getManualBreakOwnerAtPosition(state, state.selection.from, breakIds);
    if (!owner || state.selection.from !== owner.firstCursorPosition) {
      return null;
    }
    const previous = TextSelection.findFrom(state.doc.resolve(owner.nodeStart), -1, true);
    return previous ? { blockId: owner.blockId, position: previous.from } : null;
  }

  const next = TextSelection.findFrom(
    state.doc.resolve(Math.min(state.doc.content.size, $from.end() + 1)),
    1,
    true,
  );
  if (!next) {
    return null;
  }
  const owner = getManualBreakOwnerAtPosition(state, next.from, breakIds);
  if (!owner || next.from !== owner.firstCursorPosition) {
    return null;
  }
  return { blockId: owner.blockId, position: next.from };
}

function getManualBreakOwnerAtPosition(
  state: EditorState,
  position: number,
  breakIds: ReadonlySet<string>,
): { blockId: string; nodeStart: number; firstCursorPosition: number } | null {
  const resolved = state.doc.resolve(Math.max(0, Math.min(position, state.doc.content.size)));
  for (let depth = resolved.depth; depth > 0; depth -= 1) {
    const blockId = resolved.node(depth).attrs.sigmaDocId;
    if (typeof blockId !== "string" || !breakIds.has(blockId)) {
      continue;
    }
    const nodeStart = resolved.before(depth);
    const first = TextSelection.findFrom(
      state.doc.resolve(Math.min(state.doc.content.size, nodeStart + 1)),
      1,
      true,
    );
    if (first) {
      return {
        blockId,
        nodeStart,
        firstCursorPosition: first.from,
      };
    }
  }
  return null;
}
