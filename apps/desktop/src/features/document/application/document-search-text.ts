import { normalizeOverlaySnapshot } from "../overlay-snapshot";
import { overlayTextBlockInlineRuns } from "../overlay-inline-projection";
import type { InlineNode, PageOverlay, SigmaDocument } from "../model";

/**
 * 教材の中で人が読む文字を、文書の順に 1 本の文字列へ並べる (ワークスペースの本文検索の索引)。
 *
 * 本文のブロック・問題 (前文・問い・ヒント・解答とタグ)・枠・段組・引用・コード、紙面に置いた
 * 文字図形・吹き出し・表、ヘッダーとフッターを拾う。数式は TeX のまま入れる (「sin」「\sqrt」でも
 * 引けるように)。題名とコメントは入れない — 題名は一覧の題名検索が、コメントはコメント一覧が受け持つ。
 *
 * ブロックの境目は改行にするので、検索語がブロックをまたいで一致することはない。読み込んだだけの
 * JSON (検証前) を渡されても投げないよう、配列と文字列は必ず確かめてから読む。
 */
export function documentSearchText(document: SigmaDocument): string {
  const lines: string[] = [];
  const content = Array.isArray(document?.content)
    ? document.content
    : legacyChapterContent(document);
  collectBlocks(content, lines);
  const pageLayout = document?.pageLayout;
  for (const region of [pageLayout?.header, pageLayout?.footer]) {
    if (!region) continue;
    collectBlocks(region.blocks, lines);
    collectOverlay(region.overlay, lines);
  }
  collectOverlay(pageLayout?.overlay, lines);
  return lines.join("\n");
}

/** 章立てを持っていた古い教材は、章の中身を順につないだものが本文 (`parseSigmaDocument` と同じ読み方)。 */
function legacyChapterContent(document: unknown): unknown[] {
  const chapters = (document as { chapters?: unknown } | null)?.chapters;
  if (!Array.isArray(chapters)) return [];
  return chapters.flatMap((chapter) => {
    const content = (chapter as { content?: unknown } | null)?.content;
    return Array.isArray(content) ? content : [];
  });
}

function collectBlocks(blocks: unknown, lines: string[]): void {
  if (!Array.isArray(blocks)) return;
  for (const block of blocks) collectBlock(block, lines);
}

function collectBlock(value: unknown, lines: string[]): void {
  if (typeof value !== "object" || value === null) return;
  const block = value as Record<string, unknown>;
  switch (block.type) {
    case "section":
      pushLine(lines, typeof block.title === "string" ? block.title : "");
      return;
    case "heading":
    case "paragraph":
    case "codeBlock":
      pushInline(lines, block.children);
      return;
    case "list":
      collectListItems(block.items, lines);
      return;
    case "quote":
    case "boxBlock":
      if (block.type === "boxBlock") {
        pushInline(lines, block.title);
        pushInline(lines, block.subtitle);
      }
      collectBlocks(block.blocks, lines);
      return;
    case "layoutSection":
      collectBlocks(block.children, lines);
      return;
    case "problem":
      if (Array.isArray(block.tags)) pushLine(lines, block.tags.filter((tag) => typeof tag === "string").join(" "));
      for (const area of ["lead", "prompt", "hints", "solution"] as const) collectBlocks(block[area], lines);
      return;
    default:
      // 区切り線など、文字を持たないブロック。
      return;
  }
}

function collectListItems(items: unknown, lines: string[]): void {
  if (!Array.isArray(items)) return;
  for (const value of items) {
    if (typeof value !== "object" || value === null) continue;
    const item = value as Record<string, unknown>;
    pushInline(lines, item.children);
    // 続きブロックは見出し・段落・区切り線だけなので、ブロックとして読めば区切り線は自然に飛ぶ。
    collectBlocks(item.continuations, lines);
    if (Array.isArray(item.nested)) {
      for (const nested of item.nested) collectListItems((nested as { items?: unknown } | null)?.items, lines);
    }
  }
}

function collectOverlay(overlay: PageOverlay | undefined, lines: string[]): void {
  const snapshot = overlay?.overlaySnapshot;
  if (!snapshot) return;
  for (const shape of normalizeOverlaySnapshot(snapshot).shapes) {
    if (shape.type === "text" || shape.type === "callout") {
      for (const block of shape.props.blocks) pushInline(lines, overlayTextBlockInlineRuns(block));
    } else if (shape.type === "tableShape") {
      for (const cell of shape.props.table.cells) {
        for (const content of cell.content) pushInline(lines, content.type === "trend" ? content.label : content.children);
      }
    }
  }
}

/** 1 つの行 (段落など) の中の連なり。書式で分かれた文字はそのままつなぎ、数式は前後に空白を置く。 */
function pushInline(lines: string[], nodes: unknown): void {
  if (!Array.isArray(nodes)) return;
  let line = "";
  for (const node of nodes as InlineNode[]) {
    if (node?.type === "text" && typeof node.text === "string") line += node.text;
    else if (node?.type === "mathInline" && typeof node.tex === "string") line += ` ${node.tex} `;
  }
  pushLine(lines, line);
}

function pushLine(lines: string[], line: string): void {
  const trimmed = line.replace(/\s+/g, " ").trim();
  if (trimmed) lines.push(trimmed);
}
