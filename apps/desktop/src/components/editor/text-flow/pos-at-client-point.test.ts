// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorView } from "@tiptap/pm/view";
import { posAtClientPoint } from "./pos-at-client-point";

afterEach(() => document.body.replaceChildren());

function bounds(element: Element, x: number, y: number, width: number, height: number) {
  element.getBoundingClientRect = () => ({ x, y, left: x, top: y, right: x + width, bottom: y + height, width, height }) as DOMRect;
}

describe("local column caret ownership", () => {
  it("clamps lower whitespace to the clicked column even when the browser returns a valid neighbour position", () => {
    const root = document.createElement("div");
    root.innerHTML = '<div class="layout-section-independent-columns"><div class="layout-section-independent-column"><p>left</p></div><div class="layout-section-independent-column"><p>right</p></div></div>';
    document.body.append(root);
    const grid = root.firstElementChild!;
    bounds(grid, 0, 0, 320, 180);
    bounds(grid.children[0], 0, 0, 200, 180);
    bounds(grid.children[1], 220, 0, 100, 180);
    bounds(grid.children[0].firstElementChild!, 0, 0, 200, 20);
    bounds(grid.children[1].firstElementChild!, 220, 0, 100, 180);
    const posAtCoords = vi.fn(({ left, top }: { left: number; top: number }) => ({ pos: left < 200 && top < 20 ? 2 : 40 }));
    const view = { dom: root, posAtCoords } as unknown as EditorView;
    expect(posAtClientPoint(view, 30, 150)).toBe(2);
    expect(posAtClientPoint(view, 250, 150)).toBe(40);
  });

  it("keeps raw coordinates for positioned page text outside local columns", () => {
    const root = document.createElement("div");
    bounds(root, 0, 0, 500, 20);
    const posAtCoords = vi.fn(() => ({ pos: 99 }));
    expect(posAtClientPoint({ dom: root, posAtCoords } as unknown as EditorView, 120, 900)).toBe(99);
    expect(posAtCoords).toHaveBeenCalledWith({ left: 120, top: 900 });
  });
});
