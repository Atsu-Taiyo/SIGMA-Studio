import type { Editor as TiptapEditor } from "@tiptap/core";
import type { EditorState } from "@tiptap/pm/state";

import {
  type BoxedVariant,
  normalizeLineHeight,
  normalizeOrderedListMarkerStyle,
  type OrderedListMarkerStyle,
} from "@/features/document";
import { normalizeCodeLanguage } from "@/features/rendering/adapters";
import { resolveEffectiveFontFamily } from "@/features/text-editing";
import { boxFrameAppliesFontFamily } from "@/lib/box-blocks";

export interface TextFormatSelectionRange {
  from: number;
  to: number;
}

export interface TextFormatCommandRequest {
  command: string;
  value?: unknown;
}

export interface TextFormatCommandOptions {
  selection: TextFormatSelectionRange | null;
  blockNodeType: "paragraph" | "heading";
  allowBlockStyle?: boolean;
  preserveSelectionForBlockAttributes?: boolean;
  /**
   * 適用前にエディタへ焦点を当てるか (既定 true)。跨ぎ選択 (text-run-span) は複数エディタへ
   * 順に適用するため、focus() で焦点とスクロールが最後のエディタへ飛ばないよう false を渡す。
   */
  focusEditor?: boolean;
}

export type TextFormatTargetNodeType = "paragraph" | "heading" | "boxBlockTitle" | "codeBlock";

/** 文字 run を持ち、本文ツールバーの共通装飾を受けられるブロック内ノード。 */
export function isTextFormatTargetNodeType(value: unknown): value is TextFormatTargetNodeType {
  return value === "paragraph"
    || value === "heading"
    || value === "boxBlockTitle"
    || value === "codeBlock";
}

export interface TextFormatStateContext {
  enabled: boolean;
  nodeType: TextFormatTargetNodeType | null;
  blockId: string | null;
}

export interface TextFormatStateDetail {
  target: string;
  enabled: boolean;
  nodeType: TextFormatTargetNodeType | null;
  blockId: string | null;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  boxed: boolean;
  boxedPaddingY: number;
  boxedVariant: BoxedVariant;
  color: string | null;
  backgroundColor: string | null;
  /**
   * The font this position is actually drawn with (mark → frame → document default), not the last
   * font picked from the dropdown. `null` when the selection is mixed, and when the caller supplied
   * no editor state — read `fontFamilyMixed` to tell those apart.
   */
  fontFamily: string | null;
  /** The selection spans more than one effective font, so the toolbar shows nothing. */
  fontFamilyMixed: boolean;
  fontSize: number | null;
  lineHeight: string | null;
  /** キャレットが引用ブロックの中にいるか。 */
  inQuoteBlock: boolean;
  /** 区切り線そのものを選んでいるか（ボタンを押すと外せる状態）。 */
  onDivider: boolean;
  /** コードブロックの言語。自動判定のときは `null`。 */
  codeLanguage: string | null;
  /** キャレットがコードブロックの中にいるか。 */
  inCodeBlock: boolean;
  /** キャレットが入っているリストの種類。リストの外では `null`。 */
  listType: "bullet" | "ordered" | null;
  /** 番号付きリストのマーカー形式。番号付きの外では `null`、未指定は `"decimal"` 扱い。 */
  orderedMarkerStyle: OrderedListMarkerStyle | null;
}

export interface TextFormatFontContext {
  /** Editor state to read the runs and the enclosing frame from. */
  state?: EditorState;
  /** Default font of the surface: the body default for the document, its own for shape text. */
  documentFontFamily?: string;
}

type TextFormatChain = ReturnType<TiptapEditor["chain"]>;

/**
 * Toggles that must follow the caret instead of the block it sits in: with nothing
 * selected they arm the caret (storedMarks) so only what the user types next picks the
 * format up, the way Word/Docs behave. Paragraph commands remain block-scoped,
 * while every inline mark applies only to text typed from the caret onward.
 */
const CARET_SCOPED_TEXT_FORMAT_COMMANDS = new Set([
  "bold",
  "italic",
  "underline",
  "boxed",
  "boxedPaddingY",
  "boxedVariant",
  "color",
  "backgroundColor",
  "fontFamily",
  "fontSize",
]);

export function isCaretScopedTextFormatCommand(command: unknown): boolean {
  return typeof command === "string" && CARET_SCOPED_TEXT_FORMAT_COMMANDS.has(command);
}

export function applyTextFormatCommand(
  editor: TiptapEditor,
  request: TextFormatCommandRequest,
  options: TextFormatCommandOptions,
): boolean {
  const runSelected = (apply: (chain: TextFormatChain) => TextFormatChain) => {
    runTextFormatChain(editor, options.selection, apply, options.focusEditor !== false);
  };
  /** ブロックの入れ物を作り替えるコマンド。位置が動くので選択の復元はしない。 */
  const runStructural = (apply: (chain: TextFormatChain) => TextFormatChain) => {
    runTextFormatChain(editor, options.selection, apply, options.focusEditor !== false, false);
  };

  if (request.command === "bold") {
    runSelected((chain) => chain.toggleBold());
    return true;
  }
  if (request.command === "italic") {
    runSelected((chain) => chain.toggleItalic());
    return true;
  }
  if (request.command === "underline") {
    runSelected((chain) => chain.toggleUnderline());
    return true;
  }
  if (request.command === "boxed") {
    runSelected((chain) => chain.toggleBoxedText());
    return true;
  }
  if (request.command === "boxedPaddingY" && typeof request.value === "string") {
    const paddingY = normalizeTextFormatNonnegativeNumber(request.value);
    if (paddingY === undefined) {
      return false;
    }
    runSelected((chain) => chain.setBoxedTextPaddingY(paddingY));
    return true;
  }
  if (request.command === "boxedVariant") {
    const variant = normalizeTextFormatBoxedVariant(request.value);
    if (!variant) {
      return false;
    }
    runSelected((chain) => chain.setBoxedTextVariant(variant));
    return true;
  }
  if (request.command === "blockStyle" && options.allowBlockStyle && typeof request.value === "string") {
    if (request.value === "paragraph") {
      // 「本文」は見出し・リスト・コードのどれから来ても素の段落へ戻す。引用は入れ物なので
      // ここでは外さない (引用の中の見出しを本文にしたいだけ、という操作を殺さないため)。
      runStructural((chain) => chain.liftListItem("listItem").setParagraph());
      return true;
    }
    if (request.value === "h1" || request.value === "h2" || request.value === "h3") {
      const level = Number(request.value.slice(1)) as 1 | 2 | 3;
      runStructural((chain) => chain.setHeading({ level }));
      return true;
    }
    if (request.value === "quote") {
      runStructural((chain) => chain.toggleQuoteBlock());
      return true;
    }
    if (request.value === "code") {
      runStructural((chain) => chain.toggleCodeBlock());
      return true;
    }
    if (request.value === "bulletList") {
      runStructural((chain) => chain.toggleBulletList());
      return true;
    }
    // 番号付きは「番号付きにする」と「マーカー形式を選ぶ」が 1 つの操作。すでにその形式の
    // 番号付きなら解除する (ツールバーのトグル)。
    if (request.value === "orderedList" || request.value === "orderedListParen") {
      const markerStyle: OrderedListMarkerStyle = request.value === "orderedListParen" ? "paren" : "decimal";
      const active = editor.isActive("orderedList")
        && (normalizeOrderedListMarkerStyle(editor.getAttributes("orderedList").markerStyle) ?? "decimal") === markerStyle;
      if (active) {
        runStructural((chain) => chain.toggleOrderedList());
        return true;
      }
      runStructural((chain) => (editor.isActive("orderedList") ? chain : chain.toggleOrderedList())
        .updateAttributes("orderedList", { markerStyle: markerStyle === "paren" ? "paren" : null }));
      return true;
    }
    if (request.value === "divider") {
      runStructural((chain) => chain.toggleDivider());
      return true;
    }
    return false;
  }
  if (request.command === "color" && typeof request.value === "string") {
    runSelected((chain) => chain.setTextColor(request.value as string));
    return true;
  }
  if (request.command === "backgroundColor" && typeof request.value === "string") {
    if (request.value) {
      runSelected((chain) => chain.setTextBackgroundColor(request.value as string));
    } else {
      runSelected((chain) => chain.unsetTextBackgroundColor());
    }
    return true;
  }
  if (request.command === "fontFamily" && typeof request.value === "string") {
    if (request.value) {
      runSelected((chain) => chain.setFontFamily(request.value as string));
    } else {
      runSelected((chain) => chain.unsetFontFamily());
    }
    return true;
  }
  if (request.command === "fontSize" && typeof request.value === "string") {
    if (request.value === "") {
      // 「自動」: run 自身の指定を外し、見出しレベルや文書既定の大きさへ戻す。
      // インラインの font-size は見出しの CSS に必ず勝つので、外す手立てが要る。
      runSelected((chain) => chain.unsetFontSize());
      return true;
    }
    const fontSize = normalizeTextFormatFontSize(request.value);
    if (!fontSize) {
      return false;
    }
    runSelected((chain) => chain.setFontSize(fontSize));
    return true;
  }
  if (request.command === "codeLanguage") {
    runSelected((chain) => chain.setCodeBlockLanguage(
      typeof request.value === "string" && request.value ? request.value : null,
    ));
    return true;
  }
  if (request.command === "lineHeight" && typeof request.value === "string") {
    const lineHeight = normalizeLineHeight(request.value);
    if (!lineHeight) {
      return false;
    }
    runBlockAttributeCommand(editor, options, { lineHeight });
    return true;
  }
  if (request.command === "textAlign") {
    const textAlign = normalizeTextFormatAlign(request.value);
    if (!textAlign) {
      return false;
    }
    runBlockAttributeCommand(editor, options, { textAlign });
    return true;
  }

  return false;
}

/**
 * The font mark on every run the selection touches, `null` where a run carries none.
 *
 * A collapsed caret yields exactly one entry, taken from `storedMarks` first so the toolbar shows
 * the font the *next* keystroke will use (the same order `isActive()` uses). A non-empty selection
 * walks only `nodesBetween(from, to)` — never the whole document, which would put an O(doc) scan on
 * every transaction.
 */
const MAX_DISTINCT_SELECTION_FONTS = 3;

export function collectSelectionFontFamilies(state: EditorState): (string | null)[] {
  const markType = state.schema.marks.styledText;
  if (!markType) {
    return [];
  }

  const { from, to, empty, $head } = state.selection;
  if (empty) {
    const marks = state.storedMarks ?? $head.marks();
    const fontFamily = marks.find((mark) => mark.type === markType)?.attrs.fontFamily;
    return [typeof fontFamily === "string" ? fontFamily : null];
  }

  // Only the *distinct* values matter to the caller, and three of them already force a "mixed"
  // answer no matter what the rest of the range holds — so a long selection stops early instead of
  // walking to the end on every transaction it is held for.
  const distinct = new Set<string | null>();
  state.doc.nodesBetween(from, to, (node) => {
    if (distinct.size >= MAX_DISTINCT_SELECTION_FONTS) {
      return false;
    }
    if (!node.isText && !node.isAtom) {
      return true;
    }
    const fontFamily = node.marks.find((mark) => mark.type === markType)?.attrs.fontFamily;
    distinct.add(typeof fontFamily === "string" ? fontFamily : null);
    return false;
  });
  return [...distinct];
}

/** The enclosing frame's fonts, and whether the caret is in its title rather than its body. */
export function resolveBoxFontContext(state: EditorState): {
  bodyFontFamily?: string;
  titleFontFamily?: string;
  inBoxTitle: boolean;
} {
  const { $from } = state.selection;
  let inBoxTitle = false;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === "boxBlockTitle") {
      inBoxTitle = true;
    }
    if (node.type.name === "boxBlock") {
      const frame = node.attrs.frame;
      if (!isRecord(frame)) {
        return { inBoxTitle };
      }
      // Some frames declare `font-family: inherit` on their title and body, which beats the custom
      // properties the frame spec sets. Reporting the stored font there would be the very "toolbar
      // shows what is not drawn" bug this resolution exists to remove.
      const styleId = typeof node.attrs.styleId === "string" ? node.attrs.styleId : undefined;
      const decorations = Array.isArray(frame.decorations) ? frame.decorations : undefined;
      if (!boxFrameAppliesFontFamily(styleId, { decorations } as Parameters<typeof boxFrameAppliesFontFamily>[1])) {
        return { inBoxTitle };
      }

      const bodyFontFamily = typeof frame.bodyFontFamily === "string" ? frame.bodyFontFamily : undefined;
      const titleFontFamily = typeof frame.titleFontFamily === "string" ? frame.titleFontFamily : undefined;
      return { bodyFontFamily, titleFontFamily, inBoxTitle };
    }
  }
  return { inBoxTitle };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function createTextFormatStateDetail(
  editor: Pick<TiptapEditor, "getAttributes" | "isActive">,
  target = "document",
  context?: TextFormatStateContext,
  fontContext?: TextFormatFontContext,
): TextFormatStateDetail {
  const boxedAttrs = editor.getAttributes("boxed");
  const styledTextAttrs = editor.getAttributes("styledText");
  const activeBlockNodeType = editor.isActive("heading")
    ? "heading"
    : editor.isActive("codeBlock")
      ? "codeBlock"
      : "paragraph";
  const blockAttrs = editor.getAttributes(activeBlockNodeType);
  const nodeType = editor.isActive("heading")
    ? "heading"
    : editor.isActive("codeBlock")
      ? "codeBlock"
      : editor.isActive("paragraph")
        ? "paragraph"
        : null;
  const resolvedContext = context ?? {
    enabled: nodeType !== null,
    nodeType,
    blockId: null,
  };

  const effectiveFont = resolveEffectiveFont(fontContext);

  const orderedListActive = editor.isActive("orderedList");
  return {
    target,
    ...resolvedContext,
    inQuoteBlock: editor.isActive("quote"),
    inCodeBlock: editor.isActive("codeBlock"),
    onDivider: editor.isActive("divider"),
    codeLanguage: normalizeCodeLanguage(editor.getAttributes("codeBlock").language) ?? null,
    listType: editor.isActive("bulletList")
      ? "bullet"
      : orderedListActive
        ? "ordered"
        : null,
    orderedMarkerStyle: orderedListActive
      ? normalizeOrderedListMarkerStyle(editor.getAttributes("orderedList").markerStyle) ?? "decimal"
      : null,
    // isActive() reads storedMarks first and falls back to the marks at the
    // cursor, so these stay true for a collapsed caret sitting inside a run.
    bold: editor.isActive("bold"),
    italic: editor.isActive("italic"),
    underline: editor.isActive("underline"),
    boxed: editor.isActive("boxed"),
    boxedPaddingY: normalizeTextFormatNonnegativeNumber(boxedAttrs.paddingY) ?? 0,
    boxedVariant: normalizeTextFormatBoxedVariant(boxedAttrs.variant) ?? "frame",
    color: normalizeTextFormatCssValue(styledTextAttrs.color),
    backgroundColor: normalizeTextFormatCssValue(styledTextAttrs.backgroundColor),
    fontFamily: effectiveFont
      ? (effectiveFont.kind === "mixed" ? null : effectiveFont.fontFamily)
      : normalizeTextFormatCssValue(styledTextAttrs.fontFamily),
    fontFamilyMixed: effectiveFont?.kind === "mixed",
    fontSize: normalizeTextFormatFontSize(styledTextAttrs.fontSize) ?? null,
    lineHeight: normalizeLineHeight(blockAttrs.lineHeight) ?? null,
  };
}

/** `undefined` when the caller supplied no state — the pre-existing attribute read then stands. */
function resolveEffectiveFont(fontContext: TextFormatFontContext | undefined) {
  const state = fontContext?.state;
  const documentFontFamily = fontContext?.documentFontFamily;
  if (!state || !documentFontFamily) {
    return undefined;
  }

  const boxContext = resolveBoxFontContext(state);
  return resolveEffectiveFontFamily({
    markFontFamilies: collectSelectionFontFamilies(state),
    boxBodyFontFamily: boxContext.bodyFontFamily,
    boxTitleFontFamily: boxContext.titleFontFamily,
    inBoxTitle: boxContext.inBoxTitle,
    documentFontFamily,
  });
}

function normalizeTextFormatCssValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * `overrides` は焦点エディタ単体では決められない状態の上書き (跨ぎ選択のトグル系マークを
 * span 全体で判定した値など)。渡された項目だけが detail を上書きする。
 */
export function dispatchTextFormatState(
  editor: Pick<TiptapEditor, "getAttributes" | "isActive">,
  eventName: string,
  target = "document",
  context?: TextFormatStateContext,
  fontContext?: TextFormatFontContext,
  overrides?: Partial<TextFormatStateDetail>,
): void {
  window.dispatchEvent(new CustomEvent(eventName, {
    detail: {
      ...createTextFormatStateDetail(editor, target, context, fontContext),
      ...overrides,
    },
  }));
}

export function isValidTextFormatSelection(
  selection: TextFormatSelectionRange,
  docSize: number,
): boolean {
  return selection.from < selection.to &&
    selection.from >= 0 &&
    selection.to <= docSize;
}

export function normalizeTextFormatAlign(
  value: unknown,
): "left" | "center" | "right" | "justify" | undefined {
  return value === "left" ||
    value === "center" ||
    value === "right" ||
    value === "justify"
    ? value
    : undefined;
}

export function normalizeTextFormatFontSize(value: unknown): number | undefined {
  const fontSize = typeof value === "number"
    ? value
    : Number.parseFloat(String(value));
  return Number.isFinite(fontSize) && fontSize > 0
    ? fontSize
    : undefined;
}

export function normalizeTextFormatNonnegativeNumber(value: unknown): number | undefined {
  const number = typeof value === "number"
    ? value
    : Number.parseFloat(String(value));
  return Number.isFinite(number) && number >= 0
    ? number
    : undefined;
}

export function normalizeTextFormatBoxedVariant(value: unknown): BoxedVariant | undefined {
  return value === "frame" ||
    value === "thick" ||
    value === "double" ||
    value === "oval" ||
    value === "shade"
    ? value
    : undefined;
}

function runBlockAttributeCommand(
  editor: TiptapEditor,
  options: TextFormatCommandOptions,
  attributes: Record<string, unknown>,
): void {
  const focusEditor = options.focusEditor !== false;
  const apply = (chain: TextFormatChain) => (
    chain.updateAttributes(options.blockNodeType, attributes)
  );
  if (options.preserveSelectionForBlockAttributes) {
    runTextFormatChain(editor, options.selection, apply, focusEditor);
    return;
  }
  apply(focusEditor ? editor.chain().focus() : editor.chain()).run();
}

/**
 * @param restoreSelection コマンドの後に元の範囲を選び直すか。
 *
 * 既定は true で、文字書式 (太字・色・フォント) はこれが要る — マークを付けても位置は
 * 動かないので、同じ範囲を選び直せば選択が保たれる。
 *
 * **入れ物を作る/外すコマンドでは false にすること。** `wrapIn` は後続の位置を +1 ずらすので、
 * 変更前の数値をそのまま選び直すとキャレットが新しい入れ物の**外**に落ちる。実機では
 * 「引用ボタンを押した直後に打った文字が引用の中に入らない」という形で出た。
 */
function runTextFormatChain(
  editor: TiptapEditor,
  selection: TextFormatSelectionRange | null,
  apply: (chain: TextFormatChain) => TextFormatChain,
  focusEditor: boolean,
  restoreSelection = true,
): void {
  let chain = focusEditor ? editor.chain().focus() : editor.chain();
  if (selection) {
    chain = chain.setTextSelection(selection);
  }
  chain = apply(chain);
  if (selection && restoreSelection) {
    chain = chain.setTextSelection(selection);
  }
  chain.run();
}
