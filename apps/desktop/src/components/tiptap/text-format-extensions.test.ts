import { getSchema } from "@tiptap/core";
import { DOMParser, DOMSerializer } from "@tiptap/pm/model";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";

import { InlineMathExtension } from "@/components/tiptap/inline-math-extension";
import { createRichTextEngineExtensions } from "@/components/tiptap/rich-text-engine";
import { UnderlineExtension, updateInlineMarkInSelection } from "@/components/tiptap/text-format-extensions";

const schema = getSchema([
  UnderlineExtension,
  StarterKit.configure({
    undoRedo: false,
    underline: false,
  }),
  InlineMathExtension,
]);

describe("text format extensions", () => {
  it("toggles underline over text and inline math in one selection", () => {
    const underline = schema.marks.underline;
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("a"),
        schema.nodes.mathInline.create({ id: "m1", tex: "x^2" }),
        schema.text("b"),
      ]),
    ]);
    let state = EditorState.create({
      doc,
      selection: TextSelection.create(doc, 1, 4),
    });

    expect(updateInlineMarkInSelection(state, (tr) => {
      state = state.apply(tr);
    }, "underline", {}, "toggle")).toBe(true);
    expect(paragraphMarkNames(state)).toEqual([["underline"], ["underline"], ["underline"]]);

    expect(updateInlineMarkInSelection(state, (tr) => {
      state = state.apply(tr);
    }, "underline", {}, "toggle")).toBe(true);
    expect(paragraphMarkNames(state)).toEqual([[], [], []]);
    expect(underline.isInSet(state.doc.firstChild?.child(1).marks ?? [])).toBeUndefined();
  });

  it("ranks underline outside bold/italic so mixed italic text + math can share one run", () => {
    // User fixture: italic+underline on CJK, underline-only on math (sa^2, ∑).
    // ProseMirror nests lower-rank marks outside higher-rank ones. If underline
    // nests inside em, each italic boundary splits the underline DOM and ^2
    // segments get a different stroke height from the surrounding 和文.
    const engineSchema = getSchema(createRichTextEngineExtensions({ enableMathDelimiters: true }));
    const italic = engineSchema.marks.italic;
    const bold = engineSchema.marks.bold;
    const underline = engineSchema.marks.underline;
    expect(underline).toBeTruthy();
    expect(italic).toBeTruthy();
    expect(bold).toBeTruthy();
    expect(markRank(underline)).toBeLessThan(markRank(italic));
    expect(markRank(underline)).toBeLessThan(markRank(bold));
  });

  it("ranks the inline chrome the way the static projection nests it", () => {
    // The static renderer nests the wrappers in a fixed order (`rich-text-dom.ts`): the underline
    // run outermost, then the styled span, then the box, then `<strong>`/`<em>`. ProseMirror nests
    // by mark rank, so the ranks have to agree — a box that sits inside `<strong>` in the editor
    // and outside it in the static twin changes the drawing on focus, and a styled font size
    // inside the box makes the box's `em` padding scale differently in the two.
    const engineSchema = getSchema(createRichTextEngineExtensions({ enableMathDelimiters: true }));
    const ranks = ["underline", "styledText", "boxed", "bold", "italic"]
      .map((name) => markRank(engineSchema.marks[name]));

    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(new Set(ranks).size).toBe(ranks.length);
  });

  it("renders the boxed mark through the shared inline projection", () => {
    const engineSchema = getSchema(createRichTextEngineExtensions({ enableMathDelimiters: true }));
    const boxed = engineSchema.marks.boxed.create({
      math: true,
      paddingY: 2,
      tone: "blue",
      variant: "shade",
    });

    expect(engineSchema.marks.boxed.spec.toDOM?.(boxed, true)).toEqual([
      "span",
      {
        class: "boxed-text boxed-inline-math",
        "data-sigma-doc-boxed-text": "true",
        "data-sigma-doc-boxed-padding-y": "2",
        "data-sigma-doc-boxed-variant": "shade",
        "data-sigma-doc-boxed-tone": "blue",
        "data-sigma-doc-boxed-math": "true",
        style: "--boxed-text-padding-y: 2px; --boxed-text-line-height: calc(1.78em + 6px)",
      },
      0,
    ]);
  });

  it("renders the styled mark as one declaration list, in the static renderer's order", () => {
    const engineSchema = getSchema(createRichTextEngineExtensions({ enableMathDelimiters: true }));
    const styled = engineSchema.marks.styledText.create({
      backgroundColor: "#ffeeaa",
      color: "#cc0000",
      fontFamily: '"Yu Mincho", serif',
      fontSize: 12.5,
    });

    expect(engineSchema.marks.styledText.spec.toDOM?.(styled, true)).toEqual([
      "span",
      { style: 'color: #cc0000; background-color: #ffeeaa; font-family: "Yu Mincho", serif; --sigma-math-text-font-family: "Yu Mincho", serif; font-size: 12.5pt' },
      0,
    ]);
  });

  it("parses its own serialized boxed span back into a boxed mark", () => {
    // The clipboard round-trips through the schema's own HTML: ProseMirror serializes the selection
    // and re-parses it on paste. `styledText` matches a bare `<span>`, so if its parse rule is tried
    // before the boxed rules the box is silently replaced by an empty styling mark — copying a boxed
    // word and pasting it back loses the frame. The same HTML now also comes out of the static
    // renderer, so pasting from a rendered page or the viewer has to survive too.
    const engineSchema = getSchema(createRichTextEngineExtensions({ enableMathDelimiters: true }));
    const window = new Window();
    const container = window.document.createElement("div");
    const boxed = engineSchema.marks.boxed.create({ paddingY: 2, variant: "double", tone: "blue" });
    DOMSerializer.fromSchema(engineSchema).serializeFragment(
      engineSchema.nodes.paragraph.create(null, engineSchema.text("箱", [boxed])).content,
      { document: window.document as unknown as Document },
      container as unknown as HTMLElement,
    );

    const parsed = DOMParser.fromSchema(engineSchema).parse(container as unknown as Node);
    const marks = parsed.firstChild?.firstChild?.marks.map((mark) => ({ attrs: mark.attrs, type: mark.type.name }));
    window.close();

    expect(marks).toEqual([
      // `math` parses as a boolean rather than staying null; unchanged pre-existing behaviour.
      { attrs: { math: false, paddingY: 2, tone: "blue", variant: "double" }, type: "boxed" },
    ]);
  });

  it("renders underline with the Sigma continuous-run span", () => {
    const engineSchema = getSchema(createRichTextEngineExtensions({ enableMathDelimiters: true }));
    const underline = engineSchema.marks.underline.create();
    const domSpec = engineSchema.marks.underline.spec.toDOM?.(underline, true);

    expect(domSpec).toEqual([
      "span",
      { class: "sigma-underline-run", "data-sigma-doc-underline-text": "true" },
      0,
    ]);
  });
});

function paragraphMarkNames(state: EditorState): string[][] {
  const paragraph = state.doc.firstChild;
  if (!paragraph) {
    return [];
  }
  const names: string[][] = [];
  paragraph.forEach((node) => {
    names.push(node.marks.map((mark) => mark.type.name));
  });
  return names;
}

function markRank(mark: unknown): number {
  const rank = (mark as { rank?: unknown }).rank;
  expect(typeof rank).toBe("number");
  return rank as number;
}
