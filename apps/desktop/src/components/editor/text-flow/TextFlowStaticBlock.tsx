"use client";

import { useMemo, type CSSProperties } from "react";

import {
  blockSpaceAfterStyleVars,
  listItemSpaceAfterStyleVars,
  normalizeCodeBlockTheme,
  type CodeBlockNode,
  type TextAlign,
  type DividerNode,
  type InlineNode,
  type MathFractionSizing,
  type QuoteBlockNode,
  type RichBlock,
} from "@/features/document";
import {
  codeHighlightRanges,
  inlineNodesTextBlockTypographyVars,
  listMarkerTypographyDomSpec,
  normalizeCodeLanguage,
} from "@/features/rendering/adapters";
import {
  boxedInlineRunAlignmentSignature,
  renderInlineContent,
  useBoxedInlineRunAlignment,
} from "@/features/rendering/adapters/react/static";
import { stripWrappingMarkdownCodeFence } from "@/features/rendering/core";
import { capInlineNodesForEditorLayout } from "./editor-layout-cap";
import { useHeadingNumber } from "./HeadingNumberingContext";

type TextResolver = (text: string) => string;

/**
 * Class names the host wants on each block element.
 *
 * The print preview needs its `.print-*` family (the viewer, thumbnails and the template gallery
 * style against it); the running region wants none, because it renders inside `.text-flow-editor`
 * and takes the body's own typography. Everything else about the markup is identical — that is the
 * point of this component.
 */
export interface TextFlowStaticBlockClassNames {
  heading?: string;
  list?: string;
  paragraph?: string;
  quote?: string;
  code?: string;
  divider?: string;
}

/**
 * Inline styles the host wants on each block element, keyed like `classNames`.
 *
 * Only for output that is serialized away from the stylesheet — the SVG export's `<foreignObject>`,
 * where a UA `p { margin: 1em 0 }` would otherwise reflow the whole box. Surfaces that keep the
 * stylesheet pass class names instead.
 */
export type TextFlowStaticBlockStyles = {
  [K in keyof TextFlowStaticBlockClassNames]?: CSSProperties;
};

/**
 * 静的描画が受け付けるブロック。`RichBlock` に引用・コード・区切り線を足しただけで、
 * 問題エリア・段組・囲み枠の中身はすべてこの集合で描ける (ヘッダー/フッターは `RichBlock` のみ)。
 */
export type TextFlowStaticBlockNode = RichBlock | QuoteBlockNode | CodeBlockNode | DividerNode;

interface TextFlowStaticBlockProps {
  block: TextFlowStaticBlockNode;
  classNames?: TextFlowStaticBlockClassNames;
  mathFractionSizing?: MathFractionSizing | null;
  /**
   * Leave `data-sigma-doc-id` off every element this renders.
   *
   * That attribute is how the page surface finds a *body* block: `MEASURABLE_BLOCK_SELECTOR`
   * (`overlay-canvas/anchor.ts`, `page-canvas/layout-measure.ts`) and the page-window index both
   * select on it. Text drawn inside a shape is not a body block, so emitting it there would put a
   * figure's paragraphs into the anchor candidates and into the pagination measurement.
   */
  omitBlockIds?: boolean;
  /**
   * The alignment to write when a block has none of its own.
   *
   * The body needs `"left"`: its blocks are drawn inside containers that set an alignment of their
   * own (problem areas, running regions), so an unaligned paragraph has to say so rather than
   * inherit. A shape sets no alignment on its box and its editing surface (ProseMirror) writes
   * nothing for an unaligned block, so passing `null` there is what keeps the two projections
   * identical — see `inline-dom-parity.test.tsx`.
   */
  defaultTextAlign?: TextAlign | null;
  resolveText?: TextResolver;
  /**
   * Inline the styling `document-surface.css` would supply, for output serialized without it.
   * Passed straight through to `renderInlineContent`; block-level values come from `styles`.
   */
  selfContained?: boolean;
  styles?: TextFlowStaticBlockStyles;
}

interface TextFlowStaticSharedProps {
  classNames: TextFlowStaticBlockClassNames;
  defaultTextAlign: TextAlign | null;
  mathFractionSizing?: MathFractionSizing | null;
  omitBlockIds: boolean;
  resolveText: TextResolver;
  selfContained: boolean;
  styles: TextFlowStaticBlockStyles;
}

const identityTextResolver: TextResolver = (text) => text;
const NO_CLASS_NAMES: TextFlowStaticBlockClassNames = {};
const NO_STYLES: TextFlowStaticBlockStyles = {};

/** `undefined` rather than the id, so the attribute is absent instead of empty. */
function blockIdAttr(id: string, omitBlockIds: boolean): string | undefined {
  return omitBlockIds ? undefined : id;
}

/**
 * Read-only rendering of one body block.
 *
 * Header/footer content used to be drawn by a second implementation with its own `.print-*` CSS
 * family, so the PDF surface styled running text differently from the body — the values happened to
 * match, and `.text-flow-editor p` (0,1,1) already outranked `.print-paragraph` (0,1,0), so nobody
 * noticed. One renderer, class names chosen by the host.
 *
 * `data-sigma-doc-id` must stay: `page-windows.ts` indexes the paged surface by it, and running
 * region blocks are cloned onto every page.
 */
export function TextFlowStaticBlock({
  block,
  classNames = NO_CLASS_NAMES,
  defaultTextAlign = "left",
  mathFractionSizing,
  omitBlockIds = false,
  resolveText = identityTextResolver,
  selfContained = false,
  styles = NO_STYLES,
}: TextFlowStaticBlockProps) {
  const shared: TextFlowStaticSharedProps = {
    classNames,
    defaultTextAlign,
    mathFractionSizing,
    omitBlockIds,
    resolveText,
    selfContained,
    styles,
  };

  if (block.type === "heading") {
    return <TextFlowStaticHeading block={block} shared={shared} />;
  }

  if (block.type === "list") {
    return <TextFlowStaticList block={block} shared={shared} />;
  }

  if (block.type === "quote") {
    // 縦棒はこの `blockquote` に 1 本だけ引く。中身が何ブロックでも繋ぎ目は生まれない。
    return (
      <blockquote
        data-sigma-doc-id={blockIdAttr(block.id, omitBlockIds)}
        className={classNames.quote}
        style={styles.quote}
      >
        {block.blocks.map((child) => (
          <TextFlowStaticBlock key={child.id} block={child} {...shared} />
        ))}
      </blockquote>
    );
  }

  if (block.type === "codeBlock") {
    return <TextFlowStaticCodeBlock block={block} shared={shared} />;
  }

  if (block.type === "divider") {
    return (
      <hr
        data-sigma-doc-id={blockIdAttr(block.id, omitBlockIds)}
        className={classNames.divider}
        style={{
          ...blockSpaceAfterStyleVars(block),
          ...styles.divider,
        } as CSSProperties}
      />
    );
  }

  return <TextFlowStaticParagraph block={block} shared={shared} />;
}

function TextFlowStaticHeading({
  block,
  shared,
}: {
  block: Extract<RichBlock, { type: "heading" }>;
  shared: TextFlowStaticSharedProps;
}) {
  const HeadingTag = `h${block.level}` as "h1" | "h2" | "h3";
  const headingNumber = useHeadingNumber(block.id);
  const layoutChildren = capInlineNodesForEditorLayout(block.children);
  const typographyVars = inlineNodesTextBlockTypographyVars(layoutChildren.children);
  const dependencyKey = useInlineAlignmentDependencyKey(layoutChildren.children);
  const { aligned, alignmentStyles, ref } = useBoxedInlineRunAlignment<HTMLHeadingElement>(dependencyKey);

  return (
    <HeadingTag
      ref={ref}
      data-boxed-run-aligned={aligned ? "true" : undefined}
      data-editor-layout-capped={layoutChildren.capped ? "" : undefined}
      data-editor-layout-chars={layoutChildren.capped ? String(layoutChildren.originalLength) : undefined}
      data-sigma-doc-id={blockIdAttr(block.id, shared.omitBlockIds)}
      className={shared.classNames.heading}
      style={{
        textAlign: block.align ?? shared.defaultTextAlign ?? undefined,
        lineHeight: block.lineHeight,
        ...typographyVars,
        ...blockSpaceAfterStyleVars(block),
        ...shared.styles.heading,
      } as CSSProperties}
    >
      {headingNumber ? <span className="heading-number-prefix">{headingNumber} </span> : null}
      {renderInlineContent(layoutChildren.children, {
        preserveInheritedFontSize: Boolean(typographyVars),
        alignmentStyles,
        keyPrefix: block.id,
        mathFractionSizing: shared.mathFractionSizing,
        resolveText: shared.resolveText,
        selfContained: shared.selfContained,
      })}
    </HeadingTag>
  );
}

function TextFlowStaticParagraph({
  block,
  shared,
}: {
  block: Extract<RichBlock, { type: "paragraph" }>;
  shared: TextFlowStaticSharedProps;
}) {
  const layoutChildren = capInlineNodesForEditorLayout(block.children);
  const typographyVars = inlineNodesTextBlockTypographyVars(layoutChildren.children);
  const dependencyKey = useInlineAlignmentDependencyKey(layoutChildren.children);
  const { aligned, alignmentStyles, ref } = useBoxedInlineRunAlignment<HTMLParagraphElement>(dependencyKey);

  return (
    <p
      ref={ref}
      data-boxed-run-aligned={aligned ? "true" : undefined}
      data-editor-layout-capped={layoutChildren.capped ? "" : undefined}
      data-editor-layout-chars={layoutChildren.capped ? String(layoutChildren.originalLength) : undefined}
      data-sigma-doc-id={blockIdAttr(block.id, shared.omitBlockIds)}
      className={shared.classNames.paragraph}
      style={{
        textAlign: block.align ?? shared.defaultTextAlign ?? undefined,
        lineHeight: block.lineHeight,
        ...typographyVars,
        ...blockSpaceAfterStyleVars(block),
        ...shared.styles.paragraph,
      } as CSSProperties}
    >
      {renderInlineContent(layoutChildren.children, {
        preserveInheritedFontSize: Boolean(typographyVars),
        alignmentStyles,
        keyPrefix: block.id,
        mathFractionSizing: shared.mathFractionSizing,
        resolveText: shared.resolveText,
        selfContained: shared.selfContained,
      })}
      {!paragraphHasVisibleContent(layoutChildren.children) && <br key="trailing-break" />}
    </p>
  );
}

/**
 * コードブロック。`<pre>` 1 つに全行が入るので、行間はこのブロックの line-height だけで決まる
 * — 段落を積んでいたときのように「1 行目だけ余白が違う」ことが起きない。
 *
 * 色分けは編集中の ProseMirror と **同じ `codeHighlightRanges`** から出す。run の書式
 * (フォント・大きさ・色) はその上に重ねるので、明示指定があればトークンの色より勝つ。
 */
function TextFlowStaticCodeBlock({
  block,
  shared,
}: {
  block: CodeBlockNode;
  shared: TextFlowStaticSharedProps;
}) {
  const { classNames, resolveText } = shared;
  const language = normalizeCodeLanguage(block.language);
  const theme = normalizeCodeBlockTheme(block.theme) ?? "light";
  const segments = useMemo(
    () => splitCodeIntoHighlightedSegments(
      capInlineNodesForEditorLayout(block.children).children,
      language,
      resolveText,
    ),
    [block.children, language, resolveText],
  );

  return (
    <pre
      data-sigma-doc-id={blockIdAttr(block.id, shared.omitBlockIds)}
      data-code-language={language}
      data-code-theme={theme}
      className={classNames.code}
      style={shared.styles.code}
    >
      {segments.map((segment, index) => (
        <span
          // 分割位置は本文と言語だけで決まるので、index で安定する。
          key={`${block.id}:${index}`}
          className={segment.className}
          style={segment.style}
        >
          {segment.text}
        </span>
      ))}
      {segments.length === 0 && <br key="trailing-break" />}
    </pre>
  );
}

interface CodeSegment {
  text: string;
  className?: string;
  style?: CSSProperties;
}

/**
 * run の境界と色分けトークンの境界の **両方** で切る。
 *
 * 位置合わせは編集面と同じ規約: 数式などのテキストでない run は 1 文字ぶんとして数える
 * (`code-highlight-extension.ts` の `ATOM_CHAR` と同じ)。ここがずれると「編集中と印刷で
 * 色の付く範囲が違う」という、いちばん見つけにくい形の食い違いになる。
 */
function splitCodeIntoHighlightedSegments(
  children: readonly InlineNode[],
  language: string | undefined,
  resolveText: TextResolver,
): CodeSegment[] {
  const resolvedChildren = childrenWithoutWrappingMarkdownFence(children, resolveText);
  const code = resolvedChildren
    .map((child) => (child.type === "text" ? child.text : "￼"))
    .join("");
  const ranges = codeHighlightRanges(code, language);

  const segments: CodeSegment[] = [];
  let offset = 0;
  let rangeIndex = 0;
  for (const child of resolvedChildren) {
    const text = child.type === "text" ? child.text : "￼";
    const style = child.type === "text" ? inlineCodeRunStyle(child) : undefined;
    let cursor = 0;
    while (cursor < text.length) {
      while (rangeIndex < ranges.length && ranges[rangeIndex].to <= offset + cursor) {
        rangeIndex += 1;
      }
      const range = ranges[rangeIndex];
      const inRange = range !== undefined && range.from <= offset + cursor;
      const end = range === undefined
        ? text.length
        : Math.min(text.length, (inRange ? range.to : range.from) - offset);
      segments.push({
        text: text.slice(cursor, Math.max(cursor + 1, end)),
        className: inRange ? range.className : undefined,
        style,
      });
      cursor = Math.max(cursor + 1, end);
    }
    offset += text.length;
  }
  return segments;
}

function childrenWithoutWrappingMarkdownFence(
  children: readonly InlineNode[],
  resolveText: TextResolver,
): InlineNode[] {
  const resolved = children.map((child) => (
    child.type === "text" ? { ...child, text: resolveText(child.text) } : child
  ));
  const joined = resolved
    .map((child) => (child.type === "text" ? child.text : "￼"))
    .join("");
  const stripped = stripWrappingMarkdownCodeFence(joined);
  if (stripped === joined) {
    return resolved;
  }
  return [{ type: "text", text: stripped }];
}

/** コードの run が持つ書式。トークンの色より後に当たるので、明示指定はこちらが勝つ。 */
function inlineCodeRunStyle(child: Extract<InlineNode, { type: "text" }>): CSSProperties | undefined {
  const style: CSSProperties = {};
  if (child.color) {
    style.color = child.color;
  }
  if (child.backgroundColor) {
    style.backgroundColor = child.backgroundColor;
  }
  if (child.fontFamily) {
    style.fontFamily = child.fontFamily;
  }
  if (child.fontSize) {
    style.fontSize = `${child.fontSize}pt`;
  }
  if (child.marks?.includes("bold")) {
    style.fontWeight = "bold";
  }
  if (child.marks?.includes("italic")) {
    style.fontStyle = "italic";
  }
  if (child.marks?.includes("underline")) {
    style.textDecoration = "underline";
  }
  return Object.keys(style).length > 0 ? style : undefined;
}

function TextFlowStaticList({
  block,
  shared,
}: {
  block: Extract<RichBlock, { type: "list" }>;
  shared: TextFlowStaticSharedProps;
}) {
  const { classNames, omitBlockIds, styles } = shared;
  const items = block.items.map((item) => {
    // The marker inherits the `li` font, so the typography of the item's first run has to be
    // handed to `::marker` from here — the run's own span is inside the `li` and cannot reach it.
    // Note the asymmetry with the editing surface, where `data-sigma-doc-id` sits on the inner `p`:
    // these must stay on the `li` or the CSS rule never matches.
    const markerTypography = listMarkerTypographyDomSpec(item.children);
    return (
      <li
        key={item.id}
        data-sigma-doc-id={blockIdAttr(item.id, omitBlockIds)}
        {...markerTypography?.attrs}
        style={{ ...markerTypography?.style, ...listItemSpaceAfterStyleVars(item) } as CSSProperties}
      >
        <TextFlowStaticListItemContent item={item} shared={shared} />
        {(item.continuations ?? []).map((continuation) => (
          <TextFlowStaticBlock key={continuation.id} block={continuation} {...shared} />
        ))}
        {(item.nested ?? []).map((nested) => (
          <TextFlowStaticList key={nested.id} block={nested} shared={shared} />
        ))}
      </li>
    );
  });

  return block.listType === "ordered"
    ? (
      <ol
        data-sigma-doc-id={blockIdAttr(block.id, omitBlockIds)}
        // `document-surface.css` swaps the counter style on this attribute, matching what the
        // editor's `orderedList` node renders. No marker style means the UA default decimal.
        data-list-marker={block.markerStyle === "paren" ? "paren" : undefined}
        className={classNames.list}
        start={block.start}
        style={{ ...blockSpaceAfterStyleVars(block), ...styles.list } as CSSProperties}
      >
        {items}
      </ol>
    )
    : (
      <ul
        data-sigma-doc-id={blockIdAttr(block.id, omitBlockIds)}
        className={classNames.list}
        style={{ ...blockSpaceAfterStyleVars(block), ...styles.list } as CSSProperties}
      >
        {items}
      </ul>
    );
}

function TextFlowStaticListItemContent({
  item,
  shared,
}: {
  item: Extract<RichBlock, { type: "list" }>["items"][number];
  shared: TextFlowStaticSharedProps;
}) {
  const layoutChildren = capInlineNodesForEditorLayout(item.children);
  const typographyVars = inlineNodesTextBlockTypographyVars(layoutChildren.children);
  const dependencyKey = useInlineAlignmentDependencyKey(layoutChildren.children);
  const { aligned, alignmentStyles, ref } = useBoxedInlineRunAlignment<HTMLSpanElement>(dependencyKey);

  return (
    <span
      ref={ref}
      data-boxed-run-aligned={aligned ? "true" : undefined}
      data-editor-layout-capped={layoutChildren.capped ? "" : undefined}
      style={{ display: "block", textAlign: item.align ?? shared.defaultTextAlign ?? undefined, ...typographyVars }}
      data-sigma-doc-list-item-text=""
    >
      {renderInlineContent(layoutChildren.children, {
        preserveInheritedFontSize: Boolean(typographyVars),
        alignmentStyles,
        keyPrefix: item.id,
        mathFractionSizing: shared.mathFractionSizing,
        resolveText: shared.resolveText,
        selfContained: shared.selfContained,
      })}
    </span>
  );
}

/**
 * Empty paragraphs still need one line box, matching the ProseMirror editing surface.
 */
function paragraphHasVisibleContent(children: readonly InlineNode[]): boolean {
  return children.some((child) => (child.type === "text" ? child.text.length > 0 : true));
}

function useInlineAlignmentDependencyKey(children: readonly InlineNode[]): string {
  return useMemo(() => boxedInlineRunAlignmentSignature(children), [children]);
}
