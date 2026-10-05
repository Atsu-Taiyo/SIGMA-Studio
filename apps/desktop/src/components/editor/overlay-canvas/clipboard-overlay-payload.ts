import {
  PROBLEM_AREA_ORDER,
  type InlineNode,
  type OverlayShape,
  type OverlayTextBlock,
  type OverlayTextShape,
  type SigmaBlock,
} from "@/features/document";
import {
  DEFAULT_TEXT_SHAPE_WIDTH,
  getShapesSelectionBounds,
  getTextShapeLineHeightPx,
} from "@/features/drawing";
import {
  EDITOR_CLIPBOARD_MIME,
  EDITOR_TEXT_SLICE_MIME,
  createOverlayClipboardPayload,
  isTextFlowClipboardBlock,
  parseEditorClipboardHtml,
  parseEditorClipboardPayload,
  toOverlayShapesClipboardPayload,
  type EditorClipboardPayload,
} from "@/lib/editor-clipboard";
import { createId } from "@/lib/id";
import type { TiptapDoc } from "@/lib/tiptap-adapter";

import { tiptapDocToOverlayTextBlocks, toOverlayTextBlock } from "../text-flow/overlay-tiptap-adapter";

type OverlayShapesPayload = Extract<EditorClipboardPayload, { kind: "overlayShapes" }>;

/** 文章の図形の外側 (文字の位置) と、図形の下に添えるときの図形との間隔。 */
const TEXT_SHAPE_GAP_PX = 16;

function readPayload(clip: Readonly<Record<string, string>>): EditorClipboardPayload | null {
  return parseEditorClipboardPayload(clip[EDITOR_CLIPBOARD_MIME] ?? "")
    ?? parseEditorClipboardHtml(clip["text/html"] ?? "");
}

function paragraphFromText(text: string): OverlayTextBlock {
  return {
    type: "paragraph",
    id: createId("p"),
    children: text ? [{ type: "text", text }] : [],
  };
}

/** 改行ごとに 1 段落。前後の空行は捨てる (コピー元の余白をそのまま持ち込まない)。 */
function paragraphsFromPlainText(text: string): OverlayTextBlock[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[0]?.trim() === "") {
    lines.shift();
  }
  while (lines.length > 0 && lines[lines.length - 1]?.trim() === "") {
    lines.pop();
  }
  return lines.map(paragraphFromText);
}

/**
 * 本文の範囲コピー (ProseMirror の slice) を、図形の中身のブロックへ直す。
 * 書式・数式・リストを保つために、本文と同じ変換 (`tiptapDocToOverlayTextBlocks`) を通す。
 * 直せなかったとき (選択の端が入れ物の途中で切れているなど) は空を返し、呼び出し側が
 * プレーンテキストへ落とす。
 */
function blocksFromSlice(slice: unknown): OverlayTextBlock[] {
  if (typeof slice !== "object" || slice === null || !Array.isArray((slice as { content?: unknown }).content)) {
    return [];
  }
  try {
    const doc = { type: "doc", content: (slice as { content: unknown[] }).content } as TiptapDoc;
    return tiptapDocToOverlayTextBlocks(doc).filter((block) => block.type !== "paragraph" || block.children.length > 0);
  } catch {
    return [];
  }
}

function readSlice(clip: Readonly<Record<string, string>>): unknown {
  try {
    const parsed: unknown = JSON.parse(clip[EDITOR_TEXT_SLICE_MIME] ?? "");
    return typeof parsed === "object" && parsed !== null ? (parsed as { slice?: unknown }).slice : null;
  } catch {
    return null;
  }
}

function inlineMathParagraph(tex: string): OverlayTextBlock {
  const math: InlineNode = { type: "mathInline", id: createId("math"), tex, display: "inline" };
  return { type: "paragraph", id: createId("p"), children: [math] };
}

/**
 * 本文のブロックを、図形に入れられるブロックの並びへ直す。
 *
 * 図形は段落・見出し・リスト・引用・コード・区切り線までしか持てない。問題・囲み枠・段組は、
 * 中のブロックを**ブロックのまま順に**並べて持ち込む (段落やリストの区切り、数式、書式を保つ)。
 * 問題は紙面に並ぶ順 (導入文 → 問題文 → ヒント → 解答) で、番号・枠・タグは図形に持てないので落ちる。
 * 節は見出しの文字だけを段落にする。
 */
function toOverlayTextBlocks(block: SigmaBlock | Parameters<typeof toOverlayTextBlock>[0]): OverlayTextBlock[] {
  switch (block.type) {
    case "problem":
      return PROBLEM_AREA_ORDER.flatMap((area) => (block[area] as SigmaBlock[]).flatMap(toOverlayTextBlocks));
    case "boxBlock":
      return (block.blocks as SigmaBlock[]).flatMap(toOverlayTextBlocks);
    case "layoutSection":
      return (block.children as SigmaBlock[]).flatMap(toOverlayTextBlocks);
    default:
      return [toOverlayTextBlock(block as Parameters<typeof toOverlayTextBlock>[0])];
  }
}

/**
 * コピーが書いた内容から、文章の図形に入れるブロックを作る。作れるものが無ければ空。
 *
 * SigmaDoc の payload (ブロック・数式) を最優先し、無いときは本文の範囲コピーの slice、
 * それも無いときだけプレーンテキストを使う。図形に入れられないブロック (問題など) は、
 * 中のブロックを順に並べて持ち込む — 捨てると、ポケットに入れた中身が消えてしまうため。
 */
function textBlocksFromClipboard(
  clip: Readonly<Record<string, string>>,
  payload: EditorClipboardPayload | null,
): OverlayTextBlock[] {
  const plain = clip["text/plain"] ?? "";
  if (payload?.kind === "inlineMath") {
    return payload.tex.trim() ? [inlineMathParagraph(payload.tex)] : [];
  }
  if (payload?.kind === "textFlowBlocks" || payload?.kind === "documentBlocks") {
    // 文章を持たないブロック (画像・表) は、ここでは持ち込まない。
    const blocks: OverlayTextBlock[] = payload.blocks
      .filter((block) => payload.kind === "textFlowBlocks" || block.type === "problem" || isTextFlowClipboardBlock(block))
      .flatMap((block) => toOverlayTextBlocks(block));
    return blocks.length > 0 ? blocks : paragraphsFromPlainText(plain);
  }
  if (payload?.kind === "textAndShapes") {
    const fromSlice = blocksFromSlice(payload.text.slice);
    return fromSlice.length > 0 ? fromSlice : paragraphsFromPlainText(payload.text.text);
  }
  const fromSlice = blocksFromSlice(readSlice(clip));
  return fromSlice.length > 0 ? fromSlice : paragraphsFromPlainText(plain);
}

function createTextShape(blocks: OverlayTextBlock[], x: number, y: number): OverlayTextShape {
  return {
    id: createId("overlay_shape"),
    type: "text",
    x,
    y,
    rotation: 0,
    props: {
      w: DEFAULT_TEXT_SHAPE_WIDTH,
      // 高さは描画のあとで測り直される。最初は段落の数だけ 1 行ずつ見積もる。
      h: getTextShapeLineHeightPx("m") * Math.max(1, blocks.length),
      blocks,
      color: "black",
      size: "m",
    },
  };
}

/**
 * ポケットの項目 (コピーが書いたクリップボード) を、紙面の図形として置くための payload にする。
 *
 * 本文を持たない紙面 (ホワイトボード) は、本文のコピーを貼る場所が無い。ここで文章の図形に
 * 直して、図形の貼り付けと同じ経路 (ID の振り直し・Undo・選択) で置けるようにする。
 *
 * - 図形だけのコピーはそのまま。
 * - 本文 (文章・ブロック・数式) のコピーは、文章の図形 1 つ。
 * - 本文と図形が一緒のコピーは、文章の図形を図形の上に添える。
 *
 * 位置は呼び出し側が決める (`centerAt`) ので、ここでの座標は図形同士の相対位置だけが意味を持つ。
 * 置けるものが何も無ければ null。
 */
export function createOverlayPayloadFromClipboard(
  clip: Readonly<Record<string, string>>,
): OverlayShapesPayload | null {
  const payload = readPayload(clip);
  if (payload?.kind === "overlayShapes") {
    return payload.shapes.length > 0 ? payload : null;
  }

  const blocks = textBlocksFromClipboard(clip, payload);
  const sourceShapes = payload?.kind === "textAndShapes" ? toOverlayShapesClipboardPayload(payload) : null;
  if (blocks.length === 0) {
    return sourceShapes && sourceShapes.shapes.length > 0 ? sourceShapes : null;
  }

  const text = createTextShape(blocks, 0, 0);
  const figures = sourceShapes?.shapes ?? [];
  const bounds = getShapesSelectionBounds(figures);
  if (bounds) {
    text.x = bounds.x;
    text.y = bounds.y - text.props.h - TEXT_SHAPE_GAP_PX;
  }
  const shapes: OverlayShape[] = [text, ...figures];

  return createOverlayClipboardPayload(shapes, sourceShapes?.assets ?? {}, sourceShapes?.sourceDocId);
}
