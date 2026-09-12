import { createTranslator, SUPPORTED_LOCALES } from "@/lib/i18n";
import { parseDocumentTitleInlineNodes } from "@/features/rendering/core";
import { inlineNodesToPlainText } from "@/lib/tiptap-adapter";
import type { BoxBlockChildBlock, InlineNode, LayoutSectionChildBlock, ListNode, RichBlock, SigmaBlock, SigmaDocument } from "@/features/document";

export const DEFAULT_DOCUMENT_TITLE = "無題の教材";

/**
 * 「まだ題名を付けていない」を表す既定題名の**全ロケール分**。
 *
 * D3 で、新規文書の題名は**作成時点の UI 言語**で焼かれるようになった
 * (`blank-document.ts` / `storage.ts`)。日本語の 1 文字列とだけ比べると、
 * 英語 UI で作った文書の "Untitled material" が「明示的に付けた題名」と
 * 判定され、**本文の 1 行目から題名を導出する動作が永久に止まる**。
 * 訳文を判定に使う以上、比較対象は 1 言語ではなく全言語でなければならない。
 */
let defaultDocumentTitles: ReadonlySet<string> | null = null;

/**
 * 初回参照まで作らない。**module 直下で作ると、この module を import しただけで
 * 翻訳器が 4 つ立ち上がる** — `document-title.ts` はエディタの起動経路に居るので、
 * 読み込み時の仕事は増やさない。値は起動後に変わらないので 1 度だけで足りる。
 */
function getDefaultDocumentTitles(): ReadonlySet<string> {
  defaultDocumentTitles ??= new Set(
    SUPPORTED_LOCALES.flatMap((locale) => [
      createTranslator(locale, "workspace")("untitledMaterial") as unknown as string,
      createTranslator(locale, "editor")("shell.untitledDocument") as unknown as string,
    ]).map((title) => title.trim()),
  );
  return defaultDocumentTitles;
}
export const MAX_DOCUMENT_TITLE_LENGTH = 160;

type TitleSourceBlock = SigmaBlock | RichBlock | LayoutSectionChildBlock | BoxBlockChildBlock;

/**
 * タイトルの 2 つの面。**どちらも同じ正規化から作る**ので、片方だけが真になることはない。
 *
 * 本文から導出したタイトルは `InlineNode[]` として素直に取り出せるのに、以前は
 * `$tex$` の文字列へ潰してから表示側で読み直していた。往復のたびに上限の切り出しが
 * `$…$` の対を割り、tex の前後空白が落ち、本文の素の `$` が区切りに化けるので、
 * `$\sum…` のような生ソースが画面に出ていた。導出側はノード列のまま渡す。
 */
export interface ResolvedDocumentTitle {
  /** 台帳・ファイル名・検索・aria-label・AI・MCP など**素の文字列しか置けない面**用。 */
  text: string;
  /** 表示面用。本文由来ならそのノード列、明示タイトルなら表示時パース、数式が無ければ `null`。 */
  nodes: InlineNode[] | null;
}

export function isDocumentTitleExplicit(title: string | null | undefined): boolean {
  const normalized = title?.trim() ?? "";
  return normalized.length > 0 && !getDefaultDocumentTitles().has(normalized);
}

export function documentTitleInputValue(title: string): string {
  return isDocumentTitleExplicit(title) ? title : "";
}

/**
 * 文字列のタイトル。`resolveDocumentTitleContent(...).text` と**常に同じ値**を返す
 * (この関数自体がその薄いラッパなので、2 つの真実になりようがない)。
 */
export function resolveDocumentTitle(document: SigmaDocument, fallback = DEFAULT_DOCUMENT_TITLE): string {
  return resolveDocumentTitleContent(document, fallback).text;
}

export function resolveDocumentTitleContent(document: SigmaDocument, fallback = DEFAULT_DOCUMENT_TITLE): ResolvedDocumentTitle {
  if (isDocumentTitleExplicit(document.metadata.title)) {
    // 明示タイトルは保存値が素の文字列なので、数式は表示時に読むしかない。
    // 保存値は 1 バイトも書き換えない。
    const text = normalizeDocumentTitleText(document.metadata.title) ?? fallback;
    return { text, nodes: parseDocumentTitleInlineNodes(text) };
  }

  const derived = getFirstContentLineTitleNodes(document);
  if (derived) {
    // 数式が無い派生タイトルは `null` を返す。素のテキストにリッチ描画の要素を被せても
    // 見た目は変わらず、DOM とスタイルの分岐だけが増えるため。
    return {
      text: inlineNodesToPlainText(derived),
      nodes: derived.some((node) => node.type === "mathInline") ? derived : null,
    };
  }

  return { text: normalizeDocumentTitleText(fallback) ?? DEFAULT_DOCUMENT_TITLE, nodes: null };
}

export function getFirstContentLineTitle(document: SigmaDocument): string | null {
  const nodes = getFirstContentLineTitleNodes(document);
  return nodes ? inlineNodesToPlainText(nodes) : null;
}

export function getFirstContentLineTitleNodes(document: SigmaDocument): InlineNode[] | null {
  return firstTitleLineFromBlocks(document.content);
}

/**
 * タイトルの正規化。**実装はここ 1 つだけ**で、文字列版 (`normalizeDocumentTitleText`) は
 * この関数のラッパ。規則は次の 4 つ:
 *
 * 1. text ノードの `\n` で行に割り、最初の「グリフのある行」だけを採る。tex の中の改行も
 *    空白へ均す — タイトルは常に 1 行という不変条件が、台帳・タブの `title` 属性・
 *    入力欄 (DOM が改行を黙って落とす) の全部にかかっているため
 * 2. 各 text ノードの連続空白を 1 個へ畳み、行頭・行末の空白はノード境界をまたいで落とす
 *    (改行以外の tex 内部の空白には触れない — 保存値を描画都合で書き換えないため)
 * 3. 上限は text が `text.length`、数式が `tex.length + 2` (`$…$` の分)。**数式は分割しない** —
 *    直前までが上限未満なら丸ごと入れ、達していたら入れない。これが「`$\sum` で止まる」の根治。
 *    したがって上限をまたぐ数式が 1 つあると、結果は `MAX_DOCUMENT_TITLE_LENGTH` を超えうる。
 *    `text` 側だけを切るのは不可 — `text` は `nodes` の射影でなければ 2 つの真実になる
 * 4. 何も残らなければ `null`
 *
 * 装飾 (marks / 色 / 文字サイズ / 囲み枠) は落とし、`text` と `mathInline` の素のノードだけを返す。
 * タブや一覧の狭い面に本文の見出しサイズや囲み枠が漏れると行が壊れるうえ、
 * 明示タイトル側 (`parseDocumentTitleInlineNodes`) が作るノード列と形が揃わなくなるため。
 * 数式の id も本文のものは持ち込まず `t<index>` を振り直す (本文と同じ `data-id` が
 * ヘッダーとページの両方に出ると、DOM 全体を引く問い合わせが本文ではなくタイトルを掴む)。
 */
export function normalizeDocumentTitleInlineNodes(nodes: readonly InlineNode[]): InlineNode[] | null {
  for (const line of splitTitleLines(nodes)) {
    const normalized = normalizeTitleLine(line);
    if (normalized.length > 0) {
      return clampTitleLine(normalized);
    }
  }
  return null;
}

export function normalizeDocumentTitleText(value: string | null | undefined): string | null {
  const nodes = normalizeDocumentTitleInlineNodes([{ type: "text", text: value ?? "" }]);
  return nodes ? inlineNodesToPlainText(nodes) : null;
}

/** text ノードの改行で行に割る。数式ノードは行を割らない (中の改行は行内の空白として均す)。 */
function splitTitleLines(nodes: readonly InlineNode[]): InlineNode[][] {
  const lines: InlineNode[][] = [[]];
  for (const node of nodes) {
    if (node.type !== "text") {
      lines[lines.length - 1].push(node);
      continue;
    }
    const parts = node.text.split(/\r?\n/);
    parts.forEach((part, index) => {
      if (index > 0) {
        lines.push([]);
      }
      lines[lines.length - 1].push({ type: "text", text: part });
    });
  }
  return lines;
}

function normalizeTitleLine(line: readonly InlineNode[]): InlineNode[] {
  const nodes: InlineNode[] = [];
  for (const node of line) {
    if (node.type === "text") {
      nodes.push({ type: "text", text: node.text.replace(/\s+/g, " ") });
      continue;
    }
    // 空の tex はグリフを持たない (画面には何も出ない) ので、行の中身としては数えない。
    if (node.tex.trim().length > 0) {
      // TeX では改行はただの空白なので、1 行へ均しても数式の意味は変わらない。
      nodes.push({ type: "mathInline", id: `t${nodes.length}`, tex: node.tex.replace(/\r?\n/g, " "), display: "inline" });
    }
  }

  trimTitleLineEdge(nodes, "start");
  trimTitleLineEdge(nodes, "end");
  return nodes.filter((node) => node.type !== "text" || node.text.length > 0);
}

/** 行頭・行末の空白をノード境界をまたいで落とす (空になった text ノードは畳んで次を見る)。 */
function trimTitleLineEdge(nodes: InlineNode[], edge: "start" | "end"): void {
  while (nodes.length > 0) {
    const index = edge === "start" ? 0 : nodes.length - 1;
    const node = nodes[index];
    if (node.type !== "text") {
      return;
    }
    const text = edge === "start" ? node.text.replace(/^\s+/, "") : node.text.replace(/\s+$/, "");
    if (text.length === 0) {
      nodes.splice(index, 1);
      continue;
    }
    nodes[index] = { type: "text", text };
    return;
  }
}

function clampTitleLine(line: readonly InlineNode[]): InlineNode[] {
  const clamped: InlineNode[] = [];
  let used = 0;
  for (const node of line) {
    if (used >= MAX_DOCUMENT_TITLE_LENGTH) {
      break;
    }
    if (node.type !== "text") {
      clamped.push(node);
      used += node.tex.length + 2;
      continue;
    }
    const text = node.text.slice(0, MAX_DOCUMENT_TITLE_LENGTH - used);
    if (text.length > 0) {
      clamped.push({ type: "text", text });
      used += text.length;
    }
    if (text.length < node.text.length) {
      break;
    }
  }
  return clamped;
}

function firstTitleLineFromBlocks(blocks: TitleSourceBlock[]): InlineNode[] | null {
  for (const block of blocks) {
    const nodes = firstTitleLineFromBlock(block);
    if (nodes) {
      return nodes;
    }
  }
  return null;
}

function firstTitleLineFromBlock(block: TitleSourceBlock): InlineNode[] | null {
  switch (block.type) {
    case "section":
      return normalizeDocumentTitleInlineNodes([{ type: "text", text: block.title ?? "" }]);
    case "heading":
    case "paragraph":
      return firstTitleLineFromInlineNodes(block.children);
    case "list":
      return firstTitleLineFromList(block);
    case "boxBlock":
      return firstTitleLineFromInlineNodes(block.title ?? []) ?? firstTitleLineFromBlocks(block.blocks);
    case "layoutSection":
      return firstTitleLineFromBlocks(block.children);
    case "problem":
      return firstTitleLineFromBlocks([
        ...block.lead,
        ...block.prompt,
        ...block.solution,
        ...block.hints,
      ]);
    case "codeBlock":
      return firstTitleLineFromInlineNodes(block.children);
    case "quote":
      return firstTitleLineFromBlocks(block.blocks);
    case "divider":
      return null;
  }
}

function firstTitleLineFromList(list: ListNode): InlineNode[] | null {
  for (const item of list.items) {
    const nodes = firstTitleLineFromInlineNodes(item.children);
    if (nodes) {
      return nodes;
    }
    const nested = item.nested ? firstTitleLineFromBlocks(item.nested) : null;
    if (nested) {
      return nested;
    }
  }
  return null;
}

function firstTitleLineFromInlineNodes(children: InlineNode[]): InlineNode[] | null {
  return normalizeDocumentTitleInlineNodes(children);
}
