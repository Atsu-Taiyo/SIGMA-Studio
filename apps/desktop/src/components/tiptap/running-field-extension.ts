import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import {
  findRunningRegionFields,
  resolveRunningRegionField,
  type RunningRegionFieldValues,
} from "@/features/document";

/**
 * ヘッダー/フッターの差し込み (`{title}` `{page}` `{total}`) を、そのページの値で見せる装飾。
 *
 * 本文には書いた文字 (`{page}`) のまま残し、見た目だけを値に替える。編集中も編集していないときも
 * 同じエディタ・同じ装飾で描くので、見え方は変わらない (打ち終えた瞬間に値になる)。
 * 差し込みは 1 文字ずつではなく 1 つの塊として扱う: カーソルは中に入らず、Backspace / Delete は
 * 塊ごと消す。
 *
 * 並びは「値 (差し込みの前、`side: 1`)・隠した文字・幅の無い目印 (後ろ、`side: -1`)」。
 * ProseMirror は境目のカーソルを直前の要素の後ろに描くので、差し込みの前のカーソルは前の文字の
 * 後ろ (段落の先頭なら値の前)、後ろのカーソルは目印の後ろに出る — 隠した文字の隣にカーソルを
 * 置くと見えなくなり、そこで打った文字は差し込みの反対側に入ってしまう。
 * 隠した文字はブラウザのカーソル移動では越えられないので、差し込みをまたぐ ←/→ はここで動かす。
 */
export interface RunningFieldOptions {
  getValues: () => RunningRegionFieldValues | null;
}

interface RunningFieldRange {
  from: number;
  to: number;
  value: string;
}

export const runningFieldKey = new PluginKey<DecorationSet>("runningField");

export function collectRunningFieldRanges(
  doc: ProseMirrorNode,
  values: RunningRegionFieldValues,
): Array<RunningFieldRange & { marks: ProseMirrorNode["marks"] }> {
  const ranges: Array<RunningFieldRange & { marks: ProseMirrorNode["marks"] }> = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) {
      return true;
    }
    for (const match of findRunningRegionFields(node.text)) {
      ranges.push({
        from: pos + match.start,
        to: pos + match.end,
        value: resolveRunningRegionField(match.field, values),
        marks: node.marks,
      });
    }
    return false;
  });
  return ranges;
}

export function createRunningFieldDecorations(
  doc: ProseMirrorNode,
  values: RunningRegionFieldValues | null,
): DecorationSet {
  if (!values) {
    return DecorationSet.empty;
  }
  const decorations: Decoration[] = [];
  for (const range of collectRunningFieldRanges(doc, values)) {
    decorations.push(Decoration.widget(range.from, () => createFieldValue(range.value), {
      side: 1,
      marks: range.marks,
      // 太字などの書式を変えたら描き直す (key が同じだと ProseMirror は前の要素を使い回す)。
      key: `running-field-${range.value}-${range.marks.map((mark) => `${mark.type.name}:${JSON.stringify(mark.attrs)}`).join("|")}`,
    }));
    decorations.push(Decoration.inline(range.from, range.to, { class: "running-field-source" }));
    decorations.push(Decoration.widget(range.to, createCaretAnchor, {
      side: -1,
      key: "running-field-anchor",
    }));
  }
  return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

function createFieldValue(value: string): HTMLElement {
  const element = document.createElement("span");
  element.className = "running-field-value";
  element.contentEditable = "false";
  element.textContent = value;
  return element;
}

function createCaretAnchor(): HTMLElement {
  const element = document.createElement("span");
  element.className = "running-field-caret-anchor";
  element.contentEditable = "false";
  return element;
}

function fieldRangesOf(state: EditorState, values: RunningRegionFieldValues | null): RunningFieldRange[] {
  return values ? collectRunningFieldRanges(state.doc, values) : [];
}

/** カーソルが差し込みの中に入ったら、動いてきた向きの外側へ出す。 */
function snapSelectionOutOfFields(
  transactions: readonly Transaction[],
  oldState: EditorState,
  newState: EditorState,
  values: RunningRegionFieldValues | null,
): Transaction | null {
  const { selection } = newState;
  if (!selection.empty || !transactions.some((transaction) => transaction.selectionSet || transaction.docChanged)) {
    return null;
  }
  const head = selection.head;
  const inside = fieldRangesOf(newState, values).find((range) => head > range.from && head < range.to);
  if (!inside) {
    return null;
  }
  const movingLeft = head < oldState.selection.head;
  const target = movingLeft ? inside.from : inside.to;
  return newState.tr.setSelection(TextSelection.create(newState.doc, target)).setMeta("addToHistory", false);
}

/** 差し込みをまたぐ ←/→ (Shift で選択を伸ばす)。またがない移動はブラウザに任せる。 */
function moveAcrossField(
  view: EditorView,
  direction: "left" | "right",
  extend: boolean,
  values: RunningRegionFieldValues | null,
): boolean {
  const { state } = view;
  const { selection } = state;
  if (!extend && !selection.empty) {
    return false;
  }
  const head = selection.head;
  const range = fieldRangesOf(state, values).find((candidate) => (
    direction === "left" ? candidate.to === head : candidate.from === head
  ));
  if (!range) {
    return false;
  }
  const target = direction === "left" ? range.from : range.to;
  const next = extend
    ? TextSelection.create(state.doc, selection.anchor, target)
    : TextSelection.create(state.doc, target);
  view.dispatch(state.tr.setSelection(next).scrollIntoView());
  return true;
}

function deleteWholeField(view: EditorView, key: "Backspace" | "Delete", values: RunningRegionFieldValues | null): boolean {
  const { state } = view;
  const { selection } = state;
  if (!selection.empty) {
    return false;
  }
  const head = selection.head;
  const range = fieldRangesOf(state, values).find((candidate) => (
    key === "Backspace" ? candidate.to === head : candidate.from === head
  ));
  if (!range) {
    return false;
  }
  view.dispatch(state.tr.delete(range.from, range.to).scrollIntoView());
  return true;
}

export const RunningFieldExtension = Extension.create<RunningFieldOptions>({
  name: "runningField",

  addOptions() {
    return {
      getValues: () => null,
    };
  },

  addProseMirrorPlugins() {
    const getValues = () => this.options.getValues();
    return [new Plugin<DecorationSet>({
      key: runningFieldKey,
      state: {
        init: (_config, state) => createRunningFieldDecorations(state.doc, getValues()),
        apply: (transaction, previous) => (
          transaction.docChanged || transaction.getMeta(runningFieldKey) !== undefined
            ? createRunningFieldDecorations(transaction.doc, getValues())
            : previous
        ),
      },
      appendTransaction: (transactions, oldState, newState) => snapSelectionOutOfFields(
        transactions,
        oldState,
        newState,
        getValues(),
      ),
      props: {
        decorations: (state) => runningFieldKey.getState(state) ?? DecorationSet.empty,
        handleKeyDown: (view, event) => {
          if (event.altKey || event.metaKey || event.ctrlKey || event.isComposing) {
            return false;
          }
          if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
            return moveAcrossField(view, event.key === "ArrowLeft" ? "left" : "right", event.shiftKey, getValues());
          }
          if (event.key !== "Backspace" && event.key !== "Delete") {
            return false;
          }
          return deleteWholeField(view, event.key, getValues());
        },
      },
    })];
  },
});
