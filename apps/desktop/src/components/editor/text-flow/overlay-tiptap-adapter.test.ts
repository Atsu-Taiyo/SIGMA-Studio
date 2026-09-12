import { describe, expect, it } from "vitest";

import {
  DEFAULT_SERIF_BODY_FONT_FAMILY,
  LEGACY_STANDARD_SERIF_FONT_FAMILY,
  type OverlayTextBlock,
} from "@/features/document";
import type { TiptapDoc } from "@/lib/tiptap-adapter";

import {
  overlayTextBlocksToTiptapDoc,
  tiptapDocToOverlayTextBlocks,
} from "./overlay-tiptap-adapter";

/**
 * A shape's content is the body's content, so it goes through the body's converter. What is pinned
 * here is that nothing is lost on the way: the structure the body can express (lists, nesting, the
 * blocks that continue an item) survives a round trip, and block identity survives an edit.
 */
describe("a shape's blocks through the editor", () => {
  it("projects legacy standard Mincho marks to the bundled editor font", () => {
    const document: OverlayTextBlock[] = [{
        type: "paragraph", id: "tiptap_adapter_test_60",
        children: [{ type: "text", text: "明朝", fontFamily: LEGACY_STANDARD_SERIF_FONT_FAMILY }],
      }];

    expect(overlayTextBlocksToTiptapDoc(document).content[0].content?.[0].marks).toContainEqual({
      type: "styledText",
      attrs: {
        color: undefined,
        backgroundColor: undefined,
        fontFamily: DEFAULT_SERIF_BODY_FONT_FAMILY,
        fontSize: undefined,
      },
    });
  });

  it("round-trips semantic overlay rich text through an editor-only Tiptap document", () => {
    const overlayDocument: OverlayTextBlock[] = [
        {
          type: "paragraph", id: "tiptap_adapter_test_61",
          children: [
            {
              type: "text",
              text: "本文\n",
              marks: ["bold", "boxed"],
            },
            {
              type: "mathInline",
              id: "math_overlay",
              tex: "x^2+1",
              display: "inline",
              marks: ["underline"],
              backgroundColor: "#fff3c2",
              fontSize: 13.5,
              semanticRole: "expression",
            },
          ],
        },
        {
          type: "heading", id: "tiptap_adapter_test_62",
          level: 2,
          align: "right",
          lineHeight: "1.5",
          children: [{ type: "text", text: "見出し", marks: ["italic"] }],
        },
      ];

    const tiptapDocument = overlayTextBlocksToTiptapDoc(overlayDocument);
    // The editor JSON carries no block ids, so the round trip is given the blocks it started from
    // and takes the ids back from them by position — typing inside a block must not rename it.
    const restored = tiptapDocToOverlayTextBlocks(tiptapDocument, overlayDocument);

    expect(tiptapDocument).not.toBe(overlayDocument);
    expect(tiptapDocument).toMatchObject({
      type: "doc",
      content: [
        { type: "paragraph" },
        { type: "heading", attrs: { level: 2, textAlign: "right", lineHeight: "1.5" } },
      ],
    });
    expect(restored).toEqual(overlayDocument);
  });

  /**
   * Identity travels in the node's own attrs, not by position: typing in a block keeps its id, and
   * a block inserted before it does not shift everything after it onto someone else's identity.
   * Everything keyed on that id — React subtrees, comment anchors, the boxed-run measurement map —
   * is rebuilt when it changes, so a keystroke must not change it.
   */
  it("keeps a block's identity through an edit, and mints one only for a new block", () => {
    const blocks: OverlayTextBlock[] = [
      { type: "paragraph", id: "p_first", children: [{ type: "text", text: "一" }] },
      { type: "paragraph", id: "p_second", children: [{ type: "text", text: "二" }] },
    ];
    const doc = overlayTextBlocksToTiptapDoc(blocks);

    // The author types into the second block, and adds a third one above it with no id of its own.
    const edited: TiptapDoc = {
      type: "doc",
      content: [
        doc.content[0],
        { type: "paragraph", content: [{ type: "text", text: "あいだ" }] },
        {
          ...doc.content[1],
          content: [{ type: "text", text: "二ばん" }],
        },
      ],
    };

    const restored = tiptapDocToOverlayTextBlocks(edited, blocks);

    expect(restored.map((block) => block.id)).toEqual([
      "p_first",
      expect.not.stringMatching(/^p_(?:first|second)$/) as unknown as string,
      "p_second",
    ]);
    expect(restored[2]).toMatchObject({ children: [{ type: "text", text: "二ばん" }] });
  });

  it("round-trips a nested list and the blocks that continue an item", () => {
    const blocks: OverlayTextBlock[] = [{
      type: "list",
      id: "list_1",
      listType: "bullet",
      items: [{
        type: "listItem",
        id: "li_1",
        children: [{ type: "text", text: "親" }],
        continuations: [
          { type: "paragraph", id: "p_cont", children: [{ type: "text", text: "続き" }] },
          { type: "divider", id: "divider_cont" },
        ],
        nested: [{
          type: "list",
          id: "list_2",
          listType: "ordered",
          items: [{ type: "listItem", id: "li_2", children: [{ type: "text", text: "子" }] }],
        }],
      }],
    }];

    const restored = tiptapDocToOverlayTextBlocks(overlayTextBlocksToTiptapDoc(blocks), blocks);

    expect(restored).toEqual(blocks);
  });

  /**
   * Typing `- ` in a shape has always produced a list — the editing schema never disabled them —
   * and the shape's old converter answered by throwing, from inside `onUpdate`, where nothing
   * catches it. Keeping the list is the fix; this is the case that used to break the editor.
   */
  it("keeps a list the author typed instead of refusing the document", () => {
    const typed = {
      type: "doc",
      content: [{
        type: "bulletList",
        content: [{
          type: "listItem",
          content: [{ type: "paragraph", content: [{ type: "text", text: "項目" }] }],
        }],
      }],
    } as TiptapDoc;

    const restored = tiptapDocToOverlayTextBlocks(typed);

    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({
      type: "list",
      listType: "bullet",
      items: [{ type: "listItem", children: [{ type: "text", text: "項目" }] }],
    });
  });

  /**
   * A node type the shape's schema cannot produce is dropped rather than thrown on. This runs
   * inside `onUpdate`, so throwing takes the editor down with it — and the surrounding blocks the
   * author *can* see are worth keeping.
   */
  it("drops a block type the shape cannot hold, keeping the rest", () => {
    const withUnsupported = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "のこる" }] },
        { type: "table", content: [] },
      ],
    } as TiptapDoc;

    const restored = tiptapDocToOverlayTextBlocks(withUnsupported);

    expect(restored).toHaveLength(1);
    expect(restored[0]).toMatchObject({ type: "paragraph", children: [{ type: "text", text: "のこる" }] });
  });


  /**
   * Quote, code and divider are the body's, and now the shape's. The whole point of putting a
   * shape's text on the body's converter is that a block the editor can create survives being
   * saved and read back — a type the converter flattened into a paragraph would lose its meaning
   * on the first keystroke after it was typed.
   */
  it.each([
    ["a quote", {
      type: "quote",
      id: "quote_1",
      blocks: [{ type: "paragraph", id: "quote_p", children: [{ type: "text", text: "引用" }] }],
    }],
    // A registered highlight.js name: the converter drops one it cannot colour, which would make
    // this a round trip of a different block.
    ["a code block", {
      type: "codeBlock",
      id: "code_1",
      language: "typescript",
      children: [{ type: "text", text: "const a = 1;" }],
    }],
    ["a divider", { type: "divider", id: "divider_1" }],
  ] as const)("round-trips %s a shape now holds", (_name, block) => {
    const document = [
      { type: "paragraph", id: "p_before", children: [{ type: "text", text: "まえ" }] },
      block,
      { type: "paragraph", id: "p_after", children: [{ type: "text", text: "あと" }] },
    ] as OverlayTextBlock[];

    const restored = tiptapDocToOverlayTextBlocks(overlayTextBlocksToTiptapDoc(document), document);

    expect(restored).toEqual(document);
  });
});
