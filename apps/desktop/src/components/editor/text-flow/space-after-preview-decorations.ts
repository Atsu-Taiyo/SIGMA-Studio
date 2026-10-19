import type { Node as ProseMirrorModelNode } from "@tiptap/pm/model";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { BLOCK_SPACE_AFTER_FOLLOWER_CLASS } from "@/features/document";

import type { BlockSpaceAfterPreview } from "./block-space-after-preview";

/**
 * ドラッグ中のブロック下余白プレビュー。
 *
 * 付けるのは **印 (class) だけ** で、px は載せない。移動量は紙面の親に書かれた custom
 * property 1 本から読むので、pointermove のたびに transaction を打つ必要が無い
 * (打つのは掴んだ瞬間と離した瞬間の 2 回きり)。
 *
 * 文書には触らない (`pageDocument` に混ぜると同期キーが変わって `setContent` が走り、
 * キャレットと選択が飛ぶ)。DOM を直接触るのも不可 (ProseMirror のノード再描画で消える)。
 * decoration なら doc を変えずに DOM だけ変わる。
 */
export function createSpaceAfterPreviewDecorations(
  doc: ProseMirrorModelNode,
  preview: BlockSpaceAfterPreview | null,
): DecorationSet {
  // 掴んでいない間はここが毎 transaction の全コスト。doc を走査しない。
  if (!preview || preview.followerBlockIds.length === 0) {
    return DecorationSet.empty;
  }

  const followers = new Set(preview.followerBlockIds);
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    const blockId = previewBlockIdOf(node);
    if (blockId && followers.has(blockId)) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, {
          class: BLOCK_SPACE_AFTER_FOLLOWER_CLASS,
        }),
      );
      // 中身は一緒に動く。中にも印を付けると平行移動が二重になる。
      return false;
    }
    // 入れ子のブロック (リストの項目・箱の中の段落) も追従するので降りる。行内までは降りない。
    return !node.isTextblock && !node.isLeaf;
  });

  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/**
 * 印を付ける単位の id。リスト項目の id は 1 行目の段落が持つが、番号 (`::marker`)・続きの段落・
 * 入れ子を描くのは li なので、印は listItem ノードに付ける (段落に付けると番号だけ置いていかれる)。
 */
function previewBlockIdOf(node: ProseMirrorModelNode): string {
  const holder = node.type.name === "listItem" ? node.firstChild : node;
  const id = holder?.attrs?.sigmaDocId;
  return typeof id === "string" ? id : "";
}
