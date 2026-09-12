// @vitest-environment happy-dom

import { describe, expect, it } from "vitest";

import type { SigmaDocument } from "@/features/document";
import type { DragUnitInfo } from "@/lib/block-drag-move";

import {
  measureDragUnit,
  pointHitsLayoutColumnResizeHandle,
  resolveDeepestDescendantHoverCandidate,
  resolveInnerAffordanceProbe,
  resolveHoverDragUnitAt,
  resolveListItemAffordanceProbe,
  type DragIndex,
} from "./block-drag-dom";

function setRect(element: HTMLElement, rect: { left: number; top: number; right: number; bottom: number }) {
  element.getBoundingClientRect = () => ({
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top,
    x: rect.left,
    y: rect.top,
    toJSON: () => rect,
  });
}

describe("resolveListItemAffordanceProbe", () => {
  it("keeps every indentation band on the deepest matching nested item row", () => {
    const editor = document.createElement("div");
    editor.innerHTML = `
      <ul>
        <li id="parent-item">
          <p id="parent-row">parent</p>
          <ul>
            <li id="nested-item"><p id="nested-row">nested</p></li>
          </ul>
        </li>
      </ul>
    `;
    const parentRow = editor.querySelector<HTMLElement>("#parent-row")!;
    const nestedRow = editor.querySelector<HTMLElement>("#nested-row")!;
    setRect(parentRow, { left: 120, top: 100, right: 320, bottom: 124 });
    setRect(nestedRow, { left: 168, top: 124, right: 320, bottom: 148 });
    // The nested list draws its ○ marker in the 24px before the row text.
    setRect(nestedRow.closest("ul")!, { left: 144, top: 124, right: 320, bottom: 148 });

    for (const clientX of [160, 144, 128, 112]) {
      expect(resolveListItemAffordanceProbe(editor, clientX, 136)).toEqual({
        probeX: 176,
        laneLeft: 144,
      });
    }
  });

  it("uses the parent item only on the parent's own row", () => {
    const editor = document.createElement("div");
    editor.innerHTML = '<ul><li><p id="parent-row">parent</p><ul><li><p id="nested-row">nested</p></li></ul></li></ul>';
    setRect(editor.querySelector<HTMLElement>("#parent-row")!, { left: 120, top: 100, right: 320, bottom: 124 });
    setRect(editor.querySelector<HTMLElement>("#nested-row")!, { left: 168, top: 124, right: 320, bottom: 148 });

    // Without a laid-out list element the row's own left is the lane.
    expect(resolveListItemAffordanceProbe(editor, 112, 112)).toEqual({ probeX: 128, laneLeft: 120 });
  });

  it("anchors the lane at the list's marker box, left of the bullet", () => {
    const editor = document.createElement("div");
    editor.innerHTML = '<ul id="list"><li><p id="row">item</p></li></ul>';
    setRect(editor.querySelector<HTMLElement>("#list")!, { left: 96, top: 100, right: 320, bottom: 124 });
    setRect(editor.querySelector<HTMLElement>("#row")!, { left: 120, top: 100, right: 320, bottom: 124 });

    expect(resolveListItemAffordanceProbe(editor, 100, 112)).toEqual({ probeX: 128, laneLeft: 96 });
  });
});

describe("measureDragUnit (list items)", () => {
  it("owns only the item's own rows, not its nested list, and starts at the marker box", () => {
    const canvas = document.createElement("div");
    canvas.innerHTML = `
      <ul id="list" data-sigma-doc-id="list_1">
        <li>
          <p data-sigma-doc-id="li_1">parent</p>
          <ul id="nested" data-sigma-doc-id="list_n"><li><p data-sigma-doc-id="li_1a">nested</p></li></ul>
        </li>
      </ul>`;
    document.body.append(canvas);
    Object.defineProperty(canvas, "offsetWidth", { configurable: true, value: 800 });
    setRect(canvas, { left: 0, top: 0, right: 800, bottom: 1000 });
    const list = canvas.querySelector<HTMLElement>("#list")!;
    const item = canvas.querySelector<HTMLElement>("li")!;
    const parentRow = canvas.querySelector<HTMLElement>('[data-sigma-doc-id="li_1"]')!;
    const nested = canvas.querySelector<HTMLElement>("#nested")!;
    const nestedRow = canvas.querySelector<HTMLElement>('[data-sigma-doc-id="li_1a"]')!;
    setRect(list, { left: 144, top: 255, right: 806, bottom: 313 });
    setRect(item, { left: 184, top: 255, right: 806, bottom: 313 });
    setRect(parentRow, { left: 184, top: 255, right: 806, bottom: 283 });
    setRect(nested, { left: 184, top: 285, right: 806, bottom: 313 });
    setRect(nested.querySelector<HTMLElement>("li")!, { left: 224, top: 285, right: 806, bottom: 313 });
    setRect(nestedRow, { left: 224, top: 285, right: 806, bottom: 313 });

    const parent = measureDragUnit(canvas, "li_1", "listItem")!;
    // The `>--` edge is the parent's own row bottom (before the nested list), not the list's end.
    expect(parent.ownBox).toEqual({ top: 255, bottom: 283, left: 144, right: 806 });
    // The whole `li` (with the nested list) is still what a drag lifts.
    expect(parent.box).toEqual({ top: 255, bottom: 313, left: 184, right: 806 });

    const child = measureDragUnit(canvas, "li_1a", "listItem")!;
    expect(child.ownBox).toEqual({ top: 285, bottom: 313, left: 184, right: 806 });
    canvas.remove();
  });
});

describe("resolveHoverDragUnitAt", () => {
  it("descends from box chrome to the inner row at the probe height", () => {
    const canvas = document.createElement("div");
    const box = document.createElement("div");
    const row = document.createElement("p");
    box.dataset.sigmaDocId = "box_1";
    row.dataset.sigmaDocId = "p_box_1";
    box.append(row);
    canvas.append(box);
    document.body.append(canvas);
    Object.defineProperty(canvas, "offsetWidth", { configurable: true, value: 800 });
    setRect(canvas, { left: 0, top: 0, right: 800, bottom: 1000 });
    setRect(box, { left: 100, top: 100, right: 500, bottom: 220 });
    setRect(row, { left: 120, top: 124, right: 480, bottom: 152 });
    const elementsFromPoint = document.elementsFromPoint;
    document.elementsFromPoint = () => [box, canvas];

    const unit = (id: string, type: "boxBlock" | "paragraph", ancestors: string[]): DragUnitInfo => ({
      id,
      type,
      container: { kind: ancestors.length > 0 ? "box" as const : "content" as const, ownerId: ancestors.at(-1) ?? null },
      ancestors,
      order: ancestors.length,
      index: 0,
      siblingCount: 1,
    });
    const boxInfo = unit("box_1", "boxBlock", []);
    const rowInfo = unit("p_box_1", "paragraph", ["box_1"]);
    const index: DragIndex = {
      units: new Map([[boxInfo.id, boxInfo], [rowInfo.id, rowInfo]]),
      anchors: new Map([[boxInfo.id, boxInfo], [rowInfo.id, rowInfo]]),
    };
    const sigmaDocument = {
      content: [{ type: "boxBlock", id: "box_1", styleId: "fancybox", blocks: [
        { type: "paragraph", id: "p_box_1", children: [] },
      ] }],
    } as unknown as SigmaDocument;

    expect(resolveHoverDragUnitAt(canvas, sigmaDocument, index, 128, 138)?.id).toBe("p_box_1");
    document.elementsFromPoint = elementsFromPoint;
    canvas.remove();
  });

  it("descends through problem number and side-note chrome at an inner row height", () => {
    const canvas = document.createElement("div");
    const area = document.createElement("div");
    const row = document.createElement("p");
    area.dataset.problemId = "problem_1";
    area.dataset.problemArea = "prompt";
    row.dataset.sigmaDocId = "p_problem_1";
    area.append(row);
    canvas.append(area);
    document.body.append(canvas);
    Object.defineProperty(canvas, "offsetWidth", { configurable: true, value: 800 });
    setRect(canvas, { left: 0, top: 0, right: 800, bottom: 1000 });
    setRect(area, { left: 100, top: 100, right: 500, bottom: 220 });
    setRect(row, { left: 140, top: 124, right: 480, bottom: 152 });
    const elementsFromPoint = document.elementsFromPoint;
    document.elementsFromPoint = () => [area, canvas];
    const problemInfo: DragUnitInfo = {
      id: "problem_1",
      type: "problem",
      container: { kind: "content", ownerId: null },
      ancestors: [],
      order: 0,
      index: 0,
      siblingCount: 1,
    };
    const rowInfo: DragUnitInfo = {
      id: "p_problem_1",
      type: "paragraph",
      container: { kind: "problemArea", ownerId: "problem_1", area: "prompt" },
      ancestors: ["problem_1"],
      order: 1,
      index: 0,
      siblingCount: 1,
    };
    const index: DragIndex = {
      units: new Map([[problemInfo.id, problemInfo], [rowInfo.id, rowInfo]]),
      anchors: new Map([[problemInfo.id, problemInfo], [rowInfo.id, rowInfo]]),
    };
    const sigmaDocument = { content: [{
      type: "problem",
      id: "problem_1",
      tags: [],
      lead: [],
      prompt: [{ type: "paragraph", id: "p_problem_1", children: [] }],
      solution: [],
      hints: [],
      numbering: { enabled: true, value: 1 },
    }] } as unknown as SigmaDocument;

    expect(resolveHoverDragUnitAt(canvas, sigmaDocument, index, 112, 138)?.id).toBe("p_problem_1");
    document.elementsFromPoint = elementsFromPoint;
    canvas.remove();
  });

  it("reserves at least six pixels at a zero-padding section top", () => {
    const canvas = document.createElement("div");
    const section = document.createElement("div");
    const row = document.createElement("p");
    section.dataset.sigmaDocId = "section_1";
    row.dataset.sigmaDocId = "c_1";
    section.append(row);
    canvas.append(section);
    document.body.append(canvas);
    Object.defineProperty(canvas, "offsetWidth", { configurable: true, value: 800 });
    setRect(canvas, { left: 0, top: 0, right: 800, bottom: 1000 });
    setRect(section, { left: 100, top: 100, right: 500, bottom: 220 });
    setRect(row, { left: 100, top: 100, right: 500, bottom: 152 });
    const elementsFromPoint = document.elementsFromPoint;
    document.elementsFromPoint = () => [section, canvas];
    const sectionInfo: DragUnitInfo = {
      id: "section_1",
      type: "layoutSection" as const,
      container: { kind: "content" as const, ownerId: null },
      ancestors: [] as string[],
      order: 0,
      index: 0,
      siblingCount: 1,
    };
    const rowInfo: DragUnitInfo = {
      id: "c_1",
      type: "paragraph" as const,
      container: { kind: "layout" as const, ownerId: "section_1" },
      ancestors: ["section_1"],
      order: 1,
      index: 0,
      siblingCount: 1,
    };
    const index: DragIndex = {
      units: new Map([[sectionInfo.id, sectionInfo], [rowInfo.id, rowInfo]]),
      anchors: new Map([[sectionInfo.id, sectionInfo], [rowInfo.id, rowInfo]]),
    };
    const sigmaDocument = { content: [{
      type: "layoutSection",
      id: "section_1",
      layout: { columnCount: 1 },
      children: [{ type: "paragraph", id: "c_1", children: [] }],
    }] } as unknown as SigmaDocument;

    expect(resolveHoverDragUnitAt(canvas, sigmaDocument, index, 108, 102)?.id).toBe("section_1");
    expect(resolveHoverDragUnitAt(canvas, sigmaDocument, index, 108, 108)?.id).toBe("c_1");
    document.elementsFromPoint = elementsFromPoint;
    canvas.remove();
  });

  it("descends through a box and nested layout section from the box padding", () => {
    const canvas = document.createElement("div");
    const box = document.createElement("div");
    const section = document.createElement("div");
    const row = document.createElement("p");
    box.dataset.sigmaDocId = "right_box";
    section.dataset.sigmaDocId = "right_inner_section";
    row.dataset.sigmaDocId = "right_inner_1";
    section.append(row);
    box.append(section);
    canvas.append(box);
    document.body.append(canvas);
    Object.defineProperty(canvas, "offsetWidth", { configurable: true, value: 800 });
    setRect(canvas, { left: 0, top: 0, right: 800, bottom: 1000 });
    setRect(box, { left: 410, top: 100, right: 700, bottom: 220 });
    setRect(section, { left: 430, top: 110, right: 680, bottom: 200 });
    setRect(row, { left: 440, top: 124, right: 545, bottom: 152 });
    const elementsFromPoint = document.elementsFromPoint;
    document.elementsFromPoint = () => [box, canvas];

    const infos: DragUnitInfo[] = [
      { id: "right_box", type: "boxBlock", container: { kind: "content", ownerId: null }, ancestors: [], order: 0, index: 0, siblingCount: 1 },
      { id: "right_inner_section", type: "layoutSection", container: { kind: "box", ownerId: "right_box" }, ancestors: ["right_box"], order: 1, index: 0, siblingCount: 1 },
      { id: "right_inner_1", type: "paragraph", container: { kind: "layout", ownerId: "right_inner_section" }, ancestors: ["right_box", "right_inner_section"], order: 2, index: 0, siblingCount: 1 },
    ];
    const index: DragIndex = {
      units: new Map(infos.map((info) => [info.id, info])),
      anchors: new Map(infos.map((info) => [info.id, info])),
    };
    const sigmaDocument = { content: [{
      type: "boxBlock",
      id: "right_box",
      styleId: "fancybox",
      blocks: [{
        type: "layoutSection",
        id: "right_inner_section",
        layout: { columnCount: 2, columnStartIds: ["right_inner_1"] },
        children: [{ type: "paragraph", id: "right_inner_1", children: [] }],
      }],
    }] } as unknown as SigmaDocument;

    expect(resolveHoverDragUnitAt(canvas, sigmaDocument, index, 430, 138)?.id).toBe("right_inner_1");
    document.elementsFromPoint = elementsFromPoint;
    canvas.remove();
  });

  it("prefers the nested list row over its parent from the parent gutter", () => {
    const canvas = document.createElement("div");
    const list = document.createElement("ul");
    list.dataset.sigmaDocId = "list_1";
    list.innerHTML = `
      <li><p data-sigma-doc-id="li_2">parent</p>
        <ul><li><p data-sigma-doc-id="nested_item">nested</p></li></ul>
      </li>`;
    canvas.append(list);
    document.body.append(canvas);
    Object.defineProperty(canvas, "offsetWidth", { configurable: true, value: 800 });
    const parent = list.querySelector<HTMLElement>('[data-sigma-doc-id="li_2"]')!;
    const nested = list.querySelector<HTMLElement>('[data-sigma-doc-id="nested_item"]')!;
    setRect(canvas, { left: 0, top: 0, right: 800, bottom: 1000 });
    setRect(list, { left: 100, top: 100, right: 500, bottom: 180 });
    setRect(parent, { left: 120, top: 100, right: 500, bottom: 124 });
    setRect(nested, { left: 168, top: 124, right: 500, bottom: 148 });
    setRect(parent.closest("li")!, { left: 112, top: 100, right: 500, bottom: 148 });
    setRect(nested.closest("li")!, { left: 160, top: 124, right: 500, bottom: 148 });
    const elementsFromPoint = document.elementsFromPoint;
    document.elementsFromPoint = () => [parent, list, canvas];
    const infos: DragUnitInfo[] = [
      { id: "li_2", type: "listItem", container: { kind: "list", ownerId: "list_1" }, ancestors: ["list_1"], order: 0, index: 0, siblingCount: 1 },
      { id: "nested_item", type: "listItem", container: { kind: "list", ownerId: "nested_list" }, ancestors: ["list_1", "li_2", "nested_list"], order: 1, index: 0, siblingCount: 1 },
    ];
    const index: DragIndex = {
      units: new Map(infos.map((info) => [info.id, info])),
      anchors: new Map(infos.map((info) => [info.id, info])),
    };
    const sigmaDocument = { content: [{ type: "list", id: "list_1", listType: "bullet", items: [] }] } as unknown as SigmaDocument;

    expect(resolveHoverDragUnitAt(canvas, sigmaDocument, index, 110, 136)?.id).toBe("nested_item");
    document.elementsFromPoint = elementsFromPoint;
    canvas.remove();
  });
});

describe("resolveDeepestDescendantHoverCandidate", () => {
  it("walks the selected outer box and nested column to each deepest row", () => {
    const candidates = [
      { id: "left_box", ancestors: ["outer_section"], order: 0, left: 100, right: 390 },
      { id: "left_inner_section", ancestors: ["outer_section", "left_box"], order: 1, left: 120, right: 370 },
      { id: "left_inner_1", ancestors: ["outer_section", "left_box", "left_inner_section"], order: 2, left: 120, right: 195 },
      { id: "left_inner_2", ancestors: ["outer_section", "left_box", "left_inner_section"], order: 3, left: 215, right: 370 },
      { id: "right_box", ancestors: ["outer_section"], order: 4, left: 410, right: 700 },
      { id: "right_inner_section", ancestors: ["outer_section", "right_box"], order: 5, left: 430, right: 680 },
      { id: "right_inner_1", ancestors: ["outer_section", "right_box", "right_inner_section"], order: 6, left: 440, right: 545 },
      { id: "right_inner_2", ancestors: ["outer_section", "right_box", "right_inner_section"], order: 7, left: 565, right: 680 },
    ];

    expect(resolveDeepestDescendantHoverCandidate("outer_section", candidates, 430)).toBe("right_inner_1");
    expect(resolveDeepestDescendantHoverCandidate("outer_section", candidates, 205)).toBe("left_inner_2");
  });

  it("walks through a parent list item to its nested row from the parent gutter", () => {
    expect(resolveDeepestDescendantHoverCandidate("li_2", [{
      id: "nested_item",
      ancestors: ["list_1", "li_2", "nested_list"],
      order: 1,
      left: 168,
      right: 500,
    }], 110)).toBe("nested_item");
  });
});

describe("layout-column affordance lanes", () => {
  it("reads the divider's actual DOM hit rectangle", () => {
    const root = document.createElement("div");
    const divider = document.createElement("button");
    divider.className = "layout-section-column-resize-handle";
    root.append(divider);
    setRect(divider, { left: 394, top: 100, right: 406, bottom: 300 });

    expect(pointHitsLayoutColumnResizeHandle(root, 400, 120)).toBe(true);
    expect(pointHitsLayoutColumnResizeHandle(root, 393, 120)).toBe(false);
    expect(pointHitsLayoutColumnResizeHandle(root, 400, 301)).toBe(false);
  });

  it("descends only through the chosen outer lane in the sibling nested-grid fixture", () => {
    const owner = document.createElement("div");
    owner.innerHTML = `
      <div id="outer-grid" class="layout-section-independent-columns">
        <div id="outer-left" class="layout-section-independent-column">
          <div id="left-grid" class="layout-section-independent-columns">
            <div id="left-inner-1" class="layout-section-independent-column"></div>
            <div id="left-inner-2" class="layout-section-independent-column"></div>
          </div>
        </div>
        <div id="outer-right" class="layout-section-independent-column">
          <div id="right-grid" class="layout-section-independent-columns">
            <div id="right-inner-1" class="layout-section-independent-column"></div>
            <div id="right-inner-2" class="layout-section-independent-column"></div>
          </div>
        </div>
      </div>
    `;
    const rects = {
      "outer-grid": { left: 100, top: 100, right: 700, bottom: 300 },
      "outer-left": { left: 100, top: 100, right: 390, bottom: 300 },
      "outer-right": { left: 410, top: 100, right: 700, bottom: 300 },
      "left-grid": { left: 120, top: 110, right: 370, bottom: 200 },
      "left-inner-1": { left: 120, top: 110, right: 195, bottom: 200 },
      "left-inner-2": { left: 215, top: 110, right: 370, bottom: 200 },
      "right-grid": { left: 430, top: 110, right: 680, bottom: 200 },
      "right-inner-1": { left: 430, top: 110, right: 545, bottom: 200 },
      "right-inner-2": { left: 565, top: 110, right: 680, bottom: 200 },
    } as const;
    for (const [id, rect] of Object.entries(rects)) {
      setRect(owner.querySelector<HTMLElement>(`#${id}`)!, rect);
    }

    expect(resolveInnerAffordanceProbe(owner, 420, 140)).toMatchObject({
      probeX: 438,
      laneLeft: 430,
      firstColumn: false,
    });
    expect(resolveInnerAffordanceProbe(owner, 205, 140)).toMatchObject({
      probeX: 223,
      laneLeft: 215,
      firstColumn: false,
    });
  });
});
