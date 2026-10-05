import { Selection, TextSelection, type EditorState } from "@tiptap/pm/state";

/**
 * 畳んだ最上位ブロック (`TextFlowChangeDecorationState.collapsedIds`: 描かれていないブロック) の中にある
 * 選択を、見えるブロックへ移した選択。畳んだブロックに残った選択は見えず、打鍵は編集ガードに断られる
 * だけになる。直前の見えるブロックの末尾へ、無ければ直後の見えるブロックの先頭へ置く。
 *
 * 動かすのは、ノード選択でない選択の両端が同じ畳んだブロックの内側にあるときだけ。ノード選択 (画像・
 * 別行数式)・全選択・畳んだブロックをまたぐ範囲 (その削除はガードが断る)・畳んだブロックの手前で終わる
 * 範囲は動かさない。動かさないとき・移す先が無いときは null (選択はそのまま)。
 */
export function selectionOutsideCollapsedBlocks(
  state: EditorState,
  collapsedIds: readonly string[] | undefined,
): Selection | null {
  const { doc, selection } = state;
  if (!collapsedIds?.length || !(selection instanceof TextSelection)) {
    return null;
  }
  const collapsed = new Set(collapsedIds);
  const isCollapsed = (index: number) => {
    const id: unknown = doc.maybeChild(index)?.attrs.sigmaDocId;
    return typeof id === "string" && collapsed.has(id);
  };
  const { $from, $to } = selection;
  // 両端が最上位ブロックの内側 (深さ 1 以上) で、同じブロックにあること。境目の位置 (深さ 0) は
  // index(0) が次のブロックを指すだけで、そのブロックの中ではない。
  if ($from.depth < 1 || $to.depth < 1 || $from.index(0) !== $to.index(0)) {
    return null;
  }
  const foldedIndex = $from.index(0);
  if (!isCollapsed(foldedIndex)) {
    return null;
  }

  const offsets: number[] = [];
  doc.forEach((_node, offset) => {
    offsets.push(offset);
  });
  const landsOutside = (candidate: Selection | null) => (
    candidate && !isCollapsed(doc.resolve(candidate.from).index(0)) ? candidate : null
  );
  for (let index = foldedIndex - 1; index >= 0; index -= 1) {
    if (!isCollapsed(index)) {
      const end = offsets[index] + doc.child(index).nodeSize - 1;
      const candidate = landsOutside(Selection.findFrom(doc.resolve(end), -1, true));
      if (candidate) {
        return candidate;
      }
    }
  }
  for (let index = foldedIndex + 1; index < doc.childCount; index += 1) {
    if (!isCollapsed(index)) {
      const candidate = landsOutside(Selection.findFrom(doc.resolve(offsets[index] + 1), 1, true));
      if (candidate) {
        return candidate;
      }
    }
  }
  return null;
}
