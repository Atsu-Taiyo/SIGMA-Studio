import type { InlineNode, SigmaCommentAnchor, SigmaDocument } from "@/features/document";
import { walkDocumentBlocks, type EditableBlock } from "@/lib/document-tree";

/** カードの引用は 2 行で切るので、長い範囲を全部組まない。 */
const MAX_QUOTE_LENGTH = 400;

/**
 * コメントが指している本文を、本文と同じインラインノード (書式・数式つき) で切り出す。表示側は
 * 本文の静的な描画 (`InlineContent`) にそのまま渡せる。文字の範囲は `$tex$` を含む平文の文字数で数える
 * (本文のハイライト `getTextRangeForBlock` と同じ座標系)。本文から引けない付け先 (図形・領域・消えた所)
 * は null を返すので、保存してある引用の文字列を使う。
 */
export function getCommentQuoteContent(document: SigmaDocument, anchor: SigmaCommentAnchor): InlineNode[] | null {
  if (anchor.type === "overlayMath") {
    return anchor.tex ? [quoteMath(anchor.tex)] : null;
  }
  if (anchor.type === "block") {
    const block = findInlineBlock(document, anchor.blockId);
    return block ? nonEmpty(prepareQuote(block.children)) : null;
  }
  if (anchor.type === "inlineMath") {
    const block = findInlineBlock(document, anchor.blockId);
    const math = block?.children.find((node) => node.type === "mathInline" && node.id === anchor.mathInlineId);
    if (math) {
      return prepareQuote([math]);
    }
    return anchor.tex ? [quoteMath(anchor.tex)] : null;
  }
  if (anchor.type !== "textRange") {
    return null;
  }

  const blocks = [...walkDocumentBlocks(document)].filter(hasInlineChildren);
  const startIndex = blocks.findIndex((block) => block.id === anchor.start.blockId);
  const endIndex = blocks.findIndex((block) => block.id === anchor.end.blockId);
  if (startIndex < 0 || endIndex < 0) {
    return null;
  }
  // 後ろから前へ選んだ範囲も、本文の並びに直してから切る。
  const forward = startIndex < endIndex || (startIndex === endIndex && anchor.start.offset <= anchor.end.offset);
  const [first, last] = forward ? [anchor.start, anchor.end] : [anchor.end, anchor.start];
  const [from, to] = forward ? [startIndex, endIndex] : [endIndex, startIndex];
  const nodes: InlineNode[] = [];
  let length = 0;
  for (let index = from; index <= to && length < MAX_QUOTE_LENGTH; index += 1) {
    const children = blocks[index].children;
    const sliceStart = index === from ? first.offset : 0;
    const sliceEnd = index === to ? last.offset : Number.POSITIVE_INFINITY;
    const slice = sliceInlineNodes(children, sliceStart, sliceEnd);
    if (slice.length === 0) {
      continue;
    }
    if (nodes.length > 0) {
      nodes.push({ type: "text", text: " " });
    }
    nodes.push(...slice);
    length += plainLength(slice);
  }
  return nonEmpty(prepareQuote(nodes));
}

type InlineBlock = Extract<EditableBlock, { type: "paragraph" | "heading" | "listItem" }>;

function hasInlineChildren(block: EditableBlock): block is InlineBlock {
  return block.type === "paragraph" || block.type === "heading" || block.type === "listItem";
}

function findInlineBlock(document: SigmaDocument, blockId: string): InlineBlock | null {
  for (const block of walkDocumentBlocks(document)) {
    if (block.id === blockId) {
      return hasInlineChildren(block) ? block : null;
    }
  }
  return null;
}

/** 平文での長さ。数式は `$tex$` の長さ (空の数式は 1)。 */
function nodeLength(node: InlineNode): number {
  return node.type === "mathInline" ? (node.tex ? node.tex.length + 2 : 1) : node.text.length;
}

function plainLength(nodes: readonly InlineNode[]): number {
  return nodes.reduce((total, node) => total + nodeLength(node), 0);
}

/** 範囲 [from, to) に掛かる部分を返す。数式は一部だけ掛かっても丸ごと入れる (途中で切れない)。 */
export function sliceInlineNodes(nodes: readonly InlineNode[], from: number, to: number): InlineNode[] {
  const result: InlineNode[] = [];
  let cursor = 0;
  for (const node of nodes) {
    const start = cursor;
    const end = cursor + nodeLength(node);
    cursor = end;
    if (end <= from || start >= to) {
      continue;
    }
    if (node.type === "mathInline") {
      result.push(node);
      continue;
    }
    const text = node.text.slice(Math.max(0, from - start), Math.min(node.text.length, to - start));
    if (text) {
      result.push({ ...node, text });
    }
  }
  return result;
}

/**
 * カードの中で組めるように整える。本文の文字の大きさと書体は持ち込まない (見出しの 20pt が
 * カードに出ないように)。数式の id は本文の数式と被らないよう付け替える (同じ id が画面に 2 つあると、
 * id で数式を探す処理がカードの側を掴みうる)。
 */
function prepareQuote(nodes: readonly InlineNode[]): InlineNode[] {
  return nodes.map((node) => {
    const rest = { ...node };
    delete rest.fontSize;
    delete rest.fontFamily;
    return rest.type === "mathInline" ? { ...rest, id: `${rest.id}__comment_quote` } : rest;
  });
}

function quoteMath(tex: string): InlineNode {
  return { type: "mathInline", id: "comment_quote_math", tex, display: "inline" };
}

function nonEmpty(nodes: InlineNode[]): InlineNode[] | null {
  return nodes.some((node) => node.type === "mathInline" || node.text.trim().length > 0) ? nodes : null;
}
