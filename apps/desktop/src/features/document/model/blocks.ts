import type { ColumnRule } from "./column-rule";
import type { InlineNode, LineHeight, TextAlign } from "./rich-text";

export type SigmaBlock =
  | SectionNode
  | HeadingNode
  | ParagraphNode
  | ListNode
  | QuoteBlockNode
  | CodeBlockNode
  | DividerNode
  | ProblemNode
  | LayoutSectionNode
  | BoxBlockNode;

/**
 * 文章を持つブロック。`divider` は意図的に入れていない — ヘッダー/フッター (`PageRunningRegion`)
 * はこの型で組まれていて、ページごとに複製・採寸される領域に「中身の無いブロック」を通すと
 * `children` を前提にした経路がそこでも分岐を持つ。罫線が要るなら図形で引ける。
 */
export type RichBlock = HeadingNode | ParagraphNode | ListNode;
export type ProblemAreaBlock =
  | RichBlock
  | QuoteBlockNode
  | CodeBlockNode
  | DividerNode
  | LayoutSectionNode
  | BoxBlockNode;
export type LayoutSectionChildBlock =
  | SectionNode
  | HeadingNode
  | ParagraphNode
  | ListNode
  | QuoteBlockNode
  | CodeBlockNode
  | DividerNode
  | BoxBlockNode;
/** 枠は任意の文書ブロックを包める。改ページも子の pagination で表す。 */
export type BoxBlockChildBlock = SigmaBlock;

/**
 * 引用の中に置けるもの。入れ子の引用と段組・囲み枠は入れていない — 引用は「本文を一段
 * 引き込む」ための入れ物で、その中でページ割りの単位をもう一段作る意味が無い。
 * 必要になったらここに 1 行足す (中身の描画は子ブロックの経路をそのまま通る)。
 */
export type QuoteChildBlock =
  | HeadingNode
  | ParagraphNode
  | ListNode
  | CodeBlockNode
  | DividerNode;

export interface BaseNode {
  type: string;
  id: string;
  pagination?: PaginationHints;
  /**
   * ブロック最終行の下に足す CSS px (0..400 の整数、ズーム非依存の論理 px)。
   * 未指定は 0 と同じ = 従来どおりの間隔。`padding-bottom` として描くので実測の高さに含まれる。
   */
  spaceAfterPx?: number;
}

export interface PaginationHints {
  /** 手動改ページ / 改段。このブロックを次のページ (段組みでは次の段) の先頭から始める。 */
  break?: boolean;
}

export interface SectionNode extends BaseNode {
  type: "section";
  title: string;
  align?: TextAlign;
  lineHeight?: LineHeight;
}

export interface HeadingNode extends BaseNode {
  type: "heading";
  level: 1 | 2 | 3;
  children: InlineNode[];
  align?: TextAlign;
  lineHeight?: LineHeight;
}

export interface ParagraphNode extends BaseNode {
  type: "paragraph";
  children: InlineNode[];
  align?: TextAlign;
  lineHeight?: LineHeight;
}

/**
 * 引用ブロック。本文ブロックを一段引き込んで見せる入れ物 (HTML の `blockquote` と同じ)。
 *
 * 中身が複数行になっても縦棒は **ブロック 1 つに 1 本** 引く。段落ごとに引くと、チャンク境界・
 * 改ページウィジェット・段組の絶対配置が間に入った瞬間に繋ぎ目が割れる。
 */
export interface QuoteBlockNode extends BaseNode {
  type: "quote";
  blocks: QuoteChildBlock[];
}

/**
 * コードブロック。改行を含む **1 つの** テキストブロック。
 *
 * 段落の連なりではなく 1 ブロックなので、中の行間は常に一定で、箱も 1 つ。改行は他の本文と
 * 同じ規約で text run の中の `\n` として持つ (編集面では hardBreak)。
 * 文字単位の書式は `children` の run が持つので、フォント・大きさ・色はそのまま変えられる。
 */
export interface CodeBlockNode extends BaseNode {
  type: "codeBlock";
  children: InlineNode[];
  /**
   * 色分けに使う言語。未指定は自動判定。
   *
   * 値は highlight.js の登録名そのもの（`features/rendering/adapters/code-highlight.ts` の一覧）。
   * 色そのものは保存しない — トークンは毎回引き直す派生値で、これにより編集中・静的描画・
   * 印刷/PDF・埋め込みビューアが同じ関数から同じ色を出せる。
   */
  language?: string;
  /**
   * コードブロックだけの配色。未指定はライト。
   *
   * アプリ全体のテーマとは独立したブロック設定として保存し、編集面・印刷・ビューアの全てで
   * 同じ背景と構文色を使う。背景色そのものを保存しないので、配色の調整で文書を書き換えずに済む。
   */
  theme?: CodeBlockTheme;
}

export type CodeBlockTheme = "light" | "dark";

export function normalizeCodeBlockTheme(value: unknown): CodeBlockTheme | undefined {
  return value === "light" || value === "dark" ? value : undefined;
}

/** 区切り線。中身を持たない唯一の本文ブロック。 */
export interface DividerNode extends BaseNode {
  type: "divider";
}

/**
 * How an ordered list draws its number. Adding a近い形式 (全角括弧など) means adding one value
 * here plus one input rule and one counter style — `listType` stays `"ordered"` so every existing
 * `listType === "ordered"` branch keeps working.
 */
export type OrderedListMarkerStyle = "decimal" | "paren";

/**
 * 1 つの項目マーカーの下にぶら下がるブロック。
 *
 * 区切り線も置ける — 項目の中で話題を切りたいことは普通にあり、置けないほうが不自然だから。
 * 入れ物 (引用・囲み枠・段組) は入れない: 項目の中でページ割りの単位を増やすと、リストの
 * マーカー計算と入れ物のページまたぎが同時に効いて手に負えなくなる。
 *
 * `divider` は文章を持たない。項目の中身を読む側は `listItemContinuationInlineNodes` を通すこと。
 */
export type ListItemContinuationNode = HeadingNode | ParagraphNode | DividerNode;

export interface ListNode extends BaseNode {
  type: "list";
  listType: "bullet" | "ordered";
  start?: number;
  /** 番号マーカーの見せ方。未指定は "decimal"。"ordered" 以外では無視する。 */
  markerStyle?: OrderedListMarkerStyle;
  items: ListItemNode[];
}

export interface ListItemNode {
  type: "listItem";
  id: string;
  children: InlineNode[];
  align?: TextAlign;
  /** Extra space after this item. List items are independently draggable blocks in the editor. */
  spaceAfterPx?: number;
  /** Additional text blocks that stay under the same list marker. */
  continuations?: ListItemContinuationNode[];
  nested?: ListNode[];
}

export interface ProblemNode extends BaseNode {
  type: "problem";
  tags: string[];
  lead: ProblemAreaBlock[];
  prompt: ProblemAreaBlock[];
  answer?: AnswerDefinition;
  solution: ProblemAreaBlock[];
  hints: ProblemAreaBlock[];
  areaLayout?: Partial<Record<ProblemAreaKind, ProblemAreaLayout>>;
  numbering?: ProblemNumbering;
  frame?: ProblemFrame;
}

export type ProblemAreaKind = "lead" | "prompt" | "solution" | "hints";

/**
 * The order a problem's areas are laid out in on the page — 導入文 → 問題文 → コメント →
 * 解答. Note this is NOT the field order of `ProblemNode` (`solution` is declared before
 * `hints`), so anything walking areas for rendering, pagination or editing must use this
 * constant rather than iterating the interface.
 */
export const PROBLEM_AREA_ORDER: readonly ProblemAreaKind[] = ["lead", "prompt", "hints", "solution"];

/**
 * Unknown marker styles become `undefined` (= the implicit `"decimal"`) rather than being kept, so
 * an unrecognized value degrades to a plain numbered list instead of losing the list entirely.
 */
export function normalizeOrderedListMarkerStyle(value: unknown): OrderedListMarkerStyle | undefined {
  return value === "decimal" || value === "paren" ? value : undefined;
}

export type ProblemAreaColumnSpan = "column" | "full";

export interface ProblemAreaLayout {
  minHeightMm?: number;
  columnSpan?: ProblemAreaColumnSpan;
}

export interface ProblemNumbering {
  enabled?: boolean;
  fontSize?: number;
  value?: number;
}

export interface ProblemFrame {
  enabled?: boolean;
  styleId?: string;
}

export interface LayoutSectionNode extends BaseNode {
  type: "layoutSection";
  layout: LayoutSectionLayout;
  children: LayoutSectionChildBlock[];
}

export interface LayoutSectionLayout {
  columnCount: number;
  columnGapMm?: number;
  columnRule?: ColumnRule;
  /**
   * Independent column ownership. Each entry is the id of the first child in that column,
   * ordered from left to right. Unlike `pagination.break`, this is layout structure rather than
   * pagination state, so editing one column can never cause its blocks to flow into another.
   */
  columnStartIds?: string[];
  /** Relative widths, ordered like `columnStartIds`. Values are normalized at render time. */
  columnWidths?: number[];
}

export interface BoxBlockNode extends BaseNode {
  type: "boxBlock";
  /** Built-in or user-defined style identifier such as `fancybox` or `doublebox`. */
  styleId: string;
  title?: InlineNode[];
  blocks: BoxBlockChildBlock[];
  frame?: BoxFrameSpec;
}

export interface BoxFrameSpec {
  borderWidthPx?: number;
  borderColor?: string;
  borderStyle?: "solid" | "dashed" | "dotted" | "double" | "none";
  backgroundColor?: string;
  titleBackgroundColor?: string;
  titleColor?: string;
  titleAlign?: TextAlign;
  titlePosition?: "l" | "c" | "r";
  titleFontWeight?: "normal" | "bold";
  titleFontFamily?: string;
  titleFontSizePx?: number;
  titleLineHeight?: string;
  bodyColor?: string;
  bodyAlign?: TextAlign;
  bodyFontFamily?: string;
  bodyFontSizePx?: number;
  bodyLineHeight?: string;
  cornerStyle?: "sharp" | "round";
  radiusPx?: number;
  paddingPx?: BoxSpacingPx;
  decorations?: BoxDecorationSpec[];
}

export interface BoxSpacingPx {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export type BoxDecorationSpec =
  | { type: "cornerSquares"; sizePx: number; color: string }
  | { type: "doubleRule"; offsetPx: number; widthPx?: number; color?: string }
  | {
      type: "titleDoubleRule";
      ruleWidthPx?: number;
      ruleColor?: string;
      guideColor?: string;
    }
  | {
      type: "titleBand";
      heightPx?: number;
      backgroundColor?: string;
      /** 帯と本文の境に引く罫。TeX の見出し付き枠が持つ「帯の下の 1 本」。 */
      ruleWidthPx?: number;
      ruleColor?: string;
    }
  /**
   * 枠の上辺に載せる見出しタブ (tcolorbox の `attach boxed title to top left` 相当)。
   * `titlePlate` と違って**地色で塗る**ので、タイトルの背景がそのまま見出しになる。
   */
  | {
      type: "titleTab";
      heightPx?: number;
      radiusPx?: number;
      offsetXPx?: number;
      paddingPx?: BoxSpacingPx;
      backgroundColor?: string;
    }
  | {
      type: "titlePlate";
      borderColor?: string;
      radiusPx?: number;
      paddingPx?: BoxSpacingPx;
    }
  | { type: "leftBar"; widthPx: number; color: string }
  | {
      type: "shadow";
      offsetXPx: number;
      offsetYPx: number;
      blurPx?: number;
      spreadPx?: number;
      color: string;
    }
  | { type: "horizontalRules"; widthPx?: number; color?: string }
  | {
      type: "notebookRules";
      baseBodyWidthPx?: number;
      frameLeftPx?: number;
      frameHeightPx?: number;
      frameStrokeOpacity?: number;
      lineColor?: string;
      lineGapPx?: number;
      lineWidthPx?: number;
      lineOffsetPx?: number;
      bindingColor?: string;
      bindingWidthPx?: number;
      bindingXPx?: number;
      bindingStrokeOpacity?: number;
      ringColor?: string;
      ringWidthPx?: number;
      ringHeightPx?: number;
      ringStrokePx?: number;
      ringGapPx?: number;
      ringTopPx?: number;
      ringCount?: number;
      ringLeftOverhangPx?: number;
      minHeightPx?: number;
    };

export interface AnswerDefinition {
  type: "math" | "text";
  expected: string;
}

/**
 * リスト項目の続きブロックが持つ文章。区切り線は持たないので空配列。
 *
 * 項目の中身を読む側 (検索・文字数・コピペ・AI 差分・行の計測) はこれを通す。`children` を
 * 直接触ると、区切り線を 1 つ足しただけで全経路が落ちる。
 */
export function listItemContinuationInlineNodes(block: ListItemContinuationNode): InlineNode[] {
  return block.type === "divider" ? [] : block.children;
}
