// @vitest-environment happy-dom

import { EditorState } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { getSchema } from "@tiptap/core";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { collectBoxedRunDocTargetsForTextBlock } from "@/components/tiptap/boxed-text-run-height";
import { OverlayTextBlockAttrs } from "@/components/editor/overlay-canvas/overlay-text-block-attrs";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import type { OverlayTextBlock } from "@/features/document";
import { OverlayTextBlocksView } from "@/components/editor/text-flow/OverlayTextBlocksView";
import { overlayTextBlocksToTiptapDoc } from "@/components/editor/text-flow/overlay-tiptap-adapter";
import { createTextBlockTypographyPlugin } from "./text-block-typography";

/**
 * Overlay text is drawn by Tiptap while it has focus and by the static renderer the rest of the
 * time, so anything the two project differently reads as the document changing when the author
 * clicks away. Three earlier attempts at this failed by "matching" one output to the other; here
 * both sides are made to derive their DOM from one projection instead, and this test is what holds
 * them to it: the ProseMirror schema DOM with its runtime typography decorations is compared against
 * `OverlayRichTextPreview` for the same document. Tags, nesting, classes, attributes and inline
 * styles all have to agree, because a difference here is one
 * of the two projections drifting.
 *
 * Two things are outside what a schema serialization can express, so they are stated as scope
 * rather than tolerated as diffs:
 *
 * - **The runtime measurement channel** (`data-boxed-run-*`, and the inline styles carrying the
 *   measured `--boxed-run-*` values). On the editing side it is a ProseMirror *decoration*, which
 *   lives in the view and not in the schema; on the display side it is the render model's boxed-run
 *   annotation. `RUN_METADATA_ATTRIBUTES` names them exhaustively and the test fails if the static
 *   side grows any other extra attribute, so nothing can hide in this gap. What the two measure is
 *   compared by `boxed-run-measurements.test.ts` and `tests/e2e/boxed-text-run-height.spec.ts`.
 * - **Empty blocks and inline math.** Both are drawn by the view (ProseMirror's
 *   `<br class="ProseMirror-trailingBreak">`, and the math node view / `MathPreview`) and have no
 *   schema DOM at all. They are covered by `tests/e2e/editing-display-parity.spec.ts` and by the
 *   shared `inlineMathNodeClassName` / `inlineMathNodeDataAttributes` that both sides already use.
 */

// The shape editor's own schema, option for option (`text-shape-editor.tsx`). Building a
// different one here would compare the static renderer against an editor that does not ship.
const schema = getSchema(createRichTextEngineExtensions({
  blockExtensions: [OverlayTextBlockAttrs],
  drawBoxedRunFrames: false,
  enableMathDelimiters: true,
  listMarkerTypography: true,
  orderedListMarkerStyles: true,
  textBlockStyle: true,
}));

/** Attributes only the boxed-run measurement pass emits. See the file comment. */
const RUN_METADATA_ATTRIBUTES = [
  "data-boxed-run-connect-left",
  "data-boxed-run-connect-right",
  "data-boxed-run-height-target",
  "data-boxed-run-id",
  "data-boxed-run-segment-count",
  "data-boxed-run-segment-id",
  "data-boxed-run-segment-index",
  "data-boxed-run-style-key",
] as const;

interface NormalizedNode {
  attrs?: Record<string, string>;
  children?: NormalizedNode[];
  style?: Record<string, string>;
  tag?: string;
  text?: string;
}

interface DomLikeNode {
  childNodes: ArrayLike<DomLikeNode>;
  classList?: { contains: (name: string) => boolean };
  getAttribute?: (name: string) => null | string;
  getAttributeNames?: () => string[];
  nodeType: number;
  tagName?: string;
  textContent: null | string;
}

const CORPUS: Array<{ document: OverlayTextBlock[]; name: string }> = [
  {
    name: "plain paragraph",
    document: [{ type: "paragraph", id: "inline_dom_parity_test_1", children: [{ type: "text", text: "ふつうの段落" }] }],
  },
  {
    name: "headings, alignment and line height",
    document: [
        { type: "heading", id: "inline_dom_parity_test_2", level: 1, children: [{ type: "text", text: "見出し1" }] },
        { type: "heading", id: "inline_dom_parity_test_3", level: 2, align: "center", children: [{ type: "text", text: "見出し2" }] },
        { type: "paragraph", id: "inline_dom_parity_test_4", align: "right", lineHeight: "1.8", children: [{ type: "text", text: "右" }] },
      ],
  },
  {
    name: "bold, italic and underline",
    document: [{
        type: "paragraph", id: "inline_dom_parity_test_5",
        children: [
          { type: "text", text: "太字", marks: ["bold"] },
          { type: "text", text: "斜体", marks: ["italic"] },
          { type: "text", text: "下線", marks: ["underline"] },
          { type: "text", text: "全部", marks: ["bold", "italic", "underline"] },
        ],
      }],
  },
  {
    name: "one underline run across several nodes",
    document: [{
        type: "paragraph", id: "inline_dom_parity_test_6",
        children: [
          { type: "text", text: "ここから", marks: ["underline"] },
          { type: "text", text: "太字も", marks: ["underline", "bold"] },
          { type: "text", text: "ここまで", marks: ["underline"] },
          { type: "text", text: "そと" },
        ],
      }],
  },
  {
    name: "inline text styling",
    document: [{
        type: "paragraph", id: "inline_dom_parity_test_7",
        children: [{
          type: "text",
          text: "色つき",
          color: "#cc0000",
          backgroundColor: "#ffeeaa",
          fontFamily: '"Yu Mincho", serif',
          fontSize: 12.5,
        }],
      }],
  },
  {
    name: "boxed text",
    document: [{
        type: "paragraph", id: "inline_dom_parity_test_8",
        children: [
          { type: "text", text: "囲み", marks: ["boxed"], boxedPaddingY: 2 },
          { type: "text", text: "そと" },
        ],
      }],
  },
  {
    name: "boxed variants and tones",
    document: [{
        type: "paragraph", id: "inline_dom_parity_test_9",
        children: [
          { type: "text", text: "太枠", marks: ["boxed"], boxedVariant: "thick" },
          { type: "text", text: "二重", marks: ["boxed"], boxedVariant: "double", boxedPaddingY: 1.5 },
          { type: "text", text: "楕円", marks: ["boxed"], boxedVariant: "oval" },
          { type: "text", text: "網掛け", marks: ["boxed"], boxedVariant: "shade", boxedTone: "blue" },
          { type: "text", text: "既定", marks: ["boxed"], boxedVariant: "frame" },
        ],
      }],
  },
  {
    name: "boxed combined with the other inline marks",
    document: [{
        type: "paragraph", id: "inline_dom_parity_test_10",
        children: [
          {
            type: "text",
            text: "全部乗せ",
            marks: ["bold", "italic", "underline", "boxed"],
            boxedPaddingY: 3,
            boxedVariant: "thick",
            color: "#0000cc",
            fontSize: 14,
          },
        ],
      }],
  },
  {
    name: "a bullet list",
    document: [{
        type: "list", id: "inline_dom_parity_test_14",
        listType: "bullet",
        items: [
          { type: "listItem", id: "inline_dom_parity_test_15", children: [{ type: "text", text: "ひとつ" }] },
          { type: "listItem", id: "inline_dom_parity_test_16", children: [{ type: "text", text: "ふたつ", marks: ["bold"] }] },
        ],
      }],
  },
  {
    name: "hard breaks inside a marked run",
    document: [{
        type: "paragraph", id: "inline_dom_parity_test_11",
        children: [
          { type: "text", text: "いち\nに", marks: ["underline"] },
          { type: "text", text: "\nさん", marks: ["boxed"], boxedPaddingY: 1 },
          { type: "text", text: "よん\n", marks: ["bold"] },
        ],
      }],
  },
];

/**
 * The one shape of block the two projections do not agree on, recorded rather than hidden.
 *
 * The editing surface draws `li > p`; the static renderer draws `li > span[display:block]` and
 * puts the marker typography on the `li` from a measurement the editor makes at runtime. This is
 * not specific to shapes — the body has the same divergence and pins it the same way, with the
 * cost of closing it written down (`text-flow-static-parity.test.tsx`: aligning the static side on
 * `p` changes what print emits). `it.fails` means fixing it turns this red instead of leaving a
 * stale exception behind.
 */
const KNOWN_DIVERGENT = new Set(["a bullet list"]);

describe("overlay text projects the same DOM through Tiptap and the static renderer", () => {
  for (const { document: richText, name } of CORPUS) {
    if (KNOWN_DIVERGENT.has(name)) {
      it.fails(`still differs on ${name} (known divergence, as in the body)`, () => {
        expect(staticBlocks(richText)).toEqual(editorBlocks(richText));
      });
      continue;
    }
    it(`agrees on ${name}`, () => {
      expect(staticBlocks(richText)).toEqual(editorBlocks(richText));
    });
  }

  /**
   * What must agree for a list: the runs inside an item. The item's own wrapper is the known
   * divergence above; the inline projection is what this file exists to hold together.
   */
  it("agrees on the inline content inside a list item", () => {
    const richText: OverlayTextBlock[] = [{
      type: "list", id: "inline_dom_parity_test_17",
      listType: "bullet",
      items: [{
        type: "listItem", id: "inline_dom_parity_test_18",
        children: [
          { type: "text", text: "太字", marks: ["bold"] },
          { type: "text", text: "囲み", marks: ["boxed"], boxedPaddingY: 2 },
        ],
      }],
    }];

    expect(listItemInlineDom(staticBlocks(richText))).toEqual(listItemInlineDom(editorBlocks(richText)));
  });

  it("gives every drawn boxed fragment its own measurement identity, as the editor does", () => {
    // The measurement channel is the one thing the two sides build differently (see the file
    // comment), so what has to agree is how many things there are to measure. A `\n` inside boxed
    // text draws a frame on each line and ProseMirror sees two document targets, because the mark
    // span closes at its `hardBreak`; the static side splits its text node the same way and so has
    // to hand out two segment ids, not the entry's one. Sharing an id collapsed the two frames into
    // one entry of the alignment map and left the first line's frame stretched to the second's.
    const richText: OverlayTextBlock[] = [{
        type: "paragraph", id: "inline_dom_parity_test_12",
        children: [
          { type: "text", text: "あ\nい", marks: ["boxed"], boxedPaddingY: 2 },
          { type: "text", text: "う", marks: ["boxed"], boxedPaddingY: 2 },
        ],
      }];
    const block = schema.nodeFromJSON(overlayTextBlocksToTiptapDoc(richText)).firstChild;
    const editorTargets = block ? collectBoxedRunDocTargetsForTextBlock(block, 0) : [];

    // Run ids are keyed on the block's own id now that shape text goes through the body's static
    // block renderer, which is what makes them stable across a re-render of the same block.
    expect(boxedRunSegmentIds(renderStaticHtml(richText))).toEqual([
      "inline_dom_parity_test_12-boxed-run-0-segment-0-0-line-0",
      "inline_dom_parity_test_12-boxed-run-0-segment-0-0-line-1",
      "inline_dom_parity_test_12-boxed-run-0-segment-1-1",
    ]);
    expect(editorTargets).toHaveLength(3);
    // Only the fragment that really has a neighbour on its line claims the joint.
    expect(boxedRunConnections(renderStaticHtml(richText))).toEqual([
      { left: false, right: false },
      { left: false, right: true },
      { left: true, right: false },
    ]);
  });

  it("only ever drops the boxed-run measurement attributes when comparing", () => {
    // Guards the one documented gap: if the static renderer grows another extra attribute, the
    // comparison above must fail rather than silently ignore it.
    const richText: OverlayTextBlock[] = [{
        type: "paragraph", id: "inline_dom_parity_test_13",
        children: [{ type: "text", text: "囲み", marks: ["boxed"], boxedPaddingY: 2 }],
      }];
    expect(droppedAttributeNames(renderStaticHtml(richText)).sort())
      .toEqual([
        "data-boxed-run-height-target",
        "data-boxed-run-id",
        "data-boxed-run-segment-count",
        "data-boxed-run-segment-id",
        "data-boxed-run-segment-index",
        "data-boxed-run-style-key",
      ]);
  });
});

/** The runs inside the first list item, with each side's own item wrapper peeled off. */
function listItemInlineDom(blocks: NormalizedNode[]): NormalizedNode[] {
  const item = blocks[0]?.children?.[0];
  const wrapper = item?.children?.[0];
  return wrapper?.children ?? [];
}

/** The static renderer's blocks, with the wrappers only it has removed (see the file comment). */
function staticBlocks(richText: OverlayTextBlock[]): NormalizedNode[] {
  return normalizeHtml(renderStaticHtml(richText), { unwrapInlineContent: true });
}

/** Schema DOM plus the editor's derived typography decorations, which are not persisted. */
function editorBlocks(richText: OverlayTextBlock[]): NormalizedNode[] {
  const node = schema.nodeFromJSON(overlayTextBlocksToTiptapDoc(richText));
  const view = new EditorView(document.createElement("div"), {
    state: EditorState.create({ schema, doc: node, plugins: [createTextBlockTypographyPlugin()] }),
  });
  try {
    // ProseMirror's caret placeholder is outside the document projection (see scope above).
    view.dom.querySelectorAll("br.ProseMirror-trailingBreak").forEach((placeholder) => placeholder.remove());
    return normalizeHtml(view.dom.innerHTML, { unwrapInlineContent: false });
  } finally {
    view.destroy();
  }
}

function renderStaticHtml(richText: OverlayTextBlock[]): string {
  // The view wraps its blocks in the shape's content box; the comparison is per block, so the
  // wrapper is unwrapped here rather than given to the editor side to match.
  const html = renderToStaticMarkup(<OverlayTextBlocksView blocks={richText} />);
  return html.replace(/^<div class="overlay-text-shape-content">/, "").replace(/<\/div>$/, "");
}

function normalizeHtml(html: string, options: { unwrapInlineContent: boolean }): NormalizedNode[] {
  const window = new Window();
  const container = window.document.createElement("div");
  container.innerHTML = html;
  const nodes = Array.from(container.childNodes as unknown as ArrayLike<DomLikeNode>)
    .flatMap((node) => normalizeNode(node, options));
  window.close();
  return nodes;
}

function normalizeNode(node: DomLikeNode, options: { unwrapInlineContent: boolean }): NormalizedNode[] {
  if (node.nodeType === 3) {
    return node.textContent ? [{ text: node.textContent }] : [];
  }
  const element = node as Required<DomLikeNode>;
  const children = Array.from(element.childNodes).flatMap((child) => normalizeNode(child, options));
  // `.rich-inline-content` scopes math to the body font size for the surfaces that embed inline
  // runs at a smaller size (comments, AI chat). It is a wrapper the editor has no equivalent of,
  // and it carries no geometry of its own.
  if (options.unwrapInlineContent && element.classList.contains("rich-inline-content")) {
    return children;
  }

  const attrs: Record<string, string> = {};
  let style: Record<string, string> | undefined;
  for (const name of element.getAttributeNames().sort()) {
    if (isRunMetadataAttribute(name)) {
      continue;
    }
    const value = element.getAttribute(name) ?? "";
    if (name === "style") {
      style = parseStyle(value, { dropRunMetadata: true });
      continue;
    }
    attrs[name] = value;
  }
  return [{
    tag: element.tagName.toLowerCase(),
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(style && Object.keys(style).length > 0 ? { style } : {}),
    children,
  }];
}

function isRunMetadataAttribute(name: string): boolean {
  return (RUN_METADATA_ATTRIBUTES as readonly string[]).includes(name);
}

/** The `data-boxed-run-segment-id` of every boxed span in the markup, in document order. */
function boxedRunSegmentIds(html: string): string[] {
  return boxedRunElements(html).map((element) => element.getAttribute("data-boxed-run-segment-id") ?? "");
}

function boxedRunConnections(html: string): Array<{ left: boolean; right: boolean }> {
  return boxedRunElements(html).map((element) => ({
    left: element.getAttribute("data-boxed-run-connect-left") === "true",
    right: element.getAttribute("data-boxed-run-connect-right") === "true",
  }));
}

function boxedRunElements(html: string): Array<Required<DomLikeNode>> {
  const window = new Window();
  const container = window.document.createElement("div");
  container.innerHTML = html;
  const found: Array<Required<DomLikeNode>> = [];
  const visit = (node: DomLikeNode) => {
    if (node.nodeType === 1 && (node as Required<DomLikeNode>).getAttribute("data-boxed-run-segment-id")) {
      found.push(node as Required<DomLikeNode>);
    }
    Array.from(node.childNodes).forEach(visit);
  };
  Array.from(container.childNodes as unknown as ArrayLike<DomLikeNode>).forEach(visit);
  window.close();
  return found;
}

function droppedAttributeNames(html: string): string[] {
  const window = new Window();
  const container = window.document.createElement("div");
  container.innerHTML = html;
  const dropped = new Set<string>();
  const visit = (node: DomLikeNode) => {
    if (node.nodeType === 1) {
      const element = node as Required<DomLikeNode>;
      for (const name of element.getAttributeNames()) {
        if (isRunMetadataAttribute(name)) {
          dropped.add(name);
        }
      }
    }
    Array.from(node.childNodes).forEach(visit);
  };
  Array.from(container.childNodes as unknown as ArrayLike<DomLikeNode>).forEach(visit);
  window.close();
  return [...dropped];
}

function parseStyle(value: string, options: { dropRunMetadata: boolean }): Record<string, string> {
  const declarations: Record<string, string> = {};
  for (const declaration of value.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) {
      continue;
    }
    const property = declaration.slice(0, separator).trim();
    const propertyValue = declaration.slice(separator + 1).trim();
    if (!property || (options.dropRunMetadata && property.startsWith("--boxed-run-"))) {
      continue;
    }
    declarations[property] = propertyValue;
  }
  return Object.fromEntries(Object.entries(declarations).sort(([a], [b]) => a.localeCompare(b)));
}
