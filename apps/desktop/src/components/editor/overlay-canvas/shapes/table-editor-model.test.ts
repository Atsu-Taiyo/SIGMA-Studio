import { describe, expect, it } from "vitest";

import { createPlainTableSpec } from "./table";
import {
  applyTableCellStyleToRange,
  getTableCellNavigationDirection,
  getTableCellStyle,
  shouldNavigateTableCell,
  type TableEditorViewLike,
} from "./table-editor-model";

function keyboardEvent(
  key: string,
  overrides: Partial<KeyboardEvent> = {},
): KeyboardEvent {
  return {
    key,
    altKey: false,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    isComposing: false,
    ...overrides,
  } as KeyboardEvent;
}

describe("overlay table cell font size", () => {
  it("applies a pt font size only to cells in the selected range", () => {
    const table = createPlainTableSpec(2, 2);
    const next = applyTableCellStyleToRange(table, {
      startRow: 0,
      endRow: 0,
      startColumn: 0,
      endColumn: 1,
    }, { fontSize: 12.5 });

    expect(next.cells.slice(0, 2).map((cell) => cell.style?.fontSize)).toEqual([12.5, 12.5]);
    expect(next.cells.slice(2).map((cell) => cell.style?.fontSize)).toEqual([undefined, undefined]);
  });

  it("renders the SigmaDoc font size using pt instead of React numeric px", () => {
    const table = createPlainTableSpec(1, 1);
    table.defaultCellStyle.fontSize = 15;

    expect(getTableCellStyle(table, table.cells[0], 0, 0, 1, 1)).toMatchObject({
      fontSize: "15pt",
    });

    table.cells[0].style = { fontSize: 10.5 };
    expect(getTableCellStyle(table, table.cells[0], 0, 0, 1, 1)).toMatchObject({
      fontSize: "10.5pt",
    });
  });
});

describe("overlay table cell navigation", () => {
  it("maps unmodified arrow keys to adjacent-cell directions", () => {
    expect(getTableCellNavigationDirection(keyboardEvent("ArrowLeft"))).toBe("left");
    expect(getTableCellNavigationDirection(keyboardEvent("ArrowRight"))).toBe("right");
    expect(getTableCellNavigationDirection(keyboardEvent("ArrowUp"))).toBe("up");
    expect(getTableCellNavigationDirection(keyboardEvent("ArrowDown"))).toBe("down");
    expect(getTableCellNavigationDirection(keyboardEvent("Enter"))).toBeNull();
  });

  it("leaves modified and composing arrow keys inside the active editor", () => {
    expect(getTableCellNavigationDirection(keyboardEvent("ArrowLeft", { altKey: true }))).toBeNull();
    expect(getTableCellNavigationDirection(keyboardEvent("ArrowRight", { ctrlKey: true }))).toBeNull();
    expect(getTableCellNavigationDirection(keyboardEvent("ArrowUp", { metaKey: true }))).toBeNull();
    expect(getTableCellNavigationDirection(keyboardEvent("ArrowDown", { shiftKey: true }))).toBeNull();
    expect(getTableCellNavigationDirection(keyboardEvent("ArrowRight", { isComposing: true }))).toBeNull();
  });

  it("moves horizontally only from a collapsed selection at the matching edge", () => {
    expect(shouldNavigateTableCell(editorView(0, 3), "left")).toBe(true);
    expect(shouldNavigateTableCell(editorView(1, 3), "left")).toBe(false);
    expect(shouldNavigateTableCell(editorView(3, 3), "right")).toBe(true);
    expect(shouldNavigateTableCell(editorView(2, 3), "right")).toBe(false);
    expect(shouldNavigateTableCell(editorView(0, 3, false), "left")).toBe(false);
  });
});

function editorView(
  parentOffset: number,
  contentSize: number,
  empty = true,
): TableEditorViewLike {
  const parent = { content: { size: contentSize } };
  return {
    state: {
      selection: {
        empty,
        from: parentOffset + 1,
        to: parentOffset + 1,
        $from: { parentOffset, parent },
        $to: { parentOffset, parent },
      },
      doc: { content: { size: contentSize + 2 } },
    },
    coordsAtPos: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
    dom: {
      ownerDocument: {
        getSelection: () => null,
      },
    } as unknown as HTMLElement,
  };
}


describe("overlay table cell alignment", () => {
  it.each(["left", "right", "center"] as const)("replaces paragraph overrides with %s only in the selected range", (align) => {
    const table = createPlainTableSpec(2, 2);
    const next = applyTableCellStyleToRange(table, {
      startRow: 0, endRow: 0, startColumn: 0, endColumn: 1,
    }, { align });
    const restored = JSON.parse(JSON.stringify(next)) as typeof next;
    for (const cell of restored.cells.slice(0, 2)) {
      expect(cell.style?.align).toBe(align);
      expect(cell.content[0]).toMatchObject({ type: "paragraph", align });
    }
    expect(next.cells.slice(2)).toEqual(table.cells.slice(2));
    expect(table.cells[0].content[0]).toMatchObject({ align: "center" });
    expect(next.cells[0].content[0].id).toBe(table.cells[0].content[0].id);
  });
});
