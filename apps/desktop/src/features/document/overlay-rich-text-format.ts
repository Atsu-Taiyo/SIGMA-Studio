import type {
  BoxedVariant,
  HeadingNode,
  InlineNode,
  ListItemContinuationNode,
  ListNode,
  ParagraphNode,
  TextMark,
} from "./model";
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
  | "color"
  | "backgroundColor"
  | "fontFamily"
  | "lineHeight"
  | "textAlign";

export function formatOverlayTextBlocks(
  blocks: readonly OverlayTextBlock[],
  command: OverlayTextCommand,
  value?: string,
): OverlayTextBlock[] {
  return blocks.map((block) => formatBlock(block, command, value));
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

function formatBlock(
  block: OverlayTextBlock,
  command: OverlayTextCommand,
  value?: string,
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
      blocks: block.blocks.map((child) => formatBlock(child as OverlayTextBlock, command, value) as typeof child),
    };
  }
  if (block.type === "codeBlock") {
    return { ...block, children: block.children.map((child) => formatInline(child, command, value)) };
  }
  return block.type === "list"
    ? formatListBlock(block, command, value)
    : formatProseBlock(block, command, value);
}

function formatListBlock(
  block: ListNode,
  command: OverlayTextCommand,
  value?: string,
): ListNode {
  return {
    ...block,
    items: block.items.map((item) => ({
      ...item,
      children: item.children.map((child) => formatInline(child, command, value)),
      ...(command === "textAlign" ? { align: normalizeTextAlign(value) } : {}),
      ...(item.continuations === undefined
        ? {}
        : {
            continuations: item.continuations.map((child) => (
              child.type === "divider" ? child : formatProseBlock(child, command, value)
            )),
          }),
      ...(item.nested === undefined
        ? {}
        : { nested: item.nested.map((child) => formatListBlock(child, command, value)) }),
    })),
  };
}

function formatProseBlock<T extends HeadingNode | ParagraphNode>(
  block: T,
  command: OverlayTextCommand,
  value?: string,
): T {
  const children = block.children.map((child) => formatInline(child, command, value));
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
  value?: string,
): InlineNode {
  if (command === "bold" || command === "italic" || command === "underline" || command === "boxed") {
    if (node.type === "mathInline" && command !== "boxed" && command !== "underline") {
      return node;
    }
    if (node.type === "mathInline") {
      return {
        ...node,
        marks: toggleMathMark(node.marks, command === "boxed" ? "boxed" : "underline"),
      };
    }
    return { ...node, marks: toggleMark(node.marks, command) };
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
  if (node.type === "mathInline") {
    return node;
  }
  if (command === "color" || command === "backgroundColor" || command === "fontFamily") {
    return { ...node, [command]: value || undefined };
  }
  return node;
}

function toggleMark(
  marks: readonly TextMark[] | undefined,
  mark: TextMark,
): TextMark[] | undefined {
  if (marks?.includes(mark)) {
    const next = marks.filter((item) => item !== mark);
    return next.length ? next : undefined;
  }
  return [...(marks ?? []), mark];
}

function ensureBoxedMark(marks: readonly TextMark[] | undefined): TextMark[] {
  return marks?.includes("boxed") ? [...marks] : [...(marks ?? []), "boxed"];
}

function toggleMathMark(
  marks: readonly ("underline" | "boxed")[] | undefined,
  mark: "underline" | "boxed",
): Array<"underline" | "boxed"> | undefined {
  if (marks?.includes(mark)) {
    const next = marks.filter((item) => item !== mark);
    return next.length ? next : undefined;
  }
  return [...(marks ?? []), mark];
}

function ensureMathBoxedMark(
  marks: readonly ("underline" | "boxed")[] | undefined,
): Array<"underline" | "boxed"> {
  return marks?.includes("boxed") ? [...marks] : [...(marks ?? []), "boxed"];
}

function normalizeNonnegativeNumber(value: unknown): number | undefined {
  const numeric = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(numeric) && numeric >= 0 ? numeric : undefined;
}

function normalizeBoxedVariant(value: unknown): BoxedVariant | undefined {
  return value === "frame" || value === "thick" || value === "double" || value === "oval" || value === "shade"
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
