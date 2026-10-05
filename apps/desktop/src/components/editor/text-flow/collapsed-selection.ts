import { Selection, type EditorState } from "@tiptap/pm/state";

/**
 * 畳んだ最上位ブロック (`TextFlowChangeDecorationState.collapsedIds`: 描かれていないブロック) の中にある
 * 選択を、見えるブロックへ移した選択。畳んだブロックに残った選択は見えず、打鍵は編集ガードに断られる
 * だけになる。直前の見えるブロックの末尾へ、無ければ直後の見えるブロックの先頭へ置く。
 *
 * 選択が畳んだブロックに無いとき・移す先が無いときは null (選択はそのまま)。
 */
export function selectionOutsideCollapsedBlocks(
  state: EditorState,
  collapsedIds: readonly string[] | undefined,
): Selection | null {
  if (!collapsedIds?.length) {
    return null;
  }
  const collapsed = new Set(collapsedIds);
  const { doc, selection } = state;
  const offsets: number[] = [];
  doc.forEach((_node, offset) => {
    offsets.push(offset);
  });
  const isCollapsed = (index: number) => {
    const id: unknown = doc.maybeChild(index)?.attrs.sigmaDocId;
    return typeof id === "string" && collapsed.has(id);
  };
  const fromIndex = doc.resolve(selection.from).index(0);
  const toIndex = doc.resolve(selection.to).index(0);
  const foldedIndex = isCollapsed(fromIndex) ? fromIndex : isCollapsed(toIndex) ? toIndex : -1;
  if (foldedIndex < 0) {
    return null;
  }

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
