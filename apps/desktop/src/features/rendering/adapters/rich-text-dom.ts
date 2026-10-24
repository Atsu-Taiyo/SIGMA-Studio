import type { InlineNode, UnderlineStyle } from "@/features/document";
import {
  inlineMathNodeClassName,
  inlineMathNodeDataAttributes,
} from "./inline-math-frame";
import {
  createInlineNodesRenderModel,
  type BoxedInlineRunSegment,
  type RichTextBoxDecoration,
  type RichTextInlineRenderNode,
  type RichTextRenderDecoration,
  type RichTextRenderStyle,
} from "@/features/rendering/core";

import {
  boxedInlineDomSpec,
  boxedRunDomAttrs,
  inlineTextStyleDeclarations,
} from "./boxed-inline-dom";

import { INHERITED_TEXT_FONT_ATTRIBUTE } from "./text-block-typography-dom";

/**
 * The single DOM projection of the rich-text render model.
 *
 * Overlay rich text is drawn twice: React mounts it in the editor/PDF surface, and a string
 * serializer embeds it in the exported SVG's `<foreignObject>`. Those used to be two hand-written
 * implementations of the same model and had drifted apart (heading levels, `\n`, blank blocks,
 * boxed metadata, underline runs). Both now walk the descriptors this module builds, so the DOM is
 * shared by construction rather than by convention — see `rich-text-parity.test.tsx`.
 *
 * `style` is what both surfaces emit. `selfContainedStyle` is the extra inline styling a surface
 * needs when no stylesheet is available (the exported SVG is viewed standalone); it repeats what
 * the classes in `document-surface.css` would have supplied. Only the SVG projection opts in, so
 * the app keeps getting its styling from CSS — inlining it there would beat the boxed variant/tone
 * custom properties and the boxed-run height targets.
 */

export type RichTextDomStyle = Record<string, string>;

/** The one class name a continuous underline run is drawn with, in both projections. */
export const UNDERLINE_RUN_CLASS_NAME = "sigma-underline-run";

export interface RichTextDomElement {
  attrs?: Record<string, string>;
  children: RichTextDomNode[];
  className?: string;
  key: string;
  kind: "element";
  selfContainedStyle?: RichTextDomStyle;
  style?: RichTextDomStyle;
  tag: string;
}

export type RichTextDomNode =
  | RichTextDomElement
  | { key: string; kind: "lineBreak" }
  | { key: string; kind: "mathBody"; tex: string; compact?: boolean }
  | { key: string; kind: "text"; text: string };

export interface InlineRichTextDomOptions {
  /** Preserve unformatted runs when the containing block derives its baseline from smaller runs. */
  preserveInheritedFontSize?: boolean;
  /** Runtime boxed-run measurements, keyed by segment id. React only; absent in static output. */
  alignmentStyles?: Record<string, RichTextDomStyle>;
  keyPrefix: string;
  resolveText?: (text: string) => string;
}

const IDENTITY_TEXT: (text: string) => string = (text) => text;

/**
 * Block reset for stylesheet-less output. Mirrors `globals.css`'s
 * `.overlay-text-shape .ProseMirror p { margin: 0 }` — headings have no such app rule, so the
 * zero margin is a deliberate divergence there (registered in `rich-text-self-contained.test.ts`)
 * rather than an oversight: it is what the SVG has always drawn.
 */
export const OVERLAY_BLOCK_SELF_CONTAINED_STYLE: RichTextDomStyle = { margin: "0" };

/** Mirrors `globals.css`'s `.overlay-text-shape .inline-math-node { margin: 0 }`. */
export const MATH_FRAME_SELF_CONTAINED_STYLE: RichTextDomStyle = { margin: "0" };

export function buildInlineRichTextDom(
  children: readonly InlineNode[],
  options: InlineRichTextDomOptions,
): RichTextDomNode[] {
  return buildInlineRenderModelDom(
    createInlineNodesRenderModel(children, {
      annotateBoxedRuns: true,
      runIdPrefix: options.keyPrefix,
    }).children,
    options,
  );
}

/**
 * One item of the flattened inline sequence.
 *
 * A `\n` inside a text node is a hard break, and ProseMirror stores it as a mark-less `hardBreak`
 * node between two text nodes — so the mark spans close at the break and reopen after it. The same
 * flattening happens here, which is why a text entry can contribute several `piece`s.
 */
type InlinePiece =
  | {
      entry: RichTextInlineRenderNode;
      /** The piece's own share of the entry's boxed run, when the entry carries one. */
      boxedRun?: BoxedInlineRunSegment;
      key: string;
      kind: "piece";
      text?: string;
    }
  | { key: string; kind: "break" };

export function buildInlineRenderModelDom(
  entries: RichTextInlineRenderNode[],
  options: InlineRichTextDomOptions,
): RichTextDomNode[] {
  const nodes: RichTextDomNode[] = [];
  let underlineRun: Array<Extract<InlinePiece, { kind: "piece" }>> = [];

  const flushUnderlineRun = () => {
    if (underlineRun.length === 0) {
      return;
    }

    const first = underlineRun[0];
    const last = underlineRun[underlineRun.length - 1];
    const style = findDecoration(first.entry.decorations, "underline")?.style;
    const containsMath = underlineRun.some((piece) => piece.entry.kind === "math");
    // A run with math draws one border under everything, boxes included; a text-only run's
    // decoration stops at each boxed segment, which then draws the underline itself.
    const boxedUnderline = containsMath ? undefined : style ?? "solid";
    const members = underlineRun.map((piece) => buildInlinePieceDom(piece, options, boxedUnderline));
    nodes.push({
      kind: "element",
      tag: "span",
      className: UNDERLINE_RUN_CLASS_NAME,
      key: `${options.keyPrefix}-underline-run-${first.key}-${last.key}`,
      attrs: underlineDomAttrs(style),
      selfContainedStyle: underlineRunStyle(containsMath, style),
      children: style === "wavy"
        ? [
          { kind: "element", tag: "span", key: `${first.key}-wave-content`, children: members },
          { kind: "element", tag: "span", key: `${first.key}-wave-stroke`, className: UNDERLINE_WAVE_CLASS_NAME, attrs: { "aria-hidden": "true" },
            selfContainedStyle: underlineWaveStrokeStyle(containsMath), children: [] },
        ]
        : members,
    });
    underlineRun = [];
  };

  for (const piece of flattenInlinePieces(entries, options)) {
    if (piece.kind === "piece" && hasDecoration(piece.entry.decorations, "underline")) {
      const previous = underlineRun[underlineRun.length - 1];
      if (previous && (findDecoration(previous.entry.decorations, "underline")?.style ?? "solid")
        !== (findDecoration(piece.entry.decorations, "underline")?.style ?? "solid")) {
        flushUnderlineRun();
      }
      underlineRun.push(piece);
      continue;
    }

    flushUnderlineRun();
    if (piece.kind === "break") {
      nodes.push({ kind: "lineBreak", key: piece.key });
      continue;
    }
    nodes.push(buildInlinePieceDom(piece, options));
  }

  flushUnderlineRun();
  return nodes;
}

function flattenInlinePieces(
  entries: RichTextInlineRenderNode[],
  options: InlineRichTextDomOptions,
): InlinePiece[] {
  const resolveText = options.resolveText ?? IDENTITY_TEXT;
  const pieces: InlinePiece[] = [];
  entries.forEach((entry, entryIndex) => {
    const index = entry.sourceIndex ?? entryIndex;
    if (entry.kind !== "text") {
      pieces.push({ entry, key: `${index}-${entry.id}`, kind: "piece" });
      return;
    }

    const segments = resolveText(entry.text).split("\n");
    const boxedRun = findDecoration(entry.decorations, "box")?.run;
    segments.forEach((segment, segmentIndex) => {
      if (segmentIndex > 0) {
        pieces.push({ key: `${options.keyPrefix}-${index}-br-${segmentIndex}`, kind: "break" });
      }
      if (segment.length > 0) {
        pieces.push({
          entry,
          ...(boxedRun ? { boxedRun: splitBoxedRunSegment(boxedRun, segmentIndex, segments.length) } : {}),
          key: `${index}-${segmentIndex}`,
          kind: "piece",
          text: segment,
        });
      }
    });
  });
  return pieces;
}

function buildInlinePieceDom(
  piece: Extract<InlinePiece, { kind: "piece" }>,
  options: InlineRichTextDomOptions,
  boxedUnderline?: UnderlineStyle,
): RichTextDomNode {
  const child = piece.entry;
  const key = `${options.keyPrefix}-${piece.key}`;
  const boxed = withPieceBoxedRun(findDecoration(child.decorations, "box"), piece.boxedRun);
  const style = inlineTextStyleDeclarations(inlineStyleSource(findDecoration(child.decorations, "style")?.style));

  // The wrapper nesting is fixed here and mirrored by the Tiptap mark ranks (see
  // `text-format-extensions.ts`), so neither projection can decide a different wrapper is
  // innermost. Underline is not in this list: it wraps whole runs, above.
  let children: RichTextDomNode[] = child.kind === "text"
    ? (piece.text ?? "").length > 0 ? [{ kind: "text", key: `${key}-text`, text: piece.text ?? "" }] : []
    : [mathFrame(child, options, boxed?.variant === "compact" || hasDecoration(child.decorations, "underline"))];
  if (options.preserveInheritedFontSize && findDecoration(child.decorations, "style")?.style.fontSizePt === undefined) {
    children = [{
      kind: "element", tag: "span", key: `${key}-inherited-font`,
      attrs: { [INHERITED_TEXT_FONT_ATTRIBUTE]: "" }, children,
    }];
  }
  if (hasDecoration(child.decorations, "italic")) {
    children = [wrap("em", `${key}-em`, children)];
  }
  if (hasDecoration(child.decorations, "bold")) {
    children = [wrap("strong", `${key}-strong`, children)];
  }
  if (boxed) {
    children = [boxedElement(boxed, `${key}-boxed`, children, options, boxedUnderline)];
  }
  if (child.kind === "text" && child.reference) {
    children = [{ kind: "element", tag: "span", key: `${key}-reference`, className: "document-reference",
      attrs: { "data-document-reference-kind": child.reference.kind, "data-document-reference-id": child.reference.id, role: "link", tabindex: "0" }, children }];
  }
  if (style) {
    return { kind: "element", tag: "span", key: `${key}-styled`, style, children };
  }
  return children.length === 1 ? children[0] : wrap("span", key, children);
}

/**
 * The boxed-run identity of one fragment of a text node that a hard break split.
 *
 * A `\n` inside boxed text draws two frames on two lines, and the editor sees them as two
 * independent document targets (the mark span closes at ProseMirror's `hardBreak`). Re-using the
 * entry's single segment id for both would collapse them into one entry of the measured alignment
 * map — the frame on the first line then took the second line's stretch — and would leave the
 * fragment that ends at the break claiming something joins it on the right, so it drew with a
 * squared-off, borderless right edge in mid-air.
 */
function splitBoxedRunSegment(
  boxedRun: BoxedInlineRunSegment,
  fragmentIndex: number,
  fragmentCount: number,
): BoxedInlineRunSegment {
  if (fragmentCount <= 1) {
    return boxedRun;
  }
  return {
    ...boxedRun,
    connectLeft: fragmentIndex === 0 ? boxedRun.connectLeft : false,
    connectRight: fragmentIndex === fragmentCount - 1 ? boxedRun.connectRight : false,
    segmentId: `${boxedRun.segmentId}-line-${fragmentIndex}`,
  };
}

function withPieceBoxedRun(
  boxed: RichTextBoxDecoration | undefined,
  boxedRun: BoxedInlineRunSegment | undefined,
): RichTextBoxDecoration | undefined {
  if (!boxed || !boxedRun || boxedRun === boxed.run) {
    return boxed;
  }
  return {
    ...boxed,
    connectLeft: boxedRun.connectLeft,
    connectRight: boxedRun.connectRight,
    run: boxedRun,
  };
}

function mathFrame(
  child: Extract<RichTextInlineRenderNode, { kind: "math" }>,
  options: InlineRichTextDomOptions,
  compact: boolean,
): RichTextDomElement {
  return {
    kind: "element",
    tag: "span",
    // クラスと属性は編集面の NodeView と同じ出典から (`inline-math-frame.ts`)。
    className: inlineMathNodeClassName(),
    key: `${options.keyPrefix}-${child.id}-frame`,
    attrs: inlineMathNodeDataAttributes({ id: child.id, tex: child.tex }),
    selfContainedStyle: compact
      ? { ...MATH_FRAME_SELF_CONTAINED_STYLE, "margin-inline": "0", "line-height": "0" }
      : MATH_FRAME_SELF_CONTAINED_STYLE,
    children: [{ kind: "mathBody", key: `${options.keyPrefix}-${child.id}-body`, tex: child.tex,
      ...(compact ? { compact: true } : {}) }],
  };
}

function boxedElement(
  boxed: RichTextBoxDecoration,
  key: string,
  children: RichTextDomNode[],
  options: InlineRichTextDomOptions,
  underline: UnderlineStyle | undefined,
): RichTextDomElement {
  const spec = boxedInlineDomSpec({
    boxedPaddingY: boxed.paddingY,
    boxedRoundness: boxed.roundness,
    boxedTone: boxed.tone,
    boxedVariant: boxed.variant,
  }, { math: boxed.math });
  const alignment = boxed.run ? options.alignmentStyles?.[boxed.run.segmentId] : undefined;
  return {
    kind: "element",
    tag: "span",
    className: spec.className,
    key,
    attrs: { ...spec.attrs, ...boxedRunDomAttrs(boxed.run) },
    style: mergeStyles(spec.style, alignment),
    selfContainedStyle: boxedSelfContainedStyle(boxed, underline),
    children,
  };
}

/**
 * The declarations `.boxed-text` and its state rules apply to this element, written out for
 * surfaces that ship without the stylesheet.
 *
 * This is a mirror, not a re-invention: `rich-text-self-contained.test.ts` parses
 * `document-surface.css` and fails if the two drift. Two deliberate transformations:
 *
 * - the boxed custom properties are read with a `var(name, default)` fallback instead of being
 *   re-declared inline. An inline `--boxed-text-border-width` would beat the
 *   `[data-sigma-doc-boxed-variant="thick"]` rules and freeze every box at the default frame; the
 *   fallback form keeps variants and tones working wherever the stylesheet is present, and lands
 *   on the same defaults where it is not. `.boxed-run-frame` uses this form in the CSS itself.
 * - runtime-only branches (`[data-boxed-run-aligned="true"] …`, `.boxed-run-measuring …`,
 *   `.boxed-run-framed …`) are skipped: their ancestors exist only while an editor is mounted and
 *   measuring, never in serialized output. The last one is what stops a segment painting its own
 *   border once one rectangle is drawn for the whole run — serialized output has no such rectangle,
 *   so its segments have to keep their frames.
 *
 * `underline` is the style of the text-only underline run the box sits in, if any: a run segment
 * is `inline-flex`, which the run's own decoration does not reach.
 */
export function boxedSelfContainedStyle(boxed: RichTextBoxDecoration, underline?: UnderlineStyle): RichTextDomStyle {
  const style: RichTextDomStyle = { ...BOXED_TEXT_BASE_STYLE };
  if (boxed.math) {
    Object.assign(style, BOXED_INLINE_MATH_STYLE);
  }
  // `data-boxed-run-height-target` is emitted for every segment of a boxed run, and its rule comes
  // after the math rule in the stylesheet, so it wins where the two overlap.
  if (boxed.run) {
    Object.assign(style, BOXED_RUN_HEIGHT_TARGET_STYLE);
    if (underline) {
      Object.assign(style, boxedRunUnderlineStyle(underline));
    }
  }
  if (boxed.connectRight) {
    Object.assign(style, BOXED_RUN_CONNECT_RIGHT_STYLE);
  }
  if (boxed.connectLeft) {
    Object.assign(style, BOXED_RUN_CONNECT_LEFT_STYLE);
  }
  if (boxed.variant === "compact") {
    Object.assign(style, { "--boxed-text-padding-y": "1px", "padding-inline": "1px" });
  }
  return style;
}

const BOXED_FRAME_STYLE: RichTextDomStyle = {
  border:
    "var(--boxed-text-border-width, 1px) var(--boxed-text-border-style, solid) var(--boxed-text-border-color, currentColor)",
  "border-radius": "var(--boxed-text-border-radius, 0)",
  "background-color": "var(--boxed-text-background, transparent)",
};

// 左右の余白。角丸・網かけの端は広く、ランの継ぎ目は細線と同じ幅 (どちらも stylesheet が変数で決める)。
const BOXED_RUN_PADDING_LEFT = "var(--boxed-run-padding-left, var(--boxed-text-end-padding-x, 0.18em))";
const BOXED_RUN_PADDING_RIGHT = "var(--boxed-run-padding-right, var(--boxed-text-end-padding-x, 0.18em))";

/** `.boxed-text` */
const BOXED_TEXT_BASE_STYLE: RichTextDomStyle = {
  "box-sizing": "border-box",
  display: "inline",
  ...BOXED_FRAME_STYLE,
  padding:
    `calc(var(--boxed-text-padding-y, 0px) + var(--boxed-run-extra-padding-y, 0px)) ${BOXED_RUN_PADDING_RIGHT} calc(var(--boxed-text-padding-y, 0px) + var(--boxed-run-extra-padding-y, 0px)) ${BOXED_RUN_PADDING_LEFT}`,
  "line-height": "var(--boxed-text-line-height, inherit)",
  "box-decoration-break": "clone",
  "-webkit-box-decoration-break": "clone",
};

/** `.boxed-text.boxed-inline-math` */
const BOXED_INLINE_MATH_STYLE: RichTextDomStyle = {
  display: "inline-flex",
  "align-items": "center",
  "vertical-align": "baseline",
  "line-height": "normal",
};

/** `.boxed-text[data-boxed-run-height-target="true"]` */
const BOXED_RUN_HEIGHT_TARGET_STYLE: RichTextDomStyle = {
  "box-sizing": "border-box",
  display: "inline-flex",
  // Baseline, not center: PR #223 moved boxed runs to a baseline anchor because an explicit
  // height + top alignment left short frames floating above the surrounding text's baseline.
  "align-items": "baseline",
  ...BOXED_FRAME_STYLE,
  padding:
    `calc(var(--boxed-text-padding-y, 0px) + var(--boxed-run-extra-padding-top, 0px)) ${BOXED_RUN_PADDING_RIGHT} calc(var(--boxed-text-padding-y, 0px) + var(--boxed-run-extra-padding-bottom, 0px) + var(--boxed-run-underline-room, 0px)) ${BOXED_RUN_PADDING_LEFT}`,
  "line-height": "1",
  "vertical-align": "baseline",
  "box-decoration-break": "clone",
  "-webkit-box-decoration-break": "clone",
};

/**
 * `.sigma-underline-run:not(:has(.math-preview)) :is(.boxed-text[data-boxed-run-height-target="true"], …)`
 * and its style variants. The room is the one custom property written inline: it only lengthens
 * the bottom padding above, and still reads the double box's inner-rule inset from the stylesheet.
 */
function boxedRunUnderlineStyle(style: UnderlineStyle): RichTextDomStyle {
  const lineDepth = style === "wavy" || style === "double" ? "3px" : "1px";
  return {
    "--boxed-run-underline-room": `calc(0.2em + ${lineDepth} + var(--boxed-text-inner-rule-inset, 0px))`,
    ...underlineStyle(style),
  };
}

/** `.boxed-text[data-boxed-run-connect-right="true"]` */
const BOXED_RUN_CONNECT_RIGHT_STYLE: RichTextDomStyle = {
  "border-right-width": "0",
  "border-top-right-radius": "0",
  "border-bottom-right-radius": "0",
};

/** `.boxed-text[data-boxed-run-connect-left="true"]` */
const BOXED_RUN_CONNECT_LEFT_STYLE: RichTextDomStyle = {
  "border-left-width": "0",
  "border-top-left-radius": "0",
  "border-bottom-left-radius": "0",
};

export const UNDERLINE_WAVE_CLASS_NAME = "sigma-underline-wave";
const UNDERLINE_WAVE_MASK = "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='4' viewBox='0 0 8 4'%3E%3Cpath d='M0 2 Q2 0 4 2 T8 2' fill='none' stroke='black' stroke-width='1'/%3E%3C/svg%3E\")";

/** A CSS decoration inside the marked run; it is never a canonical canvas shape. */
export function underlineWaveStrokeStyle(containsMath: boolean): RichTextDomStyle {
  return {
    display: containsMath ? "block" : "none",
    position: "absolute",
    left: "0",
    right: "0",
    bottom: "0",
    height: "4px",
    "background-color": "currentColor",
    "mask-image": UNDERLINE_WAVE_MASK,
    "mask-size": "8px 4px",
    "mask-repeat": "repeat-x",
    "pointer-events": "none",
  };
}

export function underlineDomAttrs(style?: UnderlineStyle): Record<string, string> {
  return {
    "data-sigma-doc-underline-text": "true",
    ...(style && style !== "solid" ? { "data-sigma-doc-underline-style": style } : {}),
  };
}

export function underlineRunStyle(containsMath: boolean, style: UnderlineStyle = "solid"): RichTextDomStyle {
  if (!containsMath) {
    return underlineStyle(style);
  }
  return {
    display: "inline-block",
    "vertical-align": "baseline",
    "max-width": "100%",
    "text-decoration": "none",
    "border-bottom": style === "double" ? "3px double currentColor" : `1.25px ${style === "wavy" ? "solid" : style} currentColor`,
    ...(style === "wavy" ? {
      "border-bottom": "0",
      position: "relative",
    } : {}),
    "padding-bottom": style === "wavy" ? "4px" : "0.1em",
    "box-decoration-break": "clone",
    "-webkit-box-decoration-break": "clone",
  };
}

export function underlineStyle(style: UnderlineStyle = "solid"): RichTextDomStyle {
  return {
    "text-decoration-line": "underline",
    ...(style !== "solid" ? { "text-decoration-style": style } : {}),
    "text-decoration-thickness": "1px",
    "text-decoration-color": "currentColor",
    "text-underline-offset": "0.12em",
    "text-decoration-skip-ink": "auto",
  };
}

function wrap(tag: string, key: string, children: RichTextDomNode[]): RichTextDomElement {
  return { kind: "element", tag, key, children };
}

function inlineStyleSource(style: RichTextRenderStyle | undefined): {
  backgroundColor?: string;
  color?: string;
  fontFamily?: string;
  fontSizePt?: number;
} {
  return {
    backgroundColor: style?.backgroundColor,
    color: style?.color,
    fontFamily: style?.fontFamily,
    fontSizePt: style?.fontSizePt,
  };
}

function hasDecoration(
  decorations: RichTextRenderDecoration[],
  type: RichTextRenderDecoration["type"],
): boolean {
  return decorations.some((decoration) => decoration.type === type);
}

function findDecoration<Type extends RichTextRenderDecoration["type"]>(
  decorations: RichTextRenderDecoration[],
  type: Type,
): Extract<RichTextRenderDecoration, { type: Type }> | undefined {
  return decorations.find(
    (decoration): decoration is Extract<RichTextRenderDecoration, { type: Type }> => decoration.type === type,
  );
}

export function mergeStyles(
  ...styles: Array<RichTextDomStyle | undefined>
): RichTextDomStyle | undefined {
  const merged: RichTextDomStyle = {};
  for (const style of styles) {
    if (style) {
      Object.assign(merged, style);
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
