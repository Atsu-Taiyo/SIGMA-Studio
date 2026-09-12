import { describe, expect, it } from "vitest";

import { createBoxBlock } from "@/lib/box-blocks";
import {
  collectBlocksById,
  collectOutline,
  collectOverlayShapeOutline,
  collectProblemAreaBlockLocations,
  createLayoutSection,
  createParagraph,
  deleteBlocksFromDocument,
  duplicateTopLevelBlock,
  ensureBodyBlockAfterProblem,
  ensureEditableBody,
  findBlock,
  findContainingBoxBlock,
  findContainingLayoutSection,
  findContainingProblem,
  findProblemAreaBlockLocation,
  insertRichBlockNearSelection,
  insertTopLevelBlock,
  insertTopLevelBlockReplacingEmptySelection,
  insertBlockAtSelection,
  isOverlayShapeId,
  moveBlocksInDocument,
  removeBlockFromDocument,
  resolveTextFlowBlockRangeIds,
  unwrapLayoutSection,
  updateBlockInDocument,
  wrapTextFlowBlockInLayoutSection,
  wrapTextFlowBlocksInLayoutSection,
} from "@/lib/document-tree";
import { createGraphShapeProps } from "@/components/editor/overlay-canvas/shapes/graph";
import { ensurePageLayout } from "@/lib/page-layout";
import { getDefaultPageLayout, type OverlayShape, type OverlayTableShape, type OverlayTextShape } from "@/features/document";
import { getLayoutSectionColumns } from "@/features/text-editing";
import type { ListNode, SigmaDocument, ParagraphNode, ProblemNode } from "@/types/sigma-doc";

const paragraph = (id: string, text: string): ParagraphNode => ({
  type: "paragraph",
  id,
  children: [{ type: "text", text }],
});

const baseDocument: SigmaDocument = {
  version: "2.0",
  docId: "doc_test",
  metadata: {
    title: "Test",
  },
  outputProfiles: {
    student: {},
    teacher: {},
    answerBook: {},
  },
  content: [
    {
      type: "problem",
      id: "problem_1",
      tags: [],
      lead: [],
      prompt: [paragraph("prompt_1", "prompt 1"), paragraph("prompt_2", "prompt 2")],
      solution: [paragraph("solution_1", "solution 1")],
      hints: [],
    },
  ],
};

const problem = (id: string): ProblemNode => ({
  type: "problem",
  id,
  tags: [],
  lead: [],
  prompt: [paragraph(`${id}_prompt`, "problem prompt")],
  solution: [],
  hints: [],
});

describe("document tree", () => {
  it("inserts a rich block after the selected block inside a problem area", () => {
    const inserted = createParagraph("inserted");
    const next = insertRichBlockNearSelection(baseDocument, "prompt_1", inserted);
    const problem = next?.content[0];

    expect(problem?.type).toBe("problem");
    if (problem?.type !== "problem") {
      return;
    }

    expect(problem.prompt.map((block) => block.id)).toEqual(["prompt_1", inserted.id, "prompt_2"]);
    expect(problem.solution.map((block) => block.id)).toEqual(["solution_1"]);
  });

  it("appends a rich block to the prompt when the problem block itself is selected", () => {
    const inserted = createParagraph("inserted");
    const next = insertRichBlockNearSelection(baseDocument, "problem_1", inserted);
    const problem = next?.content[0];

    expect(problem?.type).toBe("problem");
    if (problem?.type !== "problem") {
      return;
    }

    expect(problem.prompt.map((block) => block.id)).toEqual(["prompt_1", "prompt_2", inserted.id]);
  });

  it("inserts a top-level block after the owner problem when a problem area block is selected", () => {
    const inserted = createParagraph("inserted");
    const next = insertTopLevelBlock(baseDocument, inserted, "solution_1");

    expect(next.content.map((block) => block.id)).toEqual(["problem_1", inserted.id]);
  });

  it("replaces the selected empty top-level text block when inserting a top-level block", () => {
    const inserted = problem("problem_inserted");
    const next = insertTopLevelBlockReplacingEmptySelection({
      ...baseDocument,
      content: [paragraph("empty", "   "), paragraph("after", "after")],
    }, inserted, "empty");

    expect(next.content.map((block) => block.id)).toEqual(["problem_inserted", "after"]);
  });

  it("keeps the existing after-selection behavior when the selected top-level text block is not empty", () => {
    const inserted = problem("problem_inserted");
    const next = insertTopLevelBlockReplacingEmptySelection({
      ...baseDocument,
      content: [paragraph("before", "before"), paragraph("after", "after")],
    }, inserted, "before");

    expect(next.content.map((block) => block.id)).toEqual(["before", "problem_inserted", "after"]);
  });

  it("adds an empty body paragraph immediately after a problem when no text flow block follows it", () => {
    const { document: next, bodyBlock } = ensureBodyBlockAfterProblem(baseDocument, "problem_1");

    expect(bodyBlock).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "" }],
    });
    expect(next.content.map((block) => block.id)).toEqual(["problem_1", bodyBlock?.id]);
  });

  it("inserts a menu problem in the innermost box and keeps its following caret paragraph there", () => {
    const document: SigmaDocument = { ...baseDocument, content: [{
      type: "boxBlock", id: "outer", styleId: "fancybox", blocks: [{
        type: "boxBlock", id: "inner", styleId: "fancybox", blocks: [paragraph("empty", "")],
      }],
    }] };
    const inserted = insertBlockAtSelection(document, problem("nested"), "empty", { replaceEmpty: true });
    const { document: next, bodyBlock } = ensureBodyBlockAfterProblem(inserted, "nested");
    expect(next.content).toHaveLength(1);
    expect(findBlock(next, "inner")).toMatchObject({ blocks: [{ id: "nested", type: "problem" }, { id: bodyBlock?.id, type: "paragraph" }] });
    expect(findBlock(next, "empty")).toBeNull();
    expect(findBlock(document, "empty")).not.toBeNull();
  });

  it("keeps the document unchanged when a text flow block already follows the problem", () => {
    const document = {
      ...baseDocument,
      content: [problem("problem_inserted"), paragraph("after", "after")],
    };

    const result = ensureBodyBlockAfterProblem(document, "problem_inserted");

    expect(result.bodyBlock).toBeNull();
    expect(result.document).toBe(document);
  });

  it("keeps unchanged top-level block references when updating one block", () => {
    const before = paragraph("before", "before");
    const target = paragraph("target", "target");
    const after = problem("after_problem");
    const document = {
      ...baseDocument,
      content: [before, target, after],
    };

    const next = updateBlockInDocument(document, "target", (block) => (
      block.type === "paragraph" ? { ...block, align: "center" } : block
    ));

    expect(next).not.toBe(document);
    expect(next.content[0]).toBe(before);
    expect(next.content[1]).not.toBe(target);
    expect(next.content[2]).toBe(after);
  });

  it("keeps unchanged nested problem area references when updating one rich block", () => {
    const next = updateBlockInDocument(baseDocument, "prompt_1", (block) => (
      block.type === "paragraph" ? { ...block, align: "right" } : block
    ));
    const previousProblem = baseDocument.content[0];
    const nextProblem = next.content[0];

    expect(nextProblem).not.toBe(previousProblem);
    if (previousProblem.type !== "problem" || nextProblem.type !== "problem") {
      return;
    }
    expect(nextProblem.prompt[0]).not.toBe(previousProblem.prompt[0]);
    expect(nextProblem.prompt[1]).toBe(previousProblem.prompt[1]);
    expect(nextProblem.solution).toBe(previousProblem.solution);
    expect(nextProblem.lead).toBe(previousProblem.lead);
    expect(nextProblem.hints).toBe(previousProblem.hints);
  });

  it("returns the same document when the target block is missing", () => {
    const next = updateBlockInDocument(baseDocument, "missing", (block) => block);

    expect(next).toBe(baseDocument);
  });

  it("adds the body paragraph directly after the problem even when text flow exists farther below", () => {
    const document = {
      ...baseDocument,
      content: [problem("problem_inserted"), problem("problem_next"), paragraph("after", "after")],
    };

    const { document: next, bodyBlock } = ensureBodyBlockAfterProblem(document, "problem_inserted");

    expect(next.content.map((block) => block.id)).toEqual([
      "problem_inserted",
      bodyBlock?.id,
      "problem_next",
      "after",
    ]);
  });

  it("finds the owner problem when a rich block inside the problem is selected", () => {
    expect(findContainingProblem(baseDocument, "prompt_1")?.id).toBe("problem_1");
    expect(findContainingProblem(baseDocument, "problem_1")?.id).toBe("problem_1");
    expect(findContainingProblem(baseDocument, null)).toBeNull();
  });

  it("resolves problem area ownership from rich block ids", () => {
    expect(findProblemAreaBlockLocation(baseDocument, "prompt_1")).toEqual({
      problemId: "problem_1",
      area: "prompt",
      blockId: "prompt_1",
    });
    expect(findProblemAreaBlockLocation(baseDocument, "solution_1")).toEqual({
      problemId: "problem_1",
      area: "solution",
      blockId: "solution_1",
    });
    expect(findProblemAreaBlockLocation(baseDocument, "problem_1")).toBeNull();

    expect(Array.from(collectProblemAreaBlockLocations(baseDocument).keys())).toEqual([
      "prompt_1",
      "prompt_2",
      "solution_1",
    ]);
  });

  it("wraps a top-level text block in a layout section and can unwrap it", () => {
    const document = {
      ...baseDocument,
      content: [paragraph("before", "before"), paragraph("target", "target"), paragraph("after", "after")],
    };

    const wrapped = wrapTextFlowBlockInLayoutSection(document, "target", 3);
    expect(wrapped.content.map((block) => block.type)).toEqual(["paragraph", "layoutSection", "paragraph"]);
    const section = wrapped.content[1];
    expect(section).toMatchObject({
      type: "layoutSection",
      layout: { columnCount: 3 },
    });
    if (section.type === "layoutSection") {
      expect(section.children).toHaveLength(3);
      expect(section.layout.columnStartIds).toEqual(section.children.map((child) => child.id));
    }
    expect(findContainingLayoutSection(wrapped, "target")?.id).toBe(section.id);

    const unwrapped = unwrapLayoutSection(wrapped, section.id);
    expect(unwrapped.content.map((block) => block.id)).toEqual(["before", "target", "after"]);
  });

  it("wraps contiguous top-level text blocks in one layout section", () => {
    const document = {
      ...baseDocument,
      content: [
        paragraph("before", "before"),
        paragraph("first", "first"),
        paragraph("second", "second"),
        paragraph("after", "after"),
      ],
    };

    const wrapped = wrapTextFlowBlocksInLayoutSection(document, ["first", "second"], 2, 5.5);
    expect(wrapped.content.map((block) => block.type)).toEqual(["paragraph", "layoutSection", "paragraph"]);
    const section = wrapped.content[1];
    expect(section).toMatchObject({
      type: "layoutSection",
      layout: { columnCount: 2, columnGapMm: 5.5 },
      children: [{ id: "first" }, { id: "second" }],
    });
  });

  it("resolves the current inclusive block range from stable start/end anchors", () => {
    const document = {
      ...baseDocument,
      content: [
        paragraph("outside_before", "before"),
        paragraph("range_start", "start"),
        paragraph("inserted_later", "later"),
        paragraph("range_end", "end"),
        paragraph("outside_after", "after"),
      ],
    };

    expect(resolveTextFlowBlockRangeIds(document, "range_start", "range_end")).toEqual([
      "range_start",
      "inserted_later",
      "range_end",
    ]);
    expect(resolveTextFlowBlockRangeIds(document, "range_end", "range_start")).toBeNull();
    expect(resolveTextFlowBlockRangeIds(document, "range_start", "missing")).toBeNull();
  });

  it("wraps contiguous solution blocks in one layout section and can unwrap it", () => {
    const document: SigmaDocument = {
      ...baseDocument,
      content: [
        {
          type: "problem",
          id: "problem_solution_columns",
          tags: [],
          lead: [],
          prompt: [paragraph("prompt", "prompt")],
          solution: [
            paragraph("solution_before", "before"),
            paragraph("solution_first", "first"),
            paragraph("solution_second", "second"),
            paragraph("solution_after", "after"),
          ],
          hints: [],
        },
      ],
    };

    const wrapped = wrapTextFlowBlocksInLayoutSection(document, ["solution_first", "solution_second"], 3);
    const problemBlock = wrapped.content[0];
    expect(problemBlock.type).toBe("problem");
    if (problemBlock.type !== "problem") {
      return;
    }

    expect(problemBlock.solution.map((block) => block.type)).toEqual(["paragraph", "layoutSection", "paragraph"]);
    const section = problemBlock.solution[1];
    expect(section).toMatchObject({
      type: "layoutSection",
      layout: { columnCount: 3 },
    });
    if (section.type === "layoutSection") {
      expect(section.children).toHaveLength(3);
      expect(section.children.slice(0, 2).map((child) => child.id)).toEqual(["solution_first", "solution_second"]);
    }
    expect(findContainingLayoutSection(wrapped, "solution_first")?.id).toBe(section.id);

    const unwrapped = unwrapLayoutSection(wrapped, section.id);
    const unwrappedProblem = unwrapped.content[0];
    expect(unwrappedProblem.type).toBe("problem");
    if (unwrappedProblem.type !== "problem") {
      return;
    }
    expect(unwrappedProblem.solution.map((block) => block.id)).toEqual([
      "solution_before",
      "solution_first",
      "solution_second",
      "solution_after",
    ]);
  });

  it("does not wrap non-contiguous solution blocks", () => {
    const document: SigmaDocument = {
      ...baseDocument,
      content: [
        {
          type: "problem",
          id: "problem_solution_non_contiguous",
          tags: [],
          lead: [],
          prompt: [paragraph("prompt", "prompt")],
          solution: [
            paragraph("solution_first", "first"),
            paragraph("solution_middle", "middle"),
            paragraph("solution_last", "last"),
          ],
          hints: [],
        },
      ],
    };

    const wrapped = wrapTextFlowBlocksInLayoutSection(document, ["solution_first", "solution_last"], 2);
    expect(wrapped).toBe(document);
  });

  it("wraps a text block inside a box in a layout section and can unwrap it", () => {
    const document = {
      ...baseDocument,
      content: [
        createBoxBlock("tcolorbox-note", "note", {
          id: "box",
          bodyId: "target",
          bodyText: "target",
        }),
      ],
    };

    const wrapped = wrapTextFlowBlockInLayoutSection(document, "target", 2);
    const box = wrapped.content[0];
    expect(box.type).toBe("boxBlock");
    if (box.type !== "boxBlock") {
      return;
    }
    expect(box.blocks.map((block) => block.type)).toEqual(["layoutSection"]);
    const section = box.blocks[0];
    expect(section).toMatchObject({
      type: "layoutSection",
      layout: { columnCount: 2 },
    });
    if (section.type === "layoutSection") expect(section.children).toHaveLength(2);
    expect(findContainingLayoutSection(wrapped, "target")?.id).toBe(section.id);
    expect(findContainingBoxBlock(wrapped, "target")?.id).toBe("box");
    expect(findContainingBoxBlock(wrapped, section.id)?.id).toBe("box");
    expect(findContainingBoxBlock(wrapped, "box")).toBeNull();

    const unwrapped = unwrapLayoutSection(wrapped, section.id);
    const unwrappedBox = unwrapped.content[0];
    expect(unwrappedBox.type).toBe("boxBlock");
    if (unwrappedBox.type !== "boxBlock") {
      return;
    }
    expect(unwrappedBox.blocks.map((block) => block.id)).toEqual(["target"]);
  });
});

describe("deleteBlocksFromDocument", () => {
  it("removes a top-level block and a nested problem-area block in one call", () => {
    const document = {
      ...baseDocument,
      content: [paragraph("keep", "keep"), ...baseDocument.content, paragraph("drop", "drop")],
    };

    const next = deleteBlocksFromDocument(document, ["drop", "prompt_2"]);

    expect(next.content.map((block) => block.id)).toEqual(["keep", "problem_1"]);
    const nextProblem = next.content[1];
    expect(nextProblem.type).toBe("problem");
    if (nextProblem.type !== "problem") {
      return;
    }
    expect(nextProblem.prompt.map((block) => block.id)).toEqual(["prompt_1"]);
  });

  it("tolerates a batch where one id is a descendant of another block already removed in the same call", () => {
    const document = {
      ...baseDocument,
      content: [problem("outer")],
    };

    const next = deleteBlocksFromDocument(document, ["outer", "outer_prompt"]);

    expect(next.content).toEqual([]);
  });

  it("throws when a target block id does not exist", () => {
    expect(() => deleteBlocksFromDocument(baseDocument, ["missing"])).toThrow();
  });

  it("throws when asked to delete a bare list item id", () => {
    const list: ListNode = {
      type: "list",
      id: "list_1",
      listType: "bullet",
      items: [{ type: "listItem", id: "item_1", children: [{ type: "text", text: "a" }] }],
    };
    const document = { ...baseDocument, content: [list] };

    expect(() => deleteBlocksFromDocument(document, ["item_1"])).toThrow();
  });

  it("transfers a deleted block's manual break to its next sibling", () => {
    const document = {
      ...baseDocument,
      content: [
        paragraph("before", "前"),
        { ...paragraph("deleted", "削除"), pagination: { break: true as const } },
        paragraph("after", "後"),
      ],
    };

    const next = deleteBlocksFromDocument(document, ["deleted"]);

    expect(next.content.map((block) => [block.id, block.pagination?.break])).toEqual([
      ["before", undefined],
      ["after", true],
    ]);
  });

  it("keeps surviving blocks in their pre-delete layout columns when a column start is removed", () => {
    const document: SigmaDocument = {
      ...baseDocument,
      content: [{
        type: "layoutSection",
        id: "columns",
        layout: {
          columnCount: 2,
          columnStartIds: ["a", "c"],
          columnWidths: [6000, 4000],
        },
        children: [
          paragraph("a", "a"),
          paragraph("b", "b"),
          paragraph("c", "c"),
          paragraph("d", "d"),
          paragraph("e", "e"),
        ],
      }],
    };

    const next = deleteBlocksFromDocument(document, ["c"]);
    const section = next.content[0];
    expect(section.type).toBe("layoutSection");
    if (section.type !== "layoutSection") return;
    expect(section.layout.columnStartIds).toEqual(["a", "d"]);
    expect(section.layout.columnWidths).toEqual([6000, 4000]);
    expect(getLayoutSectionColumns(section).map((column) => column.map((block) => block.id)))
      .toEqual([["a", "b"], ["d", "e"]]);
  });

  it("keeps an empty owner in a column emptied by direct removal", () => {
    const document: SigmaDocument = {
      ...baseDocument,
      content: [{
        type: "layoutSection",
        id: "columns",
        layout: {
          columnCount: 2,
          columnStartIds: ["left", "right"],
          columnWidths: [5000, 5000],
        },
        children: [paragraph("left", "left"), paragraph("right", "right")],
      }],
    };

    const next = removeBlockFromDocument(document, "right");
    const section = next.content[0];
    expect(section.type).toBe("layoutSection");
    if (section.type !== "layoutSection") return;
    const columns = getLayoutSectionColumns(section);
    expect(columns).toHaveLength(2);
    expect(columns[0].map((block) => block.id)).toEqual(["left"]);
    expect(columns[1]).toHaveLength(1);
    expect(columns[1][0]).toMatchObject({ type: "paragraph", children: [{ type: "text", text: "" }] });
  });

  it("leaves an unrelated sparse three-column section untouched", () => {
    const sparseSection = {
      type: "layoutSection" as const,
      id: "sparse-columns",
      layout: {
        columnCount: 3,
        columnStartIds: ["left", "right", "missing-third-owner"],
        columnWidths: [2000, 3000, 5000],
      },
      children: [paragraph("left", "left"), paragraph("right", "right")],
    };
    const document: SigmaDocument = {
      ...baseDocument,
      content: [sparseSection, paragraph("outside", "outside")],
    };

    const next = deleteBlocksFromDocument(document, ["outside"]);

    expect(next.content[0]).toBe(sparseSection);
    expect(next.content[0]).toMatchObject({
      layout: {
        columnCount: 3,
        columnStartIds: ["left", "right", "missing-third-owner"],
        columnWidths: [2000, 3000, 5000],
      },
    });
  });

  it("preserves three columns and their widths when deletion empties one column", () => {
    const document: SigmaDocument = {
      ...baseDocument,
      content: [{
        type: "layoutSection",
        id: "columns",
        layout: {
          columnCount: 3,
          columnStartIds: ["left", "middle", "right"],
          columnWidths: [2000, 3000, 5000],
        },
        children: [
          paragraph("left", "left"),
          paragraph("middle", "middle"),
          paragraph("right", "right"),
        ],
      }],
    };

    const next = deleteBlocksFromDocument(document, ["middle"]);
    const section = next.content[0];
    expect(section.type).toBe("layoutSection");
    if (section.type !== "layoutSection") return;
    const columns = getLayoutSectionColumns(section);
    expect(section.layout.columnCount).toBe(3);
    expect(section.layout.columnWidths).toEqual([2000, 3000, 5000]);
    expect(columns).toHaveLength(3);
    expect(columns[0].map((block) => block.id)).toEqual(["left"]);
    expect(columns[1]).toHaveLength(1);
    expect(columns[1][0]).toMatchObject({ type: "paragraph", children: [{ type: "text", text: "" }] });
    expect(columns[2].map((block) => block.id)).toEqual(["right"]);
  });

  it("reuses unrelated layout sections inside a problem area and a box", () => {
    const problemSection = {
      type: "layoutSection" as const,
      id: "problem-columns",
      layout: {
        columnCount: 3,
        columnStartIds: ["problem-left", "problem-right", "problem-missing"],
        columnWidths: [2000, 3000, 5000],
      },
      children: [paragraph("problem-left", "left"), paragraph("problem-right", "right")],
    };
    const boxSection = {
      type: "layoutSection" as const,
      id: "box-columns",
      layout: {
        columnCount: 3,
        columnStartIds: ["box-left", "box-right", "box-missing"],
        columnWidths: [2500, 2500, 5000],
      },
      children: [paragraph("box-left", "left"), paragraph("box-right", "right")],
    };
    const document: SigmaDocument = {
      ...baseDocument,
      content: [{
        type: "problem",
        id: "problem",
        tags: [],
        lead: [],
        prompt: [problemSection, paragraph("problem-sibling", "delete")],
        solution: [],
        hints: [],
      }, {
        type: "boxBlock",
        id: "box",
        styleId: "plain",
        blocks: [boxSection, paragraph("box-sibling", "delete")],
      }],
    };

    const next = deleteBlocksFromDocument(document, ["problem-sibling", "box-sibling"]);
    const problem = next.content[0];
    const box = next.content[1];
    expect(problem.type).toBe("problem");
    expect(box.type).toBe("boxBlock");
    if (problem.type !== "problem" || box.type !== "boxBlock") return;
    expect(problem.prompt[0]).toBe(problemSection);
    expect(box.blocks[0]).toBe(boxSection);
    expect(problemSection.layout.columnCount).toBe(3);
    expect(boxSection.layout.columnCount).toBe(3);
  });
});

describe("duplicateTopLevelBlock", () => {
  it("rewrites layout column starts to the duplicated child ids", () => {
    const document: SigmaDocument = {
      ...baseDocument,
      content: [{
        type: "layoutSection",
        id: "columns",
        layout: {
          columnCount: 2,
          columnStartIds: ["left", "right"],
          columnWidths: [6000, 4000],
        },
        children: [
          paragraph("left", "left"),
          paragraph("left-tail", "left tail"),
          paragraph("right", "right"),
          paragraph("right-tail", "right tail"),
        ],
      }],
    };

    const next = duplicateTopLevelBlock(document, "columns");
    const copy = next.content[1];
    expect(copy.type).toBe("layoutSection");
    if (copy.type !== "layoutSection") return;
    expect(copy.layout.columnStartIds).toEqual([copy.children[0].id, copy.children[2].id]);
    expect(getLayoutSectionColumns(copy).map((column) => column.length)).toEqual([2, 2]);
    expect(copy.layout.columnWidths).toEqual([6000, 4000]);
  });
});

describe("ensureEditableBody", () => {
  it("leaves a document that still has body blocks untouched", () => {
    const result = ensureEditableBody(baseDocument);

    expect(result.document).toBe(baseDocument);
    expect(result.bodyBlock).toBeNull();
  });

  it("puts an empty paragraph back when the last block was deleted", () => {
    const emptied = deleteBlocksFromDocument({ ...baseDocument, content: [problem("outer")] }, ["outer"]);

    const result = ensureEditableBody(emptied);

    expect(result.bodyBlock).not.toBeNull();
    expect(result.document.content).toEqual([result.bodyBlock]);
    expect(result.document.content[0]).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "" }],
    });
  });

  it("repairs the same empty document to the same value every time", () => {
    const document = { ...baseDocument, content: [] };

    const first = ensureEditableBody(document).document;
    const second = ensureEditableBody(document).document;

    // 直すたびに新しい id を振ると、ホストのエコーや外部同期と往復し続けるループになる。
    expect(first).toEqual(second);
    expect(ensureEditableBody(first).document).toBe(first);
  });

  it("keeps everything but the body of the document it repairs", () => {
    const document = { ...baseDocument, content: [], metadata: { title: "残す" } };

    const result = ensureEditableBody(document);

    expect(result.document.docId).toBe(document.docId);
    expect(result.document.metadata).toBe(document.metadata);
    expect(result.document.outputProfiles).toBe(document.outputProfiles);
  });

  it("does not add a body block to a whiteboard document", () => {
    const whiteboard = {
      ...baseDocument,
      content: [],
      pageLayout: getDefaultPageLayout("whiteboard"),
    };

    const result = ensureEditableBody(whiteboard);

    expect(result.document).toBe(whiteboard);
    expect(result.document.content).toEqual([]);
    expect(result.bodyBlock).toBeNull();
  });
});

describe("moveBlocksInDocument", () => {
  it.each([
    { name: "後方", targetId: "d", position: "after" as const, expectedIds: ["a", "c", "d", "b"] },
    { name: "前方", targetId: "a", position: "before" as const, expectedIds: ["b", "a", "c", "d"] },
  ])("moves a break-owning block $name without duplicating its break", ({ targetId, position, expectedIds }) => {
    const document = {
      ...baseDocument,
      content: [
        paragraph("a", "a"),
        { ...paragraph("b", "b"), pagination: { break: true as const } },
        paragraph("c", "c"),
        paragraph("d", "d"),
      ],
    };

    const next = moveBlocksInDocument(document, ["b"], targetId, position);

    expect(next.content.map((block) => block.id)).toEqual(expectedIds);
    expect(next.content.filter((block) => block.pagination?.break === true).map((block) => block.id))
      .toEqual(["b"]);
  });

  it("drops a moved block's break when its destination cannot own one", () => {
    const box = createBoxBlock("fancybox", "", { id: "box", bodyId: "box_body", bodyText: "inside" });
    const document = {
      ...baseDocument,
      content: [
        { ...paragraph("moving", "moving"), pagination: { break: true as const } },
        box,
      ],
    };

    const next = moveBlocksInDocument(document, ["moving"], "box_body", "after");
    const moved = findBlock(next, "moving");

    expect(moved && moved.type !== "listItem" ? moved.pagination?.break : undefined).toBeUndefined();
  });

  it("moves a top-level block before another top-level block", () => {
    const document = {
      ...baseDocument,
      content: [paragraph("a", "a"), paragraph("b", "b"), paragraph("c", "c")],
    };

    const next = moveBlocksInDocument(document, ["c"], "a", "before");

    expect(next.content.map((block) => block.id)).toEqual(["c", "a", "b"]);
  });

  it("moves a top-level block after another top-level block", () => {
    const document = {
      ...baseDocument,
      content: [paragraph("a", "a"), paragraph("b", "b"), paragraph("c", "c")],
    };

    const next = moveBlocksInDocument(document, ["a"], "b", "after");

    expect(next.content.map((block) => block.id)).toEqual(["b", "a", "c"]);
  });

  it("moves a top-level block into a problem's prompt area", () => {
    const inserted = paragraph("standalone", "standalone");
    const document = {
      ...baseDocument,
      content: [inserted, ...baseDocument.content],
    };

    const next = moveBlocksInDocument(document, ["standalone"], "prompt_1", "after");

    expect(next.content.map((block) => block.id)).toEqual(["problem_1"]);
    const nextProblem = next.content[0];
    expect(nextProblem.type).toBe("problem");
    if (nextProblem.type !== "problem") {
      return;
    }
    expect(nextProblem.prompt.map((block) => block.id)).toEqual(["prompt_1", "standalone", "prompt_2"]);
  });

  it("moves a block into layoutSection children", () => {
    const section = createLayoutSection([paragraph("in_section", "in")], 2);
    const document = {
      ...baseDocument,
      content: [section, paragraph("outside", "outside")],
    };

    const next = moveBlocksInDocument(document, ["outside"], "in_section", "after");
    const nextSection = next.content[0];
    expect(nextSection.type).toBe("layoutSection");
    if (nextSection.type !== "layoutSection") {
      return;
    }
    expect(nextSection.children.slice(0, 2).map((block) => block.id)).toEqual(["in_section", "outside"]);
    expect(nextSection.children).toHaveLength(3);
  });

  it("keeps surviving blocks in their source columns when moving a column start out", () => {
    const document: SigmaDocument = {
      ...baseDocument,
      content: [{
        type: "layoutSection",
        id: "columns",
        layout: {
          columnCount: 2,
          columnStartIds: ["a", "c"],
          columnWidths: [6000, 4000],
        },
        children: [
          paragraph("a", "a"),
          paragraph("b", "b"),
          paragraph("c", "c"),
          paragraph("d", "d"),
          paragraph("e", "e"),
        ],
      }, paragraph("outside", "outside")],
    };

    const next = moveBlocksInDocument(document, ["c"], "outside", "after");
    const section = next.content[0];
    expect(section.type).toBe("layoutSection");
    if (section.type !== "layoutSection") return;
    expect(section.layout.columnStartIds).toEqual(["a", "d"]);
    expect(section.layout.columnWidths).toEqual([6000, 4000]);
    expect(getLayoutSectionColumns(section).map((column) => column.map((block) => block.id)))
      .toEqual([["a", "b"], ["d", "e"]]);
    expect(next.content.map((block) => block.id)).toEqual(["columns", "outside", "c"]);
  });

  it("throws when the target is one of the moved blocks", () => {
    const document = {
      ...baseDocument,
      content: [paragraph("a", "a"), paragraph("b", "b")],
    };

    expect(() => moveBlocksInDocument(document, ["a", "b"], "a", "after")).toThrow();
  });

  it("throws when the target is nested inside a moved block", () => {
    const section = createLayoutSection([paragraph("inner", "inner")], 2);
    const document = { ...baseDocument, content: [section] };

    expect(() => moveBlocksInDocument(document, [section.id], "inner", "after")).toThrow();
  });

  it("throws when a moved block's type is incompatible with the target container", () => {
    const problemToMove = problem("problem_to_move");
    const document = {
      ...baseDocument,
      content: [...baseDocument.content, problemToMove],
    };

    expect(() => moveBlocksInDocument(document, ["problem_to_move"], "prompt_1", "after")).toThrow();
  });
});

describe("collectOutline body blocks", () => {
  it("keeps the default (no options) outline limited to section/heading/layoutSection/problem", () => {
    const document = {
      ...baseDocument,
      content: [paragraph("body", "some body text"), ...baseDocument.content],
    };

    const outline = collectOutline(document);

    expect(outline.map((entry) => entry.type)).toEqual(["problem"]);
  });

  it("includes top-level and nested paragraph/list/boxBlock entries when includeBodyBlocks is set", () => {
    const box = createBoxBlock("fancybox", "Note", { id: "box_1", bodyId: "box_body", bodyText: "boxed text" });
    const document = {
      ...baseDocument,
      content: [paragraph("top_body", "top level paragraph text"), box, ...baseDocument.content],
    };

    const outline = collectOutline(document, { includeBodyBlocks: true });
    const byId = new Map(outline.map((entry) => [entry.id, entry]));

    expect(byId.get("top_body")).toMatchObject({ type: "paragraph", excerpt: "top level paragraph text" });
    expect(byId.get("box_1")).toMatchObject({ type: "boxBlock" });
    expect(byId.get("box_body")).toMatchObject({ type: "paragraph", excerpt: "boxed text", parentId: "box_1" });
    expect(byId.get("prompt_1")).toMatchObject({ type: "paragraph", excerpt: "prompt 1", parentId: "problem_1" });
    expect(byId.get("solution_1")).toMatchObject({ type: "paragraph", excerpt: "solution 1", parentId: "problem_1" });
  });

  it("truncates long excerpts to 60 characters", () => {
    const longText = "あ".repeat(100);
    const document = { ...baseDocument, content: [paragraph("long", longText)] };

    const outline = collectOutline(document, { includeBodyBlocks: true });
    const entry = outline.find((item) => item.id === "long");

    expect(entry?.excerpt?.length).toBeLessThanOrEqual(60);
  });
});

function documentWithOverlayShapes(shapes: OverlayShape[]): SigmaDocument {
  const base = ensurePageLayout(baseDocument);
  return {
    ...base,
    pageLayout: {
      ...base.pageLayout!,
      overlay: {
        overlaySnapshot: { version: 1, assets: {}, shapes },
      },
    },
  };
}

function tableShapeWithCellText(id: string, text: string, anchorBlockId?: string): OverlayTableShape {
  return {
    id,
    type: "tableShape",
    x: 0,
    y: 0,
    ...(anchorBlockId ? { anchor: { type: "block", blockId: anchorBlockId, dy: 0 } } : {}),
    props: {
      w: 200,
      h: 100,
      table: {
        version: 1,
        kind: "plain",
        columns: [{ id: "col_1", width: { mode: "auto", min: 48 } }, { id: "col_2", width: { mode: "auto", min: 48 } }],
        rows: [{ id: "row_1", height: { mode: "auto", min: 32 } }, { id: "row_2", height: { mode: "auto", min: 32 } }],
        cells: [
          { id: "cell_1_1", rowId: "row_1", columnId: "col_1", content: [{ type: "paragraph", id: "cell_p_1_1", children: [{ type: "text", text: "" }] }] },
          { id: "cell_1_2", rowId: "row_1", columnId: "col_2", content: [{ type: "paragraph", id: "cell_p_1_2", children: [{ type: "text", text }] }] },
        ],
        grid: { borderColor: "#111827", borderWidth: 1 },
        defaultCellStyle: {},
      },
    },
  };
}

function textShapeWithContent(id: string, text: string, parentId?: string): OverlayTextShape {
  return {
    id,
    type: "text",
    x: 0,
    y: 0,
    ...(parentId ? { parentId } : {}),
    props: {
      w: 120,
      h: 16,
      color: "#111827",
      size: "m",
      blocks: [{ type: "paragraph", id: "document_tree_test_35", children: [{ type: "text", text }] }],
    },
  };
}

describe("collectOverlayShapeOutline", () => {
  it("describes a table shape by its dimensions and first non-empty cell text", () => {
    const document = documentWithOverlayShapes([tableShapeWithCellText("shape_table", "国語の点数")]);

    const outline = collectOverlayShapeOutline(document);

    expect(outline).toEqual([
      { id: "shape_table", type: "tableShape", description: "表 2行×2列 「国語の点数」", x: 0, y: 0 },
    ]);
  });

  it("describes a table by what a formula cell evaluates to, not by its source", () => {
    // The outline names the table for a human. A label reading `=1+29` where the canvas, print, the
    // PDF and the viewer all show `30` describes a table nobody can see.
    const document = documentWithOverlayShapes([tableShapeWithCellText("shape_table", "=1+29")]);

    expect(collectOverlayShapeOutline(document)[0].description).toBe("表 2行×2列 「30」");
  });

  it("still names a table by a formula it cannot parse, as the text that was typed", () => {
    const document = documentWithOverlayShapes([tableShapeWithCellText("shape_table", "=SUM(A1")]);

    expect(collectOverlayShapeOutline(document)[0].description).toBe("表 2行×2列 「=SUM(A1」");
  });

  it("describes a text shape by its content and reports its anchor block id", () => {
    const document = documentWithOverlayShapes([
      { ...textShapeWithContent("shape_text", "図の説明"), anchor: { type: "block", blockId: "prompt_1", dy: 4 } },
    ]);

    const outline = collectOverlayShapeOutline(document);

    // 絶対座標 (x/y) を返さないと、AIは insert_shape の絶対座標APIを使いようがない。
    expect(outline).toEqual([
      { id: "shape_text", type: "text", description: "図の説明", anchorBlockId: "prompt_1", x: 0, y: 0 },
    ]);
  });

  it("describes a graph shape by its title and kind", () => {
    const graphProps = createGraphShapeProps("blank");
    const document = documentWithOverlayShapes([
      { id: "shape_graph", type: "graph2dShape", x: 0, y: 0, props: { ...graphProps, spec: { ...graphProps.spec, title: "放物線のグラフ" } } },
    ]);

    const outline = collectOverlayShapeOutline(document);

    expect(outline).toEqual([
      { id: "shape_graph", type: "graph2dShape", description: "グラフ「放物線のグラフ」(cartesian)", x: 0, y: 0 },
    ]);
  });

  it("reports parentId for shapes grouped under another shape", () => {
    // A group with fewer than 2 children is treated as degenerate and dissolved by
    // normalizeOverlaySnapshot, so this needs two children to keep the group (and its
    // children's parentId) intact.
    const document = documentWithOverlayShapes([
      { id: "shape_group", type: "group", x: 0, y: 0, props: { w: 100, h: 100 } },
      textShapeWithContent("shape_child_1", "内側のラベル1", "shape_group"),
      textShapeWithContent("shape_child_2", "内側のラベル2", "shape_group"),
    ]);

    const outline = collectOverlayShapeOutline(document);
    const child = outline.find((entry) => entry.id === "shape_child_1");

    expect(child).toMatchObject({ parentId: "shape_group" });
  });

  it("returns an empty list when the document has no overlay shapes", () => {
    expect(collectOverlayShapeOutline(baseDocument)).toEqual([]);
  });
});

describe("isOverlayShapeId", () => {
  it("returns true for an overlay shape id and false for a body block id or unknown id", () => {
    const document = documentWithOverlayShapes([tableShapeWithCellText("shape_table", "点数")]);

    expect(isOverlayShapeId(document, "shape_table")).toBe(true);
    expect(isOverlayShapeId(document, "prompt_1")).toBe(false);
    expect(isOverlayShapeId(document, "does_not_exist")).toBe(false);
  });
});

describe("deleteBlocksFromDocument overlay shape id error", () => {
  it("tells the caller to use delete_shapes when the id is an overlay shape (table), not a body block", () => {
    const document = documentWithOverlayShapes([tableShapeWithCellText("shape_table", "点数")]);

    expect(() => deleteBlocksFromDocument(document, ["shape_table"])).toThrow(/delete_shapes/);
  });

  it("keeps the plain not-found message when the id matches neither a block nor an overlay shape", () => {
    expect(() => deleteBlocksFromDocument(baseDocument, ["does_not_exist"])).not.toThrow(/delete_shapes/);
    expect(() => deleteBlocksFromDocument(baseDocument, ["does_not_exist"])).toThrow(/見つかりません/);
  });
});

describe("collectBlocksById", () => {
  it("resolves blocks nested inside a problem's prompt/solution areas, not just top-level content", () => {
    const map = collectBlocksById(baseDocument.content);

    expect(map.get("problem_1")?.type).toBe("problem");
    expect(map.get("prompt_1")?.type).toBe("paragraph");
    expect(map.get("prompt_2")?.type).toBe("paragraph");
    expect(map.get("solution_1")?.type).toBe("paragraph");
    expect(map.get("does_not_exist")).toBeUndefined();
  });

  it("preserves a manual pagination hint on a block nested in a problem's solution area — this is the lookup the single-column layout pass (PageCanvasEditor) relies on to honor 改ページ/改段 inside problem areas", () => {
    const documentWithBreak: SigmaDocument = {
      ...baseDocument,
      content: [
        {
          ...(baseDocument.content[0] as ProblemNode),
          solution: [
            paragraph("solution_1", "solution 1"),
            { ...paragraph("solution_2", "solution 2"), pagination: { break: true } },
          ],
        },
      ],
    };

    const map = collectBlocksById(documentWithBreak.content);
    const block = map.get("solution_2");

    expect(block?.type).toBe("paragraph");
    expect(block && block.type !== "listItem" ? block.pagination?.break : undefined).toBe(true);
  });

  it("also resolves a boxBlock (and its own children) nested inside a layoutSection reached through a problem area", () => {
    const box = createBoxBlock("fancybox");
    const section = createLayoutSection([box, paragraph("layout_child", "段組の中身")]);
    const documentWithNesting: SigmaDocument = {
      ...baseDocument,
      content: [
        {
          ...(baseDocument.content[0] as ProblemNode),
          prompt: [section],
        },
      ],
    };

    const map = collectBlocksById(documentWithNesting.content);

    expect(map.get(section.id)?.type).toBe("layoutSection");
    expect(map.get(box.id)?.type).toBe("boxBlock");
    expect(map.get(box.blocks[0].id)?.type).toBe("paragraph");
    expect(map.get("layout_child")?.type).toBe("paragraph");
  });
});
