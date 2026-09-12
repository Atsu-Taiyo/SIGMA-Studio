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
  doc.forEach((node, offset) => {
    const blockId = typeof node.attrs?.sigmaDocId === "string" ? node.attrs.sigmaDocId : "";
    if (!blockId || !followers.has(blockId)) {
      return;
    }
    decorations.push(
      Decoration.node(offset, offset + node.nodeSize, {
        class: BLOCK_SPACE_AFTER_FOLLOWER_CLASS,
      }),
    );
  });

  return decorations.length ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}
