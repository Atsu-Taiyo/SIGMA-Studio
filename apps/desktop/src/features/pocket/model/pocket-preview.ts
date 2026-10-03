import type { OverlayAsset, OverlayShape, SigmaBlock } from "@/features/document";
import {
  cloneDocumentBlocksForPaste,
  cloneTextFlowBlocksForPaste,
  EDITOR_CLIPBOARD_MIME,
  parseEditorClipboardHtml,
  parseEditorClipboardPayload,
  type EditorClipboardPayload,
} from "@/lib/editor-clipboard";

/**
 * ポケットの項目をカードに描くための、中身の要約。
 *
 * コピー時に書かれたクリップボードの内容 (`PocketClipboardBag`) から作る派生値で、正本ではない。
 * 貼り戻しは必ず元の bag をそのまま使い、ここで作った値からは文書へ何も書かない。
 */
export type PocketPreview =
  | {
      kind: "blocks";
      /** 描画専用。ブロック ID は付け替え済みで、紙面の同じ ID の要素と取り違えない。 */
      blocks: SigmaBlock[];
      blockCount: number;
      text: string;
    }
  | {
      kind: "shapes";
      shapes: OverlayShape[];
      assets: Record<string, OverlayAsset>;
      shapeCount: number;
    }
  | {
      kind: "mixed";
      text: string;
      shapes: OverlayShape[];
      assets: Record<string, OverlayAsset>;
      shapeCount: number;
    }
  | { kind: "math"; tex: string }
  | { kind: "text"; text: string };

export const POCKET_PLAIN_TEXT_MIME = "text/plain";
export const POCKET_HTML_MIME = "text/html";

function readPayload(bag: Readonly<Record<string, string>>): EditorClipboardPayload | null {
  // 独自 MIME を受け付けない貼り付け経路でも読めるよう、HTML に埋めた payload を第二候補にする
  // (`readEditorClipboardPayload` と同じ順序)。
  return parseEditorClipboardPayload(bag[EDITOR_CLIPBOARD_MIME] ?? "")
    ?? parseEditorClipboardHtml(bag[POCKET_HTML_MIME] ?? "");
}

/** 空白を畳んだ 1 行。カードの読み上げ名と検索に使う。 */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * クリップボードの内容から、カードに出す要約を作る。描くものが何も無ければ null。
 *
 * 種類は SigmaDoc の payload (ブロック・図形・数式) を優先し、payload が無いときだけ
 * プレーンテキストを見る。書式のあるテキストは payload 側に載っているので、HTML は
 * 描画に使わない。
 */
export function derivePocketPreview(bag: Readonly<Record<string, string>>): PocketPreview | null {
  const payload = readPayload(bag);

  if (payload?.kind === "inlineMath") {
    return payload.tex.trim() ? { kind: "math", tex: payload.tex } : null;
  }

  if (payload?.kind === "textFlowBlocks" || payload?.kind === "documentBlocks") {
    if (payload.blocks.length === 0) {
      return null;
    }
    // 紙面と同じ ID の要素が DOM に増えると、ID で探す処理 (アウトラインのスクロールや
    // 図形アンカーの実測) が取り違える。描画用の写しは必ず別の ID にする。
    const blocks = payload.kind === "textFlowBlocks"
      ? cloneTextFlowBlocksForPaste(payload.blocks)
      : cloneDocumentBlocksForPaste(payload.blocks);
    return {
      kind: "blocks",
      blocks,
      blockCount: blocks.length,
      text: collapseWhitespace(bag[POCKET_PLAIN_TEXT_MIME] ?? ""),
    };
  }

  if (payload?.kind === "overlayShapes") {
    return payload.shapes.length > 0
      ? { kind: "shapes", shapes: payload.shapes, assets: payload.assets, shapeCount: payload.shapes.length }
      : null;
  }

  if (payload?.kind === "textAndShapes") {
    const text = collapseWhitespace(payload.text.text);
    if (payload.shapes.length === 0) {
      return text ? { kind: "text", text } : null;
    }
    return {
      kind: "mixed",
      text,
      shapes: payload.shapes,
      assets: payload.assets,
      shapeCount: payload.shapes.length,
    };
  }

  const text = collapseWhitespace(bag[POCKET_PLAIN_TEXT_MIME] ?? "");
  return text ? { kind: "text", text } : null;
}
