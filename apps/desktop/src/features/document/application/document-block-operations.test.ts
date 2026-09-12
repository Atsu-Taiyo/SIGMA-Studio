import { describe, expect, it, vi } from "vitest";

import type {
  ParagraphNode,
  ProblemNode,
  SigmaBlock,
  SigmaDocument,
} from "../model";
import {
  diffDeletedContentIds,
  insertTopLevelDocumentBlocks,
  insertTopLevelDocumentBlocksBefore,
  repairDuplicateTopLevelIds,
  type DocumentBlockClock,
  type DocumentBlockIdFactory,
  type DocumentBlockIdPrefix,
} from "./document-block-operations";

const NOW = "2026-07-25T02:03:04.000Z";

describe("document block operations", () => {
  it("inserts after and before direct top-level anchors", () => {
    const first = paragraph("first");
    const second = paragraph("second");
    const document = documentWith([first, second]);
    const inserted = [paragraph("inserted-a"), paragraph("inserted-b")];
    const afterClock = testClock();
    const beforeClock = testClock();

    const after = insertTopLevelDocumentBlocks(
      document,
      "first",
      inserted,
      afterClock.port,
    );
    const before = insertTopLevelDocumentBlocksBefore(
      document,
      "second",
      inserted,
      beforeClock.port,
    );

    expect(after.content.map(({ id }) => id)).toEqual([
      "first",
      "inserted-a",
      "inserted-b",
      "second",
    ]);
    expect(before.content.map(({ id }) => id)).toEqual([
      "first",
      "inserted-a",
      "inserted-b",
      "second",
    ]);
    expect(after.updatedAt).toBe(NOW);
    expect(before.updatedAt).toBe(NOW);
    expect(after.content[0]).toBe(first);
    expect(after.content[1]).toBe(inserted[0]);
    expect(after.content[2]).toBe(inserted[1]);
    expect(document.content).toEqual([first, second]);
    expect(afterClock.now).toHaveBeenCalledTimes(1);
    expect(beforeClock.now).toHaveBeenCalledTimes(1);
  });

  it("inserts beside the containing problem for deeply nested problem anchors", () => {
    const beforeProblem = paragraph("before-problem");
    const problem = nestedProblem();
    const afterProblem = paragraph("after-problem");
    const document = documentWith([beforeProblem, problem, afterProblem]);
    const insertedAfter = paragraph("inserted-after");
    const insertedBefore = paragraph("inserted-before");

    const after = insertTopLevelDocumentBlocks(
      document,
      "nested-list-item",
      [insertedAfter],
      testClock().port,
    );
    const before = insertTopLevelDocumentBlocksBefore(
      document,
      "nested-list",
      [insertedBefore],
      testClock().port,
    );

    expect(after.content.map(({ id }) => id)).toEqual([
      "before-problem",
      "problem",
      "inserted-after",
      "after-problem",
    ]);
    expect(before.content.map(({ id }) => id)).toEqual([
      "before-problem",
      "inserted-before",
      "problem",
      "after-problem",
    ]);
    expect(after.content[1]).toBe(problem);
    expect(before.content[2]).toBe(problem);
  });

  it("appends for missing or null anchors and still timestamps empty inserts", () => {
    const document = documentWith([paragraph("first")]);
    const inserted = paragraph("inserted");
    const missingClock = testClock();
    const nullClock = testClock();
    const emptyClock = testClock();

    const missing = insertTopLevelDocumentBlocks(
      document,
      "missing",
      [inserted],
      missingClock.port,
    );
    const nullBefore = insertTopLevelDocumentBlocksBefore(
      document,
      null,
      [inserted],
      nullClock.port,
    );
    const empty = insertTopLevelDocumentBlocks(
      document,
      "first",
      [],
      emptyClock.port,
    );

    expect(missing.content.map(({ id }) => id)).toEqual(["first", "inserted"]);
    expect(nullBefore.content.map(({ id }) => id)).toEqual(["first", "inserted"]);
    expect(empty).not.toBe(document);
    expect(empty.content).not.toBe(document.content);
    expect(empty.content).toEqual(document.content);
    expect(empty.updatedAt).toBe(NOW);
    expect(missingClock.now).toHaveBeenCalledTimes(1);
    expect(nullClock.now).toHaveBeenCalledTimes(1);
    expect(emptyClock.now).toHaveBeenCalledTimes(1);
  });

  it("repairs duplicate and blank top-level ids with the existing block prefixes", () => {
    const blocks = duplicateBlocksByType();
    const document = {
      ...documentWith(blocks),
      updatedAt: "2026-07-24T00:00:00.000Z",
    };
    const prefixCounts = new Map<DocumentBlockIdPrefix, number>();
    const createId = vi.fn<(prefix: DocumentBlockIdPrefix) => string>(
      (prefix) => {
        const count = (prefixCounts.get(prefix) ?? 0) + 1;
        prefixCounts.set(prefix, count);
        return `${prefix}_generated${count === 1 ? "" : `_${count}`}`;
      },
    );
    const idFactory: DocumentBlockIdFactory = { createId };

    const result = repairDuplicateTopLevelIds(document, idFactory);

    expect(createId.mock.calls.map(([prefix]) => prefix)).toEqual([
      "section",
      "heading",
      "p",
      "list",
      "problem",
      "problem",
      "box",
    ]);
    expect(result.content.map(({ id }) => id)).toEqual([
      "section-original",
      "section_generated",
      "heading-original",
      "heading_generated",
      "paragraph-original",
      "p_generated",
      "list-original",
      "list_generated",
      "problem-original",
      "problem_generated",
      "layout-original",
      "problem_generated_2",
      "box-original",
      "box_generated",
    ]);
    expect(result.updatedAt).toBe(document.updatedAt);
    for (let index = 0; index < blocks.length; index += 2) {
      expect(result.content[index]).toBe(blocks[index]);
      expect(result.content[index + 1]).not.toBe(blocks[index + 1]);
    }
  });

  it("returns the original document when ids are already unique", () => {
    const document = documentWith([
      paragraph("first"),
      paragraph("second"),
      nestedProblem(),
    ]);
    const createId = vi.fn<(prefix: DocumentBlockIdPrefix) => string>();

    const result = repairDuplicateTopLevelIds(document, { createId });

    expect(result).toBe(document);
    expect(result.content).toBe(document.content);
    expect(createId).not.toHaveBeenCalled();
  });

  it("retries id generation until the replacement is unique", () => {
    const document = documentWith([
      paragraph("taken"),
      paragraph("taken"),
    ]);
    const generatedIds = ["taken", "p_unique"];
    const createId = vi.fn<(prefix: DocumentBlockIdPrefix) => string>(
      () => generatedIds.shift() ?? "p_fallback",
    );

    const result = repairDuplicateTopLevelIds(document, { createId });

    expect(result.content.map(({ id }) => id)).toEqual(["taken", "p_unique"]);
    expect(createId.mock.calls).toEqual([["p"], ["p"]]);
  });

  it("reports only deleted top-level ids in their previous order", () => {
    const previousProblem = nestedProblem();
    const nextProblem = {
      ...nestedProblem(),
      prompt: [paragraph("replacement-nested")],
    };
    const previous = documentWith([
      paragraph("deleted-first"),
      previousProblem,
      paragraph("deleted-last"),
    ]);
    const next = documentWith([
      nextProblem,
      paragraph("inserted"),
    ]);

    expect(diffDeletedContentIds(previous, next)).toEqual([
      "deleted-first",
      "deleted-last",
    ]);
  });
});

function documentWith(content: SigmaBlock[]): SigmaDocument {
  return {
    version: "2.0",
    docId: "document-block-operations-test",
    metadata: { title: "ブロック操作" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}

function paragraph(id: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children: [{ type: "text", text: id }],
  };
}

function nestedProblem(): ProblemNode {
  return {
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
        blocks: [{
          id: "problem-box-layout",
          type: "layoutSection",
          layout: { columnCount: 1 },
          children: [{
            id: "problem-list",
            type: "list",
            listType: "bullet",
            items: [{
              id: "problem-list-item",
              type: "listItem",
              children: [{ type: "text", text: "item" }],
              nested: [{
                id: "nested-list",
                type: "list",
                listType: "ordered",
                items: [{
                  id: "nested-list-item",
                  type: "listItem",
                  children: [{ type: "text", text: "nested" }],
                }],
              }],
            }],
          }],
        }],
      }],
    }],
    hints: [],
    solution: [],
  };
}

function duplicateBlocksByType(): SigmaBlock[] {
  return [
    {
      id: "section-original",
      type: "section",
      title: "section",
    },
    {
      id: "section-original",
      type: "section",
      title: "duplicate section",
    },
    {
      id: "heading-original",
      type: "heading",
      level: 1,
      children: [],
    },
    {
      id: "heading-original",
      type: "heading",
      level: 2,
      children: [],
    },
    paragraph("paragraph-original"),
    paragraph("paragraph-original"),
    {
      id: "list-original",
      type: "list",
      listType: "bullet",
      items: [],
    },
    {
      id: "list-original",
      type: "list",
      listType: "ordered",
      items: [],
    },
    {
      ...nestedProblem(),
      id: "problem-original",
    },
    {
      ...nestedProblem(),
      id: "problem-original",
    },
    {
      id: "layout-original",
      type: "layoutSection",
      layout: { columnCount: 1 },
      children: [],
    },
    {
      id: "",
      type: "layoutSection",
      layout: { columnCount: 2 },
      children: [],
    },
    {
      id: "box-original",
      type: "boxBlock",
      styleId: "frame",
      blocks: [],
    },
    {
      id: "box-original",
      type: "boxBlock",
      styleId: "frame",
      blocks: [],
    },
  ];
}

function testClock(): {
  port: DocumentBlockClock;
  now: ReturnType<typeof vi.fn<() => string>>;
} {
  const now = vi.fn<() => string>(() => NOW);
  return {
    port: { now },
    now,
  };
}
