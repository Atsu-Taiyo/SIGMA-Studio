import { describe, expect, it } from "vitest";

import type {
  InlineNode,
  ParagraphNode,
  SigmaBlock,
  SigmaDocument,
} from "@/features/document";
import {
  countTextMatches,
  replaceInDocument,
  updateInlineMathTexInDocument,
} from "@/features/text-editing";

function paragraph(id: string, children: InlineNode[]): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children,
  };
}

function documentWith(content: SigmaBlock[]): SigmaDocument {
  return {
    version: "2.0",
    docId: "document-text-mutations-test",
    metadata: { title: "本文変更" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}

function nestedMutationDocument(): SigmaDocument {
  return documentWith([
    paragraph("top", [
      { type: "text", text: "target target" },
      { id: "top-math", type: "mathInline", tex: "target", display: "inline" },
    ]),
    {
      id: "problem",
      type: "problem",
      tags: [],
      lead: [],
      prompt: [{
        id: "problem-layout",
        type: "layoutSection",
        layout: { columnCount: 2 },
        children: [{
          id: "problem-box",
          type: "boxBlock",
          styleId: "frame",
          title: [{ type: "text", text: "target" }],
          blocks: [{
            id: "problem-list",
            type: "list",
            listType: "bullet",
            items: [{
              id: "problem-list-item",
              type: "listItem",
              children: [
                { type: "text", text: "target" },
                {
                  id: "nested-math",
                  type: "mathInline",
                  tex: "old_tex",
                  display: "inline",
                },
              ],
            }],
          }],
        }],
      }],
      hints: [],
      solution: [],
    },
    {
      id: "top-layout",
      type: "layoutSection",
      layout: { columnCount: 2 },
      children: [paragraph("top-layout-paragraph", [{ type: "text", text: "target" }])],
    },
    {
      id: "top-box",
      type: "boxBlock",
      styleId: "frame",
      title: [{ type: "text", text: "target" }],
      blocks: [paragraph("top-box-paragraph", [{ type: "text", text: "target" }])],
    },
    {
      id: "top-list",
      type: "list",
      listType: "bullet",
      items: [{
        id: "top-list-item",
        type: "listItem",
        children: [{ type: "text", text: "target" }],
      }],
    },
  ]);
}

describe("document text mutations", () => {
  it("updates inline math through problem, layout, box, and list nesting", () => {
    const original = nestedMutationDocument();

    const result = updateInlineMathTexInDocument(
      original,
      "nested-math",
      "new_tex",
      { now: () => "2026-07-25T01:00:00.000Z" },
    );

    expect(result).not.toBe(original);
    expect(result.updatedAt).toBe("2026-07-25T01:00:00.000Z");
    expect(JSON.stringify(result)).toContain('"id":"nested-math","type":"mathInline","tex":"new_tex"');
    expect(JSON.stringify(original)).toContain('"id":"nested-math","type":"mathInline","tex":"old_tex"');
  });

  it("replaces only the first text occurrence while preserving math TeX", () => {
    const original = documentWith([
      paragraph("first", [
        { type: "text", text: "target target" },
        { id: "math", type: "mathInline", tex: "target", display: "inline" },
      ]),
      paragraph("second", [{ type: "text", text: "target" }]),
    ]);

    const result = replaceInDocument(
      original,
      "target",
      "done",
      false,
      { now: () => "2026-07-25T02:00:00.000Z" },
    );

    expect(result.content[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", text: "done target" },
        { id: "math", type: "mathInline", tex: "target" },
      ],
    });
    expect(result.content[1]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "target" }],
    });
    expect(result.updatedAt).toBe("2026-07-25T02:00:00.000Z");
  });

  it("replaces all text across top-level, problem, layout, box, and list content", () => {
    const original = nestedMutationDocument();

    const result = replaceInDocument(
      original,
      "target",
      "done",
      true,
      { now: () => "2026-07-25T03:00:00.000Z" },
    );

    expect(countTextMatches(original.content, "target")).toBe(9);
    expect(countTextMatches(result.content, "target")).toBe(1);
    expect(countTextMatches(result.content, "done")).toBe(8);
    expect(JSON.stringify(result)).toContain('"id":"top-math","type":"mathInline","tex":"target"');
    expect(result.updatedAt).toBe("2026-07-25T03:00:00.000Z");
  });

  it("preserves the document reference and does not read the clock when nothing changes", () => {
    const original = nestedMutationDocument();
    const now = () => {
      throw new Error("clock is not expected");
    };

    expect(updateInlineMathTexInDocument(
      original,
      "missing",
      "new_tex",
      { now },
    )).toBe(original);
    expect(updateInlineMathTexInDocument(
      original,
      "nested-math",
      "old_tex",
      { now },
    )).toBe(original);
    expect(replaceInDocument(
      original,
      "missing",
      "done",
      true,
      { now },
    )).toBe(original);
    expect(replaceInDocument(
      original,
      "  ",
      "done",
      true,
      { now },
    )).toBe(original);
  });
});
