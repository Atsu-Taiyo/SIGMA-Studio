import {
  DEFAULT_FONT_FAMILY_VALUE,
  FONT_FAMILY_OPTIONS,
  MAX_BOXED_TEXT_PADDING_Y,
  MIN_BOXED_TEXT_PADDING_Y,
} from "@/components/editor/editor-shell/constants";
import {
  normalizeOrderedListMarkerStyle,
  type BoxedVariant,
  type OrderedListMarkerStyle,
} from "@/features/document";
import { normalizeCodeLanguage } from "@/features/rendering/adapters";

export function normalizeToolbarFontFamily(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value : DEFAULT_FONT_FAMILY_VALUE;
}

export function getFontFamilyLabel(
  value: string,
  customOptions: Array<{ label: string; value: string }> = [],
): string {
  const option = [...FONT_FAMILY_OPTIONS, ...customOptions].find((item) => item.value === value);
  return option?.label ?? getPrimaryFontFamilyName(value);
}

function getPrimaryFontFamilyName(value: string): string {
  const families = splitFontFamilyList(value);
  return families.find((family) => !isGenericFontFamilyName(family)) ?? families[0] ?? value;
}

function splitFontFamilyList(value: string): string[] {
  const families: string[] = [];
  let current = "";
  let quote: "\"" | "'" | null = null;

  for (const char of value) {
    if ((char === "\"" || char === "'") && quote === null) {
      quote = char;
      continue;
    }
    if (char === quote) {
      quote = null;
      continue;
    }
    if (char === "," && quote === null) {
      const family = current.trim();
      if (family) {
        families.push(family);
      }
      current = "";
      continue;
    }
    current += char;
  }

  const family = current.trim();
  if (family) {
    families.push(family);
  }
  return families;
}

function isGenericFontFamilyName(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "serif" ||
    normalized === "sans-serif" ||
    normalized === "monospace" ||
    normalized === "cursive" ||
    normalized === "fantasy" ||
    normalized === "system-ui" ||
    normalized === "ui-sans-serif" ||
    normalized === "ui-serif" ||
    normalized === "-apple-system" ||
    normalized === "blinkmacsystemfont";
}

export function clampBoxedTextPaddingY(value: number): number {
  if (!Number.isFinite(value)) {
    return MIN_BOXED_TEXT_PADDING_Y;
  }

  return Math.min(MAX_BOXED_TEXT_PADDING_Y, Math.max(MIN_BOXED_TEXT_PADDING_Y, Math.round(value)));
}

export function normalizeBoxedTextVariant(value: unknown): BoxedVariant | undefined {
  return value === "frame" || value === "thick" || value === "double" || value === "oval" || value === "shade"
    ? value
    : undefined;
}

/**
 * ブロック種別トグル (箇条書き / 番号付き / 引用 / コード / 区切り線) のツールバー状態。
 *
 * B/I/U と同じで、キャレットの居場所を写した派生値であって文書の一部ではない。
 * オブジェクトを毎回作り直すと `useState` の bail-out が効かず、打鍵のたびにクロームが
 * 再レンダーされるので、`nextBlockStyleToolbarState` は変化が無ければ元の参照を返す。
 */
export interface BlockStyleToolbarState {
  listType: "bullet" | "ordered" | null;
  orderedMarkerStyle: OrderedListMarkerStyle | null;
  inQuoteBlock: boolean;
  inCodeBlock: boolean;
  onDivider: boolean;
  /** コードブロックの言語。自動判定のときは `null`。 */
  codeLanguage: string | null;
}

export const EMPTY_BLOCK_STYLE_TOOLBAR_STATE: BlockStyleToolbarState = {
  listType: null,
  orderedMarkerStyle: null,
  inQuoteBlock: false,
  inCodeBlock: false,
  onDivider: false,
  codeLanguage: null,
};

export function nextBlockStyleToolbarState(
  current: BlockStyleToolbarState,
  detail: {
    listType?: unknown;
    orderedMarkerStyle?: unknown;
    inQuoteBlock?: unknown;
    inCodeBlock?: unknown;
    onDivider?: unknown;
    codeLanguage?: unknown;
  },
): BlockStyleToolbarState {
  const next: BlockStyleToolbarState = {
    listType: detail.listType === "bullet" || detail.listType === "ordered" ? detail.listType : null,
    orderedMarkerStyle: normalizeOrderedListMarkerStyle(detail.orderedMarkerStyle) ?? null,
    inQuoteBlock: detail.inQuoteBlock === true,
    inCodeBlock: detail.inCodeBlock === true,
    onDivider: detail.onDivider === true,
    codeLanguage: normalizeCodeLanguage(detail.codeLanguage) ?? null,
  };
  return current.listType === next.listType
    && current.orderedMarkerStyle === next.orderedMarkerStyle
    && current.inQuoteBlock === next.inQuoteBlock
    && current.inCodeBlock === next.inCodeBlock
    && current.onDivider === next.onDivider
    && current.codeLanguage === next.codeLanguage
    ? current
    : next;
}

/**
 * ツールバーのブロックボタンが送る `blockStyle` の値。段落スタイルのドロップダウンと
 * 同じコマンドに乗せてあるので、適用経路 (`applyTextFormatCommand`) は 1 つで済む。
 */
export type BlockStyleCommandValue =
  | "paragraph"
  | "h1"
  | "h2"
  | "h3"
  | "bulletList"
  | "orderedList"
  | "orderedListParen"
  | "quote"
  | "code"
  | "divider";

/** ツールバーのブロックボタンが送る値。段落スタイル (見出し・本文) はここに含めない。 */
export type BlockStructureCommandValue = Extract<
  BlockStyleCommandValue,
  "bulletList" | "orderedList" | "orderedListParen" | "quote" | "code" | "divider"
>;
