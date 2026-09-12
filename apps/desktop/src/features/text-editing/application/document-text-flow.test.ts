import { describe, expect, it } from "vitest";

import type {
  ParagraphNode,
  SigmaBlock,
  SigmaDocument,
} from "@/features/document";
import {
  insertTopLevelTextFlowBlocks,
  replaceTopLevelTextFlowBlocks,
  type TextFlowBlock,
} from "@/features/text-editing";

function paragraph(id: string, text: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children: text ? [{ type: "text", text }] : [],
  };
}

describe("page breaks after deleting the leading body", () => {
  it("clears a break owned by a different editor chunk and preserves other pagination fields", () => {
    const after = { ...paragraph("after", "あ"), pagination: { break: true, keepWithNext: true } };
    const result = replaceTopLevelTextFlowBlocks([paragraph("first", "前"), after], ["first"], [paragraph("first", "")]);
    expect(result[1].pagination).toEqual({ keepWithNext: true });
    expect(after.pagination.break).toBe(true);
  });

  it("clears a break after deleting the whole first paragraph", () => {
    const after = { ...paragraph("after", "あ"), pagination: { break: true } };
    const result = replaceTopLevelTextFlowBlocks([paragraph("first", "前"), after], ["first"], []);
    expect(result).toEqual([paragraph("after", "あ")]);
  });

  it("keeps later breaks when body precedes them", () => {
    const after = { ...paragraph("after", "あ"), pagination: { break: true } };
    const result = replaceTopLevelTextFlowBlocks([paragraph("first", "前"), paragraph("blank", ""), after], ["blank"], []);
    expect(result[1]).toBe(after);
  });
});

function documentWith(content: SigmaBlock[]): SigmaDocument {
  return {
    version: "2.0",
    docId: "document-text-flow-test",
    metadata: { title: "本文flow" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}

function deterministicIdFactory() {
  const sequenceByPrefix = new Map<string, number>();
  return (prefix: string) => {
    const sequence = (sequenceByPrefix.get(prefix) ?? 0) + 1;
    sequenceByPrefix.set(prefix, sequence);
    return `${prefix}_generated_${sequence}`;
  };
}

describe("document text-flow application", () => {
  it("preserves top-level insertion semantics when the anchor exists only inside a problem", () => {
    const original = documentWith([
      {
        id: "problem",
        type: "problem",
        tags: [],
        lead: [],
        prompt: [paragraph("problem_prompt", "問題文")],
        hints: [],
        solution: [],
      },
      paragraph("tail", "末尾"),
    ]);

    const result = insertTopLevelTextFlowBlocks(
      original,
      "problem_prompt",
      [paragraph("inserted", "追加")],
      { now: () => "2026-07-25T00:00:00.000Z" },
    );

    expect(result.content.map((block) => block.id)).toEqual([
      "problem",
      "tail",
      "inserted",
    ]);
    expect(result.updatedAt).toBe("2026-07-25T00:00:00.000Z");
    expect(original.updatedAt).toBeUndefined();
  });

  it("reuses the original content and block references for an equivalent replacement", () => {
    const originalBlock = paragraph("same", "同じ");
    const content: SigmaBlock[] = [originalBlock];

    const result = replaceTopLevelTextFlowBlocks(
      content,
      ["same"],
      [structuredClone(originalBlock)],
      { createId: deterministicIdFactory() },
    );

    expect(result).toBe(content);
    expect(result[0]).toBe(originalBlock);
  });

  it("normalizes duplicate ids recursively inside nested list content through the id port", () => {
    const content: SigmaBlock[] = [
      paragraph("reserved", "予約済み"),
      paragraph("replace", "置換前"),
    ];
    const replacement: TextFlowBlock = {
      id: "replace",
      type: "boxBlock",
      styleId: "frame",
      title: [{
        type: "text",
        text: "重要",
        marks: ["bold"],
        color: "#dc2626",
      }],
      blocks: [{
        id: "list",
        type: "list",
        listType: "bullet",
        items: [{
          id: "item",
          type: "listItem",
          children: [{ type: "text", text: "親" }],
          nested: [{
            id: "list",
            type: "list",
            listType: "bullet",
            items: [{
              id: "item",
              type: "listItem",
              children: [{ type: "text", text: "子" }],
            }],
          }],
        }],
      }],
    };

    const result = replaceTopLevelTextFlowBlocks(
      content,
      ["replace"],
      [replacement],
      { createId: deterministicIdFactory() },
    );
    const box = result[1];

    expect(box.type).toBe("boxBlock");
    if (box.type !== "boxBlock") {
      return;
    }
    expect(box.title).toEqual([{
      type: "text",
      text: "重要",
      marks: ["bold"],
      color: "#dc2626",
    }]);
    const list = box.blocks[0];
    expect(list.type).toBe("list");
    if (list.type !== "list") {
      return;
    }
    expect(list.items[0].nested?.[0].id).toBe("list_generated_1");
    expect(list.items[0].nested?.[0].items[0].id).toBe("li_generated_1");
  });

  it("accepts a layout section replacement and normalizes its nested ids", () => {
    const content: SigmaBlock[] = [
      paragraph("reserved", "予約済み"),
      paragraph("replace", "置換前"),
    ];
    const replacement: TextFlowBlock = {
      id: "replace",
      type: "layoutSection",
      layout: { columnCount: 2 },
      children: [paragraph("reserved", "段組み本文")],
    };

    const result = replaceTopLevelTextFlowBlocks(
      content,
      ["replace"],
      [replacement],
      { createId: deterministicIdFactory() },
    );

    expect(result[1]).toMatchObject({
      id: "replace",
      type: "layoutSection",
      children: [{
        id: "p_generated_1",
        type: "paragraph",
      }],
    });
  });

  it("keeps the original content for empty or missing replacement targets", () => {
    const content: SigmaBlock[] = [paragraph("existing", "本文")];
    const createId = () => {
      throw new Error("id allocation is not expected");
    };

    expect(replaceTopLevelTextFlowBlocks(
      content,
      [],
      [paragraph("next", "次")],
      { createId },
    )).toBe(content);
    expect(replaceTopLevelTextFlowBlocks(
      content,
      ["missing"],
      [paragraph("next", "次")],
      { createId },
    )).toBe(content);
  });
});
