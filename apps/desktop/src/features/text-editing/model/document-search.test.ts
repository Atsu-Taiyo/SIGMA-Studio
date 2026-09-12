import { describe, expect, it } from "vitest";

import type { SigmaBlock } from "@/features/document";
import {
  countTextMatches,
  findFirstBlockWithText,
} from "@/features/text-editing";

function searchableContent(): SigmaBlock[] {
  return [
    {
      id: "top-section",
      type: "section",
      title: "top needle",
    },
    {
      id: "problem",
      type: "problem",
      tags: [],
      lead: [paragraph("problem-lead", "problem needle")],
      prompt: [{
        id: "problem-layout",
        type: "layoutSection",
        layout: { columnCount: 2 },
        children: [
          {
            id: "problem-layout-section",
            type: "section",
            title: "layout needle",
          },
          {
            id: "problem-box",
            type: "boxBlock",
            styleId: "frame",
            title: [{ type: "text", text: "box needle" }],
            blocks: [{
              id: "problem-list",
              type: "list",
              listType: "bullet",
              items: [{
                id: "problem-item",
                type: "listItem",
                children: [{ type: "text", text: "list needle" }],
                nested: [{
                  id: "problem-nested-list",
                  type: "list",
                  listType: "bullet",
                  items: [{
                    id: "problem-nested-item",
                    type: "listItem",
                    children: [{ type: "text", text: "nested needle" }],
                  }],
                }],
              }],
            }],
          },
        ],
      }],
      hints: [],
      solution: [],
    },
    {
      id: "top-layout",
      type: "layoutSection",
      layout: { columnCount: 2 },
      children: [paragraph("top-layout-paragraph", "top layout needle")],
    },
    {
      id: "top-box",
      type: "boxBlock",
      styleId: "frame",
      title: [{ type: "text", text: "top box needle" }],
      blocks: [paragraph("top-box-paragraph", "box body needle")],
    },
    {
      id: "top-list",
      type: "list",
      listType: "bullet",
      items: [{
        id: "top-list-item",
        type: "listItem",
        children: [{
          id: "top-list-math",
          type: "mathInline",
          tex: "needle_tex",
          display: "inline",
        }],
      }],
    },
  ];
}

function paragraph(
  id: string,
  text: string,
): Extract<SigmaBlock, { type: "paragraph" }> {
  return {
    id,
    type: "paragraph",
    children: [{ type: "text", text }],
  };
}

describe("document search model", () => {
  it("finds text through top-level, problem, layout, box, and nested list blocks", () => {
    const content = searchableContent();

    expect(findFirstBlockWithText(content, "top needle", null, "next")?.id)
      .toBe("top-section");
    expect(findFirstBlockWithText(content, "problem needle", null, "next")?.id)
      .toBe("problem-lead");
    expect(findFirstBlockWithText(content, "layout needle", null, "next")?.id)
      .toBe("problem-layout-section");
    expect(findFirstBlockWithText(content, "box needle", null, "next")?.id)
      .toBe("problem-box");
    expect(findFirstBlockWithText(content, "list needle", null, "next")?.id)
      .toBe("problem-item");
    expect(findFirstBlockWithText(content, "nested needle", null, "next")?.id)
      .toBe("problem-nested-item");
    expect(findFirstBlockWithText(content, "top layout needle", null, "next")?.id)
      .toBe("top-layout-paragraph");
    expect(findFirstBlockWithText(content, "box body needle", null, "next")?.id)
      .toBe("top-box-paragraph");
  });

  it("includes inline math TeX in search text and match counts", () => {
    const content = searchableContent();

    expect(findFirstBlockWithText(content, "needle_tex", null, "next")?.id)
      .toBe("top-list-item");
    expect(countTextMatches(content, "needle")).toBe(10);
  });

  it("wraps next and previous search around the flattened document order", () => {
    const content = searchableContent();

    expect(findFirstBlockWithText(content, "needle", "top-list-item", "next")?.id)
      .toBe("top-section");
    expect(findFirstBlockWithText(content, "needle", "top-section", "previous")?.id)
      .toBe("top-list-item");
  });

  it("treats blank and missing queries as no matches", () => {
    const content = searchableContent();

    expect(findFirstBlockWithText(content, "  ", null, "next")).toBeNull();
    expect(findFirstBlockWithText(content, "missing", null, "next")).toBeNull();
    expect(countTextMatches(content, "  ")).toBe(0);
    expect(countTextMatches(content, "missing")).toBe(0);
  });
});
