import { getCaretSurfaces } from "../text-flow/caret-router";
import { resolveTextSelectionBlockId } from "../text-flow/text-selection-block";

/**
 * 選択中のブロック (`blockId`) の中に、文字のカーソルを置いただけか。
 *
 * `selectedId` は「どのブロックに今いるか」を表すので、カーソルを置いただけでもその段落の id が入る。
 * 画像・表・グラフを丸ごと選んだとき (ノードの選択) や、つまみで選んだブロックと見分けるため、
 * 編集面の ProseMirror の選択そのものを読む: 範囲もノードも持たない (`empty`) 選択が、`selectedId` と
 * 同じ規則 (`TextFlowEditor` の `getSelectedTextBlockId`) で解いて同じブロックにあるときだけ true。
 *
 * フォーカスがある面があれば、その面だけで決める (選択を持ったままの他の面は見ない)。フォーカスが
 * リボンの入力欄や AI の入力欄へ移っても、カーソルを置いた事実は変わらないので、移った途端に
 * チップが浮かぶことはない。
 */
export function isCaretOnlyInBlock(canvas: HTMLElement | null, blockId: string | null): boolean {
  if (!canvas || !blockId) {
    return false;
  }
  const surfaces = getCaretSurfaces().filter(({ editor }) => canvas.contains(editor.view.dom));
  const focused = surfaces.find(({ editor }) => editor.view.hasFocus());
  return (focused ? [focused] : surfaces).some(({ editor }) => {
    const { doc, selection } = editor.state;
    return selection.empty && resolveTextSelectionBlockId(doc, selection.from) === blockId;
  });
}
