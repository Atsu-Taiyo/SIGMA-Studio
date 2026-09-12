import type { InlineNode } from "@/features/document";

import { getInlineEditorLength, getTextFlowBlockEditorLength } from "./block-model";
import type { CaretAddress, CaretAffinity, TextFlowSelectionBookmark } from "./caret-bookmark";
import type { TextFlowBlock } from "./text-flow-types";

/**
 * ProseMirror は position に affinity を持たないので、既定は `"after"` (PM の `assoc = 1` と
 * 同じ「後ろ側に属する」向き)。transaction 前の写像だけは bias を持つので、そちらを引き継ぐ。
 */
export const DEFAULT_CARET_AFFINITY: CaretAffinity = "after";

/**
 * 位置を解決するときに辿ったブロックの並び (**外側から内側の順**)。ProseMirror の
 * `ResolvedPos` をそのまま渡さないのは、この層が編集エンジンに依存しないため。
 */
export interface CaretBlockPathEntry {
  /** SigmaDoc のブロック id。持たない構造ノード (doc / 箱の本体など) は null。 */
  blockId: string | null;
  /** このノードの内容の開始位置 (絶対)。 */
  contentStart: number;
  /** このノードの内容の長さ。 */
  contentSize: number;
  /** 中へキャレットが入れないノードか (区切り線など)。 */
  isAtom: boolean;
}

export function clampCaretOffset(offset: number, length: number): number {
  if (!Number.isFinite(offset)) {
    return 0;
  }
  return Math.min(Math.max(offset, 0), Math.max(0, length));
}

/**
 * ブロック末尾のキャレット位置。復元側は offset を PM の content offset として解釈するため、
 * 入れ子ブロック (箱 / 引用 / 段組み / リスト) はコンテナの平坦化文字数ではなく、**最後の
 * テキスト葉ブロックの id + その文字数**で表す。中身が空のコンテナは降りる先が無いので
 * コンテナ自身を返す (例外は投げない)。
 */
export function caretAddressAtBlockEnd(block: TextFlowBlock): CaretAddress {
  if (block.type === "divider") {
    return nodeCaretAddress(block.id);
  }
  if (block.type === "boxBlock" && block.blocks.length > 0) {
    return caretAddressAtBlockEnd(block.blocks[block.blocks.length - 1]);
  }
  if (block.type === "quote" && block.blocks.length > 0) {
    return caretAddressAtBlockEnd(block.blocks[block.blocks.length - 1]);
  }
  if (block.type === "layoutSection" && block.children.length > 0) {
    return caretAddressAtBlockEnd(block.children[block.children.length - 1]);
  }
  if (block.type === "list") {
    const item = block.items.at(-1);
    if (item) {
      const nested = item.nested?.at(-1);
      if (nested) {
        return caretAddressAtBlockEnd(nested);
      }
      const continuation = item.continuations?.at(-1);
      if (continuation) {
        return caretAddressAtBlockEnd(continuation);
      }
      return textCaretAddress(item.id, inlineEditorLength(item.children));
    }
  }
  return textCaretAddress(block.id, getTextFlowBlockEditorLength(block));
}

/** ブロック先頭のキャレット位置。入れ子ブロックは最初のテキスト葉へ降りる。 */
export function caretAddressAtBlockStart(block: TextFlowBlock): CaretAddress {
  if (block.type === "divider") {
    return nodeCaretAddress(block.id);
  }
  if (block.type === "boxBlock" && block.blocks.length > 0) {
    return caretAddressAtBlockStart(block.blocks[0]);
  }
  if (block.type === "quote" && block.blocks.length > 0) {
    return caretAddressAtBlockStart(block.blocks[0]);
  }
  if (block.type === "layoutSection" && block.children.length > 0) {
    return caretAddressAtBlockStart(block.children[0]);
  }
  if (block.type === "list" && block.items.length > 0) {
    return textCaretAddress(block.items[0].id, 0);
  }
  return textCaretAddress(block.id, 0);
}

export function caretAddressAtBlockEdge(
  block: TextFlowBlock,
  edge: "start" | "end",
): CaretAddress {
  return edge === "start" ? caretAddressAtBlockStart(block) : caretAddressAtBlockEnd(block);
}

/**
 * 解決済みの位置を `CaretAddress` へ正規化する。
 *
 * **最も内側の、id を持つブロック**を選ぶ。`offset` はそのブロックの内容の先頭からの距離で、
 * 入れ子の途中 (段落と段落の隙間など) ではコンテナの中での位置になる — 復元側も同じ規約で
 * 位置へ戻すので、往復すれば元の場所に着く。id を持つ祖先がまったく無ければ null。
 *
 * **SigmaDoc から組み立てる位置** (`caretAddressAtBlockStart` / `caretAddressAtBlockEnd`) は
 * 事情が違い、必ず葉ブロックまで降りる: あちらの offset は平坦化した文字数なので、コンテナの
 * id に載せると復元側が別の場所を指す。
 */
export function normalizeCaretAddressPath(
  path: readonly CaretBlockPathEntry[],
  position: number,
  affinity: CaretAffinity,
): CaretAddress | null {
  for (let index = path.length - 1; index >= 0; index -= 1) {
    const entry = path[index];
    if (!entry.blockId) {
      continue;
    }
    if (entry.isAtom) {
      return { affinity, blockId: entry.blockId, kind: "node", offset: 0 };
    }
    return {
      affinity,
      blockId: entry.blockId,
      kind: "text",
      offset: clampCaretOffset(position - entry.contentStart, entry.contentSize),
    };
  }
  return null;
}

/**
 * 中へキャレットが入れないブロック (区切り線) は、文字位置ではなくノードそのものを指す。
 * `kind:"text"` で表すと、復元側が「ノードの内容の中」を指してしまい行き過ぎる。
 */
export function nodeCaretAddress(blockId: string): CaretAddress {
  return { affinity: DEFAULT_CARET_AFFINITY, blockId, kind: "node", offset: 0 };
}

/** 葉ブロックの中の文字位置。affinity を書き忘れて既定からずれるのを防ぐ。 */
export function textCaretAddress(blockId: string, offset: number): CaretAddress {
  return { affinity: DEFAULT_CARET_AFFINITY, blockId, kind: "text", offset };
}

/** 1 点だけを指す (畳まれた) 選択。 */
export function collapsedCaretBookmark(address: CaretAddress): TextFlowSelectionBookmark {
  return { anchor: address, head: address, preferredX: null };
}

function inlineEditorLength(children: readonly InlineNode[]): number {
  return children.reduce((length, child) => length + getInlineEditorLength(child), 0);
}
