import { normalizeBlockSpaceAfterPx } from "@/features/document";
import type {
  BoxBlockChildBlock,
  BoxFrameSpec,
  InlineNode,
  LayoutSectionChildBlock,
  ListItemNode,
  RichBlock,
  SigmaCommentAnchor,
  SigmaCommentThread,
} from "@/features/document";

import type { TextFlowBlock } from "./text-flow-types";

const textFlowBlockSyncKeyCache = new WeakMap<TextFlowBlock, string>();

export interface TextFlowColumnLayoutSyncValue {
  x: number;
  y: number;
  width: number;
}

export interface TextFlowFragmentLayoutSyncValue {
  visibleHeight: number;
  totalHeight: number;
}

export function areTextFlowBlockIdSequencesEqual(
  a: readonly string[],
  b: readonly string[],
): boolean {
  return a.length === b.length
    && a.every((value, index) => value === b[index]);
}

export function getTextFlowBreakGapSyncKey(
  gaps: Readonly<Record<string, number>> | undefined,
): string {
  if (!gaps) {
    return "";
  }
  return Object.keys(gaps)
    .sort()
    .map((key) => `${key}:${gaps[key]}`)
    .join("\u0000");
}

export function getTextFlowColumnLayoutsSyncKey(
  layouts: Readonly<Record<string, TextFlowColumnLayoutSyncValue>> | undefined,
): string {
  if (!layouts) {
    return "";
  }
  return Object.keys(layouts)
    .sort()
    .map((key) => {
      const layout = layouts[key];
      return `${key}:${layout.x}:${layout.y}:${layout.width}`;
    })
    .join("\u0000");
}

export function getTextFlowFragmentLayoutsSyncKey(
  layouts: Readonly<Record<string, TextFlowFragmentLayoutSyncValue>> | undefined,
): string {
  if (!layouts) {
    return "";
  }
  return Object.keys(layouts)
    .sort()
    .map((key) => {
      const layout = layouts[key];
      return `${key}:${layout.visibleHeight}:${layout.totalHeight}`;
    })
    .join("\u0000");
}

export function getTextFlowBlocksSyncKey(blocks: TextFlowBlock[]): string {
  return blocks.map(getTextFlowBlockSyncKey).join("\u0000");
}

function getTextFlowBlockSyncKey(block: TextFlowBlock): string {
  const cached = textFlowBlockSyncKeyCache.get(block);
  if (cached) {
    return cached;
  }

  if (block.type === "problem") {
    const key = JSON.stringify(block);
    textFlowBlockSyncKeyCache.set(block, key);
    return key;
  }
  const key = block.type === "list"
    ? [
        "list",
        block.id,
        block.listType,
        block.start ?? "",
        block.markerStyle ?? "",
        paginationSyncKey(block.pagination),
        block.spaceAfterPx ?? "",
        block.items.map(getListItemSyncKey).join("\u0001"),
      ].join(":")
    : block.type === "boxBlock"
      ? [
          "boxBlock",
          block.id,
          block.styleId,
          inlineNodesSyncKey(block.title ?? []),
          boxFrameSyncKey(block.frame),
          paginationSyncKey(block.pagination),
          block.spaceAfterPx ?? "",
          block.blocks.map(getBoxBlockChildSyncKey).join("\u0001"),
        ].join(":")
      : block.type === "layoutSection"
        ? [
            "layoutSection",
            block.id,
            block.layout.columnCount,
            block.layout.columnGapMm ?? "",
            JSON.stringify(block.layout.columnRule ?? null),
            paginationSyncKey(block.pagination),
            block.spaceAfterPx ?? "",
            block.children.map(getLayoutSectionChildSyncKey).join("\u0001"),
          ].join(":")
        : block.type === "quote"
        ? [
            "quote",
            block.id,
            paginationSyncKey(block.pagination),
            block.spaceAfterPx ?? "",
            block.blocks.map(getTextFlowBlockSyncKey).join("\u0001"),
          ].join(":")
      : block.type === "divider"
          // 区切り線が持つ状態は id と改ページ指定と下余白だけ。
          ? ["divider", block.id, paginationSyncKey(block.pagination), block.spaceAfterPx ?? ""].join(":")
          : [
              block.type,
              block.id,
              block.type === "heading" ? block.level : "",
              ...(block.type === "codeBlock" ? [block.language ?? "", block.theme ?? "light"] : []),
              block.type === "section"
                ? block.title
                : inlineNodesSyncKey(block.children),
              "align" in block ? block.align ?? "" : "",
              "lineHeight" in block ? block.lineHeight ?? "" : "",
              paginationSyncKey(block.pagination),
              block.spaceAfterPx ?? "",
            ].join(":");
  textFlowBlockSyncKeyCache.set(block, key);
  return key;
}

function getListItemSyncKey(item: ListItemNode): string {
  return [
    item.id,
    inlineNodesSyncKey(item.children),
    item.align ?? "",
    item.spaceAfterPx ?? "",
    (item.continuations ?? []).map(getTextFlowBlockSyncKey).join("\u0002"),
    (item.nested ?? []).map(getTextFlowBlockSyncKey).join("\u0002"),
  ].join(":");
}

function getRichBlockSyncKey(block: RichBlock): string {
  if (block.type === "list") {
    return getTextFlowBlockSyncKey(block);
  }
  return [
    block.type,
    block.id,
    block.type === "heading" ? block.level : "",
    inlineNodesSyncKey(block.children),
    block.align ?? "",
    block.lineHeight ?? "",
    paginationSyncKey(block.pagination),
    block.spaceAfterPx ?? "",
  ].join(":");
}

function getBoxBlockChildSyncKey(block: BoxBlockChildBlock): string {
  if (block.type === "layoutSection") {
    return getTextFlowBlockSyncKey(block);
  }
  return getTextFlowBlockSyncKey(block);
}

function getLayoutSectionChildSyncKey(
  block: LayoutSectionChildBlock,
): string {
  return block.type === "section"
    || block.type === "boxBlock"
    || block.type === "quote"
    || block.type === "codeBlock"
    || block.type === "divider"
    ? getTextFlowBlockSyncKey(block)
    : getRichBlockSyncKey(block);
}

function inlineNodesSyncKey(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    const marks = node.marks?.join(",") ?? "";
    if (node.type === "mathInline") {
      return [
        "m",
        node.id,
        node.tex,
        marks,
        node.boxedPaddingY ?? "",
        node.boxedVariant ?? "",
        node.boxedTone ?? "",
        node.semanticRole ?? "",
        node.altText ?? "",
      ].join("|");
    }
    return [
      "t",
      node.text,
      marks,
      node.color ?? "",
      node.backgroundColor ?? "",
      node.fontFamily ?? "",
      node.fontSize ?? "",
      node.boxedPaddingY ?? "",
      node.boxedVariant ?? "",
      node.boxedTone ?? "",
    ].join("|");
  }).join("\u0003");
}

function paginationSyncKey(pagination: TextFlowBlock["pagination"]): string {
  if (!pagination) {
    return "";
  }
  return `${pagination.break ?? ""}`;
}

function boxFrameSyncKey(frame: BoxFrameSpec | undefined): string {
  return frame ? JSON.stringify(frame) : "";
}

export function getTextFlowBlockIds(blocks: TextFlowBlock[]): string[] {
  return blocks.flatMap(getTextFlowBlockIdsForBlock);
}

export function textFlowBlocksContainId(
  blocks: TextFlowBlock[],
  id: string,
): boolean {
  return getTextFlowBlockIds(blocks).includes(id);
}

function getTextFlowBlockIdsForBlock(block: TextFlowBlock): string[] {
  if (block.type === "boxBlock") {
    return [block.id, ...block.blocks.flatMap(getTextFlowBlockIdsForBoxBlockChild)];
  }
  if (block.type === "layoutSection") {
    return [
      block.id,
      ...block.children.flatMap(getTextFlowBlockIdsForLayoutSectionChild),
    ];
  }
  if (block.type !== "list") {
    return [block.id];
  }
  return [
    block.id,
    ...block.items.flatMap((item) => [
      item.id,
      ...(item.continuations ?? []).map((paragraph) => paragraph.id),
      ...(item.nested ?? []).flatMap(getTextFlowBlockIdsForBlock),
    ]),
  ];
}

function getTextFlowBlockIdsForBoxBlockChild(
  block: BoxBlockChildBlock,
): string[] {
  return getTextFlowBlockIdsForBlock(block);
}

function getTextFlowBlockIdsForLayoutSectionChild(
  block: LayoutSectionChildBlock,
): string[] {
  return getTextFlowBlockIdsForBlock(block);
}

export function getLastTextFlowBlockId(
  blocks: TextFlowBlock[],
): string | null {
  const ids = getTextFlowBlockIds(blocks);
  return ids.at(-1) ?? null;
}

export function shouldSyncFocusedTextFlowContent(
  editorBlockIds: string[],
  blocks: TextFlowBlock[],
): boolean {
  const blockIds = getTextFlowBlockIds(blocks);
  return !areTextFlowBlockIdSequencesEqual(editorBlockIds, blockIds);
}

/**
 * ブロック種別 (段落 / コード / 見出し1・2・3) の写像。
 *
 * フォーカス中のエディタの受動同期は「ブロック id 列が同じなら何もしない」。段落スタイルを
 * 変えても id は変わらないので、それだけだと SigmaDoc は見出しになったのに DOM は `<p>` の
 * まま — 見出し1/2/3 を選び分けても紙面が変わらない、という形で出る。
 *
 * コードブロックは段落と id を共有したまま種別だけが変わる (段落 ⇄ コードは `setNode`) ので、
 * ここに載せないと同じ形で抜ける。引用は入れ物なので id 列そのものが変わり、この写像に
 * 頼らずに検出できる。
 *
 * 対象は「SigmaDoc の値がそのままタグを決めるブロック」だけに絞る。両側で同じ値を出せない
 * ものを入れると、毎回「変わった」と判定して同期が止まらなくなる。リスト項目のように片側に
 * しか現れない id は、双方に載っている id だけを突き合わせることで自然に外れる。
 */
export type TextFlowBlockKind =
  | "paragraph"
  | "codeBlock"
  | "heading1"
  | "heading2"
  | "heading3";

export function getTextFlowBlockKinds(blocks: TextFlowBlock[]): Map<string, TextFlowBlockKind> {
  const kinds = new Map<string, TextFlowBlockKind>();
  collectTextFlowBlockKinds(blocks, kinds);
  return kinds;
}

export function hasTextFlowBlockKindChange(
  editorKinds: ReadonlyMap<string, TextFlowBlockKind>,
  blocks: TextFlowBlock[],
): boolean {
  const kinds = getTextFlowBlockKinds(blocks);
  for (const [id, kind] of kinds) {
    const editorKind = editorKinds.get(id);
    if (editorKind && editorKind !== kind) {
      return true;
    }
  }
  return false;
}

/**
 * SigmaDoc だけが運ぶ **非構造の属性** の写像 (ブロック id → 署名)。
 *
 * {@link getTextFlowBlockKinds} と同じ穴をふさぐ 2 枚目。フォーカス中のエディタの受動同期は
 * 「ブロック id 列が同じなら何もしない」ので、id も種別も動かさない属性は、キャレットの居る面
 * にだけ永遠に届かない。下端つまみの `spaceAfterPx` がまさにそれで、確定値が紙面に出ないまま
 * 局所プレビューだけが外れる ＝ 離した瞬間に元の位置へ戻って見える、という形で出ていた。
 *
 * 載せてよいのは **PM のノード属性としてそのまま往復する値** だけ。往復で同じ値に戻らない
 * ものを載せると毎回「変わった」と判定され、焦点面への `setContent` が止まらなくなる。
 * リスト項目は PM 側の先頭段落が専用の非描画属性を運び、同じ id で突き合わせる。
 */
export function getTextFlowBlockAttributes(blocks: TextFlowBlock[]): Map<string, string> {
  const attributes = new Map<string, string>();
  collectTextFlowBlockAttributes(blocks, attributes);
  return attributes;
}

export function hasTextFlowBlockAttributeChange(
  editorAttributes: ReadonlyMap<string, string>,
  blocks: TextFlowBlock[],
): boolean {
  const attributes = getTextFlowBlockAttributes(blocks);
  for (const [id, signature] of attributes) {
    const editorSignature = editorAttributes.get(id);
    if (editorSignature !== undefined && editorSignature !== signature) {
      return true;
    }
  }
  return false;
}

/**
 * 突き合わせる値を 1 つの文字列に畳む。**SigmaDoc 側と PM 側の両方がこれを呼ぶ**ので、
 * 属性を増やすときはここへ 1 つ足すだけで両側が同時に増える (正規化も共通になる)。
 */
export function textFlowBlockAttributeSignature(
  values: { spaceAfterPx?: unknown },
): string {
  return [
    normalizeBlockSpaceAfterPx(values.spaceAfterPx) ?? "",
  ].join(" ");
}

function collectTextFlowBlockKinds(
  blocks: readonly TextFlowBlock[],
  kinds: Map<string, TextFlowBlockKind>,
): void {
  for (const block of blocks) {
    if (block.type === "section") {
      // section は level 1 の見出しとして描く。
      kinds.set(block.id, "heading1");
      continue;
    }
    if (block.type === "heading") {
      kinds.set(block.id, `heading${block.level}` as TextFlowBlockKind);
      continue;
    }
    if (block.type === "paragraph" || block.type === "codeBlock") {
      kinds.set(block.id, block.type === "codeBlock" ? "codeBlock" : "paragraph");
      continue;
    }
    if (block.type === "quote") {
      collectTextFlowBlockKinds(block.blocks, kinds);
      continue;
    }
    if (block.type === "boxBlock") {
      collectTextFlowBlockKinds(block.blocks, kinds);
      continue;
    }
    if (block.type === "layoutSection") {
      collectTextFlowBlockKinds(block.children, kinds);
      continue;
    }
    if (block.type === "list") {
      for (const item of block.items) {
        // 項目そのものは PM 側で段落として描かれるが SigmaDoc では listItem なので載せない。
        collectTextFlowBlockKinds(item.continuations ?? [], kinds);
        collectTextFlowBlockKinds(item.nested ?? [], kinds);
      }
    }
  }
}

function collectTextFlowBlockAttributes(
  blocks: readonly TextFlowBlock[],
  attributes: Map<string, string>,
): void {
  for (const block of blocks) {
    attributes.set(block.id, textFlowBlockAttributeSignature(block));
    if (block.type === "quote" || block.type === "boxBlock") {
      collectTextFlowBlockAttributes(block.blocks, attributes);
      continue;
    }
    if (block.type === "layoutSection") {
      collectTextFlowBlockAttributes(block.children, attributes);
      continue;
    }
    if (block.type === "list") {
      for (const item of block.items) {
        attributes.set(item.id, textFlowBlockAttributeSignature(item));
        collectTextFlowBlockAttributes(item.continuations ?? [], attributes);
        collectTextFlowBlockAttributes(item.nested ?? [], attributes);
      }
    }
  }
}

/**
 * コメント装飾の再 dispatch を値で判定するためのキー。
 *
 * スレッド配列は文書が作り直されるたびに新しい配列になるので、識別子で比べると打鍵ごとに
 * 全ユニットへ装飾更新の transaction が飛ぶ。装飾自体は `props.decorations` が最新の
 * スレッドを毎回読んで組み立てるので、ここでは「装飾の見た目を変えうる値」だけを拾えばよい。
 */
export function getCommentThreadsSyncKey(
  threads: readonly SigmaCommentThread[] | undefined,
): string {
  if (!threads || threads.length === 0) {
    return "";
  }
  // 区切り文字での連結ではなく JSON: id や引用に区切り文字が混じっても別のスレッド集合と
  // 同じキーにならない。並びは装飾が読む順そのもの。
  return JSON.stringify(threads.map(getCommentThreadSyncValue));
}

function getCommentThreadSyncValue(thread: SigmaCommentThread): unknown[] {
  return [
    thread.id,
    thread.resolved === true,
    thread.color ?? null,
    thread.updatedAt ?? thread.createdAt,
    getCommentAnchorSyncValue(thread.anchor),
  ];
}

function getCommentAnchorSyncValue(anchor: SigmaCommentAnchor): unknown[] {
  switch (anchor.type) {
    case "textRange":
      return [anchor.type, anchor.start.blockId, anchor.start.offset, anchor.end.blockId, anchor.end.offset];
    case "inlineMath":
      return [anchor.type, anchor.blockId, anchor.mathInlineId];
    case "block":
      return [anchor.type, anchor.blockId];
    case "canvasRegion":
      return [anchor.type, anchor.bounds.x, anchor.bounds.y, anchor.bounds.w, anchor.bounds.h];
    case "overlayShape":
      return [anchor.type, [...anchor.shapeIds]];
    case "overlayMath":
      return [anchor.type, anchor.shapeId ?? null, anchor.mathInlineId ?? null];
  }
}

/**
 * 外部更新 (AI 承認・MCP 書き込み・タブ間同期) をエディタへ流し込むべきか。
 *
 * 「もう入っていると分かっている内容」は 2 つある:
 *
 * - `restoredContentKey`: 履歴復元 (undo/redo) の layout effect が同期的に入れた内容。
 * - `mountContentKey`: マウント時にエディタを作った内容。**まだ一度も差し替わっていない間だけ**
 *   有効なので、呼び出し側は差し替えを決めた時点で `null` にする。ここで打ち止めないと、
 *   マウント直後の二度打ち (ユニット数だけの無駄な `setContent`) が毎回走る。
 *
 * どちらとも違う内容が来たら、それは外から入った変更なのでエディタへ流し込む。
 */
export function shouldSyncExternalTextFlowContent(
  restoredContentKey: string | null,
  mountContentKey: string | null,
  blocksSyncKey: string,
): boolean {
  return restoredContentKey !== blocksSyncKey && mountContentKey !== blocksSyncKey;
}
