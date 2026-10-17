import { DEFAULT_BOXED_ROUNDNESS, normalizeBoxedRoundness } from "./boxed-roundness";
import type {
  BoxedVariant,
  HeadingNode,
  InlineNode,
  ListItemContinuationNode,
  ListNode,
  ParagraphNode,
  TextMark,
} from "./model";
import { overlayTextBlockInlineRuns } from "./overlay-inline-projection";
import type {
  OverlayTextBlock,
  OverlayTextSize,
} from "./overlay-model";

export type { OverlayTextSize } from "./overlay-model";

export type OverlayTextCommand =
  | "bold"
  | "italic"
  | "underline"
  | "boxed"
  | "boxedPaddingY"
  | "boxedVariant"
  | "boxedRoundness"
  | "color"
  | "backgroundColor"
  | "fontFamily"
  | "fontSize"
  | "lineHeight"
  | "textAlign";

/** The marks a toolbar button switches on and off over a whole shape. */
type OverlayTextToggleMark = "bold" | "italic" | "underline" | "boxed";

/**
 * What the toolbar shows while a whole text shape is selected (no text session open).
 *
 * The rule is the body editor's (`editor.isActive` over a selection): a mark is on only when every
 * run that can carry it carries it. Math carries the box and the underline but not bold or italic,
 * so it is left out of those two. The box's style is read off the first boxed run.
 */
export interface OverlayTextFormatState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  boxed: boolean;
  boxedPaddingY: number;
  boxedVariant: BoxedVariant;
  /** 角丸の丸め具合 (%)。先頭の囲みから読み、既定の丸みは 100。 */
  boxedRoundness: number;
}

export function getOverlayTextFormatState(blocks: readonly OverlayTextBlock[]): OverlayTextFormatState {
  const runs = blocks.flatMap((block) => overlayTextBlockInlineRuns(block));
  const firstBoxed = runs.find((run) => run.marks?.includes("boxed"));
  return {
    bold: everyRunHasMark(runs, "bold"),
    italic: everyRunHasMark(runs, "italic"),
    underline: everyRunHasMark(runs, "underline"),
    boxed: everyRunHasMark(runs, "boxed"),
    boxedPaddingY: normalizeNonnegativeNumber(firstBoxed?.boxedPaddingY) ?? 0,
    boxedVariant: normalizeBoxedVariant(firstBoxed?.boxedVariant) ?? "frame",
    boxedRoundness: normalizeBoxedRoundness(firstBoxed?.boxedRoundness) ?? DEFAULT_BOXED_ROUNDNESS,
  };
}

/**
 * Applies one toolbar command to every run of a shape.
 *
 * A toggle (bold, italic, underline, box) takes the whole shape one way: off when every run that
 * can carry the mark has it — exactly when the toolbar shows it on — and on everywhere otherwise.
 * Flipping each run by itself made a shape whose text and formula disagreed swap them instead.
 */
export function formatOverlayTextBlocks(
  blocks: readonly OverlayTextBlock[],
  command: OverlayTextCommand,
  value?: string,
): OverlayTextBlock[] {
  const toggle = isToggleCommand(command)
    ? { mark: command, remove: everyRunHasMark(blocks.flatMap((block) => overlayTextBlockInlineRuns(block)), command) }
    : undefined;
  return blocks.map((block) => formatBlock(block, command, value, toggle));
}

export function fontSizeToOverlaySize(fontSize: number): OverlayTextSize {
  if (fontSize <= 10) {
    return "s";
  }
  if (fontSize <= 13) {
    return "m";
  }
  if (fontSize <= 16) {
    return "l";
  }
  return "xl";
}

export function overlayTextSizeToPx(size: OverlayTextSize): number {
  if (size === "xs") {
    return 11;
  }
  if (size === "s") {
    return 13;
  }
  if (size === "l") {
    return 20;
  }
  if (size === "xl") {
    return 24;
  }
  return 16;
}

interface ResolvedToggle {
  mark: OverlayTextToggleMark;
  /** Decided once for the whole shape, before any run changes. */
  remove: boolean;
}

function formatBlock(
  block: OverlayTextBlock,
  command: OverlayTextCommand,
  value: string | undefined,
  toggle: ResolvedToggle | undefined,
): OverlayTextBlock {
  // A divider has no runs to style. A quote is styled through the blocks inside it, so selecting a
  // shape and pressing bold reaches the quoted words too — leaving them out would style everything
  // the reader can see except the part that is visibly quoted.
  if (block.type === "divider") {
    return block;
  }
  if (block.type === "quote") {
    return {
      ...block,
      blocks: block.blocks.map((child) => formatBlock(child as OverlayTextBlock, command, value, toggle) as typeof child),
    };
  }
  if (block.type === "codeBlock") {
    return { ...block, children: block.children.map((child) => formatInline(child, command, value, toggle)) };
  }
  return block.type === "list"
    ? formatListBlock(block, command, value, toggle)
    : formatProseBlock(block, command, value, toggle);
}

function formatListBlock(
  block: ListNode,
  command: OverlayTextCommand,
  value: string | undefined,
  toggle: ResolvedToggle | undefined,
): ListNode {
  return {
    ...block,
    items: block.items.map((item) => ({
      ...item,
      children: item.children.map((child) => formatInline(child, command, value, toggle)),
      ...(command === "textAlign" ? { align: normalizeTextAlign(value) } : {}),
      ...(item.continuations === undefined
        ? {}
        : {
            continuations: item.continuations.map((child) => (
              child.type === "divider" ? child : formatProseBlock(child, command, value, toggle)
            )),
          }),
      ...(item.nested === undefined
        ? {}
        : { nested: item.nested.map((child) => formatListBlock(child, command, value, toggle)) }),
    })),
  };
}

function formatProseBlock<T extends HeadingNode | ParagraphNode>(
  block: T,
  command: OverlayTextCommand,
  value: string | undefined,
  toggle: ResolvedToggle | undefined,
): T {
  const children = block.children.map((child) => formatInline(child, command, value, toggle));
  if (command === "lineHeight") {
    return { ...block, children, lineHeight: value };
  }
  if (command === "textAlign") {
    return { ...block, children, align: normalizeTextAlign(value) };
  }
  return { ...block, children };
}

function formatInline(
  node: InlineNode,
  command: OverlayTextCommand,
  value: string | undefined,
  toggle: ResolvedToggle | undefined,
): InlineNode {
  if (toggle) {
    return toggleRunMark(node, toggle);
  }
  if (command === "boxedPaddingY") {
    if (node.type === "mathInline") {
      return {
        ...node,
        marks: ensureMathBoxedMark(node.marks),
        boxedPaddingY: normalizeNonnegativeNumber(value) ?? 0,
      };
    }
    return {
      ...node,
      marks: ensureBoxedMark(node.marks),
      boxedPaddingY: normalizeNonnegativeNumber(value) ?? 0,
    };
  }
  if (command === "boxedVariant") {
    const variant = normalizeBoxedVariant(value);
    if (node.type === "mathInline") {
      return {
        ...node,
        marks: ensureMathBoxedMark(node.marks),
        ...(variant && variant !== "frame" ? { boxedVariant: variant } : { boxedVariant: undefined }),
      };
    }
    return {
      ...node,
      marks: ensureBoxedMark(node.marks),
      ...(variant && variant !== "frame" ? { boxedVariant: variant } : { boxedVariant: undefined }),
    };
  }
  if (command === "boxedRoundness") {
    // 既定の丸み (100%) は書かない。本文の囲み文字 (`setBoxedTextRoundness`) と同じ保存形。
    const roundness = normalizeBoxedRoundness(Number.parseFloat(String(value)));
    if (roundness === undefined) {
      return node;
    }
    const boxedRoundness = roundness === DEFAULT_BOXED_ROUNDNESS ? undefined : roundness;
    if (node.type === "mathInline") {
      return { ...node, marks: ensureMathBoxedMark(node.marks), boxedRoundness };
    }
    return { ...node, marks: ensureBoxedMark(node.marks), boxedRoundness };
  }
  if (command === "fontSize") {
    const fontSize = Number(value);
    return Number.isFinite(fontSize) && fontSize > 0 ? { ...node, fontSize } : node;
  }
  if (node.type === "mathInline") {
    return node;
  }
  if (command === "color" || command === "backgroundColor" || command === "fontFamily") {
    return { ...node, [command]: value || undefined };
  }
  return node;
}

function isToggleCommand(command: OverlayTextCommand): command is OverlayTextToggleMark {
  return command === "bold" || command === "italic" || command === "underline" || command === "boxed";
}

/** Math is drawn by the math renderer, which has no bold or italic of its own to switch. */
function runCanCarryMark(run: InlineNode, mark: OverlayTextToggleMark): boolean {
  return run.type === "text" || mark === "boxed" || mark === "underline";
}

/**
 * Whether every run that can carry `mark` carries it. A run that is only line breaks is not
 * counted: it shows no glyph to format, and a break at the start of a paragraph is saved as a run
 * of its own that never picked up the marks of the text after it.
 */
function everyRunHasMark(runs: readonly InlineNode[], mark: OverlayTextToggleMark): boolean {
  const counted = runs.filter((run) => (
    runCanCarryMark(run, mark) && (run.type !== "text" || run.text.replace(/\n/g, "").length > 0)
  ));
  return counted.length > 0 && counted.every((run) => (run.marks as readonly string[] | undefined)?.includes(mark));
}

function toggleRunMark(node: InlineNode, toggle: ResolvedToggle): InlineNode {
  if (!runCanCarryMark(node, toggle.mark)) {
    return node;
  }
  if (!toggle.remove) {
    return node.type === "mathInline"
      ? { ...node, marks: withMark(node.marks, toggle.mark as "underline" | "boxed") }
      : { ...node, marks: withMark(node.marks, toggle.mark) };
  }
  const next: InlineNode = node.type === "mathInline"
    ? { ...node, marks: withoutMark(node.marks, toggle.mark as "underline" | "boxed") }
    : { ...node, marks: withoutMark(node.marks, toggle.mark) };
  if (next.marks === undefined) {
    delete next.marks;
  }
  if (toggle.mark === "boxed") {
    // The box's style lives beside the mark; a run that is no longer boxed keeps none of it, the
    // same as the body editor, whose mark carries these as attributes and drops them with it.
    delete next.boxedPaddingY;
    delete next.boxedVariant;
    delete next.boxedTone;
    delete next.boxedRoundness;
  }
  return next;
}

function withMark<T extends string>(marks: readonly T[] | undefined, mark: T): T[] {
  return marks?.includes(mark) ? [...marks] : [...(marks ?? []), mark];
}

function withoutMark<T extends string>(marks: readonly T[] | undefined, mark: T): T[] | undefined {
  const next = (marks ?? []).filter((item) => item !== mark);
  return next.length ? next : undefined;
}

function ensureBoxedMark(marks: readonly TextMark[] | undefined): TextMark[] {
  return withMark(marks, "boxed");
}

function ensureMathBoxedMark(
  marks: readonly ("underline" | "boxed")[] | undefined,
): Array<"underline" | "boxed"> {
  return withMark(marks, "boxed");
}

function normalizeNonnegativeNumber(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

function normalizeBoxedVariant(value: unknown): BoxedVariant | undefined {
  return value === "frame" || value === "thick" || value === "double" || value === "oval" || value === "shade" || value === "compact"
    ? value
    : undefined;
}

function normalizeTextAlign(value: unknown): "left" | "center" | "right" | "justify" | undefined {
  return value === "left" || value === "center" || value === "right" || value === "justify"
    ? value
    : undefined;
}

/**
 * Lines a shape's blocks occupy: one per block (one per list *item*), plus one per hard break
 * inside it. Width-driven wrapping is not counted — this is the pure lower bound a shape can never
 * be shorter than, used while the measured height is missing or stale.
 *
 * This feature's copy. `features/rendering/core` has an identical one (drawing and rendering cannot
 * import this feature at runtime, only for types), and `overlay-text-line-count.test.ts` pins the
 * two against each other over a corpus — the count feeds the *stored* geometry of text shapes, so
 * a rule that drifted would move figures in saved documents.
 */
export function getOverlayTextBlocksLineCount(blocks: readonly OverlayTextBlock[]): number {
  const list = Array.isArray(blocks) ? blocks : [];
  if (list.length === 0) {
    return 1;
  }
  return Math.max(1, list.reduce((sum, block) => sum + getBlockLineCount(block), 0));
}

function getBlockLineCount(block: OverlayTextBlock | ListItemContinuationNode | undefined): number {
  if (!block) {
    return 0;
  }
  if (block.type === "divider") {
    return 1;
  }
  if (block.type === "list") {
    return (block.items ?? []).reduce((sum, item) => (
      sum +
      getInlineLineCount(item?.children ?? []) +
      (item?.continuations ?? []).reduce((inner, child) => inner + getBlockLineCount(child), 0) +
      (item?.nested ?? []).reduce((inner, nested) => inner + getBlockLineCount(nested), 0)
    ), 0);
  }
  if (block.type === "quote") {
    return (block.blocks ?? []).reduce((sum, child) => sum + getBlockLineCount(child), 0);
  }
  return getInlineLineCount(block.children ?? []);
}

function getInlineLineCount(content: readonly InlineNode[]): number {
  return 1 + content.reduce((sum, inline) => (
    inline?.type === "text" ? sum + Math.max(0, (inline.text ?? "").split("\n").length - 1) : sum
  ), 0);
}
