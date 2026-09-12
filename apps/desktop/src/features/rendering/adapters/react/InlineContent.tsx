"use client";

import {
  Fragment,
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

import type {
  InlineNode,
  MathFractionSizing,
} from "@/features/document";
import { isSafeCssDeclarationValue } from "@/features/document/css-safety";
import {
  buildInlineRichTextDom,
  getEffectiveZoom,
  mergeStyles,
  type RichTextDomNode,
  type RichTextDomStyle,
} from "@/features/rendering/adapters";
import {
  boxedInlineRunSignature,
  computeBoxedRunLineTargets,
  hasVisibleInlineText,
  scaleBoxedRunRects,
  type BoxedRunMeasurement,
  type BoxedRunRect,
} from "@/features/rendering/core";

import { MathPreview } from "./MathPreview";

const BOXED_RUN_TARGET_SELECTOR = "[data-boxed-run-height-target=\"true\"][data-boxed-run-segment-id]";
const HEIGHT_TARGET_TOLERANCE_PX = 0.5;
const CSS_PIXEL_PRECISION = 100;
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

type TextResolver = (text: string) => string;

export type BoxedInlineRunAlignmentStyles = Record<string, CSSProperties>;

interface StaticBoxedRunTarget {
  segmentId: string;
}

interface RenderInlineContentOptions {
  preserveInheritedFontSize?: boolean;
  alignmentStyles?: BoxedInlineRunAlignmentStyles;
  keyPrefix?: string;
  mathFractionSizing?: MathFractionSizing | null;
  resolveText?: TextResolver;
  /**
   * Inline the styling `document-surface.css` would supply. Only for output that is serialized
   * into a context without the stylesheet — today that is the SVG export's `<foreignObject>`.
   * See `rich-text-dom.ts`; the values are checked against the CSS in
   * `rich-text-self-contained.test.ts`.
   */
  selfContained?: boolean;
}

/**
 * Shared read-only renderer for `InlineNode[]` runs (text + inline math).
 *
 * The document body is an editable Tiptap surface, so it cannot literally be
 * reused for static display. This renderer is its static twin: it emits the
 * same inline math wrapper, boxed-run metadata, and text marks so comments,
 * AI previews, page previews, and print previews agree with the body.
 */

export function boxedInlineRunAlignmentSignature(nodes: readonly InlineNode[]): string {
  return boxedInlineRunSignature(nodes);
}

export function useBoxedInlineRunAlignment<TElement extends HTMLElement>(
  dependencyKey: string,
): {
  aligned: boolean;
  alignmentStyles: BoxedInlineRunAlignmentStyles;
  ref: RefObject<TElement | null>;
} {
  const ref = useRef<TElement>(null);
  const [alignmentStyles, setAlignmentStyles] = useState<BoxedInlineRunAlignmentStyles>({});

  useIsomorphicLayoutEffect(() => {
    const root = ref.current;
    if (!root || typeof window === "undefined") {
      return undefined;
    }

    let destroyed = false;
    let measuring = false;
    let animationFrameId: number | null = null;
    let releaseMeasuringFrameId: number | null = null;
    let settleMeasuringFrameId: number | null = null;
    const resizeObserver = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => scheduleMeasure());
    const mutationObserver = typeof MutationObserver === "undefined"
      ? null
      : new MutationObserver(() => scheduleMeasure());

    const observeResizeTargets = () => {
      resizeObserver?.disconnect();
      resizeObserver?.observe(root);
      root.querySelectorAll<HTMLElement>(BOXED_RUN_TARGET_SELECTOR).forEach((element) => {
        resizeObserver?.observe(element);
      });
    };

    const measure = () => {
      measuring = true;
      root.classList.add("boxed-run-measuring");
      try {
        const nextStyles = measureBoxedInlineRunAlignment(root);
        setAlignmentStyles((currentStyles) => (
          sameAlignmentStyles(currentStyles, nextStyles) ? currentStyles : nextStyles
        ));
      } finally {
        root.classList.remove("boxed-run-measuring");
        observeResizeTargets();
        releaseMeasuringFrameId = window.requestAnimationFrame(() => {
          releaseMeasuringFrameId = null;
          settleMeasuringFrameId = window.requestAnimationFrame(() => {
            settleMeasuringFrameId = null;
            measuring = false;
          });
        });
      }
    };

    function scheduleMeasure() {
      if (destroyed || measuring || animationFrameId !== null) {
        return;
      }
      animationFrameId = window.requestAnimationFrame(() => {
        animationFrameId = null;
        measure();
      });
    }

    observeResizeTargets();
    mutationObserver?.observe(root, {
      attributes: true,
      attributeFilter: [
        "class",
        "data-sigma-doc-boxed-padding-y",
        "data-sigma-doc-boxed-variant",
        "data-sigma-doc-boxed-tone",
      ],
      childList: true,
      characterData: true,
      subtree: true,
    });
    window.addEventListener("resize", scheduleMeasure);
    scheduleMeasure();

    return () => {
      destroyed = true;
      if (animationFrameId !== null) {
        window.cancelAnimationFrame(animationFrameId);
      }
      if (releaseMeasuringFrameId !== null) {
        window.cancelAnimationFrame(releaseMeasuringFrameId);
      }
      if (settleMeasuringFrameId !== null) {
        window.cancelAnimationFrame(settleMeasuringFrameId);
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [dependencyKey]);

  return {
    aligned: Object.keys(alignmentStyles).length > 0,
    alignmentStyles,
    ref,
  };
}

export function renderInlineContent(
  children: readonly InlineNode[],
  options: RenderInlineContentOptions = {},
): ReactNode[] {
  const keyPrefix = options.keyPrefix ?? "inline";
  return renderRichTextDom(
    buildInlineRichTextDom(children, {
      preserveInheritedFontSize: options.preserveInheritedFontSize,
      alignmentStyles: options.alignmentStyles as Record<string, RichTextDomStyle> | undefined,
      keyPrefix,
      resolveText: options.resolveText,
    }),
    options,
  );
}

/**
 * React projection of the shared DOM description (`rich-text-dom.ts`). The HTML string serializer
 * walks the very same descriptors, which is what keeps the two static renderers identical —
 * `rich-text-parity.test.tsx` compares their output literally.
 */
function renderRichTextDom(
  nodes: RichTextDomNode[],
  options: RenderInlineContentOptions,
): ReactNode[] {
  return nodes.map((node) => renderRichTextDomNode(node, options));
}

function renderRichTextDomNode(node: RichTextDomNode, options: RenderInlineContentOptions): ReactNode {
  if (node.kind === "text") {
    return <Fragment key={node.key}>{node.text}</Fragment>;
  }
  if (node.kind === "lineBreak") {
    return <br key={node.key} />;
  }
  if (node.kind === "mathBody") {
    return (
      <MathPreview
        key={node.key}
        tex={node.tex}
        mathFractionSizing={options.mathFractionSizing}
      />
    );
  }

  const Tag = node.tag as "em" | "span" | "strong" | "u";
  const style = options.selfContained
    ? mergeStyles(node.selfContainedStyle, node.style)
    : node.style;
  return (
    <Tag
      key={node.key}
      className={node.className}
      style={toReactStyle(style)}
      {...node.attrs}
    >
      {node.children.map((child) => renderRichTextDomNode(child, options))}
    </Tag>
  );
}

function toReactStyle(style: RichTextDomStyle | undefined): CSSProperties | undefined {
  if (!style) {
    return undefined;
  }
  const cssStyle: Record<string, string> = {};
  for (const [property, value] of Object.entries(style)) {
    // The same component renders through `renderToStaticMarkup` for the SVG export, where a `;`
    // inside a style object value is written out unescaped and becomes real extra declarations.
    // The live DOM hides this (CSSOM discards the malformed value), so the check belongs here
    // rather than at the call sites.
    if (!isSafeCssDeclarationValue(value)) {
      continue;
    }
    // Custom properties have to keep their literal name; everything else is camelCased for React.
    cssStyle[property.startsWith("--") ? property : toCamelCaseProperty(property)] = value;
  }
  return cssStyle as CSSProperties;
}

function toCamelCaseProperty(property: string): string {
  return property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function measureBoxedInlineRunAlignment(root: HTMLElement): BoxedInlineRunAlignmentStyles {
  const measurements = collectStaticInlineMeasurements(root);
  const lineTargets = computeBoxedRunLineTargets(measurements);
  const alignmentStyles: BoxedInlineRunAlignmentStyles = {};

  for (const [target, lineTarget] of lineTargets) {
    alignmentStyles[target.segmentId] = {
      "--boxed-run-extra-padding-bottom": `${roundCssPx(lineTarget.extraPaddingBottom)}px`,
      "--boxed-run-extra-padding-top": `${roundCssPx(lineTarget.extraPaddingTop)}px`,
      "--boxed-run-own-height": `${roundCssPx(lineTarget.ownHeight)}px`,
      "--boxed-run-target-height": `${roundCssPx(lineTarget.targetHeight)}px`,
    } as CSSProperties;
  }

  return alignmentStyles;
}

function collectStaticInlineMeasurements(root: HTMLElement): Array<BoxedRunMeasurement<StaticBoxedRunTarget>> {
  const measurements: Array<BoxedRunMeasurement<StaticBoxedRunTarget>> = [];
  // Rects are zoom-scaled when the page canvas is zoomed; divide back out so the
  // applied target height matches content instead of growing by zoom². See getEffectiveZoom.
  const zoom = getEffectiveZoom(root);
  const visit = (node: Node) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === Node.TEXT_NODE) {
        if (hasVisibleInlineText(child.textContent ?? "") && child instanceof Text) {
          measurements.push(...scaleBoxedRunRects(getTextNodeRects(child), zoom));
        }
        continue;
      }

      if (!(child instanceof HTMLElement) || isIgnorableElement(child)) {
        continue;
      }

      if (child.matches(BOXED_RUN_TARGET_SELECTOR)) {
        const segmentId = child.getAttribute("data-boxed-run-segment-id");
        if (segmentId) {
          measurements.push(...scaleBoxedRunRects(getElementRects(child), zoom).map((rect) => ({
            ...rect,
            boxedTarget: { segmentId },
          })));
        }
        continue;
      }

      if (child.tagName === "BR") {
        continue;
      }

      if (child.querySelector(BOXED_RUN_TARGET_SELECTOR)) {
        visit(child);
        continue;
      }

      if (hasVisibleElementContent(child)) {
        measurements.push(...scaleBoxedRunRects(getElementRects(child), zoom));
      }
    }
  };

  visit(root);
  return measurements;
}

function getTextNodeRects(node: Text): BoxedRunRect[] {
  const range = node.ownerDocument.createRange();
  range.selectNodeContents(node);
  const rects = getClientRects(range);
  range.detach();
  return rects;
}

function getElementRects(element: HTMLElement): BoxedRunRect[] {
  const rects = getClientRects(element);
  if (rects.length > 0) {
    return rects;
  }
  return toBoxedRunRect(element.getBoundingClientRect());
}

function getClientRects(target: Element | Range): BoxedRunRect[] {
  return Array.from(target.getClientRects())
    .flatMap(toBoxedRunRect);
}

function toBoxedRunRect(rect: DOMRect | DOMRectReadOnly): BoxedRunRect[] {
  if (!Number.isFinite(rect.top) || !Number.isFinite(rect.bottom) || !Number.isFinite(rect.height) || rect.height <= 0) {
    return [];
  }
  return [{
    top: rect.top,
    bottom: rect.bottom,
    height: rect.height,
  }];
}

function isIgnorableElement(element: HTMLElement): boolean {
  return element.getAttribute("aria-hidden") === "true" || element.hidden;
}

function hasVisibleElementContent(element: HTMLElement): boolean {
  return hasVisibleInlineText(element.textContent ?? "") ||
    element.getBoundingClientRect().width > 0 ||
    element.getBoundingClientRect().height > 0;
}

function sameAlignmentStyles(a: BoxedInlineRunAlignmentStyles, b: BoxedInlineRunAlignmentStyles): boolean {
  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);
  if (aKeys.length !== bKeys.length || !aKeys.every((key) => b[key] !== undefined)) {
    return false;
  }

  return aKeys.every((key) => (
    sameCssPx(readStylePx(a[key], "--boxed-run-extra-padding-bottom"), readStylePx(b[key], "--boxed-run-extra-padding-bottom")) &&
    sameCssPx(readStylePx(a[key], "--boxed-run-extra-padding-top"), readStylePx(b[key], "--boxed-run-extra-padding-top")) &&
    sameCssPx(readStylePx(a[key], "--boxed-run-own-height"), readStylePx(b[key], "--boxed-run-own-height")) &&
    sameCssPx(readStylePx(a[key], "--boxed-run-target-height"), readStylePx(b[key], "--boxed-run-target-height"))
  ));
}

function readStylePx(style: CSSProperties, property: string): number {
  const value = style[property as keyof CSSProperties];
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function sameCssPx(a: number, b: number): boolean {
  return Math.abs(a - b) <= HEIGHT_TARGET_TOLERANCE_PX;
}

function roundCssPx(value: number): number {
  return Math.round(value * CSS_PIXEL_PRECISION) / CSS_PIXEL_PRECISION;
}

interface InlineContentProps {
  nodes: readonly InlineNode[];
  className?: string;
  keyPrefix?: string;
  mathFractionSizing?: MathFractionSizing | null;
}

/**
 * Wrapper element carrying the `rich-inline-content` class, which scopes math to
 * the body font size so inline math is the same size as in the document even
 * when the surrounding text (e.g. 13px comments/chat) is smaller.
 */
// Memoized: when a block's inline nodes are unchanged (immutable doc updates keep the
// array identity), this static renderer — and all the math it contains — skips
// re-rendering even though a sibling edit re-renders the surrounding tree.
export const InlineContent = memo(function InlineContent({ nodes, className, keyPrefix, mathFractionSizing }: InlineContentProps) {
  const classes = ["rich-inline-content", className].filter(Boolean).join(" ");
  const dependencyKey = useMemo(() => boxedInlineRunSignature(nodes), [nodes]);
  const { aligned, alignmentStyles, ref } = useBoxedInlineRunAlignment<HTMLSpanElement>(dependencyKey);

  return (
    <span
      ref={ref}
      className={classes}
      data-boxed-run-aligned={aligned ? "true" : undefined}
    >
      {renderInlineContent(nodes, { alignmentStyles, keyPrefix, mathFractionSizing })}
    </span>
  );
});
