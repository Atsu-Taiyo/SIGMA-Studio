import { describe, expect, it } from "vitest";

import type { AiAppliedDocumentDiff } from "@/lib/ai/applied-document-diff";
import type {
  BoxBlockNode,
  HeadingNode,
  LayoutSectionNode,
  ListNode,
  ParagraphNode,
  ProblemNode,
  SectionNode,
} from "@/types/sigma-doc";
import type { InlineNode } from "@/features/document";
import {
  buildAppliedDiffRows,
  countAppliedDiffLines,
  flattenBlockLines,
  mapBlockLineNodes,
  pairBlockLines,
} from "./applied-diff-lines";

function paragraph(id: string, text: string): ParagraphNode {
  return { id, type: "paragraph", children: [{ type: "text", text }] };
}

describe("flattenBlockLines", () => {
  it("flattens a section title into a single synthetic text line", () => {
    const section: SectionNode = { id: "s1", type: "section", title: "第1章" };
    expect(flattenBlockLines(section)).toEqual([
      { key: "s1:title", label: undefined, nodes: [{ type: "text", text: "第1章" }] },
    ]);
  });

  it("flattens a heading/paragraph into one line carrying its own children", () => {
    const heading: HeadingNode = { id: "h1", type: "heading", level: 1, children: [{ type: "text", text: "見出し" }] };
    expect(flattenBlockLines(heading)).toEqual([{ key: "h1", nodes: heading.children }]);
  });

  it("flattens nested list items depth-first, one line per item", () => {
    const list: ListNode = {
      id: "list_1",
      type: "list",
      listType: "bullet",
      items: [
        {
          id: "item_1",
          type: "listItem",
          children: [{ type: "text", text: "親" }],
          nested: [{
            id: "nested_list_1",
            type: "list",
            listType: "bullet",
            items: [{ id: "nested_item_1", type: "listItem", children: [{ type: "text", text: "子" }] }],
          }],
        },
      ],
    };

    const lines = flattenBlockLines(list);
    expect(lines.map((line) => line.key)).toEqual(["item_1", "nested_item_1"]);
  });

  it("labels problem areas 導入文/問題文/コメント/解答 without repeating per nested block", () => {
    const problem: ProblemNode = {
      id: "problem_1",
      type: "problem",
      tags: [],
      lead: [paragraph("lead_1", "導入")],
      prompt: [paragraph("prompt_1", "問題")],
      solution: [paragraph("solution_1", "解答")],
      hints: [paragraph("hint_1", "ヒント")],
    };

    const lines = flattenBlockLines(problem);
    expect(lines).toEqual([
      { key: "lead_1", label: "導入文", nodes: [{ type: "text", text: "導入" }] },
      { key: "prompt_1", label: "問題文", nodes: [{ type: "text", text: "問題" }] },
      { key: "hint_1", label: "コメント", nodes: [{ type: "text", text: "ヒント" }] },
      { key: "solution_1", label: "解答", nodes: [{ type: "text", text: "解答" }] },
    ]);
  });

  it("recurses into layoutSection children and boxBlock title+blocks", () => {
    const layoutSection: LayoutSectionNode = {
      id: "layout_1",
      type: "layoutSection",
      layout: { columnCount: 2 },
      children: [paragraph("p1", "左段"), paragraph("p2", "右段")],
    };
    expect(flattenBlockLines(layoutSection).map((line) => line.key)).toEqual(["p1", "p2"]);

    const boxBlock: BoxBlockNode = {
      id: "box_1",
      type: "boxBlock",
      styleId: "fancybox",
      title: [{ type: "text", text: "箱タイトル" }],
      blocks: [paragraph("box_p1", "本文")],
    };
    expect(flattenBlockLines(boxBlock).map((line) => line.key)).toEqual(["box_1:title", "box_p1"]);
  });
});

describe("buildAppliedDiffRows", () => {
  it("aligns a modification pair by line and highlights only the changed word", () => {
    const diff: AiAppliedDocumentDiff = {
      body: [
        { change: "removed", block: paragraph("p1", "変更前") },
        { change: "added", block: paragraph("p1", "変更後") },
      ],
      shapes: [],
    };

    const rows = buildAppliedDiffRows(diff);
    expect(rows.map((row) => row.type)).toEqual(["removed", "added"]);
    const removedRow = rows[0];
    const addedRow = rows[1];
    if (removedRow.type !== "removed" || addedRow.type !== "added") {
      throw new Error("unexpected row types");
    }
    expect(removedRow.segments.some((segment) => segment.changed)).toBe(true);
    expect(removedRow.segments.some((segment) => !segment.changed)).toBe(true);
    expect(addedRow.segments.some((segment) => segment.changed)).toBe(true);

    const { added, removed } = countAppliedDiffLines(rows);
    expect(added).toBe(1);
    expect(removed).toBe(1);
  });

  it("emits plain removed/added rows for pure insert/delete blocks", () => {
    const diff: AiAppliedDocumentDiff = {
      body: [{ change: "added", block: paragraph("p1", "新しい段落") }],
      shapes: [],
    };
    const rows = buildAppliedDiffRows(diff);
    expect(rows).toEqual([
      { type: "added", key: "p1", label: undefined, segments: [{ changed: true, nodes: [{ type: "text", text: "新しい段落" }] }] },
    ]);
  });

  it("emits nothing for a modification pair whose content is unchanged (e.g. a move)", () => {
    const diff: AiAppliedDocumentDiff = {
      body: [
        { change: "removed", block: paragraph("p1", "同じ内容") },
        { change: "added", block: paragraph("p1", "同じ内容") },
      ],
      shapes: [],
    };
    expect(buildAppliedDiffRows(diff)).toEqual([]);
  });

  it("emits removed/added rows when only inline styling changed", () => {
    const before = paragraph("p1", "重要");
    const after: ParagraphNode = {
      ...before,
      children: [{ type: "text", text: "重要", marks: ["bold"] }],
    };
    const diff: AiAppliedDocumentDiff = {
      body: [
        { change: "removed", block: before },
        { change: "added", block: after },
      ],
      shapes: [],
    };

    const rows = buildAppliedDiffRows(diff);

    expect(rows.map((row) => row.type)).toEqual(["removed", "added"]);
    expect(countAppliedDiffLines(rows)).toEqual({ added: 1, removed: 1 });
    expect(rows.every((row) => (
      (row.type === "removed" || row.type === "added")
      && row.segments.some((segment) => segment.changed)
    ))).toBe(true);
  });

  it("keeps every unchanged line of a modification pair as a context row and counts only the changed lines", () => {
    const removedItems = Array.from({ length: 7 }, (_, i) => ({
      id: `item_${i}`,
      type: "listItem" as const,
      children: [{ type: "text" as const, text: i === 0 ? "最初の行(削除前)" : `共通行${i}` }],
    }));
    const addedItems = removedItems.map((item, i) => (
      i === 0 ? { ...item, children: [{ type: "text" as const, text: "最初の行(削除後)" }] } : item
    ));
    const diff: AiAppliedDocumentDiff = {
      body: [
        { change: "removed", block: { id: "list_1", type: "list", listType: "bullet", items: removedItems } },
        { change: "added", block: { id: "list_1", type: "list", listType: "bullet", items: addedItems } },
      ],
      shapes: [],
    };

    const rows = buildAppliedDiffRows(diff);
    // 行を画面に並べる描画はもう無いので、変わらない行は折りたたまずにそのまま残す。
    expect(rows.map((row) => row.type)).toEqual(["removed", "added", "context", "context", "context", "context", "context", "context"]);
    expect(countAppliedDiffLines(rows)).toEqual({ added: 1, removed: 1 });
  });
});

describe("mapBlockLineNodes", () => {
  const tag = (key: string, nodes: InlineNode[]): InlineNode[] => [...nodes, { type: "text", text: `<${key}>` }];

  const problem: ProblemNode = {
    id: "problem_1",
    type: "problem",
    tags: [],
    lead: [paragraph("lead_1", "導入")],
    prompt: [{
      id: "prompt_list",
      type: "list",
      listType: "bullet",
      items: [{
        id: "item_1",
        type: "listItem",
        children: [{ type: "text", text: "項目" }],
        continuations: [paragraph("cont_1", "続き"), { id: "div_1", type: "divider" }],
        nested: [{
          id: "nested_list",
          type: "list",
          listType: "bullet",
          items: [{ id: "nested_item", type: "listItem", children: [{ type: "text", text: "子" }] }],
        }],
      }],
    }],
    hints: [{
      id: "box_1",
      type: "boxBlock",
      styleId: "itembox",
      title: [{ type: "text", text: "要点" }],
      blocks: [paragraph("box_p", "箱の本文")],
    }],
    solution: [{
      id: "layout_1",
      type: "layoutSection",
      layout: { columnCount: 2 },
      children: [paragraph("col_1", "左"), { id: "quote_1", type: "quote", blocks: [paragraph("quote_p", "引用")] }],
    }],
  };

  it("visits every line flattenBlockLines produces, with the same keys and in the same order", () => {
    const visited: string[] = [];
    mapBlockLineNodes(problem, (key) => {
      visited.push(key);
      return undefined;
    });

    expect(visited).toEqual(flattenBlockLines(problem).map((line) => line.key));
  });

  it("writes the mapped nodes back to the same line, which flattenBlockLines then reads", () => {
    const mapped = mapBlockLineNodes(problem, tag);
    // 区切り線 (div_1) は文章を持たないので、書き戻す先が無い。
    const lines = flattenBlockLines(mapped).filter((line) => line.key !== "div_1");

    expect(lines.map((line) => line.key)).toEqual(["lead_1", "item_1", "cont_1", "nested_item", "box_1:title", "box_p", "col_1", "quote_p"]);
    for (const line of lines) {
      expect(line.nodes.at(-1)).toEqual({ type: "text", text: `<${line.key}>` });
    }
  });

  it("returns a copy and never mutates the block it was given", () => {
    const before = structuredClone(problem);
    const mapped = mapBlockLineNodes(problem, tag);

    expect(problem).toEqual(before);
    expect(mapped).not.toBe(problem);
  });

  it("leaves a section title (plain string) untouched", () => {
    const section: SectionNode = { id: "s1", type: "section", title: "第1章" };

    expect(mapBlockLineNodes(section, tag)).toEqual(section);
  });
});

describe("pairBlockLines", () => {
  it("pairs equal and rewritten lines by position and leaves unmatched lines single", () => {
    const removed: ListNode = {
      id: "list_1",
      type: "list",
      listType: "bullet",
      items: [
        { id: "a", type: "listItem", children: [{ type: "text", text: "そのまま" }] },
        { id: "b", type: "listItem", children: [{ type: "text", text: "変更前" }] },
      ],
    };
    const added: ListNode = {
      ...removed,
      items: [
        removed.items[0]!,
        { id: "b", type: "listItem", children: [{ type: "text", text: "変更後" }] },
        { id: "c", type: "listItem", children: [{ type: "text", text: "追加" }] },
      ],
    };

    expect(pairBlockLines(removed, added).map((pair) => [pair.removed?.key ?? null, pair.added?.key ?? null]))
      .toEqual([["a", "a"], ["b", "b"], [null, "c"]]);
  });
});
