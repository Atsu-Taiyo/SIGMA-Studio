import type { TextFlowBoundaryDeleteResult } from "@/features/text-editing";

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
