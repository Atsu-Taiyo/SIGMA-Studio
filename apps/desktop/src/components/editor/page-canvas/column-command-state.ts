// リボンと右クリックメニューで共有する段組の実行可否。
// document-tree の段組セクション化が実際に届く位置だけを対象にする。

import { getLayoutSectionColumnCount } from "@/components/editor/page-canvas/render-units";
import { isColumnWrapTargetBlock } from "@/features/text-editing/model";
import type {
  BoxBlockChildBlock,
  LayoutSectionNode,
  ProblemAreaBlock,
  SigmaBlock,
  SigmaDocument,
} from "@/features/document";

export interface ColumnCommandState {
  /** 段組みボタンを押せるか。 */
  enabled: boolean;
  /** いま何段か。段組セクションの外なら 1。 */
  currentColumnCount: number;
  /** すでに段組セクションの中なら、段数を変える/解除する対象のセクションID。外なら null (新規作成)。 */
  sectionId: string | null;
}

/**
 * 段組みコマンドが無効な状態。docs レイアウトではボタン自体が無いので、
 * 毎レンダーで文書を走査しないよう呼び出し側がこれで差し替える。
 */
export const NO_COLUMN_COMMAND: ColumnCommandState = {
  enabled: false,
  currentColumnCount: 1,
  sectionId: null,
};

type ColumnScanBlock = SigmaBlock | ProblemAreaBlock | BoxBlockChildBlock;

type ColumnTarget =
  /** すでに段組セクションの中。段数変更 / 解除の対象。 */
  | { kind: "change"; section: LayoutSectionNode }
  /** 段組セクションを新設できる位置。 */
  | { kind: "wrap" };

/**
 * 選択ブロックを、段組みを適用できる文脈の中から探す。**1回の走査**で
 * 「新設できる位置か」と「すでにどのセクションの中か」を同時に決める。
 *
 * 降りる経路は `document-tree` の `wrapBlocksInLayoutSection*` と同じ:
 * 本文トップレベル / 問題の**解答**エリア / 枠(boxBlock)の中 / 段組セクションの子。
 * 問題文・導入文・コメントには降りない (そこは段組セクションを作れないので、
 * 押しても何も起きないボタンになる)。
 *
 * `section` 文脈は **boxBlock に入るところでリセットする**。枠の外側にある段組
 * セクションは枠の中のブロックにとっての「自分の段組」ではなく、そこで段数を
 * 変えるとユーザーが選んでいないブロックまで作り変えてしまうため
 * (右クリックメニューの `effectiveContextMenuLayoutSection` と同じ規約)。
 */
function findColumnTarget(
  blocks: readonly ColumnScanBlock[],
  blockId: string,
  section: LayoutSectionNode | null,
): ColumnTarget | null {
  for (const block of blocks) {
    if (block.id === blockId) {
      if (section) {
        return { kind: "change", section };
      }
      return isColumnWrapTargetBlock(block) ? { kind: "wrap" } : null;
    }
    if (block.type === "problem") {
      // 問題は段組セクションの子になれないので、外側のセクション文脈は持ち込まない。
      const found = findColumnTarget(block.solution, blockId, null);
      if (found) {
        return found;
      }
    }
    if (block.type === "boxBlock") {
      const found = findColumnTarget(block.blocks, blockId, null);
      if (found) {
        return found;
      }
    }
    if (block.type === "layoutSection") {
      const found = findColumnTarget(block.children, blockId, block);
      if (found) {
        return found;
      }
    }
  }
  return null;
}

export function resolveColumnCommandState(
  document: SigmaDocument,
  selectedId: string | null,
): ColumnCommandState {
  if (!selectedId) {
    return NO_COLUMN_COMMAND;
  }

  const target = findColumnTarget(document.content, selectedId, null);
  if (!target) {
    return NO_COLUMN_COMMAND;
  }
  if (target.kind === "change") {
    return {
      enabled: true,
      currentColumnCount: getLayoutSectionColumnCount(target.section),
      sectionId: target.section.id,
    };
  }
  return { enabled: true, currentColumnCount: 1, sectionId: null };
}
