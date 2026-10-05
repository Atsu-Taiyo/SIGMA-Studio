import type { TextFlowBoundaryDeleteInput, TextFlowBoundaryDeleteResult } from "@/features/text-editing";

/**
 * 編集面をまたぐ境界の削除・結合 (`resolveTextFlowBoundaryDelete`) が、紙面に描かれていないブロック
 * (機能が畳んだもの。`TextFlowChangeDecorationState.collapsedIds`) に触れるなら、そのブロックの id。
 * 結合の相手・消えるブロック・キャレットの行き先のどれかが畳んだブロックなら、見えないブロックを
 * 書き換える・見えない所へキャレットを置くことになるので断る (面の中の編集はガードが断る)。
 */
export function findHiddenBoundaryDeleteBlockId(
  deletion: Pick<TextFlowBoundaryDeleteResult, "previousIds" | "focusBlockId">,
  hiddenBlockIds: ReadonlySet<string> | readonly string[] | undefined,
): string | null {
  const hidden = hiddenBlockIds instanceof Set ? hiddenBlockIds : new Set(hiddenBlockIds ?? []);
  if (hidden.size === 0) {
    return null;
  }
  return [...deletion.previousIds, deletion.focusBlockId].find((id) => hidden.has(id)) ?? null;
}

/**
 * 境界の削除を、描かれていないブロックに触れないように決める。空行を消してキャレットを隣へ送るだけの
 * 削除で、行き先が畳んだブロックなら、反対側の見えるブロックへ送る (見えるブロックのうち近い方)。結合の
 * 相手・消えるブロックが畳んだブロックなら断る (`blockedBlockId`)。削除が無ければ null。
 */
export function resolveVisibleBoundaryDelete(
  request: TextFlowBoundaryDeleteInput,
  resolve: (request: TextFlowBoundaryDeleteInput) => TextFlowBoundaryDeleteResult | null,
  hiddenBlockIds: ReadonlySet<string> | readonly string[] | undefined,
): { deletion: TextFlowBoundaryDeleteResult } | { blockedBlockId: string } | null {
  const deletion = resolve(request);
  if (!deletion) {
    return null;
  }
  const blockedBlockId = findHiddenBoundaryDeleteBlockId(deletion, hiddenBlockIds);
  if (!blockedBlockId) {
    return { deletion };
  }
  const removesOnlyTheLine = deletion.nextBlocks.length === 0
    && deletion.previousIds.length === 1
    && deletion.previousIds[0] === request.blockId
    && deletion.focusBlockId === blockedBlockId;
  if (removesOnlyTheLine) {
    const otherSide = resolve({ ...request, direction: request.direction === "backward" ? "forward" : "backward" });
    if (
      otherSide
      && otherSide.nextBlocks.length === 0
      && otherSide.previousIds.length === 1
      && otherSide.previousIds[0] === request.blockId
      && !findHiddenBoundaryDeleteBlockId(otherSide, hiddenBlockIds)
    ) {
      return { deletion: otherSide };
    }
  }
  return { blockedBlockId };
}
