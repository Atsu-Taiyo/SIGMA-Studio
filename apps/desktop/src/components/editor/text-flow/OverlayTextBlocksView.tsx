"use client";

import type { CSSProperties } from "react";

import type { MathFractionSizing, OverlayTextBlock } from "@/features/document";

import {
  TextFlowStaticBlock,
  type TextFlowStaticBlockClassNames,
  type TextFlowStaticBlockStyles,
} from "./TextFlowStaticBlock";

/**
 * The typography `document-surface.css` gives a shape's blocks, as inline values.
 *
 * Only the SVG export needs these: its `<foreignObject>` is viewed without the stylesheet, so a UA
 * `p { margin: 1em 0 }` or `ul { padding-inline-start: 40px }` would reflow the box away from what
 * the app draws. `rich-text-self-contained.test.ts` holds these against the CSS rules they mirror —
 * change one and the other fails.
 */
export const OVERLAY_TEXT_BLOCK_SELF_CONTAINED_STYLES: TextFlowStaticBlockStyles = {
  heading: { margin: "0" },
  paragraph: { margin: "0" },
  list: { margin: "0", paddingInlineStart: "1.6em" },
  quote: {
    margin: "0",
    padding: "0 0 0 0.6em",
    borderLeft: "3px solid rgba(17, 17, 17, 0.28)",
    color: "rgba(17, 17, 17, 0.78)",
  },
  code: {
    margin: "0",
    padding: "0.3em 0.5em",
    border: "1px solid rgba(17, 17, 17, 0.09)",
    borderRadius: "6px",
    background: "#f7f8fa",
    color: "#24292f",
    fontFamily: '"SFMono-Regular", "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    whiteSpace: "pre-wrap",
    overflowWrap: "anywhere",
    fontSize: "0.92em",
    fontVariantLigatures: "none",
    lineHeight: 1.5,
    tabSize: 2,
  },
  divider: { margin: "0", border: "0", borderTop: "1px solid rgba(17, 17, 17, 0.24)" },
};

/**
 * What the dark theme changes about a code block, as inline values.
 *
 * The stylesheet says this in a second rule keyed on the theme attribute, which an inline style
 * beats — so a self-contained surface (print, the material thumbnail, the exported SVG) would draw
 * a dark block light while the canvas drew it dark. The inline styles have to carry the choice,
 * not just the default.
 */
const OVERLAY_TEXT_DARK_CODE_SELF_CONTAINED_STYLE: CSSProperties = {
  borderColor: "rgba(255, 255, 255, 0.16)",
  background: "#171717",
  color: "#f5f5f5",
};

/** The block's own self-contained typography: the shared map, plus whatever its theme changes. */
export function overlayTextBlockSelfContainedStyles(block: OverlayTextBlock): TextFlowStaticBlockStyles {
  if (block.type !== "codeBlock" || block.theme !== "dark") {
    return OVERLAY_TEXT_BLOCK_SELF_CONTAINED_STYLES;
  }
  return {
    ...OVERLAY_TEXT_BLOCK_SELF_CONTAINED_STYLES,
    code: {
      ...OVERLAY_TEXT_BLOCK_SELF_CONTAINED_STYLES.code,
      ...OVERLAY_TEXT_DARK_CODE_SELF_CONTAINED_STYLE,
    },
  };
}

/**
 * The class names the editing surface puts on these three blocks.
 *
 * The Tiptap extensions hard-code them in `renderHTML` (`body-block-extensions.ts`), so a focused
 * shape has them whatever the host does. The static view has to put the same ones on, or blurring
 * a shape would strip a quote's rule, a code block's syntax colours and its language badge — the
 * seam between the two projections that this whole renderer exists to close. Paragraphs, headings
 * and lists carry none on either side, so they stay unnamed here too.
 */
const OVERLAY_TEXT_BLOCK_CLASS_NAMES: TextFlowStaticBlockClassNames = {
  quote: "print-quote",
  code: "print-code",
  divider: "print-divider",
};

export interface OverlayTextBlocksViewProps {
  blocks: readonly OverlayTextBlock[];
  /**
   * The element to measure the drawn height on. It is the *content* box, never the wrapper the
   * caller sizes: the measured height is written back to the shape and lands on the wrapper's
   * `min-height`, so measuring the wrapper would feed the reading back into itself.
   */
  contentRef?: (element: HTMLDivElement | null) => void;
  mathFractionSizing?: MathFractionSizing | null;
  /** Inline the app's block typography. Set only by output that leaves the stylesheet behind. */
  selfContained?: boolean;
  /** Serialized markup needs the namespace on the outermost element; the mounted view does not. */
  xmlns?: string;
}

/**
 * A shape's text, drawn by the body's own static renderer.
 *
 * The shape used to have a renderer of its own that could only draw paragraphs and headings, which
 * is why a list inside a figure had nowhere to go. This is the same `TextFlowStaticBlock` the body,
 * the print surface and the embedded viewer use, with two things asked of it:
 *
 * - **no `data-sigma-doc-id`** — a figure's paragraphs are not body blocks, and that attribute is
 *   what the page surface selects on to find anchor candidates and pagination units;
 * - the shape's own typography, which stays tight (`line-height: 1`, no block margins) rather than
 *   the body's 1.78 line and paragraph spacing — a one-word label in a diagram is not a paragraph.
 *   The tight values live in `document-surface.css` under `.overlay-text-shape`, so the editing
 *   surface (ProseMirror, same class) and this renderer take them from one place.
 */
export function OverlayTextBlocksView({
  blocks,
  contentRef,
  mathFractionSizing,
  selfContained = false,
  xmlns,
}: OverlayTextBlocksViewProps) {
  return (
    <div
      ref={contentRef}
      className="overlay-text-shape-content"
      style={selfContained ? OVERLAY_TEXT_CONTENT_SELF_CONTAINED_STYLE : undefined}
      {...(xmlns ? ({ xmlns } as { xmlns: string }) : {})}
    >
      {blocks.map((block) => (
        <TextFlowStaticBlock
          key={block.id}
          block={block}
          classNames={OVERLAY_TEXT_BLOCK_CLASS_NAMES}
          defaultTextAlign={null}
          mathFractionSizing={mathFractionSizing}
          omitBlockIds
          selfContained={selfContained}
          styles={selfContained ? overlayTextBlockSelfContainedStyles(block) : undefined}
        />
      ))}
    </div>
  );
}

/**
 * The content box's own rules, inlined for the same reason as the block styles above. Width and
 * font size are not here: the caller sizes the box, because only it knows the shape's geometry.
 */
export const OVERLAY_TEXT_CONTENT_SELF_CONTAINED_STYLE: CSSProperties = {
  overflowWrap: "anywhere",
  whiteSpace: "pre-wrap",
};
