import type { Editor as TiptapEditor } from "@tiptap/core";
import { TextSelection, type EditorState } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";

import { findAncestorNodeDepth } from "@/components/tiptap/node-queries";
import { parseTextFlowCommandTrigger, type TextFlowCommandDefinition } from "@/features/text-editing";
import { createBlock } from "@/lib/document-tree";
import { createBoxBlock } from "@/lib/box-blocks";
import { createTranslator, getAppLocale } from "@/lib/i18n";
import { applyRememberedBoxFrame } from "@/lib/remembered-box-style";
import type { MaterialItem } from "@/types/material";

import { bodyBlockCommandId, bodyBlockCommandKindFromId, type ActiveSlashCommandQuery, type SlashCommandCandidate } from "./slash-command-model";
import { textFlowBlockToTiptapNode } from "./tiptap-document-adapter";
import type { TextFlowEditorProps } from "./types";

/**
 * いま置ける本文ブロック。置けない物を一覧に出すと「選んでも何も起きない」候補になるので、
 * キャレットの位置から先に絞る (引用の中の引用、コードの中のコードは作れない)。
 */
function getAvailableBodyBlockCommandIds(state: EditorState): string[] {
  const { $from } = state.selection;
  const ids: string[] = [];
  if (state.schema.nodes.quote && findAncestorNodeDepth($from, "quote") < 0) {
    ids.push(bodyBlockCommandId("quote"));
  }
  if (state.schema.nodes.codeBlock && $from.parent.type.name !== "codeBlock") {
    ids.push(bodyBlockCommandId("codeBlock"));
  }
  if (state.schema.nodes.divider) {
    ids.push(bodyBlockCommandId("divider"));
  }
  return ids;
}

export function handleSlashCommandQueryKeyDown(
  view: EditorView,
  event: KeyboardEvent,
  slashCommandQueryRef: { current: ActiveSlashCommandQuery | null },
  slashCommandCandidatesRef: { current: SlashCommandCandidate[] },
  slashCommandActiveIndexRef: { current: number },
  setSlashCommandActiveIndex: (updater: (current: number) => number) => void,
  onMaterialInsertRef: { current: TextFlowEditorProps["onMaterialInsert"] },
  onBoxCommandRef: { current: TextFlowEditorProps["onBoxCommand"] },
  onProblemCommandRef: { current: TextFlowEditorProps["onProblemCommand"] },
  onBodyBlockCommandRef: { current: TextFlowEditorProps["onBodyBlockCommand"] },
  editorRef: { current: TiptapEditor | null },
  onHeadingCommandRef: { current: TextFlowEditorProps["onHeadingCommand"] },
  setSlashCommandQuery: (query: ActiveSlashCommandQuery | null) => void,
): boolean {
  if (!slashCommandQueryRef.current) {
    return false;
  }

  if (event.key === "Escape") {
    event.preventDefault();
    setSlashCommandQuery(null);
    return true;
  }

  const candidates = slashCommandCandidatesRef.current;
  if (candidates.length === 0) {
    return false;
  }

  if (event.key === "ArrowDown") {
    event.preventDefault();
    setSlashCommandActiveIndex((current) => (current + 1) % candidates.length);
    return true;
  }

  if (event.key === "ArrowUp") {
    event.preventDefault();
    setSlashCommandActiveIndex((current) => (current - 1 + candidates.length) % candidates.length);
    return true;
  }

  if ((event.key === "Enter" || event.key === "Tab") && !event.metaKey && !event.ctrlKey) {
    event.preventDefault();
    insertSlashCommandFromQuery(
      view,
      candidates[slashCommandActiveIndexRef.current] ?? candidates[0],
      slashCommandQueryRef,
      onMaterialInsertRef,
      onBoxCommandRef,
      onProblemCommandRef,
      onBodyBlockCommandRef,
      editorRef,
      onHeadingCommandRef,
      setSlashCommandQuery,
    );
    return true;
  }

  return false;
}

export function insertSlashCommandFromQuery(
  view: EditorView,
  candidate: SlashCommandCandidate,
  slashCommandQueryRef: { current: ActiveSlashCommandQuery | null },
  onMaterialInsertRef: { current: TextFlowEditorProps["onMaterialInsert"] },
  onBoxCommandRef: { current: TextFlowEditorProps["onBoxCommand"] },
  onProblemCommandRef: { current: TextFlowEditorProps["onProblemCommand"] },
  onBodyBlockCommandRef: { current: TextFlowEditorProps["onBodyBlockCommand"] },
  editorRef: { current: TiptapEditor | null },
  onHeadingCommandRef: { current: TextFlowEditorProps["onHeadingCommand"] },
  setSlashCommandQuery: (query: ActiveSlashCommandQuery | null) => void,
): void {
  if (candidate.kind === "problem") {
    insertProblemCommandFromQuery(view, slashCommandQueryRef, onProblemCommandRef, setSlashCommandQuery);
    return;
  }

  if (candidate.kind === "block") {
    insertBodyBlockCommandFromQuery(
      view,
      candidate.block,
      slashCommandQueryRef,
      editorRef,
      onBodyBlockCommandRef,
      setSlashCommandQuery,
    );
    return;
  }

  if (candidate.kind === "heading") {
    insertHeadingCommandFromQuery(
      view,
      candidate.heading.level,
      slashCommandQueryRef,
      onHeadingCommandRef,
      setSlashCommandQuery,
    );
    return;
  }

  if (candidate.kind === "box") {
    insertBoxCommandFromQuery(view, candidate.box, slashCommandQueryRef, onBoxCommandRef, setSlashCommandQuery);
    return;
  }

  insertMaterialFromQuery(view, candidate.material, slashCommandQueryRef, onMaterialInsertRef, setSlashCommandQuery);
}

function insertHeadingCommandFromQuery(
  view: EditorView,
  level: 1 | 2 | 3,
  slashCommandQueryRef: { current: ActiveSlashCommandQuery | null },
  onHeadingCommandRef: { current: TextFlowEditorProps["onHeadingCommand"] },
  setSlashCommandQuery: (query: ActiveSlashCommandQuery | null) => void,
): void {
  const query = slashCommandQueryRef.current;
  if (!query) return;
  const { state } = view;
  const { $from } = state.selection;
  const trailingText = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, "", "");
  const headingType = state.schema.nodes.heading;
  if (!state.selection.empty || !$from.parent.isTextblock || trailingText.trim() || !headingType) {
    setSlashCommandQuery(null);
    return;
  }
  if (!(onHeadingCommandRef.current?.({ triggerBlockId: query.blockId, level }) ?? true)) {
    setSlashCommandQuery(null);
    return;
  }

  const blockFrom = $from.before($from.depth);
  const removedSize = query.to - query.from;
  const transaction = state.tr.delete(query.from, query.to);
  transaction.setBlockType(
    blockFrom,
    Math.max(blockFrom + 1, $from.after($from.depth) - removedSize),
    headingType,
    { ...$from.parent.attrs, level },
  );
  transaction.setSelection(TextSelection.create(transaction.doc, query.from));
  view.dispatch(transaction.scrollIntoView());
  view.focus();
  setSlashCommandQuery(null);
}

function insertMaterialFromQuery(
  view: EditorView,
  material: MaterialItem,
  slashCommandQueryRef: { current: ActiveSlashCommandQuery | null },
  onMaterialInsertRef: { current: TextFlowEditorProps["onMaterialInsert"] },
  setSlashCommandQuery: (query: ActiveSlashCommandQuery | null) => void,
): void {
  const query = slashCommandQueryRef.current;
  if (!query) {
    return;
  }

  setSlashCommandQuery(null);
  view.dispatch(view.state.tr.delete(query.from, query.to));
  view.focus();

  onMaterialInsertRef.current?.({
    material,
    triggerBlockId: query.blockId,
    screenPoint: query.screenPoint,
  });
}

function insertProblemCommandFromQuery(
  view: EditorView,
  slashCommandQueryRef: { current: ActiveSlashCommandQuery | null },
  onProblemCommandRef: { current: TextFlowEditorProps["onProblemCommand"] },
  setSlashCommandQuery: (query: ActiveSlashCommandQuery | null) => void,
): void {
  const query = slashCommandQueryRef.current;
  if (!query) {
    return;
  }

  const { state } = view;
  if (!state.selection.empty) {
    setSlashCommandQuery(null);
    return;
  }

  const { $from } = state.selection;
  const trailingText = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, "", "");
  if (!$from.parent.isTextblock || trailingText.trim().length > 0) {
    setSlashCommandQuery(null);
    return;
  }

  if (isSelectionInsideBoxBlock(state) && $from.node($from.depth - 1).type.name === "boxBlockBody") {
    const problem = createBlock("problem", createTranslator(getAppLocale(), "editor"));
    const from = $from.before($from.depth);
    const node = state.schema.nodeFromJSON(textFlowBlockToTiptapNode(problem));
    const paragraph = state.schema.nodes.paragraph.create();
    const transaction = state.tr.replaceWith(from, $from.after($from.depth), [node, paragraph]);
    transaction.setSelection(TextSelection.create(transaction.doc, from + node.nodeSize + 1));
    setSlashCommandQuery(null);
    view.dispatch(transaction.scrollIntoView());
    view.focus();
    return;
  }

  const handledByHost = onProblemCommandRef.current?.({
    triggerBlockId: query.blockId,
  }) ?? false;
  if (!handledByHost) {
    setSlashCommandQuery(null);
    return;
  }

  view.dispatch(state.tr.delete(query.from, query.to).scrollIntoView());
  view.focus();
  setSlashCommandQuery(null);
}

/**
 * 本文ブロック (引用・コード・区切り線) を `/` から作る。
 *
 * 打った `/引用` の文字を消してから **Tiptap のコマンドをそのまま呼ぶ** のが肝で、ツールバー・
 * 入力ルール (`> `, ```` ``` ````, `---`) と同じ 1 本の経路を通る。ここで独自に段落を作り替えると、
 * リストからの抜け方やコードの fence 除去といった約束が `/` からだけ抜け落ちる。
 */
function insertBodyBlockCommandFromQuery(
  view: EditorView,
  candidate: TextFlowCommandDefinition,
  slashCommandQueryRef: { current: ActiveSlashCommandQuery | null },
  editorRef: { current: TiptapEditor | null },
  onBodyBlockCommandRef: { current: TextFlowEditorProps["onBodyBlockCommand"] },
  setSlashCommandQuery: (query: ActiveSlashCommandQuery | null) => void,
): void {
  const query = slashCommandQueryRef.current;
  const editor = editorRef.current;
  const kind = bodyBlockCommandKindFromId(candidate.id);
  setSlashCommandQuery(null);
  if (!query || !kind || !editor || editor.isDestroyed) {
    return;
  }

  // 先にトリガー文字だけを消す。ブロックを作り替えるコマンドは「いまの段落」を対象に取るので、
  // `/引用` が残ったまま包むと引用の中に `/引用` という本文が残る。
  view.dispatch(view.state.tr.delete(query.from, query.to));
  view.focus();

  // ホストが受けるならそちらへ渡す。入れ物を作る操作はこのエディタごと remount させるので、
  // 焦点の戻し先を知っているのはホストだけ (ツールバーのブロックボタンと同じ経路)。
  if (onBodyBlockCommandRef.current?.({ kind, triggerBlockId: query.blockId })) {
    return;
  }

  const chain = editor.chain().focus();
  if (kind === "quote") {
    chain.toggleQuoteBlock().run();
    return;
  }
  if (kind === "codeBlock") {
    chain.toggleCodeBlock().run();
    return;
  }
  chain.toggleDivider().run();
}

function insertBoxCommandFromQuery(
  view: EditorView,
  candidate: TextFlowCommandDefinition,
  slashCommandQueryRef: { current: ActiveSlashCommandQuery | null },
  onBoxCommandRef: { current: TextFlowEditorProps["onBoxCommand"] },
  setSlashCommandQuery: (query: ActiveSlashCommandQuery | null) => void,
): void {
  const query = slashCommandQueryRef.current;
  if (!query) {
    return;
  }

  const { state } = view;
  const { selection } = state;
  if (!selection.empty || !query.canInsertBox) {
    setSlashCommandQuery(null);
    return;
  }

  const { $from } = selection;
  const trailingText = $from.parent.textBetween($from.parentOffset, $from.parent.content.size, "", "");
  if (!$from.parent.isTextblock || trailingText.trim().length > 0) {
    setSlashCommandQuery(null);
    return;
  }

  const handledByHost = onBoxCommandRef.current?.({
    styleId: candidate.id,
    commandName: candidate.commandName,
    displayName: candidate.displayName,
    triggerBlockId: query.blockId,
  }) ?? false;

  if (handledByHost) {
    view.dispatch(state.tr.delete(query.from, query.to).scrollIntoView());
    view.focus();
    setSlashCommandQuery(null);
    return;
  }

  // 既定タイトルは**文書に焼き込まれる**ので、挿入した時点の UI 言語で解決する。
  // ここは React の外 (module 直下のヘルパ) なので `useT` ではなくストアから引く。
  const boxBlock = applyRememberedBoxFrame(
    createBoxBlock(candidate.id, "", {}, createTranslator(getAppLocale(), "editor")),
  );
  const boxNode = state.schema.nodeFromJSON(textFlowBlockToTiptapNode(boxBlock));
  const from = $from.before($from.depth);
  const to = $from.after($from.depth);
  const transaction = state.tr.replaceWith(from, to, boxNode);
  const focusPos = Math.min(transaction.doc.content.size, from + 2);
  try {
    transaction.setSelection(TextSelection.create(transaction.doc, focusPos));
  } catch {
    // If the schema changes, the insertion should still succeed even if focus falls back.
  }
  view.dispatch(transaction.scrollIntoView());
  view.focus();
  setSlashCommandQuery(null);
}

export function getActiveSlashCommandQuery(view: EditorView): ActiveSlashCommandQuery | null {
  const { selection } = view.state;
  if (!selection.empty) {
    return null;
  }

  const { $from } = selection;
  if (findAncestorNodeDepth($from, "boxBlockTitle") >= 0) {
    return null;
  }
  const parent = $from.parent;
  if (!parent.isTextblock) {
    return null;
  }

  const blockId = typeof parent.attrs.sigmaDocId === "string" ? parent.attrs.sigmaDocId : "";
  if (!blockId) {
    return null;
  }

  const beforeCursor = parent.textBetween(0, $from.parentOffset, "", "");
  const trigger = parseTextFlowCommandTrigger(beforeCursor);
  if (!trigger) {
    return null;
  }

  const trailingText = parent.textBetween($from.parentOffset, parent.content.size, "", "");
  const canInsertBox = trailingText.trim().length === 0;
  const availableBlockCommandIds = trailingText.trim().length === 0
    ? getAvailableBodyBlockCommandIds(view.state)
    : [];
  const from = selection.from - trigger.triggerLength;
  const to = selection.from;
  try {
    const rect = view.coordsAtPos(from);
    return {
      blockId,
      from,
      to,
      query: trigger.query,
      canInsertBox,
      availableBlockCommandIds,
      rect: {
        bottom: rect.bottom,
        left: rect.left,
      },
      screenPoint: {
        x: rect.left,
        y: rect.top,
      },
    };
  } catch {
    return null;
  }
}

function isSelectionInsideBoxBlock(state: EditorState): boolean {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name === "boxBlock") {
      return true;
    }
  }
  return false;
}
