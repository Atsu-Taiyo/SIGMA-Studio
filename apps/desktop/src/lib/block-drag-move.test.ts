import { describe, expect, it } from "vitest";

import type {
  LayoutSectionNode,
  ListNode,
  ParagraphNode,
  SigmaBlock,
  SigmaDocument,
} from "@/features/document";

import {
  canDropUnits,
  indexDragUnits,
  moveBlocksByDrag,
  moveUnitsByStep,
  normalizeDragUnitIds,
  resolveExplicitColumns,
} from "./block-drag-move";

function p(id: string, text = id): ParagraphNode {
  return { type: "paragraph", id, children: [{ type: "text", text }] };
}

function framedLayoutChild(type: "quote" | "codeBlock", id: string): LayoutSectionNode["children"][number] {
  return type === "quote"
    ? { type, id, blocks: [p(`${id}-body`)] }
    : { type, id, children: [{ type: "text", text: id }] };
}

function ordered(id: string, itemIds: string[], extra: Partial<ListNode> = {}): ListNode {
  return {
    type: "list",
    id,
    listType: "ordered",
    items: itemIds.map((itemId) => ({ type: "listItem", id: itemId, children: [{ type: "text", text: itemId }] })),
    ...extra,
  };
}

function section(id: string, children: LayoutSectionNode["children"], columnCount = 2): LayoutSectionNode {
  const breakStarts = children.filter((child, index) => index === 0 || child.pagination?.break === true).map((child) => child.id);
  const fallbackStarts = Array.from({ length: Math.min(columnCount, children.length) }, (_, index) => (
    children[Math.floor(index * children.length / Math.min(columnCount, children.length))].id
  ));
  return {
    type: "layoutSection",
    id,
    layout: {
      columnCount,
      columnGapMm: 8,
      columnStartIds: breakStarts.length > 1 ? breakStarts : fallbackStarts,
    },
    children,
  };
}

function doc(content: SigmaBlock[]): SigmaDocument {
  return {
    docId: "doc",
    schemaVersion: 1,
    metadata: { title: "t" },
    content,
    overlays: [],
  } as unknown as SigmaDocument;
}

function topIds(document: SigmaDocument): string[] {
  return document.content.map((block) => block.id);
}

function listItems(block: SigmaBlock | undefined): string[] {
  return block?.type === "list" ? block.items.map((item) => item.id) : [];
}

describe("normalizeDragUnitIds", () => {
  it("orders ids by document order and drops descendants of selected units", () => {
    const document = doc([
      p("a"),
      { type: "boxBlock", id: "box", styleId: "plain", blocks: [p("inner")] },
      ordered("list", ["i1", "i2"]),
    ]);
    expect(normalizeDragUnitIds(document.content, ["i2", "inner", "box", "a"])).toEqual(["a", "box", "i2"]);
  });

  it("indexes list items but not the list itself", () => {
    const index = indexDragUnits([ordered("list", ["i1", "i2"])]);
    expect(index.has("list")).toBe(false);
    expect(index.get("i2")).toMatchObject({ type: "listItem", container: { kind: "list", ownerId: "list" }, index: 1 });
  });
});

describe("moveBlocksByDrag — siblings", () => {
  it("moves a top-level paragraph after another", () => {
    const document = doc([p("a"), p("b"), p("c")]);
    const next = moveBlocksByDrag(document, { unitIds: ["a"], target: { kind: "sibling", anchorId: "c", position: "after" } });
    expect(topIds(next)).toEqual(["b", "c", "a"]);
  });

  it("returns the same document for a no-op drop next to itself", () => {
    const document = doc([p("a"), p("b")]);
    expect(moveBlocksByDrag(document, { unitIds: ["a"], target: { kind: "sibling", anchorId: "b", position: "before" } })).toBe(document);
    expect(moveBlocksByDrag(document, { unitIds: ["a"], target: { kind: "sibling", anchorId: "a", position: "before" } })).toBe(document);
  });

  it("moves several selected blocks together, keeping document order", () => {
    const document = doc([p("a"), p("b"), p("c"), p("d")]);
    const next = moveBlocksByDrag(document, { unitIds: ["c", "a"], target: { kind: "sibling", anchorId: "d", position: "after" } });
    expect(topIds(next)).toEqual(["b", "d", "a", "c"]);
  });

  it("moves a paragraph into a box and out of a quote", () => {
    const document = doc([
      { type: "quote", id: "quote", blocks: [p("q1"), p("q2")] },
      { type: "boxBlock", id: "box", styleId: "plain", blocks: [p("b1")] },
    ]);
    const intoBox = moveBlocksByDrag(document, { unitIds: ["q1"], target: { kind: "sibling", anchorId: "b1", position: "after" } });
    expect(intoBox.content[0]).toMatchObject({ type: "quote", blocks: [{ id: "q2" }] });
    expect(intoBox.content[1]).toMatchObject({ type: "boxBlock", blocks: [{ id: "b1" }, { id: "q1" }] });

    const outOfQuote = moveBlocksByDrag(document, { unitIds: ["q2"], target: { kind: "sibling", anchorId: "quote", position: "before" } });
    expect(topIds(outOfQuote)).toEqual(["q2", "quote", "box"]);
  });

  it("fills an emptied box with an empty paragraph", () => {
    const document = doc([p("a"), { type: "boxBlock", id: "box", styleId: "plain", blocks: [p("b1")] }]);
    const next = moveBlocksByDrag(document, { unitIds: ["b1"], target: { kind: "sibling", anchorId: "a", position: "before" } });
    expect(topIds(next)).toEqual(["b1", "a", "box"]);
    expect(next.content[2]).toMatchObject({ type: "boxBlock", blocks: [{ type: "paragraph" }] });
  });

  it("refuses types the container cannot hold", () => {
    const document = doc([
      { type: "problem", id: "prob", tags: [], lead: [], prompt: [p("q")], solution: [], hints: [] },
      { type: "quote", id: "quote", blocks: [p("x")] },
    ]);
    expect(canDropUnits(document, ["prob"], { kind: "sibling", anchorId: "x", position: "after" })).toBe(false);
    expect(canDropUnits(document, ["quote"], { kind: "sibling", anchorId: "q", position: "after" })).toBe(true);
    expect(canDropUnits(document, ["quote"], { kind: "sibling", anchorId: "x", position: "after" })).toBe(false);
  });

  it("refuses dropping a container into itself", () => {
    const document = doc([{ type: "boxBlock", id: "box", styleId: "plain", blocks: [p("b1"), p("b2")] }, p("z")]);
    expect(canDropUnits(document, ["box"], { kind: "sibling", anchorId: "b1", position: "after" })).toBe(false);
    expect(moveBlocksByDrag(document, { unitIds: ["box"], target: { kind: "sibling", anchorId: "b2", position: "before" } })).toBe(document);
  });

  it("appends to an empty problem area", () => {
    const document = doc([
      { type: "problem", id: "prob", tags: [], lead: [], prompt: [p("q")], solution: [], hints: [] },
      p("answer"),
    ]);
    const next = moveBlocksByDrag(document, { unitIds: ["answer"], target: { kind: "areaEnd", problemId: "prob", area: "solution" } });
    expect(next.content[0]).toMatchObject({ solution: [{ id: "answer" }] });
    expect(topIds(next)).toEqual(["prob"]);
  });
});

describe("moveBlocksByDrag — list items", () => {
  it("reorders items within a list", () => {
    const document = doc([ordered("list", ["i1", "i2", "i3"])]);
    const next = moveBlocksByDrag(document, { unitIds: ["i3"], target: { kind: "sibling", anchorId: "i1", position: "before" } });
    expect(topIds(next)).toEqual(["list"]);
    expect(listItems(next.content[0])).toEqual(["i3", "i1", "i2"]);
  });

  it("turns an item dropped outside into a one-item list of the same kind", () => {
    const document = doc([p("a"), ordered("list", ["i1", "i2"], { markerStyle: "paren" }), p("b")]);
    const next = moveBlocksByDrag(document, { unitIds: ["i1"], target: { kind: "sibling", anchorId: "b", position: "after" } });
    expect(next.content.map((block) => block.type)).toEqual(["paragraph", "list", "paragraph", "list"]);
    expect(listItems(next.content[1])).toEqual(["i2"]);
    expect(next.content[3]).toMatchObject({ listType: "ordered", markerStyle: "paren", items: [{ id: "i1" }] });
    expect(next.content[3].id).not.toBe("list");
  });

  it("splits an ordered list around a dropped paragraph and keeps the numbering going", () => {
    const document = doc([ordered("list", ["i1", "i2", "i3"]), p("para")]);
    const next = moveBlocksByDrag(document, { unitIds: ["para"], target: { kind: "sibling", anchorId: "i2", position: "before" } });
    expect(next.content.map((block) => block.type)).toEqual(["list", "paragraph", "list"]);
    expect(next.content[0]).toMatchObject({ id: "list", items: [{ id: "i1" }] });
    expect(next.content[2]).toMatchObject({ start: 2, items: [{ id: "i2" }, { id: "i3" }] });
  });

  it("merges the halves back when the paragraph between them is dragged away", () => {
    const document = doc([
      ordered("list", ["i1"]),
      p("para"),
      ordered("list_tail", ["i2", "i3"], { start: 2 }),
      p("z"),
    ]);
    const next = moveBlocksByDrag(document, { unitIds: ["para"], target: { kind: "sibling", anchorId: "z", position: "after" } });
    expect(next.content.map((block) => block.id)).toEqual(["list", "z", "para"]);
    expect(listItems(next.content[0])).toEqual(["i1", "i2", "i3"]);
    expect((next.content[0] as ListNode).start).toBeUndefined();
  });

  it("does not merge two ordered lists whose numbering is not continuous", () => {
    const document = doc([ordered("list", ["i1"]), p("para"), ordered("other", ["j1"], { start: 7 }), p("z")]);
    const next = moveBlocksByDrag(document, { unitIds: ["para"], target: { kind: "sibling", anchorId: "z", position: "after" } });
    expect(next.content.map((block) => block.id)).toEqual(["list", "other", "z", "para"]);
  });

  it("merges an item dropped next to another list of the same kind", () => {
    const document = doc([ordered("list", ["i1", "i2"]), p("mid"), ordered("other", ["j1"])]);
    const next = moveBlocksByDrag(document, { unitIds: ["i2"], target: { kind: "sibling", anchorId: "j1", position: "before" } });
    expect(next.content.map((block) => block.id)).toEqual(["list", "mid", "other"]);
    expect(listItems(next.content[2])).toEqual(["i2", "j1"]);
  });

  it("does not merge a bullet item into an ordered list", () => {
    const bullets: ListNode = { ...ordered("bullets", ["b1", "b2"]), listType: "bullet" };
    const document = doc([bullets, ordered("numbers", ["n1"])]);
    const next = moveBlocksByDrag(document, { unitIds: ["b2"], target: { kind: "sibling", anchorId: "numbers", position: "after" } });
    expect(next.content.map((block) => block.type)).toEqual(["list", "list", "list"]);
    expect(next.content[2]).toMatchObject({ listType: "bullet", items: [{ id: "b2" }] });
  });

  it("carries nested children with the parent item and lets a nested item move on its own", () => {
    const list: ListNode = ordered("list", ["i1", "i2"]);
    list.items[0].nested = [ordered("nested", ["n1", "n2"])];
    const document = doc([list, p("z")]);

    const parentMoved = moveBlocksByDrag(document, { unitIds: ["i1"], target: { kind: "sibling", anchorId: "z", position: "after" } });
    expect(parentMoved.content[2]).toMatchObject({ type: "list", items: [{ id: "i1", nested: [{ id: "nested" }] }] });

    const nestedMoved = moveBlocksByDrag(document, { unitIds: ["n2"], target: { kind: "sibling", anchorId: "i2", position: "after" } });
    expect(listItems(nestedMoved.content[0])).toEqual(["i1", "i2", "n2"]);
    expect((nestedMoved.content[0] as ListNode).items[0].nested?.[0]).toMatchObject({ items: [{ id: "n1" }] });
  });

  it("drops the list when its last item leaves", () => {
    const document = doc([ordered("list", ["i1"]), p("z")]);
    const next = moveBlocksByDrag(document, { unitIds: ["i1"], target: { kind: "sibling", anchorId: "z", position: "after" } });
    expect(next.content.map((block) => block.type)).toEqual(["paragraph", "list"]);
  });

  it("refuses a paragraph between nested items", () => {
    const list: ListNode = ordered("list", ["i1"]);
    list.items[0].nested = [ordered("nested", ["n1", "n2"])];
    const document = doc([list, p("z")]);
    expect(canDropUnits(document, ["z"], { kind: "sibling", anchorId: "n1", position: "after" })).toBe(false);
  });
});

describe("moveBlocksByDrag — columns", () => {
  it.each(["quote", "codeBlock"] as const)("reorders a %s within one layout column", (type) => {
    const subject = framedLayoutChild(type, "subject");
    const document = doc([{
      ...section("sec", [p("left"), subject, p("right"), p("right-tail")]),
      layout: {
        columnCount: 2,
        columnStartIds: ["left", "right"],
        columnWidths: [4000, 6000],
      },
    }]);

    const next = moveBlocksByDrag(document, {
      unitIds: ["subject"],
      target: { kind: "sibling", anchorId: "left", position: "before" },
    });
    const updated = next.content[0] as LayoutSectionNode;
    expect(resolveExplicitColumns(updated).map((column) => column.map((child) => child.id)))
      .toEqual([["subject", "left"], ["right", "right-tail"]]);
    expect(updated.layout.columnWidths).toEqual([4000, 6000]);
  });

  it.each(["quote", "codeBlock"] as const)("moves a %s across layout columns", (type) => {
    const subject = framedLayoutChild(type, "subject");
    const document = doc([{
      ...section("sec", [p("left"), subject, p("right"), p("right-tail")]),
      layout: {
        columnCount: 2,
        columnStartIds: ["left", "right"],
        columnWidths: [4000, 6000],
      },
    }]);

    const next = moveBlocksByDrag(document, {
      unitIds: ["subject"],
      target: { kind: "sibling", anchorId: "right", position: "after" },
    });
    const updated = next.content[0] as LayoutSectionNode;
    expect(resolveExplicitColumns(updated).map((column) => column.map((child) => child.id)))
      .toEqual([["left"], ["right", "subject", "right-tail"]]);
    expect(updated.layout.columnWidths).toEqual([4000, 6000]);
  });

  it("creates a two-column section when dropped beside a block", () => {
    const document = doc([p("a"), p("b"), p("c")]);
    const next = moveBlocksByDrag(document, { unitIds: ["c"], target: { kind: "newColumns", anchorId: "a", side: "right" } });
    expect(next.content.map((block) => block.type)).toEqual(["layoutSection", "paragraph"]);
    const created = next.content[0] as LayoutSectionNode;
    expect(created.layout.columnCount).toBe(2);
    expect(created.children.map((child) => child.id)).toEqual(["a", "c"]);
    expect(created.layout.columnStartIds).toEqual(["a", "c"]);
  });

  it("puts the dropped block on the left when dropped at the left edge", () => {
    const document = doc([p("a"), p("b")]);
    const next = moveBlocksByDrag(document, { unitIds: ["b"], target: { kind: "newColumns", anchorId: "a", side: "left" } });
    const created = next.content[0] as LayoutSectionNode;
    expect(created.children.map((child) => child.id)).toEqual(["b", "a"]);
    expect(created.layout.columnStartIds).toEqual(["b", "a"]);
  });

  it("refuses columns for problems and for anchors inside a quote", () => {
    const document = doc([
      { type: "problem", id: "prob", tags: [], lead: [], prompt: [p("q")], solution: [], hints: [] },
      p("a"),
      { type: "quote", id: "quote", blocks: [p("x")] },
    ]);
    expect(canDropUnits(document, ["prob"], { kind: "newColumns", anchorId: "a", side: "right" })).toBe(false);
    expect(canDropUnits(document, ["a"], { kind: "newColumns", anchorId: "prob", side: "right" })).toBe(false);
    expect(canDropUnits(document, ["a"], { kind: "newColumns", anchorId: "x", side: "right" })).toBe(false);
    expect(canDropUnits(document, ["quote"], { kind: "newColumns", anchorId: "a", side: "right" })).toBe(true);
  });

  it("isolates a list item into the new section and keeps the numbering around it", () => {
    const document = doc([ordered("list", ["i1", "i2", "i3"]), p("para")]);
    const next = moveBlocksByDrag(document, { unitIds: ["para"], target: { kind: "newColumns", anchorId: "i2", side: "right" } });
    expect(next.content.map((block) => block.type)).toEqual(["list", "layoutSection", "list"]);
    const created = next.content[1] as LayoutSectionNode;
    expect(created.children[0]).toMatchObject({ type: "list", start: 2, items: [{ id: "i2" }] });
    expect(created.children[1]).toMatchObject({ id: "para" });
    expect(created.layout.columnStartIds).toEqual([created.children[0].id, "para"]);
    expect(next.content[2]).toMatchObject({ start: 3, items: [{ id: "i3" }] });
  });

  it("adds a column to an existing section using canonical membership", () => {
    const document = doc([section("sec", [p("a"), p("b"), p("c")]), p("z")]);
    const next = moveBlocksByDrag(document, {
      unitIds: ["z"],
      target: { kind: "insertColumn", sectionId: "sec", anchorChildId: "c", side: "right" },
    });
    const updated = next.content[0] as LayoutSectionNode;
    expect(updated.layout.columnCount).toBe(3);
    expect(updated.layout.columnStartIds).toEqual(["a", "b", "z"]);
    expect(updated.children.map((child) => child.id)).toEqual(["a", "b", "c", "z"]);
  });

  it("refuses a fifth column", () => {
    const document = doc([section("sec", [p("a"), p("b"), p("c"), p("d")], 4), p("z")]);
    expect(canDropUnits(document, ["z"], { kind: "insertColumn", sectionId: "sec", anchorChildId: "d", side: "right" })).toBe(false);
  });

  it("collapses an emptied column and unwraps a section left with one column", () => {
    const withBreaks = section("sec", [p("a"), { ...p("b"), pagination: { break: true } }]);
    const document = doc([withBreaks, p("z")]);
    const next = moveBlocksByDrag(document, { unitIds: ["b"], target: { kind: "sibling", anchorId: "z", position: "after" } });
    expect(topIds(next)).toEqual(["a", "z", "b"]);
    expect(next.content[2].pagination).toBeUndefined();
  });

  it("only shrinks the column count by the columns that emptied", () => {
    const three = section("sec", [p("a"), { ...p("b"), pagination: { break: true } }, { ...p("c"), pagination: { break: true } }], 3);
    const document = doc([three, p("z")]);
    const next = moveBlocksByDrag(document, { unitIds: ["b"], target: { kind: "sibling", anchorId: "z", position: "after" } });
    const updated = next.content[0] as LayoutSectionNode;
    expect(updated.layout.columnCount).toBe(2);
    expect(updated.children.map((child) => child.id)).toEqual(["a", "c"]);
    expect(updated.layout.columnStartIds).toEqual(["a", "c"]);
  });

  it("keeps a balanced section's column count when a block is dropped inside it", () => {
    const document = doc([section("sec", [p("a"), p("b")]), p("z")]);
    const next = moveBlocksByDrag(document, {
      unitIds: ["z"],
      target: { kind: "sibling", anchorId: "b", position: "after" },
    });
    const updated = next.content[0] as LayoutSectionNode;
    expect(updated.layout.columnCount).toBe(2);
    expect(updated.children.map((child) => child.id)).toEqual(["a", "b", "z"]);
    expect(updated.layout.columnStartIds).toEqual(["a", "b"]);
  });

  it("moving the only block of a column across unwraps the section", () => {
    const document = doc([section("sec", [p("a"), { ...p("b"), pagination: { break: true } }])]);
    const next = moveBlocksByDrag(document, { unitIds: ["a"], target: { kind: "sibling", anchorId: "b", position: "after" } });
    expect(topIds(next)).toEqual(["b", "a"]);
  });

  it("resolves columns only from canonical membership", () => {
    const explicit = section("sec", [p("a"), { ...p("b"), pagination: { break: true } }]);
    expect(resolveExplicitColumns(explicit).map((column) => column.map((child) => child.id))).toEqual([["a"], ["b"]]);
    const balanced = section("sec", [p("a"), p("b"), p("c")]);
    expect(resolveExplicitColumns(balanced).map((column) => column.map((child) => child.id))).toEqual([["a"], ["b", "c"]]);
  });
});

describe("moveUnitsByStep", () => {
  it("swaps with the previous and next sibling", () => {
    const document = doc([p("a"), p("b"), p("c")]);
    expect(topIds(moveUnitsByStep(document, ["b"], "up"))).toEqual(["b", "a", "c"]);
    expect(topIds(moveUnitsByStep(document, ["b"], "down"))).toEqual(["a", "c", "b"]);
    expect(moveUnitsByStep(document, ["a"], "up")).toBe(document);
  });

  it("steps out of a box at its edges", () => {
    const document = doc([p("a"), { type: "boxBlock", id: "box", styleId: "plain", blocks: [p("b1"), p("b2")] }, p("z")]);
    const up = moveUnitsByStep(document, ["b1"], "up");
    expect(topIds(up)).toEqual(["a", "b1", "box", "z"]);
    const down = moveUnitsByStep(document, ["b2"], "down");
    expect(topIds(down)).toEqual(["a", "box", "b2", "z"]);
  });

  it("moves a paragraph into the list above it, one item at a time", () => {
    const document = doc([ordered("list", ["i1", "i2"]), p("para")]);
    const up = moveUnitsByStep(document, ["para"], "up");
    expect(up.content.map((block) => block.type)).toEqual(["list", "paragraph", "list"]);
    expect(listItems(up.content[0])).toEqual(["i1"]);
  });

  it("jumps a first list item over the block above the list", () => {
    const document = doc([p("a"), ordered("list", ["i1", "i2"])]);
    const up = moveUnitsByStep(document, ["i1"], "up");
    expect(up.content.map((block) => block.type)).toEqual(["list", "paragraph", "list"]);
    expect(listItems(up.content[0])).toEqual(["i1"]);
    expect(listItems(up.content[2])).toEqual(["i2"]);
  });

  it("moves a selection of several blocks as a group", () => {
    const document = doc([p("a"), p("b"), p("c"), p("d")]);
    expect(topIds(moveUnitsByStep(document, ["b", "c"], "down"))).toEqual(["a", "d", "b", "c"]);
    expect(topIds(moveUnitsByStep(document, ["b", "c"], "up"))).toEqual(["b", "c", "a", "d"]);
  });
});
